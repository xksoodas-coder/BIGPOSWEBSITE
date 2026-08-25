// ============================================================================
//  علم «منتج جديد» — يضبطه أدمين المتجر من تطبيق SOFT ADMIN MANAGER بمفتاح
//  تشغيل/إطفاء لكل منتج. علم **عرضي بحت**: لا يمسّ أي سعر ولا turso_changelog،
//  بل جدول صغير مستقل، تمامًا كما يفعل bws_product_discounts.
//
//    bws_product_flags(
//        store_id     TEXT NOT NULL,
//        product_uuid TEXT NOT NULL,
//        is_new       INTEGER NOT NULL DEFAULT 0,   -- 1 = معلَّم «جديد»
//        marked_at    TEXT,                          -- وقت التعليم (للترتيب)
//        PRIMARY KEY(store_id, product_uuid))
//
//  التكلفة: قراءة واحدة كل 30 ثانية لكل متجر (كاش في الذاكرة) يتقاسمها كل
//  الطلبات مهما بلغ عدد الزبائن أو عدد الصفحات المُحمَّلة.
// ============================================================================

import { getTursoClient } from './turso.js';

export async function ensureFlagsTable(client) {
    await client.execute(`
        CREATE TABLE IF NOT EXISTS bws_product_flags (
            store_id     TEXT NOT NULL,
            product_uuid TEXT NOT NULL,
            is_new       INTEGER NOT NULL DEFAULT 0,
            marked_at    TEXT,
            PRIMARY KEY (store_id, product_uuid)
        )
    `);
    // فهرس «أحدث منتج معلَّم» — يجعل نبض الإشعارات يقرأ **سطراً واحداً** بدل
    // مسح كل أعلام المتجر في كل استطلاع. يُنشأ مرّة عند أوّل كتابة من الأدمين.
    await client.execute(`
        CREATE INDEX IF NOT EXISTS idx_flags_store_new_marked
            ON bws_product_flags (store_id, is_new, marked_at)
    `);
}

// كاش قصير في الذاكرة لكل متجر (يقلّل قراءات Turso في مسار عرض المنتجات).
const _memo = new Map();
const TTL_MS = 30 * 1000;

/** خريطة uuid → marked_at لكل المنتجات المعلَّمة «جديد». فارغة إن لم يوجد جدول. */
export async function getStoreNewFlags(storeId) {
    const e = _memo.get(storeId);
    if (e && Date.now() - e.at < TTL_MS) return e.map;
    const map = new Map();
    try {
        const r = await getTursoClient().execute({
            sql: `SELECT product_uuid, marked_at FROM bws_product_flags
                  WHERE store_id = ? AND is_new = 1`,
            args: [storeId]
        });
        for (const row of r.rows) {
            map.set(row.product_uuid, String(row.marked_at || ''));
        }
    } catch { /* الجدول غير موجود بعد → لا منتجات جديدة */ }
    _memo.set(storeId, { at: Date.now(), map });
    return map;
}

/** يُبطل كاش متجر (يُستدعى بعد أي كتابة من لوحة الأدمين). */
export function invalidateNewFlags(storeId) {
    _memo.delete(storeId);
}

/** تشغيل/إطفاء علم «جديد» لمنتج. يُنشئ الجدول عند الحاجة ويُبطل الكاش. */
export async function setNewFlag(storeId, productUuid, value) {
    const client = getTursoClient();
    await ensureFlagsTable(client);
    await client.execute({
        sql: `INSERT INTO bws_product_flags (store_id, product_uuid, is_new, marked_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(store_id, product_uuid) DO UPDATE SET
                  is_new    = excluded.is_new,
                  marked_at = excluded.marked_at`,
        args: [storeId, productUuid, value ? 1 : 0, new Date().toISOString()]
    });
    invalidateNewFlags(storeId);
}
