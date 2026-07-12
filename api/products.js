import { getTursoClient } from './_lib/turso.js';
import { resolveReadAccess, getStoreSettings } from './_lib/access.js';
import { readSessionFromRequest } from './_lib/session.js';
// قراءة عبر الموجّه: Turso (bws_products) إن كان المتجر منسوخًا، وإلا Supabase.
import { getCatalog, getFamilyPage, getTursoCatalog } from './_lib/turso-catalog.js';
import { splitFamilies } from './_lib/families.js';
import { buyerPricing, guestPriceTier, projectProductPrices } from './_lib/pricing.js';
import {
    getStoreDiscounts, applyDiscount, ensureDiscountTable, invalidateDiscounts
} from './_lib/discounts.js';

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
    // ── مسار الأدمين (تطبيق SOFT ADMIN MANAGER): إدارة تخفيضات المنتجات ──
    // مدمج هنا (بدل دالة مستقلّة) لتفادي تجاوز حدّ عدد دوال Vercel.
    if (req.method === 'POST') {
        return handleAdminDiscountPost(req, res);
    }
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    if (String(req.query?.admin || '') === '1') {
        return handleAdminProductsList(req, res);
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

        // كاش الحافة (Edge/CDN) للضيوف: الرد نفسه لكل ضيوف المتجر المباشر، فيُخزَّن
        // على Vercel Edge ويتشاركه الجميع → قراءات Supabase/Turso أقل بكثير.
        // المسجّلون يبقون private (فيهم مفضلة/أسعار خاصة). Vary يمنع خلط المتاجر.
        const setCacheHeaders = () => {
            if (access.guest) {
                res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
                res.setHeader('Vary', 'x-store-slug');
            } else {
                res.setHeader('Cache-Control', 'private, max-age=15');
            }
        };

        const familyFilter = (req.query?.family || '').toString().trim();
        const favoritesOnly = String(req.query?.favorites || '') === '1';
        // بحث نصّي بالاسم (من تطبيق المتجر) — يُصفّى على الخادم فلا يُنزَّل الكتالوج
        // كاملاً إلى الهاتف؛ يُعاد فقط صفحة النتائج المطابقة.
        const q = (req.query?.q || '').toString().trim().toLowerCase();
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

        // تخفيضات المتجر (يضبطها الأدمين) — تُطبَّق بعد إسقاط الأسعار.
        const discounts = await getStoreDiscounts(storeId);

        // ── المسار المُحسَّن: تصفّح عائلة بترقيم صفحات ──
        // نقرأ صفحة الـ limit فقط من Supabase (لا الكتالوج كاملاً) → قراءات أقل.
        // يُستخدم فقط مع (عائلة محدّدة + ليس المفضّلة + بلا بحث نصّي + limit>0). أي خطأ → تراجُع.
        if (familyFilter && !favoritesOnly && !q && limit > 0) {
            try {
                const { products: pageRows, total } = await getFamilyPage(
                    storeId, familyFilter, { hideOOS, limit, offset });
                const products = pageRows.map((p) => {
                    const proj = projectProductPrices(p, allowed, pricePerProduct);
                    applyDiscount(proj, discounts.get(p.uuid));
                    proj.isFavorite = favSet.has(p.uuid);
                    return proj;
                });
                setCacheHeaders();
                res.status(200).json({ products, total });
                return;
            } catch (e) {
                console.error('[products] family-page fallback:', e?.message || e);
                // نُكمل بالطريقة الكاملة أدناه (تبقى صحيحة).
            }
        }

        // كامل الكتالوج (حالة حالية) — Turso إن مُنسِخ، وإلا Supabase.
        const catalog = await getCatalog(storeId);
        const products = [];
        for (const p of catalog) {
            if (hideOOS && !p.available) continue;
            // المنتج قد يحمل عدّة عائلات محزومة في `family` ("A~@~B")؛ نطابق
            // الاحتواء بدل التطابق التام ليظهر تحت كلٍّ من عائلاته.
            if (familyFilter && !splitFamilies(p.family).includes(familyFilter)) continue;
            // بحث نصّي بالاسم (احتواء، غير حسّاس للحالة).
            if (q && !(p.name || '').toLowerCase().includes(q)) continue;
            const isFavorite = favSet.has(p.uuid);
            if (favoritesOnly && !isFavorite) continue;
            const proj = projectProductPrices(p, allowed, pricePerProduct);
            applyDiscount(proj, discounts.get(p.uuid));
            proj.isFavorite = isFavorite;
            products.push(proj);
        }

        const total = products.length;
        const paged = limit > 0 ? products.slice(offset, offset + limit) : products;

        setCacheHeaders();
        res.status(200).json({ products: paged, total });
    } catch (err) {
        console.error('[products] error', err);
        res.status(500).json({ error: 'تعذّر تحميل المنتجات' });
    }
}

