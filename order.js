/*
 * BigWebStore — صفحة الطلب المباشر (زبون عابر، بلا تسجيل دخول).
 * تصميم حديث يشبه صفحة المنتج مع نموذج الطلب وملخص الطلبية.
 */
function withStore(url) {
    try {
        const slug = new URLSearchParams(location.search).get('store');
        if (!slug) return url;
        return url + (url.includes('?') ? '&' : '?') + 'store=' + encodeURIComponent(slug);
    } catch { return url; }
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2400);
}

function makePlaceholder(text) {
    const div = document.createElement('div');
    div.className = 'category-placeholder';
    div.textContent = text;
    return div;
}
window.makePlaceholder = makePlaceholder;

function imageOrPlaceholder(src, fallback, opts = {}) {
    if (src) {
        // Hero image loads eagerly with high priority; thumbnails lazy-load.
        // On load failure, fall back to the colored first-letter placeholder.
        const attrs = opts.lazy
            ? 'loading="lazy" decoding="async"'
            : 'decoding="async" fetchpriority="high"';
        return `<img src="${escapeHtml(src)}" alt="" ${attrs} onerror="this.replaceWith(makePlaceholder('${escapeHtml(fallback)}'))">`;
    }
    return `<div class="category-placeholder">${escapeHtml(fallback)}</div>`;
}

// Default product image: a neutral gray box icon (no site color, no letter).
const PRODUCT_BOX_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8.5"/></svg>';
function makeProductPlaceholder() {
    const div = document.createElement('div');
    div.className = 'product-placeholder';
    div.innerHTML = PRODUCT_BOX_SVG;
    return div;
}
window.makeProductPlaceholder = makeProductPlaceholder;
function productImageOrPlaceholder(src, opts = {}) {
    if (src) {
        const attrs = opts.lazy
            ? 'loading="lazy" decoding="async"'
            : 'fetchpriority="high" decoding="async"';
        const fb = (opts.legacy && opts.legacy !== src) ? ` data-fb="${escapeHtml(opts.legacy)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="" ${attrs}${fb} onerror="if(this.dataset.fb){var u=this.dataset.fb;this.removeAttribute('data-fb');this.src=u;}else{this.replaceWith(makeProductPlaceholder());}">`;
    }
    return `<div class="product-placeholder">${PRODUCT_BOX_SVG}</div>`;
}

// Two-phase thumbnails for the related grid: the card text paints first with a
// gray box; the real image (data-img) is loaded afterwards, near the viewport,
// by hydrateThumbs(). The hero image stays eager (high priority) — only these
// secondary thumbnails are deferred.
function deferredThumb(src, legacy) {
    const data = src ? ` data-img="${escapeHtml(src)}"` : '';
    const dataFb = (src && legacy && legacy !== src) ? ` data-img-fb="${escapeHtml(legacy)}"` : '';
    return `<div class="related-card-img"${data}${dataFb}><div class="product-placeholder">${PRODUCT_BOX_SVG}</div></div>`;
}

function hydrateThumbs(root) {
    if (!root) return;
    const boxes = Array.from(root.querySelectorAll('.related-card-img[data-img]'));
    if (!boxes.length) return;

    const swap = (box) => {
        const src = box.getAttribute('data-img');
        const fb = box.getAttribute('data-img-fb');
        box.removeAttribute('data-img');
        box.removeAttribute('data-img-fb');
        if (!src) return;
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.onload = () => { box.innerHTML = ''; box.appendChild(img); box.classList.add('img-ready'); };
        let triedFb = false;
        img.onerror = () => { if (fb && !triedFb) { triedFb = true; img.src = fb; return; } };
        img.src = src;
    };

    if (!('IntersectionObserver' in window)) { boxes.forEach(swap); return; }
    const obs = new IntersectionObserver((entries, o) => {
        for (const e of entries) if (e.isIntersecting) { o.unobserve(e.target); swap(e.target); }
    }, { rootMargin: '300px 0px', threshold: 0.01 });
    boxes.forEach(b => obs.observe(b));
}

