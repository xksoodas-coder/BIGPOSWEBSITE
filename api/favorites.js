import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';

/**
 * Customer favourites — stored per (store, customer, product).
 *
 *   GET    /api/favorites          → { uuids: [...] }
 *   POST   /api/favorites {uuid}   → add
 *   DELETE /api/favorites {uuid}   → remove
 *
 * Schema:
 *   bws_favorites(store_id, customer_uuid, product_uuid, created_at,
 *                 PRIMARY KEY(store_id, customer_uuid, product_uuid))
 */

let _schemaReady = false;
async function ensureSchema(client) {
    if (_schemaReady) return;
    await client.batch([
        `CREATE TABLE IF NOT EXISTS bws_favorites (
            store_id TEXT NOT NULL,
            customer_uuid TEXT NOT NULL,
            product_uuid TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (store_id, customer_uuid, product_uuid)
        )`
    ], 'write');
    _schemaReady = true;
}

export default async function handler(req, res) {
    try {
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId || !session.customerUuid) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        const client = getTursoClient();
        await ensureSchema(client);

        if (req.method === 'GET') {
            const result = await client.execute({
                sql: `SELECT product_uuid FROM bws_favorites
                      WHERE store_id = ? AND customer_uuid = ?`,
                args: [session.storeId, session.customerUuid]
            });
            res.status(200).json({ uuids: result.rows.map(r => r.product_uuid) });
            return;
        }

        if (req.method === 'POST') {
            const { uuid } = req.body || {};
            if (!uuid) { res.status(400).json({ error: 'معرّف المنتج مفقود' }); return; }
            await client.execute({
                sql: `INSERT OR IGNORE INTO bws_favorites
                      (store_id, customer_uuid, product_uuid, created_at)
                      VALUES (?, ?, ?, ?)`,
                args: [session.storeId, session.customerUuid, String(uuid), new Date().toISOString()]
            });
            res.status(200).json({ ok: true });
            return;
        }

        if (req.method === 'DELETE') {
            const { uuid } = req.body || {};
            if (!uuid) { res.status(400).json({ error: 'معرّف المنتج مفقود' }); return; }
            await client.execute({
                sql: `DELETE FROM bws_favorites
                      WHERE store_id = ? AND customer_uuid = ? AND product_uuid = ?`,
                args: [session.storeId, session.customerUuid, String(uuid)]
            });
            res.status(200).json({ ok: true });
            return;
        }

        res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('[favorites] error', err);
        res.status(500).json({ error: 'تعذّر تحديث المفضلة' });
    }
}
