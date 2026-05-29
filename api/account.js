import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';

/**
 * GET /api/account  → { remaining, paid }
 *
 * Mirrors how the desktop / mobile derive a customer's balance: it is NOT
 * stored, it is computed from the event-sourced changelogs.
 *
 *   remaining = Σ invoice.DueAmount + Σ addedDebt.Amount − Σ payment.Amount
 *   paid      = Σ invoice.PaidAmount + Σ payment.Amount
 *
 * Cancelled invoices (Status == 2) and deleted records are excluded.
 * The customer is matched by the desktop DB id:
 *   invoice.CustomerNumber == payment.CustomerId == addedDebt.CustomerId == customerId
 */
export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const session = readSessionFromRequest(req);
        if (!session || !session.storeId) {
            res.status(401).json({ error: 'يجب تسجيل الدخول' });
            return;
        }

        const customerId = session.customerId;
        if (customerId === null || customerId === undefined) {
            // Older session without customerId — nothing to compute.
            res.status(200).json({ remaining: 0, paid: 0, available: false });
            return;
        }
        const cid = Number(customerId);

        const client = getTursoClient();
        const [invoices, payments, debts] = await Promise.all([
            client.execute({
                sql: `SELECT record_uuid, operation, json_payload, timestamp
                      FROM turso_invoice_changelog
                      WHERE store_id = ? AND table_name = 'SalesInvoices'
                      ORDER BY timestamp ASC`,
                args: [session.storeId]
            }),
            client.execute({
                sql: `SELECT record_uuid, operation, json_payload, timestamp
                      FROM turso_customer_payment_changelog
                      WHERE store_id = ? AND table_name = 'CustomerPayments'
                      ORDER BY timestamp ASC`,
                args: [session.storeId]
            }),
            client.execute({
                sql: `SELECT record_uuid, operation, json_payload, timestamp
                      FROM turso_added_debt_changelog
                      WHERE store_id = ? AND table_name = 'CustomerAddedDebts'
                      ORDER BY timestamp ASC`,
                args: [session.storeId]
            })
        ]);

        // ── Invoices: merge partial STATUS_CHANGE events with the full payload ──
        const invMap = new Map(); // record_uuid → {full, status, deleted, ts}
        for (const row of invoices.rows) {
            const uuid = row.record_uuid;
            let data;
            try { data = JSON.parse(row.json_payload); } catch { continue; }
            const entry = invMap.get(uuid) || { full: null, status: null, deleted: false };
            if (row.operation === 'DELETE' || data.Deleted === true) {
                entry.deleted = true;
            } else if (row.operation === 'STATUS_CHANGE') {
                if (data.Status !== undefined) entry.status = Number(data.Status);
            } else {
                // INSERT / UPDATE carry the complete payload.
                entry.full = data;
                if (data.Status !== undefined) entry.status = Number(data.Status);
            }
            invMap.set(uuid, entry);
        }

        let sumDue = 0, sumPaidOnInvoices = 0;
        for (const entry of invMap.values()) {
            if (entry.deleted) continue;
            if (entry.status === 2) continue; // cancelled
            const data = entry.full;
            if (!data) continue;
            if (Number(data.CustomerNumber) !== cid) continue;
            sumDue += Number(data.DueAmount || 0);
            sumPaidOnInvoices += Number(data.PaidAmount || 0);
        }

        // ── Payments (reduce to latest per record, drop deletes) ──
        const payMap = reduceLatest(payments.rows);
        let sumPayments = 0;
        for (const data of payMap.values()) {
            if (Number(data.CustomerId) !== cid) continue;
            sumPayments += Number(data.Amount || 0);
        }

        // ── Added debts (reduce to latest per record, drop deletes) ──
        const debtMap = reduceLatest(debts.rows);
        let sumAddedDebts = 0;
        for (const data of debtMap.values()) {
            if (Number(data.CustomerId) !== cid) continue;
            sumAddedDebts += Number(data.Amount || 0);
        }

        const remaining = sumDue + sumAddedDebts - sumPayments;
        const paid = sumPaidOnInvoices + sumPayments;

        res.setHeader('Cache-Control', 'private, max-age=20');
        res.status(200).json({
            remaining: Math.round(remaining * 100) / 100,
            paid: Math.round(paid * 100) / 100,
            available: true
        });
    } catch (err) {
        console.error('[account] error', err);
        res.status(500).json({ error: 'تعذّر تحميل بيانات الحساب' });
    }
}

function reduceLatest(rows) {
    const latest = new Map(); // record_uuid → {data, op, ts}
    for (const row of rows) {
        const uuid = row.record_uuid;
        const existing = latest.get(uuid);
        if (!existing || row.timestamp > existing.ts) {
            let data = null;
            try { data = JSON.parse(row.json_payload); } catch { /* ignore */ }
            latest.set(uuid, { data, op: row.operation, ts: row.timestamp });
        }
    }
    const out = new Map();
    for (const [uuid, v] of latest) {
        if (v.op === 'DELETE' || !v.data) continue;
        out.set(uuid, v.data);
    }
    return out;
}
