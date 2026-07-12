// ============================================================================
//  التخفيضات (العروض) لكل منتج — يضبطها تطبيق الأدمين (SOFT ADMIN MANAGER).
//  تُخزَّن في جدول مستقلّ bws_product_discounts (وليس داخل bws_products) كي لا
//  تُمسح عند مزامنة المنتجات من الهاتف/سطح المكتب.
//
//    bws_product_discounts(
//        store_id     TEXT,
//        product_uuid TEXT,
//        disc_type    TEXT   -- 'price' (سعر جديد) | 'percent' (نسبة %)
//        disc_value   REAL,  -- السعر الجديد أو النسبة (0..100)
//        updated_at   TEXT,
//        PRIMARY KEY(store_id, product_uuid))
// ============================================================================

import { getTursoClient } from './turso.js';

export async function ensureDiscountTable(client) {
    await client.execute(`
        CREATE TABLE IF NOT EXISTS bws_product_discounts (
            store_id     TEXT NOT NULL,
            product_uuid TEXT NOT NULL,
            disc_type    TEXT NOT NULL,
            disc_value   REAL NOT NULL,
            updated_at   TEXT,
            PRIMARY KEY (store_id, product_uuid)
        )
    `);
}

// كاش قصير في الذاكرة لكل متجر (يقلّل قراءات Turso في مسار عرض المنتجات).
const _memo = new Map();
const TTL_MS = 30 * 1000;

/** خريطة uuid → { type, value } لكل تخفيضات المتجر. فارغة إن لم يوجد جدول بعد. */
export async function getStoreDiscounts(storeId) {
    const e = _memo.get(storeId);
    if (e && Date.now() - e.at < TTL_MS) return e.map;
    const map = new Map();
    try {
        const r = await getTursoClient().execute({
            sql: `SELECT product_uuid, disc_type, disc_value
                  FROM bws_product_discounts WHERE store_id = ?`,
            args: [storeId]
        });
        for (const row of r.rows) {
            map.set(row.product_uuid, {
                type: String(row.disc_type),
                value: Number(row.disc_value)
            });
        }
    } catch { /* الجدول غير موجود بعد → لا تخفيضات */ }
    _memo.set(storeId, { at: Date.now(), map });
    return map;
}

/** يُبطل كاش متجر بعد أن يعدّل الأدمين تخفيضاته (فتظهر أسرع). */
export function invalidateDiscounts(storeId) {
    _memo.delete(storeId);
}

/**
 * يطبّق تخفيضًا على منتج مُسعَّر (بعد projectProductPrices). يعدّل الكائن موضعيًا:
 *   price           → السعر الجديد (بعد التخفيض)
 *   oldPrice        → السعر الأصلي (يُعرض مشطوبًا بالأحمر)
 *   discountPercent → النسبة الصحيحة (لشارة -%)
 * يتجاهل أي تخفيض غير منطقي (سعر جديد ≥ القديم، نسبة خارج 1..99).
 */
export function applyDiscount(p, disc) {
    if (!disc) return p;
    const oldPrice = Number(p.price ?? 0);
    if (!(oldPrice > 0)) return p;

    let newPrice = oldPrice;
    let percent = 0;
    if (disc.type === 'percent') {
        percent = Math.round(disc.value);
        if (percent <= 0 || percent >= 100) return p;
        newPrice = Math.round(oldPrice * (1 - percent / 100));
    } else { // 'price' — سعر جديد صريح
        newPrice = Math.round(Number(disc.value));
        if (!(newPrice > 0) || newPrice >= oldPrice) return p;
        percent = Math.round((1 - newPrice / oldPrice) * 100);
    }
    if (!(newPrice > 0) || newPrice >= oldPrice || percent <= 0) return p;

    p.price = newPrice;
    p.oldPrice = oldPrice;
    p.discountPercent = percent;
    return p;
}
