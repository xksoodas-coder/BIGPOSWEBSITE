import { getTursoClient } from './turso.js';

/**
 * Multi-tenant resolver. Maps an incoming request (custom domain / subdomain /
 * ?store= slug) to a store in the bws_tenants registry.
 *
 *   bws_tenants(
 *     store_id PK,          -- same code used across all other tables
 *     slug UNIQUE,          -- ali  → ali.<root> or ?store=ali
 *     custom_domain UNIQUE, -- www.boutique-ali.com (optional)
 *     domain_status,        -- none | pending | active
 *     display_name,
 *     is_active,            -- 1/0
 *     plan, created_at, updated_at
 *   )
 *
 * Root domain comes from env BWS_ROOT_DOMAIN (e.g. "bigstore.dz"). Subdomains
 * of that root resolve to {slug}. On the platform/preview host (vercel.app),
 * the ?store= query (or x-store-slug header) selects a tenant for testing.
 */

let _cache = { at: 0, byDomain: new Map(), bySlug: new Map() };
const TTL_MS = 60 * 1000;
// After a failed refresh we keep serving the previous registry and retry soon,
// instead of 500-ing (which made the storefront forget its own store).
const RETRY_MS = 5 * 1000;

// Host labels that are the platform itself, never a store slug.
const PLATFORM_LABELS = new Set(['www', 'api', 'admin', 'app', 'store']);

/** Configured platform roots. Accepts a comma-separated list. */
function rootDomains() {
    return (process.env.BWS_ROOT_DOMAIN || '')
        .toLowerCase()
        .split(',')
        .map(s => s.trim().replace(/^\.+/, '').replace(/:.*/, ''))
        .filter(Boolean);
}

export async function ensureTenantsTable(client) {
    await client.execute(`
        CREATE TABLE IF NOT EXISTS bws_tenants (
            store_id      TEXT PRIMARY KEY,
            slug          TEXT UNIQUE NOT NULL,
            custom_domain TEXT,
            domain_status TEXT DEFAULT 'none',
            display_name  TEXT,
            is_active     INTEGER DEFAULT 1,
            plan          TEXT DEFAULT 'basic',
            created_at    TEXT,
            updated_at    TEXT
        )
    `);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_tenants_slug ON bws_tenants(slug)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_tenants_domain ON bws_tenants(custom_domain)`);
}

export function invalidateTenantCache() { _cache.at = 0; }

async function loadAll(client) {
    const hasCache = _cache.bySlug.size || _cache.byDomain.size;
    if (Date.now() - _cache.at < TTL_MS && hasCache) return;
    try {
        // القراءة أولاً بلا تهيئة: كان كل تحديث للكاش يُرسل CREATE TABLE +
        // فهرسين قبل الاستعلام، أي ثلاث رحلات إضافية لقاعدة البيانات على كل
        // نسخة باردة (يظهر أثرها كبطء في تسجيل الدخول). التهيئة تُستدعى الآن
        // فقط إذا كان الجدول غير موجود فعلاً.
        let r;
        try {
            r = await client.execute(
                `SELECT store_id, slug, custom_domain, display_name, is_active FROM bws_tenants`
            );
        } catch {
            await ensureTenantsTable(client);
            r = await client.execute(
                `SELECT store_id, slug, custom_domain, display_name, is_active FROM bws_tenants`
            );
        }
        const byDomain = new Map();
        const bySlug = new Map();
        for (const row of r.rows) {
            const t = {
                storeId: row.store_id,
                slug: (row.slug || '').toLowerCase(),
                customDomain: (row.custom_domain || '').toLowerCase().replace(/^www\./, ''),
                name: row.display_name || '',
                active: Number(row.is_active) !== 0
            };
            if (t.slug) bySlug.set(t.slug, t);
            if (t.customDomain) byDomain.set(t.customDomain, t);
        }
        _cache = { at: Date.now(), byDomain, bySlug };
    } catch (err) {
        // A transient DB hiccup must NOT make a known store look unknown (the
        // storefront then shows the "رمز المتجر" field on a store's own
        // subdomain). Serve the previous registry and retry shortly.
        if (hasCache) {
            _cache.at = Date.now() - TTL_MS + RETRY_MS;
            console.error('[tenant] refresh failed, serving cached registry:', err?.message || err);
            return;
        }
        throw err;
    }
}

function hostOf(req) {
    const raw = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
    return raw.split(',')[0].trim().toLowerCase().split(':')[0];
}

function explicitSlug(req) {
    const q = (req.query && (req.query.store || req.query.slug)) || '';
    const h = req.headers['x-store-slug'] || '';
    return (q || h).toString().trim().toLowerCase();
}

/**
 * Returns the tenant object {storeId, slug, customDomain, name, active} or null.
 * Host-based matches (custom domain / subdomain) are trusted; the explicit slug
 * is only honored on the platform/preview host (not a tenant host) — so a
 * customer on store A's domain cannot spoof store B.
 */
export async function resolveTenant(req) {
    const client = getTursoClient();
    await loadAll(client);

    const host = hostOf(req);
    const hostNoWww = host.replace(/^www\./, '');
    const roots = rootDomains();

    // 1) Custom domain (exact, with/without www).
    if (_cache.byDomain.has(host)) return _cache.byDomain.get(host);
    if (_cache.byDomain.has(hostNoWww)) return _cache.byDomain.get(hostNoWww);

    // 2) Subdomain of a configured platform root: {slug}.<root>
    const root = roots.find(r => host.endsWith('.' + r));
    if (root) {
        const sub = host.slice(0, -(root.length + 1));
        const slug = sub.split('.').pop(); // last label, supports nested
        if (slug && !PLATFORM_LABELS.has(slug)) {
            // Authoritative: a store subdomain never falls through to the
            // client-supplied slug (a customer on store A's domain must not be
            // able to spoof store B).
            return _cache.bySlug.get(slug) || null;
        }
        // `www.<root>` is the platform host (not a store subdomain) — fall
        // through to explicit ?store= resolution below, exactly like the apex
        // and preview hosts. Otherwise guests on www couldn't resolve a store
        // (so 'direct' mode would wrongly 401), while colors/settings — read
        // post-login from the session — kept working, causing a confusing split.
    } else if (!host.endsWith('.vercel.app')) {
        // 2b) Env-independent fallback: any host of the form {label}.<domain>
        //     whose first label is a registered slug IS that store. Without
        //     this, forgetting to set BWS_ROOT_DOMAIN silently disabled
        //     subdomain resolution, and first-time visitors on asd.<root> were
        //     asked for a store code (returning visitors were saved by the
        //     slug cached in their browser — hence the "random" failures).
        const labels = host.split('.');
        if (labels.length >= 3 && !PLATFORM_LABELS.has(labels[0])) {
            const t = _cache.bySlug.get(labels[0]);
            if (t) return t;
        }
    }

    // 3) Platform/preview host (e.g. *.vercel.app or apex) → explicit slug.
    const slug = explicitSlug(req);
    if (slug) return _cache.bySlug.get(slug) || null;

    return null;
}
