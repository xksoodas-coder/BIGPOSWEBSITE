import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';
import { resolveStoreAccess } from './_lib/access.js';

/**
 * Per-store website settings, stored on the server so every customer who
 * logs in with a given store code sees the layout/theme the shop's admin
 * configured for that code.
 *
 *   GET  /api/site-settings   → { settings }   (any logged-in customer)
 *   POST /api/site-settings   → { ok: true }   (admin session only)
 *
 * Table: bws_site_settings(store_id TEXT PRIMARY KEY, settings_json TEXT,
 *                          updated_at TEXT)
 */

async function ensureTable(client) {
    await client.execute(`
        CREATE TABLE IF NOT EXISTS bws_site_settings (
            store_id    TEXT PRIMARY KEY,
            settings_json TEXT NOT NULL DEFAULT '{}',
            updated_at  TEXT
        )
    `);
}

/**
 * «نبض» المتجر للإشعارات المحلية في تطبيق BIGSOFT STORE:
 *   { newStamp, newCount, dealStamp, dealCount }
 * الطابع الزمني هو أحدث تعليم/تخفيض؛ يقارنه الهاتف بما حفظه سابقًا، فإن تغيّر
 * أظهر إشعارًا. لا يحتاج تسجيل دخول (يكفي رمز المتجر) وبلا أي بيانات شخصية.
 */
// ═══════════════════════════════════════════════════════════════════════════
//  نبض الإشعارات — مصمَّم ليكلّف قاعدة البيانات ~لا شيء مهما بلغ عدد الزبائن.
//  ثلاث طبقات فوق بعضها:
//    1) كاش حافة Vercel (public + s-maxage): كل أجهزة المتجر تتقاسم ردًّا
//       واحدًا، فألف هاتف = طلب أصل واحد. stale-while-revalidate يعني ألّا
//       ينتظر أي هاتف قاعدة البيانات أبدًا.
//    2) كاش في ذاكرة الدالة: النسخة الدافئة تردّ بلا أي استعلام.
//    3) الاستعلام نفسه: عبارة واحدة تقرأ **سطرين فقط** (أحدث «جديد» + أحدث
//       تخفيض) بفضل الفهرسين أدناه — بلا COUNT ولا مسح للجدول.
//  الحصيلة: ~١٤٤ استعلامًا في اليوم لكل متجر كحدّ أقصى، أي ~٦٠٠ سطر مقروء —
//  أقل ممّا يقرأه زبون واحد يفتح التطبيق ويتصفّح تصنيفين.
// ═══════════════════════════════════════════════════════════════════════════
const _pulseMemo = new Map(); // storeId → { at, payload }
const PULSE_MEMO_MS = 10 * 60 * 1000;
// عشر دقائق على الحافة. كانت ساعة (لتقليل قراءات القاعدة) فصار تعليم منتج
// «جديد» لا يصل قبل ساعة كاملة — تبدو الخاصية معطّلة. الاستعلام الآن سطران
// عبر فهرسين، فالكلفة تبقى تافهة (~٦٠٠ سطر/يوم/متجر مهما بلغ عدد الهواتف)
// والتأخير يصير محكومًا بدورة الفحص في الهاتف (٣٠ دقيقة) لا بالكاش.
const PULSE_EDGE_S = 600;

function sendPulseJson(res, payload) {
    res.setHeader('Cache-Control',
        `public, s-maxage=${PULSE_EDGE_S}, stale-while-revalidate=${PULSE_EDGE_S}`);
    res.setHeader('Vary', 'x-store-slug');
    res.status(200).json(payload);
}

