export function clipPreviewInterval(start, end, width, offset = 0) {
  if (![start, end, width, offset].every(Number.isFinite) || width <= 0 || end <= start) return { left: 0, width: 0, visible: false };
  const left = Math.max(start, -offset - width), right = Math.min(end, -offset + width * 2);
  return right > left ? { left, width: right - left, visible: true } : { left: 0, width: 0, visible: false };
}

export function previewTabIndex(start, end, width, offset = 0) {
  return [start, end, width, offset].every(Number.isFinite) && width > 0 && end > start
    && end + offset > 0 && start + offset < width ? 0 : -1;
}

function previewChildKey(node) {
  if (!node.matches?.('.record-label') || !node.hasAttribute('tabindex')) return node.outerHTML;
  const copy = node.cloneNode(true); copy.removeAttribute('tabindex'); return copy.outerHTML;
}

export function reconcilePreviewChildren(parent, proposed) {
  const buckets = new Map();
  for (const node of parent.children) {
    const key = previewChildKey(node), nodes = buckets.get(key) || []; nodes.push(node); buckets.set(key, nodes);
  }
  const desired = proposed.map(node => buckets.get(previewChildKey(node))?.shift() || node), retained = new Set(desired);
  for (const node of [...parent.children]) if (!retained.has(node)) parent.removeChild(node);
  let cursor = parent.firstChild;
  for (const node of desired) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
}
