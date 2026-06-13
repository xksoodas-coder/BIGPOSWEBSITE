/*
 * BigWebStore – customer-side controller.
 * Pages render via async API fetches; cart state stays in localStorage.
 */

document.addEventListener('DOMContentLoaded', async () => {
    applyThemeAndAnnouncement();

    // One request resolves tenant + settings + store + categories and primes
    // the caches the steps below read, collapsing the old sequential waterfall.
    // Best-effort: if it fails, each step falls back to its own endpoint.
    await BWS.bootstrap();

    if (!(await ensureTenant())) return;

    // Pull settings first (public-capable) so we know the order mode before
    // deciding whether to require login.
    await refreshSiteSettings();
    const direct = BWS.getSettings().orderMode === 'direct';
    window.__BWS_DIRECT__ = direct;

    // Direct (public) stores skip the login gate; cart stores require login.
    if (!direct && !enforcePrivateAccess()) return;

    injectChrome();
    updateCartBadge();
    wireSearchPanel();
    initCartSidebar();
    wireCartIcons();
    // The cart works in both modes now (guests check out via a quick form).
    // Show the customer badge whenever a session exists; otherwise, on a public
    // store, offer a secure "تسجيل الدخول" button for registered customers.
    renderCustomerBadge();
    if (direct && !BWS.getCustomerSession()) renderLoginButton();
    applyStoreBranding();
    initFooterReveal();

    try {
        if (document.getElementById('categoriesGrid')) {
            await renderCategoriesGrid();
        }
        if (document.getElementById('productsGrid')) {
            await renderProductsPage();
        }
        if (document.getElementById('cartContainer')) {
            renderCartPage();
        }
        if (document.getElementById('contactForm')) {
            wireContactForm();
        }
    } catch (err) {
        console.error(err);
        showToast(err.message || 'تعذّر تحميل البيانات');
    }

    // Warm the full catalog in the background (when the browser is idle) so that
    // opening a category afterwards renders instantly from the client cache.
    schedulePrefetchCatalog();
});

// Prefetch the catalog on idle (or a short timeout where requestIdleCallback is
// unavailable, e.g. Safari). Deduped + best-effort inside prefetchCatalog().
function schedulePrefetchCatalog() {
    const run = () => { try { BWS.prefetchCatalog(); } catch { /* ignore */ } };
    if ('requestIdleCallback' in window) {
        requestIdleCallback(run, { timeout: 3000 });
    } else {
        setTimeout(run, 1200);
    }
}

// ===== Store branding (logo + name in header/footer) =====
async function applyStoreBranding() {
    // Logged-in customer OR a public store (tenant resolved).
    if (!BWS.getSessionToken() && !BWS.getTenantInfo()) return;
    let info;
    try { info = await BWS.fetchStoreInfo(); } catch { return; }
    if (!info) return;

    document.querySelectorAll('.logo-circle').forEach(el => {
        if (info.logoUrl) {
            el.classList.add('has-logo');
            el.innerHTML = `<img src="${escapeHtml(info.logoUrl)}" alt="${escapeHtml(info.name || 'logo')}" onerror="this.parentElement.classList.remove('has-logo'); this.replaceWith(makeBSFallback())">`;
        }
    });

    if (info.name) {
        document.querySelectorAll('.footer-brand').forEach(el => {
            el.textContent = info.name;
        });
        document.title = info.name;
    }

    // Fill the dedicated store-info block in the footer (if present).
    const box = document.getElementById('footerStoreInfo');
    if (box) {
        const rows = [
            ['اسم المحل', info.name],
            ['النشاط', info.activity],
            ['العنوان', info.address],
            ['الهاتف 1', info.phone1],
            ['الهاتف 2', info.phone2],
            ['البريد', info.email],
            ['RIB', info.rib]
        ].filter(([, v]) => v && v.trim());

        box.innerHTML = rows.length
            ? rows.map(([k, v]) =>
                `<div class="store-info-row"><span class="si-key">${escapeHtml(k)}</span><span class="si-val">${escapeHtml(v)}</span></div>`
              ).join('')
            : '<p class="muted">لا توجد معلومات للمحل بعد.</p>';
    }
}

function makeBSFallback() {
    const span = document.createElement('span');
    span.textContent = 'BS';
    return span;
}
window.makeBSFallback = makeBSFallback;

// ===== Tenant (multi-store) resolution =====
// Determines which store this link/domain is, shows an "unavailable" page for
// disabled stores, and logs out if the saved session belongs to another store.
async function ensureTenant() {
    let t;
    try { t = await BWS.resolveTenant(); } catch { return true; }
    if (!t || !t.found) return true; // platform/preview host without a tenant → legacy behaviour

    if (t.active === false) {
        document.body.innerHTML =
            '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;'
            + 'font-family:sans-serif;color:#444;text-align:center;padding:24px">'
            + '<div><h1 style="font-size:22px;margin-bottom:8px">هذا المتجر غير متاح حاليًا</h1>'
            + '<p style="color:#888">يرجى المحاولة لاحقًا.</p></div></div>';
        return false;
    }

    // Logged into a different store than this link → clear and force re-login.
    const session = BWS.getCustomerSession();
    if (session && session.storeId && t.storeId && session.storeId !== t.storeId) {
        BWS.customerLogout();
    }
    return true;
}

// Append the current ?store= slug (platform-host testing) to an internal URL so
// the tenant survives navigation when there is no subdomain/custom domain.
function withTenant(url) {
    try {
        const slug = new URLSearchParams(location.search).get('store');
        if (!slug) return url;
        return url + (url.includes('?') ? '&' : '?') + 'store=' + encodeURIComponent(slug);
    } catch { return url; }
}

// ===== Login gate (always required — multi-tenant) =====
function enforcePrivateAccess() {
    if (BWS.getCustomerSession() && BWS.getSessionToken()) return true;
    if (/login\.html$/i.test(window.location.pathname)) return true;
    window.location.replace(withTenant('login.html'));
    return false;
}

