import { TimelineRenderer } from '../timeline/renderer.js';
import { projectTime, timeDecimal, toIso, generateTicks } from '../timeline/time-scale.js';
import { escapeHtml as esc } from '../utils/dom.js';
import { resolvePresentation } from '../timeline/presentation.js';
import { formatBandDate } from '../timeline/date-format.js';
import { adaptiveTicks } from '../timeline/adaptive-ticks.js';

const providerPreviews = new WeakMap();
const RESIZE_DELAY = 120;

export function createModelPreview(options) {
  const { provider, generation, isCurrent, container, axis, definition, domain, fromMs, toMs, filters, search } = options;
  const queryOptions = Object.fromEntries(['definitionVersion', 'relationshipMode', 'searchMode', 'searchCaseSensitive', 'searchFields', 'searchFlags', 'searchMatchMode', 'searchDialect'].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
  const presentation = resolvePresentation(definition), band = presentation.bands.primary;
  if (band.axisPosition === 'top') container.before(axis);
  axis.style.color = band.dateColor;
  const previous = providerPreviews.get(provider);
  const controller = new AbortController(), listeners = new Set();
  let queryId = null, map = null, zones = null, layoutId = null, renderer = null;
  let disposed = false, running = false, timer = null, intent = 1, settled = false, disposal = null, task = Promise.resolve();
  let requested = dimensions(), resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  function dimensions() { return { width: Math.max(100, container.clientWidth), height: container.clientHeight }; }
  function check() { if (disposed || !isCurrent(provider, generation)) throw new DOMException('Preview canceled', 'AbortError'); }
  function publish(status) { if (!disposed) for (const listener of listeners) listener(status); }
  async function releaseLayout(id) { if (queryId && id) await provider.releaseLayout(queryId, id).catch(() => {}); }
  async function releaseQuery() { const id = queryId; queryId = null; layoutId = null; if (id) await provider.releaseQuery(id).catch(() => {}); }
  function schedule() {
    if (disposed) return;
    const next = dimensions();
    if (next.width === requested.width && next.height === requested.height) return;
    requested = next; ++intent; clearTimeout(timer);
    container.dataset.previewState = 'resizing';
    timer = setTimeout(pump, RESIZE_DELAY);
  }
  function pump() {
    if (disposed || running) return;
    running = true;
    const requestIntent = intent, { width, height } = requested;
    task = (async () => {
      let candidateId = null;
      try {
        check();
        if (!queryId) {
          await previous?.dispose(); check();
          // Let allocations return their IDs even after Close so they can be released.
          const query = await provider.createQuery({ domain, filters, search, ...queryOptions, scaleMode: definition.scaleMode, ratio: definition.ratio, bins: definition.bins }, { timeout: 10000 });
          queryId = query.queryId; check();
          map = await provider.getMap(queryId, query.mapId, { signal: controller.signal }); check();
          zones = await provider.getZones(queryId, { signal: controller.signal }); check();
        }
        const layout = await provider.createLayout(queryId, { mapId: map.mapId, from: toIso(fromMs), to: toIso(toMs), viewFromMs: fromMs, viewToMs: toMs, width, availableHeight: Math.max(definition.rowHeight, height - 52), rowHeight: definition.rowHeight, fontSize: definition.fontSize, groupBy: definition.groupBy, theme: definition.theme, ...(definition.presentation ? { presentation: definition.presentation } : {}), renderProfileId: 'noto-sans-latin-v1' }, { timeout: 10000 });
        candidateId = layout.layoutId; check();
        const rows = await provider.getRows(queryId, candidateId, { signal: controller.signal }); check();
        if (requestIntent !== intent) return;
        const project = value => { const t = timeDecimal(value); const clamped = t.lt(timeDecimal(domain.from)) ? domain.from : t.gt(timeDecimal(domain.to)) ? domain.to : value; return projectTime(map, clamped, fromMs, toMs, width); };
        const candidates = definition.scaleMode === 'adaptive' ? adaptiveTicks({ map, from: fromMs, to: toMs, width, project, timeZone: definition.timeZone }) : generateTicks(fromMs, toMs, band.intervalUnit, { timeZone: definition.timeZone, maxTicks: 200 });
        if (!candidates.length) candidates.push({ timeMs: fromMs, label: toIso(fromMs) }, { timeMs: toMs, label: toIso(toMs) });
        const measurement = document.createElement('canvas').getContext('2d'); measurement.font = '10px "Noto Sans"';
        const ticks = []; let lastRight = -12;
        for (const tick of candidates) {
          const x = project(tick.timeMs), label = formatBandDate(tick.timeMs, band.dateFormat, definition.timeZone, tick.label), labelWidth = measurement.measureText(label).width;
          const labelLeft = Math.max(0, Math.min(width - labelWidth, x - labelWidth / 2));
          if (x >= 0 && x <= width && labelWidth <= width && labelLeft >= lastRight + 12) { ticks.push({ ...tick, label, labelLeft }); lastRight = labelLeft + labelWidth; }
        }
        renderer ||= new TimelineRenderer(container);
        container.classList.toggle('dark', definition.theme === 'dark');
        renderer.render({ rows, width, height, rowHeight: rows.rowHeight || layout.rowHeight, fontSize: definition.fontSize, project, zones: zones.items, theme: definition.theme, ticks, hasSearch: !!search, interactive: false, presentation: definition.presentation ? presentation : undefined, labelBackgroundAuthored: Object.hasOwn(definition.presentation?.labels || {}, 'backgroundColor') });
        axis.innerHTML = ticks.map(tick => `<span style="left:${tick.labelLeft}px;transform:none">${esc(tick.label)}</span>`).join('');
        const oldLayout = layoutId; layoutId = candidateId; candidateId = null;
        Object.assign(container.dataset, { previewState: 'ready', previewQueryId: queryId, previewMapId: map.mapId, previewFromMs: String(fromMs), previewToMs: String(toMs), previewWidth: String(width), previewHeight: String(height) });
        const unused = Array.isArray(options.sourceIds) ? presentation.sourceStyles.filter(style => !options.sourceIds.includes(style.sourceId)).map(style => style.sourceId) : [];
        const summary = `${rows.loadedCount} of ${layout.detailTotal} records / ${definition.timeZone}${unused.length ? ` / Unused source styles: ${unused.join(', ')}` : ''}`;
        if (!settled) { settled = true; resolveReady(summary); }
        publish({ summary });
        await releaseLayout(oldLayout);
      } catch (error) {
        if (!disposed && error.code === 'row_height_limit' && height < 244) { container.style.minHeight = '246px'; schedule(); return; }
        if (!settled) { settled = true; rejectReady(error); }
        if (!disposed && error.name !== 'AbortError') { container.dataset.previewState = 'error'; publish({ error }); }
        if (!renderer) await releaseQuery();
      } finally {
        await releaseLayout(candidateId);
        running = false;
        if (!disposed && requestIntent !== intent) { clearTimeout(timer); timer = setTimeout(pump, RESIZE_DELAY); }
      }
    })();
  }
  const observer = new ResizeObserver(schedule);
  const handle = {
    ready,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      if (disposal) return disposal;
      disposed = true; ++intent; observer.disconnect(); clearTimeout(timer); controller.abort(); listeners.clear();
      if (!settled) { settled = true; rejectReady(new DOMException('Preview canceled', 'AbortError')); }
      renderer?.dispose(); renderer = null;
      disposal = (async () => { await task; await releaseQuery(); if (providerPreviews.get(provider) === handle) providerPreviews.delete(provider); })();
      return disposal;
    },
  };
  providerPreviews.set(provider, handle);
  container.dataset.previewState = 'loading'; observer.observe(container); pump();
  return handle;
}
