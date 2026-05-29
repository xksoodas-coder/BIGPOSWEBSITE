import { getTursoClient, reduceChangelog } from './_lib/turso.js';
import { signSession } from './_lib/session.js';

/**
 * POST /api/auth
 * body: { username, password, storeId }
 *
 * Multi-tenant: the storeId the customer supplies determines which tenant
 * the credentials are checked against. No env-level store binding — this
 * single deployment serves every shop in the Turso database.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const { username, password, storeId } = req.body || {};
        if (!username || !password || !storeId) {
            res.status(400).json({ error: 'الرجاء إدخال جميع الحقول' });
            return;
        }

        const targetStore = String(storeId).trim();

        const client = getTursoClient();
        const result = await client.execute({
            sql: `SELECT record_uuid, operation, json_payload, timestamp
                  FROM turso_customer_changelog
                  WHERE store_id = ?
                  ORDER BY timestamp ASC`,
            args: [targetStore]
        });

        if (result.rows.length === 0) {
            // No customers exist for this store_id at all.
            res.status(401).json({ error: 'رمز المتجر غير صحيح أو لا يوجد زبائن مسجلون' });
            return;
        }

        const latest = reduceChangelog(result.rows);

        const uname = String(username).trim().toLowerCase();
        let match = null;
        for (const [recordUuid, entry] of latest) {
            let data;
            try { data = JSON.parse(entry.payload); } catch { continue; }
            const webUsername = (data.WebUsername || '').trim().toLowerCase();
            const webPassword = data.WebPassword || '';
            if (webUsername && webUsername === uname && webPassword === password) {
                match = { recordUuid, data };
                break;
            }
        }

        if (!match) {
            res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
            return;
        }

        const sevenDays = 60 * 60 * 24 * 7;
        // customerId is the desktop DB primary key — invoices/payments/added
        // debts reference the customer by this number, so we carry it in the
        // session to compute the account balance later.
        const customerId = match.data.Id ?? match.data.CustomerId ?? null;
        const token = signSession({
            storeId: targetStore,
            customerUuid: match.recordUuid,
            customerId,
            name: match.data.Name || match.data.WebUsername || '',
            phone: match.data.Phone || '',
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + sevenDays
        });

        res.status(200).json({
            ok: true,
            token,
            customer: {
                name: match.data.Name || match.data.WebUsername || '',
                phone: match.data.Phone || ''
            }
        });
    } catch (err) {
        console.error('[auth] error', err);
        res.status(500).json({ error: 'خطأ في الخادم. حاول مرة أخرى.' });
    }
}
