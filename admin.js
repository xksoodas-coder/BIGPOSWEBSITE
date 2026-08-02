/*
 * BigWebStore – Admin-side controller.
 * Each page wires itself up depending on which DOM elements exist.
 */

document.addEventListener('DOMContentLoaded', async () => {
    if (document.getElementById('loginForm')) {
        wireLogin();
        return;
    }

    if (!BWS.isAdminAuthed()) {
        window.location.href = 'admin-login.html';
        return;
    }

    wireLogout();
    wireAdminShell();

    try {
        if (document.getElementById('statTotalCategories')) {
            await renderDashboard();
        }
        if (document.getElementById('categoriesTableBody')) {
            await renderCategoriesTable();
            wireCategoriesToolbar();
        }
        if (document.getElementById('settingsForm')) {
            wireSettingsPage();
        }
        if (document.getElementById('descProductsList')) {
            await wireDescriptionsPage();
        }
    } catch (err) {
        console.error(err);
        showToastAdmin(err.message || 'خطأ في الاتصال بالخادم');
    }
});

// ===== شريط جانبي للإدارة (زر ثلاث خطوط) =====
function wireAdminShell() {
    if (document.getElementById('adminSidebar')) return;
    const page = (location.pathname.split('/').pop() || '').toLowerCase();

    const burger = document.createElement('button');
    burger.id = 'adminHamburger';
    burger.className = 'admin-hamburger';
    burger.setAttribute('aria-label', 'القائمة');
    burger.innerHTML = '<span></span><span></span><span></span>';
    const headerC = document.querySelector('.admin-header-container');
    if (headerC) headerC.prepend(burger);
    else { burger.classList.add('floating'); document.body.appendChild(burger); }

    const overlay = document.createElement('div');
    overlay.className = 'admin-sidebar-overlay';
    document.body.appendChild(overlay);

    const items = [
        { label: '📦 المنتجات', href: 'admin-descriptions.html', match: 'admin-descriptions.html' },
        { label: '🗂️ التصنيفات', href: 'admin-categories.html', match: 'admin-categories.html' },
        { label: '⚙️ الإعدادات', href: 'admin-settings.html', match: 'admin-settings.html' },
        { label: '🎨 المظاهر', href: 'admin-settings.html#appearanceCard', match: '' }
    ];
    const sidebar = document.createElement('aside');
    sidebar.className = 'admin-sidebar';
    sidebar.id = 'adminSidebar';
    sidebar.innerHTML =
        '<div class="admin-sidebar-head"><div class="logo-circle small"><span>BS</span></div><span>لوحة الإدارة</span></div>' +
        '<nav class="admin-sidebar-nav">' +
        items.map(it => `<a href="${it.href}" class="${it.match === page ? 'active' : ''}">${it.label}</a>`).join('') +
        '</nav>' +
        '<div class="admin-sidebar-foot">' +
        '<a href="admin-dashboard.html">🏠 لوحة التحكم</a>' +
        '<a href="index.html" target="_blank">🛍️ عرض المتجر</a>' +
        '</div>';
    document.body.appendChild(sidebar);

    // إخفاء الشريط العلوي القديم (استبدلناه بالجانبي).
    document.querySelector('.admin-nav')?.classList.add('admin-nav-hidden');

    const open = () => { sidebar.classList.add('open'); overlay.classList.add('show'); };
    const close = () => { sidebar.classList.remove('open'); overlay.classList.remove('show'); };
    burger.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open());
    overlay.addEventListener('click', close);
    sidebar.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
}