// ===== Customer "logged in as" badge + account dropdown =====
function renderCustomerBadge() {
    const session = BWS.getCustomerSession();
    if (!session) return;
    const headerLeft = document.querySelector('.header-left');
    if (!headerLeft || document.querySelector('.customer-info')) return;

    const wrap = document.createElement('div');
    wrap.className = 'customer-info';
    wrap.innerHTML = `
        <button class="account-btn" id="accountBtn" type="button">
            <span class="customer-name">${escapeHtml(session.name || session.username)}</span>
            <span class="account-debt" id="accountDebtInline" hidden></span>
            <span class="account-caret">▾</span>
        </button>
        <button class="customer-logout" id="customerLogoutBtn">خروج</button>
        <div class="account-dropdown" id="accountDropdown" hidden>
            <div class="account-row">
                <span>الدين المتبقي</span>
                <strong class="debt-remaining" id="ddRemaining">—</strong>
            </div>
        </div>
    `;
    headerLeft.appendChild(wrap);

    document.getElementById('customerLogoutBtn').addEventListener('click', () => {
        BWS.customerLogout();
        window.location.href = 'login.html';
    });

    const accountBtn = document.getElementById('accountBtn');
    const dropdown = document.getElementById('accountDropdown');
    accountBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.hidden = !dropdown.hidden;
    });
    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) dropdown.hidden = true;
    });

    // Load the balance and fill both the inline badge and the dropdown.
    BWS.fetchAccount().then(acc => {
        if (!acc || acc.available === false) return;
        const inline = document.getElementById('accountDebtInline');
        const ddR = document.getElementById('ddRemaining');
        ddR.textContent = BWS.formatPrice(acc.remaining || 0);
        if ((acc.remaining || 0) > 0) {
            inline.textContent = BWS.formatPrice(acc.remaining);
            inline.hidden = false;
        }
    });
}

// ===== Public store: "تسجيل الدخول" button for registered customers =====
// On a public store a guest browses freely; this button lets a registered
// customer sign in (api/auth.js validates credentials — secure, members only).
function renderLoginButton() {
    const headerLeft = document.querySelector('.header-left');
    if (!headerLeft || document.querySelector('.customer-login-btn') ||
        document.querySelector('.customer-info')) return;
    const a = document.createElement('a');
    a.className = 'customer-login-btn';
    a.href = withTenant('login.html');
    a.textContent = 'تسجيل الدخول';
    headerLeft.appendChild(a);
}

// ===== Inject shared chrome (favorites link + footer store-info block) =====
function injectChrome() {
    // 0. Ensure a toast element exists (the home page doesn't ship one).
    if (!document.getElementById('toast')) {
        const t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast';
        document.body.appendChild(t);
    }

    // 1. "المفضلة" link in the main nav (logged-in customers only — needs an account).
    const nav = document.querySelector('.main-nav');
    if (nav && BWS.getCustomerSession() && !nav.querySelector('.nav-favorites')) {
        const a = document.createElement('a');
        a.href = 'products.html?favorites=1';
        a.className = 'nav-favorites';
        a.textContent = '♥ المفضلة';
        const params = new URLSearchParams(window.location.search);
        if (/products\.html$/i.test(window.location.pathname) && params.get('favorites') === '1') {
            a.classList.add('active');
        }
        nav.insertBefore(a, nav.firstChild);
    }

    // 2. Store-info block at the top of the footer.
    const footerContainer = document.querySelector('.main-footer .footer-container');
    if (footerContainer && !document.getElementById('footerStoreInfo')) {
        const block = document.createElement('div');
        block.className = 'footer-store-info-block';
        block.innerHTML = `
            <h4>معلومات المحل</h4>
            <div id="footerStoreInfo" class="store-info-grid">
                <p class="muted">…</p>
            </div>
        `;
        const footer = document.querySelector('.main-footer');
        footer.insertBefore(block, footerContainer);
    }
}

// ===== Footer reveal (only at the bottom of the page) =====
function initFooterReveal() {
    const footer = document.querySelector('.main-footer');
    if (!footer) return;
    footer.classList.add('footer-reveal');

    const check = () => {
        const scrolledToBottom =
            window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
        footer.classList.toggle('revealed', scrolledToBottom);
    };
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check, { passive: true });
    check();
}

// ===== Server settings refresh =====
async function refreshSiteSettings() {
    // Works for logged-in customers AND public (direct-mode) stores via tenant.
    try { await BWS.fetchSiteSettings(); } catch { /* keep cache */ }
    applyThemeAndAnnouncement();
}

// ===== Theme + Announcement bar =====
function applyThemeAndAnnouncement() {
    const settings = BWS.getSettings();
    const root = document.documentElement;
    root.style.setProperty('--primary', settings.theme.primary);
    root.style.setProperty('--primary-dark', settings.theme.primaryDark);
    root.style.setProperty('--primary-light', settings.theme.primaryLight);
    // Per-element colors (price / order button / cart button / heart).
    root.style.setProperty('--price-color', settings.theme.priceColor);
    root.style.setProperty('--order-btn-color', settings.theme.orderBtnColor);
    root.style.setProperty('--cart-btn-color', settings.theme.cartBtnColor);
    root.style.setProperty('--fav-color', settings.theme.favColor);
    root.style.setProperty('--products-per-row', settings.productsPerRow || 7);
    root.style.setProperty('--families-per-row', settings.familiesPerRow || 4);

    document.querySelectorAll('.top-bar').forEach(bar => {
        const text = (settings.announcement || '').trim();
        const span = bar.querySelector('.top-bar-text');
        if (span) span.textContent = text;
        bar.hidden = text.length === 0;
    });
}

// ===== Header =====
function updateCartBadge() {
    const badge = document.getElementById('cartBadge');
    if (!badge) return;
    const count = BWS.cartCount();
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
}

function wireSearchPanel() {
    const btn = document.getElementById('searchBtn');
    const panel = document.getElementById('searchPanel');
    const close = document.getElementById('searchClose');
    const input = document.getElementById('searchInput');
    if (!btn || !panel) return;

    btn.addEventListener('click', () => {
        panel.classList.add('open');
        if (input) input.focus();
    });
    close?.addEventListener('click', () => panel.classList.remove('open'));
    input?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const q = input.value.trim().toLowerCase();
            if (!q) return;
            try {
                const families = await BWS.getVisibleFamilies();
                const match = families.find(f => f.name.toLowerCase().includes(q));
                if (match) {
                    // A family with sub-families opens them; a leaf opens products.
                    const hasKids = families.some(f => f.parentId === match.id);
                    window.location.href = hasKids
                        ? withTenant('categories.html?parent=' + match.id)
                        : withTenant('products.html?familyId=' + match.id);
                } else {
                    showToast('لم يتم العثور على نتائج.');
                }
            } catch (err) {
                showToast(err.message || 'خطأ في البحث');
            }
        } else if (e.key === 'Escape') {
            panel.classList.remove('open');
        }
    });
}

