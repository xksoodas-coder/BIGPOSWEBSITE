/**
 * Cloudflare R2 public URL builder for assets the desktop / mobile apps
 * upload (products + store logos + later family images).
 *
 * The base URL is the bucket's r2.dev public URL — same one R2Config.cs
 * uses on the desktop side.
 */

const R2_PUBLIC_BASE =
    process.env.R2_PUBLIC_URL ||
    'https://pub-19134f600ae440bd83f48f9c42296d4e.r2.dev';

function clean(base) {
    return base.replace(/\/+$/, '');
}

export function productImageUrl(productUuid, version = '') {
    if (!productUuid) return '';
    const v = version ? `?v=${encodeURIComponent(version)}` : '';
    return `${clean(R2_PUBLIC_BASE)}/products/${productUuid}.jpg${v}`;
}

export function storeLogoUrl(storeId, version = '') {
    if (!storeId) return '';
    const v = version ? `?v=${encodeURIComponent(version)}` : '';
    return `${clean(R2_PUBLIC_BASE)}/logos/${storeId}.jpg${v}`;
}

export function familyImageUrl(familyUuid, version = '') {
    if (!familyUuid) return '';
    const v = version ? `?v=${encodeURIComponent(version)}` : '';
    return `${clean(R2_PUBLIC_BASE)}/families/${familyUuid}.jpg${v}`;
}