// Build the short-description badge markup (one badge per non-empty line).
function badgesHtml(text) {
    if (!text) return '';
    return text.split('\n').filter(l => l.trim())
        .map(l => `<span class="order-badge">${escapeHtml(l.trim())}</span>`).join('');
}
function setBadges(text) {
    const el = document.getElementById('orderBadges');
    if (el) el.innerHTML = badgesHtml(text);
}

// ---- State ----
let _selectedProduct = null;
let _allProducts = [];
let _currentQty = 1;
let _summaryOpen = true;

document.addEventListener('DOMContentLoaded', async () => {
    // Theme
    const applyTheme = () => {
        const s = BWS.getSettings();
        const root = document.documentElement;
        root.style.setProperty('--primary', s.theme.primary);
        root.style.setProperty('--primary-dark', s.theme.primaryDark);
        root.style.setProperty('--primary-light', s.theme.primaryLight);
        document.querySelectorAll('.top-bar').forEach(bar => {
            const text = (s.announcement || '').trim();
            const span = bar.querySelector('.top-bar-text');
            if (span) span.textContent = text;
            bar.hidden = text.length === 0;
        });
    };
    applyTheme();

    // One request resolves tenant + settings + store and primes their caches,
    // so the resolveTenant/fetchSiteSettings/branding steps below need no extra
    // round trips. Best-effort: on failure each step falls back to its endpoint.
    await BWS.bootstrap();

    // Resolve tenant
    const tenant = await BWS.resolveTenant();
    if (tenant && tenant.found && tenant.active === false) {
        document.body.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;'
            + 'justify-content:center;font-family:sans-serif">هذا المتجر غير متاح حاليًا</div>';
        return;
    }
    try { await BWS.fetchSiteSettings(); } catch {}
    applyTheme();
    // بيكسل المتجر (إن ضبطه صاحب المتجر) — بعد وصول الإعدادات من الخادم.
    window.BWSPixel?.refresh();
    // The order form is available in both modes. On a login-required store the
    // customer must be signed in first (the order then carries their session).
    const directMode = BWS.getSettings().orderMode === 'direct';
    if (!directMode && !(BWS.getCustomerSession() && BWS.getSessionToken())) {
        window.location.replace(withStore('login.html'));
        return;
    }
    window.__BWS_DIRECT__ = true;

    await applyBranding();

    // ----- Load ONLY the selected product + the rest of its category -----
    // The order page never needs the whole catalogue — only the chosen product,
    // its in-category siblings (for "related" + instant switching) and the
    // descriptions. Fetching just those replaces the multi-MB whole-catalog
    // download that made this page slow (and time out) on big stores.
    const selUuid = (new URLSearchParams(location.search).get('product') || '').trim();
    await loadProductContext(selUuid);
    renderInitial();

    // Client-side navigation: intercept related-product clicks + back/forward.
    bindRelatedNav();
    window.addEventListener('popstate', onPopState);
});