// ===== Cart Sidebar =====
function initCartSidebar() {
    if (document.getElementById('cartSidebar')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'cartBackdrop';
    backdrop.className = 'cart-backdrop';

    const sidebar = document.createElement('aside');
    sidebar.id = 'cartSidebar';
    sidebar.className = 'cart-sidebar';
    sidebar.innerHTML = `
        <div class="cart-sidebar-header">
            <h3>سلة المشتريات</h3>
            <button class="sidebar-close" id="sidebarClose" aria-label="إغلاق">×</button>
        </div>
        <div class="cart-sidebar-items" id="sidebarItems"></div>
        <div class="cart-sidebar-footer">
            <div class="summary-line total-line">
                <span>المجموع:</span>
                <span id="sidebarTotal">0 د.ج</span>
            </div>
            <button class="checkout-btn" id="sidebarCheckoutBtn">إتمام الطلب</button>
            <a href="cart.html" class="view-cart-link">عرض السلة الكاملة</a>
        </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(sidebar);

    backdrop.addEventListener('click', closeCartSidebar);
    sidebar.querySelector('#sidebarClose').addEventListener('click', closeCartSidebar);
    sidebar.querySelector('#sidebarCheckoutBtn').addEventListener('click', () => {
        closeCartSidebar();
        window.location.href = 'cart.html';
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCartSidebar();
    });
}

function openCartSidebar() {
    initCartSidebar();
    renderCartSidebar();
    document.getElementById('cartSidebar').classList.add('open');
    document.getElementById('cartBackdrop').classList.add('open');
}

function closeCartSidebar() {
    document.getElementById('cartSidebar')?.classList.remove('open');
    document.getElementById('cartBackdrop')?.classList.remove('open');
}

function renderCartSidebar() {
    const container = document.getElementById('sidebarItems');
    if (!container) return;
    const items = BWS.getCart();
    if (items.length === 0) {
        container.innerHTML = '<p class="empty-sidebar">السلة فارغة</p>';
    } else {
        container.innerHTML = items.map(it => `
            <div class="sidebar-item" data-uuid="${escapeHtml(it.uuid)}">
                <div class="sidebar-item-img">
                    ${renderProductImageOrPlaceholder(it.imageUrl || null)}
                </div>
                <div class="sidebar-item-info">
                    <h4>${escapeHtml(it.name)}</h4>
                    <div class="item-price">${BWS.formatPrice(it.price)}${priceArrowHtml(it)}</div>
                    <div class="sidebar-qty">
                        <button class="qty-btn qty-dec" aria-label="تقليل">−</button>
                        <span class="qty-value">${it.qty}</span>
                        <button class="qty-btn qty-inc" aria-label="زيادة">+</button>
                    </div>
                    ${sizeEditHtml(it)}
                </div>
                <button class="sidebar-item-remove" aria-label="حذف">×</button>
            </div>
        `).join('');
        container.querySelectorAll('.sidebar-item').forEach(row => {
            const uuid = row.dataset.uuid;
            wireSizeEdit(row, uuid, renderCartSidebar);
            row.querySelector('.sidebar-item-remove').addEventListener('click', () => {
                BWS.removeFromCart(uuid);
                renderCartSidebar();
                updateCartBadge();
            });
            row.querySelector('.qty-dec').addEventListener('click', () => {
                const cur = BWS.getCart().find(it => it.uuid === uuid);
                if (!cur) return;
                if (cur.qty <= 1) BWS.removeFromCart(uuid);
                else BWS.updateCartQty(uuid, cur.qty - 1);
                renderCartSidebar();
                updateCartBadge();
            });
            row.querySelector('.qty-inc').addEventListener('click', () => {
                const cur = BWS.getCart().find(it => it.uuid === uuid);
                if (!cur) return;
                BWS.updateCartQty(uuid, cur.qty + 1);
                renderCartSidebar();
                updateCartBadge();
            });
            const switchBtn = row.querySelector('.price-switch-btn');
            if (switchBtn) {
                switchBtn.addEventListener('click', () => {
                    const cur = BWS.getCart().find(it => it.uuid === uuid);
                    if (!cur) return;
                    BWS.setCartItemTier(uuid, BWS.nextTier(cur.prices, cur.tier));
                    renderCartSidebar();
                });
            }
        });
    }
    const totalEl = document.getElementById('sidebarTotal');
    if (totalEl) totalEl.textContent = BWS.formatPrice(BWS.cartTotal());
}

function wireCartIcons() {
    document.querySelectorAll('.cart-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Read the mode at click-time so a later server refresh is honoured.
            if (BWS.getSettings().cartMode === 'sidebar') {
                e.preventDefault();
                openCartSidebar();
            }
        });
    });
}

// ===== Categories Grid =====
async function renderCategoriesGrid() {
    const grid = document.getElementById('categoriesGrid');

    // "products" display mode: show all products directly (paginated) instead
    // of the category tiles.
    if (BWS.getSettings().displayMode === 'products') {
        return renderAllProductsMode(grid, BWS.getSettings().pageSize);
    }

    grid.innerHTML = loadingHtml();

    let families;
    try {
        families = await BWS.getVisibleFamilies();
    } catch (err) {
        grid.innerHTML = `
            <div class="empty-state">
                <h2>تعذّر تحميل التصنيفات</h2>
                <p>${escapeHtml(err.message || '')}</p>
            </div>
        `;
        return;
    }

    if (families.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <h2>لا توجد تصنيفات حاليًا</h2>
                <p>الرجاء العودة لاحقًا.</p>
            </div>
        `;
        return;
    }

    // Group by parent so we can show ONE level at a time. The mobile app nests
    // families (up to 3 levels); here a main family that HAS sub-families opens
    // them (?parent=), and a leaf family opens its products. All client-side from
    // the already-loaded families list — no extra request, very light.
    const childrenOf = new Map(); // parentKey (0 = root) → [family]
    for (const f of families) {
        const key = f.parentId == null ? 0 : f.parentId;
        if (!childrenOf.has(key)) childrenOf.set(key, []);
        childrenOf.get(key).push(f);
    }
    const hasChildren = (id) => (childrenOf.get(id) || []).length > 0;

    const parentId = Number(new URLSearchParams(location.search).get('parent')) || null;
    const level = childrenOf.get(parentId == null ? 0 : parentId) || [];

    // Title + back link reflect the current level.
    const titleEl = document.querySelector('.page-title');
    const subEl = document.querySelector('.page-subtitle');
    const parent = parentId != null ? families.find(f => f.id === parentId) : null;
    if (parent) {
        if (titleEl) titleEl.textContent = parent.name;
        if (subEl) subEl.textContent = 'التصنيفات الفرعية';
        setCategoriesBackLink(parent.parentId); // up one level (null → root)
    } else {
        if (titleEl) titleEl.textContent = 'التصنيفات';
        if (subEl) subEl.textContent = 'جميع تصنيفات المتجر';
        setCategoriesBackLink(undefined); // remove the back link at root
    }

    if (level.length === 0) {
        grid.innerHTML = '<div class="empty-state"><h2>لا توجد تصنيفات حاليًا</h2><p>الرجاء العودة لاحقًا.</p></div>';
        return;
    }

    grid.innerHTML = level.map(f => {
        const href = hasChildren(f.id)
            ? categoriesHref('?parent=' + f.id)
            : withTenant('products.html?familyId=' + f.id);
        return `
        <a href="${href}" class="category-card">
            <div class="category-image">
                ${renderImageOrPlaceholder(f.imageUrl || null, f.name.charAt(0))}
            </div>
            <div class="category-name">${escapeHtml(f.name)}</div>
        </a>`;
    }).join('');

    // Predictive prefetch: the moment the customer's pointer/finger reaches the
    // categories, warm the catalog so the category they click opens instantly.
    const warm = () => BWS.prefetchCatalog();
    grid.addEventListener('pointerover', warm, { once: true, passive: true });
    grid.addEventListener('touchstart', warm, { once: true, passive: true });
}

