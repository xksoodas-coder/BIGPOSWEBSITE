// ============================================================================
//  نسخ (لمرة واحدة) منتجات متجر محدّد من Supabase → جدول Turso bws_products.
//
//  «نسخ فقط»: لا يحذف من Supabase ولا يزامن — يقرأ أسطر المنتجات ويكتبها في
//  Turso. يستعمل INSERT OR REPLACE (على المفتاح store_id+uuid) فيمكن إعادة
//  تشغيله بأمان دون تكرار الأسطر.
//
//  التشغيل (من مجلد bigwebstore، بعد `npm install` مرة واحدة):
//    node scripts/copy-products-to-turso.js <STORE_ID>
//  مثال:
//    node scripts/copy-products-to-turso.js NAILMO
//
//  يقرأ الأسرار من متغيّرات البيئة:
//    TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================================

import { createClient } from '@libsql/client';

const STORE_ID = process.argv[2];
if (!STORE_ID) {
    console.error('الاستعمال: node scripts/copy-products-to-turso.js <STORE_ID>');
    process.exit(1);
}

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!SB_URL || !SB_KEY) { console.error('❌ حدّد SUPABASE_URL و SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!TURSO_URL || !TURSO_TOKEN) { console.error('❌ حدّد TURSO_DATABASE_URL و TURSO_AUTH_TOKEN'); process.exit(1); }

// نفس أعمدة Supabase بالضبط (نقرؤها كما هي).
const COLUMNS = [
    'store_id', 'uuid', 'product_id', 'name', 'family',
    'price1', 'price2', 'price3', 'price4', 'price5', 'price6', 'price7',
    'quantity', 'unit_type', 'image_version', 'barcode', 'web_visible', 'sizes', 'updated_at'
];

// يجلب كل صفوف المنتجات لمتجر من Supabase (يتخطّى حدّ 1000 لكل طلب).
async function fetchAllFromSupabase(storeId) {
    const all = [];
    const pageSize = 1000;
    let from = 0, total = Infinity;
    const select = COLUMNS.join(',');
    while (from < total) {
        const to = from + pageSize - 1;
        const url = `${SB_URL}/rest/v1/products?store_id=eq.${encodeURIComponent(storeId)}&select=${select}&order=uuid.asc`;
        const res = await fetch(url, {
            headers: {
                apikey: SB_KEY,
                authorization: `Bearer ${SB_KEY}`,
                accept: 'application/json',
                Range: `${from}-${to}`,
                'Range-Unit': 'items',
                Prefer: 'count=exact'
            }
        });
        if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const batch = await res.json();
        const cr = res.headers.get('content-range') || '';
        const m = cr.match(/\/(\d+)\s*$/);
        if (m) total = Number(m[1]);
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        from += batch.length;
        if (!m && batch.length < pageSize) break;
    }
    return all;
}

// يحوّل صفّ Supabase إلى وسائط INSERT بنفس ترتيب الأعمدة (مع ترجمة الأنواع).
function toRowArgs(r) {
    return [
        r.store_id ?? STORE_ID,
        r.uuid,
        r.product_id ?? null,
        r.name ?? '',
        r.family ?? '',
        Number(r.price1 ?? 0),
        Number(r.price2 ?? 0),
        Number(r.price3 ?? 0),
        Number(r.price4 ?? 0),
        Number(r.price5 ?? 0),
        Number(r.price6 ?? 0),
        Number(r.price7 ?? 0),
        Number(r.quantity ?? 0),
        r.unit_type ?? 'قطعة',
        r.image_version ?? '',
        r.barcode ?? '',
        (r.web_visible === false ? 0 : 1),                       // boolean → 0/1
        JSON.stringify(Array.isArray(r.sizes) ? r.sizes : (r.sizes ?? [])), // jsonb → TEXT
        (r.updated_at ?? new Date().toISOString())
    ];
}

const INSERT_SQL =
    `INSERT OR REPLACE INTO bws_products
     (store_id,uuid,product_id,name,family,price1,price2,price3,price4,price5,price6,price7,
      quantity,unit_type,image_version,barcode,web_visible,sizes,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

async function main() {
    console.log(`📥 قراءة منتجات المتجر "${STORE_ID}" من Supabase...`);
    const rows = await fetchAllFromSupabase(STORE_ID);
    console.log(`   تم جلب ${rows.length} منتجًا.`);
    if (rows.length === 0) { console.log('لا يوجد ما يُنسخ.'); return; }

    const turso = createClient({
        url: TURSO_URL.startsWith('libsql://') ? TURSO_URL : `libsql://${TURSO_URL.replace(/^https?:\/\//, '')}`,
        authToken: TURSO_TOKEN
    });

    console.log('📤 الكتابة إلى Turso (bws_products)...');
    const BATCH = 100;
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const stmts = chunk.map((r) => ({ sql: INSERT_SQL, args: toRowArgs(r) }));
        await turso.batch(stmts, 'write');
        done += chunk.length;
        console.log(`   ${done}/${rows.length}`);
    }
    console.log(`✅ تم نسخ ${done} منتجًا إلى bws_products للمتجر "${STORE_ID}".`);
}

main().catch((e) => { console.error('❌ فشل:', e.message); process.exit(1); });
