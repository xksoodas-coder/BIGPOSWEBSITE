import { getTursoClient } from './_lib/turso.js';
import { resolveReadAccess, getStoreSettings } from './_lib/access.js';
import { getCatalog } from './_lib/catalog.js';
import { splitFamilies } from './_lib/families.js';
import { buyerPricing, guestPriceTier, projectProductPrices } from './_lib/pricing.js';

/**
 * GET /api/products?family=<name>&favorites=1&limit=&offset=
 * Auth: Bearer <session token> (logged-in customer) OR a guest on a
 * 'direct'-mode (public) store — storeId comes from the token/tenant.
 *
 * The catalogue itself is served from a per-store materialised snapshot
 * (see _lib/catalog.js) instead of reducing the whole changelog on every
 * request. Only the per-customer `isFavorite` flag and the requested
 * family/favorites/pagination filters are applied here, so the heavy work
 * happens at most once per snapshot TTL.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        // Logged-in customer OR a guest on a 'direct'-mode (public) store.
        const access = await resolveReadAccess(req);
        if (!access) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }
        const storeId = access.storeId;
        const session = access.session; // undefined for guests

        const familyFilter = (req.query?.family || '').toString().trim();
        const favoritesOnly = String(req.query?.favorites || '') === '1';
        // Optional server-side pagination (used by the "all products" storefront
        // mode). limit<=0 / missing → return everything.
        const limit = Math.max(0, parseInt(req.query?.limit, 10) || 0);
        const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);

        const client = getTursoClient();

        // Load the customer's favourites (best-effort; guests have none).
        let favSet = new Set();
        if (session && session.customerUuid) {
            try {
                const favRes = await client.execute({
                    sql: `SELECT product_uuid FROM bws_favorites
                          WHERE store_id = ? AND customer_uuid = ?`,
                    args: [storeId, session.customerUuid]
                });
                favSet = new Set(favRes.rows.map(r => r.product_uuid));
            } catch { /* table missing → no favourites yet */ }
        }

        // When the store hides out-of-stock items, drop them server-side so they
        // are never sent (lighter response) — default is to show them as «غير متاح».
        const settings = await getStoreSettings(storeId);
        const hideOOS = settings.showOutOfStock === false;

        // مستويات الأسعار المسموحة للمشتري — لا نكشف باقي المستويات (الجملة...).
        const gt = session ? 1 : await guestPriceTier(client, storeId);
        const { allowed, pricePerProduct } = buyerPricing(session, gt);

        // Whole catalogue (shaped, snapshot-cached) → apply the request filters.
        const catalog = await getCatalog(client, storeId);
        const products = [];
        for (const p of catalog) {
            if (hideOOS && !p.available) continue;
            // المنتج قد يحمل عدّة عائلات محزومة في `family` ("A~@~B")؛ نطابق
            // الاحتواء بدل التطابق التام ليظهر تحت كلٍّ من عائلاته.
            if (familyFilter && !splitFamilies(p.family).includes(familyFilter)) continue;
            const isFavorite = favSet.has(p.uuid);
            if (favoritesOnly && !isFavorite) continue;
            const proj = projectProductPrices(p, allowed, pricePerProduct);
            proj.isFavorite = isFavorite;
            products.push(proj);
        }

        const total = products.length;
        const paged = limit > 0 ? products.slice(offset, offset + limit) : products;

        res.setHeader('Cache-Control', 'private, max-age=15');
        res.status(200).json({ products: paged, total });
    } catch (err) {
        console.error('[products] error', err);
        res.status(500).json({ error: 'تعذّر تحميل المنتجات' });
    }
}