// Href to the CURRENT categories page (index.html / categories.html) carrying a
// query, so sub-level navigation stays on the same page (and keeps the tenant).
function categoriesHref(query) {
    const page = (location.pathname.split('/').pop() || 'index.html');
    return withTenant(page + query);
}

// Show/hide the "back" link in the title section.
//   undefined → remove (we're at the root level)
//   null      → link back to the root
//   <id>      → link back to that ancestor level
function setCategoriesBackLink(parentOfCurrent) {
    const section = document.querySelector('.page-title-section');
    let link = document.getElementById('catBackLink');
    if (parentOfCurrent === undefined) {
        if (link) link.remove();
        return;
    }
    if (!link && section) {
        link = document.createElement('a');
        link.id = 'catBackLink';
        link.className = 'back-link';
        section.appendChild(link);
    }
    if (link) {
        link.textContent = '→ رجوع';
        link.href = (parentOfCurrent == null)
            ? categoriesHref('')
            : categoriesHref('?parent=' + parentOfCurrent);
    }
}

// All-products display mode (paginated) shown on the home page.
async function renderAllProductsMode(grid, pageSize) {
    const titleEl = document.querySelector('.page-title');
    const subEl = document.querySelector('.page-subtitle');
    if (titleEl) titleEl.textContent = 'المنتجات';
    if (subEl) subEl.textContent = 'جميع منتجات المتجر';

    grid.classList.remove('categories-grid');
    grid.classList.add('products-grid');

    const section = grid.closest('.content-section') || grid.parentElement;
    let pager = document.getElementById('productsPager');
    if (!pager) {
        pager = document.createElement('div');
        pager.id = 'productsPager';
        pager.className = 'products-pager';
        section.appendChild(pager);
    }

    const size = pageSize || 25;
    let page = 1;

    function renderPager(total) {
        const pages = Math.max(1, Math.ceil(total / size));
        if (pages <= 1) { pager.innerHTML = ''; return; }
        pager.innerHTML = `
            <button class="pager-btn" id="pagerPrev" ${page <= 1 ? 'disabled' : ''}>السابق</button>
            <span class="pager-info">صفحة ${page} من ${pages}</span>
            <button class="pager-btn" id="pagerNext" ${page >= pages ? 'disabled' : ''}>التالي</button>
        `;
        document.getElementById('pagerPrev')?.addEventListener('click', () => { if (page > 1) loadPage(page - 1); });
        document.getElementById('pagerNext')?.addEventListener('click', () => { if (page < pages) loadPage(page + 1); });
    }

    async function loadPage(p) {
        page = p;
        grid.innerHTML = loadingHtml();
        let res;
        try {
            res = await BWS.fetchAllProducts({ page, pageSize: size });
        } catch (err) {
            grid.innerHTML = `<div class="empty-state"><h2>تعذّر تحميل المنتجات</h2><p>${escapeHtml(err.message || '')}</p></div>`;
            pager.innerHTML = '';
            return;
        }
        const { products, total } = res;
        if (!products.length) {
            grid.innerHTML = '<div class="empty-state"><h2>لا توجد منتجات حاليًا</h2></div>';
            pager.innerHTML = '';
            return;
        }
        grid.innerHTML = products.map(renderProductCard).join('');
        wireProductCards(grid, products, false);
        setupPriceTierBar(products, grid, false);
        deferHydrate(grid);
        renderPager(total);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    await loadPage(1);
}

// Default category image when a main/sub family has no picture: a neutral gray
// "category" (grid) icon — same gray treatment as the product box, but a
// category glyph. The old colored first-letter tile is gone.
const CATEGORY_BOX_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

function makeCategoryPlaceholder() {
    const div = document.createElement('div');
    div.className = 'category-placeholder';
    div.innerHTML = CATEGORY_BOX_SVG;
    return div;
}
window.makeCategoryPlaceholder = makeCategoryPlaceholder;

function renderImageOrPlaceholder(src) {
    if (src) {
        return `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" onerror="this.replaceWith(makeCategoryPlaceholder())">`;
    }
    return `<div class="category-placeholder">${CATEGORY_BOX_SVG}</div>`;
}

// Default product image: a neutral gray box icon (no site color, no letter).
// Used everywhere a product lacks a real image.
const PRODUCT_BOX_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8.5"/></svg>';

// Cart glyph for the per-product "add to cart" icon button.
const CART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>';

function renderProductImageOrPlaceholder(src) {
    if (src) {
        return `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" onerror="this.replaceWith(makeProductPlaceholder())">`;
    }
    return `<div class="product-placeholder">${PRODUCT_BOX_SVG}</div>`;
}

function makeProductPlaceholder() {
    const div = document.createElement('div');
    div.className = 'product-placeholder';
    div.innerHTML = PRODUCT_BOX_SVG;
    return div;
}
window.makeProductPlaceholder = makeProductPlaceholder;

// ===== Two-phase product images (text-first, images-after) =====
// Grid cards paint instantly with a neutral gray box; the real image URL rides
// on the container's data-img and is loaded only AFTER the cards are on screen,
// near the viewport. So a category opens fast (all product text/prices) and the
// images stream in progressively as the customer reads/scrolls.
function renderDeferredProductImage(src) {
    const data = src ? ` data-img="${escapeHtml(src)}"` : '';
    return `<div class="product-image"${data}><div class="product-placeholder">${PRODUCT_BOX_SVG}</div></div>`;
}

function hydrateProductImages(root) {
    if (!root) return;
    const boxes = Array.from(root.querySelectorAll('.product-image[data-img]'));
    if (!boxes.length) return;

    const swap = (box) => {
        const src = box.getAttribute('data-img');
        box.removeAttribute('data-img');
        if (!src) return;
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.onload = () => {
            box.innerHTML = '';
            box.appendChild(img);
            box.classList.add('img-ready');
        };
        img.onerror = () => { /* keep the gray placeholder */ };
        img.src = src;
    };

    if (!('IntersectionObserver' in window)) {
        boxes.forEach(swap);
        return;
    }
    const obs = new IntersectionObserver((entries, o) => {
        for (const e of entries) {
            if (e.isIntersecting) { o.unobserve(e.target); swap(e.target); }
        }
    }, { rootMargin: '300px 0px', threshold: 0.01 });
    boxes.forEach(b => obs.observe(b));
}

// Start image loading only after the product cards have painted (two frames),
// so the list text is visible first, then the images begin.
function deferHydrate(grid) {
    requestAnimationFrame(() => requestAnimationFrame(() => hydrateProductImages(grid)));
}

// ===== Products Page =====
// A simple centered circular spinner shown while products load (cleaner than a
// blank white area). Spans the whole grid via grid-column.
function loadingHtml() {
    return '<div class="grid-loading"><div class="bws-spinner"></div></div>';
}

async function renderProductsPage() {
    const params = new URLSearchParams(window.location.search);
    const favoritesMode = params.get('favorites') === '1';
    const familyId = Number(params.get('familyId'));

    const titleEl = document.getElementById('productsPageTitle');
    const subtitleEl = document.getElementById('productsPageSubtitle');
    const grid = document.getElementById('productsGrid');
    const emptyState = document.getElementById('emptyState');

    // ----- Favourites: small set, load all at once (unchanged) -----
    if (favoritesMode) {
        titleEl.textContent = 'منتجاتي المفضلة';
        subtitleEl.textContent = 'المنتجات التي أضفتها للمفضلة';
        grid.innerHTML = loadingHtml();
        let products;
        try {
            products = await BWS.fetchFavoriteProducts();
        } catch (err) {
            grid.innerHTML = '';
            titleEl.textContent = 'تعذّر تحميل المفضلة';
            subtitleEl.textContent = err.message || '';
            emptyState.style.display = 'block';
            return;
        }
        if (products.length === 0) {
            grid.innerHTML = '';
            grid.style.display = 'none';
            emptyState.style.display = 'block';
            emptyState.innerHTML = '<p>لا توجد منتجات في المفضلة بعد. اضغط على ♥ في أي منتج لإضافته.</p>';
            return;
        }
        grid.style.display = '';
        emptyState.style.display = 'none';
        grid.innerHTML = products.map(renderProductCard).join('');
        wireProductCards(grid, products, true);
        setupPriceTierBar(products, grid, true);
        deferHydrate(grid);
        return;
    }

    // ----- Category: paginated + infinite scroll (light & fast) -----
    const family = await BWS.getFamilyById(familyId);
    if (!family) {
        titleEl.textContent = 'تصنيف غير موجود';
        subtitleEl.textContent = 'الرجاء اختيار تصنيف من قائمة التصنيفات';
        emptyState.style.display = 'block';
        return;
    }
    if (new Set(BWS.getHiddenIds()).has(family.id)) {
        titleEl.textContent = 'هذا التصنيف غير متاح';
        subtitleEl.textContent = '';
        emptyState.style.display = 'block';
        return;
    }

    // A family that owns sub-families is a navigation node, not a product list →
    // send the customer to its sub-categories instead of an empty product page.
    try {
        const fams = await BWS.getVisibleFamilies();
        if (fams.some(f => f.parentId === family.id)) {
            window.location.replace(withTenant('categories.html?parent=' + family.id));
            return;
        }
    } catch { /* families unavailable → fall through to products */ }

    // Name is known instantly (families primed by bootstrap) → no title flicker.
    titleEl.textContent = family.name;
    subtitleEl.textContent = 'منتجات التصنيف';

    // Instant path: if the catalog was prefetched (idle/hover), render this
    // family's products straight from the client cache — no network. The idle
    // prefetch keeps it fresh; falls back to the paged server fetch otherwise.
    let localItems = null;
    try {
        const cached = BWS.getCachedCatalog();
        if (cached && cached.length) {
            const items = cached.filter(p => p.family === family.name);
            if (items.length) localItems = items;
        }
    } catch { /* ignore → server fetch */ }

    await renderFamilyPaged(family, grid, emptyState, localItems);
}

// Category view: load page 1 immediately (with a skeleton placeholder), then
// auto-load further pages as the customer nears the bottom (IntersectionObserver
// sentinel). Each page renders text-first; its images hydrate afterwards.
async function renderFamilyPaged(family, grid, emptyState, localItems = null) {
    const size = Math.max(12, Number(BWS.getSettings().pageSize) || 30);
    const all = [];
    let page = 1, total = 0, loading = false, done = false;

    grid.style.display = '';
    emptyState.style.display = 'none';
    grid.innerHTML = loadingHtml();

    // A sentinel placed after the grid; when it scrolls into view we load more.
    const section = grid.closest('.content-section') || grid.parentElement;
    let sentinel = document.getElementById('gridSentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = 'gridSentinel';
        sentinel.className = 'grid-sentinel';
        section.appendChild(sentinel);
    }
    sentinel.style.display = 'none';

    let observer = null;
    const finish = () => {
        done = true;
        sentinel.style.display = 'none';
        if (observer) observer.disconnect();
    };

    // Render one page's products (shared by the bootstrap preload + loadNext).
    function appendPage(products) {
        if (page === 1) {
            grid.innerHTML = ''; // clear the skeleton
            if (products.length === 0) {
                grid.style.display = 'none';
                emptyState.style.display = 'block';
                finish();
                return;
            }
        }
        all.push(...products);
        grid.insertAdjacentHTML('beforeend', products.map(renderProductCard).join(''));
        wireProductCards(grid, all, false);
        setupPriceTierBar(all, grid, false);
        deferHydrate(grid);

        page += 1;
        if (all.length >= total || products.length < size) {
            finish();
        } else {
            sentinel.textContent = '';
            sentinel.style.display = '';
            // If the page didn't fill the viewport, keep going.
            requestAnimationFrame(() => {
                const r = sentinel.getBoundingClientRect();
                if (r.top < window.innerHeight + 200) loadNext();
            });
        }
    }

    async function loadNext() {
        if (loading || done) return;
        loading = true;
        if (page > 1) sentinel.textContent = 'جاري التحميل...';

        // Local source: paginate the prefetched catalog in memory (instant).
        if (localItems) {
            total = localItems.length;
            const start = (page - 1) * size;
            appendPage(localItems.slice(start, start + size));
            loading = false;
            return;
        }

        let res;
        try {
            res = await BWS.fetchProductsForFamilyPaged(family.name, { page, pageSize: size });
        } catch (err) {
            loading = false;
            if (page === 1) {
                grid.innerHTML = '';
                grid.style.display = 'none';
                emptyState.style.display = 'block';
                emptyState.innerHTML = `<p>${escapeHtml(err.message || 'تعذّر تحميل المنتجات')}</p>`;
                finish();
            }
            return;
        }
        total = res.total || 0;
        appendPage(res.products || []);
        loading = false;
    }

    if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) loadNext();
        }, { rootMargin: '400px 0px' });
        observer.observe(sentinel);
    }

    // Prefer the prefetched catalog (instant, local pagination); else the page
    // bootstrap already preloaded (no extra request); else fetch the first page.
    if (localItems) {
        await loadNext();
    } else {
        const pre = BWS.takePreloadedFamilyPage(family.id);
        if (pre) {
            total = pre.total;
            appendPage(pre.products);
        } else {
            await loadNext();
        }
    }
}