// Load the working set for one product: its category's products (for related +
// switching) plus the product's own detail (price/stock/descriptions). Keeps
// _allProducts scoped to the product's family instead of the entire store.
async function loadProductContext(uuid) {
    if (!uuid) { _allProducts = []; return; }

    // Fast path: BWS.bootstrap() already folded this product + its whole category
    // into the single entry request → use it with ZERO extra round-trips.
    const pre = BWS.takePreloadedProduct(uuid);
    if (pre && pre.product) {
        _allProducts = Array.isArray(pre.familyProducts) ? pre.familyProducts.slice() : [];
        const inList = _allProducts.find(p => p.uuid === uuid);
        if (inList) {
            inList.shortDescription = pre.product.shortDescription || '';
            inList.description = pre.product.description || '';
            inList._enriched = true;
        } else {
            const sel = normalizeDetail(pre.product);
            _allProducts.unshift(sel);
        }
        return;
    }

    // The product's own detail also tells us its family + descriptions.
    let detail = null;
    try { detail = await BWS.fetchProductDetailCached(uuid); } catch { /* offline / 404 */ }

    // The rest of the category — fully-shaped cards (id, prices, stock, sizes).
    let familyItems = [];
    const fam = detail && detail.family;
    if (fam) {
        try { familyItems = await BWS.fetchProductsForFamily(fam); } catch { /* keep just the detail */ }
    }

    _allProducts = Array.isArray(familyItems) ? familyItems.slice() : [];
    const inList = _allProducts.find(p => p.uuid === uuid);
    if (inList && detail) {
        // Merge descriptions so enrichSelected paints badges with no extra fetch.
        inList.shortDescription = detail.shortDescription || '';
        inList.description = detail.description || '';
        inList._enriched = true;
    } else if (detail) {
        // Selected product isn't in the family list (e.g. store hides out-of-stock
        // items) → fall back to its own detail so the page can still render it.
        _allProducts.unshift(normalizeDetail(detail));
    }
}

// Shape a single-product /api/product detail like a catalog card so the order
// page renderers (which expect catalog items) can use it interchangeably.
function normalizeDetail(d) {
    return {
        uuid: d.uuid,
        id: d.id ?? null,
        name: d.name || '',
        family: d.family || '',
        price: Number(d.price ?? d.price1 ?? 0),
        price1: Number(d.price1 ?? 0), price2: Number(d.price2 ?? 0),
        price3: Number(d.price3 ?? 0), price4: Number(d.price4 ?? 0),
        price5: Number(d.price5 ?? 0), price6: Number(d.price6 ?? 0),
        price7: Number(d.price7 ?? 0),
        quantity: Number(d.quantity ?? 0),
        available: !!d.available,
        unitType: d.unitType || 'قطعة',
        imageUrl: d.imageUrl || '',
        imageUrlLegacy: d.imageUrlLegacy || '',
        sizes: Array.isArray(d.sizes) ? d.sizes : [],
        shortDescription: d.shortDescription || '',
        description: d.description || '',
        _enriched: true
    };
}

// ---- Initial paint from the current ?product= in the URL ----
let _initialRendered = false;
function renderInitial() {
    const selUuid = (new URLSearchParams(location.search).get('product') || '').trim();
    _selectedProduct = _allProducts.find(p => p.uuid === selUuid) || null;
    _currentQty = 1;
    renderOrderPage();
    // التتبّع قبل عرض «منتجات أخرى»: أي خطأ في العرض يجب ألّا يُسقط الحدث.
    window.BWSPixel?.viewContent(_selectedProduct);
    renderRelatedProducts(selUuid);
    enrichSelected(_selectedProduct);
    _initialRendered = true;
}