// ===== Login =====
async function wireLogin() {
    if (BWS.isAdminAuthed()) {
        window.location.href = 'admin-dashboard.html';
        return;
    }

    // If the store is known from the link/domain, hide the store-code field —
    // the server resolves the store from the tenant.
    let tenantActive = false;
    try {
        const tenant = await BWS.resolveTenant();
        // A store subdomain identifies the store by itself (Host header), so
        // hide the code field even when the tenant lookup could not confirm it.
        tenantActive = !!BWS.tenantHostSlug() || !!(tenant && tenant.found && tenant.active);
        if (tenantActive) {
            const grp = document.getElementById('adminStoreIdGroup');
            if (grp) grp.style.display = 'none';
            const nameEl = document.getElementById('adminTenantName');
            if (nameEl && tenant.name) { nameEl.textContent = tenant.name; nameEl.hidden = false; }
        }
    } catch { /* platform host → keep store-code field */ }

    // Show / hide the password.
    const passInput = document.getElementById('password');
    const toggle = document.getElementById('toggleAdminPassword');
    if (passInput && toggle) {
        toggle.addEventListener('click', () => {
            const show = passInput.type === 'password';
            passInput.type = show ? 'text' : 'password';
            toggle.setAttribute('aria-pressed', String(show));
            const label = show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور';
            toggle.setAttribute('aria-label', label);
            toggle.setAttribute('title', label);
            passInput.focus({ preventScroll: true });
        });
    }

    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const storeId = tenantActive ? '' : document.getElementById('storeId').value.trim();
        const err = document.getElementById('loginError');
        // Write into the text span so the alert icon survives.
        const errText = document.getElementById('loginErrorText') || err;
        err.hidden = true;

        const btn = form.querySelector('button[type="submit"]');
        const label = document.getElementById('adminBtnLabel') || btn;
        const orig = label.textContent;
        btn.disabled = true;
        label.textContent = 'جاري الدخول...';
        btn.insertAdjacentHTML('afterbegin', '<span class="btn-spinner"></span>');

        const res = await BWS.adminLogin(username, password, storeId);
        if (res.ok) {
            window.location.href = 'admin-dashboard.html';
        } else {
            err.hidden = false;
            errText.textContent = res.error || 'بيانات الدخول غير صحيحة';
            btn.disabled = false;
            const sp = btn.querySelector('.btn-spinner');
            if (sp) sp.remove();
            label.textContent = orig;
        }
    });
}

function wireLogout() {
    const btn = document.getElementById('logoutBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        BWS.adminLogout();
        window.location.href = 'admin-login.html';
    });
}

// ===== Dashboard =====
async function renderDashboard() {
    try {
        const all = await BWS.getAllFamilies();
        document.getElementById('statTotalCategories').textContent = all.length;
    } catch {
        document.getElementById('statTotalCategories').textContent = '—';
    }
}

