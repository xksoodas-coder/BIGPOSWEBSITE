/*
 * BigWebStore — Meta (Facebook) Pixel, per store.
 *
 * Every tenant has its OWN pixel: the store's admin pastes the ID it got from
 * Meta Events Manager into لوحة الإدارة ← إعدادات الموقع, it is stored in that
 * store's settings (bws_site_settings.settings_json.metaPixelId) and served to
 * the storefront with the rest of the settings. Nothing is loaded for a store
 * that did not configure a pixel — no third-party script, no requests.
 *
 * Why a module instead of a snippet in every page:
 *   - the ID is known only AFTER the settings arrive (async), so the events a
 *     page fires meanwhile are queued here and flushed on init;
 *   - the ID is validated (digits only) before it ever reaches fbq(), so a
 *     poisoned settings blob cannot turn into script injection;
 *   - Purchase is de-duplicated per order uuid (a page refresh after checkout
 *     must not count the sale twice) and carries an eventID, which is what a
 *     server-side Conversions API would later de-duplicate against.
 *
 * Public API (all no-ops when the store has no pixel):
 *   BWSPixel.refresh()                     re-read settings, init if needed
 *   BWSPixel.viewContent(product)
 *   BWSPixel.addToCart(product, qty)
 *   BWSPixel.initiateCheckoutOnce(items, value)
 *   BWSPixel.purchase(items, value, { orderId, name, phone })
 *   BWSPixel.track(name, params, opts)     escape hatch (standard events)
 *
 * `product` = a catalog card; `items` = [{ uuid, name, price, qty }].
 */