async function sendPulse(client, storeId, res) {
    const cached = _pulseMemo.get(storeId);
    if (cached && Date.now() - cached.at < PULSE_MEMO_MS) {
        sendPulseJson(res, cached.payload);
        return;
    }

    const run = async (sql, args) => {
        try {
            const r = await client.execute({ sql, args });
            return r.rows;
        } catch {
            return null;
        }
    };

    // عبارة واحدة، سطر واحد من كل جدول. الاسم عبر LEFT JOIN بمفتاح أساسي
    // (بحث مباشر بلا مسح) ليصير نصّ الإشعار «قميص أزرق» بدل جملة عامة.
    let rows = await run(`
        SELECT * FROM (
            SELECT 'new' AS kind, f.product_uuid AS uuid, f.marked_at AS stamp,
                   p.name AS name, 0 AS old_price, 0 AS price
            FROM bws_product_flags f
            LEFT JOIN bws_products p
                   ON p.store_id = f.store_id AND p.uuid = f.product_uuid
            WHERE f.store_id = ? AND f.is_new = 1
            ORDER BY f.marked_at DESC LIMIT 1
        )
        UNION ALL
        SELECT * FROM (
            SELECT 'deal' AS kind, d.product_uuid AS uuid, d.updated_at AS stamp,
                   p.name AS name, d.old_price AS old_price,
                   COALESCE(p.price1, 0) AS price
            FROM bws_product_discounts d
            LEFT JOIN bws_products p
                   ON p.store_id = d.store_id AND p.uuid = d.product_uuid
            WHERE d.store_id = ?
            ORDER BY d.updated_at DESC LIMIT 1
        )`, [storeId, storeId]);

    // احتياطي لمتجر بلا جدول منتجات على Turso (كتالوجه على Supabase) أو بلا
    // أحد الجدولين: استعلامان مبسّطان بلا JOIN.
    if (rows === null) {
        rows = [];
        const a = await run(
            `SELECT 'new' AS kind, product_uuid AS uuid, marked_at AS stamp,
                    '' AS name, 0 AS old_price, 0 AS price
             FROM bws_product_flags WHERE store_id = ? AND is_new = 1
             ORDER BY marked_at DESC LIMIT 1`, [storeId]);
        const b = await run(
            `SELECT 'deal' AS kind, product_uuid AS uuid, updated_at AS stamp,
                    '' AS name, old_price AS old_price, 0 AS price
             FROM bws_product_discounts WHERE store_id = ?
             ORDER BY updated_at DESC LIMIT 1`, [storeId]);
        if (a) rows.push(...a);
        if (b) rows.push(...b);
    }

    const newRow = rows.find(r => r.kind === 'new') || null;
    const dealRow = rows.find(r => r.kind === 'deal') || null;

    const oldPrice = Number(dealRow?.old_price ?? 0);
    const price = Number(dealRow?.price ?? 0);
    const dealPercent = (oldPrice > 0 && price > 0 && price < oldPrice)
        ? Math.round((1 - price / oldPrice) * 100)
        : 0;

    const payload = {
        newStamp: String(newRow?.stamp || ''),
        newName: String(newRow?.name || ''),
        newUuid: String(newRow?.uuid || ''),
        dealStamp: String(dealRow?.stamp || ''),
        dealName: String(dealRow?.name || ''),
        dealUuid: String(dealRow?.uuid || ''),
        dealPercent
    };
    if (_pulseMemo.size > 200) _pulseMemo.clear();
    _pulseMemo.set(storeId, { at: Date.now(), payload });
    sendPulseJson(res, payload);
}

