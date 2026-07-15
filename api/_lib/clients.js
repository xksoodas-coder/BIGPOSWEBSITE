/**
 * Reads of the **bws_clients** mirror — the clean, one-row-per-customer snapshot
 * that BIGSOFT MOBI maintains for the storefront (login credentials, the
 * pre-computed debt, and the per-customer special price tier).
 *
 * Every read is defensive: if the table doesn't exist yet (a store that never
 * ran "رفع الزبائن للمتجر") the helpers return null / false so callers fall back
 * to the legacy changelog path. Once the mirror is populated it becomes the fast
 * source of truth: auth = one indexed row lookup, debt = one column read —
 * instead of scanning thousands of invoice/payment/debt changelog rows.
 */

/** The customer row matching a web username (case-insensitive), or null. */
export async function findClientByUsername(client, storeId, username) {
    const uname = String(username || '').trim().toLowerCase();
    if (!uname) return null;
    try {
        const r = await client.execute({
            sql: `SELECT uuid, name, phone, web_username, web_password, web_enabled,
                         price_tier, special_price_enabled, debt
                  FROM bws_clients
                  WHERE store_id = ? AND lower(web_username) = ? LIMIT 1`,
            args: [storeId, uname]
        });
        return r.rows[0] || null;
    } catch {
        return null; // table missing → treat as "not synced yet"
    }
}

/** The customer row for a uuid, or null (used to read the pre-computed debt). */
export async function getClientByUuid(client, storeId, uuid) {
    if (!uuid) return null;
    try {
        const r = await client.execute({
            sql: `SELECT uuid, name, phone, web_enabled, price_tier,
                         special_price_enabled, debt
                  FROM bws_clients WHERE store_id = ? AND uuid = ? LIMIT 1`,
            args: [storeId, String(uuid)]
        });
        return r.rows[0] || null;
    } catch {
        return null;
    }
}

/**
 * Has this store populated the mirror at all? Distinguishes "not synced"
 * (→ fall back to legacy auth) from "synced but this username is unknown"
 * (→ genuine bad credentials). Reserved for callers that need that distinction.
 */
export async function clientsMirrorHasRows(client, storeId) {
    try {
        const r = await client.execute({
            sql: `SELECT 1 FROM bws_clients WHERE store_id = ? LIMIT 1`,
            args: [storeId]
        });
        return r.rows.length > 0;
    } catch {
        return false;
    }
}

/**
 * Translate a mirror row into the session's price tiers, honoring the
 * per-customer "special price" switch: OFF → [1] (which downstream pricing maps
 * to the store's general web price / guestPriceTier); ON → the chosen tier.
 */
export function priceTiersFromClient(row) {
    const special = Number(row.special_price_enabled) === 1;
    const tier = Number(row.price_tier);
    if (special && tier >= 1 && tier <= 7) return [tier];
    return [1];
}
