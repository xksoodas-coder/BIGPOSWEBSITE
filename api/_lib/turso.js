import { createClient } from '@libsql/client';

let _client = null;

export function getTursoClient() {
    if (_client) return _client;

    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url || !authToken) {
        throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set');
    }

    _client = createClient({
        url: url.startsWith('libsql://') ? url : `libsql://${url.replace(/^https?:\/\//, '')}`,
        authToken
    });
    return _client;
}

/**
 * Reduce an event-sourced changelog to the latest state per record_uuid.
 * Returns Map<record_uuid, {payload, operation, timestamp}> excluding deleted rows.
 */
export function reduceChangelog(rows) {
    const latest = new Map();
    for (const row of rows) {
        const recordUuid = row.record_uuid;
        const existing = latest.get(recordUuid);
        if (!existing || row.timestamp > existing.timestamp) {
            latest.set(recordUuid, {
                operation: row.operation,
                payload: row.json_payload,
                timestamp: row.timestamp
            });
        }
    }
    for (const [k, v] of latest) {
        if (v.operation === 'DELETE') latest.delete(k);
    }
    return latest;
}
