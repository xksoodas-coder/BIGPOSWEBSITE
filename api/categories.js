import { resolveReadAccess } from './_lib/access.js';
// قراءة عبر الموجّه: عائلات Turso إن كان المتجر منسوخًا، وإلا Supabase.
import { getFamilies } from './_lib/turso-catalog.js';

/**
 * GET /api/categories
 * Auth: Bearer <session token>  (required — storeId comes from the token)
 *
 * Reads turso_families (one JSON blob per store_id) and flattens the tree
 * into a list the frontend can render directly. Families tombstoned in
 * turso_deleted_properties are dropped (so phone-deleted families don't
 * resurrect on the storefront when another device re-unions them).
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const access = await resolveReadAccess(req);
        if (!access) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        // Families — read only from Supabase.
        let families = [];
        try { families = await getFamilies(access.storeId); }
        catch (e) { console.error('[categories] supabase error:', e?.message || e); families = []; }

        // كاش الحافة للضيوف (متجر مباشر) — نفس التصنيفات للجميع فتُخزَّن على Edge.
        // المسجّلون يبقون private. Vary يمنع خلط المتاجر على المضيف المشترك.
        if (access.guest) {
            res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
            res.setHeader('Vary', 'x-store-slug');
        } else {
            res.setHeader('Cache-Control', 'private, max-age=30');
        }
        res.status(200).json({ families });
    } catch (err) {
        console.error('[categories] error', err);
        res.status(500).json({ error: 'تعذّر تحميل التصنيفات' });
    }
}