// ── الأدمين: قائمة منتجات المتجر مع تخفيضاتها الحالية (بحث بالاسم) ──
// GET /api/products?admin=1&q=<بحث>&limit=  (توكن أدمين). يُعيد نتائج البحث فقط
// (لا يُحمَّل الكتالوج كاملاً على الواجهة إلا عند الطلب).
async function handleAdminProductsList(req, res) {
    try {
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }
        if (!session.isAdmin) {
            res.status(403).json({ error: 'صلاحية الإدارة مطلوبة' });
            return;
        }
        const storeId = session.storeId;
        const q = (req.query?.q || '').toString().trim().toLowerCase();
        const limit = Math.min(80, Math.max(1, parseInt(req.query?.limit, 10) || 50));

        const [catalog, discounts] = await Promise.all([
            getTursoCatalog(storeId),
            getStoreDiscounts(storeId)
        ]);

        const out = [];
        for (const p of catalog) {
            if (q && !(p.name || '').toLowerCase().includes(q)) continue;
            const d = discounts.get(p.uuid) || null;
            out.push({
                uuid: p.uuid,
                name: p.name,
                family: p.family,
                price1: p.price1,
                imageUrl: p.imageUrl,
                imageUrlLegacy: p.imageUrlLegacy,
                discount: d ? { type: d.type, value: d.value } : null
            });
            if (out.length >= limit) break;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ products: out });
    } catch (err) {
        console.error('[products admin-list] error', err);
        res.status(500).json({ error: 'تعذّر تحميل المنتجات' });
    }
}

// ── الأدمين: ضبط/حذف تخفيض منتج ──
// POST /api/products  body: { productUuid, discount: {type,value} | null }  (توكن أدمين)
async function handleAdminDiscountPost(req, res) {
    try {
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }
        if (!session.isAdmin) {
            res.status(403).json({ error: 'صلاحية الإدارة مطلوبة' });
            return;
        }
        const storeId = session.storeId;
        const uuid = (req.body?.productUuid || '').toString().trim();
        if (!uuid) {
            res.status(400).json({ error: 'معرّف المنتج مطلوب' });
            return;
        }
        const client = getTursoClient();
        await ensureDiscountTable(client);

        const disc = req.body?.discount;
        if (disc == null) {
            await client.execute({
                sql: `DELETE FROM bws_product_discounts WHERE store_id = ? AND product_uuid = ?`,
                args: [storeId, uuid]
            });
            invalidateDiscounts(storeId);
            res.status(200).json({ ok: true });
            return;
        }

        const type = (disc.type || '').toString();
        const value = Number(disc.value);
        if ((type !== 'price' && type !== 'percent') || !Number.isFinite(value) || value <= 0) {
            res.status(400).json({ error: 'قيمة التخفيض غير صالحة' });
            return;
        }
        if (type === 'percent' && value >= 100) {
            res.status(400).json({ error: 'النسبة يجب أن تكون أقلّ من 100' });
            return;
        }

        await client.execute({
            sql: `INSERT INTO bws_product_discounts (store_id, product_uuid, disc_type, disc_value, updated_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(store_id, product_uuid) DO UPDATE SET
                      disc_type  = excluded.disc_type,
                      disc_value = excluded.disc_value,
                      updated_at = excluded.updated_at`,
            args: [storeId, uuid, type, value, new Date().toISOString()]
        });
        invalidateDiscounts(storeId);
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('[products admin-discount] error', err);
        res.status(500).json({ error: 'تعذّر تنفيذ العملية' });
    }
}
