import { getTursoClient } from './_lib/turso.js';
import { getCatalog } from './_lib/catalog.js';

/**
 * GET /api/warmup  — keep-warm heartbeat (pinged by an external cron every ~10 min).
 *
 * Independent of the mobile app and the desktop program: a scheduler simply
 * hits this URL on a timer so nothing ever goes fully cold. Each hit keeps
 * warm, in one cheap round-trip:
 *   1. the Turso connection (a trivial `SELECT 1`),
 *   2. this Vercel serverless instance (avoids Node cold start), and
 *   3. the per-store catalog snapshot (the heaviest server operation) — for
 *      every store id listed in the WARMUP_STORE_IDS env var (comma-separated).
 *      Calling getCatalog() refreshes the snapshot *before* a real customer has
 *      to wait for the rebuild.
 *
 * Public and harmless (only reads); returns quickly with per-step timings so
 * the cron log shows exactly what warmed and how long it took.
 */
export default async function handler(req, res) {
    const t0 = Date.now();
    const timings = {};
    let dbOk = false;

    try {
        const client = getTursoClient();

        // 1) Warm Turso + the connection pool.
        const tDb = Date.now();
        await client.execute('SELECT 1');
        timings.db_ms = Date.now() - tDb;
        dbOk = true;

        // 2) Warm each configured store's catalog snapshot (best-effort).
        const ids = (process.env.WARMUP_STORE_IDS || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        const warmed = [];
        for (const storeId of ids) {
            const tC = Date.now();
            try {
                const catalog = await getCatalog(client, storeId);
                warmed.push({ storeId, products: catalog.length, ms: Date.now() - tC });
            } catch (e) {
                warmed.push({ storeId, error: String(e?.message || e), ms: Date.now() - tC });
            }
        }
        timings.catalogs = warmed;
    } catch (err) {
        // Never fail loudly — the cron just needs a 200 so it doesn't alarm.
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ ok: false, dbOk, error: String(err?.message || err), total_ms: Date.now() - t0 });
        return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, dbOk, timings, total_ms: Date.now() - t0 });
}
