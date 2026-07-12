// ============================================================================
//  التخفيضات (العروض) لكل منتج — يضبطها تطبيق BIGSOFT MOBI عند وضع تخفيض.
//  في BIGSOFT MOBI التخفيض = تعديل سعر حقيقي على حقل السعر (يُزامَن إلى bws_products)،
//  وهذا الجدول يحفظ **فقط السعر القديم + النوع** كي يعرض تطبيق store الشطب والشارة.
//  إذن دور هذا الملف هنا صار **للعرض فقط**: لا يُعيد حساب السعر (bws_products أصلاً
//  فيه السعر المخفّض)، بل يُرفق oldPrice + discountPercent لعرضهما.
//
//    bws_product_discounts(
//        store_id, product_uuid,
//        tier INTEGER,          -- مستوى السعر المخفّض
//        old_price REAL,        -- السعر قبل التخفيض (للشطب)
//        disc_type TEXT, disc_value REAL, updated_at TEXT,
//        PRIMARY KEY(store_id, product_uuid))
// ============================================================================

import { getTursoClient } from './turso.js';

export async function ensureDiscountTable(client) {
    await client.execute(`
        CREATE TABLE IF NOT EXISTS bws_product_discounts (
            store_id     TEXT NOT NULL,
            product_uuid TEXT NOT NULL,
            tier         INTEGER NOT NULL DEFAULT 1,
            old_price    REAL NOT NULL DEFAULT 0,
            disc_type    TEXT NOT NULL DEFAULT 'price',
            disc_value   REAL NOT NULL DEFAULT 0,
            updated_at   TEXT,
            PRIMARY KEY (store_id, product_uuid)
        )
    `);
}

// كاش قصير في الذاكرة لكل متجر (يقلّل قراءات Turso في مسار عرض المنتجات).
const _memo = new Map();
const TTL_MS = 30 * 1000;

/** خريطة uuid → { oldPrice, type, value } لكل تخفيضات المتجر. فارغة إن لم يوجد جدول. */
export async function getStoreDiscounts(storeId) {
    const e = _memo.get(storeId);
    if (e && Date.now() - e.at < TTL_MS) return e.map;
    const map = new Map();
    try {
        const r = await getTursoClient().execute({
            sql: `SELECT product_uuid, old_price, disc_type, disc_value
                  FROM bws_product_discounts WHERE store_id = ?`,
            args: [storeId]
        });
        for (const row of r.rows) {
            map.set(row.product_uuid, {
                oldPrice: Number(row.old_price ?? 0),
                type: String(row.disc_type ?? 'price'),
                value: Number(row.disc_value ?? 0)
            });
        }
    } catch { /* الجدول/العمود غير موجود بعد → لا تخفيضات */ }
    _memo.set(storeId, { at: Date.now(), map });
    return map;
}

/** يُبطل كاش متجر (يُستدعى بعد أي كتابة). */
export function invalidateDiscounts(storeId) {
    _memo.delete(storeId);
}

/**
 * يُرفق معلومات العرض على منتج مُسعَّر (بعد projectProductPrices):
 *   oldPrice        → السعر الأصلي (يُعرض مشطوبًا) — من سجلّ التخفيض
 *   discountPercent → النسبة المشتقّة من (السعر الحالي مقابل القديم)
 * لا يغيّر p.price لأن bws_products يحمل أصلاً السعر المخفّض (تعديل من BIGSOFT MOBI).
 * يتجاهل السجلّ إن كان السعر القديم ليس أعلى من الحالي (لا تخفيض ساري).
 */
export function applyDiscount(p, disc) {
    if (!disc) return p;
    const cur = Number(p.price ?? 0);
    const oldPrice = Number(disc.oldPrice ?? 0);
    if (!(cur > 0) || !(oldPrice > cur)) return p;
    p.oldPrice = oldPrice;
    p.discountPercent = Math.round((1 - cur / oldPrice) * 100);
    return p;
}