// ===== Categories admin =====
async function renderCategoriesTable(filterText = '') {
    const tbody = document.getElementById('categoriesTableBody');
    const hidden = new Set(BWS.getHiddenIds());

    let all;
    try {
        all = await BWS.getAllFamilies();
    } catch (err) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align:center;padding:24px;color:var(--danger,#c53030)">
                    تعذّر الاتصال بالخادم: ${escapeHtmlAdmin(err.message || '')}
                </td>
            </tr>
        `;
        return;
    }

    const filtered = all.filter(f =>
        !filterText || f.name.toLowerCase().includes(filterText.toLowerCase())
    );

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted)">
                    لا توجد نتائج
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filtered.map(f => {
        const isHidden = hidden.has(f.id);
        return `
            <tr data-family-id="${f.id}">
                <td>${f.id}</td>
                <td>${escapeHtmlAdmin(f.name)}</td>
                <td>
                    <span class="status-pill ${isHidden ? 'hidden' : 'visible'}">
                        ${isHidden ? 'مخفي' : 'ظاهر'}
                    </span>
                </td>
                <td>
                    <button class="toggle-switch ${isHidden ? '' : 'on'}" aria-label="تبديل">
                        <span class="toggle-track"></span>
                        <span class="toggle-label">${isHidden ? 'مخفي' : 'ظاهر'}</span>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('tr').forEach(tr => {
        const id = Number(tr.dataset.familyId);
        const toggle = tr.querySelector('.toggle-switch');
        if (!toggle) return;
        toggle.addEventListener('click', async () => {
            BWS.toggleHidden(id);
            const stillHidden = new Set(BWS.getHiddenIds()).has(id);
            await renderCategoriesTable(document.getElementById('catSearch')?.value || '');
            showToastAdmin(stillHidden ? 'تم إخفاء التصنيف' : 'تم إظهار التصنيف');
        });
    });
}

function wireCategoriesToolbar() {
    const search = document.getElementById('catSearch');
    search?.addEventListener('input', () => {
        renderCategoriesTable(search.value);
    });

    document.getElementById('showAllBtn')?.addEventListener('click', async () => {
        BWS.setHiddenIds([]);
        await renderCategoriesTable(search?.value || '');
        showToastAdmin('تم إظهار جميع التصنيفات');
    });

    document.getElementById('hideAllBtn')?.addEventListener('click', async () => {
        if (!confirm('هل تريد إخفاء جميع التصنيفات من واجهة الزبون؟')) return;
        const all = await BWS.getAllFamilies();
        BWS.setHiddenIds(all.map(f => f.id));
        await renderCategoriesTable(search?.value || '');
        showToastAdmin('تم إخفاء جميع التصنيفات');
    });
}

// ===== Product descriptions admin =====
async function wireDescriptionsPage() {
    const listEl = document.getElementById('descProductsList');
    const searchEl = document.getElementById('descSearch');
    const loadMoreBtn = document.getElementById('descLoadMore');
    const PAGE_SIZE = 50;

    let descMap = {};        // uuid -> { shortDescription, description }
    let loaded = [];         // accumulated products across pages
    let page = 0;
    let total = Infinity;

    try {
        descMap = await BWS.fetchProductDescriptions();
    } catch (err) {
        descMap = {};
    }

    function hasDesc(uuid) {
        const d = descMap[uuid];
        return !!(d && ((d.shortDescription || '').trim() || (d.description || '').trim()));
    }

    function render() {
        const filter = (searchEl.value || '').trim().toLowerCase();
        const rows = loaded.filter(p => !filter || (p.name || '').toLowerCase().includes(filter));

        if (rows.length === 0) {
            listEl.innerHTML = `<p class="muted" style="padding:16px">لا توجد منتجات مطابقة</p>`;
            return;
        }

        listEl.innerHTML = rows.map(p => {
            const d = descMap[p.uuid] || { shortDescription: '', description: '' };
            const flagged = hasDesc(p.uuid);
            return `
                <div class="desc-row" data-uuid="${escapeHtmlAdmin(p.uuid)}">
                    <div class="desc-row-head">
                        <span class="desc-name">${escapeHtmlAdmin(p.name)}</span>
                        <span class="status-pill ${flagged ? 'visible' : 'hidden'}">
                            ${flagged ? 'له وصف' : 'بدون وصف'}
                        </span>
                        <button class="ghost-btn desc-toggle">تعديل الوصف</button>
                    </div>
                    <div class="desc-editor" hidden>
                        <label class="desc-label">وصف مختصر (نقاط — سطر لكل نقطة، يظهر بجانب اسم المنتج)</label>
                        <textarea class="admin-input desc-short" rows="3">${escapeHtmlAdmin(d.shortDescription || '')}</textarea>
                        <label class="desc-label">وصف كامل (فقرات تظهر أسفل المنتج)</label>
                        <textarea class="admin-input desc-full" rows="6">${escapeHtmlAdmin(d.description || '')}</textarea>
                        <div class="desc-actions">
                            <button class="primary-btn desc-save">حفظ الوصف</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('.desc-row').forEach(row => {
            const uuid = row.dataset.uuid;
            const editor = row.querySelector('.desc-editor');
            row.querySelector('.desc-toggle').addEventListener('click', () => {
                editor.hidden = !editor.hidden;
            });
            row.querySelector('.desc-save').addEventListener('click', async () => {
                const shortDescription = row.querySelector('.desc-short').value;
                const description = row.querySelector('.desc-full').value;
                const btn = row.querySelector('.desc-save');
                const orig = btn.textContent;
                btn.disabled = true;
                btn.textContent = 'جاري الحفظ...';
                try {
                    await BWS.saveProductDescription(uuid, shortDescription, description);
                    descMap[uuid] = { shortDescription, description };
                    const pill = row.querySelector('.status-pill');
                    const flagged = hasDesc(uuid);
                    pill.className = `status-pill ${flagged ? 'visible' : 'hidden'}`;
                    pill.textContent = flagged ? 'له وصف' : 'بدون وصف';
                    showToastAdmin('تم حفظ الوصف');
                } catch (err) {
                    showToastAdmin(err.message || 'تعذّر حفظ الوصف');
                } finally {
                    btn.disabled = false;
                    btn.textContent = orig;
                }
            });
        });
    }

    async function loadNextPage() {
        page += 1;
        loadMoreBtn.disabled = true;
        try {
            const { products, total: t } = await BWS.fetchAllProducts({ page, pageSize: PAGE_SIZE });
            total = t;
            loaded = loaded.concat(products);
            render();
        } catch (err) {
            if (page === 1) {
                listEl.innerHTML = `<p style="padding:16px;color:var(--danger,#c53030)">تعذّر تحميل المنتجات: ${escapeHtmlAdmin(err.message || '')}</p>`;
            }
        } finally {
            loadMoreBtn.disabled = false;
            loadMoreBtn.hidden = loaded.length >= total;
        }
    }

    searchEl.addEventListener('input', render);
    await loadNextPage();
    loadMoreBtn.addEventListener('click', loadNextPage);
}

// ===== Settings page =====
function wireSettingsPage() {
    const form = document.getElementById('settingsForm');
    const fields = {
        primary: document.getElementById('primary'),
        primaryHex: document.getElementById('primaryHex'),
        primaryDark: document.getElementById('primaryDark'),
        primaryDarkHex: document.getElementById('primaryDarkHex'),
        primaryLight: document.getElementById('primaryLight'),
        primaryLightHex: document.getElementById('primaryLightHex'),
        priceColor: document.getElementById('priceColor'),
        priceColorHex: document.getElementById('priceColorHex'),
        orderBtnColor: document.getElementById('orderBtnColor'),
        orderBtnColorHex: document.getElementById('orderBtnColorHex'),
        cartBtnColor: document.getElementById('cartBtnColor'),
        cartBtnColorHex: document.getElementById('cartBtnColorHex'),
        favColor: document.getElementById('favColor'),
        favColorHex: document.getElementById('favColorHex'),
        announcement: document.getElementById('announcement'),
        cartModePage: document.getElementById('cartModePage'),
        cartModeSidebar: document.getElementById('cartModeSidebar'),
        displayCategories: document.getElementById('displayCategories'),
        displayProducts: document.getElementById('displayProducts'),
        pageSize: document.getElementById('pageSize'),
        pageSizeWrap: document.getElementById('pageSizeWrap'),
        orderModeCart: document.getElementById('orderModeCart'),
        orderModeDirect: document.getElementById('orderModeDirect'),
        ppr4: document.getElementById('ppr4'),
        ppr5: document.getElementById('ppr5'),
        ppr6: document.getElementById('ppr6'),
        ppr7: document.getElementById('ppr7'),
        fpr4: document.getElementById('fpr4'),
        fpr5: document.getElementById('fpr5'),
        fpr6: document.getElementById('fpr6'),
        fpr7: document.getElementById('fpr7'),
        sizeOrderGuest: document.getElementById('sizeOrderGuest'),
        sizeOrderRegistered: document.getElementById('sizeOrderRegistered'),
        showOutOfStock: document.getElementById('showOutOfStock'),
        metaPixelId: document.getElementById('metaPixelId'),
        metaAdvancedMatching: document.getElementById('metaAdvancedMatching'),
        metaExcludeRegistered: document.getElementById('metaExcludeRegistered'),
        btnGuestOrder: document.getElementById('btnGuestOrder'),
        btnGuestCart: document.getElementById('btnGuestCart'),
        btnGuestFav: document.getElementById('btnGuestFav'),
        btnRegOrder: document.getElementById('btnRegOrder'),
        btnRegCart: document.getElementById('btnRegCart'),
        btnRegFav: document.getElementById('btnRegFav'),
        previewMain: document.getElementById('previewMain'),
        previewDark: document.getElementById('previewDark'),
        previewLight: document.getElementById('previewLight')
    };

    // أسعار التوصيل: office[wilayaId]=price ، home[wilayaId]=price (كلاهما لكل ولاية).
    let _delivery = { office: {}, home: {} };
    let _persistDelivery = async () => {}; // تُسنَد لاحقاً (حفظ فوري على الخادم).

    // ترحيل خريطة المنزل من مفاتيح البلدية القديمة ("wid|بلدية") إلى مفاتيح الولاية
    // ("wid")، كي تبقى الأسعار الحالية تعمل دون إعادة إدخال (آخر قيمة لكل ولاية تفوز).
    function collapseHomeAdmin(h) {
        const out = {};
        if (!h || typeof h !== 'object') return out;
        for (const k of Object.keys(h)) {
            const wid = String(k).split('|')[0];
            if (wid) out[wid] = Number(h[k]) || 0;
        }
        return out;
    }

    function syncPageSizeVisibility() {
        if (!fields.pageSizeWrap) return;
        fields.pageSizeWrap.style.display = fields.displayProducts.checked ? '' : 'none';
    }
    fields.displayCategories?.addEventListener('change', syncPageSizeVisibility);
    fields.displayProducts?.addEventListener('change', syncPageSizeVisibility);

    function setColorPair(colorEl, hexEl, value) {
        colorEl.value = value;
        hexEl.value = value.toUpperCase();
    }

    function syncColorToHex(colorEl, hexEl) {
        colorEl.addEventListener('input', () => {
            hexEl.value = colorEl.value.toUpperCase();
            updatePreview();
        });
        hexEl.addEventListener('input', () => {
            const v = hexEl.value.trim();
            if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
                colorEl.value = v;
                updatePreview();
            }
        });
    }

    function updatePreview() {
        fields.previewMain.style.backgroundColor = fields.primary.value;
        fields.previewDark.style.backgroundColor = fields.primaryDark.value;
        fields.previewLight.style.backgroundColor = fields.primaryLight.value;
    }

    function fillForm(s) {
        setColorPair(fields.primary, fields.primaryHex, s.theme.primary);
        setColorPair(fields.primaryDark, fields.primaryDarkHex, s.theme.primaryDark);
        setColorPair(fields.primaryLight, fields.primaryLightHex, s.theme.primaryLight);
        setColorPair(fields.priceColor, fields.priceColorHex, s.theme.priceColor);
        setColorPair(fields.orderBtnColor, fields.orderBtnColorHex, s.theme.orderBtnColor);
        setColorPair(fields.cartBtnColor, fields.cartBtnColorHex, s.theme.cartBtnColor);
        setColorPair(fields.favColor, fields.favColorHex, s.theme.favColor);
        fields.announcement.value = s.announcement || '';
        if (s.cartMode === 'sidebar') fields.cartModeSidebar.checked = true;
        else fields.cartModePage.checked = true;
        if (s.displayMode === 'products') fields.displayProducts.checked = true;
        else fields.displayCategories.checked = true;
        if (fields.pageSize) fields.pageSize.value = s.pageSize || 25;
        if (s.orderMode === 'direct') fields.orderModeDirect.checked = true;
        else fields.orderModeCart.checked = true;
        const pprField = fields['ppr' + (s.productsPerRow || 7)];
        if (pprField) pprField.checked = true;
        const fprField = fields['fpr' + (s.familiesPerRow || 4)];
        if (fprField) fprField.checked = true;
        _delivery = (s.delivery && typeof s.delivery === 'object')
            ? {
                office: { ...(s.delivery.office || {}) },
                home: collapseHomeAdmin(s.delivery.home)
              }
            : { office: {}, home: {} };
        renderDeliveryList();
        if (fields.sizeOrderGuest) fields.sizeOrderGuest.checked = s.sizeOrderGuest === true;
        if (fields.sizeOrderRegistered) fields.sizeOrderRegistered.checked = s.sizeOrderRegistered === true;
        if (fields.showOutOfStock) fields.showOutOfStock.checked = s.showOutOfStock !== false;
        if (fields.metaPixelId) fields.metaPixelId.value = s.metaPixelId || '';
        if (fields.metaAdvancedMatching) {
            fields.metaAdvancedMatching.checked = s.metaAdvancedMatching === true;
        }
        if (fields.metaExcludeRegistered) {
            fields.metaExcludeRegistered.checked = s.metaExcludeRegistered === true;
        }
        const pb = (s.productButtons && typeof s.productButtons === 'object') ? s.productButtons : {};
        const g = pb.guest || {}, rg = pb.registered || {};
        if (fields.btnGuestOrder) fields.btnGuestOrder.checked = g.order !== false;
        if (fields.btnGuestCart)  fields.btnGuestCart.checked  = g.cart !== false;
        if (fields.btnGuestFav)   fields.btnGuestFav.checked   = g.fav === true;
        if (fields.btnRegOrder)   fields.btnRegOrder.checked   = rg.order !== false;
        if (fields.btnRegCart)    fields.btnRegCart.checked    = rg.cart !== false;
        if (fields.btnRegFav)     fields.btnRegFav.checked     = rg.fav !== false;
        syncPageSizeVisibility();
        updatePreview();
    }

    // ── أسعار التوصيل ──
    const _wilayas = window.BWS_WILAYAS || [];
    const _widName = {};
    for (const w of _wilayas) _widName[String(w.id)] = `${w.code} - ${w.name}`;

    function setupDeliveryUI() {
        const off = document.getElementById('delOfficeWilaya');
        const homeW = document.getElementById('delHomeWilaya');
        if (!off || !homeW) return;
        const opts = '<option value="">اختر الولاية</option>' +
            _wilayas.map(w => `<option value="${w.id}">${escapeHtmlAdmin(w.code + ' - ' + w.name)}</option>`).join('');
        off.innerHTML = opts;
        homeW.innerHTML = opts;

        document.getElementById('delOfficeSave').addEventListener('click', () => {
            const wid = off.value;
            const price = Number(document.getElementById('delOfficePrice').value);
            if (!wid) { showToastAdmin('اختر الولاية'); return; }
            if (!(price >= 0)) { showToastAdmin('أدخل سعراً صحيحاً'); return; }
            _delivery.office[wid] = price;
            document.getElementById('delOfficePrice').value = '';
            renderDeliveryList();
            _persistDelivery();
        });

        document.getElementById('delHomeSave').addEventListener('click', () => {
            const wid = homeW.value;
            const price = Number(document.getElementById('delHomePrice').value);
            if (!wid) { showToastAdmin('اختر الولاية'); return; }
            if (!(price >= 0)) { showToastAdmin('أدخل سعراً صحيحاً'); return; }
            _delivery.home[wid] = price;
            document.getElementById('delHomePrice').value = '';
            renderDeliveryList();
            _persistDelivery();
        });
    }

    // قائمة موحَّدة: كل ولاية في سطر واحد، سعر المكتب وسعر المنزل جنباً إلى جنب،
    // وكلٌّ منهما يُحذف على حدة.
    function renderDeliveryList() {
        const el = document.getElementById('delList');
        if (!el) return;
        const office = _delivery.office || {};
        const home = _delivery.home || {};
        const wids = Array.from(new Set([...Object.keys(office), ...Object.keys(home)]))
            .sort((a, b) => Number(a) - Number(b));
        if (!wids.length) {
            el.innerHTML = '<p class="muted" style="font-size:12px">لا توجد أسعار توصيل بعد.</p>';
            return;
        }
        const part = (label, val, kind, wid) => (val != null && val !== '')
            ? `${label} <b>${escapeHtmlAdmin(String(val))}</b> د.ج <button type="button" class="ghost-btn del-rm" data-kind="${kind}" data-key="${escapeHtmlAdmin(wid)}" title="حذف">×</button>`
            : `<span style="color:#bbb">${label} —</span>`;
        el.innerHTML = wids.map(wid => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #eee;flex-wrap:wrap">
                <span style="font-weight:700;min-width:120px">${escapeHtmlAdmin(_widName[wid] || wid)}</span>
                <span style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:12.5px">
                    <span>${part('🏢 مكتب', office[wid], 'office', wid)}</span>
                    <span>${part('🏠 منزل', home[wid], 'home', wid)}</span>
                </span>
            </div>`).join('');
        el.querySelectorAll('.del-rm').forEach(b => {
            b.addEventListener('click', () => {
                const kind = b.getAttribute('data-kind');
                const key = b.getAttribute('data-key');
                if (kind === 'office') delete _delivery.office[key];
                else delete _delivery.home[key];
                renderDeliveryList();
                _persistDelivery();
            });
        });
    }

    // إعدادات المتجر الخام كما وصلت من الخادم (بلا تطبيع) وقت فتح الصفحة.
    let _serverRaw = {};

    async function load() {
        // Server is the source of truth for this store's settings.
        const s = await BWS.fetchSiteSettings({ adminAuth: true });
        _serverRaw = (BWS.getRawSettings ? BWS.getRawSettings() : {}) || {};
        fillForm(s);
    }

    syncColorToHex(fields.primary, fields.primaryHex);
    syncColorToHex(fields.primaryDark, fields.primaryDarkHex);
    syncColorToHex(fields.primaryLight, fields.primaryLightHex);
    syncColorToHex(fields.priceColor, fields.priceColorHex);
    syncColorToHex(fields.orderBtnColor, fields.orderBtnColorHex);
    syncColorToHex(fields.cartBtnColor, fields.cartBtnColorHex);
    syncColorToHex(fields.favColor, fields.favColorHex);
    setupDeliveryUI();

    // معرّف بيكسل ميتا كما كتبه الأدمين، بلا فراغات ولا رموز — أرقام فقط.
    // '' = معطَّل، null = مُدخَل غير صالح (يُبلَّغ به قبل الحفظ).
    function readPixelId() {
        const raw = String(fields.metaPixelId?.value || '').replace(/\s+/g, '');
        if (!raw) return '';
        return /^\d{5,20}$/.test(raw) ? raw : null;
    }

    // يجمع كل إعدادات الموقع من النموذج (تُستعمل في الحفظ اليدوي وفي حفظ أسعار
    // التوصيل الفوري).
    function collectSettings() {
        let pageSize = parseInt(fields.pageSize?.value, 10);
        if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 25;
        pageSize = Math.min(200, pageSize);
        // نبدأ من إعدادات المتجر كما قُرئت من الخادم عند فتح الصفحة، فنحافظ على
        // المفاتيح التي لا يعرفها هذا النموذج (مثل «banner» الذي يكتبه تطبيق
        // الإدارة) بدل محوها. guestPriceTier مستثنى: مصدره turso_web_settings
        // (تطبيق الهاتف) ويُدمج عند القراءة، فكتابته هنا تُجمّد قيمة قديمة.
        const preserved = { ..._serverRaw };
        delete preserved.guestPriceTier;
        // مُدخَل بيكسل غير صالح (يحدث فقط في الحفظ الفوري لأسعار التوصيل، فالحفظ
        // اليدوي يرفضه): أبقِ المعرّف المحفوظ بدل شطبه.
        const px = readPixelId();
        return {
            ...preserved,
            theme: {
                primary: fields.primary.value,
                primaryDark: fields.primaryDark.value,
                primaryLight: fields.primaryLight.value,
                priceColor: fields.priceColor?.value || '',
                orderBtnColor: fields.orderBtnColor?.value || '',
                cartBtnColor: fields.cartBtnColor?.value || '',
                favColor: fields.favColor?.value || ''
            },
            announcement: fields.announcement.value,
            cartMode: fields.cartModeSidebar.checked ? 'sidebar' : 'page',
            displayMode: fields.displayProducts.checked ? 'products' : 'categories',
            pageSize,
            orderMode: fields.orderModeDirect.checked ? 'direct' : 'cart',
            productsPerRow: Number(document.querySelector('input[name="productsPerRow"]:checked')?.value || 7),
            familiesPerRow: Number(document.querySelector('input[name="familiesPerRow"]:checked')?.value || 4),
            delivery: _delivery,
            sizeOrderGuest: !!fields.sizeOrderGuest?.checked,
            sizeOrderRegistered: !!fields.sizeOrderRegistered?.checked,
            showOutOfStock: fields.showOutOfStock ? !!fields.showOutOfStock.checked : true,
            metaPixelId: px === null ? String(preserved.metaPixelId || '') : px,
            metaAdvancedMatching: !!fields.metaAdvancedMatching?.checked,
            metaExcludeRegistered: !!fields.metaExcludeRegistered?.checked,
            productButtons: {
                guest: {
                    order: !!fields.btnGuestOrder?.checked,
                    cart: !!fields.btnGuestCart?.checked,
                    fav: !!fields.btnGuestFav?.checked
                },
                registered: {
                    order: !!fields.btnRegOrder?.checked,
                    cart: !!fields.btnRegCart?.checked,
                    fav: !!fields.btnRegFav?.checked
                }
            }
        };
    }

    // حفظ أسعار التوصيل فوراً على الخادم (دون انتظار زر «حفظ الإعدادات»).
    _persistDelivery = async () => {
        try {
            await BWS.saveSiteSettings(collectSettings());
            showToastAdmin('تم حفظ أسعار التوصيل ✅');
        } catch (err) {
            showToastAdmin(err.message || 'تعذّر الحفظ');
        }
    };

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        // معرّف بيكسل خاطئ يُبلَّغ عنه بدل أن يُحذف بصمت (وإلا ظنّ التاجر أن
        // التتبّع يعمل بينما هو معطَّل).
        if (readPixelId() === null) {
            showToastAdmin('معرّف البيكسل غير صالح — أرقام فقط (15 أو 16 رقمًا)');
            fields.metaPixelId?.focus();
            return;
        }
        const settings = collectSettings();

        const btn = form.querySelector('button[type="submit"]');
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'جاري الحفظ...';
        try {
            await BWS.saveSiteSettings(settings);
            showToastAdmin('تم حفظ الإعدادات على الخادم');
        } catch (err) {
            showToastAdmin(err.message || 'تعذّر حفظ الإعدادات');
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    });

    document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
        if (!confirm('استعادة الإعدادات الافتراضية؟')) return;
        fillForm(BWS.getDefaultSettings());
        showToastAdmin('تمت الاستعادة — اضغط حفظ لتطبيقها على الخادم');
    });

    load();
}

// ===== Utilities =====
function showToastAdmin(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToastAdmin._t);
    showToastAdmin._t = setTimeout(() => toast.classList.remove('show'), 2200);
}

function escapeHtmlAdmin(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
