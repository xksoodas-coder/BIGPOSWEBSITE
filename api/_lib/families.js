import { familyImageUrl, familyImageUrlLegacy } from './r2.js';

// Separator used by the mobile app's property tombstone keys
// (product_properties_service.dart `_tombSep`).
const TOMB_SEP = '~@~';

/**
 * Flatten a `turso_families` JSON tree into the flat list the storefront
 * renders, DROPPING any node tombstoned as deleted ('d') in
 * `turso_deleted_properties`.
 *
 * Why: families deleted on a phone are recorded as tombstones, and phones honor
 * them — but the desktop's family sync does a blind union-merge that re-injects
 * its still-present local families back into `turso_families`, and the website
 * historically read `turso_families` verbatim. Net effect: a deleted family kept
 * reappearing on the storefront. Applying the tombstones here makes the
 * storefront immune to that resurrection regardless of who wrote the blob.
 *
 * Tombstone key = `families~@~<root>~@~...~@~<node>` with each name trimmed +
 * lowercased; value = `{ a: 'd'|'a', t: ISO }` ('d' = deleted, latest wins —
 * the stored map already holds the winning state per key).
 *
 * @param {string} familiesJson     json_payload from turso_families
 * @param {string} [tombstonesJson] json_payload from turso_deleted_properties
 * @returns {Array<{id:number,parentId:number|null,name:string,uuid:string,imageVersion:string,imageUrl:string}>}
 */
export function flattenFamilies(storeId, familiesJson, tombstonesJson) {
    let tree = [];
    try { tree = JSON.parse(familiesJson); } catch { tree = []; }
    if (!Array.isArray(tree)) tree = [];

    let tombs = {};
    if (tombstonesJson) {
        try { tombs = JSON.parse(tombstonesJson) || {}; } catch { tombs = {}; }
    }
    const isDeleted = (path) => {
        const key = ['families', ...path.map(n => String(n).trim().toLowerCase())].join(TOMB_SEP);
        const t = tombs[key];
        return !!t && t.a === 'd';
    };

    const families = [];
    let nextId = 1;
    const walk = (nodes, parentId, prefix) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            const name = String(node.name || '').trim();
            const path = [...prefix, name];
            // Skip a deleted node AND its whole subtree.
            if (isDeleted(path)) continue;
            const id = nextId++;
            const uuid = String(node.uuid || '').trim();
            const imageVersion = String(node.imageVersion || '').trim();
            families.push({
                id,
                parentId,
                name,
                uuid,
                imageVersion,
                imageUrl: (uuid && imageVersion) ? familyImageUrl(storeId, uuid, imageVersion) : '',
                imageUrlLegacy: (uuid && imageVersion) ? familyImageUrlLegacy(uuid, imageVersion) : ''
            });
            if (Array.isArray(node.children) && node.children.length > 0) {
                walk(node.children, id, path);
            }
        }
    };
    walk(tree, null, []);
    return families;
}
