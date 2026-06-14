import { getTursoClient } from './_lib/turso.js';
import { resolveReadAccess } from './_lib/access.js';
import { flattenFamilies } from './_lib/families.js';

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

        const client = getTursoClient();
        const famRes = await client.execute({
            sql: 'SELECT json_payload FROM turso_families WHERE store_id = ? LIMIT 1',
            args: [access.storeId]
        });

        if (!famRes.rows.length) {
            res.status(200).json({ families: [] });
            return;
        }

        // The tombstones table is created only once a property is deleted on a
        // phone — on a store that never deleted one it doesn't exist yet. Reading
        // it in the SAME batch as turso_families made a "no such table" error take
        // the families down with it → 500 "تعذّر تحميل التصنيفات". Read it on its
        // own and tolerate its absence.
        let tombsJson = null;
        try {
            const tombRes = await client.execute({
                sql: 'SELECT json_payload FROM turso_deleted_properties WHERE store_id = ? LIMIT 1',
                args: [access.storeId]
            });
            if (tombRes.rows.length) tombsJson = tombRes.rows[0].json_payload;
        } catch { /* table may not exist yet → no tombstones */ }

        let families = [];
        try { families = flattenFamilies(famRes.rows[0].json_payload, tombsJson); }
        catch { families = []; }

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({ families });
    } catch (err) {
        console.error('[categories] error', err);
        res.status(500).json({ error: 'تعذّر تحميل التصنيفات' });
    }
}