// ---- Instant client-side switch to another product (no page reload) ----
async function selectProduct(uuid, { push = true } = {}) {
    let p = _allProducts.find(x => x.uuid === uuid);
    if (!p) {
        // Product not in the current category set (e.g. navigating to a product
        // from a different family) → load its context on demand, then retry.
        await loadProductContext(uuid);
        p = _allProducts.find(x => x.uuid === uuid);
    }
    if (!p) return;

    const form = captureForm();        // keep what the customer already typed
    _selectedProduct = p;
    _currentQty = 1;

    if (push) {
        history.pushState({ uuid },
            '', withStore('order.html?product=' + encodeURIComponent(uuid)));
    }

    const section = document.getElementById('orderTopSection');
    if (section) section.classList.add('swapping');
    renderOrderPage();                 // rebuilds + rebinds the top section
    restoreForm(form);
    // التنقّل بين المنتجات هنا بلا إعادة تحميل — كل منتج يُعدّ «مشاهدة محتوى».
    window.BWSPixel?.viewContent(p);
    renderRelatedProducts(uuid);
    enrichSelected(p);
    if (section) requestAnimationFrame(() => section.classList.remove('swapping'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function onPopState() {
    const uuid = (new URLSearchParams(location.search).get('product') || '').trim();
    if (uuid) selectProduct(uuid, { push: false });
}

// Lazily load the selected product's description/badges (cached per uuid).
async function enrichSelected(p) {
    if (!p) return;
    if (p._enriched) { setBadges(p.shortDescription); return; }
    try {
        const d = await BWS.fetchProductDetailCached(p.uuid);
        if (!d) return;
        p.shortDescription = d.shortDescription || '';
        p.description = d.description || '';
        p._enriched = true;
        if (_selectedProduct && _selectedProduct.uuid === p.uuid) {
            setBadges(p.shortDescription);
        }
    } catch { /* keep the basic cached info */ }
}

// Capture / restore the order form across product switches.
function captureForm() {
    const g = id => (document.getElementById(id) || {}).value || '';
    return {
        name: g('ofName'), phone: g('ofPhone'), wilaya: g('ofWilaya'),
        baladiya: g('ofBaladiya'), delivery: g('ofDelivery'), notes: g('ofNotes')
    };
}
function restoreForm(v) {
    if (!v) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    set('ofName', v.name); set('ofPhone', v.phone); set('ofNotes', v.notes);
    const wil = document.getElementById('ofWilaya');
    if (wil && v.wilaya) {
        wil.value = v.wilaya;
        populateBaladiyas(wil, document.getElementById('ofBaladiya'));
        const bal = document.getElementById('ofBaladiya');
        if (bal && v.baladiya) bal.value = v.baladiya;
    }
    set('ofDelivery', v.delivery);
}

// Delegate clicks on related cards to client-side navigation (bound once).
function bindRelatedNav() {
    const container = document.getElementById('relatedProducts');
    if (!container || container._navBound) return;
    container._navBound = true;
    container.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // new-tab etc.
        const card = e.target.closest('.related-card');
        if (!card) return;
        const uuid = card.getAttribute('data-uuid');
        if (!uuid) return;
        e.preventDefault();
        selectProduct(uuid, { push: true });
    });
}

async function applyBranding() {
    let info;
    try { info = await BWS.fetchStoreInfo(); } catch { return; }
    if (!info) return;
    if (info.logoUrl) {
        document.querySelectorAll('.logo-circle').forEach(el => {
            el.innerHTML = `<img src="${escapeHtml(info.logoUrl)}" alt="logo" onerror="this.style.display='none'">`;
            el.classList.add('has-logo');
        });
    }
    if (info.name) document.title = info.name + ' — الطلب';
}

function renderOrderPage() {
    const section = document.getElementById('orderTopSection');
    const p = _selectedProduct;

    if (!p) {
        section.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:60px 20px">
                <h2 style="color:var(--text-dark);margin-bottom:8px">لم يتم اختيار منتج</h2>
                <p style="color:var(--text-muted)">يرجى اختيار منتج من المتجر أولاً</p>
                <a href="${withStore('index.html')}" class="checkout-btn" style="display:inline-block;text-decoration:none;margin-top:14px;width:auto;padding:12px 32px">العودة إلى المتجر</a>
            </div>`;
        return;
    }

    const price = BWS.effectivePrice(p);
    const wilayas = (window.BWS_WILAYAS || []);

    section.innerHTML = `
        <!-- Left column: info + form + summary -->
        <div class="order-left-col">
            <h1 class="order-product-title">${escapeHtml(p.name)}</h1>
            <div class="order-product-badges" id="orderBadges">${badgesHtml(p.shortDescription)}</div>
            <div class="order-product-price">${BWS.formatPrice(price)}</div>
            <div class="order-product-stars">★★★★★</div>

            <div class="order-instruction">
                للطلب أدخل معلوماتك في الخانات أسفله <span class="emoji">👇</span> .. ثم إضغط على زر "<strong>تأكيد الطلب</strong>"
            </div>

            <form id="orderForm" class="order-form" autocomplete="on">
                <div class="of-row">
                    <div class="of-field">
                        <input type="text" id="ofName" placeholder="الإسم الأول" required>
                    </div>
                    <div class="of-field">
                        <input type="tel" id="ofPhone" inputmode="tel" placeholder="رقم الهاتف" required>
                    </div>
                </div>
                <div class="of-row">
                    <div class="of-field">
                        <select id="ofWilaya" required>
                            <option value="">الولاية</option>
                            ${wilayas.map(w => `<option value="${escapeHtml(w.code + ' - ' + w.name)}" data-wid="${w.id}">${escapeHtml(w.code + ' - ' + w.name)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="of-field">
                        <select id="ofBaladiya" disabled>
                            <option value="">البلدية / الدائرة</option>
                        </select>
                    </div>
                </div>
                <div class="of-row">
                    <div class="of-field">
                        <select id="ofDelivery">
                            <option value="home">🏠 توصيل إلى المنزل</option>
                            <option value="office">🏢 توصيل إلى المكتب</option>
                        </select>
                    </div>
                    <div class="of-field">
                        <input type="text" id="ofNotes" placeholder="ملاحظة (إختيارية)">
                    </div>
                </div>
            </form>

            <!-- Order Summary -->
            <div class="order-summary-section">
                <button type="button" class="order-summary-toggle" id="summaryToggle">
                    <span><span class="summary-cart-icon">🛒</span> ملخص الطلبية</span>
                    <span class="toggle-icon open" id="toggleIcon">▲</span>
                </button>
                <div class="order-summary-body" id="summaryBody">
                    <div class="summary-item" id="summaryItemRow">
                        <span class="summary-item-name">
                            ${escapeHtml(p.name)}
                            <span class="summary-qty-badge" id="summaryQtyBadge">x${_currentQty}</span>
                        </span>
                        <span class="summary-item-price" id="summaryItemPrice">${BWS.formatPrice(price * _currentQty)}</span>
                    </div>
                    <div class="summary-row">
                        <span class="summary-row-label">🚚 سعر التوصيل</span>
                        <span class="summary-row-value" id="summaryDelivery">اختر ولاية التسليم</span>
                    </div>
                    <div class="summary-row total-row">
                        <span class="summary-row-label">الثمن الإجمالي</span>
                        <span class="summary-row-value" id="summaryTotal">${BWS.formatPrice(price * _currentQty)}</span>
                    </div>
                </div>
            </div>

            <!-- Action bar -->
            <div class="order-action-bar">
                <button type="button" class="order-submit-btn" id="orderSubmit">اضغط هنا للطلب</button>
                <div class="order-qty-controls">
                    <button type="button" class="order-qty-btn" id="qtyDec" aria-label="تقليل">−</button>
                    <span class="order-qty-value" id="qtyValue">${_currentQty}</span>
                    <button type="button" class="order-qty-btn" id="qtyInc" aria-label="زيادة">+</button>
                </div>
            </div>
        </div>

        <!-- Right column: product image -->
        <div class="order-right-col">
            <div class="order-product-image">
                ${productImageOrPlaceholder(p.imageUrl, { legacy: p.imageUrlLegacy })}
            </div>
        </div>
    `;

    // Bind events
    bindSummaryToggle();
    bindQtyControls();
    bindSubmit();
    bindWilayaChange();
    bindImageZoom();
    initScrollHeader(p, price);
    prefillFromSession();
    updateSummary();

    // الزبون المسجَّل: لا تُحتسب له رسوم توصيل → أخفِ سطر «سعر التوصيل» فقط، وتبقى
    // حقول الولاية/البلدية/نوع التوصيل ظاهرة (لمعرفة مكان التسليم وطريقته).
    if (BWS.getCustomerSession()) {
        const wil = document.getElementById('ofWilaya');
        if (wil) wil.required = false;
        const dr = document.getElementById('summaryDelivery');
        if (dr) { const row = dr.closest('.summary-row'); if (row) row.style.display = 'none'; }
    }
}

// On a login-required store the customer is signed in — prefill their
// name/phone so they don't retype it (only fills empty fields).
function prefillFromSession() {
    const s = BWS.getCustomerSession && BWS.getCustomerSession();
    if (!s) return;
    const nameEl = document.getElementById('ofName');
    const phoneEl = document.getElementById('ofPhone');
    if (nameEl && !nameEl.value) nameEl.value = s.name || s.username || '';
    if (phoneEl && !phoneEl.value) phoneEl.value = s.phone || '';
}

// Populate & observe: when product title scrolls behind the header,
// switch the header to show product name + price.
function initScrollHeader(product, price) {
    const header = document.querySelector('.main-header');
    const titleEl = document.querySelector('.order-product-title');
    const hpbName = document.getElementById('hpbName');
    const hpbPrice = document.getElementById('hpbPrice');
    if (!header || !titleEl || !hpbName || !hpbPrice || !product) return;

    // Fill in the product info
    hpbName.textContent = product.name || '';
    hpbPrice.textContent = BWS.formatPrice(price);

    // Use IntersectionObserver to detect when the title leaves the viewport
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) {
                // Title is hidden behind the header → show product bar
                header.classList.add('header-scrolled');
            } else {
                // Title is visible → restore normal header
                header.classList.remove('header-scrolled');
            }
        });
    }, {
        // Account for the sticky header height
        rootMargin: '-90px 0px 0px 0px',
        threshold: 0
    });

    observer.observe(titleEl);
}

