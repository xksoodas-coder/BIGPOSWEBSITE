/**
 * Per-buyer price projection. The catalog stores all 7 price tiers, but a
 * customer must only ever SEE the tier(s) they are allowed to use — otherwise
 * the merchant's wholesale / special prices leak to every customer via the API
 * payload. This mirrors the client pricing logic in data.js exactly so the
 * storefront keeps working.
 */

/** { allowed: number[], pricePerProduct: bool } for a buyer (session or guest).
 *
 * سعر الموقع (guestTier) صار الافتراضي للجميع — الزائر **والزبون المسجّل** —
 * إلا إذا كان للزبون سعر خاص. الزبون الافتراضي (سعر 1 فقط) يُعامَل كالزائر
 * فيتبع سعر الموقع؛ أما الزبون الذي له سعر خاص (يشمل مستوى غير 1) فيُستعمل سعره.
 */
export function buyerPricing(session, guestTier) {
    const g = (guestTier >= 1 && guestTier <= 7) ? guestTier : 1;
    if (session) {
        const t = (Array.isArray(session.priceTiers) ? session.priceTiers : [])
            .map(Number).filter(n => n >= 1 && n <= 7);
        const unique = Array.from(new Set(t)).sort((a, b) => a - b);
        // بلا سعر خاص (فارغ أو سعر 1 فقط) → اتبع سعر الموقع.
        const isDefault = unique.length === 0 || (unique.length === 1 && unique[0] === 1);
        const allowed = isDefault ? [g] : unique;
        return { allowed, pricePerProduct: session.pricePerProduct === true && allowed.length > 1 };
    }
    return { allowed: [g], pricePerProduct: false };
}

/** Guest price tier from the store's web settings (mobile-set). Default 1. */
export async function guestPriceTier(client, storeId) {
    try {
        const w = await client.execute({
            sql: `SELECT json_payload FROM turso_web_settings WHERE store_id = ? LIMIT 1`,
            args: [storeId]
        });
        if (w.rows.length) {
            const wj = JSON.parse(w.rows[0].json_payload || '{}');
            const n = Number(wj.guestPriceTier);
            if (n >= 1 && n <= 7) return n;
        }
    } catch { /* default */ }
    return 1;
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
 * Return a customer-safe copy of a product: only the tier prices the buyer may
 * use are kept (others zeroed), and `price` is set to the effective price.
 * - pricePerProduct=true  → keep all `allowed` tiers (the client may switch).
 * - pricePerProduct=false → keep only the buyer's single tier (allowed[0]).
 */
export function projectProductPrices(p, allowed, pricePerProduct) {
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
    return out;
}
