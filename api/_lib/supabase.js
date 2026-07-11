import { productImageUrl, productImageUrlLegacy } from './r2.js';
import { familyImageUrl, familyImageUrlLegacy } from './r2.js';

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

// ── كاش قصير في الذاكرة (لكل نسخة دالة serverless) يقلّل قراءات Supabase ──
// المتكرّرة للكتالوج/العائلات/الصفحات. TTL قصير يوازن بين قلّة القراءات وحداثة
// البيانات (تغييرات المنتجات تظهر خلال ثوانٍ). القيم المخزّنة لا تُعدَّل لاحقًا
// (projectProductPrices ينسخ الكائن) فالمشاركة آمنة.
const _memo = new Map();
const MEMO_TTL_MS = 45 * 1000;
function memoGet(key) {
    const e = _memo.get(key);
    if (e && Date.now() - e.at < MEMO_TTL_MS) return e.val;
    return undefined;
}
function memoSet(key, val) {
    if (_memo.size > 500) _memo.clear(); // حدّ أمان ضد نمو غير محدود
    _memo.set(key, { at: Date.now(), val });
    return val;
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
 * Fetch ALL rows for a query, paging past PostgREST's max-rows cap (default
 * 1000). Without this a store with >1000 products/families gets a silently
 * truncated (and, with no ORDER BY, non-deterministic) list — products would
 * randomly go missing. `path` MUST include an `order=` for stable paging.
 */
async function sbGetAll(path, pageSize = 1000) {
    const { url, key } = sbConfig();
    const all = [];
    let from = 0;
    let total = Infinity;
    while (from < total) {
        const to = from + pageSize - 1;
        const res = await fetch(`${url}/rest/v1/${path}`, {
            headers: {
                apikey: key,
                authorization: `Bearer ${key}`,
                accept: 'application/json',
                Range: `${from}-${to}`,
                'Range-Unit': 'items',
                Prefer: 'count=exact'
            }
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`supabase ${res.status}: ${text.slice(0, 200)}`);
        }
        const batch = await res.json();
        // Content-Range: "items 0-999/12345" → learn the real total to bound the loop.
        const cr = res.headers.get('content-range') || '';
        const m = cr.match(/\/(\d+)\s*$/);
        if (m) total = Number(m[1]);
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        from += batch.length; // advance by what the server actually returned
        if (!m && batch.length < pageSize) break; // no total header → stop when short
    }
    return all;
}

/** يحوّل صفّ Supabase خام إلى شكل المنتج الموحّد (نفس شكل getCatalog). */
function shapeProduct(storeId, row) {
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
}

/**
 * Return the store's catalog (array of shaped products, sorted by name),
 * WITHOUT per-customer flags — same shape as getCatalog() from catalog.js.
 * Hidden products (web_visible=false) are excluded server-side.
 */
export async function getSupabaseCatalog(storeId) {
    const hit = memoGet(`cat:${storeId}`);
    if (hit) return hit;
    const q = `products?store_id=eq.${encodeURIComponent(storeId)}` +
              `&web_visible=eq.true&select=${PRODUCT_COLUMNS}&order=uuid.asc`;
    const rows = await sbGetAll(q);
    const products = rows.map((row) => shapeProduct(storeId, row));
    // Preserve the exact Arabic ordering the Turso path used.
    products.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return memoSet(`cat:${storeId}`, products);
}

/**
 * قراءة **صفحة واحدة** من منتجات عائلة معيّنة مباشرةً من Supabase (لا نقرأ كامل
 * الكتالوج). يقلّل قراءات Supabase إلى صفوف الصفحة فقط عبر:
 *   - تصفية العائلة على مستوى القاعدة: المنتج يحمل الاسم إمّا وحده أو ضمن سلسلة
 *     محزومة بـ "~@~" → or=(eq, يبدأ بـ، ينتهي بـ، في الوسط).
 *   - web_visible=true (+ quantity>0 عند إخفاء غير المتوفر).
 *   - ترتيب name.asc + Range للصفحة + Prefer count=exact لإجمالي العدد.
 * يعيد { products: [مُشكَّلة], total }. يرمي عند الخطأ (المستدعي يتراجع للكتالوج).
 */
export async function getSupabaseFamilyPage(storeId, familyName, { hideOOS = false, limit = 30, offset = 0 } = {}) {
    const memoKey = `page:${storeId}|${familyName}|${hideOOS ? 1 : 0}|${limit}|${offset}`;
    const hit = memoGet(memoKey);
    if (hit) return hit;
    const { url, key } = sbConfig();
    const sep = '~@~';
    // نُهرّب اسم العائلة للاستعمال داخل قيم PostgREST. الأسماء الشائعة (عربية/
    // أرقام/مسافات) آمنة؛ الحالات النادرة (فاصلة/أقواس) قد ترمي → تراجُع.
    const enc = (s) => encodeURIComponent(s);
    const v = enc(familyName);
    const s = enc(sep);
    const orFilter =
        `or=(family.eq.${v},family.like.${v}${s}*,family.like.*${s}${v},family.like.*${s}${v}${s}*)`;
    let path = `products?store_id=eq.${encodeURIComponent(storeId)}` +
               `&web_visible=eq.true`;
    if (hideOOS) path += `&quantity=gt.0`;
    path += `&${orFilter}&select=${PRODUCT_COLUMNS}&order=name.asc`;

    const from = Math.max(0, offset);
    const to = from + Math.max(1, limit) - 1;
    const res = await fetch(`${url}/rest/v1/${path}`, {
        headers: {
            apikey: key,
            authorization: `Bearer ${key}`,
            accept: 'application/json',
            Range: `${from}-${to}`,
            'Range-Unit': 'items',
            Prefer: 'count=exact'
        }
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`supabase family-page ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows = await res.json();
    const cr = res.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)\s*$/);
    const total = m ? Number(m[1]) : (Array.isArray(rows) ? rows.length : 0);
    const products = (Array.isArray(rows) ? rows : []).map((row) => shapeProduct(storeId, row));
    return memoSet(memoKey, { products, total });
}

/**
 * Return the store's families, same shape as flattenFamilies() from
 * families.js: { id, parentId, name, uuid, imageVersion, imageUrl, imageUrlLegacy }.
 * The phone already uploads the final (tombstone-resolved) list, so no
 * deletion/tombstone handling is needed here.
 */
export async function getSupabaseFamilies(storeId) {
    const hit = memoGet(`fam:${storeId}`);
    if (hit) return hit;
    const q = `families?store_id=eq.${encodeURIComponent(storeId)}` +
              `&select=family_id,parent_id,name,uuid,image_version&order=family_id.asc`;
    const rows = await sbGetAll(q);

    const families = rows.map((row) => {
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
    return memoSet(`fam:${storeId}`, families);
}
