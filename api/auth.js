import { timingSafeEqual } from 'node:crypto';
import { getTursoClient, reduceChangelog } from './_lib/turso.js';
import { signSession } from './_lib/session.js';
import { resolveTenant } from './_lib/tenant.js';
import { clientIp, isRateLimited, recordFailure, clearAttempts } from './_lib/ratelimit.js';

function isTruthy(v) {
    return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

// مقارنة ثابتة الزمن لكلمات المرور (تمنع هجمات التوقيت timing). ملاحظة: كلمات
// المرور ما تزال مخزّنة نصّاً صريحاً في المصدر (تُزامَن من تطبيق سطح المكتب)؛
// تجزئتها عند المصدر متابعة منفصلة تتطلّب تغييراً في التطبيق.
function safeEqual(a, b) {
    const ba = Buffer.from(String(a ?? ''), 'utf8');
    const bb = Buffer.from(String(b ?? ''), 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

// حدود محاولات الدخول (نافذة 15 دقيقة).
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX_PER_USER = 8;
const RL_MAX_PER_IP = 40;

/**
 * POST /api/auth
 * body: { username, password, storeId, role }
 *
 * Multi-tenant. Two kinds of login share this endpoint:
 *   - Customer login (default): checks the customer credentials stored in
 *     turso_customer_changelog (WebUsername / WebPassword) for the shop. The
 *     customer then browses the storefront for that store.
 *   - Admin login (role === 'admin'): checks the app USERS synced to the
 *     turso_users table for the store, and requires the user's CanAccessWebsite
 *     permission. These users manage the website's settings.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const { username, password, storeId, role } = req.body || {};

        // Determine the store from the tenant (link/domain) when available — this
        // is trusted (server-resolved). Fall back to the store code typed by the
        // customer (legacy / platform host without a tenant).
        let tenant = null;
        try { tenant = await resolveTenant(req); } catch { /* ignore */ }
        if (tenant && !tenant.active) {
            res.status(403).json({ error: 'هذا المتجر غير متاح حاليًا' });
            return;
        }
        const targetStore = (tenant && tenant.storeId)
            ? tenant.storeId
            : (storeId ? String(storeId).trim() : '');

        if (!username || !password || !targetStore) {
            res.status(400).json({ error: 'الرجاء إدخال جميع الحقول' });
            return;
        }

        const uname = String(username).trim().toLowerCase();
        const client = getTursoClient();

        // ── Brute-force throttle: per (store+username) and per IP, 15-min window ──
        const ip = clientIp(req);
        const userKey = `u:${targetStore}:${uname}`;
        const ipKey = `ip:${ip}`;
        const [userLimited, ipLimited] = await Promise.all([
            isRateLimited(client, userKey, RL_MAX_PER_USER, RL_WINDOW_MS),
            isRateLimited(client, ipKey, RL_MAX_PER_IP, RL_WINDOW_MS)
        ]);
        if (userLimited || ipLimited) {
            res.status(429).json({ error: 'محاولات كثيرة. يرجى الانتظار قليلاً ثم إعادة المحاولة.' });
            return;
        }
        const recordLoginFailure = () => Promise.all([
            recordFailure(client, userKey, RL_WINDOW_MS),
            recordFailure(client, ipKey, RL_WINDOW_MS)
        ]);
        const clearLoginAttempts = () => Promise.all([
            clearAttempts(client, userKey),
            clearAttempts(client, ipKey)
        ]);

        // ───────────────────────── Admin login (app users) ─────────────────────
        if (role === 'admin') {
            let rows;
            try {
                const r = await client.execute({
                    sql: `SELECT json_payload FROM turso_users WHERE store_id = ? LIMIT 1`,
                    args: [targetStore]
                });
                rows = r.rows;
            } catch {
                res.status(401).json({ error: 'رمز المتجر غير صحيح أو لا يوجد مستخدمون' });
                return;
            }

            if (!rows || rows.length === 0) {
                res.status(401).json({ error: 'رمز المتجر غير صحيح أو لا يوجد مستخدمون' });
                return;
            }

            let users = [];
            try { users = JSON.parse(rows[0].json_payload) || []; } catch { users = []; }

            const user = users.find(u => {
                const name = (u.Name || '').toString().trim().toLowerCase();
                const pass = (u.Password || '').toString();
                const active = u.IsActive === undefined ? true : isTruthy(u.IsActive);
                return name === uname && safeEqual(pass, password) && active;
            });

            if (!user) {
                await recordLoginFailure();
                res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
                return;
            }
            await clearLoginAttempts();

            if (!isTruthy(user.CanAccessWebsite)) {
                res.status(403).json({ error: 'هذا المستخدم لا يملك صلاحية إدارة الموقع' });
                return;
            }

            // رمز المشرف أقصر عمراً (حساب إداري عالي القيمة) — يومان.
            const adminTtl = 60 * 60 * 24 * 2;
            const token = signSession({
                storeId: targetStore,
                userName: user.Name || username,
                name: user.Name || username,
                isAdmin: true,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + adminTtl
            });

            res.status(200).json({
                ok: true,
                token,
                isAdmin: true,
                customer: { name: user.Name || username, phone: '' }
            });
            return;
        }

        // ───────────────────────── Customer login (storefront) ─────────────────
        const result = await client.execute({
            sql: `SELECT record_uuid, operation, json_payload, timestamp
                  FROM turso_customer_changelog
                  WHERE store_id = ?
                  ORDER BY timestamp ASC`,
            args: [targetStore]
        });

        if (result.rows.length === 0) {
            res.status(401).json({ error: 'رمز المتجر غير صحيح أو لا يوجد زبائن مسجلون' });
            return;
        }

        const latest = reduceChangelog(result.rows);

        let match = null;
        for (const [recordUuid, entry] of latest) {
            let data;
            try { data = JSON.parse(entry.payload); } catch { continue; }
            const webUsername = (data.WebUsername || '').trim().toLowerCase();
            const webPassword = data.WebPassword || '';
            if (webUsername && webUsername === uname && safeEqual(webPassword, password)) {
                match = { recordUuid, data };
                break;
            }
        }

        if (!match) {
            await recordLoginFailure();
            res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
            return;
        }
        await clearLoginAttempts();

        // مفتاح تفعيل الدخول للموقع (سويتش في تطبيق الهاتف). غياب الحقل = مفعّل
        // (توافق مع السجلات القديمة والحاسوب الذي لا يرسل هذا الحقل).
        if (match.data.WebEnabled !== undefined && !isTruthy(match.data.WebEnabled)) {
            res.status(403).json({ error: 'تم تعطيل دخول هذا الحساب للموقع. يرجى التواصل مع المتجر.' });
            return;
        }

        // Price permissions: which tiers this customer may use, and whether
        // each product's price can be switched (per-product) vs one global tier.
        const priceTiers = [];
        // Price 1 is allowed by default (backward compat with old records).
        if (match.data.CanUsePrice1 === undefined || isTruthy(match.data.CanUsePrice1)) priceTiers.push(1);
        if (isTruthy(match.data.CanUsePrice2)) priceTiers.push(2);
        if (isTruthy(match.data.CanUsePrice3)) priceTiers.push(3);
        if (isTruthy(match.data.CanUsePrice4)) priceTiers.push(4);
        if (isTruthy(match.data.CanUsePrice5)) priceTiers.push(5);
        if (isTruthy(match.data.CanUsePrice6)) priceTiers.push(6);
        if (isTruthy(match.data.CanUsePrice7)) priceTiers.push(7);
        if (priceTiers.length === 0) priceTiers.push(1);
        const pricePerProduct = isTruthy(match.data.PricePerProduct);

        const sevenDays = 60 * 60 * 24 * 7;
        // customerId is the desktop DB primary key — invoices/payments/added
        // debts reference the customer by this number, so we carry it in the
        // session to compute the account balance later.
        const customerId = match.data.Id ?? match.data.CustomerId ?? null;
        const token = signSession({
            storeId: targetStore,
            customerUuid: match.recordUuid,
            customerId,
            name: match.data.Name || match.data.WebUsername || '',
            phone: match.data.Phone || '',
            priceTiers,
            pricePerProduct,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + sevenDays
        });

        res.status(200).json({
            ok: true,
            token,
            customer: {
                name: match.data.Name || match.data.WebUsername || '',
                phone: match.data.Phone || '',
                priceTiers,
                pricePerProduct
            }
        });
    } catch (err) {
        console.error('[auth] error', err);
        res.status(500).json({ error: 'خطأ في الخادم. حاول مرة أخرى.' });
    }
}
