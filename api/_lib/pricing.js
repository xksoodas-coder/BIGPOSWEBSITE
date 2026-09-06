/**
 * Per-buyer price projection. The catalog stores all 7 price tiers, but a
 * customer must only ever SEE the tier(s) they are allowed to use — otherwise
 * the merchant's wholesale / special prices leak to every customer via the API
 * payload. This mirrors the client pricing logic in data.js exactly so the
 * storefront keeps working.
 */

import { getClientByUuid, priceTiersFromClient, boxPriceTierFromClient } from './clients.js';

/** سعر الصندوق مستويات ثلاثة فقط (على الصندوق الرئيسي ⭐)، بخلاف سعر القطعة. */
const cleanBoxTier = (t) => (Number(t) >= 1 && Number(t) <= 3) ? Number(t) : 1;

/** { allowed: number[], pricePerProduct: bool, boxTier: 1..3 } for a buyer
 * (session or guest).
 *
 * سعر الموقع (guestTier) صار الافتراضي للجميع — الزائر **والزبون المسجّل** —
 * إلا إذا كان للزبون سعر خاص. الزبون الافتراضي (سعر 1 فقط) يُعامَل كالزائر
 * فيتبع سعر الموقع؛ أما الزبون الذي له سعر خاص (يشمل مستوى غير 1) فيُستعمل سعره.
 *
 * سعر الصندوق لا يعرفه التوكن (أُضيف بعده)، فهذا المسار القديم يتبع دائماً سعر
 * صندوق الموقع — وهو ما كان يحدث قبل وجود الحقل أصلاً. المرآة وحدها تعرف السعر
 * الخاص بالصندوق، و[buyerPricingLive] هي التي تقرؤه.
 */
export function buyerPricing(session, guestTier, guestBoxTier) {
    const g = (guestTier >= 1 && guestTier <= 7) ? guestTier : 1;
    const gb = cleanBoxTier(guestBoxTier);
    if (session) {
        const t = (Array.isArray(session.priceTiers) ? session.priceTiers : [])
            .map(Number).filter(n => n >= 1 && n <= 7);
        const unique = Array.from(new Set(t)).sort((a, b) => a - b);
        // بلا سعر خاص (فارغ أو سعر 1 فقط) → اتبع سعر الموقع.
        const isDefault = unique.length === 0 || (unique.length === 1 && unique[0] === 1);
        const allowed = isDefault ? [g] : unique;
        return {
            allowed,
            pricePerProduct: session.pricePerProduct === true && allowed.length > 1,
            boxTier: gb
        };
    }
    return { allowed: [g], pricePerProduct: false, boxTier: gb };
}

/**
 * Same as [buyerPricing], but resolves the customer's tier at **request time**
 * from the bws_clients mirror instead of trusting the session token.
 *
 * Why: the token is signed for 7 DAYS and carries the tiers that were true at
 * LOGIN. Without this, flipping the special-price switch (or changing the tier)
 * on the phone would not reach the customer until they logged out and back in —
 * a refresh would keep showing the old price. Reading the mirror row is one
 * indexed lookup (exactly what the mirror exists for), so a plain refresh is now
 * enough for every pricing change to land.
 *
 * When a mirror row exists it is AUTHORITATIVE and the `isDefault` heuristic in
 * [buyerPricing] is bypassed entirely: the switch already told us the answer, so
 * OFF → the web tier, ON → the chosen tier **even if that tier is 1**. Letting
 * the heuristic run here would collapse "special price = price 1" into the web
 * price. The heuristic still applies to the legacy fallback below, where a bare
 * [1] genuinely does mean "no special price".
 *
 * Falls back to the token's tiers when there is no mirror row (a store that
 * never ran «رفع الزبائن للمتجر»), so legacy stores keep working unchanged.
 *
 * The BOX tier travels the same road: the same switch, the same mirror row (no
 * extra read), and the same «OFF → the store's web box price» default.
 */
export async function buyerPricingLive(client, storeId, session, guestTier, guestBoxTier) {
    const gb = cleanBoxTier(guestBoxTier);
    if (session && session.customerUuid) {
        const row = await getClientByUuid(client, storeId, session.customerUuid);
        if (row) {
            const g = (guestTier >= 1 && guestTier <= 7) ? guestTier : 1;
            const tiers = priceTiersFromClient(row); // [tier] أو null = سعر الموقع
            const boxTier = boxPriceTierFromClient(row); // 1..3 أو null = سعر الموقع
            // سعر واحد لكل زبون في نموذج المرآة (كما يضبطه auth.js).
            return {
                allowed: tiers || [g],
                pricePerProduct: false,
                boxTier: boxTier || gb
            };
        }
    }
    return buyerPricing(session, guestTier, gb);
}

