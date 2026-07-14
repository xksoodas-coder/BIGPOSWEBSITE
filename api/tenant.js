import { resolveTenant } from './_lib/tenant.js';
import { getTursoClient } from './_lib/turso.js';

/**
 * GET /api/tenant?store=<slug>&package=<applicationId>
 * Resolves the storefront's tenant from the request (custom domain / subdomain
 * / ?store= slug) and returns its public identity. Used by the storefront to
 * know which store it is BEFORE the customer logs in (branding + login).
 *
 * Also returns a PER-APP forced-update signal (`appVersion`) keyed by the app's
 * `package` (applicationId) — read from table `bws_app_versions`. Each
 * white-label app has its OWN row, so forcing an update on one app never
 * affects the others (no collision). Merged here to avoid adding a new
 * serverless function.
 *
 * Never returns secrets — storeId here is the same public store code customers
 * already use.
 */
async function readAppVersion(pkg) {
    if (!pkg) return null;
    try {
        const r = await getTursoClient().execute({
            sql: `SELECT min_build, update_message, store_url
                  FROM bws_app_versions WHERE package_name = ? LIMIT 1`,
            args: [pkg]
        });
        if (!r.rows.length) return null;
        const row = r.rows[0];
        return {
            minBuild: Number(row.min_build ?? 0),
            message: String(row.update_message ?? ''),
            storeUrl: String(row.store_url ?? '')
        };
    } catch {
        return null; // الجدول قد لا يكون موجوداً بعد
    }
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    try {
        // The response depends on the request Host / ?store= — must NOT be cached
        // by a shared CDN (would risk serving one store's identity to another).
        res.setHeader('Cache-Control', 'no-store');

        // إشارة التحديث الإجباري لكل تطبيق (حسب اسم الحزمة) — مستقلّة عن المتجر.
        const pkg = (req.query?.package || '').toString().trim();
        const appVersion = await readAppVersion(pkg);

        const t = await resolveTenant(req);
        if (!t) {
            res.status(200).json({ found: false, appVersion });
            return;
        }
        if (!t.active) {
            res.status(200).json({ found: true, active: false, name: t.name, appVersion });
            return;
        }
        res.status(200).json({
            found: true,
            active: true,
            storeId: t.storeId,
            slug: t.slug,
            name: t.name,
            appVersion
        });
    } catch (err) {
        console.error('[tenant] error', err);
        res.status(500).json({ error: 'تعذّر تحديد المتجر' });
    }
}