function renderProductCard(p) {
    const available = p.available && p.quantity > 0;
    const fav = p.isFavorite ? ' active' : '';

    // Which buttons show is admin-controlled PER audience (guest vs registered),
    // resolved from the already-loaded settings — no extra request, applied live.
    const audience = BWS.getCustomerSession() ? 'registered' : 'guest';
    const vis = BWS.buttonVisibility(audience);

    const orderUrl = withTenant('order.html?product=' + encodeURIComponent(p.uuid));
    const orderBtn = vis.order
        ? (available
            ? `<a class="add-cart-btn order-btn" href="${orderUrl}">اضغط هنا للطلب</a>`
            : `<span class="add-cart-btn order-btn unavailable-btn">غير متاح</span>`)
        : '';
    const cartIconBtn = (vis.cart && available)
        ? `<button class="cart-icon-btn" type="button" aria-label="إضافة إلى السلة" title="إضافة إلى السلة">${CART_SVG}</button>`
        : '';
    // Heart overlays the image (top-left corner); shown per the audience setting.
    const favBtn = vis.fav
        ? `<button class="fav-btn${fav}" type="button" aria-label="مفضلة">♥</button>`
        : '';

    return `
        <div class="product-card${available ? '' : ' unavailable'}" data-uuid="${escapeHtml(p.uuid)}">
            ${favBtn}
            <a class="product-link" href="${orderUrl}">
                ${renderDeferredProductImage(p.imageUrl)}
                <div class="product-name">${escapeHtml(p.name)}</div>
            </a>
            <div class="product-price">${BWS.formatPrice(BWS.effectivePrice(p))}</div>
            <div class="product-status ${available ? 'status-available' : 'status-unavailable'}">
                ${available ? 'متاح' : 'غير متاح'}
            </div>
            <div class="product-actions">
                ${orderBtn}${cartIconBtn}
            </div>
        </div>
    `;
}

