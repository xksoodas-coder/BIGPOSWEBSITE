import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';
import { storeLogoUrl } from './_lib/r2.js';

/**
 * GET /api/store
 * Auth: Bearer <session token> (required)
 *
 * Returns the store's display info (company name + logo URL) so the
 * frontend can render a branded header in place of the placeholder "BS".
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

        const client = getTursoClient();
        const result = await client.execute({
            sql: `SELECT company_name, logo_version
                  FROM turso_store_info
                  WHERE store_id = ? LIMIT 1`,
            args: [session.storeId]
        });

        let name = '';
        let logoUrl = '';
        if (result.rows.length > 0) {
            const row = result.rows[0];
            name = String(row.company_name || '').trim();
            const version = String(row.logo_version || '').trim();
            if (version) logoUrl = storeLogoUrl(session.storeId, version);
        }

        res.setHeader('Cache-Control', 'private, max-age=60');
        res.status(200).json({ name, logoUrl });
    } catch (err) {
        console.error('[store] error', err);
        res.status(500).json({ error: 'تعذّر تحميل بيانات المتجر' });
    }
}