/**
 * The store's web price tiers as set from the phone: `{ unit: 1..7, box: 1..3 }`.
 * One row, one read — both tiers live in the same `turso_web_settings` payload,
 * so asking for them separately would double the reads for nothing.
 * Defaults (and a payload written by an older phone build) → { unit: 1, box: 1 },
 * i.e. exactly the behaviour before the box tier existed.
 */
export async function guestPriceTiers(client, storeId) {
    try {
        const w = await client.execute({
            sql: `SELECT json_payload FROM turso_web_settings WHERE store_id = ? LIMIT 1`,
            args: [storeId]
        });
        if (w.rows.length) {
            const wj = JSON.parse(w.rows[0].json_payload || '{}');
            const n = Number(wj.guestPriceTier);
            const b = Number(wj.guestBoxPriceTier);
            return {
                unit: (n >= 1 && n <= 7) ? n : 1,
                box: (b >= 1 && b <= 3) ? b : 1
            };
        }
    } catch { /* default */ }
    return { unit: 1, box: 1 };
}

/** Price for a tier with the same fallback the client uses (tier→price1→first positive). */
export function priceForTier(p, tier) {
    const v = Number(p['price' + tier] ?? 0);
    if (v > 0) return v;
    const p1 = Number(p.price1 ?? p.price ?? 0);
    if (p1 > 0) return p1;
    for (const k of [2, 3, 4, 5, 6, 7]) {
        const x = Number(p['price' + k] ?? 0);
        if (x > 0) return x;
    }
    return 0;
}

/**
 * سعر بيع الصندوق لهذا المشتري من صندوقٍ في الكتالوج:
 *   سعر الصندوق للمستوى المطلوب (2 أو 3) إن كان محدَّداً (> 0)،
 *   وإلا سعر الصندوق 1 (boxPrice) — وهو السلوك الوحيد قبل هذه الميزة،
 *   وإلا 0 ومعناه «غير محدَّد» فيحسبه العميل: سعر الوحدة × السعة.
 *
 * المستويان 2 و3 موجودان على «الصندوق الرئيسي» ⭐ وحده (هكذا يخزّنهما الهاتف)،
 * فالصناديق الأخرى تُسعَّر بسعرها الوحيد مهما كان مستوى الزبون — بلا خطأ ولا
 * صفر مفاجئ.
 */
export function boxPriceForTier(size, boxTier) {
    if (!size) return 0;
    const t = cleanBoxTier(boxTier);
    const tiered = t === 2 ? Number(size.boxPrice2 ?? 0)
        : t === 3 ? Number(size.boxPrice3 ?? 0)
            : 0;
    if (tiered > 0) return tiered;
    const base = Number(size.boxPrice ?? 0);
    return base > 0 ? base : 0;
}

/**
 * Return a customer-safe copy of a product: only the tier prices the buyer may
 * use are kept (others zeroed), and `price` is set to the effective price.
 * - pricePerProduct=true  → keep all `allowed` tiers (the client may switch).
 * - pricePerProduct=false → keep only the buyer's single tier (allowed[0]).
 *
 * وكذلك الصناديق: كل صندوق يخرج بسعرٍ واحد هو سعر مستوى هذا المشتري
 * (`boxPrice`)، ومستويا الصندوق 2 و3 لا يخرجان في الحمولة أصلاً — تماماً كما
 * لا تخرج أسعار القطعة غير المسموحة. النسخ عميق للصناديق: كائنات الكتالوج
 * مشتركة ومحفوظة في كاش الذاكرة، فتعديلها في المكان يُفسد سعر الطلب التالي.
 */
export function projectProductPrices(p, allowed, pricePerProduct, boxTier) {
    const out = { ...p };
    const visible = pricePerProduct ? allowed : [allowed[0]];
    for (let t = 1; t <= 7; t++) {
        out['price' + t] = visible.includes(t) ? Number(p['price' + t] ?? 0) : 0;
    }
    const eff = priceForTier(p, allowed[0]);
    out.price = eff;
    // Guarantee the effective tier carries a positive value so the client's
    // fallback (priceForTier) resolves to the right number.
    if (!(Number(out['price' + allowed[0]]) > 0)) out['price' + allowed[0]] = eff;
    if (Array.isArray(p.sizes)) {
        out.sizes = p.sizes.map((s) => ({
            sizeId: s.sizeId,
            name: s.name,
            capacity: s.capacity,
            boxPrice: boxPriceForTier(s, boxTier)
        }));
    }
    return out;
}
