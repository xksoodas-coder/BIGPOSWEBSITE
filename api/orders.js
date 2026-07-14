import { randomUUID, createHash, createHmac } from 'node:crypto';
import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';
import { resolveStoreAccess, getStoreSettings } from './_lib/access.js';
import { getCatalog } from './_lib/turso-catalog.js';
import { clientIp, isRateLimited, recordFailure } from './_lib/ratelimit.js';

// حدّ إنشاء الطلبات لكل IP (نافذة 10 دقائق) — يمنع إغراق المتجر بطلبات.
const ORDER_RL_WINDOW_MS = 10 * 60 * 1000;
const ORDER_RL_MAX = 15;
const MAX_ITEMS_PER_ORDER = 100;

// ─── Pusher Channels (same app the mobile listens on) ───
// Lets the store's phones get a real-time notification when a customer places
// an order. appId/key/cluster are public (sent to clients); the SECRET must be
// provided via env only — never hard-coded (it can publish to any channel).
const PUSHER = {
    appId: process.env.PUSHER_APP_ID || '2152180',
    key: process.env.PUSHER_KEY || '0fa1f776b3ea9e8e337c',
    secret: process.env.PUSHER_SECRET || '',
    cluster: process.env.PUSHER_CLUSTER || 'eu'
};

async function notifyNewOrder(storeId, customerName, total) {
    // No secret configured → skip silently (notification is best-effort).
    if (!PUSHER.secret) return;
    try {
        const channel = `store-${storeId}`;
        const message = `طلبية جديدة من ${customerName || 'زبون'} — ${Math.round(total)} دج`;
        const data = JSON.stringify({
            Type: 'order',
            Device: 'web',
            UserName: customerName || 'زبون',
            Store: storeId,
            Timestamp: new Date().toISOString(),
            Count: 1,
            Message: message
        });
        const body = JSON.stringify({ name: 'sync-update', channel, data });
        const path = `/apps/${PUSHER.appId}/events`;
        const ts = Math.floor(Date.now() / 1000).toString();
        const bodyMd5 = createHash('md5').update(body).digest('hex');
        const qs = `auth_key=${PUSHER.key}&auth_timestamp=${ts}&auth_version=1.0&body_md5=${bodyMd5}`;
        const sig = createHmac('sha256', PUSHER.secret)
            .update(`POST\n${path}\n${qs}`).digest('hex');
        const url = `https://api-${PUSHER.cluster}.pusher.com${path}?${qs}&auth_signature=${sig}`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });
    } catch (err) {
        // Best-effort — never block order creation on the notification.
        console.error('[orders] pusher notify failed', err);
    }
}

/**
 * Orders live in a dedicated Turso table per store_id (multi-tenant).
 *
 * Schema:
 *   bws_pending_orders(
 *     uuid TEXT PRIMARY KEY,
 *     store_id TEXT NOT NULL,
 *     customer_uuid TEXT,
 *     customer_name TEXT,
 *     customer_phone TEXT,
 *     items_json TEXT NOT NULL,
 *     total REAL NOT NULL,
 *     status TEXT NOT NULL,
 *     notes TEXT,
 *     created_at TEXT NOT NULL
 *   )
 */