// Global price-tier selector (shown only in "apply to all products" mode when
// the customer is allowed more than one tier). Switches the price shown on all
// cards at once.
// Price switching is removed: each customer has exactly ONE price tier, so there
// is no «السعر المعروض» bar. Kept as a no-op that clears any stale bar.
function setupPriceTierBar() {
    document.getElementById('priceTierBar')?.remove();
}

// No per-item price switch anymore (single tier per customer).
function priceArrowHtml() {
    return '';
}

function wireProductCards(grid, products, favoritesMode) {
    const productByUuid = new Map(products.map(p => [p.uuid, p]));
    grid.querySelectorAll('.product-card').forEach(card => {
        // Idempotent: skip cards already wired (so appended pages during
        // infinite scroll don't double-bind their listeners).
        if (card.dataset.wired) return;
        card.dataset.wired = '1';
        const uuid = card.dataset.uuid;

        // Add to cart (the small cart-icon button; the big button is an order link).
        // Size selection now happens IN THE CART (a «🔧 الأحجام» button per line),
        // so adding here is a plain add — the product's available sizes ride along.
        const addBtn = card.querySelector('.cart-icon-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const product = productByUuid.get(uuid);
                if (BWS.addToCart(product, 1)) {
                    updateCartBadge();
                    if (document.getElementById('cartSidebar')?.classList.contains('open')) {
                        renderCartSidebar();
                    }
                    showToast('تمت إضافة المنتج إلى السلة');
                } else {
                    showToast('المنتج غير متاح');
                }
            });
        }

        // Favorite toggle (heart overlay on the image)
        const favBtn = card.querySelector('.fav-btn');
        if (favBtn) {
            favBtn.addEventListener('click', async (e) => {
                // The heart sits over the product link → don't navigate.
                e.preventDefault();
                e.stopPropagation();
                // Favourites need an account; a guest is sent to login instead.
                if (!BWS.getCustomerSession()) {
                    showToast('سجّل الدخول لإضافة المنتجات إلى المفضلة');
                    setTimeout(() => { window.location.href = withTenant('login.html'); }, 1100);
                    return;
                }
                const product = productByUuid.get(uuid);
                const willActivate = !favBtn.classList.contains('active');
                favBtn.classList.toggle('active', willActivate);
                if (product) product.isFavorite = willActivate;
                try {
                    if (willActivate) await BWS.addFavorite(uuid);
                    else await BWS.removeFavorite(uuid);
                } catch {
                    // Revert on failure.
                    favBtn.classList.toggle('active', !willActivate);
                    if (product) product.isFavorite = !willActivate;
                    showToast('تعذّر تحديث المفضلة');
                    return;
                }
                if (willActivate) {
                    showToast('أُضيف إلى المفضلة');
                } else {
                    showToast('أُزيل من المفضلة');
                    // In favourites view, removing should drop the card.
                    if (favoritesMode) {
                        card.remove();
                        if (!grid.querySelector('.product-card')) {
                            const emptyState = document.getElementById('emptyState');
                            grid.style.display = 'none';
                            emptyState.style.display = 'block';
                            emptyState.innerHTML = '<p>لا توجد منتجات في المفضلة بعد.</p>';
                        }
                    }
                }
            });
        }
    });
}

