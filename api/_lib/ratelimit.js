/**
 * Rate limiter backed by Turso (serverless functions share no memory, so the
 * counter must live in the DB). Used to throttle login brute-force / credential
 * stuffing on /api/auth. Fixed-window counter per key.
 *
 *   bws_login_attempts(rl_key PK, count, window_start_ms)
 */

let _ready = false;
async function ensure(client) {
    if (_ready) return;
    await client.execute(`
        CREATE TABLE IF NOT EXISTS bws_login_attempts (
            rl_key       TEXT PRIMARY KEY,
            count        INTEGER NOT NULL,
            window_start INTEGER NOT NULL
        )
    `);
    _ready = true;
}

/**
 * قراءة واحدة للعدّاد: { limited, exists }.
 *
 * لا تُنشئ الجدول (لا CREATE TABLE في مسار القراءة): إن كان مفقودًا يفشل
 * الاستعلام ونفتح الباب (fail-open) — والكتابة في [recordFailure] هي من
 * تُنشئه. هذا يوفّر رحلة كاملة لقاعدة البيانات في كل تسجيل دخول على نسخة
 * باردة، و`exists` تسمح بتخطّي حذفٍ لا لزوم له بعد دخول ناجح.
 */
export async function peekLimit(client, key, max, windowMs) {
    try {
        const r = await client.execute({
            sql: `SELECT count, window_start FROM bws_login_attempts WHERE rl_key = ?`,
            args: [key]
        });
        if (!r.rows.length) return { limited: false, exists: false };
        const row = r.rows[0];
        const fresh = Date.now() - Number(row.window_start) <= windowMs;
        return { limited: fresh && Number(row.count) >= max, exists: true };
    } catch {
        return { limited: false, exists: false }; // fail-open
    }
}

/** Best-effort client IP from the proxy chain (Vercel sets x-forwarded-for). */
export function clientIp(req) {
    const xff = (req.headers['x-forwarded-for'] || '').toString();
    if (xff) return xff.split(',')[0].trim();
    return (req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').toString();
}

/** true when the key already reached `max` failures inside the current window. */
export async function isRateLimited(client, key, max, windowMs) {
    const { limited } = await peekLimit(client, key, max, windowMs);
    return limited;
}

/** Increment the failure counter (starting a fresh window when expired). */
export async function recordFailure(client, key, windowMs) {
    try {
        await ensure(client);
        const now = Date.now();
        const r = await client.execute({
            sql: `SELECT window_start FROM bws_login_attempts WHERE rl_key = ?`,
            args: [key]
        });
        if (!r.rows.length || now - Number(r.rows[0].window_start) > windowMs) {
            await client.execute({
                sql: `INSERT INTO bws_login_attempts (rl_key, count, window_start)
                      VALUES (?, 1, ?)
                      ON CONFLICT(rl_key) DO UPDATE SET count = 1, window_start = ?`,
                args: [key, now, now]
            });
        } else {
            await client.execute({
                sql: `UPDATE bws_login_attempts SET count = count + 1 WHERE rl_key = ?`,
                args: [key]
            });
        }
    } catch { /* best-effort */ }
}

/** Clear the counter for a key after a successful login. */
export async function clearAttempts(client, key) {
    try {
        await client.execute({ sql: `DELETE FROM bws_login_attempts WHERE rl_key = ?`, args: [key] });
    } catch { /* ignore */ }
}