// Zoom on hover: enlarge the product image and follow the mouse,
// reset to normal when the mouse leaves (like commercial product pages).
function bindImageZoom() {
    const box = document.querySelector('.order-product-image');
    if (!box) return;
    const img = box.querySelector('img');
    if (!img) return; // no zoom for the placeholder

    box.addEventListener('mousemove', (e) => {
        const rect = box.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        img.style.transformOrigin = `${x}% ${y}%`;
        box.classList.add('zoom-active');
    });

    box.addEventListener('mouseleave', () => {
        box.classList.remove('zoom-active');
        img.style.transformOrigin = 'center center';
    });
}

function bindSummaryToggle() {
    const toggle = document.getElementById('summaryToggle');
    const body = document.getElementById('summaryBody');
    const icon = document.getElementById('toggleIcon');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
        _summaryOpen = !_summaryOpen;
        body.style.display = _summaryOpen ? '' : 'none';
        icon.classList.toggle('open', _summaryOpen);
    });
}

function bindQtyControls() {
    const p = _selectedProduct;
    if (!p) return;
    const valEl = document.getElementById('qtyValue');
    const decBtn = document.getElementById('qtyDec');
    const incBtn = document.getElementById('qtyInc');

    decBtn.addEventListener('click', () => {
        if (_currentQty > 1) {
            _currentQty--;
            valEl.textContent = _currentQty;
            updateSummary();
        }
    });

    incBtn.addEventListener('click', () => {
        // كمية غير محدودة — لا تقييد بالمخزون المتوفر.
        _currentQty++;
        valEl.textContent = _currentQty;
        updateSummary();
    });
}