// ===== Cart Page =====
function renderCartPage() {
    const container = document.getElementById('cartContainer');
    const summary = document.getElementById('cartSummary');
    const emptyState = document.getElementById('emptyCartState');

    const cart = BWS.getCart();
    if (cart.length === 0) {
        container.style.display = 'none';
        summary.style.display = 'none';
        emptyState.style.display = 'block';
        return;
    }

    container.style.display = '';
    summary.style.display = '';
    emptyState.style.display = 'none';

    container.innerHTML = cart.map(item => `
        <div class="cart-item" data-uuid="${escapeHtml(item.uuid)}">
            <div class="cart-item-image">
                ${renderProductImageOrPlaceholder(item.imageUrl || null)}
            </div>
            <div class="cart-item-info">
                <h4>${escapeHtml(item.name)}</h4>
                <div class="item-price">${BWS.formatPrice(item.price)}${priceArrowHtml(item)}</div>
                <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(item.family || '')}</div>
                ${sizeEditHtml(item)}
            </div>
            <div class="qty-controls">
                <button class="qty-btn qty-dec" aria-label="تقليل">−</button>
                <span class="qty-value">${item.qty}</span>
                <button class="qty-btn qty-inc" aria-label="زيادة">+</button>
            </div>
            <button class="remove-btn">حذف</button>
        </div>
    `).join('');

    container.querySelectorAll('.cart-item').forEach(row => {
        const uuid = row.dataset.uuid;
        row.querySelector('.qty-dec').addEventListener('click', () => {
            const current = BWS.getCart().find(it => it.uuid === uuid);
            if (!current) return;
            if (current.qty <= 1) BWS.removeFromCart(uuid);
            else BWS.updateCartQty(uuid, current.qty - 1);
            renderCartPage();
            updateCartBadge();
        });
        row.querySelector('.qty-inc').addEventListener('click', () => {
            const current = BWS.getCart().find(it => it.uuid === uuid);
            if (!current) return;
            BWS.updateCartQty(uuid, current.qty + 1);
            renderCartPage();
            updateCartBadge();
        });
        row.querySelector('.remove-btn').addEventListener('click', () => {
            BWS.removeFromCart(uuid);
            renderCartPage();
            updateCartBadge();
            showToast('تم حذف المنتج من السلة');
        });
        wireSizeEdit(row, uuid, renderCartPage);
        const switchBtn = row.querySelector('.price-switch-btn');
        if (switchBtn) {
            switchBtn.addEventListener('click', () => {
                const cur = BWS.getCart().find(it => it.uuid === uuid);
                if (!cur) return;
                BWS.setCartItemTier(uuid, BWS.nextTier(cur.prices, cur.tier));
                renderCartPage();
            });
        }
    });

    document.getElementById('summaryCount').textContent = BWS.cartCount();
    document.getElementById('summaryTotal').textContent = BWS.formatPrice(BWS.cartTotal());

    const session = BWS.getCustomerSession();
    const loggedIn = session && BWS.getSessionToken();
    const isPublic = BWS.getSettings().orderMode === 'direct';
    // On a public store, a guest checks out via a quick delivery form
    // (name/phone/wilaya/delivery), exactly like the order page.
    const guestCheckout = isPublic && !loggedIn;
    if (guestCheckout) ensureGuestCheckoutForm(summary);
    else removeGuestCheckoutForm();

    const checkoutBtn = document.getElementById('checkoutBtn');
    checkoutBtn.onclick = async () => {
        if (guestCheckout) {
            const v = id => (document.getElementById(id)?.value || '').trim();
            const name = v('ckName'), phone = v('ckPhone'), wilaya = v('ckWilaya');
            const baladiya = v('ckBaladiya'), notes = v('ckNotes');
            const deliveryType = document.getElementById('ckDelivery')?.value || 'home';
            if (!name || !phone) { showToast('الرجاء إدخال الاسم ورقم الهاتف'); return; }
            if (!wilaya) { showToast('الرجاء اختيار الولاية'); return; }
            checkoutBtn.disabled = true;
            checkoutBtn.textContent = 'جاري الإرسال...';
            const items = BWS.getCart().map(it => ({
                uuid: it.uuid, id: it.id ?? null, name: it.name,
                price: Number(it.price || 0), quantity: Number(it.qty || 0),
                unitType: it.unitType || 'قطعة',
                // تفصيل «الطلب بالأحجام» — كان يُسقَط هنا فتضيع الأحجام للزبون
                // العابر (تظهر الكمية الإجمالية فقط عند تعديل الفاتورة).
                unitQty: Number(it.unitQty) || 0,
                sizes: Array.isArray(it.sizes) ? it.sizes : []
            }));
            const result = await BWS.submitGuestOrder({
                items, name, phone, wilaya, baladiya, deliveryType, notes,
                delivery: cartDeliveryFee()
            });
            if (result.ok) {
                BWS.clearCart();
                renderCartPage();
                updateCartBadge();
                showToast('تم إرسال طلبك. سيتواصل معك المتجر قريبًا.');
            } else {
                showToast(result.error || 'تعذّر إرسال الطلب');
            }
            checkoutBtn.disabled = false;
            checkoutBtn.textContent = 'إتمام الطلب';
            return;
        }

        if (!loggedIn) {
            showToast('الرجاء تسجيل الدخول لإتمام الطلب');
            setTimeout(() => { window.location.href = withTenant('login.html'); }, 1200);
            return;
        }
        checkoutBtn.disabled = true;
        checkoutBtn.textContent = 'جاري الإرسال...';
        const result = await BWS.submitOrder({
            name: session.name || session.username,
            phone: session.phone || ''
        });
        if (result.ok) {
            renderCartPage();
            updateCartBadge();
            showToast('تم إرسال طلبك. سيتواصل معك المتجر قريبًا.');
        } else {
            showToast(result.error || 'تعذّر إرسال الطلب');
        }
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = 'إتمام الطلب';
    };
    document.getElementById('clearCartBtn').onclick = () => {
        if (confirm('هل تريد فعلاً إفراغ السلة؟')) {
            BWS.clearCart();
            renderCartPage();
            updateCartBadge();
        }
    };
}

// ===== Guest checkout form (public store, no login) =====
// Injected once into the cart summary; collects the same delivery details as
// the order page so a guest can complete a multi-item cart order.
function ensureGuestCheckoutForm(summary) {
    if (!summary || document.getElementById('guestCheckoutForm')) return;
    const wilayas = (window.BWS_WILAYAS || []);
    const form = document.createElement('div');
    form.id = 'guestCheckoutForm';
    form.className = 'guest-checkout-form';
    form.innerHTML = `
        <h4>معلومات التوصيل</h4>
        <input type="text" id="ckName" placeholder="الإسم الكامل" autocomplete="name">
        <input type="tel" id="ckPhone" inputmode="tel" placeholder="رقم الهاتف" autocomplete="tel">
        <select id="ckWilaya">
            <option value="">الولاية</option>
            ${wilayas.map(w => `<option value="${escapeHtml(w.code + ' - ' + w.name)}" data-wid="${w.id}">${escapeHtml(w.code + ' - ' + w.name)}</option>`).join('')}
        </select>
        <select id="ckBaladiya" disabled>
            <option value="">البلدية / الدائرة</option>
        </select>
        <select id="ckDelivery">
            <option value="home">🏠 توصيل إلى المنزل</option>
            <option value="office">🏢 توصيل إلى المكتب</option>
        </select>
        <input type="text" id="ckNotes" placeholder="ملاحظة (اختيارية)">
        <div class="ck-delivery-row">
            <span>🚚 سعر التوصيل</span>
            <span id="ckDeliveryFee" class="ck-delivery-fee">0.00 د.ج</span>
        </div>
        <div class="ck-grand-row">
            <span>الإجمالي مع التوصيل</span>
            <span id="ckGrandTotal"></span>
        </div>
    `;
    const checkoutBtn = document.getElementById('checkoutBtn');
    summary.insertBefore(form, checkoutBtn);

    const wilSel = document.getElementById('ckWilaya');
    const balSel = document.getElementById('ckBaladiya');
    wilSel.addEventListener('change', () => {
        populateCartBaladiyas(wilSel, balSel);
        updateCartDeliveryUI();
    });
    document.getElementById('ckDelivery').addEventListener('change', updateCartDeliveryUI);
    updateCartDeliveryUI();
}

