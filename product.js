/*
 * BigWebStore — صفحة تفاصيل المنتج.
 * تُحمّل الأوصاف (المختصر + الكامل) فقط عند فتح منتج معيّن (lazy).
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

function imageOrPlaceholder(src, fallback) {
    // On load failure, fall back to the colored first-letter placeholder
    // (site color) instead of leaving an empty box.
    if (src) return `<img src="${escapeHtml(src)}" alt="" onerror="this.replaceWith(makePlaceholder('${escapeHtml(fallback)}'))">`;
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
function productImageOrPlaceholder(src, legacy) {
    if (src) {
        const fb = (legacy && legacy !== src) ? ` data-fb="${escapeHtml(legacy)}"` : '';
        return `<img src="${escapeHtml(src)}" alt=""${fb} onerror="if(this.dataset.fb){var u=this.dataset.fb;this.removeAttribute('data-fb');this.src=u;}else{this.replaceWith(makeProductPlaceholder());}">`;
    }
    return `<div class="product-placeholder">${PRODUCT_BOX_SVG}</div>`;
}
function bulletsHtml(text) {
    const lines = (text || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return '';
    return '<ul class="pd-bullets">' + lines.map(l => `<li>${escapeHtml(l)}</li>`).join('') + '</ul>';
}

document.addEventListener('DOMContentLoaded', async () => {
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

    const tenant = await BWS.resolveTenant();
    if (tenant && tenant.found && tenant.active === false) {
        document.getElementById('productPage').innerHTML =
            '<div class="empty-state"><h2>هذا المتجر غير متاح حاليًا</h2></div>';
        return;
    }
    try { await BWS.fetchSiteSettings(); } catch {}
    applyTheme();
    // بيكسل المتجر (إن ضبطه صاحب المتجر) — بعد وصول الإعدادات من الخادم.
    window.BWSPixel?.refresh();

    const direct = BWS.getSettings().orderMode === 'direct';
    window.__BWS_DIRECT__ = direct;

    // Cart mode requires login; direct mode is public.
    if (!direct) {
        if (!(BWS.getCustomerSession() && BWS.getSessionToken())) {
            window.location.replace(withStore('login.html'));
            return;
        }
        const badge = document.getElementById('cartBadge');
        if (badge) { const c = BWS.cartCount(); badge.textContent = c; badge.style.display = c > 0 ? 'flex' : 'none'; }
    } else {
        document.getElementById('cartIcon').style.display = 'none';
    }

    const uuid = (new URLSearchParams(location.search).get('uuid') || '').trim();
    const page = document.getElementById('productPage');
    if (!uuid) { page.innerHTML = '<div class="empty-state"><h2>منتج غير موجود</h2></div>'; return; }

    let p;
    try {
        p = await BWS.fetchProductDetail(uuid);
    } catch (err) {
        page.innerHTML = `<div class="empty-state"><h2>تعذّر تحميل المنتج</h2><p>${escapeHtml(err.message || '')}</p></div>`;
        return;
    }
    if (!p) { page.innerHTML = '<div class="empty-state"><h2>المنتج غير متاح</h2></div>'; return; }

    renderProduct(p, direct);
    window.BWSPixel?.viewContent(p);
});

function renderProduct(p, direct) {
    const page = document.getElementById('productPage');
    const available = p.available && p.quantity > 0;
    const price = BWS.effectivePrice(p);

    const action = !available
        ? `<div class="pd-unavailable">غير متاح حاليًا</div>`
        : (direct
            ? `<a class="checkout-btn pd-action" href="${withStore('order.html?product=' + encodeURIComponent(p.uuid))}">اضغط هنا للطلب</a>`
            : `<button class="checkout-btn pd-action" id="pdAdd">أضف إلى السلة</button>`);

    page.innerHTML = `
        <div class="pd-top">
            <div class="pd-image">${productImageOrPlaceholder(p.imageUrl, p.imageUrlLegacy)}</div>
            <div class="pd-info">
                <h1 class="pd-name">${escapeHtml(p.name)}</h1>
                <div class="pd-price">${BWS.formatPrice(price)}</div>
                ${p.shortDescription ? `<div class="pd-short">${bulletsHtml(p.shortDescription)}</div>` : ''}
                <div class="pd-status ${available ? 'status-available' : 'status-unavailable'}">${available ? 'متاح' : 'غير متاح'}</div>
                ${action}
            </div>
        </div>
        ${p.description ? `
        <div class="pd-full">
            <h2 class="pd-full-title">تفاصيل المنتج</h2>
            <div class="pd-full-body">${escapeHtml(p.description)}</div>
        </div>` : ''}
    `;

    const addBtn = document.getElementById('pdAdd');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            if (BWS.addToCart(p, 1)) {
                window.BWSPixel?.addToCart(p, 1);
                const badge = document.getElementById('cartBadge');
                if (badge) { const c = BWS.cartCount(); badge.textContent = c; badge.style.display = c > 0 ? 'flex' : 'none'; }
                showToast('تمت إضافة المنتج إلى السلة');
            } else {
                showToast('المنتج غير متاح');
            }
        });
    }
}
