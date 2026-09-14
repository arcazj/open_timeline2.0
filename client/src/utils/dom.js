export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function icon(name) { return `<i data-lucide="${name}" aria-hidden="true"></i>`; }
export function button(action, name, label, text = false, extra = '') {
  return `<button type="button" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" ${extra}>${icon(name)}${text ? `<span>${escapeHtml(label)}</span>` : ''}</button>`;
}
export function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function dateLabel(value, detailed = false, timeZone = 'UTC') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', { timeZone, ...(detailed ? { year: 'numeric', month: 'short', day: '2-digit', ...(date.getUTCFullYear() <= 0 ? { era: 'short' } : {}) } : {}), hour: '2-digit', minute: '2-digit', ...(detailed ? { second: '2-digit' } : {}), hourCycle: 'h23' }).format(date);
}
export function dateInput(value) { return value ? new Date(value).toISOString().replace(/Z$/, '') : ''; }
export function setDateInput(input, value, reference = value) {
  input.type = reference && new Date(reference).getUTCFullYear() <= 0 ? 'text' : 'datetime-local';
  input.value = dateInput(value);
}
export function inputIso(value) {
  if (!value) return null;
  const parsed = new Date(value.endsWith('Z') ? value : `${value}Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Enter a valid UTC date and time.');
  return parsed.toISOString();
}
