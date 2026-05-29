import { getTursoClient, reduceChangelog } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';
import { productImageUrl } from './_lib/r2.js';

/**
 * GET /api/products?family=<name>&favorites=1
 * Auth: Bearer <session token> (required — storeId comes from the token)
 *
 * Walks turso_changelog for table_name='Products', reduces to the latest
 * payload per record_uuid, and returns rows where the camelCase `family`
 * field matches the requested name. Each product carries an `isFavorite`
 * flag; with favorites=1 only the customer's favourites are returned.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        const familyFilter = (req.query?.family || '').toString().trim();
        const favoritesOnly = String(req.query?.favorites || '') === '1';

        const client = getTursoClient();

        // Load the customer's favourites (best-effort; table may not exist yet).
        let favSet = new Set();
        if (session.customerUuid) {
            try {
                const favRes = await client.execute({
                    sql: `SELECT product_uuid FROM bws_favorites
                          WHERE store_id = ? AND customer_uuid = ?`,
                    args: [session.storeId, session.customerUuid]
                });
                favSet = new Set(favRes.rows.map(r => r.product_uuid));
            } catch { /* table missing → no favourites yet */ }
        }

        const result = await client.execute({
            sql: `SELECT record_uuid, operation, json_payload, timestamp
                  FROM turso_changelog
                  WHERE store_id = ? AND table_name = 'Products'
                  ORDER BY timestamp ASC`,
            args: [session.storeId]
        });

        const latest = reduceChangelog(result.rows);
        const products = [];
        for (const [recordUuid, entry] of latest) {
            let data;
            try { data = JSON.parse(entry.payload); } catch { continue; }
            const family = (data.family || '').toString().trim();
            if (familyFilter && family !== familyFilter) continue;

            const isFavorite = favSet.has(recordUuid);
            if (favoritesOnly && !isFavorite) continue;

            const totalQty = Number(data.totalQuantity ?? 0);
            const imageVersion = data.imageVersion ?? '';
            products.push({
                uuid: recordUuid,
                id: data.id ?? null,
                name: data.name ?? '',
                family,
                price: Number(data.sellPrice ?? 0),
                quantity: totalQty,
                available: totalQty > 0,
                unitType: data.unitType ?? 'قطعة',
                imageVersion,
                imageUrl: imageVersion ? productImageUrl(recordUuid, imageVersion) : '',
                barcode: data.barcode ?? '',
                isFavorite
            });
        }

        products.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

        res.setHeader('Cache-Control', 'private, max-age=15');
        res.status(200).json({ products });
    } catch (err) {
        console.error('[products] error', err);
        res.status(500).json({ error: 'تعذّر تحميل المنتجات' });
    }
}