let _schemaReady = false;
async function ensureSchema(client) {
    if (_schemaReady) return;
    await client.batch([
        `CREATE TABLE IF NOT EXISTS bws_pending_orders (
            uuid TEXT PRIMARY KEY,
            store_id TEXT NOT NULL,
            customer_uuid TEXT,
            customer_name TEXT,
            customer_phone TEXT,
            items_json TEXT NOT NULL,
            total REAL NOT NULL,
            status TEXT NOT NULL,
            notes TEXT,
            created_at TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_bws_orders_store
            ON bws_pending_orders(store_id, status, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_bws_orders_customer
            ON bws_pending_orders(customer_uuid, created_at)`
    ], 'write');
    // Guest-order fields (added incrementally — ignore "duplicate column").
    for (const col of [
        'wilaya TEXT', 'baladiya TEXT', 'delivery_type TEXT', 'is_guest INTEGER DEFAULT 0',
        'delivery REAL DEFAULT 0'
    ]) {
        try { await client.execute(`ALTER TABLE bws_pending_orders ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    _schemaReady = true;
}

export default async function handler(req, res) {
    try {
        const client = getTursoClient();
        await ensureSchema(client);

        if (req.method === 'POST') {
            // Logged-in customer OR a guest on a 'direct'-mode store.
            const access = await resolveStoreAccess(req);
            if (!access) {
                res.status(401).json({ error: 'تعذّر تحديد المتجر' });
                return;
            }
            const storeId = access.storeId;
            const session = access.session; // undefined for guests
            const isGuest = !session;

            // A guest is only allowed when the store opted into 'direct' mode.
            if (isGuest) {
                const settings = await getStoreSettings(storeId);
                if (settings.orderMode !== 'direct') {
                    res.status(401).json({ error: 'يجب تسجيل الدخول' });
                    return;
                }
            }

            // مكافحة الإغراق: حدّ إنشاء الطلبات لكل IP (لا يُلتفّ عليه بتغيير الهاتف).
            const ip = clientIp(req);
            const orderRlKey = `order:${storeId}:${ip}`;
            if (await isRateLimited(client, orderRlKey, ORDER_RL_MAX, ORDER_RL_WINDOW_MS)) {
                res.status(429).json({ error: 'محاولات كثيرة. يرجى الانتظار قليلاً قبل إرسال طلب آخر.' });
                return;
            }

            const { items, notes, phone, name, wilaya, baladiya, deliveryType, delivery: deliveryFee } = req.body || {};
            if (!Array.isArray(items) || items.length === 0) {
                res.status(400).json({ error: 'السلة فارغة' });
                return;
            }
            if (items.length > MAX_ITEMS_PER_ORDER) {
                res.status(400).json({ error: 'عدد المنتجات في الطلب كبير جدًا.' });
                return;
            }

            const cleanItems = items.map(it => ({
                uuid: it.uuid || null,
                id: it.id ?? null,
                name: String(it.name || ''),
                price: Number(it.price || 0),
                quantity: Number(it.quantity || 0),
                unitType: it.unitType || 'قطعة',
                // تفصيل الطلب بالأحجام (إن وُجد): الوحدة + كل حجم.
                unitQty: Number(it.unitQty) || 0,
                sizes: Array.isArray(it.sizes)
                    ? it.sizes.map(s => ({
                        name: String(s.name || ''),
                        capacity: Number(s.capacity) || 0,
                        qty: Number(s.qty) || 0,
                        // سعر بيع الصندوق (يُتحقّق منه من الكتالوج أدناه، لا يُوثق كما هو).
                        price: Number(s.price) || 0
                    })).filter(s => s.name && s.qty > 0)
                    : []
            })).filter(it => it.name && it.quantity > 0);

            if (cleanItems.length === 0) {
                res.status(400).json({ error: 'لا توجد منتجات صالحة في السلة' });
                return;
            }

            const custName = (name || (session && session.name) || '').toString().trim().slice(0, 200);
            const custPhone = (phone || (session && session.phone) || '').toString().trim().slice(0, 50);
            const w = (wilaya || '').toString().trim().slice(0, 100);
            const b = (baladiya || '').toString().trim().slice(0, 100);
            const delivery = (deliveryType === 'office') ? 'office' : 'home';

            // Guest orders must carry a name + phone (no account to fall back on).
            if (isGuest && (!custName || !custPhone)) {
                res.status(400).json({ error: 'الرجاء إدخال الاسم ورقم الهاتف' });
                return;
            }

            // Anti-spam: cap pending orders per customer (logged-in) or per phone (guest).
            let cntRes;
            if (session && session.customerUuid) {
                cntRes = await client.execute({
                    sql: `SELECT COUNT(*) AS c FROM bws_pending_orders
                          WHERE store_id = ? AND customer_uuid = ? AND status = 'pending'`,
                    args: [storeId, session.customerUuid]
                });
            } else if (custPhone) {
                cntRes = await client.execute({
                    sql: `SELECT COUNT(*) AS c FROM bws_pending_orders
                          WHERE store_id = ? AND customer_phone = ? AND status = 'pending'`,
                    args: [storeId, custPhone]
                });
            }
            if (cntRes && Number(cntRes.rows[0]?.c || 0) >= 20) {
                res.status(429).json({
                    error: 'عدد كبير من الطلبيات المعلقة. انتظر حتى تتم معالجتها قبل إرسال طلب جديد.'
                });
                return;
            }

            // ─────────────────────────────────────────────────────────────
            //  سلامة الأسعار: لا نثق بسعر العميل إطلاقاً. نعيد تسعير كل بند من
            //  الكتالوج (المصدر) حسب مستوى السعر المسموح لهذا المشتري، فلا يمكن
            //  التلاعب بالإجمالي بإرسال سعر مزيّف.
            // ─────────────────────────────────────────────────────────────
            let catalog;
            try {
                catalog = await getCatalog(storeId);
            } catch {
                res.status(503).json({ error: 'تعذّر التحقق من الأسعار. حاول مرة أخرى.' });
                return;
            }
            const byUuid = new Map(catalog.map(p => [p.uuid, p]));

            // مستويات الأسعار المسموحة لهذا المشتري (مطابقة لمنطق العميل).
            let allowedTiers;
            let pricePerProduct = false;
            if (session) {
                const t = (Array.isArray(session.priceTiers) ? session.priceTiers : [])
                    .map(Number).filter(n => n >= 1 && n <= 7);
                allowedTiers = t.length ? Array.from(new Set(t)).sort((a, b) => a - b) : [1];
                pricePerProduct = session.pricePerProduct === true && allowedTiers.length > 1;
            } else {
                // زائر (وضع 'direct'): سعر واحد من إعدادات الموقع (يضبطه تطبيق الهاتف).
                let gt = 1;
                try {
                    const w = await client.execute({
                        sql: `SELECT json_payload FROM turso_web_settings WHERE store_id = ? LIMIT 1`,
                        args: [storeId]
                    });
                    if (w.rows.length) {
                        const wj = JSON.parse(w.rows[0].json_payload || '{}');
                        const n = Number(wj.guestPriceTier);
                        if (n >= 1 && n <= 7) gt = n;
                    }
                } catch { /* default tier 1 */ }
                allowedTiers = [gt];
            }

            const priceForTier = (prod, tier) => {
                const v = Number(prod['price' + tier] ?? 0);
                if (v > 0) return v;
                const p1 = Number(prod.price1 ?? prod.price ?? 0);
                if (p1 > 0) return p1;
                for (const k of [2, 3, 4, 5, 6, 7]) {
                    const x = Number(prod['price' + k] ?? 0);
                    if (x > 0) return x;
                }
                return 0;
            };

            for (const it of cleanItems) {
                const prod = it.uuid ? byUuid.get(it.uuid) : null;
                if (!prod) {
                    res.status(400).json({ error: 'بعض المنتجات لم تعد متوفرة. يرجى تحديث الصفحة وإعادة المحاولة.' });
                    return;
                }
                // سعر واحد: مستوى الزبون الأول (currentTier في العميل). تعدّد:
                // أي مستوى مسموح له سعر موجب. priceForTier يتكفّل بالاحتياطي.
                const usable = allowedTiers.filter(t => Number(prod['price' + t] ?? 0) > 0);
                const tiers = (pricePerProduct && usable.length) ? usable : [allowedTiers[0]];
                const allowedPrices = tiers.map(t => priceForTier(prod, t));
                const submitted = Number(it.price || 0);

                // بند بالصندوق: السعر الموثوق = سعر الصندوق من الكتالوج (المصدر)،
                // وإلا سعر مستوى المشتري × سعة الصندوق. لا نفرض سعر الوحدة (كان يُفسد
                // إجمالي الطلب بالصندوق).
                const box = (Array.isArray(it.sizes) && it.sizes.length &&
                    Number(it.sizes[0].capacity) > 0) ? it.sizes[0] : null;
                if (box) {
                    const prodSize = Array.isArray(prod.sizes)
                        ? prod.sizes.find(s => s.name === box.name) : null;
                    const trustedBox = (prodSize && Number(prodSize.boxPrice) > 0)
                        ? Number(prodSize.boxPrice)
                        : allowedPrices[0] * Number(box.capacity);
                    it.price = (Math.abs(trustedBox - submitted) < 0.01) ? submitted : trustedBox;
                    box.price = it.price; // نثبّت سعر الصندوق الموثوق في التفصيل
                } else {
                    // نقبل سعر العميل فقط إن طابق سعر مستوى مسموح؛ وإلا نفرض سعر الخادم.
                    const matched = allowedPrices.find(ap => Math.abs(ap - submitted) < 0.01);
                    it.price = (matched != null) ? matched : allowedPrices[0];
                }
            }

            const total = cleanItems.reduce((s, it) => s + it.price * it.quantity, 0);
            // سعر التوصيل (يُحتسب في الموقع حسب الولاية/البلدية ونوع التسليم).
            const deliveryAmount = Math.max(0, Number(deliveryFee) || 0);
            const orderUuid = randomUUID();
            const createdAt = new Date().toISOString();

            await client.execute({
                sql: `INSERT INTO bws_pending_orders
                      (uuid, store_id, customer_uuid, customer_name, customer_phone,
                       items_json, total, status, notes, created_at,
                       wilaya, baladiya, delivery_type, is_guest, delivery)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    orderUuid,
                    storeId,
                    (session && session.customerUuid) || null,
                    custName,
                    custPhone,
                    JSON.stringify(cleanItems),
                    total,
                    (notes || '').toString().slice(0, 1000),
                    createdAt,
                    w, b, delivery, isGuest ? 1 : 0, deliveryAmount
                ]
            });

            // عُدّ هذا الطلب ضمن حدّ الـ IP (لمكافحة الإغراق).
            await recordFailure(client, orderRlKey, ORDER_RL_WINDOW_MS);

            // Real-time push to the store's devices (best-effort).
            await notifyNewOrder(storeId, custName, total);

            res.status(201).json({ ok: true, uuid: orderUuid, total, status: 'pending', createdAt });
            return;
        }

        // GET — the logged-in customer's own orders (requires a session).
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        if (req.method === 'GET') {
            const result = await client.execute({
                sql: `SELECT uuid, total, delivery, status, items_json, created_at
                      FROM bws_pending_orders
                      WHERE store_id = ? AND customer_uuid = ?
                      ORDER BY created_at DESC LIMIT 50`,
                args: [session.storeId, session.customerUuid]
            });
            const orders = result.rows.map(r => ({
                uuid: r.uuid,
                total: Number(r.total),
                delivery: Number(r.delivery || 0),
                status: r.status,
                items: JSON.parse(r.items_json || '[]'),
                createdAt: r.created_at
            }));
            res.status(200).json({ orders });
            return;
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('[orders] error', err);
        res.status(500).json({ error: 'تعذّر إرسال الطلب' });
    }
}