export default async function handler(req, res) {
    try {
        const client = getTursoClient();

        // ?pulse=1 → «نبض» المتجر: أحدث وقت تعليم «جديد» وأحدث تخفيض + عددهما.
        // يستطلعه تطبيق المتجر في الخلفية كل نصف ساعة ليُظهر إشعارًا محليًا.
        // الرد مخزَّن على الحافة 5 دقائق ومشترك بين كل الأجهزة، فقراءات Turso
        // تبقى ~2 كل 5 دقائق لكل متجر مهما بلغ عدد الهواتف. (قبل ensureTable
        // عمدًا: لا يحتاج جدول الإعدادات فلا داعي لعبارة إضافية في كل نبضة.)
        if (req.method === 'GET' && String(req.query?.pulse || '') === '1') {
            // بلا مصادقة عمدًا: الرد نفسه لكل أجهزة المتجر فيُخزَّن على الحافة
            // ويتقاسمه الجميع (رمز Authorization يُلغي التخزين ويضاعف قراءات
            // القاعدة بعدد الهواتف). وإن لم يكن المتجر مسجّلًا في bws_tenants —
            // وهذا حال متاجر كثيرة — نأخذ الرمز المُرسَل كما هو، وإلّا كان
            // الإشعار يعود 401 صامتًا فلا يصل الزبون أي تنبيه أبدًا.
            const acc = await resolveStoreAccess(req).catch(() => null);
            const storeId = acc?.storeId
                || String(req.query?.store || req.headers['x-store-slug'] || '').trim();
            if (!storeId) {
                res.status(400).json({ error: 'رمز المتجر مطلوب' });
                return;
            }
            await sendPulse(client, storeId, res);
            return;
        }

        await ensureTable(client);

        if (req.method === 'GET') {
            // Public-readable per tenant (theme + order mode are needed before
            // login on a 'direct'-mode store). Not sensitive.
            const access = await resolveStoreAccess(req);
            if (!access) {
                res.status(401).json({ error: 'يجب تسجيل الدخول' });
                return;
            }
            const r = await client.execute({
                sql: `SELECT settings_json FROM bws_site_settings WHERE store_id = ?`,
                args: [access.storeId]
            });
            let settings = null;
            if (r.rows.length) {
                try { settings = JSON.parse(r.rows[0].settings_json); } catch { settings = null; }
            }
            // سعر الزائر (الزبون العابر) يُضبط من تطبيق الهاتف ويُحفظ في جدول
            // مستقل turso_web_settings. نُدمجه هنا ليقرأه الموقع.
            try {
                const w = await client.execute({
                    sql: `SELECT json_payload FROM turso_web_settings WHERE store_id = ? LIMIT 1`,
                    args: [access.storeId]
                });
                if (w.rows.length) {
                    const wj = JSON.parse(w.rows[0].json_payload || '{}');
                    const tier = Number(wj.guestPriceTier);
                    if (tier >= 1 && tier <= 7) {
                        settings = settings || {};
                        settings.guestPriceTier = tier;
                    }
                }
            } catch { /* الجدول قد لا يكون موجوداً بعد */ }
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json({ settings });
            return;
        }

        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        if (req.method === 'POST') {
            if (!session.isAdmin) {
                res.status(403).json({ error: 'صلاحية الإدارة مطلوبة' });
                return;
            }
            const incoming = req.body?.settings;
            if (!incoming || typeof incoming !== 'object') {
                res.status(400).json({ error: 'إعدادات غير صالحة' });
                return;
            }
            // معرّف بيكسل ميتا: أرقام فقط. يُعقَّم هنا أيضاً (لا في المتصفح وحده)
            // لأن هذه القيمة تُمرَّر لاحقاً إلى سكربت ميتا في صفحات كل الزوّار.
            if ('metaPixelId' in incoming) {
                const px = String(incoming.metaPixelId || '').trim();
                if (px && !/^\d{5,20}$/.test(px)) {
                    res.status(400).json({ error: 'معرّف البيكسل غير صالح' });
                    return;
                }
                incoming.metaPixelId = px;
            }
            const json = JSON.stringify(incoming);
            // حدّ حجم وقائي (≈ 768KB) لمنع تخزين حمولة ضخمة.
            // رُفِع من 256KB ليتّسع لصور البانر الإعلاني (حتى 4) المخزّنة كـ base64.
            if (json.length > 768 * 1024) {
                res.status(413).json({ error: 'حجم الإعدادات كبير جدًا' });
                return;
            }
            await client.execute({
                sql: `INSERT INTO bws_site_settings (store_id, settings_json, updated_at)
                      VALUES (?, ?, ?)
                      ON CONFLICT(store_id) DO UPDATE SET
                          settings_json = excluded.settings_json,
                          updated_at    = excluded.updated_at`,
                args: [session.storeId, json, new Date().toISOString()]
            });
            res.status(200).json({ ok: true });
            return;
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('[site-settings] error', err);
        res.status(500).json({ error: 'تعذّر تحميل إعدادات الموقع' });
    }
}
