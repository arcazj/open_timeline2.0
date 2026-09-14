import { escapeHtml } from '../utils/dom.js';
export function zoneLabels(zones, project, width, top = 5) {
  return zones.map((zone, index) => {
    const start = Math.max(0, project(zone.start)), end = Math.min(width, project(zone.end));
    if (end <= start) return '';
    const labelX = Math.min(start + 5, Math.max(0, width - 180));
    return `<span class="zone-label" style="left:${labelX}px;top:${top + (index % 2) * 20}px;max-width:${Math.max(0, width - labelX - 5)}px" title="${escapeHtml(zone.title)}">${escapeHtml(zone.title)}</span>`;
  }).join('');
}
