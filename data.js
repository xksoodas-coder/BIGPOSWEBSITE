/*
 * BigWebStore – data layer (client-side).
 *
 * Server-backed data (categories, products, customer auth, orders) goes
 * through fetch() to /api/* endpoints. Local UI state (cart, theme, hidden
 * categories, admin auth) stays in localStorage so the page survives reloads.
 */

const BWS = (function () {
    // ----- localStorage keys -----
    const LS_HIDDEN = 'bws_hidden_categories';
    const LS_CART = 'bws_cart';
    const LS_ADMIN_AUTH = 'bws_admin_authed';
    const LS_SETTINGS = 'bws_settings';
    const LS_SESSION_TOKEN = 'bws_session_token';
    const LS_CUSTOMER = 'bws_customer';

    const DEFAULT_SETTINGS = {
        theme: {
            primary: '#ed5a1a',
            primaryDark: '#c94a14',
            primaryLight: '#ff7c3e'
        },
        announcement: '',
        cartMode: 'page'
    };

    // In-memory cache, refilled per page load.
    let _familiesCache = null;
    let _storeInfoCache = null;
    const _productsByFamily = new Map();

    // ----- small storage helpers -----
    function readJSON(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
        catch { return fallback; }
    }
    function writeJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    // ----- settings (admin) -----
    function getSettings() {
        const raw = readJSON(LS_SETTINGS, null);
        if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        return {
            theme: { ...DEFAULT_SETTINGS.theme, ...(raw.theme || {}) },
            announcement: typeof raw.announcement === 'string'
                ? raw.announcement : DEFAULT_SETTINGS.announcement,
            cartMode: raw.cartMode === 'sidebar' ? 'sidebar' : 'page'
        };
    }
    function setSettings(next) {
        writeJSON(LS_SETTINGS, { ...getSettings(), ...next });
    }

    // ----- admin auth (local only) -----
    const isAdminAuthed = () => localStorage.getItem(LS_ADMIN_AUTH) === '1';
    function setAdminAuthed(v) {
        if (v) localStorage.setItem(LS_ADMIN_AUTH, '1');
        else localStorage.removeItem(LS_ADMIN_AUTH);
    }

    // ----- hidden categories (admin toggle) -----
    const getHiddenIds = () => readJSON(LS_HIDDEN, []);
    const setHiddenIds = (ids) => writeJSON(LS_HIDDEN, ids);

    // ----- cart -----
    // Items now carry their own snapshot of price/name/family/unitType/uuid
    // so the cart page does not need to re-query the server.
    const getCart = () => readJSON(LS_CART, []);
    const setCart = (items) => writeJSON(LS_CART, items);

    // ----- session -----
    const getSessionToken = () => localStorage.getItem(LS_SESSION_TOKEN) || null;
    const setSessionToken = (t) => {
        if (t) localStorage.setItem(LS_SESSION_TOKEN, t);
        else localStorage.removeItem(LS_SESSION_TOKEN);
    };
    const getCustomerSession = () => readJSON(LS_CUSTOMER, null);
    const clearCustomerSession = () => {
        localStorage.removeItem(LS_CUSTOMER);
        localStorage.removeItem(LS_SESSION_TOKEN);
    };

    // ----- API helper -----
    async function apiFetch(path, options = {}) {
        const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
        const token = getSessionToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch(path, {
            ...options,
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined
        });

        let payload = null;
        try { payload = await res.json(); } catch { /* non-JSON response */ }

        if (!res.ok) {
            const message = payload?.error || `HTTP ${res.status}`;
            const err = new Error(message);
            err.status = res.status;
            throw err;
        }
        return payload || {};
    }

    return {
        // ----- settings -----
        getSettings,
        setSettings,
        getDefaultSettings: () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
        resetSettings: () => localStorage.removeItem(LS_SETTINGS),

        // ----- admin -----
        isAdminAuthed,
        setAdminAuthed,
        adminLogin(username, password) {
            if (username === 'admin' && password === 'admin') {
                setAdminAuthed(true);
                return true;
            }
            return false;
        },
        adminLogout: () => setAdminAuthed(false),

        // ----- hidden categories -----
        getHiddenIds,
        setHiddenIds,
        toggleHidden(id) {
            const ids = new Set(getHiddenIds());
            if (ids.has(id)) ids.delete(id); else ids.add(id);
            setHiddenIds(Array.from(ids));
        },

        // ----- categories (server) -----
        async fetchFamilies({ force = false } = {}) {
            if (!force && _familiesCache) return _familiesCache;
            const data = await apiFetch('/api/categories', { method: 'GET' });
            _familiesCache = data.families || [];
            return _familiesCache;
        },
        async getAllFamilies() {
            return await this.fetchFamilies();
        },
        async getVisibleFamilies() {
            const all = await this.fetchFamilies();
            const hidden = new Set(getHiddenIds());
            return all.filter(f => !hidden.has(f.id));
        },
        async getFamilyById(id) {
            const all = await this.fetchFamilies();
            return all.find(f => f.id === Number(id)) || null;
        },

        // ----- store info (server) -----
        async fetchStoreInfo({ force = false } = {}) {
            if (!force && _storeInfoCache) return _storeInfoCache;
            try {
                const data = await apiFetch('/api/store', { method: 'GET' });
                _storeInfoCache = { name: data.name || '', logoUrl: data.logoUrl || '' };
            } catch {
                _storeInfoCache = { name: '', logoUrl: '' };
            }
            return _storeInfoCache;
        },

        // ----- products (server) -----
        async fetchProductsForFamily(familyName) {
            if (_productsByFamily.has(familyName)) return _productsByFamily.get(familyName);
            const data = await apiFetch(
                `/api/products?family=${encodeURIComponent(familyName)}`,
                { method: 'GET' }
            );
            _productsByFamily.set(familyName, data.products || []);
            return data.products || [];
        },

        // ----- cart -----
        getCart,
        clearCart: () => setCart([]),

        addToCart(product, qty = 1) {
            if (!product || !product.uuid) return false;
            if (!product.available || product.quantity <= 0) return false;
            const cart = getCart();
            const existing = cart.find(it => it.uuid === product.uuid);
            const cap = Number(product.quantity);
            if (existing) {
                existing.qty = Math.min(existing.qty + qty, cap);
            } else {
                cart.push({
                    uuid: product.uuid,
                    id: product.id ?? null,
                    name: product.name,
                    family: product.family,
                    price: Number(product.price || 0),
                    unitType: product.unitType || 'قطعة',
                    imageUrl: product.imageUrl || '',
                    maxQty: cap,
                    qty: Math.min(qty, cap)
                });
            }
            setCart(cart);
            return true;
        },

        removeFromCart(uuid) {
            setCart(getCart().filter(it => it.uuid !== uuid));
        },

        updateCartQty(uuid, qty) {
            const cart = getCart();
            const item = cart.find(it => it.uuid === uuid);
            if (!item) return;
            const cap = Number(item.maxQty || 9999);
            item.qty = Math.max(1, Math.min(qty, cap));
            setCart(cart);
        },

        cartCount: () => getCart().reduce((s, it) => s + Number(it.qty || 0), 0),
        cartTotal: () => getCart().reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 0), 0),

        // ----- customer session (server) -----
        getCustomerSession,
        getSessionToken,
        async customerLogin(username, password, storeId) {
            try {
                const data = await apiFetch('/api/auth', {
                    method: 'POST',
                    body: { username, password, storeId }
                });
                setSessionToken(data.token);
                writeJSON(LS_CUSTOMER, {
                    username,
                    name: data.customer?.name || username,
                    phone: data.customer?.phone || '',
                    storeId,
                    loginAt: new Date().toISOString()
                });
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err.message || 'تعذّر تسجيل الدخول' };
            }
        },
        customerLogout: () => clearCustomerSession(),

        // ----- orders (server) -----
        async submitOrder({ notes = '', name = '', phone = '' } = {}) {
            const items = getCart();
            if (items.length === 0) {
                return { ok: false, error: 'السلة فارغة' };
            }
            try {
                const data = await apiFetch('/api/orders', {
                    method: 'POST',
                    body: {
                        items: items.map(it => ({
                            uuid: it.uuid,
                            id: it.id,
                            name: it.name,
                            price: it.price,
                            quantity: it.qty,
                            unitType: it.unitType
                        })),
                        notes,
                        name,
                        phone
                    }
                });
                setCart([]);
                return { ok: true, uuid: data.uuid, total: data.total };
            } catch (err) {
                return { ok: false, error: err.message || 'تعذّر إرسال الطلب' };
            }
        },

        // ----- formatting -----
        formatPrice(value) {
            return new Intl.NumberFormat('ar-DZ', {
                style: 'decimal',
                maximumFractionDigits: 0
            }).format(value) + ' د.ج';
        }
    };
})();
