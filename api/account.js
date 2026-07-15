import { getTursoClient } from './_lib/turso.js';
import { readSessionFromRequest } from './_lib/session.js';
import { getClientByUuid } from './_lib/clients.js';

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
 * The customer is matched by NAME (CustomerName), which is stable across devices.
 * The integer id (CustomerNumber/CustomerId) is the source device's local PK and
 * collides between devices/customers — matching by it showed unrelated debts to
 * the wrong customer. Falls back to id only when the session carries no name.
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

        // ── المسار السريع: الدين المحسوب مسبقاً من مرآة bws_clients ──
        // تطبيق الهاتف يُحدّث عمود الدين لهذا الزبون عند كل فاتورة/تسديد/دين مضاف،
        // فنقرؤه هنا من صفّ واحد بدل إعادة حسابه من كل السجلّات (وهو ما كان
        // يُظهر ديوناً خاطئة). غياب المرآة ⇒ نُكمل للحساب القديم أدناه.
        const client = getTursoClient();
        const custUuid = session.customerUuid;
        if (custUuid) {
            const row = await getClientByUuid(client, session.storeId, custUuid);
            if (row) {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.status(200).json({
                    remaining: Math.round((Number(row.debt) || 0) * 100) / 100,
                    available: true
                });
                return;
            }
        }

        const customerId = session.customerId;
        if (customerId === null || customerId === undefined) {
            // Older session without customerId — nothing to compute.
            res.status(200).json({ remaining: 0, paid: 0, available: false });
            return;
        }
        const cid = Number(customerId);

        // ── مطابقة الزبون بالاسم (المفتاح المستقر بين الأجهزة) لا بالرقم ──
        // الرقم (CustomerNumber/CustomerId) هو المعرّف المحلي للجهاز المصدر، وكل جهاز
        // يرقّم زبائنه باستقلال ⇒ زبونان مختلفان قد يحملان نفس الرقم، فتظهر للزبون ديون
        // ليست له. تطبيق سطح المكتب يعالج هذا بإعادة المطابقة بالاسم؛ نفعل المثل هنا.
        // الاسم متوفّر في كل الحمولات (CustomerName) واسم الزبون في الجلسة (session.name).
        const targetName = normName(session.name);
        const targetPhone = normPhone(session.phone);
        // إن غاب الاسم (جلسة/سجل قديم) نرجع للرقم كحل احتياطي (سلوك سابق).
        // phoneField (للفواتير فقط): تمييز إضافي يقلّل تصادم الأسماء المتطابقة —
        // إذا حمل السجلُّ والجلسةُ رقمَي هاتف وكانا مختلفين بوضوح، يُستبعَد السجل.
        // (التسديدات/الديون لا تحمل هاتفاً ⇒ تبقى مطابقتها بالاسم فقط.)
        function belongsToCustomer(data, idField, phoneField) {
            const recName = normName(data.CustomerName ?? data.customerName);
            if (targetName) {
                if (recName !== targetName) return false;
                // الاسم مطابق — تحقّق الهاتف كحاسم نزاع عند توفّره على الطرفين
                if (phoneField && targetPhone) {
                    const recPhone = normPhone(data[phoneField] ?? data.PhoneNumber ?? data.phoneNumber);
                    if (recPhone && recPhone !== targetPhone) return false;
                }
                return true;
            }
            return Number(data[idField]) === cid;
        }

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

        let sumDue = 0;
        for (const entry of invMap.values()) {
            if (entry.deleted) continue;
            if (entry.status === 2) continue; // cancelled
            const data = entry.full;
            if (!data) continue;
            if (!belongsToCustomer(data, 'CustomerNumber', 'PhoneNumber')) continue;
            sumDue += Number(data.DueAmount || 0);
        }

        // ── Payments (reduce to latest per record, drop deletes) ──
        const payMap = reduceLatest(payments.rows);
        let sumPayments = 0;
        for (const data of payMap.values()) {
            if (!belongsToCustomer(data, 'CustomerId')) continue;
            sumPayments += Number(data.Amount || 0);
        }

        // ── Added debts (reduce to latest per record, drop deletes) ──
        const debtMap = reduceLatest(debts.rows);
        let sumAddedDebts = 0;
        for (const data of debtMap.values()) {
            if (!belongsToCustomer(data, 'CustomerId')) continue;
            sumAddedDebts += Number(data.Amount || 0);
        }

        // المتبقي = ديون الفواتير غير المدفوعة + الديون المضافة − التسديدات (الكاملة).
        const remaining = sumDue + sumAddedDebts - sumPayments;

        // لا تخزين في المتصفح — أي إضافة دين أو تعديل فاتورة يُقرأ فوراً محدّثاً.
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.status(200).json({
            remaining: Math.round(remaining * 100) / 100,
            available: true
        });
    } catch (err) {
        console.error('[account] error', err);
        res.status(500).json({ error: 'تعذّر تحميل بيانات الحساب' });
    }
}

// تطبيع اسم الزبون للمقارنة: إزالة الفراغات الزائدة + توحيد الحالة.
function normName(s) {
    return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// تطبيع رقم الهاتف: أرقام فقط، ثم آخر 9 خانات (الرقم الوطني) لاستيعاب اختلاف
// الصفر البادئ/رمز الدولة (+213). فارغ إن لم يوجد رقم معتبر.
function normPhone(s) {
    const digits = String(s ?? '').replace(/\D/g, '');
    if (digits.length < 6) return ''; // قصير جداً/غير معتبر — لا نحاسب عليه
    return digits.length > 9 ? digits.slice(-9) : digits;
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
