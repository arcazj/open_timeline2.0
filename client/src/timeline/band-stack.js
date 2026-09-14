import { Temporal } from '@js-temporal/polyfill';
import { TimelineRenderer } from './renderer.js';
import { OverviewRenderer } from './overview.js';
import { fixedScaleMap } from './fixed-scale.js';
import { adaptiveTicks } from './adaptive-ticks.js';
import { toMs, toIso, timeDecimal, projectTime, invertPosition } from './time-scale.js';
import { resolvePresentation } from './presentation.js';
import { calendarRange } from '../ui/calendar-time.js';
import { escapeHtml as esc, icon } from '../utils/dom.js';

export class BandStack {
  constructor(host, { select, center, updateIcons, error }) {
    Object.assign(this, { host, select, center, updateIcons, error });
    this.frames = []; this.layouts = []; this.pending = Promise.resolve(); this.key = '';
  }
  configure(presentation) {
    const bands = presentation?.bandLayout, key = JSON.stringify(bands || null);
    if (key === this.key) return;
    this.key = key;
    const previousLayouts = this.layouts; this.layouts = [];
    this.pending = this.pending.catch(() => {}).then(async () => {
      for (const entry of previousLayouts) await entry.provider.releaseLayout(entry.queryId, entry.layoutId).catch(() => {});
    });
    for (const frame of this.frames) { frame.renderer.dispose(); frame.node.remove(); }
    this.frames = [];
    const plot = this.host.querySelector('.plot-wrap'), axis = this.host.querySelector('.main-axis'), overview = this.host.querySelector('.overview-section'), guide = this.host.querySelector('.scale-guide');
    for (const node of [plot, axis, overview, guide]) node.style.removeProperty('grid-row');
    this.host.classList.toggle('reference-bands', !!bands); this.host.style.removeProperty('grid-template-rows');
    overview.hidden = !!bands && !bands.some(b => b.role === 'overview');
    if (!bands) return;
    const tracks = ['var(--reference-guide-height,38px)']; guide.style.gridRow = '1';
    for (const band of bands) {
      const row = tracks.length + 1;
      if (band.role === 'primary') {
        tracks.push(`minmax(75px,${band.height}fr)`, '24px'); plot.style.gridRow = String(row); axis.style.gridRow = String(row + 1);
      } else if (band.role === 'overview') {
        tracks.push(`minmax(55px,${band.height}fr)`); overview.style.gridRow = String(row);
      } else {
        tracks.push(`minmax(${band.role === 'detail' ? 80 : 55}px,${band.height}fr)`);
        const node = document.createElement('section'); node.className = `additional-band ${band.role}-band`; node.dataset.bandId = band.id; node.style.gridRow = String(row); node.setAttribute('aria-label', band.id);
        node.innerHTML = `<div class="band-plot" tabindex="0"></div><div class="axis band-axis"></div><div class="band-pager" hidden><button data-page="previous" title="Previous rows" aria-label="Previous rows">${icon('chevron-up')}</button><output></output><button data-page="next" title="Next rows" aria-label="Next rows">${icon('chevron-down')}</button></div><span class="band-error" role="status"></span>`;
        const surface = node.querySelector('.band-plot'); this.host.append(node);
        const renderer = band.role === 'detail' ? new TimelineRenderer(surface) : new OverviewRenderer(surface);
        const frame = { band, node, surface, renderer }; this.frames.push(frame);
        surface.addEventListener('click', event => {
          const id = event.target.closest('[data-record-id]')?.dataset.recordId;
          if (id) this.select(id);
          else if (frame.map) this.center(invertPosition(frame.map, event.clientX - surface.getBoundingClientRect().left, frame.range.from, frame.range.to, surface.clientWidth));
        });
        node.querySelectorAll('[data-page]').forEach(button => { button.onclick = () => {
          const cursor = frame.rows?.[`${button.dataset.page}Cursor`]; if (!cursor || !frame.provider) return;
          this.pending = this.pending.catch(() => {}).then(async () => {
            const rows = await frame.provider.getRows(frame.query.queryId, frame.layout.layoutId, { cursor });
            if (!frame.current()) return;
            frame.rows = rows; this.paint(frame);
          }).catch(this.error);
        }; });
      }
    }
    this.host.style.gridTemplateRows = tracks.join(' '); this.updateIcons();
  }
  idle() { return this.pending.catch(() => {}); }
  async releaseLayouts(provider, queryId) {
    await this.idle();
    for (const entry of this.layouts.filter(entry => entry.provider === provider && entry.queryId === queryId)) await provider.releaseLayout(queryId, entry.layoutId).catch(() => {});
    this.layouts = this.layouts.filter(entry => entry.provider !== provider || entry.queryId !== queryId);
  }
  refresh(context) {
    const key = this.key;
    this.pending = this.pending.catch(() => {}).then(() => this.load({ ...context, current: () => key === this.key && context.current() }));
    return this.pending;
  }
  async overviewData(context, range, sourceIds) {
    const { provider, filters, search, query } = context;
    const selected = sourceIds?.filter(id => (!filters.sourceIds || filters.sourceIds.includes(id)) && (!filters.sourceId || filters.sourceId === 'all' || filters.sourceId === id));
    if (selected?.length === 0) return { items: [], zones: [] };
    let additional;
    try {
      additional = await provider.createQuery({ domain: range, filters: { ...filters, ...(selected ? { sourceIds: selected } : {}) }, ...search, scaleMode: 'uniform', bins: 64 });
      if (additional.generation !== query.generation || additional.revision !== query.revision) throw new Error('Band data changed. Refresh to show one consistent revision.');
      return { items: (await provider.getOverview(additional.queryId)).items, zones: (await provider.getZones(additional.queryId)).items };
    } finally { if (additional) await provider.releaseQuery(additional.queryId).catch(() => {}); }
  }
  async load(context) {
    const { provider, query, map, presentation, range, settings, filters, search, current } = context;
    if (!current()) return;
    if (context.overview) {
      const result = await this.overviewData(context, context.overview.range, context.overview.sourceIds);
      if (!current()) return;
      context.overview.apply(result);
    }
    this.layouts = this.layouts.filter(entry => entry.provider === provider && entry.queryId === query.queryId);
    for (const frame of this.frames) {
      if (!current()) return;
      const { band, surface } = frame, width = Math.max(100, surface.clientWidth), height = Math.max(32, surface.clientHeight);
      frame.node.querySelector('.band-error').textContent = '';
      Object.assign(frame, { current, provider, query, selectedId: context.selectedId, hasSearch: !!search.search });
      if (band.role === 'detail') {
        frame.map = map; frame.range = range;
        const sourcePresentation = { ...presentation, bandLayout: [{ id: band.id, role: 'primary', height: 100, ...(band.sourceIds ? { sourceIds: band.sourceIds } : {}) }], bands: { ...presentation.bands, primary: { ...presentation.bands?.primary, backgroundColor: band.backgroundColor || '#eeeeee' } } };
        const old = this.layouts.find(entry => entry.frame === frame);
        if (old) { await old.provider.releaseLayout(old.queryId, old.layoutId).catch(() => {}); this.layouts = this.layouts.filter(entry => entry !== old); }
        const layout = await provider.createLayout(query.queryId, { mapId: map.mapId, ...range, width, availableHeight: Math.max(32, height - (presentation.compact ? 48 : 52)), rowHeight: 32, fontSize: 11, groupBy: 'none', presentation: sourcePresentation });
        this.layouts.push({ frame, provider, queryId: query.queryId, layoutId: layout.layoutId });
        frame.layout = layout; frame.rows = await provider.getRows(query.queryId, layout.layoutId, {}); frame.zones = context.zones;
      } else {
        const initial = settings.range, delta = (toMs(range.from) + toMs(range.to) - toMs(initial.from) - toMs(initial.to)) / 2;
        const shifted = calendarRange((toMs(band.range.from) + toMs(band.range.to)) / 2 + delta, toMs(band.range.to) - toMs(band.range.from));
        frame.range = { from: toIso(shifted.fromMs), to: toIso(shifted.toMs) };
        frame.map = fixedScaleMap(frame.range, band.fixedScale || []);
        Object.assign(frame, await this.overviewData(context, frame.range, band.sourceIds));
        frame.presentation = resolvePresentation({ presentation: { ...presentation, bands: { ...presentation.bands, overview: { ...presentation.bands?.overview, backgroundColor: band.backgroundColor || '#dddddd' } } } });
      }
      if (!current()) return;
      this.paint(frame);
    }
  }
  paint(frame) {
    const width = Math.max(100, frame.surface.clientWidth), height = Math.max(32, frame.surface.clientHeight), { range, map } = frame;
    const project = value => projectTime(map, timeDecimal(value).clamp(toMs(map.domain.from), toMs(map.domain.to)).toFixed(), range.from, range.to, width);
    const ticks = adaptiveTicks({ map, from: range.from, to: range.to, width, project, timeZone: 'UTC' });
    if (frame.band.role === 'detail') {
      frame.renderer.render({ rows: frame.rows, width, height, project, zones: frame.zones, ticks, selectedId: frame.selectedId, hasSearch: frame.hasSearch });
      const pager = frame.node.querySelector('.band-pager'); pager.hidden = frame.rows.pageCount <= 1;
      pager.querySelector('output').textContent = `${frame.rows.pageIndex + 1} / ${frame.rows.pageCount}`;
      pager.querySelector('[data-page=previous]').disabled = !frame.rows.previousCursor; pager.querySelector('[data-page=next]').disabled = !frame.rows.nextCursor;
    } else frame.renderer.render({ items: frame.items || [], zones: frame.zones || [], width, height, project, domainEnd: range.to, presentation: frame.presentation, ticks });
    frame.node.querySelector('.band-axis').style.backgroundColor = frame.band.backgroundColor || '';
    frame.node.querySelector('.band-axis').innerHTML = ticks.filter(t => project(t.timeMs) >= 0 && project(t.timeMs) <= width - 50).map(t => `<span style="left:${project(t.timeMs)}px">${esc(t.label)}</span>`).join('');
  }
  relativeAxis(presentation, plot, project, range) {
    plot.querySelector('.relative-axis')?.remove();
    const config = presentation?.bandLayout?.find(band => band.role === 'primary')?.relativeAxis;
    if (!config) return;
    const origin = Temporal.Instant.from(config.origin).toZonedDateTimeISO('UTC'), right = toMs(range.to), left = toMs(range.from);
    const layer = document.createElement('div'); layer.className = 'relative-axis'; layer.setAttribute('aria-label', config.label);
    const years = Temporal.Instant.from(range.from).toZonedDateTimeISO('UTC').year - origin.year;
    const first = Math.max(0, Math.floor(years / config.stepYears) * config.stepYears), labels = [];
    const measure = document.createElement('canvas').getContext('2d'); measure.font = '11px "Noto Sans"';
    let lastRight = -Infinity;
    for (let age = first, count = 0; count < 200; age += config.stepYears, count++) {
      const date = origin.add({ years: age }); if (date.year > 9999) break;
      const time = date.epochMilliseconds; if (time > right) break;
      const x = project(time), text = `${age} ${config.label}`, width = measure.measureText(text).width;
      if (time >= left && x >= lastRight + 8 && x + width <= plot.clientWidth - 4) {
        labels.push(`<span style="left:${x}px">${esc(text)}</span>`); lastRight = x + width;
      }
    }
    layer.innerHTML = labels.join(''); plot.append(layer);
  }
}
