import { createHmac, timingSafeEqual } from 'node:crypto';

function getSecret() {
    const s = process.env.BWS_SESSION_SECRET;
    if (!s) throw new Error('BWS_SESSION_SECRET must be set');
    return s;
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64');
}

export function signSession(payload) {
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(createHmac('sha256', getSecret()).update(body).digest());
    return `${body}.${sig}`;
}

export function verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot === -1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = b64url(createHmac('sha256', getSecret()).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    try {
        const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
        if (payload.exp && Date.now() / 1000 > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

export function readSessionFromRequest(req) {
    const header = req.headers?.authorization || '';
    if (header.startsWith('Bearer ')) {
        return verifySession(header.slice(7));
    }
    return null;
}
