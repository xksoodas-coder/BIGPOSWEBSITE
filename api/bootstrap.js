import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';
import { resolveTenant } from './_lib/tenant.js';
import { getSupabaseCatalog, getSupabaseFamilies } from './_lib/supabase.js';
import { storeLogoUrl } from './_lib/r2.js';
import { buyerPricing, projectProductPrices } from './_lib/pricing.js';

/**
 * GET /api/bootstrap?display=products&limit=&offset=
 *
 * One-shot storefront entry point. The home page used to fire 3–4 sequential
 * requests on load (tenant → site-settings → store → categories), each its own
 * serverless invocation with its own cold start and its own repeated tenant /
 * settings lookups. This endpoint resolves all of them in a single request and
 * a single set of (batched) DB reads, collapsing the entry waterfall.
 *
 * Returns:
 *   {
 *     tenant:   { found, active?, storeId?, slug?, name? },
 *     settings: {...} | null,           // theme/mode — readable by guests too
 *     access:   true|false,             // may we read catalog/store? (login or 'direct')
 *     store:    {...} | null,           // branding (only when access)
 *     families: [...] | null,           // categories (only when access)
 *     products: {...} | null            // first page (only when display=products & access)
 *   }
 *
 * Mirrors the access rules of the individual endpoints: settings are public per
 * tenant (needed before login on a public store); store/categories/products are
 * guest-readable only when the store opted into orderMode === 'direct'.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    // Depends on Host / ?store= / Authorization — never share across tenants.
    res.setHeader('Cache-Control', 'no-store');

    // ----- 0. Keep-warm heartbeat -------------------------------------------
    // GET /api/bootstrap?warmup=1  — pinged by an external cron so the Turso
    // connection (still used for orders/customers/settings) and this serverless
    // instance don't go cold. Products/families now come from Supabase (no cold
    // start) so there is nothing catalog-related to warm. Public + read-only.
    if (String(req.query?.warmup || '') === '1') {
        const t0 = Date.now();
        try {
            const client = getTursoClient();
            await client.execute('SELECT 1');
            res.status(200).json({ ok: true, total_ms: Date.now() - t0 });
        } catch (err) {
            res.status(200).json({ ok: false, error: String(err?.message || err), total_ms: Date.now() - t0 });
        }
        return;
    }

    try {
        const client = getTursoClient();

        // ----- 1. Resolve tenant + session (no/cheap DB) -----
        const tenant = await resolveTenant(req).catch(() => null);
        const session = readSessionFromRequest(req);

        // No tenant and no session → legacy/preview host with nothing to serve.
        if ((!tenant || !tenant.storeId) && !(session && session.storeId)) {
            res.status(200).json({ tenant: { found: false }, settings: null, access: false });
            return;
        }
        if (tenant && tenant.storeId && tenant.active === false) {
            res.status(200).json({
                tenant: { found: true, active: false, name: tenant.name },
                settings: null, access: false
            });
            return;
        }

        const loggedIn = !!(session && session.storeId);
        const storeId = loggedIn ? session.storeId : tenant.storeId;
        const tenantOut = tenant && tenant.storeId
            ? { found: true, active: true, storeId: tenant.storeId, slug: tenant.slug, name: tenant.name }
            : { found: false };

        // ----- 2. Settings (raw) + guest tier, in one batched round-trip -----
        let settings = null;
        let guestTier = null;
        try {
            const rs = await client.batch([
                { sql: `SELECT settings_json FROM bws_site_settings WHERE store_id = ?`, args: [storeId] },
                { sql: `SELECT json_payload FROM turso_web_settings WHERE store_id = ? LIMIT 1`, args: [storeId] }
            ], 'read');
            if (rs[0]?.rows?.length) {
                try { settings = JSON.parse(rs[0].rows[0].settings_json); } catch { settings = null; }
            }
            if (rs[1]?.rows?.length) {
                try {
                    const wj = JSON.parse(rs[1].rows[0].json_payload || '{}');
                    const t = Number(wj.guestPriceTier);
                    if (t >= 1 && t <= 7) guestTier = t;
                } catch { /* ignore */ }
            }
        } catch { /* settings tables may not exist yet */ }
        if (guestTier != null) {
            settings = settings || {};
            settings.guestPriceTier = guestTier;
        }

        // ----- 3. Read access: logged-in OR public ('direct') store -----
        const orderMode = (settings && settings.orderMode) || 'cart';
        const access = loggedIn || orderMode === 'direct';
        if (!access) {
            res.status(200).json({ tenant: tenantOut, settings, access: false });
            return;
        }

        // مستويات الأسعار المسموحة للمشتري — تُسقَط على كل المنتجات المُعادة كي لا
        // تُكشف باقي المستويات (الجملة/الخاصة) للزبون.
        const { allowed, pricePerProduct } = buyerPricing(loggedIn ? session : null, guestTier || 1);
        const projectP = (p) => projectProductPrices(p, allowed, pricePerProduct);

        // ----- 4. Store branding + families -----
        // Read independently (NOT one batch): turso_deleted_properties only
        // exists once a property was deleted on a phone, and a missing table
        // fails the whole batch — which used to silently null out the families
        // here (so the client fell back to /api/categories, which 500'd too).
        let store = null;
        let families = null;

        try {
            const r = await client.execute({
                sql: `SELECT company_name, activity, address, phone1, phone2, email, rib, logo_version
                      FROM turso_store_info WHERE store_id = ? LIMIT 1`,
                args: [storeId]
            });
            if (r.rows.length) {
                const row = r.rows[0];
                const version = String(row.logo_version || '').trim();
                store = {
                    name: String(row.company_name || '').trim(),
                    activity: String(row.activity || '').trim(),
                    address: String(row.address || '').trim(),
                    phone1: String(row.phone1 || '').trim(),
                    phone2: String(row.phone2 || '').trim(),
                    email: String(row.email || '').trim(),
                    rib: String(row.rib || '').trim(),
                    logoUrl: version ? storeLogoUrl(storeId, version) : ''
                };
            }
        } catch { /* store info table may not exist yet */ }

        // Families — read only from Supabase.
        try { families = await getSupabaseFamilies(storeId); }
        catch (e) { console.error('[families] supabase error:', e?.message || e); families = null; }

        // ----- 5. First products page — folds the category page's 2nd request
        // into this one. familyId → first page of that category; display=products
        // → first page of the all-products home. Favourites are per-customer, so
        // the shared (favourite-less) shape is served here. --------------------
        let products = null;
        const familyIdQ = parseInt(req.query?.familyId, 10);
        const wantAll = (req.query?.display || '') === 'products';
        if (wantAll || familyIdQ > 0) {
            // Mirror the client's getSettings()+category clamp so the preloaded
            // page lines up with the offsets the client requests for page 2+.
            let ps = Number(settings && settings.pageSize);
            ps = (Number.isFinite(ps) && ps > 0) ? Math.min(200, Math.floor(ps)) : 25;
            const size = familyIdQ > 0 ? Math.max(12, ps) : ps;
            try {
                const catalog = await getSupabaseCatalog(storeId);
                // Hide out-of-stock items when the store opted to (lighter payload).
                const hideOOS = settings && settings.showOutOfStock === false;
                let list = hideOOS ? catalog.filter(p => p.available) : catalog;
                if (familyIdQ > 0) {
                    // A category: return its WHOLE product list (not just page 1)
                    // so the client paginates IN MEMORY on scroll — no per-page
                    // network requests. Those sequential paged fetches (fired to
                    // fill the viewport) were what made entering a category slow.
                    // The payload stays small because it's a single family.
                    const fam = Array.isArray(families) ? families.find(f => f.id === familyIdQ) : null;
                    const flist = (fam ? list.filter(p => p.family === fam.name) : [])
                        .map(p => ({ ...projectP(p), isFavorite: false }));
                    products = { products: flist, total: flist.length, familyId: familyIdQ, size, complete: true };
                } else {
                    // All-products home: keep server pagination (it's the whole catalog).
                    const total = list.length;
                    const paged = list.slice(0, size).map(p => ({ ...projectP(p), isFavorite: false }));
                    products = { products: paged, total };
                }
            } catch {
                products = familyIdQ > 0
                    ? { products: [], total: 0, familyId: familyIdQ, size, complete: true }
                    : { products: [], total: 0 };
            }
        }

        // ----- 6. Single product + its category — folds the ORDER page's two
        // extra round-trips (/api/product + /api/products?family=) into this one
        // request, the same way familyId folds the category page. Without this the
        // order page ran bootstrap → product → family sequentially, each a
        // separate (possibly cold-starting) serverless call → slow open. --------
        let product = null;
        let familyProducts = null;
        const productQ = (req.query?.product || '').toString().trim();
        if (productQ) {
            try {
                const catalog = await getSupabaseCatalog(storeId);
                const sel = catalog.find(p => p.uuid === productQ);
                if (sel) {
                    // Descriptions are website-only (not in the changelog/catalog).
                    let shortDescription = '', description = '';
                    try {
                        const d = await client.execute({
                            sql: `SELECT short_desc, full_desc FROM bws_product_descriptions
                                  WHERE store_id = ? AND product_uuid = ?`,
                            args: [storeId, productQ]
                        });
                        if (d.rows.length) {
                            shortDescription = d.rows[0].short_desc || '';
                            description = d.rows[0].full_desc || '';
                        }
                    } catch { /* descriptions table may not exist yet */ }

                    product = { ...projectP(sel), isFavorite: false, shortDescription, description };

                    // Same-family siblings for the "related" grid + instant switch.
                    const hideOOS = settings && settings.showOutOfStock === false;
                    let sibs = catalog.filter(p => p.family === sel.family);
                    if (hideOOS) sibs = sibs.filter(p => p.available);
                    familyProducts = sibs.map(p => ({ ...projectP(p), isFavorite: false }));
                }
            } catch { /* client falls back to the per-endpoint path */ }
        }

        res.status(200).json({
            tenant: tenantOut, settings, access: true,
            store, families, products, product, familyProducts
        });
    } catch (err) {
        console.error('[bootstrap] error', err);
        res.status(500).json({ error: 'تعذّر تحميل المتجر' });
    }
}
