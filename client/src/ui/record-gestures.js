import { pointerRecordTime } from './record-time-edit.js';
import { createElement, icons } from 'lucide';
import '../styles/record-gestures.css';

export function createRecordGestures(host) {
  const plot = host.plot, layer = document.createElement('div'); layer.className = 'record-edit-layer'; plot.append(layer);
  const abort = new AbortController(), options = { signal: abort.signal, capture: true };
  let drag = null, mode = 'navigate';
  const valid = frozen => { const now = host.context(); return now.ready && now.provider === frozen.provider && now.generation === frozen.generation && now.layoutId === frozen.layoutId && now.rows === frozen.rows && now.map === frozen.map && now.fromMs === frozen.fromMs && now.toMs === frozen.toMs && now.width === frozen.width; };
  function cancel() { const prior = drag; drag = null; layer.querySelector('.record-time-ghost')?.remove(); plot.classList.remove('record-dragging'); host.preview(null); if (prior && plot.hasPointerCapture?.(prior.pointer)) plot.releasePointerCapture(prior.pointer); }
  function geometry(item, context) {
    const y = (context.paddingTop ?? 52) + (item.row - context.startRow) * context.rowHeight;
    return { rowTop: y, labelBottom: y + (item.labelOffsetY || 0) + (item.labelLines ? item.labelLines.length * item.labelLineHeight : context.fontSize + 7), top: y + (item.geometryOffsetY ?? (item.record.kind === 'event' || item.record.end === item.record.start ? context.fontSize / 2 + 3.5 : context.fontSize + 12)), height: item.style?.barHeight || 8 };
  }
  function render() {
    if (drag && !valid(drag.context)) cancel();
    layer.querySelectorAll('.record-time-handle').forEach(node => node.remove());
    plot.classList.toggle('record-edit-mode', mode === 'edit');
    const context = host.context();
    if (mode !== 'edit' || !context.ready || !context.selectedId) return;
    const item = context.items.find(entry => entry.record?.id === context.selectedId);
    if (!item || !host.canEdit(item.record) || item.record.kind !== 'session' || item.record.end === null || item.record.end === item.record.start || item.xEnd - item.xStart < 40) return;
    const { top, rowTop, labelBottom } = geometry(item, context), handleTop = Math.max(top - 6, labelBottom);
    if (handleTop + 12 > rowTop + context.rowHeight) return;
    for (const [operation, x] of [['start', item.xStart], ['end', item.xEnd]]) {
      if (x < 10 || x > context.width - 10) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'record-time-handle'; button.dataset.recordId = item.record.id; button.dataset.timeOperation = operation;
      button.setAttribute('aria-label', `Resize session ${operation}`); button.title = `Resize ${operation}; Enter opens precise time controls`;
      button.style.left = `${x - 9}px`; button.style.top = `${handleTop}px`; button.append(createElement(icons.GripVertical, { width: 10, height: 10, 'aria-hidden': 'true' }));
      layer.append(button);
    }
  }
  plot.addEventListener('pointerdown', event => {
    if (mode !== 'edit' || event.button !== 0 || !event.isPrimary) return;
    const target = event.target.closest('[data-record-id]'); if (!target) return;
    const context = host.context(), item = context.items.find(entry => entry.record?.id === target.dataset.recordId);
    if (!context.ready || !item) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!host.canEdit(item.record)) { host.select(item.record.id); host.message('This record is read-only on the current source.'); return; }
    const box = plot.getBoundingClientRect();
    drag = { context, item, record: structuredClone(item.record), operation: target.dataset.timeOperation || 'move', pointer: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, grabX: event.clientX - box.left, left: box.left, moved: false, proposal: null, error: null };
    plot.setPointerCapture(event.pointerId);
  }, options);
  plot.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!valid(drag.context)) { cancel(); return; }
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= (drag.pointerType === 'touch' ? 8 : 4)) drag.moved = true;
    if (!drag.moved) return;
    plot.classList.add('record-dragging');
    try {
      drag.proposal = pointerRecordTime(drag.record, drag.operation, drag.context, drag.grabX, event.clientX - drag.left); drag.error = null;
      const start = host.project(drag.proposal.payload.start), end = drag.proposal.payload.end === null ? drag.record.kind === 'event' ? start : drag.item.xEnd : host.project(drag.proposal.payload.end);
      let ghost = layer.querySelector('.record-time-ghost'); if (!ghost) { ghost = document.createElement('div'); ghost.className = 'record-time-ghost'; layer.append(ghost); }
      const { top, height } = geometry(drag.item, drag.context), left = Math.max(0, Math.min(drag.context.width, start)), right = Math.max(left, Math.min(drag.context.width, end));
      Object.assign(ghost.style, { left: `${left}px`, width: `${Math.max(4, right - left)}px`, top: `${top - Math.max(8, height) / 2 - 3}px`, height: `${Math.max(8, height) + 6}px` });
      host.preview({ record: drag.record, operation: drag.operation, ...drag.proposal });
    } catch (error) { drag.error = error; drag.proposal = null; host.preview({ record: drag.record, error: error.message }); layer.querySelector('.record-time-ghost')?.remove(); }
  }, options);
  plot.addEventListener('pointerup', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const completed = drag, current = valid(drag.context); cancel();
    if (!current) return;
    if (!completed.moved) { host.select(completed.record.id); return; }
    if (completed.error) { host.message(completed.error.message); return; }
    if (completed.proposal?.changed) host.commit(completed.record, completed.proposal.payload, completed.context).catch(error => host.message(error.message));
  }, options);
  for (const type of ['pointercancel', 'lostpointercapture']) plot.addEventListener(type, cancel, options);
  window.addEventListener('blur', cancel, { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); }, { signal: abort.signal });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); } }, options);
  plot.addEventListener('keydown', event => {
    if (mode !== 'edit') return;
    const target = event.target.closest('[data-record-id]');
    if (target && (event.key === 'Enter' && event.target.dataset.timeOperation || event.key.toLowerCase() === 'e')) {
      event.preventDefault(); event.stopImmediatePropagation(); host.precise(target.dataset.recordId, event.target.dataset.timeOperation || 'move');
    }
  }, options);
  return { render, cancel, setMode(value) { cancel(); mode = value; render(); }, get mode() { return mode; }, get active() { return !!drag; }, dispose() { cancel(); abort.abort(); layer.remove(); } };
}
