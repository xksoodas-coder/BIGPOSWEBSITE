-- ============================================================================
--  جدول المنتجات في Turso — «الحالة الحالية» (صفّ واحد لكل منتج لكل متجر).
--  أعمدته مطابقة تمامًا لجدول products في Supabase (نفس الأسماء)، مع ترجمة
--  الأنواع إلى SQLite/libSQL:
--     numeric  → REAL      boolean → INTEGER(0/1)      jsonb → TEXT (JSON)
--     bigint   → INTEGER   timestamptz → TEXT
--
--  التشغيل: Turso Dashboard → قاعدتك → SQL Console (أو: turso db shell <db>)
-- ============================================================================

CREATE TABLE IF NOT EXISTS bws_products (
    store_id      TEXT    NOT NULL,               -- = bws_tenants.store_id
    uuid          TEXT    NOT NULL,               -- record_uuid (مطابق لـ Turso/Supabase)
    product_id    INTEGER,                        -- data.id (اختياري)
    name          TEXT    NOT NULL DEFAULT '',
    family        TEXT    NOT NULL DEFAULT '',    -- عائلات محزومة بـ ~@~
    price1        REAL    NOT NULL DEFAULT 0,     -- سعر البيع
    price2        REAL    NOT NULL DEFAULT 0,     -- الجملة
    price3        REAL    NOT NULL DEFAULT 0,
    price4        REAL    NOT NULL DEFAULT 0,
    price5        REAL    NOT NULL DEFAULT 0,
    price6        REAL    NOT NULL DEFAULT 0,
    price7        REAL    NOT NULL DEFAULT 0,
    quantity      REAL    NOT NULL DEFAULT 0,
    unit_type     TEXT    NOT NULL DEFAULT 'قطعة',
    image_version TEXT    NOT NULL DEFAULT '',    -- منه يُبنى رابط صورة R2
    barcode       TEXT    NOT NULL DEFAULT '',
    web_visible   INTEGER NOT NULL DEFAULT 1,     -- 1=ظاهر، 0=مخفي
    sizes         TEXT    NOT NULL DEFAULT '[]',  -- JSON: [{ "size_id": n, "name": "...", "capacity": n, "box_price": n }]  (سعر الشراء لا يُخزَّن هنا — سرّي)
    updated_at    TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    PRIMARY KEY (store_id, uuid)
);

CREATE INDEX IF NOT EXISTS bws_products_store_idx ON bws_products (store_id);
