// ============================================================================
//  طبقة قراءة المنتجات/العائلات من Turso (جدول bws_products + turso_families).
//
//  الغرض: تجريب قراءة الكتالوج من Turso بدل Supabase. الدوال تُعيد كائنات بشكل
//  مطابق تمامًا لدوال supabase.js (getSupabaseCatalog/…) فتستبدلها بلا تغيير في
//  المستدعي.
//
//  التوجيه الآمن (getCatalog/getFamilyPage/getFamilies): إن كان للمتجر صفوف في
//  bws_products → يُقرأ من Turso؛ وإلا → يتراجع إلى Supabase (فلا يتعطّل متجر لم
//  يُنسخ بعد إلى bws_products).
// ============================================================================

import { getTursoClient } from './turso.js';
import {
    productImageUrl, productImageUrlLegacy,
    familyImageUrl, familyImageUrlLegacy
} from './r2.js';
import { flattenFamilies } from './families.js';
import {
    getSupabaseCatalog, getSupabaseFamilyPage, getSupabaseFamilies
} from './supabase.js';

// كاش قصير في الذاكرة (لكل نسخة دالة) يقلّل قراءات Turso المتكرّرة.
const _memo = new Map();
const MEMO_TTL_MS = 45 * 1000;
function memoGet(key) {
    const e = _memo.get(key);
    if (e && Date.now() - e.at < MEMO_TTL_MS) return e.val;
    return undefined;
}
function memoSet(key, val) {
    if (_memo.size > 500) _memo.clear();
    _memo.set(key, { at: Date.now(), val });
    return val;
}

// يحوّل صفّ bws_products إلى شكل المنتج الموحّد (نفس شكل getSupabaseCatalog).
function shapeProduct(storeId, row) {
    const uuid = row.uuid;
    const imageVersion = String(row.image_version ?? '');
    const price1 = Number(row.price1 ?? 0);
    const quantity = Number(row.quantity ?? 0);
    let sizes = [];
    try {
        const s = JSON.parse(row.sizes || '[]');
        if (Array.isArray(s)) {
            sizes = s
                .map((x) => ({ name: String(x.name ?? ''), capacity: Number(x.capacity ?? 0) }))
                .filter((x) => x.name && x.capacity > 0);
        }
    } catch { /* sizes تالف → [] */ }
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
        available: quantity > 0,
        unitType: row.unit_type ?? 'قطعة',
        imageVersion,
        imageUrl: imageVersion ? productImageUrl(storeId, uuid, imageVersion) : '',
        imageUrlLegacy: imageVersion ? productImageUrlLegacy(uuid, imageVersion) : '',
        barcode: row.barcode ?? '',
        sizes
    };
}

/** هل للمتجر منتجات في bws_products؟ (يُقرّر مصدر القراءة). مخزَّن مؤقتًا. */
export async function tursoHasCatalog(storeId) {
    const hit = memoGet(`has:${storeId}`);
    if (hit !== undefined) return hit;
    let val = false;
    try {
        const r = await getTursoClient().execute({
            sql: 'SELECT 1 FROM bws_products WHERE store_id = ? LIMIT 1',
            args: [storeId]
        });
        val = r.rows.length > 0;
    } catch { val = false; } // الجدول قد لا يكون موجودًا بعد
    return memoSet(`has:${storeId}`, val);
}

/** كل منتجات المتجر (web_visible=1)، مرتّبة بالاسم عربيًا — كـ getSupabaseCatalog. */
export async function getTursoCatalog(storeId) {
    const hit = memoGet(`cat:${storeId}`);
    if (hit) return hit;
    const r = await getTursoClient().execute({
        sql: 'SELECT * FROM bws_products WHERE store_id = ? AND web_visible = 1',
        args: [storeId]
    });
    const products = r.rows.map((row) => shapeProduct(storeId, row));
    products.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return memoSet(`cat:${storeId}`, products);
}

/** صفحة منتجات عائلة (نفس منطق getSupabaseFamilyPage) — { products, total }. */
export async function getTursoFamilyPage(storeId, familyName, { hideOOS = false, limit = 30, offset = 0 } = {}) {
    const memoKey = `page:${storeId}|${familyName}|${hideOOS ? 1 : 0}|${limit}|${offset}`;
    const hit = memoGet(memoKey);
    if (hit) return hit;
    const sep = '~@~';
    let sql = 'SELECT *, COUNT(*) OVER() AS __total FROM bws_products WHERE store_id = ? AND web_visible = 1';
    const args = [storeId];
    if (hideOOS) sql += ' AND quantity > 0';
    // المنتج قد يحمل العائلة وحدها أو ضمن سلسلة محزومة بـ ~@~.
    sql += ' AND (family = ? OR family LIKE ? OR family LIKE ? OR family LIKE ?)';
    args.push(familyName, `${familyName}${sep}%`, `%${sep}${familyName}`, `%${sep}${familyName}${sep}%`);
    sql += ' ORDER BY name ASC LIMIT ? OFFSET ?';
    args.push(Math.max(1, limit), Math.max(0, offset));

    const r = await getTursoClient().execute({ sql, args });
    const total = r.rows.length ? Number(r.rows[0].__total) : 0;
    const products = r.rows.map((row) => shapeProduct(storeId, row));
    return memoSet(memoKey, { products, total });
}

/** عائلات المتجر من turso_families (+ tombstones) — نفس شكل getSupabaseFamilies. */
export async function getTursoFamilies(storeId) {
    const hit = memoGet(`fam:${storeId}`);
    if (hit) return hit;
    const client = getTursoClient();
    const [famRes, tombRes] = await Promise.all([
        client.execute({ sql: 'SELECT json_payload FROM turso_families WHERE store_id = ? LIMIT 1', args: [storeId] }),
        client.execute({ sql: 'SELECT json_payload FROM turso_deleted_properties WHERE store_id = ? LIMIT 1', args: [storeId] })
            .catch(() => ({ rows: [] }))
    ]);
    const famJson = famRes.rows.length ? famRes.rows[0].json_payload : '[]';
    const tombJson = tombRes.rows.length ? tombRes.rows[0].json_payload : null;
    const families = flattenFamilies(storeId, famJson, tombJson);
    return memoSet(`fam:${storeId}`, families);
}

// ── توجيه: Turso إن كان للمتجر بيانات في bws_products، وإلا Supabase (تراجُع آمن) ──
export async function getCatalog(storeId) {
    return (await tursoHasCatalog(storeId)) ? getTursoCatalog(storeId) : getSupabaseCatalog(storeId);
}
export async function getFamilyPage(storeId, familyName, opts) {
    return (await tursoHasCatalog(storeId))
        ? getTursoFamilyPage(storeId, familyName, opts)
        : getSupabaseFamilyPage(storeId, familyName, opts);
}
export async function getFamilies(storeId) {
    return (await tursoHasCatalog(storeId)) ? getTursoFamilies(storeId) : getSupabaseFamilies(storeId);
}
