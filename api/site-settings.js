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

export default async function handler(req, res) {
    try {
        const client = getTursoClient();
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