// سعر التوصيل الحالي في السلة (حسب الولاية ونوع التسليم؛ لكل ولاية سعرها).
function cartDeliveryFee() {
    const wilSel = document.getElementById('ckWilaya');
    if (!wilSel) return 0;
    const opt = wilSel.options[wilSel.selectedIndex];
    const wid = opt ? (opt.getAttribute('data-wid') || '') : '';
    if (!wid) return 0;
    const type = document.getElementById('ckDelivery')?.value || 'home';
    return BWS.deliveryFee(wid, '', type);
}

function updateCartDeliveryUI() {
    const fee = cartDeliveryFee();
    const feeEl = document.getElementById('ckDeliveryFee');
    const grandEl = document.getElementById('ckGrandTotal');
    if (feeEl) feeEl.textContent = BWS.formatPrice(fee);
    if (grandEl) grandEl.textContent = BWS.formatPrice(BWS.cartTotal() + fee);
}

function removeGuestCheckoutForm() {
    document.getElementById('guestCheckoutForm')?.remove();
}

// Fill the cart baladiya dropdown with the communes of the selected wilaya
// (optional delivery-address info — the home fee stays per-wilaya).
function populateCartBaladiyas(wilSel, balSel) {
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

// ===== نافذة الطلب بالأحجام =====
// تُرجع { total, unitQty, sizes:[{name,capacity,qty}] } أو null عند الإلغاء.
// Size-editing controls for a cart line (shown only when size ordering is enabled
// for the current viewer AND the product has size definitions). Lets the customer
// choose/change sizes from inside the cart.
function sizeEditHtml(item) {
    if (!BWS.sizeOrderingEnabled() || !Array.isArray(item.allSizes) || !item.allSizes.length) return '';
    const chosen = Array.isArray(item.sizes) ? item.sizes.filter(s => Number(s.qty) > 0) : [];
    const summary = chosen.length
        ? chosen.map(s => `${escapeHtml(s.name)}×${s.qty}`).join('، ')
        : 'اختر الأحجام';
    return `<div class="cart-sizes-line">
        <button class="size-edit-btn" type="button">🔧 الأحجام</button>
        <span class="cart-sizes-summary">${summary}</span>
    </div>`;
}

function wireSizeEdit(row, uuid, rerender) {
    const btn = row.querySelector('.size-edit-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const cur = BWS.getCart().find(it => it.uuid === uuid);
        if (!cur || !Array.isArray(cur.allSizes) || !cur.allSizes.length) return;
        const product = { name: cur.name, quantity: cur.maxQty, sizes: cur.allSizes };
        const res = await showSizeOrderDialog(product, { unitQty: cur.unitQty || 0, sizes: cur.sizes || [] });
        if (!res) return;
        BWS.updateCartItemSizes(uuid, res.total, res.unitQty, res.sizes);
        updateCartBadge();
        rerender();
    });
}

function showSizeOrderDialog(product, initial) {
    return new Promise((resolve) => {
        const cap = Number(product.quantity) || 0;
        const initSizes = (initial && Array.isArray(initial.sizes)) ? initial.sizes : [];
        const initQtyOf = (name) => {
            const m = initSizes.find(s => s.name === name);
            return m ? (Number(m.qty) || 0) : 0;
        };
        const sizes = (product.sizes || []).map(s => ({
            name: s.name, capacity: Number(s.capacity) || 0, qty: initQtyOf(s.name)
        }));
        let unitQty = initial ? (Number(initial.unitQty) || 0) : 1;
        const okLabel = initial ? 'تحديث السلة' : 'إضافة للسلة';

        const overlay = document.createElement('div');
        overlay.className = 'size-modal-overlay';
        overlay.innerHTML =
            '<div class="size-modal" dir="rtl">' +
            `<h3>${escapeHtml(product.name)}</h3>` +
            '<div class="size-total">الكمية الإجمالية: <b id="szTotal">0</b></div>' +
            '<div class="size-row"><span>الكمية بالوحدة</span>' +
            `<input type="number" id="szUnit" min="0" value="${unitQty}" class="size-qty"></div>` +
            '<div id="szSizes"></div>' +
            '<div class="size-actions">' +
            '<button type="button" class="size-cancel">إلغاء</button>' +
            `<button type="button" class="size-ok">${escapeHtml(okLabel)}</button>` +
            '</div></div>';
        document.body.appendChild(overlay);

        const szSizes = overlay.querySelector('#szSizes');
        szSizes.innerHTML = sizes.map((s, i) =>
            '<div class="size-row">' +
            `<span>${escapeHtml(s.name)} (سعة ${s.capacity})</span>` +
            `<input type="number" min="0" value="${s.qty}" data-i="${i}" class="size-qty sz-size">` +
            `<span class="sz-sub" data-i="${i}">× ${s.capacity} = ${s.qty * s.capacity}</span>` +
            '</div>').join('');

        const recompute = () => {
            let total = unitQty;
            sizes.forEach((s, i) => {
                total += s.qty * s.capacity;
                const sub = szSizes.querySelector(`.sz-sub[data-i="${i}"]`);
                if (sub) sub.textContent = `× ${s.capacity} = ${s.qty * s.capacity}`;
            });
            overlay.querySelector('#szTotal').textContent = String(total);
        };

        overlay.querySelector('#szUnit').addEventListener('input', (e) => {
            unitQty = Math.max(0, Number(e.target.value) || 0);
            recompute();
        });
        szSizes.querySelectorAll('.sz-size').forEach((inp) => {
            inp.addEventListener('input', (e) => {
                const i = Number(e.target.dataset.i);
                sizes[i].qty = Math.max(0, Number(e.target.value) || 0);
                recompute();
            });
        });

        const close = (val) => { overlay.remove(); resolve(val); };
        overlay.querySelector('.size-cancel').addEventListener('click', () => close(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        overlay.querySelector('.size-ok').addEventListener('click', () => {
            let total = unitQty;
            sizes.forEach((s) => total += s.qty * s.capacity);
            if (total <= 0) { showToast('أدخل كمية'); return; }
            if (total > cap) { showToast('الكمية تتجاوز المتوفر (' + cap + ')'); return; }
            const chosen = sizes.filter(s => s.qty > 0)
                .map(s => ({ name: s.name, capacity: s.capacity, qty: s.qty }));
            close({ total, unitQty, sizes: chosen });
        });

        recompute();
    });
}

// ===== Contact Form =====
function wireContactForm() {
    const form = document.getElementById('contactForm');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        showToast('تم إرسال رسالتك. سنتواصل معك قريبًا.');
        form.reset();
    });
}

// ===== Utilities =====
function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2400);
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function makePlaceholder(text) {
    const div = document.createElement('div');
    div.className = 'category-placeholder';
    div.textContent = text;
    return div;
}
window.makePlaceholder = makePlaceholder;
