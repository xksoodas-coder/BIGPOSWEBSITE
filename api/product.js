import { getTursoClient } from './_lib/turso.js';
import { resolveReadAccess } from './_lib/access.js';
import { productImageUrl, productImageUrlLegacy } from './_lib/r2.js';
import { buyerPricingLive, guestPriceTier, projectProductPrices } from './_lib/pricing.js';
import { getStoreDiscounts, applyDiscount } from './_lib/discounts.js';

/**
 * GET /api/product?uuid=<recordUuid>
 *
 * Returns the FULL detail of a single product by reading ONLY that product's
 * changelog rows (not the whole catalogue). The short/full descriptions are
 * NOT in the changelog (the apps don't author them) — they live in the
 * website-only bws_product_descriptions table and are merged in here, fetched
 * lazily only when a customer opens a specific product.
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    try {
        const access = await resolveReadAccess(req);
        if (!access) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }
        const uuid = (req.query?.uuid || '').toString().trim();
        if (!uuid) {
            res.status(400).json({ error: 'معرّف المنتج مطلوب' });
            return;
        }

        const client = getTursoClient();
        const r = await client.execute({
            sql: `SELECT operation, json_payload, timestamp
                  FROM turso_changelog
                  WHERE store_id = ? AND table_name = 'Products' AND record_uuid = ?
                  ORDER BY timestamp ASC`,
            args: [access.storeId, uuid]
        });

        // Reduce this product's events (latest full snapshot + later deltas).
        let full = null, fullTs = '', deltaAfter = 0, deleted = false, lastTs = '';
        for (const row of r.rows) {
            const op = row.operation, ts = row.timestamp;
            let data = null;
            try { data = JSON.parse(row.json_payload); } catch { /* ignore */ }
            if (op === 'DELETE') {
                if (ts >= lastTs) deleted = true;
            } else if (op === 'QUANTITY_DELTA') {
                if (data && ts > fullTs) deltaAfter += Number(data.totalQuantityDelta || 0);
            } else {
                if (data && ts >= fullTs) { full = data; fullTs = ts; deltaAfter = 0; deleted = false; }
            }
            if (ts >= lastTs) lastTs = ts;
        }

        if (!full || deleted || full.webVisible === false) {
            res.status(404).json({ error: 'المنتج غير متاح' });
            return;
        }

        const qty = Number(full.totalQuantity ?? 0) + deltaAfter;
        const imageVersion = full.imageVersion ?? '';

        // Descriptions are website-only — read them from their own table.
        let shortDescription = '', description = '';
        try {
            const d = await client.execute({
                sql: `SELECT short_desc, full_desc FROM bws_product_descriptions
                      WHERE store_id = ? AND product_uuid = ?`,
                args: [access.storeId, uuid]
            });
            if (d.rows.length) {
                shortDescription = d.rows[0].short_desc || '';
                description = d.rows[0].full_desc || '';
            }
        } catch { /* table may not exist yet → no descriptions */ }

        // Extra prices (4..7) from the standalone table.
        let ex = [];
        try {
            const ep = await client.execute({
                sql: `SELECT json_payload FROM turso_product_extra_prices WHERE store_id = ? LIMIT 1`,
                args: [access.storeId]
            });
            if (ep.rows.length && ep.rows[0].json_payload) {
                const m = JSON.parse(ep.rows[0].json_payload) || {};
                ex = m[uuid] || [];
            }
        } catch { /* table may not exist yet */ }

        // سعر الموقع = الافتراضي للجميع (زائر ومسجّل بلا سعر خاص). نجلبه دائمًا.
        const gt = await guestPriceTier(client, access.storeId);
        // مستويات الزبون تُقرأ حيّة من المرآة (لا من التوكن) → refresh يكفي.
        const { allowed, pricePerProduct } =
            await buyerPricingLive(client, access.storeId, access.session, gt);
        const priced = projectProductPrices({
            price1: Number(full.sellPrice ?? 0),
            price2: Number(full.wholesalePrice ?? 0),
            price3: Number(full.price3 ?? 0),
            price4: Number(ex[0] ?? 0),
            price5: Number(ex[1] ?? 0),
            price6: Number(ex[2] ?? 0),
            price7: Number(ex[3] ?? 0)
        }, allowed, pricePerProduct);

        // تخفيض هذا المنتج (إن وُجد) — يضبطه الأدمين.
        try {
            const discounts = await getStoreDiscounts(access.storeId);
            applyDiscount(priced, discounts.get(uuid));
        } catch { /* بلا تخفيض */ }

        // أسعار المسجّلين حيّة عند كل refresh؛ الضيوف نافذة حافة قصيرة فقط.
        res.setHeader('Cache-Control',
            access.guest ? 'public, s-maxage=5' : 'no-store');
        res.status(200).json({
            uuid,
            name: full.name ?? '',
            shortDescription,
            description,
            price: priced.price,
            oldPrice: priced.oldPrice ?? 0,
            discountPercent: priced.discountPercent ?? 0,
            price1: priced.price1,
            price2: priced.price2,
            price3: priced.price3,
            price4: priced.price4,
            price5: priced.price5,
            price6: priced.price6,
            price7: priced.price7,
            quantity: qty,
            available: qty > 0,
            unitType: full.unitType ?? 'قطعة',
            family: (full.family || '').toString().trim(),
            // تاريخا الإنتاج والصلاحية كما أرسلهما الهاتف/الحاسوب في حمولة المنتج.
            manufactureDate: (full.manufactureDate ?? full.ManufactureDate ?? '').toString(),
            expiryDate: (full.expiryDate ?? full.ExpiryDate ?? '').toString(),
            imageUrl: imageVersion ? productImageUrl(access.storeId, uuid, imageVersion) : '',
            imageUrlLegacy: imageVersion ? productImageUrlLegacy(uuid, imageVersion) : ''
        });
    } catch (err) {
        console.error('[product] error', err);
        res.status(500).json({ error: 'تعذّر تحميل المنتج' });
    }
}
