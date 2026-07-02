import { productImageUrl, productImageUrlLegacy } from './r2.js';
import { familyImageUrl, familyImageUrlLegacy } from './r2.js';
import { getCatalog } from './catalog.js';

/**
 * Supabase read layer (server-side only).
 *
 * Products/families for the storefront are served from Supabase (a clean
 * current-state table) instead of reducing Turso's changelog. This module
 * returns objects shaped IDENTICALLY to _lib/catalog.js (getCatalog) and
 * _lib/families.js (flattenFamilies) so bootstrap.js / products.js can swap the
 * source with no downstream changes (pricing projection, favourites, images,
 * family filter all keep working).
 *
 * Access uses the service_role key from env and happens ONLY here on the
 * server — the browser never talks to Supabase, so hidden price tiers stay
 * hidden. RLS blocks everything except service_role.
 *
 * Env:
 *   SUPABASE_URL          e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  the service_role key (secret, server-side only)
 */

const PRODUCT_COLUMNS =
    'uuid,product_id,name,family,price1,price2,price3,price4,price5,price6,price7,' +
    'quantity,unit_type,image_version,barcode,sizes';

function sbConfig() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
    return { url: url.replace(/\/+$/, ''), key };
}

/**
 * Per-store rollout switch. A store reads products/families from Supabase only
 * when Supabase is configured AND its store_id is listed in SUPABASE_STORES
 * (comma-separated). Everything else stays on Turso. This lets us cut over one
 * store at a time (start with NAILMO) and roll back instantly by editing the env.
 */
export function supabaseEnabledFor(storeId) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return false;
    const list = (process.env.SUPABASE_STORES || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    return list.includes('*') || list.includes(storeId);
}

/**
 * Unified catalog getter: Supabase when the store is switched over (with an
 * automatic fall back to the Turso catalog on any Supabase error, so the
 * storefront never breaks), otherwise the Turso catalog.
 */
export async function getStoreCatalog(client, storeId) {
    if (supabaseEnabledFor(storeId)) {
        try {
            return await getSupabaseCatalog(storeId);
        } catch (e) {
            console.error('[catalog] supabase failed, falling back to turso:', e?.message || e);
        }
    }
    return getCatalog(client, storeId);
}

async function sbGet(path) {
    const { url, key } = sbConfig();
    const res = await fetch(`${url}/rest/v1/${path}`, {
        headers: {
            apikey: key,
            authorization: `Bearer ${key}`,
            accept: 'application/json'
        }
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`supabase ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

/**
 * Return the store's catalog (array of shaped products, sorted by name),
 * WITHOUT per-customer flags — same shape as getCatalog() from catalog.js.
 * Hidden products (web_visible=false) are excluded server-side.
 */
export async function getSupabaseCatalog(storeId) {
    const q = `products?store_id=eq.${encodeURIComponent(storeId)}` +
              `&web_visible=eq.true&select=${PRODUCT_COLUMNS}`;
    const rows = await sbGet(q);

    const products = rows.map((row) => {
        const uuid = row.uuid;
        const imageVersion = String(row.image_version ?? '');
        const price1 = Number(row.price1 ?? 0);
        const quantity = Number(row.quantity ?? 0);
        const sizes = Array.isArray(row.sizes)
            ? row.sizes
                .map((s) => ({ name: String(s.name ?? ''), capacity: Number(s.capacity ?? 0) }))
                .filter((s) => s.name && s.capacity > 0)
            : [];
        return {
            uuid,
            id: row.product_id ?? null,
            name: row.name ?? '',
            family: (row.family || '').toString().trim(),
            price: price1,
            price1,
            price2: Number(row.price2 ?? 0),
            price3: Number(row.price3 ?? 0),
            price4: Number(row.price4 ?? 0),
            price5: Number(row.price5 ?? 0),
            price6: Number(row.price6 ?? 0),
            price7: Number(row.price7 ?? 0),
            quantity,
            available: quantity > 0,          // ← ≤ 0 → «غير متاح»
            unitType: row.unit_type ?? 'قطعة',
            imageVersion,
            imageUrl: imageVersion ? productImageUrl(storeId, uuid, imageVersion) : '',
            imageUrlLegacy: imageVersion ? productImageUrlLegacy(uuid, imageVersion) : '',
            barcode: row.barcode ?? '',
            sizes
        };
    });

    // Preserve the exact Arabic ordering the Turso path used.
    products.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return products;
}

/**
 * Return the store's families, same shape as flattenFamilies() from
 * families.js: { id, parentId, name, uuid, imageVersion, imageUrl, imageUrlLegacy }.
 * The phone already uploads the final (tombstone-resolved) list, so no
 * deletion/tombstone handling is needed here.
 */
export async function getSupabaseFamilies(storeId) {
    const q = `families?store_id=eq.${encodeURIComponent(storeId)}` +
              `&select=family_id,parent_id,name,uuid,image_version&order=family_id.asc`;
    const rows = await sbGet(q);

    return rows.map((row) => {
        const uuid = String(row.uuid || '').trim();
        const imageVersion = String(row.image_version || '').trim();
        return {
            id: Number(row.family_id),
            parentId: row.parent_id == null ? null : Number(row.parent_id),
            name: String(row.name || '').trim(),
            uuid,
            imageVersion,
            imageUrl: (uuid && imageVersion) ? familyImageUrl(storeId, uuid, imageVersion) : '',
            imageUrlLegacy: (uuid && imageVersion) ? familyImageUrlLegacy(uuid, imageVersion) : ''
        };
    });
}
