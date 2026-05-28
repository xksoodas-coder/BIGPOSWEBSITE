import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';

/**
 * GET /api/categories
 * Auth: Bearer <session token>  (required — storeId comes from the token)
 *
 * Reads turso_families (one JSON blob per store_id) and flattens the tree
 * into a list the frontend can render directly.
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
            sql: 'SELECT json_payload FROM turso_families WHERE store_id = ? LIMIT 1',
            args: [session.storeId]
        });

        if (result.rows.length === 0) {
            res.status(200).json({ families: [] });
            return;
        }

        const raw = result.rows[0].json_payload;
        let tree;
        try { tree = JSON.parse(raw); } catch { tree = []; }

        const families = [];
        let nextId = 1;
        const walk = (nodes, parentId) => {
            for (const node of nodes) {
                const id = nextId++;
                families.push({
                    id,
                    parentId,
                    name: String(node.name || '').trim()
                });
                if (Array.isArray(node.children) && node.children.length > 0) {
                    walk(node.children, id);
                }
            }
        };
        walk(Array.isArray(tree) ? tree : [], null);

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({ families });
    } catch (err) {
        console.error('[categories] error', err);
        res.status(500).json({ error: 'تعذّر تحميل التصنيفات' });
    }
}
