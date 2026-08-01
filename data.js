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
    const LS_SETTINGS = 'bws_settings';
    const LS_SESSION_TOKEN = 'bws_session_token';
    const LS_CUSTOMER = 'bws_customer';
    const LS_ADMIN_TOKEN = 'bws_admin_token';
    const LS_ADMIN_SESSION = 'bws_admin_session';
    const LS_PRICE_TIER = 'bws_price_tier'; // global selected price tier (1/2/3)
    const LS_TENANT = 'bws_tenant';          // resolved tenant {slug, storeId, name, active}

    let _tenantInfo = null;
    // Set once per page load after /api/bootstrap primes the caches below, so
    // the individual fetchers (settings/tenant/store/families) skip re-fetching.
    let _bootstrapApplied = false;
    // First page of a category, preloaded by bootstrap on products.html; consumed
    // once by renderFamilyPaged so the category page needs no extra request.
    let _preloadedFamily = null;
    // Selected product + its category, preloaded by bootstrap on order.html;
    // consumed once by order.js so the order page needs no extra requests.
    let _preloadedProduct = null;

    // The storefront's tenant is derived from the link: a custom domain / a
    // subdomain (server reads Host) or, on the platform/preview host, a
    // ?store=<slug> query for testing.
    function urlStoreSlug() {
        try { return (new URLSearchParams(location.search).get('store') || '').trim().toLowerCase(); }
        catch { return ''; }
    }

    // Host labels that are the platform itself, never a store slug.
    const PLATFORM_LABELS = ['www', 'api', 'admin', 'app', 'store'];

    // Derive the store slug from the URL host itself: `asd.bigsoft.top` → `asd`.
    // The page therefore knows which store it is with ZERO network calls, so a
    // slow/failed /api/tenant (or a missing BWS_ROOT_DOMAIN on the server) can
    // no longer make a store's own subdomain look like an unknown store and ask
    // the customer for a store code.
    function hostSlug() {
        let host = '';
        try { host = (location.hostname || '').toLowerCase(); } catch { return ''; }
        if (!host || host === 'localhost') return '';
        if (/^\d+(\.\d+){3}$/.test(host)) return '';   // raw IP
        if (host.endsWith('.vercel.app')) return '';   // preview host
        const labels = host.split('.');
        if (labels.length < 3) return '';              // apex or custom domain
        const first = labels[0];
        if (!first || PLATFORM_LABELS.includes(first)) return '';
        return first;
    }

    // The resolved tenant is cached PER HOST: one device may visit several
    // stores (or the platform host with ?store=), and a single shared entry
    // would leak store A's identity into store B's page.
    function tenantCacheKey() {
        let h = '';
        try { h = (location.hostname || '').toLowerCase(); } catch { h = ''; }
        return LS_TENANT + '_' + (h || '_');
    }
    function cachedTenant() {
        const t = readJSON(tenantCacheKey(), null);
        if (t) return t;
        // Legacy (pre per-host) entry — only trusted on a host that carries no
        // slug of its own, i.e. exactly where it used to be written.
        return hostSlug() ? null : readJSON(LS_TENANT, null);
    }

    function getTenantSlug() {
        const u = urlStoreSlug();
        if (u) return u;
        const h = hostSlug();
        if (h) return h;
        const t = cachedTenant();
        return (t && t.slug) || '';
    }

    const DEFAULT_SETTINGS = {
        theme: {
            primary: '#ed5a1a',
            primaryDark: '#c94a14',
            primaryLight: '#ff7c3e',
            // فارغة = «اتبع اللون الرئيسي» (للقلب: الأحمر الافتراضي). تُحَلّ في getSettings.
            priceColor: '',
            orderBtnColor: '',
            cartBtnColor: '',
            favColor: ''
        },
        announcement: '',
        cartMode: 'page',
        // Storefront layout: 'categories' = show category tiles first,
        // 'products' = show all products directly (paginated).
        displayMode: 'categories',
        pageSize: 25,
        // Order flow: 'cart' (default) = login + add-to-cart for registered
        // customers; 'direct' = public guest ordering via a landing form.
        orderMode: 'cart',
        // Products per row in the grid (4, 5, 6, or 7). Fewer = larger cards.
        productsPerRow: 7,
        // Families (categories) per row in the grid (4, 5, 6, or 7).
        familiesPerRow: 4,
        // سعر البيع للزائر/الزبون العابر (1..7) — يُضبط من تطبيق الهاتف.
        guestPriceTier: 1,
        // أسعار التوصيل: office = سعر المكتب لكل ولاية، home = سعر المنزل لكل ولاية
        // (كلاهما مفتاحه = معرّف الولاية؛ المنزل لم يعد يعتمد على البلدية).
        delivery: { office: {}, home: {} },
        // صلاحية الطلب بالأحجام (لكل فئة): العابر / المسجَّل.
        sizeOrderGuest: false,
        sizeOrderRegistered: false,
        // إظهار المنتجات التي نفد مخزونها (≤0) كـ«غير متاح». عند الإطفاء تُخفى كليًا
        // فلا يُعرض ولا يُرسَل سوى المتوفّر (أخفّ وأذكى). الافتراضي: إظهار.
        showOutOfStock: true,
        // أزرار بطاقة المنتج المعروضة لكل فئة زبون: العابر (guest) والمسجَّل
        // (registered). order = «اضغط للطلب»، cart = أيقونة السلة، fav = القلب.
        productButtons: {
            guest:      { order: true, cart: true, fav: false },
            registered: { order: true, cart: true, fav: true }
        },
        // بيكسل ميتا (فيسبوك/إنستغرام) الخاص بهذا المتجر — رقم فقط، فارغ = معطَّل.
        metaPixelId: '',
        // المطابقة المتقدمة: إرسال هاتف/اسم الزبون (مشفَّرَين من طرف ميتا في
        // المتصفح) مع حدث الشراء لتحسين نسبة المطابقة. اختياري، معطَّل افتراضياً.
        metaAdvancedMatching: false
    };

    // معرّف البيكسل أرقام فقط (15–16 رقماً لدى ميتا). التعقيم هنا يضمن أن ما
    // يصل إلى fbq() لا يمكن أن يكون سوى أرقام مهما كان محتوى الإعدادات.
    const META_PIXEL_RE = /^\d{5,20}$/;
    function cleanPixelId(raw) {
        const v = String(raw == null ? '' : raw).trim();
        return META_PIXEL_RE.test(v) ? v : '';
    }

    // In-memory cache, refilled per page load.
    let _familiesCache = null;
    let _storeInfoCache = null;
    const _productsByFamily = new Map();

    // ----- catalog (full product list) cache, stale-while-revalidate -----
    // Served instantly from memory → sessionStorage, refreshed in the
    // background. Stock is re-validated server-side at order time, so brief
    // staleness here is safe. Image URLs are versioned (immutable) so the
    // browser HTTP cache handles the images themselves.
    const CATALOG_TTL = 120000; // 2 min freshness window
    let _catalogCache = null;   // { products, ts }
    let _catalogPrefetch = null; // in-flight prefetch promise (dedupes warm calls)
    const _productDetailCache = new Map(); // uuid -> detail object
    function _catalogKey() { return 'bws_catalog_' + (getTenantSlug() || '_'); }
    function _readSessionCatalog() {
        try {
            const obj = JSON.parse(sessionStorage.getItem(_catalogKey()) || 'null');
            return (obj && Array.isArray(obj.products)) ? obj : null;
        } catch { return null; }
    }
    function _writeCatalog(products) {
        _catalogCache = { products, ts: Date.now() };
        try { sessionStorage.setItem(_catalogKey(), JSON.stringify(_catalogCache)); }
        catch { /* sessionStorage quota — keep memory cache only */ }
        return products;
    }

    // ----- small storage helpers -----
    function readJSON(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
        catch { return fallback; }
    }
    function writeJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    // Migrate the home-delivery map from the old per-baladiya keys
    // ("wilayaId|baladiya") to the new per-wilaya keys ("wilayaId"). Collapsing
    // keeps existing stores working without a re-save (last value per wilaya wins).
    function collapseHomeKeys(h) {
        if (!h || typeof h !== 'object') return {};
        const out = {};
        for (const k of Object.keys(h)) {
            const wid = String(k).split('|')[0];
            if (wid) out[wid] = Number(h[k]) || 0;
        }
        return out;
    }

    // Normalise the per-audience product-button visibility, filling any missing
    // flag from the defaults (so old saved settings keep working).
    function parseProductButtons(raw) {
        const d = DEFAULT_SETTINGS.productButtons;
        const pick = (o, def) => ({
            order: (o && typeof o.order === 'boolean') ? o.order : def.order,
            cart:  (o && typeof o.cart  === 'boolean') ? o.cart  : def.cart,
            fav:   (o && typeof o.fav   === 'boolean') ? o.fav   : def.fav
        });
        raw = (raw && typeof raw === 'object') ? raw : {};
        return { guest: pick(raw.guest, d.guest), registered: pick(raw.registered, d.registered) };
    }

    // ----- settings (admin) -----
    function getSettings() {
        const raw = readJSON(LS_SETTINGS, null);
        if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        const pageSize = Number(raw.pageSize);
        const rawTheme = raw.theme || {};
        const baseTheme = { ...DEFAULT_SETTINGS.theme, ...rawTheme };
        const primary = baseTheme.primary;
        return {
            // Price + button colors default to the primary (so existing stores keep
            // their look) until the admin sets a distinct colour; heart → red.
            theme: {
                primary,
                primaryDark: baseTheme.primaryDark,
                primaryLight: baseTheme.primaryLight,
                priceColor: rawTheme.priceColor || primary,
                orderBtnColor: rawTheme.orderBtnColor || primary,
                cartBtnColor: rawTheme.cartBtnColor || primary,
                favColor: rawTheme.favColor || '#e0245e'
            },
            announcement: typeof raw.announcement === 'string'
                ? raw.announcement : DEFAULT_SETTINGS.announcement,
            cartMode: raw.cartMode === 'sidebar' ? 'sidebar' : 'page',
            displayMode: raw.displayMode === 'products' ? 'products' : 'categories',
            pageSize: Number.isFinite(pageSize) && pageSize > 0
                ? Math.min(200, Math.floor(pageSize)) : DEFAULT_SETTINGS.pageSize,
            orderMode: raw.orderMode === 'direct' ? 'direct' : 'cart',
            productsPerRow: [4, 5, 6, 7].includes(Number(raw.productsPerRow))
                ? Number(raw.productsPerRow) : DEFAULT_SETTINGS.productsPerRow,
            familiesPerRow: [4, 5, 6, 7].includes(Number(raw.familiesPerRow))
                ? Number(raw.familiesPerRow) : DEFAULT_SETTINGS.familiesPerRow,
            guestPriceTier: [1, 2, 3, 4, 5, 6, 7].includes(Number(raw.guestPriceTier))
                ? Number(raw.guestPriceTier) : DEFAULT_SETTINGS.guestPriceTier,
            delivery: (raw.delivery && typeof raw.delivery === 'object')
                ? {
                    office: (raw.delivery.office && typeof raw.delivery.office === 'object') ? raw.delivery.office : {},
                    home: collapseHomeKeys(raw.delivery.home)
                  }
                : { office: {}, home: {} },
            sizeOrderGuest: raw.sizeOrderGuest === true,
            sizeOrderRegistered: raw.sizeOrderRegistered === true,
            showOutOfStock: raw.showOutOfStock !== false,
            productButtons: parseProductButtons(raw.productButtons),
            metaPixelId: cleanPixelId(raw.metaPixelId),
            metaAdvancedMatching: raw.metaAdvancedMatching === true
        };
    }
    function setSettings(next) {
        writeJSON(LS_SETTINGS, { ...getSettings(), ...next });
    }

    // ----- admin auth (server-backed token) -----
    const getAdminToken = () => localStorage.getItem(LS_ADMIN_TOKEN) || null;
    const getAdminSession = () => readJSON(LS_ADMIN_SESSION, null);
    const isAdminAuthed = () => !!getAdminToken();

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
        // Storefront calls use the customer token; admin calls use the admin
        // token. On a pure-admin browser (no customer session) fall back to the
        // admin token so shared GET endpoints (categories) still authenticate.
        const token = options.adminAuth
            ? getAdminToken()
            : (getSessionToken() || getAdminToken());
        if (token) headers.Authorization = `Bearer ${token}`;

        // Tell the server which tenant we are (used pre-login / on the platform
        // host). On real custom domains/subdomains the server resolves from Host
        // and ignores this, so it can't be used to cross tenants.
        const tenantSlug = getTenantSlug();
        if (tenantSlug) headers['x-store-slug'] = tenantSlug;

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
        // A product may belong to several families packed into the single
        // `family` string with the '~@~' separator (e.g. "A~@~B"). Split into the
        // list of names, and a comma-joined display string.
        splitFamilies(family) {
            if (!family) return [];
            const out = [];
            for (const raw of String(family).split('~@~')) {
                const name = raw.trim();
                if (name && !out.includes(name)) out.push(name);
            }
            return out;
        },
        displayFamilies(family) { return this.splitFamilies(family).join('، '); },

        // ----- settings -----
        getSettings,
        setSettings,
        // الإعدادات كما وصلت من الخادم بلا تطبيع — تُستعمل عند الحفظ من لوحة
        // الإدارة كي لا تُمحى المفاتيح التي تكتبها تطبيقات أخرى (مثل «banner»
        // من SOFT ADMIN MANAGER) لمجرّد أن نموذج الموقع لا يعرفها.
        getRawSettings: () => readJSON(LS_SETTINGS, {}) || {},
        getDefaultSettings: () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
        resetSettings: () => localStorage.removeItem(LS_SETTINGS),

        // Which product-card buttons to show for the current viewer. audience:
        // 'registered' (logged-in) or 'guest'. Returns { order, cart, fav }.
        buttonVisibility(audience) {
            const pb = getSettings().productButtons;
            return audience === 'registered' ? pb.registered : pb.guest;
        },

        // Pull the store's settings from the server and cache them locally so
        // applyThemeAndAnnouncement() (sync) reflects them on the next render.
        async fetchSiteSettings({ adminAuth = false } = {}) {
            // /api/bootstrap already pulled fresh settings this page load.
            if (_bootstrapApplied && !adminAuth) return getSettings();
            try {
                const data = await apiFetch('/api/site-settings', { method: 'GET', adminAuth });
                if (data && data.settings && typeof data.settings === 'object') {
                    writeJSON(LS_SETTINGS, data.settings);
                }
            } catch { /* keep local cache */ }
            return getSettings();
        },

        // ----- one-shot storefront entry (collapses the load waterfall) -----
        // Fetches tenant + settings + store + categories in a single request and
        // primes the in-memory / localStorage caches the other fetchers read, so
        // ensureTenant()/refreshSiteSettings()/renderCategoriesGrid()/branding all
        // resolve without further network. Best-effort: on any failure the caller
        // falls back to the per-endpoint path. Returns the raw payload or null.
        async bootstrap() {
            // On a category page, ask for that category's first page too; on an
            // order page, ask for the selected product + its category — so each
            // page is served by this ONE request instead of extra round-trips.
            let famId = 0;
            let productUuid = '';
            try {
                const sp = new URLSearchParams(location.search);
                famId = Number(sp.get('familyId')) || 0;
                productUuid = (sp.get('product') || '').trim();
            } catch { /* keep defaults */ }
            const qs = [];
            if (famId > 0) qs.push('familyId=' + famId);
            if (productUuid) qs.push('product=' + encodeURIComponent(productUuid));
            const path = '/api/bootstrap' + (qs.length ? ('?' + qs.join('&')) : '');

            let data;
            try { data = await apiFetch(path, { method: 'GET' }); }
            catch { return null; }
            if (!data) return null;

            // Stash the preloaded category page for renderFamilyPaged() to use.
            if (data.products && Array.isArray(data.products.products) &&
                Number(data.products.familyId) > 0) {
                _preloadedFamily = {
                    familyId: Number(data.products.familyId),
                    products: data.products.products,
                    total: Number(data.products.total || 0),
                    // true → this is the WHOLE family (paginate it in memory);
                    // false/absent → only page 1 (fetch the rest from the server).
                    complete: data.products.complete === true
                };
            }

            // Stash the preloaded product + its category for order.js to use.
            if (data.product && data.product.uuid) {
                _preloadedProduct = {
                    uuid: data.product.uuid,
                    product: data.product,
                    familyProducts: Array.isArray(data.familyProducts) ? data.familyProducts : []
                };
            }

            if (data.tenant) {
                if (data.tenant.found && data.tenant.slug) {
                    _tenantInfo = data.tenant;
                    writeJSON(tenantCacheKey(), {
                        slug: data.tenant.slug, storeId: data.tenant.storeId,
                        name: data.tenant.name, active: data.tenant.active
                    });
                } else if (!_tenantInfo || !_tenantInfo.found) {
                    // Don't let a "not found" from bootstrap overwrite a tenant
                    // we already resolved (or cached) for this host.
                    _tenantInfo = data.tenant;
                }
            }
            if (data.settings && typeof data.settings === 'object') {
                writeJSON(LS_SETTINGS, data.settings);
            }
            if (data.store && typeof data.store === 'object') {
                _storeInfoCache = {
                    name: data.store.name || '',
                    activity: data.store.activity || '',
                    address: data.store.address || '',
                    phone1: data.store.phone1 || '',
                    phone2: data.store.phone2 || '',
                    email: data.store.email || '',
                    rib: data.store.rib || '',
                    logoUrl: data.store.logoUrl || ''
                };
            }
            if (Array.isArray(data.families)) {
                _familiesCache = data.families;
            }
            _bootstrapApplied = true;
            return data;
        },
        // Consume (once) the category page preloaded by bootstrap, if it matches.
        takePreloadedFamilyPage(familyId) {
            if (_preloadedFamily && _preloadedFamily.familyId === Number(familyId)) {
                const p = _preloadedFamily;
                _preloadedFamily = null;
                return p;
            }
            return null;
        },
        // Consume (once) the product + its category preloaded by bootstrap.
        takePreloadedProduct(uuid) {
            if (_preloadedProduct && _preloadedProduct.uuid === uuid) {
                const p = _preloadedProduct;
                _preloadedProduct = null;
                return p;
            }
            return null;
        },
        // Admin-only: persist the store's settings on the server.
        async saveSiteSettings(settings) {
            writeJSON(LS_SETTINGS, settings);
            await apiFetch('/api/site-settings', {
                method: 'POST', body: { settings }, adminAuth: true
            });
        },

        // ----- admin -----
        isAdminAuthed,
        getAdminSession,
        async adminLogin(username, password, storeId) {
            try {
                const data = await apiFetch('/api/auth', {
                    method: 'POST',
                    body: { username, password, storeId, role: 'admin' }
                });
                if (!data.token) return { ok: false, error: 'تعذّر تسجيل الدخول' };
                localStorage.setItem(LS_ADMIN_TOKEN, data.token);
                writeJSON(LS_ADMIN_SESSION, {
                    username,
                    name: data.customer?.name || username,
                    storeId
                });
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err.message || 'تعذّر تسجيل الدخول' };
            }
        },
        adminLogout() {
            localStorage.removeItem(LS_ADMIN_TOKEN);
            localStorage.removeItem(LS_ADMIN_SESSION);
        },

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
                _storeInfoCache = {
                    name: data.name || '',
                    activity: data.activity || '',
                    address: data.address || '',
                    phone1: data.phone1 || '',
                    phone2: data.phone2 || '',
                    email: data.email || '',
                    rib: data.rib || '',
                    logoUrl: data.logoUrl || ''
                };
            } catch {
                _storeInfoCache = { name: '', activity: '', address: '', phone1: '', phone2: '', email: '', rib: '', logoUrl: '' };
            }
            return _storeInfoCache;
        },

        // ----- account balance (server) -----
        async fetchAccount() {
            try {
                // إضافة بصمة زمنية + cache:no-store لمنع تخزين المتصفح (قراءة محدّثة دائماً).
                return await apiFetch('/api/account?t=' + Date.now(), { method: 'GET', cache: 'no-store' });
            } catch {
                return { remaining: 0, available: false };
            }
        },

        // ----- favorites (server) -----
        async fetchFavorites() {
            try {
                const data = await apiFetch('/api/favorites', { method: 'GET' });
                return data.uuids || [];
            } catch {
                return [];
            }
        },
        async addFavorite(uuid) {
            return await apiFetch('/api/favorites', { method: 'POST', body: { uuid } });
        },
        async removeFavorite(uuid) {
            return await apiFetch('/api/favorites', { method: 'DELETE', body: { uuid } });
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
        // Paginated family fetch — loads one page of a category's products so a
        // big category opens fast (first page) and the rest stream in on scroll.
        async fetchProductsForFamilyPaged(familyName, { page = 1, pageSize = 30 } = {}) {
            const offset = Math.max(0, (page - 1) * pageSize);
            const data = await apiFetch(
                `/api/products?family=${encodeURIComponent(familyName)}&limit=${pageSize}&offset=${offset}`,
                { method: 'GET' }
            );
            return { products: data.products || [], total: Number(data.total || 0) };
        },
        async fetchFavoriteProducts() {
            const data = await apiFetch('/api/products?favorites=1', { method: 'GET' });
            return data.products || [];
        },
        // Single-product detail (incl. short + full descriptions) — fetched only
        // when a customer opens a product, never with the list.
        async fetchProductDetail(uuid) {
            return await apiFetch('/api/product?uuid=' + encodeURIComponent(uuid), { method: 'GET' });
        },

        // ----- product descriptions (admin only, website-managed) -----
        // Map of { uuid: { shortDescription, description } } for the whole store,
        // used to prefill the admin editor.
        async fetchProductDescriptions() {
            const data = await apiFetch('/api/product-descriptions', {
                method: 'GET', adminAuth: true
            });
            return data.items || {};
        },
        async saveProductDescription(uuid, shortDescription, description) {
            return await apiFetch('/api/product-descriptions', {
                method: 'POST',
                body: { uuid, shortDescription, description },
                adminAuth: true
            });
        },
        // All products across the store, paginated (used by "products" display mode).
        async fetchAllProducts({ page = 1, pageSize = 25 } = {}) {
            const offset = Math.max(0, (page - 1) * pageSize);
            const data = await apiFetch(
                `/api/products?limit=${pageSize}&offset=${offset}`,
                { method: 'GET' }
            );
            return { products: data.products || [], total: Number(data.total || 0) };
        },

        // ----- full catalog (stale-while-revalidate) -----
        // Synchronous best-effort read (memory → sessionStorage). May be stale.
        getCachedCatalog() {
            if (_catalogCache) return _catalogCache.products;
            const s = _readSessionCatalog();
            if (s) { _catalogCache = s; return s.products; }
            return null;
        },
        catalogIsFresh() {
            const c = _catalogCache || _readSessionCatalog();
            return !!(c && (Date.now() - c.ts) < CATALOG_TTL);
        },
        // Fetch the whole catalog. Returns the fresh cache instantly when valid;
        // pass { force: true } to always hit the network (background refresh).
        async fetchCatalog({ force = false } = {}) {
            if (!force && this.catalogIsFresh()) return this.getCachedCatalog();
            // No limit → the server returns the WHOLE catalogue. The old
            // `limit=1000` silently truncated stores with >1000 products, so big
            // categories showed an incomplete list and the order page sometimes
            // couldn't find a product whose name sorts past the first 1000.
            const data = await apiFetch('/api/products', { method: 'GET' });
            return _writeCatalog(data.products || []);
        },

        // Warm the full-catalog cache in the background (deduped + never throws),
        // so opening a category later renders instantly from the client cache.
        prefetchCatalog() {
            if (this.catalogIsFresh()) return Promise.resolve(this.getCachedCatalog());
            if (_catalogPrefetch) return _catalogPrefetch;
            _catalogPrefetch = this.fetchCatalog({ force: true })
                .catch(() => null)
                .finally(() => { _catalogPrefetch = null; });
            return _catalogPrefetch;
        },

        // Single-product detail with an in-memory cache (descriptions, etc.).
        async fetchProductDetailCached(uuid) {
            if (!uuid) return null;
            if (_productDetailCache.has(uuid)) return _productDetailCache.get(uuid);
            const detail = await this.fetchProductDetail(uuid);
            _productDetailCache.set(uuid, detail);
            return detail;
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
                // كمية غير محدودة: لا نقيّدها بالمخزون (الطلب قد يفوق المتوفر
                // فيُعالَج كطلبية COMMANDE). كما لا نكشف كمية المخزون للزبون.
                existing.qty = existing.qty + qty;
            } else {
                const prices = this.productTierPrices(product);
                const tier = this.currentTier();
                cart.push({
                    uuid: product.uuid,
                    id: product.id ?? null,
                    name: product.name,
                    family: product.family,
                    prices,
                    tier,
                    price: this.priceForTier(prices, tier),
                    unitType: product.unitType || 'قطعة',
                    imageUrl: product.imageUrl || '',
                    imageUrlLegacy: product.imageUrlLegacy || '',
                    maxQty: cap,
                    qty: qty,
                    // Available sizes for this product → lets the cart offer size editing.
                    allSizes: Array.isArray(product.sizes) ? product.sizes : []
                });
            }
            setCart(cart);
            return true;
        },

        // إضافة للسلة مع تفصيل الأحجام (طلب بالأحجام). يُنشئ سطراً مستقلاً يحمل
        // الكمية الإجمالية + تفصيل (الوحدة + كل حجم).
        addToCartSized(product, totalQty, unitQty, sizes) {
            if (!product || !product.uuid || !(totalQty > 0)) return false;
            const cart = getCart();
            const prices = this.productTierPrices(product);
            const tier = this.currentTier();
            cart.push({
                uuid: product.uuid,
                id: product.id ?? null,
                name: product.name,
                family: product.family,
                prices,
                tier,
                price: this.priceForTier(prices, tier),
                unitType: product.unitType || 'قطعة',
                imageUrl: product.imageUrl || '',
                imageUrlLegacy: product.imageUrlLegacy || '',
                maxQty: Number(product.quantity),
                qty: totalQty,
                unitQty: Number(unitQty) || 0,
                sizes: Array.isArray(sizes) ? sizes : [],
                allSizes: Array.isArray(product.sizes) ? product.sizes : []
            });
            setCart(cart);
            return true;
        },

        // Update an existing cart item's size breakdown (edited from the cart).
        updateCartItemSizes(uuid, totalQty, unitQty, sizes) {
            const cart = getCart();
            const item = cart.find(it => it.uuid === uuid);
            if (!item) return;
            item.qty = Number(totalQty) || item.qty;
            item.unitQty = Number(unitQty) || 0;
            item.sizes = Array.isArray(sizes) ? sizes : [];
            setCart(cart);
        },

        // Switch a cart item to another allowed price tier (per-product mode).
        setCartItemTier(uuid, tier) {
            const cart = getCart();
            const item = cart.find(it => it.uuid === uuid);
            if (!item || !item.prices) return;
            item.tier = tier;
            item.price = this.priceForTier(item.prices, tier);
            setCart(cart);
        },

        removeFromCart(uuid) {
            setCart(getCart().filter(it => it.uuid !== uuid));
        },

        updateCartQty(uuid, qty) {
            const cart = getCart();
            const item = cart.find(it => it.uuid === uuid);
            if (!item) return;
            // كمية غير محدودة — لا تقييد بالمخزون المتوفر.
            item.qty = Math.max(1, Number(qty) || 1);
            setCart(cart);
        },

        cartCount: () => getCart().reduce((s, it) => s + Number(it.qty || 0), 0),
        cartTotal: () => getCart().reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 0), 0),

        // ----- tenant (multi-store) -----
        // Resolve which store this link/domain belongs to (before login).
        async resolveTenant({ force = false } = {}) {
            if (!force && _tenantInfo && _tenantInfo.found) return _tenantInfo;
            const slug = getTenantSlug();
            const qs = slug ? ('?store=' + encodeURIComponent(slug)) : '';
            // One retry: a single cold-start/transient failure used to degrade
            // the page to "unknown store" for the whole visit.
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const data = await apiFetch('/api/tenant' + qs, { method: 'GET' });
                    if (data && data.found && data.slug) {
                        writeJSON(tenantCacheKey(), {
                            slug: data.slug, storeId: data.storeId,
                            name: data.name, active: data.active
                        });
                    }
                    _tenantInfo = data;
                    return data;
                } catch {
                    if (attempt === 0) continue;
                }
            }
            // Server unreachable → reuse the last known tenant for THIS host
            // rather than pretending the store is unknown. `offline` tells the
            // caller this is a fallback, not a server "not found".
            const cached = cachedTenant();
            if (cached && cached.slug) return { ...cached, found: true, offline: true };
            return { found: false, offline: true, hostSlug: hostSlug() };
        },
        // The slug carried by the URL host itself (empty on the platform host
        // or a custom domain). Non-empty ⇒ this page belongs to one store, even
        // if the server could not be reached to confirm it.
        tenantHostSlug: () => hostSlug(),
        getTenantInfo() {
            return _tenantInfo || cachedTenant();
        },

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
                // The effective store is the tenant's (when resolved from the
                // link) — used to detect a tenant/session mismatch later.
                const effStore = (this.getTenantInfo() && this.getTenantInfo().storeId)
                    ? this.getTenantInfo().storeId : storeId;
                writeJSON(LS_CUSTOMER, {
                    username,
                    name: data.customer?.name || username,
                    phone: data.customer?.phone || '',
                    storeId: effStore,
                    // Price permissions for this customer (which tiers they may
                    // use, and whether each product's price can be switched).
                    priceTiers: Array.isArray(data.customer?.priceTiers) && data.customer.priceTiers.length
                        ? data.customer.priceTiers : [1],
                    pricePerProduct: data.customer?.pricePerProduct === true,
                    loginAt: new Date().toISOString()
                });
                localStorage.removeItem(LS_PRICE_TIER); // reset global tier on login
                return { ok: true };
            } catch (err) {
                return { ok: false, error: err.message || 'تعذّر تسجيل الدخول' };
            }
        },
        customerLogout: () => clearCustomerSession(),

        // ----- guest order (direct / public mode) -----
        async submitGuestOrder({ items = [], name = '', phone = '', wilaya = '',
                                 baladiya = '', deliveryType = 'home', notes = '', delivery = 0 } = {}) {
            const clean = (items || []).filter(it => it && it.uuid && Number(it.quantity) > 0);
            if (clean.length === 0) return { ok: false, error: 'لم تختر أي منتج' };
            if (!name.trim() || !phone.trim()) {
                return { ok: false, error: 'الرجاء إدخال الاسم ورقم الهاتف' };
            }
            try {
                const data = await apiFetch('/api/orders', {
                    method: 'POST',
                    body: {
                        items: clean.map(it => ({
                            uuid: it.uuid, id: it.id ?? null, name: it.name,
                            price: Number(it.price || 0), quantity: Number(it.quantity),
                            unitType: it.unitType || 'قطعة',
                            unitQty: Number(it.unitQty) || 0,
                            sizes: Array.isArray(it.sizes) ? it.sizes : []
                        })),
                        name, phone, wilaya, baladiya, deliveryType, notes,
                        delivery: Number(delivery) || 0
                    }
                });
                return { ok: true, uuid: data.uuid, total: data.total };
            } catch (err) {
                return { ok: false, error: err.message || 'تعذّر إرسال الطلب' };
            }
        },

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
                            unitType: it.unitType,
                            unitQty: Number(it.unitQty) || 0,
                            sizes: Array.isArray(it.sizes) ? it.sizes : []
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

        // ----- pricing (per-customer tiers) -----
        // Which price tiers (1/2/3) this customer may use. Defaults to [1].
        allowedTiers() {
            const c = getCustomerSession();
            // الزبون العابر (بلا حساب): يرى السعر المحدَّد للموقع من تطبيق الهاتف.
            if (!c) {
                const g = Number(getSettings().guestPriceTier) || 1;
                return [(g >= 1 && g <= 7) ? g : 1];
            }
            const t = Array.isArray(c.priceTiers) ? c.priceTiers : [1];
            const clean = t.map(Number).filter(n => n >= 1 && n <= 7);
            return clean.length ? Array.from(new Set(clean)).sort((a, b) => a - b) : [1];
        },
        firstAllowedTier() { return this.allowedTiers()[0]; },
        // The single price tier shown to the current viewer: a registered customer
        // sees the ONE tier assigned to them; a guest sees the site (guest) tier set
        // from the mobile app. Customers now have exactly one price — no switching.
        currentTier() {
            const c = getCustomerSession();
            if (!c) {
                const g = Number(getSettings().guestPriceTier) || 1;
                return (g >= 1 && g <= 7) ? g : 1;
            }
            const t = (Array.isArray(c.priceTiers) ? c.priceTiers : []).map(Number).filter(n => n >= 1 && n <= 7);
            return t.length ? t[0] : 1;
        },
        isPricePerProduct() {
            const c = getCustomerSession();
            return !!(c && c.pricePerProduct) && this.allowedTiers().length > 1;
        },
        getGlobalTier() {
            const allowed = this.allowedTiers();
            const saved = Number(localStorage.getItem(LS_PRICE_TIER));
            return allowed.includes(saved) ? saved : allowed[0];
        },
        setGlobalTier(t) {
            if (this.allowedTiers().includes(Number(t))) {
                localStorage.setItem(LS_PRICE_TIER, String(Number(t)));
            }
        },
        productTierPrices(product) {
            return {
                1: Number(product.price1 ?? product.price ?? 0),
                2: Number(product.price2 ?? 0),
                3: Number(product.price3 ?? 0),
                4: Number(product.price4 ?? 0),
                5: Number(product.price5 ?? 0),
                6: Number(product.price6 ?? 0),
                7: Number(product.price7 ?? 0)
            };
        },
        priceForTier(prices, tier) {
            const v = Number(prices?.[tier] ?? 0);
            if (v > 0) return v;
            // Fallback: tier price not set → use price1, else first positive.
            const p1 = Number(prices?.[1] ?? 0);
            if (p1 > 0) return p1;
            for (const k of [2, 3, 4, 5, 6, 7]) { if (Number(prices?.[k]) > 0) return Number(prices[k]); }
            return 0;
        },
        // Tiers usable for a given product: allowed AND have a positive price.
        itemUsableTiers(prices) {
            const usable = this.allowedTiers().filter(t => Number(prices?.[t]) > 0);
            return usable.length ? usable : [this.firstAllowedTier()];
        },
        nextTier(prices, currentTier) {
            const tiers = this.itemUsableTiers(prices);
            const i = tiers.indexOf(Number(currentTier));
            return tiers[(i + 1) % tiers.length];
        },
        // Effective price shown on a product card = the viewer's single tier.
        effectivePrice(product) {
            return this.priceForTier(this.productTierPrices(product), this.currentTier());
        },
        tierLabel(t) { return 'سعر ' + t; },

        // هل الطلب بالأحجام مفعَّل للزائر الحالي؟ (حسب فئته + إعداد الأدمين)
        sizeOrderingEnabled() {
            const s = getSettings();
            return getCustomerSession() ? !!s.sizeOrderRegistered : !!s.sizeOrderGuest;
        },

        // ----- سعر التوصيل -----
        // office: حسب الولاية (المعرّف). home: حسب البلدية ("wilayaId|label").
        deliveryFee(wilayaId, baladiyaLabel, type) {
            // الزبون المسجَّل لا يُحتسب له توصيل إطلاقاً (التوصيل للزبون العابر فقط).
            if (getCustomerSession()) return 0;
            const d = getSettings().delivery || { office: {}, home: {} };
            const wid = String(wilayaId || '');
            if (!wid) return 0;
            // المكتب والمنزل كلاهما الآن بسعر واحد لكل ولاية؛ المنزل لا يعتمد البلدية
            // (يظهر السعر مباشرة بمجرّد اختيار الولاية، اختار بلدية أو لم يختر).
            if (type === 'office') {
                return Number(d.office?.[wid] ?? 0) || 0;
            }
            return Number(d.home?.[wid] ?? 0) || 0;
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
