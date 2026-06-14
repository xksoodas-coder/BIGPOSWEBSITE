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
        const rb = await client.batch([
            { sql: 'SELECT json_payload FROM turso_families WHERE store_id = ? LIMIT 1', args: [access.storeId] },
            { sql: 'SELECT json_payload FROM turso_deleted_properties WHERE store_id = ? LIMIT 1', args: [access.storeId] }
        ], 'read');

        if (!rb[0]?.rows?.length) {
            res.status(200).json({ families: [] });
            return;
        }

        const familiesJson = rb[0].rows[0].json_payload;
        const tombsJson = rb[1]?.rows?.length ? rb[1].rows[0].json_payload : null;
        const families = flattenFamilies(familiesJson, tombsJson);

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({ families });
    } catch (err) {
        console.error('[categories] error', err);
        res.status(500).json({ error: 'تعذّر تحميل التصنيفات' });
    }
}