// معرّف الولاية المختارة (من خاصية data-wid على الخيار).
function selectedWilayaId() {
    const wilSel = document.getElementById('ofWilaya');
    if (!wilSel) return '';
    const opt = wilSel.options[wilSel.selectedIndex];
    return opt ? (opt.getAttribute('data-wid') || '') : '';
}

// سعر التوصيل الحالي حسب الولاية ونوع التسليم، مع مراعاة سعر البلدية الخاص
// إن ضبطه الأدمين لها (وإلا فسعر الولاية).
function currentDeliveryFee() {
    const wid = selectedWilayaId();
    if (!wid) return 0;
    const type = document.getElementById('ofDelivery')?.value || 'home';
    const baladiya = (document.getElementById('ofBaladiya')?.value || '').trim();
    return BWS.deliveryFee(wid, baladiya, type);
}

function updateSummary() {
    const p = _selectedProduct;
    if (!p) return;
    const price = BWS.effectivePrice(p);
    const total = price * _currentQty;
    const fee = currentDeliveryFee();

    const badge = document.getElementById('summaryQtyBadge');
    const itemPrice = document.getElementById('summaryItemPrice');
    const deliveryEl = document.getElementById('summaryDelivery');
    const totalEl = document.getElementById('summaryTotal');

    if (badge) badge.textContent = 'x' + _currentQty;
    if (itemPrice) itemPrice.textContent = BWS.formatPrice(total);
    if (deliveryEl) {
        if (!selectedWilayaId()) {
            deliveryEl.textContent = 'اختر ولاية التسليم';
            deliveryEl.style.color = '';
            deliveryEl.style.fontWeight = '';
        } else {
            deliveryEl.textContent = BWS.formatPrice(fee);
            deliveryEl.style.color = '#d9480f';
            deliveryEl.style.fontWeight = '700';
        }
    }
    if (totalEl) totalEl.textContent = BWS.formatPrice(total + fee);
}

