import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';
import { resolveReadAccess } from './_lib/access.js';

/**
 * Website-only product descriptions.
 *
 * The desktop POS and the mobile app no longer carry product descriptions —
 * they are authored exclusively here, in the store's web admin, and stored in
 * a dedicated table that the apps never read or write. This keeps the product
 * changelog (synced to every device) free of long marketing text.
 *
 *   GET  /api/product-descriptions?uuid=<uuid>  → { shortDescription, description }
 *        Public per tenant (so the product detail page can show them). Reads a
 *        single row, never the whole catalogue.
 *   GET  /api/product-descriptions              → { items: { uuid: {...} } }
 *        Admin only — all descriptions for the store (to prefill the editor).
 *   POST /api/product-descriptions              → { ok: true }
 *        Admin only — upsert one product's short/full description.
 *
 * Table: bws_product_descriptions(store_id, product_uuid, short_desc, full_desc,
 *                                 updated_at, PRIMARY KEY(store_id, product_uuid))
 */

async function ensureTable(client) {
    await client.execute(`
        CREATE TABLE IF NOT EXISTS bws_product_descriptions (
            store_id     TEXT NOT NULL,
            product_uuid TEXT NOT NULL,
            short_desc   TEXT NOT NULL DEFAULT '',
            full_desc    TEXT NOT NULL DEFAULT '',
            updated_at   TEXT,
            PRIMARY KEY (store_id, product_uuid)
        )
    `);
}

export default async function handler(req, res) {
    try {
        const client = getTursoClient();
        await ensureTable(client);

        if (req.method === 'GET') {
            const uuid = (req.query?.uuid || '').toString().trim();

            if (uuid) {
                // Public single-product read (used by the product detail page).
                const access = await resolveReadAccess(req);
                if (!access) {
                    res.status(401).json({ error: 'يجب تسجيل الدخول' });
                    return;
                }
                const r = await client.execute({
                    sql: `SELECT short_desc, full_desc FROM bws_product_descriptions
                          WHERE store_id = ? AND product_uuid = ?`,
                    args: [access.storeId, uuid]
                });
                const row = r.rows[0];
                res.setHeader('Cache-Control', 'private, max-age=30');
                res.status(200).json({
                    shortDescription: row ? (row.short_desc || '') : '',
                    description: row ? (row.full_desc || '') : ''
                });
                return;
            }

            // Admin list of all descriptions for the store (prefill the editor).
            const session = readSessionFromRequest(req);
            if (!session || !session.storeId || !session.isAdmin) {
                res.status(403).json({ error: 'صلاحية الإدارة مطلوبة' });
                return;
            }
            const r = await client.execute({
                sql: `SELECT product_uuid, short_desc, full_desc
                      FROM bws_product_descriptions WHERE store_id = ?`,
                args: [session.storeId]
            });
            const items = {};
            for (const row of r.rows) {
                items[row.product_uuid] = {
                    shortDescription: row.short_desc || '',
                    description: row.full_desc || ''
                };
            }
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json({ items });
            return;
        }

        if (req.method === 'POST') {
            const session = readSessionFromRequest(req);
            if (!session || !session.storeId) {
                res.status(401).json({ error: 'يجب تسجيل الدخول' });
                return;
            }
            if (!session.isAdmin) {
                res.status(403).json({ error: 'صلاحية الإدارة مطلوبة' });
                return;
            }
            const uuid = (req.body?.uuid || '').toString().trim();
            if (!uuid) {
                res.status(400).json({ error: 'معرّف المنتج مطلوب' });
                return;
            }
            // حدود طول وقائية (تجنّب تخزين نصوص ضخمة).
            const shortDesc = (req.body?.shortDescription ?? '').toString().slice(0, 2000);
            const fullDesc = (req.body?.description ?? '').toString().slice(0, 20000);

            await client.execute({
                sql: `INSERT INTO bws_product_descriptions
                          (store_id, product_uuid, short_desc, full_desc, updated_at)
                      VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(store_id, product_uuid) DO UPDATE SET
                          short_desc = excluded.short_desc,
                          full_desc  = excluded.full_desc,
                          updated_at = excluded.updated_at`,
                args: [session.storeId, uuid, shortDesc, fullDesc, new Date().toISOString()]
            });
            res.status(200).json({ ok: true });
            return;
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('[product-descriptions] error', err);
        res.status(500).json({ error: 'تعذّر تحميل أوصاف المنتجات' });
    }
}