const BWSPixel = (function () {
    // Meta pixel IDs are numeric (15–16 digits today). Anything else is refused:
    // it is the only value from the database that reaches the Meta SDK.
    const ID_RE = /^\d{5,20}$/;
    const CURRENCY = 'DZD';
    const QUEUE_MAX = 30;
    const PURCHASED_KEY = 'bws_px_purchased'; // sessionStorage: order uuids already reported

    let _id = '';            // active pixel id ('' = disabled / not configured yet)
    let _queued = [];        // events tracked before the id was known
    let _icFired = false;    // InitiateCheckout is fired at most once per page load
    let _amEnabled = false;  // advanced matching (opt-in, per store)

    // ----- settings -----
    // data.js يُعرّف `const BWS`، وهو تعريف معجمي عام لا يُعلَّق على `window`،
    // لذلك الفحص هنا بـ typeof وليس بـ window.BWS (فحصُ window كان يُبقي البيكسل
    // معطَّلاً دائماً رغم صحّة الإعدادات).
    function bws() {
        try { return (typeof BWS !== 'undefined' && BWS) ? BWS : null; }
        catch { return null; }
    }
    function settings() {
        try {
            const b = bws();
            return (b && b.getSettings) ? b.getSettings() : null;
        } catch { return null; }
    }
    function readId() {
        const s = settings();
        const raw = String((s && s.metaPixelId) || '').trim();
        return ID_RE.test(raw) ? raw : '';
    }

    // ----- Meta base code (official snippet, loaded once and only on demand) -----
    function loadSdk() {
        if (window.fbq) return;
        const n = window.fbq = function () {
            n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!window._fbq) window._fbq = n;
        n.push = n;
        n.loaded = true;
        n.version = '2.0';
        n.queue = [];
        const js = document.createElement('script');
        js.async = true;
        js.src = 'https://connect.facebook.net/en_US/fbevents.js';
        (document.head || document.documentElement).appendChild(js);
    }

    function init() {
        const id = readId();
        if (!id || id === _id) return !!_id;
        _id = id;
        _amEnabled = (settings() || {}).metaAdvancedMatching === true;
        loadSdk();
        window.fbq('init', _id);
        window.fbq('track', 'PageView');
        const pending = _queued;
        _queued = [];
        for (const ev of pending) send(ev.name, ev.params, ev.opts);
        return true;
    }

    function send(name, params, opts) {
        if (!_id) {
            if (_queued.length < QUEUE_MAX) _queued.push({ name, params, opts });
            return;
        }
        try {
            if (opts) window.fbq('track', name, params || {}, opts);
            else window.fbq('track', name, params || {});
        } catch { /* an ad-blocker removed fbq — never break the storefront */ }
    }

    // ----- shaping -----
    function money(v) {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
    }
    function priceOf(p) {
        const b = bws();
        try { return money(b.effectivePrice(p)); } catch { return money(p && p.price); }
    }
    function familyLabel(family) {
        const b = bws();
        try { return (b && b.displayFamilies) ? b.displayFamilies(family) : ''; }
        catch { return ''; }
    }
    // Meta's `contents` / `content_ids` for a list of cart-shaped items.
    function contentsOf(items) {
        const list = (items || []).filter(it => it && it.uuid);
        return {
            content_type: 'product',
            content_ids: list.map(it => String(it.uuid)),
            contents: list.map(it => ({
                id: String(it.uuid),
                quantity: Number(it.qty || it.quantity || 1) || 1,
                item_price: money(it.price)
            }))
        };
    }
    function totalOf(items) {
        return money((items || []).reduce(
            (s, it) => s + money(it.price) * (Number(it.qty || it.quantity || 1) || 1), 0));
    }

    // ----- advanced matching (opt-in) -----
    // Meta hashes these in the browser before they leave the page. Sent only
    // when the store's admin explicitly enabled it, and only at Purchase — the
    // one moment the customer knowingly handed over their contact details.
    function normPhone(phone) {
        let d = String(phone || '').replace(/\D+/g, '');
        if (!d) return '';
        if (d.startsWith('00')) d = d.slice(2);
        if (d.startsWith('0')) d = '213' + d.slice(1);   // رقم جزائري محلي
        else if (d.length <= 9) d = '213' + d;
        return d;
    }
    function applyUserData(name, phone) {
        if (!_amEnabled || !_id) return;
        const ud = {};
        const ph = normPhone(phone);
        if (ph) ud.ph = ph;
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length) {
            ud.fn = parts[0].toLowerCase();
            if (parts.length > 1) ud.ln = parts[parts.length - 1].toLowerCase();
        }
        if (!Object.keys(ud).length) return;
        try { window.fbq('init', _id, ud); } catch { /* ignore */ }
    }

    // ----- Purchase de-duplication (per browser session) -----
    function alreadyPurchased(orderId) {
        if (!orderId) return false;
        try {
            const seen = JSON.parse(sessionStorage.getItem(PURCHASED_KEY) || '[]');
            return Array.isArray(seen) && seen.includes(orderId);
        } catch { return false; }
    }
    function markPurchased(orderId) {
        if (!orderId) return;
        try {
            let seen = JSON.parse(sessionStorage.getItem(PURCHASED_KEY) || '[]');
            if (!Array.isArray(seen)) seen = [];
            seen.push(orderId);
            sessionStorage.setItem(PURCHASED_KEY, JSON.stringify(seen.slice(-50)));
        } catch { /* private mode — de-dup best effort */ }
    }

    const api = {
        // Read the settings again and start the pixel if one is configured.
        // Safe to call repeatedly (cached settings on load, server settings after).
        refresh() { return init(); },
        isActive() { return !!_id; },

        // A customer opened a product (product page / direct-order landing).
        viewContent(p) {
            if (!p || !p.uuid) return;
            send('ViewContent', {
                content_type: 'product',
                content_ids: [String(p.uuid)],
                content_name: p.name || '',
                content_category: familyLabel(p.family),
                value: priceOf(p),
                currency: CURRENCY
            });
        },

        addToCart(p, qty = 1) {
            if (!p || !p.uuid) return;
            const q = Number(qty) || 1;
            send('AddToCart', {
                content_type: 'product',
                content_ids: [String(p.uuid)],
                content_name: p.name || '',
                contents: [{ id: String(p.uuid), quantity: q, item_price: priceOf(p) }],
                value: money(priceOf(p) * q),
                currency: CURRENCY
            });
        },

        // The customer started checking out. Fired once per page load: the cart
        // button and the order form would otherwise report the same intent twice.
        initiateCheckoutOnce(items, value) {
            if (_icFired) return;
            const list = (items || []).filter(it => it && it.uuid);
            if (!list.length) return;
            _icFired = true;
            send('InitiateCheckout', {
                ...contentsOf(list),
                num_items: list.reduce((s, it) => s + (Number(it.qty || it.quantity || 1) || 1), 0),
                value: value != null ? money(value) : totalOf(list),
                currency: CURRENCY
            });
        },

        // The order was accepted by the server. `orderId` (the order uuid) is
        // sent as the event id so a refresh — or a future Conversions API call —
        // is de-duplicated instead of counted twice.
        purchase(items, value, { orderId = '', name = '', phone = '' } = {}) {
            const list = (items || []).filter(it => it && it.uuid);
            if (!list.length) return;
            if (alreadyPurchased(orderId)) return;
            markPurchased(orderId);
            applyUserData(name, phone);
            send('Purchase', {
                ...contentsOf(list),
                num_items: list.reduce((s, it) => s + (Number(it.qty || it.quantity || 1) || 1), 0),
                value: value != null ? money(value) : totalOf(list),
                currency: CURRENCY
            }, orderId ? { eventID: String(orderId) } : undefined);
        },

        // Escape hatch for the remaining standard events (Search, Contact, …).
        track(name, params, opts) {
            if (!name) return;
            send(String(name), params || {}, opts);
        }
    };

    // Also exposed on `window` so the controllers can call it defensively
    // (`window.BWSPixel?.…`): a browser holding a cached page that predates this
    // file must degrade to "no tracking", never to a broken storefront.
    window.BWSPixel = api;

    // Boot from the settings already cached in localStorage, so a returning
    // visitor's PageView fires immediately instead of waiting for the network.
    // The controllers call refresh() again once the server settings land.
    try { init(); } catch { /* never block the page */ }

    return api;
})();