function bindWilayaChange() {
    const wilSel = document.getElementById('ofWilaya');
    if (!wilSel) return;
    const balSel = document.getElementById('ofBaladiya');
    wilSel.addEventListener('change', () => {
        populateBaladiyas(wilSel, balSel);
        updateSummary();
    });
    balSel?.addEventListener('change', updateSummary);
    document.getElementById('ofDelivery')?.addEventListener('change', updateSummary);
}

// Fill the baladiya dropdown with the communes of the selected wilaya. The
// baladiya is OPTIONAL delivery-address info — the home fee stays per-wilaya.
function populateBaladiyas(wilSel, balSel) {
    if (!balSel) return;
    const opt = wilSel.options[wilSel.selectedIndex];
    const wid = opt ? opt.getAttribute('data-wid') : '';
    const communes = (window.BWS_COMMUNES || {})[String(wid)] || [];
    balSel.innerHTML = '<option value="">البلدية / الدائرة</option>' +
        communes.map(c => {
            const label = (c.code ? c.code + ' - ' : '') + c.name;
            return `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
        }).join('');
    balSel.disabled = communes.length === 0;
}

function bindSubmit() {
    const btn = document.getElementById('orderSubmit');
    if (!btn) return;

    // بدء الطلب: أول لمسة على الاسم/الهاتف تعني أن الزائر شرع في الشراء.
    // مفوَّض على المستند لأن القسم العلوي يُعاد بناؤه عند تبديل المنتج.
    if (!bindSubmit._icBound) {
        bindSubmit._icBound = true;
        document.addEventListener('input', (e) => {
            const id = e.target && e.target.id;
            if (id !== 'ofName' && id !== 'ofPhone') return;
            const p = _selectedProduct;
            if (!p) return;
            window.BWSPixel?.initiateCheckoutOnce(
                [{ uuid: p.uuid, name: p.name, price: BWS.effectivePrice(p), qty: _currentQty }],
                BWS.effectivePrice(p) * _currentQty
            );
        }, { passive: true });
    }

    btn.addEventListener('click', async () => {
        const p = _selectedProduct;
        if (!p) return;

        const name = document.getElementById('ofName').value.trim();
        const phone = document.getElementById('ofPhone').value.trim();
        const wilaya = document.getElementById('ofWilaya').value;
        const baladiya = (document.getElementById('ofBaladiya')?.value || '').trim();
        const notes = (document.getElementById('ofNotes')?.value || '').trim();
        const deliveryType = document.getElementById('ofDelivery')?.value || 'home';

        if (!name || !phone) { showToast('الرجاء إدخال الاسم ورقم الهاتف'); return; }
        if (!BWS.getCustomerSession() && !wilaya) { showToast('الرجاء اختيار الولاية'); return; }

        const items = [{
            uuid: p.uuid,
            id: p.id ?? null,
            name: p.name,
            price: BWS.effectivePrice(p),
            quantity: _currentQty,
            unitType: p.unitType || 'قطعة'
        }];

        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'جاري الإرسال...';

        const delivery = currentDeliveryFee();
        const res = await BWS.submitGuestOrder({ items, name, phone, wilaya, baladiya, deliveryType, notes, delivery });
        if (res.ok) {
            // قيمة الشراء = ثمن المنتج فقط (بلا التوصيل).
            window.BWSPixel?.purchase(items, BWS.effectivePrice(p) * _currentQty,
                { orderId: res.uuid, name, phone });
            document.getElementById('orderPage').innerHTML = `
                <div class="order-success">
                    <div class="order-success-icon">✅</div>
                    <h2>تم إرسال طلبك بنجاح</h2>
                    <p>سيتواصل معك المتجر قريبًا لتأكيد الطلب.</p>
                    <a href="${withStore('index.html')}" class="checkout-btn order-success-btn">العودة إلى المتجر</a>
                </div>`;
        } else {
            showToast(res.error || 'تعذّر إرسال الطلب');
            btn.disabled = false;
            btn.textContent = orig;
        }
    });
}

function renderRelatedProducts(excludeUuid) {
    const container = document.getElementById('relatedProducts');
    const section = document.getElementById('orderRelatedSection');
    if (!container || !section) return;

    // Show the rest of the products that SHARE any family with the selected
    // product, excluding the one currently displayed. No limit. (A product may
    // belong to several families packed into `family` as "A~@~B".)
    const selFamilies = BWS.splitFamilies(_selectedProduct && _selectedProduct.family);
    let related = [];
    if (selFamilies.length) {
        related = _allProducts.filter(p =>
            p.uuid !== excludeUuid &&
            p.available && p.quantity > 0 &&
            BWS.splitFamilies(p.family).some(f => selFamilies.includes(f))
        );
    }

    // Fallback: if the category has no other products, show other available ones.
    if (related.length === 0) {
        related = _allProducts
            .filter(p => p.uuid !== excludeUuid && p.available && p.quantity > 0)
            .slice(0, 4);
    }

    if (related.length === 0) return;

    // Update the heading to reflect that these belong to the same category.
    // `family` هنا كان متغيّراً غير معرَّف أصلاً → ReferenceError يُوقف بقية الدالة،
    // فلا يُعرض قسم «منتجات أخرى» إطلاقاً ويُجهض ما بعده في renderInitial.
    const titleEl = section.querySelector('.related-title');
    if (titleEl && selFamilies.length) titleEl.textContent = 'منتجات أخرى من نفس التصنيف';

    section.style.display = '';
    container.innerHTML = related.map(p => {
        const price = BWS.effectivePrice(p);
        const href = withStore('order.html?product=' + encodeURIComponent(p.uuid));
        return `
            <a class="related-card" href="${escapeHtml(href)}" data-uuid="${escapeHtml(p.uuid)}">
                ${deferredThumb(p.imageUrl, p.imageUrlLegacy)}
                <div class="related-card-body">
                    <div class="related-card-name">${escapeHtml(p.name)}</div>
                    <div class="related-card-price">${BWS.formatPrice(price)}</div>
                </div>
            </a>`;
    }).join('');

    // Text-first, images-after: start thumbnails only after the cards paint.
    requestAnimationFrame(() => requestAnimationFrame(() => hydrateThumbs(container)));
}
