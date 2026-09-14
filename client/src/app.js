import './styles/app.css';
import './styles/font-variants.css';
import './styles/font-extended.css';
import './styles/models.css';
import './styles/table.css';
import './styles/filters.css';
import './styles/change-monitor.css';
import './styles/navigation.css';
import './styles/legacy.css';
import './styles/source-paths.css';
import './styles/scaling.css';
import './styles/help.css';
import './styles/calendar.css';
import './styles/test-data.css';
import { createIcons, icons } from 'lucide';
import Decimal from 'decimal.js';
import { createLocalProvider } from './data/worker-provider.js';
import { ServerProvider } from './data/server-provider.js';
import { bufferedWindow, createWindowLoader, startupTarget } from './data/window-loading.js';
import { legacyViewport } from './data/legacy-presentation.js';
import { discoverStartupCatalog, startupMessage } from './data/startup-discovery.js';
import { LOCAL_LIMITS } from './data/snapshot.js';
import { projectTime, invertPosition, panRange, zoomRange, overviewBodyDrag, overviewResize, generateTicks, toIso, toMs, timeDecimal } from './timeline/time-scale.js';
import { TimelineRenderer } from './timeline/renderer.js';
import { OverviewRenderer } from './timeline/overview.js';
import { createNavigationMotion } from './timeline/navigation-motion.js';
import { createNavigationLayoutCache } from './timeline/navigation-layout-cache.js';
import { navigatePan, navigateZoom, followingOverview, rangeInside, createPanProjector, navigationMap } from './timeline/navigation-domain.js';
import { openTimelineCalendar } from './ui/timeline-calendar.js';
import { calendarRange, centerCalendarRange } from './ui/calendar-time.js';
import { loadPathPreferences, savePathPreferences, groupingMode, groupedPresentation } from './ui/source-paths.js';
import { openModelManager } from './ui/model-manager.js';
import { createModelPreview } from './ui/model-preview.js';
import { RecordTableView } from './ui/record-table-view.js';
import { compileExpression, compileSearch } from './data/filter-expression.js';
import { resolvePresentation, readField } from './timeline/presentation.js';
import { formatBandDate } from './timeline/date-format.js';
import { adaptiveTicks } from './timeline/adaptive-ticks.js';
import { minorTicks } from './timeline/minor-ticks.js';
import { prepareScaledQuery } from './timeline/optimize-scale.js';
import { fixedScaleMap } from './timeline/fixed-scale.js';
import { BandStack } from './timeline/band-stack.js';
import { FilterEditor } from './ui/filter-editor.js';
import { createRecordRecovery } from './ui/record-recovery.js';
import { openConfigurationManager } from './ui/configuration-manager.js';
import { resetTransientSettings, exportWithPersonalPreferences } from './ui/view-settings.js';
import { filterFieldTypes } from './data/configuration-catalog.js';
import { createRecordGestures } from './ui/record-gestures.js';
import { createChangeMonitor } from './ui/change-monitor.js';
import { openRecordTimeDialog } from './ui/record-time-dialog.js';
import { openHelpPanel } from './ui/help-panel.js';
import { validateSharedView } from './ui/shared-view.js';
import { sourceCanEdit, parentTimeWarning } from './ui/record-time-edit.js';
import { DEFAULTS, TITLE, UNITS } from './config.js';
import { escapeHtml as esc, icon, button, dateLabel as formatDateLabel, dateInput, setDateInput, inputIso, downloadJson } from './utils/dom.js';

const app = document.getElementById('app');
const initialSnapshot = JSON.parse(document.getElementById('timeline-data').textContent);
const testDatasets = JSON.parse(document.getElementById('test-datasets')?.textContent || '[]');
const state = {
  provider: null, info: null, snapshot: initialSnapshot, query: null, map: null, layout: null, rows: null,
  overview: null, zones: [], selected: null, view: 'timeline', filter: { sourceId: 'all', kind: 'all' },
  search: '', searchMode: 'any', searchCaseSensitive: false, searchFields: undefined, presentation: undefined,
  ...DEFAULTS, fromMs: null, toMs: null, domain: null, dirty: false, preferencesDirty: false,
  stale: false, loading: false, sort: 'start', sortDirection: 1, epoch: 0, pendingServer: null,
  transient: {}, fieldTypes: filterFieldTypes({ schemas: [] }),
  scaleStrategy: 'automatic',
};
let timeline, overviewRenderer, resizeTimer, searchTimer, toastTimer, dialogOpener, lastWidth = 0, lastHeight = 0;
let bandStack;
let layoutIntent = 0, layoutQueue = Promise.resolve(), queryQueue = Promise.resolve(), sourceIntent = 0, importIntent = 0, selectionIntent = 0;
let localBranch = null, fallbackActive = false;
let modelManager = null;
let recordRecovery = null;
let configurationManager = null;
let recordGestures, editSources = new Map(), editActor = null, editMetadataKey = '', editMetadataIntent = 0, timeModeIntent = 0;
let tableView;
let unsubscribeSource;
let changeMonitor, timeCommitPending = 0, navigationActive = false;
let navigation;
let calendar = null, calendarOpener = null;
let displayedTimeUnit = null;
let bootPending = true;
let pathCatalog = null, pathPreferences = null;
let startupDiscovery;
let configuredServer = false, windowLoader, loadingTimer, overviewRequest, overviewTimer;
const bootControls = new Map();
const legacyControls = new Map();
const $ = selector => document.querySelector(selector);
const legacyReadOnly = () => !!(state.info?.legacy || state.info?.origin?.legacy)?.readOnly;
const updateIcons = () => {
  createIcons({ icons, attrs: { 'stroke-width': 1.7 } });
  // Do not replace an existing SVG while a pointer is pressed over its button.
  for (const node of document.querySelectorAll('svg[data-lucide]')) node.removeAttribute('data-lucide');
  recordRecovery?.refreshControls();
  for (const [node, previous] of legacyControls) if (!node.isConnected || !legacyReadOnly()) { if (node.isConnected) node.disabled = previous; legacyControls.delete(node); }
  if (legacyReadOnly()) for (const node of document.querySelectorAll('[data-action="create"],[data-action="edit"],[data-action="duplicate"],[data-action="delete"],#new-command')) {
    if (!legacyControls.has(node)) legacyControls.set(node, node.disabled);
    node.disabled = true;
  }
};
const decimal = value => new Decimal(String(value));
const rangeIso = () => ({ from: toIso(state.fromMs), to: toIso(state.toMs) });
const isLocal = () => !(state.provider instanceof ServerProvider);
const dateLabel = (value, detailed = false) => formatDateLabel(value, detailed, state.timeZone || 'UTC');
const searchOptions = () => ({ search: state.search, searchMode: state.searchMode, searchCaseSensitive: state.searchCaseSensitive, ...(state.searchFields ? { searchFields: state.searchFields } : {}) });
const presentationOptions = () => ({ theme: state.theme, displayUnit: state.unit, ...(state.presentation ? { presentation: state.presentation } : {}) });
const searchSettings = () => ({ text: state.search, mode: state.searchMode, caseSensitive: state.searchCaseSensitive, fields: state.searchFields || ['/title'] });
function rememberSetting(key, value) { state.transient[key] = structuredClone(value); state.preferencesDirty = true; }
async function settingsRegistry(provider, info, settings) {
  if (!settings.filterId) return filterFieldTypes({ schemas: [] });
  const response = await provider.getConfiguration('filters', settings.filterId);
  if (response.generation !== info.generation) throw new Error('Configuration belongs to another workspace generation.');
  const definition = response.resource.versions.find(version => version.version === settings.filterVersion)?.definition;
  if (!definition) throw new Error('The selected saved filter version is unavailable.');
  const schemas = [];
  for (const pin of definition.schemaRefs) {
    const schema = await provider.getConfiguration('schemas', pin.id);
    if (schema.generation !== info.generation) throw new Error('Data schema belongs to another workspace generation.');
    schemas.push(schema.resource);
  }
  return filterFieldTypes({ schemas }, definition.schemaRefs);
}
function adoptSettings(settings, { preserveRange = false, preserveOverview = false } = {}) {
  Object.assign(state, { unit: settings.displayUnit || 'HOUR', theme: settings.theme || 'light', rowHeight: settings.rowHeight || 32,
    fontSize: settings.fontSize || 13, groupBy: settings.groupBy || 'none', timeZone: settings.timeZone || 'UTC',
    scaleMode: settings.scaleMode || 'uniform', ratio: settings.ratio ?? 4, bins: settings.bins ?? 128 });
  state.presentation = structuredClone(settings.presentation);
  bandStack?.configure(state.presentation);
  $('.timeline-view').style.setProperty('--reference-guide-height', `${settings.scaleMode === 'adaptive' || referenceScale().fixedScale?.length ? 65 : 38}px`);
  if (!preserveOverview || !state.domain) state.domain = structuredClone(settings.overview || initialSnapshot.settings.overview);
  if (!preserveRange || state.fromMs === null) { const range = settings.range || initialSnapshot.settings.range; state.fromMs = String(toMs(range.from)); state.toMs = String(toMs(range.to)); }
  state.filter = { ...state.filter, filterId: settings.filterId ?? null, filterVersion: settings.filterVersion ?? null };
  delete state.filter.schemaRefs;
  const search = settings.search || { text: '', mode: 'any', caseSensitive: false, fields: ['/title'] };
  Object.assign(state, { search: search.text, searchMode: search.mode, searchCaseSensitive: search.caseSensitive, searchFields: structuredClone(search.fields) });
  $('#search').value = state.search; app.classList.toggle('dark', state.theme === 'dark');
  tableView.configure({ columns: settings.columns, sort: settings.sort });
  setView(settings.mode || 'timeline', { transient: false, refresh: false });
}
function adoptLegacyView({ focus = true } = {}) {
  const legacy = state.info?.legacy || state.info?.origin?.legacy;
  const hints = legacy?.viewHints, view = $('.timeline-view');
  view.classList.remove('legacy-proportions');
  view.style.removeProperty('--legacy-overview-height');
  if (!hints) return;
  try {
    const fraction = hints.bands.overview.heightFraction;
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) throw new Error('Invalid legacy band proportions');
    const width = Math.max(64, Math.min(8192, $('.plot-wrap').clientWidth));
    let ranges = legacyViewport(hints, width, Date.now(), state.timeZone);
    if (state.provider?.localBrowser && legacy.domain && (toMs(ranges.primary.to) <= toMs(legacy.domain.from) || toMs(ranges.primary.from) >= toMs(legacy.domain.to))) {
      const center = toMs(ranges.primary.to) <= toMs(legacy.domain.from) ? legacy.domain.from : legacy.domain.to;
      ranges = legacyViewport({ ...hints, focus: { mode: 'fixed', timestamp: center } }, width, Date.now(), state.timeZone);
    }
    view.style.setProperty('--legacy-overview-height', `${fraction * 100}%`);
    view.classList.add('legacy-proportions');
    if (focus && !legacy.declaredRange && !legacy.loading?.initialRange) {
      state.domain = ranges.overview;
      state.fromMs = String(toMs(ranges.primary.from)); state.toMs = String(toMs(ranges.primary.to));
    }
  } catch (error) { toast(`Legacy view settings were not applied: ${error.message}`); }
}
function noticeAction(action) {
  const node = $('.notice [data-action]'), label = action === 'sources' ? 'Choose source' : 'Retry';
  node.dataset.action = action; node.title = label; node.setAttribute('aria-label', label);
  node.innerHTML = `${icon(action === 'sources' ? 'database' : 'rotate-cw')}<span>${label}</span>`;
  updateIcons();
}
function watchSource(provider) {
  unsubscribeSource?.();
  changeMonitor.stop();
  if (provider instanceof ServerProvider) {
    if (state.info.capabilities?.changeFeed !== false) changeMonitor.start(provider, state.info);
    return;
  }
  unsubscribeSource = provider.subscribeChanges?.(event => {
    if (provider !== state.provider || event.type !== 'worker-lost') return;
    ++state.epoch; ++layoutIntent; state.localUnavailable = true; state.stale = true; state.queryLoading = false; setBusy(false); resetTimeMode();
    for (const id of ['search', 'source-filter', 'kind-filter', 'auto-scale']) $(`#${id}`).disabled = true;
    $('.plot-wrap').dispatchEvent(new Event('pointercancel')); $('.overview-plot').dispatchEvent(new Event('pointercancel'));
    tableView.suspend();
    configurationManager?.suspend();
    $('.notice span').textContent = 'The Local worker stopped. Displayed records are stale; unsaved changes may be lost. Open a complete JSON snapshot or connect to another source. No writes were replayed.';
    $('.notice').hidden = false; noticeAction('sources');
    updateStatus(); toast('Local source unavailable. Keep any open drafts until their contents are recovered.');
  });
}
function changeRefreshBlocked() {
  return bootPending || state.authRequired || state.localUnavailable || state.queryLoading || state.loading || state.searchPending || tableView?.pending || tableView?.exporting
    || navigationActive || navigation?.active || timeCommitPending > 0 || recordGestures?.active || !!recordRecovery?.pending().length
    || !!calendar || !!$('.modal-backdrop') || modelManager?.isOpen() || configurationManager?.isOpen();
}
function renderChanges(status) {
  const band = $('.change-monitor'); if (!band) return;
  band.hidden = !status.active; band.dataset.pending = String(status.pending || !!status.required);
  for (const node of band.querySelectorAll('[data-change-mode]')) { node.setAttribute('aria-pressed', String(node.dataset.changeMode === status.mode)); node.disabled = !!status.required || state.authRequired; }
  const summary = band.querySelector('.change-summary');
  summary.textContent = status.required === 'authorization-lost' ? 'Authorization required'
    : status.required === 'generation-changed' ? 'Workspace restored. Reload required'
      : status.required === 'replay-gap' ? 'Change history expired. Reload required'
        : status.required ? 'Refresh required' : status.inFlight ? 'Refreshing committed changes'
          : status.pending ? `Committed changes available / revision ${status.latest}` : `${status.mode === 'live' ? 'Live' : 'Pinned'} / revision ${status.baseline}`;
  summary.title = summary.textContent;
  band.querySelector('.change-reload').disabled = status.inFlight || state.authRequired;
}
async function reloadCommittedSource({ provider }) {
  const intent = sourceIntent, previousQuery = state.query;
  const current = () => provider === state.provider && intent === sourceIntent && !state.authRequired;
  const info = await provider.getStatus(); if (!current()) return null;
  const generationChanged = info.generation !== state.info.generation, restart = generationChanged || !!state.generationRequired;
  state.info = info; state.generationRequired = false;
  if (generationChanged) { state.selected = null; resetTimeMode(); renderDescriptor(); activateRecordRecovery(); }
  await refreshQuery();
  if (!current() || state.query === previousQuery) { if (current() && restart) state.generationRequired = true; return null; }
  if (state.selected) {
    const previousSelection = state.selected, selection = selectionIntent;
    const selectionCurrent = () => current() && selection === selectionIntent && state.selected === previousSelection && !state.localUnavailable;
    try { const selected = await provider.getRecord(previousSelection.id); if (selectionCurrent()) state.selected = selected; }
    catch (error) { if (error.status === 404) { if (selectionCurrent()) state.selected = null; } else if (current()) throw error; }
    if (current()) { renderDescriptor(); render(); }
  }
  if (!current()) return null;
  if (restart && info.capabilities?.changeFeed !== false) changeMonitor.start(provider, info);
  changeMonitor.acknowledge(state.query);
  return state.query;
}
function activateRecordRecovery() {
  recordRecovery?.dispose();
  const provider = state.provider, generation = state.info.generation;
  const current = () => state.provider === provider && state.info?.generation === generation && !state.authRequired && !state.generationRequired && !state.localUnavailable;
  recordRecovery = createRecordRecovery({
    provider, generation, local: isLocal(), logicalKey: provider.identity, anchor: $('.filter-strip'),
    isCurrent: current, openDialog, formError, updateIcons, onAuthorizationError: showError,
    onConfirmed: async (command, result) => {
      const info = await provider.getStatus();
      if (!current()) return;
      state.info = info;
      if (info.generation !== generation) { state.selected = null; activateRecordRecovery(); }
      else if (state.selected?.id === result.record.id) state.selected = command.type === 'delete' ? null : result.record;
      if (result.durability === 'memory-only') state.dirty = true;
      await refreshQuery();
      if (state.provider === provider && state.info.generation === info.generation) renderDescriptor();
    },
  });
  recordRecovery.refresh();
}

function timeEditContext() {
  const plot = $('.plot-wrap'), rowHeight = state.rows?.rowHeight || state.layout?.rowHeight || state.rowHeight;
  const paddingTop = state.presentation?.compact ? state.presentation.bandLayout?.some(b => b.relativeAxis) ? 28 : 4 : 52;
  const capacity = Math.min(100, Math.floor(Math.max(rowHeight, (plot?.clientHeight || 0) - paddingTop - (state.presentation?.compact ? 44 : 0)) / rowHeight));
  return { provider: state.provider, generation: state.info?.generation, sourceIntent, principalId: state.info?.actor?.id, sourceName: state.info?.sourceName || 'Timeline source', recovery: recordRecovery,
    ready: !!state.layout && !!state.map && Math.abs(state.layout.width - (plot?.clientWidth || 0)) < 1 && state.layout.pageCapacity === capacity && !state.queryLoading && !state.loading && !navigation?.active && !state.authRequired && !state.generationRequired && !state.localUnavailable && !recordRecovery?.pending().length,
    layoutId: state.layout?.layoutId, map: state.map, fromMs: state.fromMs, toMs: state.toMs, width: state.layout?.width, paddingTop,
    rows: state.rows, items: state.rows?.items || [], startRow: state.rows?.startRow || 0, rowHeight: state.rows?.rowHeight || state.layout?.rowHeight || state.rowHeight, fontSize: state.fontSize, selectedId: state.selected?.id };
}
const currentTimeSource = context => context.provider === state.provider && context.sourceIntent === sourceIntent && context.generation === state.info?.generation && context.principalId === state.info?.actor?.id && !state.authRequired && !state.generationRequired && !state.localUnavailable;
const canEditTime = record => timeEditContext().ready && sourceCanEdit(editActor, editSources.get(record.sourceId));
function resetTimeMode() {
  ++timeModeIntent; ++editMetadataIntent; editMetadataKey = ''; editSources.clear(); editActor = null; recordGestures?.setMode('navigate'); updateTimeControls();
  $('.plot-wrap')?.dispatchEvent(new Event('pointercancel'));
}
function updateTimeControls() {
  if (!recordGestures) return;
  const allowed = state.info?.capabilities?.recordCrud && ((editActor || state.info.actor)?.capabilities || []).some(value => value === '*' || value === 'records.edit');
  for (const node of document.querySelectorAll('[data-time-mode]')) {
    node.setAttribute('aria-pressed', node.dataset.timeMode === recordGestures.mode);
    node.disabled = !state.info || state.authRequired || state.localUnavailable || node.dataset.timeMode === 'edit' && (!allowed || !!recordRecovery?.pending().length);
  }
  for (const node of document.querySelectorAll('[data-action=time-edit],[data-action=close-session]')) node.disabled = !state.selected || !canEditTime(state.selected);
  recordGestures.render();
}
async function refreshTimePermissions(force = false) {
  if (!state.info || state.authRequired || state.localUnavailable) return;
  const context = timeEditContext(), ids = [...new Set([...context.items.map(item => item.record?.sourceId), state.selected?.sourceId].filter(Boolean))].sort();
  const key = JSON.stringify([state.info.generation, state.info.revision, state.info.actor?.id, ids]);
  if (!force && editMetadataKey === key) return;
  const intent = ++editMetadataIntent; editMetadataKey = key; editSources.clear(); editActor = null; updateTimeControls();
  try {
    const metadata = await context.provider.getStatus();
    const sources = [];
    for (const id of ids) { const response = await context.provider.getConfiguration('sources', id); if (!currentTimeSource(context) || intent !== editMetadataIntent) return; if (response.generation !== context.generation) throw new Error('The source generation changed. Refresh before editing records.'); sources.push(response.resource); }
    if (!currentTimeSource(context) || intent !== editMetadataIntent) return;
    if (metadata.generation !== context.generation) throw new Error('The source generation changed. Refresh before editing records.');
    editActor = metadata.actor; editSources = new Map(sources.map(source => [source.id, source])); updateTimeControls();
  } catch (error) { if (currentTimeSource(context) && intent === editMetadataIntent) { editMetadataKey = ''; toast(error.message); if ([401, 403].includes(error.status)) clearUnauthorized(); } }
}
async function setTimeMode(mode) {
  const intent = ++timeModeIntent;
  if (mode === 'edit') { await refreshTimePermissions(true); if (intent !== timeModeIntent) return; if (!editSources.size || !editActor || ![...editSources.values()].some(source => sourceCanEdit(editActor, source))) { toast('No authorized writable sources are available for time editing.'); return; } }
  $('.plot-wrap').dispatchEvent(new Event('pointercancel')); recordGestures.setMode(mode); updateTimeControls();
}
async function commitRecordTime(record, payload, context) {
  timeCommitPending++;
  try { return await performRecordTimeCommit(record, payload, context); }
  finally { timeCommitPending--; }
}
async function performRecordTimeCommit(record, payload, context) {
  if (!currentTimeSource(context)) throw new Error('This time draft belongs to a previous source or generation. No write was sent.');
  if (context.recovery.pending().length) throw new Error('Resolve the original record write outcome before another time change.');
  let metadata, source;
  try { metadata = await context.provider.getStatus(); source = await context.provider.getConfiguration('sources', record.sourceId); }
  catch (error) { if (currentTimeSource(context) && [401, 403].includes(error.status)) clearUnauthorized(); throw error; }
  if (!currentTimeSource(context) || metadata.generation !== context.generation || source.generation !== context.generation) throw new Error('The source changed while checking this time draft. No write was sent.');
  if (context.isDraftOpen && !context.isDraftOpen()) throw new Error('Time draft closed before dispatch. No write was sent.');
  if (!sourceCanEdit(metadata.actor, source.resource)) throw new Error('The current actor or source does not permit this record time change.');
  const command = { type: 'update', recordId: record.id, expectedVersion: record.version, generation: context.generation, clientCommandId: crypto.randomUUID(), payload };
  let result;
  try { result = await context.recovery.execute(command); } catch (error) { if (error.code === 'write_outcome_unknown') error.commandId = command.clientCommandId; throw error; }
  if (!currentTimeSource(context)) { toast('Time change confirmed on the original source. Current source unchanged.'); return result; }
  state.dirty ||= result.durability === 'memory-only'; state.info = { ...state.info, revision: result.revision }; state.selected = result.record;
  try { await refreshQuery(); if (currentTimeSource(context)) { renderDescriptor(); toast(result.durability === 'memory-only' ? 'Time changed in memory. JSON export pending.' : 'Record time saved.'); } }
  catch (error) { toast(`Time change confirmed. Follow-up refresh failed: ${error.message}. Do not submit it again.`); }
  return result;
}
function openTimeEditor(record = state.selected, operation = 'move', proposed = null, error = null, context = timeEditContext()) {
  if (!record) return;
  openRecordTimeDialog({ openDialog, closeDialog, formError, updateIcons, current: currentTimeSource, recovery: context.recovery, commit: commitRecordTime }, record, context, { operation, proposed, error });
}

function finishBoot() {
  bootPending = false;
  app.removeAttribute('aria-busy');
  for (const [control, disabled] of bootControls) control.disabled = disabled;
  bootControls.clear();
  $('.provider-status')?.removeAttribute('role');
}
function shell() {
  app.innerHTML = `<header class="app-header"><div class="header-tools">${button('sources', 'power', 'Sources and connection')}${button('range', 'calendar-days', 'Date and time range')}${button('refresh', 'rotate-cw', 'Refresh source')}${button('filters', 'filter', 'Filters')}<input id="search" type="search" aria-label="Search events and sessions" placeholder="Search events and sessions"></div><h1 class="brand">${TITLE}</h1><div class="header-right"><div class="view-tabs" aria-label="Views">${['timeline', 'table', 'split'].map(v => `<button data-view="${v}" aria-pressed="${v === state.view}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>${button('models', 'panels-top-left', 'Model library', false, 'class="desktop-tool"')}${button('create', 'plus', 'Create record', false, 'class="desktop-tool"')}${button('sources', 'database', 'Sources', false, 'class="desktop-tool"')}${button('settings', 'settings', 'Settings', false, 'class="mobile-settings"')}</div></header>
  <div class="filter-strip"><select class="source-filter" id="source-filter" aria-label="Source filter"><option value="all">All sources</option></select><select class="kind-filter" id="kind-filter" aria-label="Record type"><option value="all">All types</option><option value="event">Events</option><option value="session">Sessions</option></select><button class="range-button" data-action="range"></button><div class="tools">${button('zoom-out', 'minus', 'Zoom out')}${button('zoom-in', 'plus', 'Zoom in')}${button('fit', 'scan', 'Fit', true)}${button('now', 'clock-3', 'Now', true)}</div><label class="auto-label"><input id="auto-scale" type="checkbox" checked>Auto scale</label><span class="provider-status"></span></div>
  <div class="notice" hidden><span></span>${button('refresh', 'rotate-cw', 'Retry', true)}</div>
  <div class="server-startup" hidden><span role="status"></span><button type="button" title="Retry server connection" aria-label="Retry server connection">${icon('rotate-cw')}</button></div>
  <div class="change-monitor" hidden data-pending="false"><div class="change-modes" role="group" aria-label="Committed update mode"><button type="button" data-change-mode="pinned" aria-pressed="true">Pinned</button><button type="button" data-change-mode="live" aria-pressed="false">Live</button></div><span class="change-summary" role="status" aria-live="polite"></span><button type="button" class="change-reload" data-action="reload-changes" aria-label="Reload committed changes" title="Reload committed changes">${icon('rotate-cw')}</button></div>
  <div class="workspace"><div class="primary"><section class="timeline-view" aria-label="Timeline"><div class="scale-guide"><span class="scale-cue"></span><span class="scale-window"></span></div><div class="plot-wrap" tabindex="0" role="region" aria-label="Timeline records. Arrow keys pan; plus and minus zoom."></div><div class="axis main-axis"></div><section class="overview-section" aria-label="Overview"><div class="overview-heading"><span>Overview</span><span class="overview-count"></span></div><div class="overview-plot" tabindex="0" aria-label="Overview range navigation"><div class="overview-window" role="group" aria-label="Selected time range"><button class="overview-handle" data-edge="left" aria-label="Resize range start" title="Resize range start"></button><button class="overview-handle" data-edge="right" aria-label="Resize range end" title="Resize range end"></button></div></div><div class="axis overview-axis"></div></section></section><section class="table-view" aria-label="Tabular records" hidden></section></div><aside class="descriptor" aria-label="Selected record" hidden></aside></div>
  <footer class="app-footer"><div class="pagination">${button('previous', 'chevron-left', 'Previous rows', true)}<span class="row-count"></span>${button('next', 'chevron-right', 'Next rows', true)}</div><span class="record-count"></span><span class="save-status"></span></footer>`;
  timeline = new TimelineRenderer($('.plot-wrap')); overviewRenderer = new OverviewRenderer($('.overview-plot'));
  bandStack = new BandStack($('.timeline-view'), { select: selectRecord, updateIcons, error: showError,
    center: target => { if (state.queryLoading) return; navigation?.cancel(); const range = calendarRange(target, timeDecimal(state.toMs).minus(state.fromMs)); Object.assign(state, range); followRange(range); rememberSetting('range', rangeIso()); refreshQuery({ focusTime: target }); } });
  const calendarButton = $('.header-tools [data-action="range"]');
  calendarButton.dataset.action = 'calendar'; calendarButton.title = 'Calendar'; calendarButton.setAttribute('aria-label', 'Calendar');
  $('.view-tabs').insertAdjacentHTML('beforebegin', button('calendar', 'calendar-days', 'Calendar', false, 'class="mobile-calendar"'));
  $('.range-button').title = 'Date and time range'; $('.range-button').setAttribute('aria-label', 'Date and time range');
  $('[data-action="settings"]').insertAdjacentHTML('afterend', button('help', 'circle-help', 'Help and sharing', false, 'class="help-tool"'));
  $('.auto-label').insertAdjacentHTML('afterend', '<div class="local-scale-controls"><select id="scale-strategy" aria-label="Local scale adjustment" title="Automatic minimizes complete-layout rows; manual applies the selected density ratio"><option value="automatic">Optimize rows</option><option value="manual">Manual scale</option></select><label for="local-scale" title="Maximum local magnification relative to the coarsest time segments">Local scale</label><input id="local-scale" type="range" min="1" max="32" step="0.5" value="4" aria-label="Local scale ratio" title="Local scale ratio: 1x to 32x"><output id="local-scale-value" for="local-scale">4x</output></div>');
  $('#kind-filter').insertAdjacentHTML('afterend', '<select id="grouping-mode" aria-label="Sorting and filtering" title="Sorting and filtering"><option value="all">ALL</option><option value="namespace">NAMESPACE</option><option value="custom" disabled>Custom grouping</option></select><select id="path-shortcut" aria-label="Favorite source paths" title="Favorite source paths" hidden></select>');
  changeMonitor = createChangeMonitor({ blocked: changeRefreshBlocked, render: renderChanges, reload: reloadCommittedSource, error: showError,
    authorizationLost: clearUnauthorized,
    refreshRequired: () => { ++state.epoch; ++layoutIntent; state.queryLoading = false; state.generationRequired = true; state.stale = true; setBusy(false); resetTimeMode(); tableView.suspend(); $('.overview-plot').dispatchEvent(new Event('pointercancel')); updateStatus(); },
    unavailable: () => { if (!state.authRequired) activateFallback().catch(error => toast(error.message)); },
  });
  $('.scale-guide').insertAdjacentHTML('beforeend', `<span class="time-preview" role="status" hidden></span><div class="interaction-mode" role="group" aria-label="Timeline interaction mode"><button type="button" data-time-mode="navigate" aria-pressed="true" aria-label="Navigate timeline" title="Navigate timeline">${icon('mouse-pointer-2')}</button><button type="button" data-time-mode="edit" aria-pressed="false" aria-label="Edit record times" title="Edit record times">${icon('move-horizontal')}</button></div>`);
  recordGestures = createRecordGestures({ plot: $('.plot-wrap'), context: timeEditContext, canEdit: canEditTime, select: selectRecord, project, message: toast,
    preview: value => { const node = $('.time-preview'); node.hidden = !value; $('.scale-cue').hidden = !!value; $('.scale-window').hidden = !!value; if (value) { node.textContent = value.error || `Provisional ${value.payload.start} to ${value.payload.end || 'point / ongoing'}`; node.title = `${value.record.start} to ${value.record.end || 'point / ongoing'} -> ${node.textContent}`; node.classList.toggle('invalid', !!value.error); } },
    precise: (id, operation) => { const record = state.rows?.items.find(item => item.record?.id === id)?.record; if (record && canEditTime(record)) openTimeEditor(record, operation); },
    commit: async (record, payload, context) => { try { await commitRecordTime(record, payload, context); } catch (error) { if (currentTimeSource(context)) openTimeEditor(record, 'move', payload, error, context); else toast('Time draft canceled after a source change. No replacement write was sent.'); } },
  });
  const interactionControls = $('.interaction-mode'), narrow = matchMedia('(max-width:850px)');
  const placeInteractionControls = () => { recordGestures.cancel(); if (narrow.matches) $('.filter-strip').insertBefore(interactionControls, $('.auto-label')); else $('.scale-guide').append(interactionControls); };
  narrow.addEventListener('change', placeInteractionControls); placeInteractionControls();
  tableView = new RecordTableView({ element: $('.table-view'), context: () => ({ provider: state.provider, query: state.query, authRequired: state.authRequired, unavailable: state.localUnavailable || state.generationRequired, selectedId: state.selected?.id, timeZone: state.timeZone, window: state.fromMs === null ? initialSnapshot.settings.range : { ...rangeIso(), viewFromMs: state.fromMs, viewToMs: state.toMs } }), onSelect: selectRecord, onError: showError, onChange: updateStatus, onPreferenceChange: rememberSetting, updateIcons, dateLabel });
  app.setAttribute('aria-busy', 'true');
  for (const control of app.querySelectorAll('button, input, select, textarea')) { bootControls.set(control, control.disabled); control.disabled = true; }
  $('.provider-status').setAttribute('role', 'status');
  $('.provider-status').textContent = location.protocol === 'file:' ? 'Opening Local snapshot...' : 'Connecting configured source...';
  bindShell(); updateIcons();
  const resizeObserver = new ResizeObserver(() => {
    if (state.view === 'table') return;
    const plot = $('.plot-wrap');
    if (!plot) return;
    const box = plot.getBoundingClientRect();
    if (Math.abs(box.width - lastWidth) < 1 && Math.abs(box.height - lastHeight) < 1) return;
    clearTimeout(resizeTimer); const resize = () => {
      if (!state.query || state.view === 'table') return;
      const current = plot.getBoundingClientRect();
      if (Math.abs(current.width - lastWidth) < 1 && Math.abs(current.height - lastHeight) < 1) return;
      if (navigation?.active && Math.abs(current.width - lastWidth) < 1) {
        resizeTimer = setTimeout(resize, 100); return;
      }
      navigation?.cancel(); recordGestures?.cancel();
      if (state.scaleMode === 'adaptive' && state.scaleStrategy === 'automatic' && Math.abs(current.width - lastWidth) >= 1) refreshQuery();
      else refreshLayout();
    }; resizeTimer = setTimeout(resize, 100);
  });
  resizeObserver.observe($('.plot-wrap'));
}

async function initialize(provider, snapshot = null, { preserveView = true } = {}) {
  closeCalendar(false);
  startupDiscovery?.abort();
  if ($('.server-startup')) $('.server-startup').hidden = true;
  if (configurationManager?.isOpen()) {
    await configurationManager.close();
    if (configurationManager?.isOpen()) { if (provider !== state.provider) provider.dispose?.(); return; }
  }
  const previousView = state.info && preserveView ? { domain: state.domain, fromMs: state.fromMs, toMs: state.toMs, filter: { ...state.filter }, transient: structuredClone(state.transient), selectedId: state.selected?.id } : null;
  const intent = ++sourceIntent, selection = ++selectionIntent; ++state.epoch; ++layoutIntent;
  clearTimeout(searchTimer); state.searchPending = false;
  resetTimeMode();
  await modelManager?.close(true);
  const info = await provider.initialize({ timeout: 2500 });
  if (intent !== sourceIntent) { provider.dispose?.(); return; }
  const fieldTypes = await settingsRegistry(provider, info, info.settings || {});
  if (intent !== sourceIntent) { if (provider !== state.provider) provider.dispose?.(); return; }
  if (state.provider && state.provider !== provider) {
    if (!(state.provider instanceof ServerProvider) && provider instanceof ServerProvider) {
      if (state.localUnavailable) { state.provider.dispose(); localBranch = null; }
      else {
        const previousProvider = state.provider;
        try { if (state.query) await previousProvider.releaseQuery(state.query.queryId); }
        catch (error) { if (intent === sourceIntent) { provider.dispose?.(); throw error; } }
        if (intent !== sourceIntent) { if (provider !== state.provider) provider.dispose?.(); return; }
        localBranch = { provider: previousProvider, snapshot: state.snapshot, dirty: state.dirty, preferencesDirty: state.preferencesDirty, transient: structuredClone(state.transient) };
      }
    }
    else state.provider.dispose?.();
  }
  state.provider = provider; state.info = info;
  windowLoader?.dispose(); clearTimeout(loadingTimer); clearTimeout(overviewTimer); overviewRequest?.abort();
  state.overviewZones = null;
  windowLoader = info.legacy?.lazy ? createWindowLoader(provider, { ratio: info.legacy.loading?.bufferRatio ?? .25 }) : null;
  state.localUnavailable = false; watchSource(provider);
  for (const id of ['search', 'source-filter', 'kind-filter', 'auto-scale']) $(`#${id}`).disabled = false;
  tableView.clear();
  if (snapshot) state.snapshot = snapshot;
  state.selected = null; state.dirty = false; state.preferencesDirty = false; state.stale = false; state.authRequired = false; state.generationRequired = false;
  state.transient = {}; state.fieldTypes = fieldTypes;
  const sourceIds = info.sourceIds || (info.sources || []).map(source => typeof source === 'string' ? source : source.id);
  $('#source-filter').innerHTML = '<option value="all">All sources</option>' + sourceIds.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
  state.filter = { sourceId: 'all', kind: 'all' }; $('#source-filter').value = 'all'; $('#kind-filter').value = 'all';
  state.query = null; state.map = null; state.layout = null;
  adoptSettings(info.settings || {});
  adoptLegacyView();
  if (provider.localBrowser && pathPreferences && !info.settings?.presentation?.bandLayout) {
    state.filter.sourceIds = [...pathPreferences.selected];
    state.scaleMode = 'adaptive';
    state.ratio = 32;
  }
  if (previousView) {
    if (timeDecimal(previousView.fromMs).gte(toMs(state.domain.from)) && timeDecimal(previousView.toMs).lte(toMs(state.domain.to))) { state.fromMs = previousView.fromMs; state.toMs = previousView.toMs; if (previousView.transient.range) state.transient.range = rangeIso(); }
    state.filter.sourceId = sourceIds.includes(previousView.filter.sourceId) ? previousView.filter.sourceId : 'all'; state.filter.kind = previousView.filter.kind;
    try { compileExpression(previousView.filter.expression); if (previousView.filter.expression) state.filter.expression = previousView.filter.expression; } catch { /* Schema-scoped conditions stay on their original source. */ }
    if (previousView.transient.search) {
      const search = previousView.transient.search;
      try { compileSearch({ search: search.text, searchMode: search.mode, searchCaseSensitive: search.caseSensitive, searchFields: search.fields }, { fieldTypes }); state.transient.search = structuredClone(search); Object.assign(state, { search: search.text, searchMode: search.mode, searchCaseSensitive: search.caseSensitive, searchFields: structuredClone(search.fields) }); } catch { /* An old schema search is not transferred to this source. */ }
    }
    $('#search').value = state.search; $('#source-filter').value = state.filter.sourceId; $('#kind-filter').value = state.filter.kind;
  }
  state.preferencesDirty = Object.keys(state.transient).length > 0;
  updatePathShortcut();
  state.query = null; state.map = null; state.layout = null; $('.descriptor').hidden = true;
  if (bootPending) finishBoot();
  activateRecordRecovery();
  await refreshQuery();
  if (provider === state.provider && info.legacy?.lazy) monitorLegacyLoading(provider);
  if (previousView?.selectedId && !state.selected && selection === selectionIntent && !state.authRequired && intent === sourceIntent && provider === state.provider) {
    const epoch = state.epoch;
    const current = () => intent === sourceIntent && provider === state.provider && epoch === state.epoch && selection === selectionIntent && !state.selected && !state.authRequired && !state.localUnavailable;
    try { const selected = await provider.getRecord(previousView.selectedId); if (current()) { state.selected = selected; renderDescriptor(); render(); } }
    catch { if (current()) { state.selected = null; renderDescriptor(); } }
  }
}

function showError(error) {
  const message = error?.message || String(error);
  console.error(error); toast(message);
  if (state.provider instanceof ServerProvider && ([401, 403].includes(error?.status) || error?.code === 'permission_scope_changed')) { clearUnauthorized(); return; }
  if (state.provider instanceof ServerProvider && state.authRequired) return;
  if (state.provider instanceof ServerProvider && error?.code === 'server_unavailable') { activateFallback().catch(failure => toast(failure.message)); return; }
  if (state.provider instanceof ServerProvider) { state.stale = true; $('.notice span').textContent = `Server data may be stale. ${message}`; $('.notice').hidden = false; noticeAction('refresh'); }
  updateStatus();
}
function clearUnauthorized() {
  changeMonitor?.cancelQueuedReload();
  bandStack?.configure(null);
  ++state.epoch; ++layoutIntent; state.authRequired = true; state.selected = null; state.rows = null; state.overview = null;
  state.queryLoading = false; state.query = null; state.map = null; state.layout = null; state.zones = []; clearTimeout(searchTimer); state.searchPending = false;
  recordRecovery?.suspend();
  resetTimeMode();
  configurationManager?.close(true);
  closeDialog(); modelManager?.close(true); setBusy(false);
  state.info = { identity: state.provider.identity, providerId: state.provider.identity, sourceKind: 'server', sourceName: 'Authorization required',
    workspaceId: state.info.workspaceId, generation: state.info.generation, revision: null, recordCount: 'Unavailable', snapshotAt: null, sourceIds: [], models: [], settings: {}, actor: null };
  $('#source-filter').innerHTML = '<option value="all">Authorization required</option>';
  for (const id of ['search', 'source-filter', 'kind-filter', 'auto-scale']) $(`#${id}`).disabled = true;
  tableView.clear();
  const plot = $('.plot-wrap');
  timeline.render({ rows: { items: [], rows: [], startRow: 0 }, width: plot.clientWidth, height: plot.clientHeight, rowHeight: state.rowHeight, fontSize: state.fontSize, project: () => 0, theme: state.theme });
  overviewRenderer.render({ items: [], zones: [], width: $('.overview-plot').clientWidth, height: $('.overview-plot').clientHeight || 68, project: () => 0, theme: state.theme });
  $('.overview-window').hidden = true; $('.descriptor').hidden = true; $('.descriptor').innerHTML = ''; $('.table-view').innerHTML = '';
  $('.overview-count').textContent = ''; $('.record-count').textContent = ''; $('.row-count').textContent = 'Authorization required';
  $('.notice span').textContent = 'Server authorization is required. Managed records have been cleared. Reconnect with valid credentials.'; $('.notice').hidden = false;
  noticeAction('sources'); $('.provider-status').textContent = 'Server / Authorization required';
  $('.save-status').textContent = 'Server access denied'; $('[data-action="previous"]').disabled = true; $('[data-action="next"]').disabled = true;
}
async function activateFallback() {
  if (state.authRequired || fallbackActive === state.provider || !(state.provider instanceof ServerProvider)) return;
  if (configuredServer && state.provider.localBrowser) {
    state.stale = true; state.queryLoading = false; setBusy(false);
    $('.notice span').textContent = 'Configured server unavailable. The displayed view is retained and may be stale. Retry to reconnect; no sample data was substituted.';
    $('.notice').hidden = false; noticeAction('refresh'); updateStatus(); return;
  }
  const failed = state.provider, intent = ++sourceIntent;
  resetTimeMode();
  fallbackActive = failed;
  let branch, ownedBranch = false;
  const current = () => sourceIntent === intent && state.provider === failed;
  try {
    ++state.epoch; ++layoutIntent;
    await modelManager?.close(true);
    if (!current()) return;
    ownedBranch = !localBranch;
    branch = localBranch || { provider: createLocalProvider(initialSnapshot), snapshot: initialSnapshot, dirty: false, preferencesDirty: false };
    let unavailableBranch = false;
    let info;
    try { info = await branch.provider.initialize(); }
    catch (error) {
      if (!current()) return;
      if (error.code !== 'local_worker_lost') throw error;
      branch.provider.dispose(); unavailableBranch = true;
      branch = { provider: createLocalProvider(initialSnapshot), snapshot: initialSnapshot, dirty: false, preferencesDirty: false };
      ownedBranch = true;
      info = await branch.provider.initialize();
    }
    if (!current()) return;
    const transient = structuredClone(branch.transient || {});
    const effective = await branch.provider.getEffectiveSettings({ transient }); if (!current()) return;
    const fieldTypes = await settingsRegistry(branch.provider, info, effective.values); if (!current()) return;
    const preserved = { fromMs: state.fromMs, toMs: state.toMs, filter: { ...state.filter }, search: state.transient.search };
    if (state.query && failed === state.provider) failed.releaseQuery(state.query.queryId).catch(() => {});
    state.provider = branch.provider; state.info = info; state.snapshot = branch.snapshot;
    configurationManager?.suspend();
    ownedBranch = false;
    state.localUnavailable = false; state.generationRequired = false; watchSource(branch.provider);
    for (const id of ['search', 'source-filter', 'kind-filter', 'auto-scale']) $(`#${id}`).disabled = false;
    tableView.clear();
    state.dirty = branch.dirty; state.transient = transient; state.fieldTypes = fieldTypes;
    Object.assign(state, { query: null, layout: null, map: null, selected: null, stale: false, filter: { sourceId: 'all', kind: preserved.filter.kind } });
    adoptSettings(effective.values);
    adoptLegacyView({ focus: false });
    if (timeDecimal(preserved.fromMs).gte(toMs(state.domain.from)) && timeDecimal(preserved.toMs).lte(toMs(state.domain.to))) { state.fromMs = preserved.fromMs; state.toMs = preserved.toMs; }
    if (info.sourceIds.includes(preserved.filter.sourceId)) state.filter.sourceId = preserved.filter.sourceId;
    try { compileExpression(preserved.filter.expression); if (preserved.filter.expression) state.filter.expression = preserved.filter.expression; } catch { /* Original schema conditions cannot cross a source boundary. */ }
    if (preserved.search) {
      try { compileSearch({ search: preserved.search.text, searchMode: preserved.search.mode, searchCaseSensitive: preserved.search.caseSensitive, searchFields: preserved.search.fields }, { fieldTypes }); Object.assign(state, { search: preserved.search.text, searchMode: preserved.search.mode, searchCaseSensitive: preserved.search.caseSensitive, searchFields: preserved.search.fields }); state.transient.search = preserved.search; } catch { /* Retain the Local schema-compatible search. */ }
    }
    $('#source-filter').innerHTML = '<option value="all">All sources</option>' + info.sourceIds.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
    $('#source-filter').value = state.filter.sourceId; $('#kind-filter').value = state.filter.kind; $('#search').value = state.search;
    state.preferencesDirty = Object.keys(state.transient).length > 0;
    activateRecordRecovery();
    localBranch = null; failed.dispose?.(); renderDescriptor();
    await refreshQuery();
    if (sourceIntent !== intent || state.provider !== branch.provider) return;
    $('.notice span').textContent = `${unavailableBranch ? 'The retained Local worker was also unavailable; its unexported changes were not recovered. ' : ''}Server unavailable. Local source "${info.sourceName}" is active (${info.snapshotAt}). It may differ from the server. No writes were replayed.`;
    $('.notice').hidden = false; noticeAction('sources');
    toast('Local snapshot active. Server changes and drafts were not synchronized.');
  } finally {
    if (ownedBranch && branch?.provider !== state.provider) branch?.provider.dispose();
    if (fallbackActive === failed) fallbackActive = false;
  }
}
function toast(message) {
  $('.toast')?.remove(); const node = document.createElement('div'); node.className = 'toast'; node.setAttribute('role', 'status'); node.textContent = message; document.body.append(node);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.remove(), 4200);
}
function setBusy(value) {
  state.loading = value; $('.busy-indicator')?.remove();
  if (!value) queueMicrotask(() => document.dispatchEvent(new Event('timeline-ready')));
  if (value) { const node = document.createElement('div'); node.className = 'busy-indicator'; node.setAttribute('role', 'status'); node.textContent = 'Updating timeline...'; $('.workspace').append(node); }
  updateTimeControls();
  for (const id of ['local-scale', 'scale-strategy']) {
    const node = $(`#${id}`);
    if (node) node.disabled = value || state.scaleMode !== 'adaptive' || state.localUnavailable || state.authRequired || state.generationRequired;
  }
}
function refreshQuery(options = {}) {
  if (!state.info || state.localUnavailable || state.authRequired || state.generationRequired) return Promise.resolve();
  windowLoader?.pause(); clearTimeout(overviewTimer); overviewRequest?.abort();
  navigation?.cancel();
  clearTimeout(searchTimer); state.searchPending = false;
  const epoch = ++state.epoch; ++layoutIntent; const provider = state.provider;
  state.queryLoading = true;
  recordGestures?.cancel();
  queryQueue = queryQueue.catch(() => {}).then(() => { if (epoch !== state.epoch || provider !== state.provider) return; return performQuery(epoch, provider, options); });
  return queryQueue;
}
async function performQuery(epoch, provider, { focusTime } = {}) {
  setBusy(true);
  let stagedQuery = null;
  try {
    await bandStack.idle();
    await modelManager?.suspendPreview();
    if (epoch !== state.epoch || provider !== state.provider) return;
    const oldQuery = state.query;
    const plot = $('.plot-wrap').getBoundingClientRect(), width = Math.max(100, Math.round(plot.width || $('.primary').clientWidth - 40)), height = Math.max(1, Math.round(plot.height || 400));
    const focusRanges = new Map(), requestedRange = { fromMs: state.fromMs, toMs: state.toMs };
    const queryDomain = state.info.legacy?.lazy ? bufferedWindow(requestedRange, state.info.legacy.loading?.bufferRatio ?? .25) : state.domain;
    const prepared = await prepareScaledQuery(provider,
      { domain: queryDomain, filters: state.filter, ...searchOptions(), scaleMode: state.scaleMode, ratio: state.ratio, bins: state.bins, ...referenceScale() },
      (query, map) => {
        const range = focusTime === undefined ? requestedRange : centerCalendarRange(map, focusTime, requestedRange);
        focusRanges.set(map.mapId, range);
        return visibleLayout(provider, query.queryId, map.mapId, width, height, range);
      },
      { optimize: state.scaleStrategy === 'automatic', isCurrent: () => epoch === state.epoch && provider === state.provider });
    if (!prepared) return;
    const { query, map, layout } = prepared;
    stagedQuery = query;
    const rows = await provider.getRows(query.queryId, layout.layoutId, {});
    const zones = await provider.getZones(query.queryId);
    if (epoch !== state.epoch || provider !== state.provider) { await provider.releaseQuery(query.queryId); return; }
    const overview = await provider.getOverview(query.queryId);
    if (epoch !== state.epoch || provider !== state.provider) { await provider.releaseQuery(query.queryId); return; }
    if (focusTime !== undefined) {
      Object.assign(state, focusRanges.get(map.mapId)); rememberSetting('range', rangeIso());
    }
    Object.assign(state, { query, map, overview, bandOverview: null, zones: zones.items || [], layout, rows, stale: false, overviewZones: null });
    changeMonitor.acknowledge(query);
    lastWidth = plot.width; lastHeight = plot.height;
    $('.overview-window').hidden = false;
    $('.notice').hidden = true;
    render();
    if (oldQuery?.queryId && oldQuery.queryId !== query.queryId) await provider.releaseQuery(oldQuery.queryId).catch(() => {});
    await refreshBands(epoch);
    if (state.info.legacy?.lazy) {
      state.overviewZones = null;
      windowLoader.request(requestedRange, state.filter);
      showLegacyCoverage();
      scheduleLegacyOverview(provider, epoch);
    }
  } catch (error) { if (stagedQuery && state.query?.queryId !== stagedQuery.queryId) await provider.releaseQuery(stagedQuery.queryId).catch(() => {}); if (epoch === state.epoch && provider === state.provider) showError(error); } finally { if (epoch === state.epoch) { state.queryLoading = false; setBusy(false); } }
}
async function visibleLayout(provider, queryId, mapId, width, height, range = { fromMs: state.fromMs, toMs: state.toMs }, options = {}) {
  await bandStack.releaseLayouts(provider, queryId);
  const top = state.presentation?.compact ? state.presentation.bandLayout?.some(b => b.relativeAxis) ? 28 : 4 : 52;
  const input = { mapId, from: toIso(range.fromMs), to: toIso(range.toMs), viewFromMs: range.fromMs, viewToMs: range.toMs, width, availableHeight: Math.max(state.rowHeight, height - top - (state.presentation?.compact ? 44 : 0)), rowHeight: state.rowHeight, fontSize: state.fontSize, groupBy: state.groupBy, ...presentationOptions(), renderProfileId: 'noto-sans-latin-v1' };
  try { return await provider.createLayout(queryId, input, options); }
  catch (error) {
    if (error.code !== 'row_height_limit' || height >= 246 || provider !== state.provider || options.noResize) throw error;
    const probe = await provider.createLayout(queryId, { ...input, availableHeight: 192 }, options);
    app.style.setProperty('--minimum-plot-height', `${probe.rowHeight + 52}px`);
    app.classList.add('tall-rows');
    await provider.releaseLayout(queryId, probe.layoutId);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const box = $('.plot-wrap').getBoundingClientRect();
    return provider.createLayout(queryId, { ...input, width: Math.max(100, Math.round(box.width)), availableHeight: Math.max(probe.rowHeight, Math.round(box.height) - 52) }, options);
  }
}
function refreshLayout(cursor, queryEpoch = state.epoch) {
  if (state.localUnavailable || state.authRequired || state.generationRequired) return Promise.resolve();
  if (state.queryLoading) return queryQueue;
  const intent = ++layoutIntent, provider = state.provider, query = state.query;
  layoutQueue = layoutQueue.catch(() => {}).then(() => {
    if (intent !== layoutIntent || queryEpoch !== state.epoch || provider !== state.provider) return;
    return performLayout(cursor, queryEpoch, intent, provider, query);
  });
  return layoutQueue;
}
async function performLayout(cursor, queryEpoch, intent, provider, query) {
  if (!state.query || !state.map) return;
  setBusy(true);
  try {
    const plot = $('.plot-wrap').getBoundingClientRect();
    const width = Math.max(100, Math.round(plot.width || $('.primary').clientWidth - 40));
    const height = Math.max(1, Math.round(plot.height || 400));
    lastWidth = plot.width; lastHeight = plot.height;
    let layout = state.layout;
    if (!cursor) layout = await visibleLayout(provider, query.queryId, state.map.mapId, width, height);
    const rows = await provider.getRows(query.queryId, layout.layoutId, { cursor });
    if (queryEpoch !== state.epoch || intent !== layoutIntent || provider !== state.provider) { if (!cursor) await provider.releaseLayout(query.queryId, layout.layoutId).catch(() => {}); return; }
    const oldLayout = state.layout;
    state.layout = layout; state.rows = rows;
    try { render(); }
    finally { if (!cursor && oldLayout?.layoutId && oldLayout.layoutId !== layout.layoutId) await provider.releaseLayout(query.queryId, oldLayout.layoutId).catch(() => {}); }
    if (!cursor) await refreshBands(queryEpoch);
  } catch (error) { if (intent === layoutIntent && provider === state.provider) showError(error); } finally { if (intent === layoutIntent) setBusy(false); }
}
function clampTime(value) { return Decimal.min(Decimal.max(decimal(value instanceof Date ? value.getTime() : typeof value === 'string' && value.includes('T') ? toMs(value) : value), toMs(state.map.domain.from)), toMs(state.map.domain.to)).toString(); }
function project(value) { return projectTime(state.map, clampTime(value), state.fromMs, state.toMs, state.layout.width); }
function referenceScale() { const intervals = state.presentation?.bandLayout?.find(band => band.role === 'primary')?.fixedScale; return intervals ? { fixedScale: intervals } : {}; }
function overviewMap(domain = state.domain) { return fixedScaleMap(domain, state.presentation?.bandLayout?.find(band => band.role === 'overview')?.fixedScale || []); }
function overviewProject(value, domain = state.domain) { const width = $('.overview-plot').clientWidth; return projectTime(overviewMap(domain), timeDecimal(value).clamp(toMs(domain.from), toMs(domain.to)).toFixed(), domain.from, domain.to, width); }
function overviewTime(x) { return invertPosition(overviewMap(), x, state.domain.from, state.domain.to, $('.overview-plot').clientWidth); }

function readableTicks(from, to, unit, width, mapper, format = 'DEFAULT', adaptive = false, margin = 0, map = state.map) {
  let ticks;
  try { ticks = adaptive ? adaptiveTicks({ map, from, to, width, project: mapper, timeZone: state.timeZone || 'UTC' }) : generateTicks(from, to, unit, { maxTicks: margin ? 600 : 200, timeZone: state.timeZone || 'UTC' }); } catch { ticks = []; }
  if (!adaptive && (ticks.length >= (margin ? 600 : 200) || ticks.length < 2 || (ticks.length > 1 && Math.abs(mapper(ticks[1].timeMs) - mapper(ticks[0].timeMs)) < 65))) {
    try { ticks = adaptiveTicks({ map, from, to, width, project: mapper, timeZone: state.timeZone || 'UTC' }); } catch { /* Boundary dates keep the valid calendar ticks. */ }
  }
  if (!ticks?.length) ticks = [{ timeMs: from, label: dateLabel(toIso(from)) }, { timeMs: to, label: dateLabel(toIso(to)) }];
  const context = document.createElement('canvas').getContext('2d'); context.font = '11px "Noto Sans"';
  const filtered = []; let lastRight = -margin - 1000;
  for (const tick of ticks) {
    const x = mapper(tick.timeMs), label = formatBandDate(tick.timeMs, format, state.timeZone || 'UTC', tick.label);
    const labelWidth = context.measureText(label).width;
    if (x >= -margin - 1 && x + labelWidth <= width + margin && x >= lastRight + 12) { filtered.push({ ...tick, label }); lastRight = x + labelWidth; }
  }
  return filtered;
}
function styleAxis(axis, band, parent, anchor) {
  if (band?.axisPosition === 'top') parent.insertBefore(axis, anchor);
  else anchor.after(axis);
  axis.style.color = band?.dateColor || '';
  axis.style.backgroundColor = band?.backgroundColor || '';
}
function render() {
  if (!state.info || !state.query || !state.map || !state.rows || !state.layout || !state.overview || state.authRequired) return;
  navigation?.rendered();
  const plot = $('.plot-wrap'); const width = state.layout.width, height = Math.max(1, plot.clientHeight);
  const presentation = state.rows.presentation || (state.presentation ? resolvePresentation({ ...currentDefinition(), displayUnit: state.unit }) : undefined);
  const primaryBand = presentation?.bands.primary, overviewBand = presentation?.bands.overview;
  $('.timeline-view').style.setProperty('--reference-guide-height', `${state.map.mode === 'fixed' || state.scaleMode === 'adaptive' ? 65 : 38}px`);
  bandStack.configure(state.presentation);
  const tickStart = panRange(state.map, state.fromMs, state.toMs, width, width).fromMs;
  const tickEnd = panRange(state.map, state.fromMs, state.toMs, -width, width).toMs;
  const ticks = readableTicks(tickStart, tickEnd, primaryBand?.intervalUnit || state.unit, width, project, primaryBand?.dateFormat, state.scaleMode === 'adaptive' || state.map.mode === 'fixed', width);
  const centerTick = ticks.reduce((best, tick) => !best || Math.abs(project(tick.timeMs) - width / 2) < Math.abs(project(best.timeMs) - width / 2) ? tick : best, null);
  displayedTimeUnit = centerTick?.unit || primaryBand?.intervalUnit || state.unit;
  const majorTimes = new Set(ticks.map(tick => Number(tick.timeMs)));
  const subdivisions = minorTicks({ from: tickStart, to: tickEnd, unit: primaryBand?.intervalUnit || state.unit, divisions: primaryBand?.minorDivisions, project, timeZone: state.timeZone || 'UTC' }).filter(tick => !majorTimes.has(tick.timeMs));
  styleAxis($('.main-axis'), primaryBand, $('.timeline-view'), plot);
  styleAxis($('.overview-axis'), overviewBand, $('.overview-section'), $('.overview-plot'));
  timeline.previewOffset(0);
  timeline.render({ rows: state.rows, width, height, rowHeight: state.rows.rowHeight || state.layout.rowHeight || state.rowHeight, fontSize: state.fontSize, project, zones: state.zones, selectedId: state.selected?.id, theme: state.theme, presentation, labelBackgroundAuthored: Object.hasOwn(state.presentation?.labels || {}, 'backgroundColor'), ticks: [...ticks, ...subdivisions], hasSearch: !!state.search, referenceTime: state.info.settings?.referenceTime });
  $('.main-axis').innerHTML = `<div class="axis-tick-layer">${ticks.map(t => `<span style="left:${project(t.timeMs)}px" title="${esc(toIso(t.timeMs))}">${esc(t.label)}</span>`).join('')}</div>`;
  bandStack.relativeAxis(state.presentation, plot, project, rangeIso());
  if (!$('.overview-section').hidden) { renderOverview(state.domain, presentation); updateOverviewWindow(); }
  updateStatus(); renderTable();
  $('.empty-state')?.remove();
  if (!(state.rows.items || []).some(item => item.record)) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.innerHTML = state.query.coverage?.complete === false ? '<strong>No loaded records in this range</strong><span>Archive coverage is still being checked</span>' : '<strong>No records in this range</strong><span>Change the range or filters</span>'; plot.append(empty); }
  $('.scale-cue').textContent = state.query.coverage?.complete === false ? 'Automatic scale pending / provisional coverage' : state.scaleMode === 'adaptive' ? `${state.scaleStrategy === 'automatic' ? 'Row optimized' : 'Manual'} / ${state.map.ratio}x local scale` : state.map.mode === 'fixed' ? 'Reference / Magnified time intervals' : 'Uniform time scale';
  renderScaleCues();
  $('.scale-window').textContent = `${state.scaleMode === 'adaptive' ? 'Adaptive divisions' : state.unit[0] + state.unit.slice(1).toLowerCase()} / ${state.timeZone || 'UTC'}`;
  $('.range-button').textContent = `${rangeDate(toIso(state.fromMs))} / ${dateLabel(toIso(state.fromMs))} - ${dateLabel(toIso(state.toMs))}`;
  $('#auto-scale').checked = state.scaleMode === 'adaptive';
  $('#local-scale').value = state.ratio;
  $('#local-scale-value').textContent = `${state.ratio}x`;
  $('#scale-strategy').value = state.scaleStrategy;
  $('#grouping-mode').value = state.presentation?.grouping ? groupingMode(state.presentation) : state.groupBy === 'none' ? 'all' : 'custom';
  updateIcons();
  updateTimeControls();
  calendar?.update(timelineCenter(), calendarUnit());
  if (recordGestures?.mode === 'edit' || state.selected) refreshTimePermissions();
}
function refreshBands(epoch = state.epoch) {
  if (!state.presentation?.bandLayout || state.authRequired) return Promise.resolve();
  const provider = state.provider;
  const overviewSources = state.presentation.bandLayout.find(band => band.role === 'overview')?.sourceIds;
  return bandStack.refresh({ provider, query: state.query, map: state.map, presentation: state.presentation,
    ...(overviewSources ? { overview: { range: { ...state.domain }, sourceIds: overviewSources, apply: result => { state.bandOverview = result; renderOverview(); } } } : {}),
    range: rangeIso(), settings: state.info.settings, filters: structuredClone(state.filter), search: searchOptions(), zones: state.zones,
    selectedId: state.selected?.id, current: () => state.epoch === epoch && provider === state.provider && !state.authRequired });
}
function renderOverview(domain = state.domain, presentation = state.rows?.presentation) {
  if ($('.overview-section').hidden || $('.overview-plot').clientWidth <= 0) return;
  const width = $('.overview-plot').clientWidth, mapper = value => overviewProject(value, domain);
  const sources = state.presentation?.bandLayout?.find(b => b.role === 'overview')?.sourceIds;
  const overviewItems = sources ? state.bandOverview?.items || [] : state.overview.items || [];
  overviewRenderer.render({ items: overviewItems, zones: sources ? state.bandOverview?.zones || [] : state.overviewZones || state.zones, width, height: $('.overview-plot').clientHeight || 68, project: mapper, theme: state.theme, presentation, domainEnd: domain.to });
  const span = decimal(toMs(domain.to)).minus(toMs(domain.from)).toNumber();
  const unit = state.presentation?.bands?.overview?.intervalUnit || (span > 366 * 86400000 ? 'YEAR' : span > 3 * 86400000 ? 'DAY' : 'HOUR');
  const linear = overviewMap(domain);
  $('.overview-section').dataset.fixed = String(linear.mode === 'fixed');
  const ticks = readableTicks(toMs(domain.from), toMs(domain.to), unit, width, mapper, presentation?.bands?.overview?.dateFormat, linear.mode === 'fixed', 0, linear);
  $('.overview-axis').innerHTML = ticks.map(t => `<span style="left:${mapper(t.timeMs)}px">${esc(t.label)}</span>`).join('');
}
function renderScaleCues() {
  const guide = $('.scale-guide'); guide.querySelector('.scale-map')?.remove(); guide.classList.toggle('adaptive-guide', state.scaleMode === 'adaptive' || state.map?.mode === 'fixed');
  if ((state.scaleMode !== 'adaptive' && state.map?.mode !== 'fixed') || !state.map?.knots?.length) return;
  const knots = state.map.knots, pieces = [];
  for (let i = 1; i < knots.length; i++) pieces.push({ from: timeDecimal(knots[i - 1].timeMs), to: timeDecimal(knots[i].timeMs), slope: timeDecimal(knots[i].u).minus(knots[i - 1].u).div(timeDecimal(knots[i].timeMs).minus(knots[i - 1].timeMs)) });
  const baseline = Decimal.min(...pieces.map(p => p.slope));
  const groups = [];
  for (const piece of pieces) {
    const ratio = piece.slope.div(baseline).toNumber(), bucket = ratio < 1.15 ? 0 : ratio < 2 ? 1 : ratio < 3 ? 2 : 3;
    const last = groups.at(-1);
    if (last?.bucket === bucket && Math.max(last.ratio, ratio) / Math.min(last.minRatio, ratio) <= 1.1) {
      last.to = piece.to; last.ratio = Math.max(last.ratio, ratio); last.minRatio = Math.min(last.minRatio, ratio);
    } else groups.push({ ...piece, bucket, ratio, minRatio: ratio });
  }
  const strip = document.createElement('div'); strip.className = 'scale-map'; let lastLabelRight = -100;
  strip.innerHTML = groups.map(piece => {
    const left = Math.max(-state.layout.width, project(piece.from.toFixed())), right = Math.min(state.layout.width * 2, project(piece.to.toFixed())), width = Math.max(0, right - left);
    if (!width) return '';
    const labelLeft = left + width / 2 - 20, show = width >= 50 && labelLeft > lastLabelRight + 8;
    if (show) lastLabelRight = labelLeft + 40;
    return `<span class="scale-piece scale-level-${piece.bucket}" style="left:${left}px;width:${width}px" title="${esc(`${toIso(piece.from.toFixed())} to ${toIso(piece.to.toFixed())}: up to ${piece.ratio.toFixed(2)}x relative local scale`)}">${show ? `<b>${piece.ratio.toFixed(1)}x</b>` : ''}</span>`;
  }).join('');
  guide.append(strip);
}
function updateOverviewWindow(range = { fromMs: state.fromMs, toMs: state.toMs }, domain = state.domain) {
  if ($('.overview-section').hidden || $('.overview-plot').clientWidth <= 0) return;
  const left = overviewProject(range.fromMs, domain), right = overviewProject(range.toMs, domain);
  const selected = $('.overview-window'); selected.style.left = `${left}px`; selected.style.width = `${Math.max(1, right - left)}px`;
  selected.setAttribute('aria-label', `Selected range ${toIso(range.fromMs)} to ${toIso(range.toMs)}`);
}
function updateStatus() {
  updatePathShortcut();
  if (!state.info || state.authRequired) return;
  const local = isLocal(), modified = state.dirty || state.preferencesDirty;
  $('.provider-status').innerHTML = `<i class="status-dot ${local ? '' : 'server'} ${state.stale ? 'stale' : ''}"></i>${local ? `Local / ${state.localUnavailable ? 'Unavailable' : modified ? 'Modified' : 'Ready'}` : `Server / ${state.stale ? 'Stale' : 'Connected'}`}`;
  $('.provider-status').title = `${state.info.sourceName || 'Snapshot'} / ${state.info.snapshotAt || ''}`;
  $('.save-status').innerHTML = `${local ? state.localUnavailable ? 'Local memory unavailable' : modified ? 'Local / JSON export pending' : 'Local snapshot / In memory' : state.stale ? 'Server / Last confirmed snapshot' : 'Server / Committed snapshot'} ${icon(local ? 'hard-drive-download' : 'lock-keyhole')}`;
  const legacy = state.info.legacy || state.info.origin?.legacy;
  if (legacy?.readOnly) {
    $('.provider-status').append(document.createTextNode(' / Legacy JSON'));
    $('.save-status').textContent = `${local ? 'Local snapshot' : 'Read-only files'} / ${legacy.status === 'stale' ? 'Last good data' : 'Read-only'}`;
  }
  if (state.query && state.map && state.rows && state.layout && state.overview) {
    $('.row-count').textContent = `Rows ${state.rows.totalRows ? state.rows.startRow + 1 : 0}-${state.rows.endRow} of ${state.rows.totalRows}`;
    $('[data-action="previous"]').disabled = !state.rows.previousCursor;
    $('[data-action="next"]').disabled = !state.rows.nextCursor;
    $('.record-count').textContent = `${state.rows.loadedCount ?? state.rows.items.filter(x => x.record).length} loaded / ${state.layout.detailTotal} in range${state.search ? ` / ${state.layout.detailMatchTotal} matches` : ''}`;
    $('.overview-count').textContent = state.search ? `${state.overview.matched} search matches` : `${state.overview.total} records / full context`;
    if (legacy?.lazy) {
      if (state.query.coverage?.complete === false) $('.record-count').textContent += ' / provisional';
      const broad = state.overview.domain?.from === state.domain.from && state.overview.domain?.to === state.domain.to;
      $('.overview-count').textContent = `${state.search ? `${state.overview.matched} search matches` : `${state.overview.total} records`} / ${broad ? 'full context' : 'visible-window context'}${state.overview.coverage?.complete === false ? ' / provisional' : ''}`;
    }
  } else {
    $('.row-count').textContent = state.queryLoading ? 'Loading timeline' : 'No timeline result';
    $('.record-count').textContent = ''; $('.overview-count').textContent = '';
    $('[data-action="previous"]').disabled = true;
    $('[data-action="next"]').disabled = true;
  }
  if (state.view === 'table') {
    const result = tableView.result;
    $('.row-count').textContent = result ? `Records ${result.total ? result.startIndex + 1 : 0}-${result.endIndex} of ${result.total}` : 'Loading table';
    $('[data-action="previous"]').disabled = !result?.previousCursor || tableView.pending;
    $('[data-action="next"]').disabled = !result?.nextCursor || tableView.pending;
    $('.record-count').textContent = result ? `${result.total} records / Snapshot ${result.revision}` : '';
  }
  for (const direction of ['previous', 'next']) {
    const command = $(`[data-action="${direction}"]`), label = `${direction === 'previous' ? 'Previous' : 'Next'} ${state.view === 'table' ? 'records' : 'rows'}`;
    command.title = label; command.setAttribute('aria-label', label); if (command.querySelector('span')) command.querySelector('span').textContent = label;
    if (state.localUnavailable) command.disabled = true;
  }
  updateIcons();
}
function renderTable() {
  tableView.sync();
}
async function selectRecord(id, pinnedRecord = null) {
  const provider = state.provider, epoch = state.epoch, intent = ++selectionIntent;
  try {
    const record = pinnedRecord || state.rows?.items.find(item => item.record?.id === id)?.record || await provider.getRecord(id);
    if (provider !== state.provider || epoch !== state.epoch || intent !== selectionIntent || state.authRequired) return;
    state.selected = record; renderDescriptor(); render();
  } catch (error) { if (provider === state.provider && epoch === state.epoch && intent === selectionIntent) showError(error); }
}
function renderDescriptor() {
  const record = state.selected; const panel = $('.descriptor'); panel.hidden = !record; if (!record) return;
  closeCalendar(false);
  const duration = record.end ? `${((toMs(record.end) - toMs(record.start)) / 60000).toLocaleString(undefined, { maximumFractionDigits: 3 })} minutes` : record.kind === 'event' ? 'Point event' : 'Ongoing session';
  panel.innerHTML = `<div class="panel-heading"><h2>Descriptor</h2>${button('close-descriptor', 'x', 'Close descriptor')}</div><span class="record-badge"><i style="background:${esc(record.render?.color || '#367ba4')}"></i>${esc(record.kind)}</span><h3>${esc(record.title)}</h3><dl class="record-facts"><dt>Start / ${esc(state.timeZone || 'UTC')}</dt><dd>${esc(dateLabel(record.start, true))}</dd><dt>End / ${esc(state.timeZone || 'UTC')}</dt><dd>${record.end ? esc(dateLabel(record.end, true)) : record.kind === 'session' ? 'Ongoing' : '-'}</dd><dt>Duration</dt><dd>${duration}</dd><dt>Source</dt><dd>${esc(record.sourceId)}</dd><dt>Record ID</dt><dd>${esc(record.id)}</dd>${record.parentSessionId ? `<dt>Parent session</dt><dd>${esc(record.parentSessionId)}</dd>` : ''}<dt>Version</dt><dd>${record.version}</dd><dt>Notes</dt><dd>${esc(record.data?.description || record.data?.text || '-')}</dd></dl><div class="descriptor-actions">${button('edit', 'pencil', 'Edit', true, 'class="primary-button"')}${button('duplicate', 'copy', 'Duplicate', true)}${button('delete', 'trash-2', 'Delete', true, 'class="danger"')}</div>`;
  panel.querySelector('.descriptor-actions').insertAdjacentHTML('beforeend', button('locate', 'crosshair', 'Locate on timeline', true));
  if (record.extensions?.sourceRecord) {
    const details = document.createElement('details'); details.className = 'source-record-details';
    details.innerHTML = '<summary>Original source record and date precision</summary><pre></pre>';
    details.querySelector('pre').textContent = JSON.stringify({ original: record.extensions.sourceRecord, uncertainty: record.extensions.uncertainty || {} }, null, 2);
    panel.querySelector('.descriptor-actions').before(details);
  }
  panel.querySelector('.descriptor-actions').insertAdjacentHTML('beforeend', button('time-edit', 'move-horizontal', 'Change time', true));
  if (record.kind === 'session' && record.end === null) panel.querySelector('.descriptor-actions').insertAdjacentHTML('beforeend', button('close-session', 'clock-check', 'Close session', true));
  if (record.parentSessionId) {
    const warning = document.createElement('p'); warning.className = 'record-time-warning'; warning.hidden = true; warning.setAttribute('role', 'status'); panel.querySelector('.descriptor-actions').before(warning);
    const provider = state.provider, generation = state.info.generation;
    const parent = state.rows?.items.find(item => item.record?.id === record.parentSessionId)?.record;
    Promise.resolve(parent || provider.getRecord(record.parentSessionId)).then(value => {
      if (state.selected !== record || state.provider !== provider || state.info.generation !== generation || !warning.isConnected) return;
      warning.textContent = parentTimeWarning(record, value); warning.hidden = !warning.textContent;
    }).catch(() => { if (state.selected === record && warning.isConnected) { warning.textContent = 'Parent time extent is unavailable for comparison.'; warning.hidden = false; } });
  }
  if (state.presentation?.inspector?.fields) {
    const facts = document.createElement('dl'); facts.className = 'record-facts configured-fields';
    for (const entry of state.presentation.inspector.fields) {
      const { missing, value } = readField(record, entry.field), label = document.createElement('dt'), detail = document.createElement('dd');
      label.textContent = entry.label;
      const text = missing ? '(missing)' : value === null ? '(null)' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      detail.textContent = text.length > 4096 ? `${text.slice(0, 4096)}...` : text;
      facts.append(label, detail);
    }
    panel.querySelector('.descriptor-actions').before(facts);
  }
  if (record.extensions?.legacy && state.provider instanceof ServerProvider && state.info.legacy?.readOnly) {
    const provider = state.provider, action = document.createElement('button');
    action.innerHTML = `${icon('file-text')}<span>Legacy descriptor</span>`;
    panel.querySelector('.descriptor-actions').append(action);
    action.onclick = async () => {
      action.disabled = true;
      try {
        const result = await provider.getLegacyDescriptor(record.id);
        if (state.provider !== provider || state.selected !== record || !action.isConnected) return;
        const content = document.createElement('pre'); content.className = 'legacy-descriptor';
        const text = result.descriptor ? JSON.stringify(result.descriptor, null, 2) : result.reason;
        content.textContent = text.length > 32768 ? `${text.slice(0, 32768)}\n[Descriptor display limit reached]` : text;
        action.replaceWith(content);
      } catch (error) { if (action.isConnected) { action.disabled = false; toast(error.message); } }
    };
  }
  updateIcons();
  updateTimeControls(); refreshTimePermissions();
}

function bindShell() {
  // A worker may finish after the shell is painted; reject input until its source is adopted.
  for (const type of ['click', 'input', 'change', 'keydown', 'pointerdown', 'wheel']) app.addEventListener(type, event => {
    if (bootPending) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true, passive: false });
  app.addEventListener('click', event => {
    const changes = event.target.closest('[data-change-mode]'); if (changes) { changeMonitor.setMode(changes.dataset.changeMode); return; }
    const mode = event.target.closest('[data-time-mode]'); if (mode) { setTimeMode(mode.dataset.timeMode); return; }
    const action = event.target.closest('[data-action]'); if (action) { const provider = state.provider, intent = sourceIntent; handleAction(action.dataset.action).catch(error => { if (provider === state.provider && intent === sourceIntent) showError(error); }); return; }
    const view = event.target.closest('[data-view]'); if (view) { setView(view.dataset.view); return; }
  });
  $('#search').addEventListener('input', e => { state.search = e.target.value; rememberSetting('search', searchSettings()); clearTimeout(searchTimer); state.searchPending = true; searchTimer = setTimeout(() => { state.searchPending = false; refreshQuery(); }, 250); });
  $('#source-filter').addEventListener('change', e => { state.filter.sourceId = e.target.value; refreshQuery(); });
  $('#kind-filter').addEventListener('change', e => { state.filter.kind = e.target.value; refreshQuery(); });
  $('#auto-scale').addEventListener('change', e => { state.scaleMode = e.target.checked ? 'adaptive' : 'uniform'; rememberSetting('scaleMode', state.scaleMode); refreshQuery(); });
  $('#local-scale').addEventListener('input', e => { $('#local-scale-value').textContent = `${e.target.value}x`; });
  $('#local-scale').addEventListener('change', e => { state.ratio = Number(e.target.value); rememberSetting('ratio', state.ratio); refreshQuery(); });
  $('#scale-strategy').addEventListener('change', e => { state.scaleStrategy = e.target.value; refreshQuery(); });
  $('#grouping-mode').addEventListener('change', e => setGrouping(e.target.value));
  $('#path-shortcut').addEventListener('change', e => {
    if (e.target.value === 'choose') { updatePathShortcut(); openSources(); return; }
    if (e.target.value === 'selected') return;
    applyPaths(e.target.value === 'all' ? pathCatalog.sources.map(source => source.id) : [e.target.value]).catch(showError);
  });
  document.addEventListener('pointerdown', event => { if (event.target.closest('.plot-wrap,.overview-plot')) navigationActive = true; }, { capture: true });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) window.addEventListener(type, () => { navigationActive = false; }, { capture: true });
  bindNavigation();
}
function setView(view, { transient = true, refresh = true } = {}) {
  if (!state.info) return;
  state.view = view;
  if (transient) rememberSetting('mode', view);
  $('.workspace').classList.toggle('split-view', view === 'split');
  $('.timeline-view').hidden = view === 'table'; $('.table-view').hidden = view === 'timeline';
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === view));
  tableView.visible = view !== 'timeline'; if (refresh) tableView.sync(); updateStatus();
  if (refresh && view !== 'table') setTimeout(() => refreshLayout(), 0);
}
async function handleAction(action) {
  if (!state.info) return;
  if (action === 'help') return openHelp();
  if (action === 'reload-changes') return changeMonitor.reload();
  if (state.generationRequired && !['refresh', 'sources', 'close-descriptor', 'record-recovery'].includes(action)) { toast('Reload the restored workspace before continuing.'); return; }
  if (action === 'record-recovery') return recordRecovery?.open();
  if (recordRecovery?.pending().length && ['create', 'edit', 'duplicate', 'delete', 'time-edit', 'close-session'].includes(action)) return recordRecovery.open();
  if (!state.rows && ['previous', 'next'].includes(action)) return;
  if (!state.map && ['zoom-in', 'zoom-out'].includes(action)) return;
  if (state.localUnavailable && !['sources', 'close-descriptor'].includes(action)) { toast('The Local source is unavailable. Open another complete JSON snapshot or connect to a server.'); return; }
  if (state.queryLoading && ['previous', 'next'].includes(action)) return;
  if (state.authRequired && ['create', 'edit', 'duplicate', 'delete'].includes(action)) { toast('Reconnect with valid server authorization before editing.'); return; }
  if (action === 'previous' || action === 'next') return state.view === 'table' ? tableView.page(action) : refreshLayout(action === 'previous' ? state.rows.previousCursor : state.rows.nextCursor);
  if (action === 'zoom-in' || action === 'zoom-out') return changeRange(navigateZoom(state.map, state.fromMs, state.toMs, action === 'zoom-in' ? 1.5 : 0.65, 0.5));
  if (action === 'fit') return changeRange({ fromMs: String(toMs(state.domain.from)), toMs: String(toMs(state.domain.to)) });
  if (action === 'now') {
    const now = new Date(), day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    state.domain = { from: day.toISOString(), to: new Date(day.getTime() + 86400000).toISOString() };
    state.fromMs = String(Math.max(day.getTime(), now.getTime() - 4 * 3600000)); state.toMs = String(Math.min(day.getTime() + 86400000, now.getTime() + 4 * 3600000)); rememberSetting('overview', state.domain); rememberSetting('range', rangeIso()); return refreshQuery();
  }
  if (action === 'refresh') {
    if (!isLocal() && !state.authRequired && state.info.capabilities?.changeFeed !== false) return changeMonitor.reload();
    const provider = state.provider, intent = sourceIntent, epoch = state.epoch;
    const current = () => provider === state.provider && intent === sourceIntent && epoch === state.epoch;
    try { const info = await provider.getStatus(); if (current()) { const changedGeneration = state.info.generation !== info.generation; state.info = info; if (changedGeneration) { state.selected = null; renderDescriptor(); activateRecordRecovery(); } return refreshQuery(); } }
    catch (error) { if (current()) showError(error); }
    return;
  }
  if (action === 'range') return openRange();
  if (action === 'calendar') return toggleCalendar();
  if (action === 'settings' || action === 'filters') return openSettings(action === 'filters');
  if (action === 'models') return openModels();
  if (action === 'locate' && state.selected) return locateSelected();
  if (action === 'sources') return openSources();
  if (action === 'create') return openEditor();
  if (action === 'edit' && state.selected) return openEditor(state.selected);
  if (['time-edit', 'close-session'].includes(action) && state.selected) { await refreshTimePermissions(true); if (canEditTime(state.selected)) openTimeEditor(state.selected, action === 'close-session' ? 'close' : 'move'); return; }
  if (action === 'duplicate' && state.selected) return openEditor(state.selected, true);
  if (action === 'delete' && state.selected) return openDelete();
  if (action === 'close-descriptor') { ++selectionIntent; state.selected = null; renderDescriptor(); return render(); }
}
async function locateSelected() {
  const record = state.selected, provider = state.provider;
  if (!record || state.authRequired) return;
  const start = toMs(record.start), span = Math.max(1, timeDecimal(state.toMs).minus(state.fromMs).toNumber());
  const minimum = -377705116800000, maximum = 253402300799999;
  const left = Math.max(minimum, Math.min(start - span / 4, maximum - span)), right = Math.min(maximum, left + span);
  const outside = left < toMs(state.domain.from) || right > toMs(state.domain.to);
  if (outside) state.domain = { from: toIso(Math.max(minimum, Math.min(left - span, toMs(state.domain.from)))), to: toIso(Math.min(maximum, Math.max(right + span, toMs(state.domain.to)))) };
  state.fromMs = String(left); state.toMs = String(right);
  if (outside) rememberSetting('overview', state.domain); rememberSetting('range', rangeIso());
  setView('split');
  await (outside ? refreshQuery() : refreshLayout());
  if (provider !== state.provider || state.authRequired || !state.query || !state.layout) return;
  const query = state.query, layout = state.layout;
  const placement = await provider.getPlacement(query.queryId, layout.layoutId, record.id);
  if (provider === state.provider && query === state.query && layout === state.layout && !placement.outsideLayout) await refreshLayout(placement.cursor);
}
function currentDefinition() {
  return { theme: state.theme, rowHeight: state.rowHeight, fontSize: state.fontSize, groupBy: state.groupBy, displayUnit: state.unit, timeZone: state.timeZone || 'UTC', scaleMode: state.scaleMode, ratio: state.ratio, bins: state.bins, ...(state.presentation ? { presentation: structuredClone(state.presentation) } : {}) };
}
function openHelp(link = '', tab = 'help') {
  const provider = state.provider, intent = sourceIntent, epoch = state.epoch;
  const serverReady = !isLocal() && !state.authRequired && !state.localUnavailable && !state.generationRequired;
  return openHelpPanel({
    openDialog, closeDialog, updateIcons, toast, serverReady, generation: state.info.generation,
    testDatasets, testDatasetId: state.info.origin?.testDataset?.id || state.info.testDataset?.id,
    openTestDataset, resetTestDataset,
    reopenShare: () => { closeDialog(); openHelp('', 'share'); },
    get shareReady() { return !!state.query && !state.queryLoading && !state.loading && !state.searchPending && !navigation?.active && !state.authRequired && !state.localUnavailable && !state.generationRequired; },
    isCurrent: () => provider === state.provider && intent === sourceIntent && epoch === state.epoch,
    viewStamp: () => JSON.stringify([state.fromMs, state.toMs, state.layout?.layoutId, state.selected?.id, state.view]),
    capture: () => ({ version: 1, range: { fromMs: state.fromMs, toMs: state.toMs }, domain: structuredClone(state.domain), settings: currentDefinition(), filters: structuredClone(state.filter), search: searchOptions(), view: state.view, scaleStrategy: state.scaleStrategy, selectedId: state.selected?.id ?? null, generation: state.info.generation ?? null }),
    summary: { source: `${isLocal() ? 'Local snapshot' : 'Server data'} / ${state.info.snapshotAt || 'Live source'}`, range: `${toIso(state.fromMs)} to ${toIso(state.toMs)}`, filter: `${state.filter.sourceId || 'all'} / ${state.filter.kind || 'all'}${state.search ? ` / Search: ${state.search}` : ''}${state.filter.expression || state.filter.filterId ? ' / Advanced filter' : ''}`, selection: state.selected?.title || 'None' },
    diagnostics: { provider: isLocal() ? 'local' : 'server', readOnlyLegacy: legacyReadOnly(), recordCount: state.info.recordCount, revision: state.query?.revision ?? state.info.revision, stale: !!state.stale, sourceAvailable: !state.localUnavailable && !state.authRequired && !state.generationRequired, view: state.view, scaleMode: state.scaleMode, scaleStrategy: state.scaleStrategy, ratioLimit: state.ratio, appliedRatio: state.map?.ratio, totalRows: state.layout?.totalRows, pageCapacity: state.layout?.pageCapacity, viewport: { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio }, browser: { secureContext: window.isSecureContext, nativeShare: !!navigator.share, clipboardText: !!navigator.clipboard?.writeText, clipboardImage: !!navigator.clipboard?.write && !!window.ClipboardItem } },
    liveApi: options => provider.getOpenApi(options), health: options => provider.probe(options), apply: applySharedView,
  }, link, tab);
}
window.addEventListener('hashchange', () => {
  if (!bootPending && state.info && location.hash.startsWith('#view=') && !$('.modal-backdrop') && !modelManager?.isOpen() && !configurationManager?.isOpen()) openHelp(location.hash);
});
async function applySharedView(input, { signal, isCurrent }) {
  const view = validateSharedView(input), provider = state.provider, openingIntent = sourceIntent;
  const current = () => isCurrent() && !signal.aborted && !state.authRequired && !state.localUnavailable && !state.generationRequired;
  if (!current() || state.queryLoading || state.loading) throw new Error('Wait for the current view to finish loading.');
  const sources = [...(view.filters.sourceIds || []), ...(view.filters.sourceId && view.filters.sourceId !== 'all' ? [view.filters.sourceId] : [])];
  if (sources.some(id => !state.info.sourceIds.includes(id))) throw new Error('This view references sources unavailable in the active dataset. Choose the matching dataset first.');
  const plot = $('.plot-wrap').getBoundingClientRect(), width = Math.max(100, Math.round(plot.width || $('.primary').clientWidth - 40)), height = Math.max(192, Math.round(plot.height || 400) - 52);
  const settings = view.settings, oldQuery = state.query;
  let prepared;
  state.queryLoading = true; setBusy(true);
  try {
    await modelManager?.suspendPreview();
    prepared = await prepareScaledQuery(provider,
      { domain: view.domain, filters: view.filters, ...view.search, scaleMode: settings.scaleMode, ratio: settings.ratio, bins: settings.bins },
      (query, map) => provider.createLayout(query.queryId, { mapId: map.mapId, from: toIso(view.range.fromMs), to: toIso(view.range.toMs), viewFromMs: view.range.fromMs, viewToMs: view.range.toMs, width, availableHeight: height, rowHeight: settings.rowHeight, fontSize: settings.fontSize, groupBy: settings.groupBy, theme: settings.theme, displayUnit: settings.displayUnit, ...(settings.presentation ? { presentation: settings.presentation } : {}), renderProfileId: 'noto-sans-latin-v1' }, { signal }),
      { optimize: view.scaleStrategy === 'automatic', isCurrent: current });
    if (!prepared || !current()) throw new DOMException('Operation aborted', 'AbortError');
    const { query, map, layout } = prepared;
    const overview = await provider.getOverview(query.queryId, { signal });
    const zones = await provider.getZones(query.queryId, { signal });
    let cursor;
    if (view.selectedId) {
      const placement = await provider.getPlacement(query.queryId, layout.layoutId, view.selectedId, { signal });
      if (!placement.outsideLayout) cursor = placement.cursor;
    }
    const rows = await provider.getRows(query.queryId, layout.layoutId, { cursor, signal });
    const selected = rows.items.find(item => item.record?.id === view.selectedId)?.record || null;
    const fieldTypes = await settingsRegistry(provider, state.info, view.filters);
    if (!current()) throw new DOMException('Operation aborted', 'AbortError');
    if (query.generation !== state.info.generation) throw new Error('The active snapshot changed. Reload it before applying this link.');
    // Publish only after the provider has validated and prepared the complete view.
    ++state.epoch; ++layoutIntent; ++selectionIntent;
    Object.assign(state, settings, { unit: settings.displayUnit, presentation: structuredClone(settings.presentation), fromMs: view.range.fromMs, toMs: view.range.toMs, domain: structuredClone(view.domain), filter: structuredClone(view.filters), ...view.search, searchFields: view.search.searchFields, scaleStrategy: view.scaleStrategy, query, map, layout, rows, overview, zones: zones.items || [], selected, fieldTypes, stale: false });
    for (const [key, value] of Object.entries(settings)) rememberSetting(key, value);
    rememberSetting('overview', state.domain); rememberSetting('range', rangeIso()); rememberSetting('search', searchSettings());
    rememberSetting('filterId', state.filter.filterId ?? null); rememberSetting('filterVersion', state.filter.filterVersion ?? null);
    $('#source-filter').value = state.filter.sourceId || 'all'; $('#kind-filter').value = state.filter.kind || 'all'; $('#search').value = state.search;
    app.classList.toggle('dark', state.theme === 'dark');
    state.queryLoading = false; setBusy(false); setView(view.view, { refresh: false });
    changeMonitor.acknowledge(query); renderDescriptor(); render();
    if (oldQuery?.queryId && oldQuery.queryId !== query.queryId) await provider.releaseQuery(oldQuery.queryId).catch(() => {});
    if (view.view !== 'table') setTimeout(() => refreshLayout(), 0);
  } finally {
    if (prepared && state.query?.queryId !== prepared.query.queryId) await provider.releaseQuery(prepared.query.queryId).catch(() => {});
    if (provider === state.provider && openingIntent === sourceIntent) { state.queryLoading = false; setBusy(false); }
  }
}
function openModels() {
  if (state.authRequired) { toast('Reconnect with valid authorization to manage models.'); return; }
  closeDialog();
  if (modelManager?.isOpen()) return;
  const provider = state.provider, generation = state.info.generation, openingIntent = sourceIntent;
  const isCurrent = (origin, originGeneration) => state.provider === origin && state.info.generation === originGeneration && sourceIntent === openingIntent && !state.authRequired && !state.generationRequired && !state.localUnavailable;
  const manager = openModelManager({
    provider, generation, isCurrent, sourceName: state.info.sourceName, local: isLocal(), readOnly: legacyReadOnly(), defaultDefinition: currentDefinition(), updateIcons,
    recoveryKey: isLocal() ? provider.identity : `server:${provider.baseUrl || location.origin}:${provider.workspaceId}`,
    onClose: () => { if (modelManager === manager) modelManager = null; },
    onAuthorizationError: showError,
    createPreview: (container, axis, definition) => createModelPreview({ provider, generation, isCurrent, container, axis, definition, domain: { ...state.domain }, fromMs: state.fromMs, toMs: state.toMs, filters: structuredClone(state.filter), sourceIds: state.info.sourceIds, ...searchOptions() }),
    onMutation: async (result, type, modelId) => {
      if (!isCurrent(provider, generation)) return;
      state.info = { ...state.info, settings: result.settings, revision: result.revision };
      if (result.model) state.info.models = [...(state.info.models || []).filter(m => m.id !== result.model.id), result.model];
      else if (type === 'delete') state.info.models = (state.info.models || []).filter(m => m.id !== modelId);
      if (result.durability === 'memory-only') state.dirty = true;
      updateStatus();
    },
    onApply: async settings => {
      if (!isCurrent(provider, generation)) return;
      Object.assign(state, { theme: settings.theme, rowHeight: settings.rowHeight, fontSize: settings.fontSize, groupBy: settings.groupBy, unit: settings.displayUnit, timeZone: settings.timeZone, scaleMode: settings.scaleMode, ratio: settings.ratio, bins: settings.bins });
      state.presentation = structuredClone(settings.presentation);
      state.transient = resetTransientSettings(state.transient, [...Object.keys(currentDefinition()), 'modelId', 'modelVersion']);
      state.preferencesDirty = Object.keys(state.transient).length > 0; app.classList.toggle('dark', state.theme === 'dark');
      await refreshQuery(); if (state.selected) renderDescriptor();
    },
  });
  modelManager = manager;
}
async function openConfigurations() {
  if (configurationManager?.isOpen()) return;
  if (!state.info.actor || typeof state.provider.listConfiguration !== 'function') return;
  await modelManager?.close(); if (modelManager?.isOpen()) return;
  closeDialog();
  const provider = state.provider, generation = state.info.generation, actor = state.info.actor;
  const current = () => state.provider === provider && state.info.generation === generation && state.info.actor?.id === actor.id && !state.authRequired && !state.generationRequired && !state.localUnavailable;
  const manager = openConfigurationManager({
    provider, generation, actor, local: isLocal(), sourceName: state.info.sourceName,
    models: state.info.models || [], settings: state.info.settings, isCurrent: current, updateIcons,
    transientSettings: () => current() ? structuredClone(state.transient) : {},
    onClose: () => { if (configurationManager === manager) configurationManager = null; },
    onAuthorizationError: error => { if (current()) showError(error); },
    onMutation: async result => {
      if (!current()) return;
      if (result.durability === 'memory') state.dirty = true;
      state.info = { ...state.info, revision: result.revision };
      const info = await provider.getStatus(); if (!current() || info.generation !== generation) return;
      state.info = info;
      const sourceIds = info.sourceIds || [];
      $('#source-filter').innerHTML = '<option value="all">All sources</option>' + sourceIds.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      if (!sourceIds.includes(state.filter.sourceId)) state.filter.sourceId = 'all'; $('#source-filter').value = state.filter.sourceId;
      updateStatus();
    },
    validateApply: async ({ family, definition, resource, version }) => {
      if (family === 'views' && definition.settings.collapsedGroups?.length) throw new Error('This view requires canonical group collapse, which is not implemented yet. No preference was changed.');
      const input = family === 'views' ? { viewId: resource.id, viewVersion: version } : { transient: { filterId: resource.id, filterVersion: version, viewId: null, viewVersion: null } };
      const candidate = await provider.getEffectiveSettings(input); if (!current()) throw new Error('Source changed; no preference was changed.');
      const registry = await settingsRegistry(provider, state.info, candidate.values); if (!current()) throw new Error('Source changed; no preference was changed.');
      try { compileExpression(state.filter.expression, { fieldTypes: registry }); }
      catch { throw new Error('Temporary conditions use fields outside this saved filter schema. Clear those conditions before applying; no preference was changed.'); }
    },
    onApply: async (_effective, resetKeys) => {
      if (!current()) return;
      const transient = resetTransientSettings(state.transient, resetKeys);
      const effective = await provider.getEffectiveSettings({ transient }); if (!current() || effective.generation !== generation) return;
      const registry = await settingsRegistry(provider, state.info, effective.values); if (!current()) return;
      state.transient = transient; state.fieldTypes = registry; state.preferencesDirty = Object.keys(transient).length > 0;
      state.info = { ...state.info, settings: effective.values, preferenceRevision: effective.preferenceRevision, defaultsRevision: effective.defaultsRevision, revision: effective.revision };
      adoptSettings(effective.values, { preserveRange: !resetKeys.includes('range') && !resetKeys.includes('overview'), preserveOverview: !resetKeys.includes('overview') });
      const previousQuery = state.query?.queryId;
      await refreshQuery();
      if (current() && state.query?.queryId === previousQuery) throw new Error('The saved preference was confirmed, but the active view did not refresh. Retry the source refresh, not Apply.');
      if (current() && state.selected) renderDescriptor();
    },
  });
  configurationManager = manager;
}
function followRange(range) {
  const next = followingOverview(state.domain, range);
  if (next === state.domain) return false;
  state.domain = next; rememberSetting('overview', next); return true;
}
async function changeRange(range) {
  if (state.localUnavailable || state.authRequired || state.generationRequired) return;
  state.fromMs = range.fromMs; state.toMs = range.toMs;
  const changed = followRange(range);
  rememberSetting('range', rangeIso()); updateOverviewWindow();
  return changed || state.queryLoading || (state.info.legacy?.lazy && !rangeInside(state.map.domain, range)) || (state.scaleMode === 'adaptive' && state.scaleStrategy === 'automatic') ? refreshQuery() : refreshLayout();
}

function bindNavigation() {
  const plot = $('.plot-wrap'); let drag = null, prefetchTimer, prefetched = false;
  const pendingEdge = document.createElement('div'); pendingEdge.className = 'navigation-pending-edge'; pendingEdge.hidden = true;
  pendingEdge.textContent = 'Pending'; pendingEdge.setAttribute('aria-hidden', 'true'); plot.append(pendingEdge);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const rangeKey = range => `${range.fromMs}:${range.toMs}`;
  const current = context => context && context.provider === state.provider && context.query === state.query && context.map === state.map && context.layout === state.layout && context.rows === state.rows && context.epoch === state.epoch && Math.abs(context.width - plot.clientWidth) < 1 && !state.authRequired && !state.generationRequired && !state.localUnavailable;
  const cache = createNavigationLayoutCache({
    prepare: async (context, range, signal) => {
      await layoutQueue;
      if (signal.aborted || !current(context)) return null;
      let layout;
      try {
        layout = await visibleLayout(context.provider, context.query.queryId, context.map.mapId, context.width, context.height, range, { signal, noResize: true });
        const rows = await context.provider.getRows(context.query.queryId, layout.layoutId, { signal });
        return { layout, rows };
      } catch (error) {
        if (layout) await context.provider.releaseLayout(context.query.queryId, layout.layoutId).catch(() => {});
        throw error;
      }
    },
    release: ({ layout }, context) => context.provider.releaseLayout(context.query.queryId, layout.layoutId).catch(() => {}),
  });
  const paint = (value, context) => {
    if (value && !current(context)) { navigation.cancel(); return; }
    const offset = value?.offset || 0;
    if (value && (!context.labelAt || performance.now() - context.labelAt >= 80)) {
      context.rangeLabel ??= $('.range-button').textContent;
      const from = toIso(value.range.fromMs), to = toIso(value.range.toMs);
      $('.range-button').textContent = `${rangeDate(from)} / ${dateLabel(from)} - ${dateLabel(to)}`;
      context.labelAt = performance.now();
    } else if (!value && context.rangeLabel) $('.range-button').textContent = context.rangeLabel;
    if (value && Math.abs(offset - (context.gridOffset || 0)) > context.width * .5) {
      const map = navigationMap(context.map), mapper = time => projectTime(map, time, context.fromMs, context.toMs, context.width);
      const left = navigatePan(context.map, context.fromMs, context.toMs, offset + context.width, context.width).range.fromMs;
      const right = navigatePan(context.map, context.fromMs, context.toMs, offset - context.width, context.width).range.toMs;
      const band = context.rows.presentation?.bands?.primary;
      const ticks = readableTicks(left, right, band?.intervalUnit || state.unit, context.width, time => mapper(time) + offset, band?.dateFormat, false, context.width, map);
      timeline.previewGrid(ticks, mapper);
      context.axisHtml ??= $('.main-axis').innerHTML;
      $('.main-axis').innerHTML = `<div class="axis-tick-layer">${ticks.map(t => `<span style="left:${mapper(t.timeMs)}px" title="${esc(toIso(t.timeMs))}">${esc(t.label)}</span>`).join('')}</div>`;
      context.gridOffset = offset;
    } else if (!value && context.axisHtml) {
      $('.main-axis').innerHTML = context.axisHtml; timeline.previewGrid();
    }
    timeline.previewOffset(offset);
    const ticks = $('.main-axis .axis-tick-layer'), scale = $('.scale-map');
    if (ticks) ticks.style.transform = `translate3d(${offset}px,0,0)`;
    if (scale) for (const piece of scale.children) piece.style.transform = `translateX(${offset}px)`;
    if (state.domain && state.fromMs) {
      const domain = value ? followingOverview(context.previewDomain || state.domain, value.range) : state.domain;
      if (domain !== (context.previewDomain || state.domain)) {
        context.previewDomain = domain; renderOverview(domain);
        if (value) $('.overview-count').textContent = 'Pending context'; else updateStatus();
      }
      updateOverviewWindow(value?.range, domain);
    }
    plot.dataset.navigationOffset = String(offset);
    if (value && windowLoader && (!context.prefetchAt || performance.now() - context.prefetchAt >= 150)) {
      const delta = offset - (context.prefetchOffset || 0), elapsed = performance.now() - (context.prefetchAt || performance.now() - 150);
      windowLoader.request(value.range, state.filter, { direction: -Math.sign(delta), speed: Math.abs(delta) / Math.max(1, elapsed) });
      context.prefetchAt = performance.now(); context.prefetchOffset = offset;
    }
    pendingEdge.hidden = !value || Math.abs(value.constrainedOffset) < 1;
    pendingEdge.style.left = value?.constrainedOffset < 0 ? `${Math.max(0, context.width + value.constrainedOffset)}px` : '0';
    pendingEdge.style.width = `${Math.min(context?.width || 0, Math.abs(value?.constrainedOffset || 0))}px`;
    if (value && motion.phase === 'dragging' && !prefetched) {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => {
        if (motion.phase !== 'dragging' || motion.context !== context || !current(context)) return;
        if (rangeInside(state.map.domain, value.range)) { prefetched = true; cache.request(context, rangeKey(value.range), value.range); }
      }, 180);
    }
  };
  const motion = createNavigationMotion({
    reducedMotion: () => reduced.matches,
    preview: paint,
    changed: phase => { plot.dataset.navigationPhase = phase; if (phase !== 'dragging') clearTimeout(prefetchTimer); },
    canceled: () => { clearTimeout(prefetchTimer); void cache.discard(); },
    settle: async (value, context) => {
      if (!current(context) || motion.context !== context) return;
      setBusy(true);
      if (followingOverview(state.domain, value.range) !== state.domain || !rangeInside(state.map.domain, value.range)) {
        await cache.discard();
        if (!current(context) || motion.context !== context) return;
        // Restore the old grid while its original range is still valid. The
        // replacement viewport may extend beyond this pinned query's map.
        navigation.cancel();
        state.fromMs = value.range.fromMs; state.toMs = value.range.toMs;
        followRange(value.range); rememberSetting('range', rangeIso());
        await refreshQuery(); return;
      }
      let prepared = await cache.take(context, rangeKey(value.range));
      if (prepared && Math.abs(context.height - plot.clientHeight) >= 1) {
        await context.provider.releaseLayout(context.query.queryId, prepared.layout.layoutId).catch(() => {});
        prepared = null;
      }
      if (!current(context) || motion.context !== context) {
        if (prepared) await context.provider.releaseLayout(context.query.queryId, prepared.layout.layoutId).catch(() => {});
        return;
      }
      context.committedRange = value.range;
      state.fromMs = value.range.fromMs; state.toMs = value.range.toMs;
      rememberSetting('range', rangeIso());
      if (prepared) {
        state.layout = prepared.layout; state.rows = prepared.rows; render(); setBusy(false);
        await context.provider.releaseLayout(context.query.queryId, context.layout.layoutId).catch(() => {});
      } else {
        await refreshLayout();
        if (current(context) && motion.context === context) navigation.cancel();
      }
    },
  });
  const releasePointer = previous => { if (previous && plot.hasPointerCapture(previous.pointer)) plot.releasePointerCapture(previous.pointer); };
  navigation = {
    stop() { motion.stop(); },
    cancel() {
      const previous = drag; drag = null; const context = motion.context;
      if (current(context) && context.committedRange && state.fromMs === context.committedRange.fromMs && state.toMs === context.committedRange.toMs) { state.fromMs = context.fromMs; state.toMs = context.toMs; }
      if (motion.active) { ++layoutIntent; setBusy(false); }
      motion.cancel(); releasePointer(previous); plot.style.cursor = '';
    },
    rendered() { const previous = drag; drag = null; motion.cancel({ reset: false }); releasePointer(previous); plot.style.cursor = ''; plot.dataset.navigationOffset = '0'; pendingEdge.hidden = true; },
    get active() { return motion.active; }, get phase() { return motion.phase; },
  };
  plot.addEventListener('pointerdown', e => {
    if (!state.map || !state.layout || state.queryLoading || state.authRequired || state.generationRequired || state.localUnavailable || e.button !== 0 || e.isPrimary === false) return;
    const previous = current(motion.context) ? motion.context : null, initialOffset = previous ? motion.offset : 0;
    const context = { provider: state.provider, query: state.query, map: state.map, layout: state.layout, rows: state.rows, epoch: state.epoch, width: state.layout.width, height: plot.clientHeight, fromMs: previous?.fromMs || state.fromMs, toMs: previous?.toMs || state.toMs };
    if (previous) Object.assign(context, { axisHtml: previous.axisHtml, gridOffset: previous.gridOffset, previewDomain: previous.previewDomain, rangeLabel: previous.rangeLabel });
    if (!current(context)) return;
    ++layoutIntent; prefetched = false; setBusy(false);
    motion.begin(context, createPanProjector(context.map, context.fromMs, context.toMs, context.width), initialOffset);
    state.fromMs = context.fromMs; state.toMs = context.toMs;
    drag = { x: e.clientX, y: e.clientY, initialOffset, id: e.target.closest('[data-record-id]')?.dataset.recordId, moved: !!initialOffset, pointer: e.pointerId };
    plot.setPointerCapture(e.pointerId); e.preventDefault();
  });
  plot.addEventListener('pointermove', e => {
    if (!drag || drag.pointer !== e.pointerId) return; const dx = e.clientX - drag.x;
    if (Math.hypot(dx, e.clientY - drag.y) >= (e.pointerType === 'touch' ? 8 : 4)) drag.moved = true;
    if (drag.moved) { motion.move(drag.initialOffset + dx); plot.style.cursor = 'grabbing'; e.preventDefault(); }
  });
  plot.addEventListener('pointerup', e => {
    if (!drag || drag.pointer !== e.pointerId) return; const completed = drag; drag = null; plot.style.cursor = ''; releasePointer(completed);
    if (completed.moved) motion.release();
    else { navigation.cancel(); if (completed.id) selectRecord(completed.id); }
  });
  plot.addEventListener('pointercancel', () => navigation.cancel());
  plot.addEventListener('lostpointercapture', () => { if (drag) navigation.cancel(); });
  window.addEventListener('blur', () => navigation.cancel());
  document.addEventListener('visibilitychange', () => { if (document.hidden) navigation.cancel(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') navigation.cancel(); }, { capture: true });
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.plot-wrap')) {
      if (motion.phase === 'coasting' && !e.target.closest('button,input,select,textarea,a,summary,.overview-plot')) navigation.stop();
      else navigation.cancel();
    }
  }, { capture: true });
  plot.addEventListener('wheel', e => {
    if (!state.map || state.authRequired) return; navigation.cancel(); e.preventDefault();
    const x = Math.max(0, Math.min(1, (e.clientX - plot.getBoundingClientRect().left) / plot.clientWidth));
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    changeRange(horizontal ? navigatePan(state.map, state.fromMs, state.toMs, -(e.deltaX || e.deltaY), state.layout.width).range : navigateZoom(state.map, state.fromMs, state.toMs, e.deltaY > 0 ? 0.87 : 1.15, x));
  }, { passive: false });
  plot.addEventListener('keydown', e => {
    if (!state.map || state.authRequired || state.generationRequired || state.localUnavailable) return;
    if (['ArrowLeft', 'ArrowRight', '+', '=', '-'].includes(e.key)) navigation.cancel();
    if (e.target.matches('[data-record-id]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectRecord(e.target.dataset.recordId); return; }
    if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); changeRange(navigatePan(state.map, state.fromMs, state.toMs, state.layout.width * (e.key === 'ArrowLeft' ? 0.15 : -0.15), state.layout.width).range); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); handleAction('zoom-in'); }
    if (e.key === '-') { e.preventDefault(); handleAction('zoom-out'); }
  });
  const overview = $('.overview-plot'); let overviewDrag = null;
  overview.addEventListener('pointerdown', e => {
    if (!state.map || state.queryLoading || state.authRequired || state.generationRequired || state.localUnavailable || e.button !== 0) return; const x = e.clientX - overview.getBoundingClientRect().left;
    overviewDrag = { from: state.fromMs, to: state.toMs, time: overviewTime(x), edge: e.target.closest('[data-edge]')?.dataset.edge, body: !!e.target.closest('.overview-window'), x: e.clientX, moved: false };
    overview.setPointerCapture(e.pointerId); e.preventDefault();
  });
  overview.addEventListener('pointermove', e => {
    if (!overviewDrag) return;
    if (Math.abs(e.clientX - overviewDrag.x) >= 4) overviewDrag.moved = true;
    const t = overviewTime(e.clientX - overview.getBoundingClientRect().left);
    try {
      const map = navigationMap(state.map);
      const range = overviewDrag.edge ? overviewResize(map, overviewDrag.from, overviewDrag.to, overviewDrag.edge === 'left' ? 'start' : 'end', t) : overviewBodyDrag(map, overviewDrag.from, overviewDrag.to, overviewDrag.time, t);
      state.fromMs = range.fromMs; state.toMs = range.toMs; updateOverviewWindow();
      windowLoader?.request(range, state.filter);
    } catch { /* Crossing handles leaves the last valid viewport intact. */ }
  });
  overview.addEventListener('pointerup', e => {
    if (!overviewDrag) return;
    const completed = overviewDrag; overviewDrag = null;
    if (!completed.moved && !completed.body && !completed.edge) {
      const map = navigationMap(state.map);
      const center = invertPosition(map, state.layout.width / 2, completed.from, completed.to, state.layout.width);
      const target = overviewTime(e.clientX - overview.getBoundingClientRect().left);
      changeRange(overviewBodyDrag(map, completed.from, completed.to, center, target));
    } else changeRange({ fromMs: state.fromMs, toMs: state.toMs });
  });
  overview.addEventListener('pointercancel', () => { if (overviewDrag) { state.fromMs = overviewDrag.from; state.toMs = overviewDrag.to; overviewDrag = null; updateOverviewWindow(); } });
  overview.addEventListener('keydown', e => {
    if (!state.map || state.authRequired || state.generationRequired || state.localUnavailable) return;
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault();
    const edge = e.target.dataset.edge; const step = decimal(state.toMs).minus(state.fromMs).times(e.shiftKey ? 0.1 : 0.02).times(e.key === 'ArrowRight' ? 1 : -1);
    if (edge) changeRange(overviewResize(navigationMap(state.map), state.fromMs, state.toMs, edge === 'left' ? 'start' : 'end', decimal(edge === 'left' ? state.fromMs : state.toMs).plus(step).toString()));
    else changeRange(navigatePan(state.map, state.fromMs, state.toMs, state.layout.width * (e.key === 'ArrowLeft' ? 0.1 : -0.1), state.layout.width).range);
  });
}

function openDialog(title, content, { wide = false } = {}) {
  closeDialog(false); dialogOpener = document.activeElement;
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="panel-heading"><h2 id="dialog-title">${esc(title)}</h2>${button('close-modal', 'x', 'Close dialog')}</div>${content}</section>`;
  document.body.append(backdrop); updateIcons();
  backdrop.querySelector('[data-action="close-modal"]').onclick = () => closeDialog();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeDialog(); });
  backdrop.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    if (e.key === 'Tab') { const items = [...backdrop.querySelectorAll('button,input,select,textarea,a[href],summary,iframe')].filter(el => !el.disabled && el.getClientRects().length); const first = items[0], last = items.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  });
  setTimeout(() => backdrop.querySelector('input,select,button')?.focus(), 0);
  return backdrop;
}
function closeDialog(restore = true) { const dialog = $('.modal-backdrop'); dialog?.dispatchEvent(new Event('dialog-close')); dialog?.remove(); if (restore) dialogOpener?.focus?.(); }
function formError(form, error) { form.querySelector('.form-error')?.remove(); const node = document.createElement('div'); node.className = 'form-error'; node.setAttribute('role', 'alert'); node.textContent = error.message || String(error); form.append(node); }

function openEditor(record = null, duplicate = false) {
  if (legacyReadOnly()) { toast('Legacy JSON records are read-only.'); return; }
  if (recordRecovery?.pending().length) { recordRecovery.open(); return; }
  const originProvider = state.provider, originGeneration = state.info.generation;
  const originRecovery = recordRecovery;
  let uncertainCommand = null, writeConfirmed = false;
  const creating = !record || duplicate; const start = record?.start || toIso(state.fromMs);
  const dialog = openDialog(creating ? 'Create record' : 'Edit record', `<form id="record-form"><div class="form-grid"><label class="full">Title<input name="title" required maxlength="500" value="${esc(record?.title || '')}"></label><label>Type<select name="kind"><option value="event" ${record?.kind === 'session' ? '' : 'selected'}>Event</option><option value="session" ${record?.kind === 'session' ? 'selected' : ''}>Session</option></select></label><label>Source<input name="sourceId" required value="${esc(record?.sourceId || state.info.sourceIds?.[0] || 'default')}"></label><label>Start / UTC<input type="datetime-local" name="start" step="0.001" required value="${dateInput(start)}"></label><label class="end-field">End / UTC<input type="datetime-local" name="end" step="0.001" value="${dateInput(record?.end)}"></label><label class="check-label full"><input name="ongoing" type="checkbox" ${record?.kind === 'session' && !record.end ? 'checked' : ''}>Ongoing session</label><label>Color<input name="color" type="color" value="${esc(record?.render?.color || '#397aa6')}"></label><label>Parent session ID<input name="parentSessionId" value="${esc(record?.parentSessionId || '')}" placeholder="Optional UUID"></label><label class="full">Notes<textarea name="notes">${esc(record?.data?.description || '')}</textarea></label></div><div class="modal-actions"><button type="button" id="cancel-edit">Cancel</button><button type="submit" class="primary-button">${icon('check')}${creating ? 'Create' : 'Save changes'}</button></div><p class="subtle">${isLocal() ? 'Local changes stay in memory until JSON is exported.' : 'Changes are saved through the JSON-backed server.'}</p></form>`);
  const form = dialog.querySelector('form'); const fields = form.elements;
  setDateInput(fields.start, start); setDateInput(fields.end, record?.end, record?.end || start);
  originRecovery.warning(form);
  const updateEnd = () => { const session = fields.kind.value === 'session'; fields.ongoing.disabled = !session; fields.end.disabled = !session || fields.ongoing.checked; fields.end.required = session && !fields.ongoing.checked; };
  fields.kind.disabled = !creating; fields.kind.onchange = updateEnd; fields.ongoing.onchange = updateEnd; updateEnd();
  dialog.querySelector('#cancel-edit').onclick = () => closeDialog();
  form.onsubmit = async e => {
    e.preventDefault(); const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try {
      if (state.provider !== originProvider || state.info.generation !== originGeneration) throw new Error('This draft belongs to the previous source. Its data has not been written to the current source. Reconnect to the original source before resolving it.');
      if (state.authRequired) throw new Error('Server authorization is required before this draft can be saved.');
      if (state.localUnavailable) throw new Error('The Local source is unavailable. Keep this draft open until its contents are recovered.');
      const payload = { kind: fields.kind.value, title: fields.title.value.trim(), start: inputIso(fields.start.value), end: fields.kind.value === 'event' || fields.ongoing.checked ? null : inputIso(fields.end.value), sourceId: fields.sourceId.value.trim(), parentSessionId: fields.parentSessionId.value.trim() || null, order: record?.order || 0, groupIds: record?.groupIds || [], tags: record?.tags || [], extensions: record?.extensions || {}, schemaId: record?.schemaId || null, schemaVersion: record?.schemaVersion || null, originalStart: record?.originalStart || null, originalEnd: record?.originalEnd || null, render: { ...record?.render, color: fields.color.value }, data: { ...record?.data, description: fields.notes.value } };
      if (creating) { delete payload.id; delete payload.version; delete payload.createdAt; delete payload.updatedAt; delete payload.deletedAt; }
      if (payload.end && toMs(payload.end) < toMs(payload.start)) throw new Error('End must be at or after start.');
      const command = { generation: originGeneration, type: creating ? 'create' : 'update', recordId: creating ? undefined : record.id, expectedVersion: creating ? undefined : record.version, payload, clientCommandId: crypto.randomUUID() };
      let result;
      try { result = await originRecovery.execute(command); } catch (error) { if (error.code === 'write_outcome_unknown') uncertainCommand = command; throw error; }
      writeConfirmed = true;
      if (state.provider !== originProvider || state.info.generation !== originGeneration) {
        if (form.isConnected) formError(form, new Error('The write was confirmed on its original source. The currently active source has not been changed.'));
        toast('Write confirmed on the original source. Current source unchanged.');
        return;
      }
      state.dirty = !(originProvider instanceof ServerProvider); state.info = { ...state.info, revision: result.revision, recordCount: state.info.recordCount + (creating ? 1 : 0) }; state.selected = result.record;
      closeDialog(); await refreshQuery(); renderDescriptor(); toast(result.durability === 'memory-only' ? 'Record updated in memory. JSON export pending.' : 'Record saved on the server.');
    } catch (error) {
      formError(form, error);
      if (uncertainCommand && !form.querySelector('.outcome-check')) {
        originRecovery.attachOutcome(form, uncertainCommand.clientCommandId);
      }
    } finally { submit.disabled = !!uncertainCommand || writeConfirmed || originRecovery.pending().length > 0; originRecovery.warning(form); }
  };
}
function openDelete() {
  if (legacyReadOnly()) { toast('Legacy JSON records are read-only.'); return; }
  if (recordRecovery?.pending().length) { recordRecovery.open(); return; }
  const record = state.selected;
  const originProvider = state.provider, originGeneration = state.info.generation;
  const originRecovery = recordRecovery;
  const dialog = openDialog('Delete record', `<p>Delete <strong>${esc(record.title)}</strong>?</p><p class="subtle">The provider retains a tombstone. A parent with active children cannot be deleted by this command.</p><div class="modal-actions"><button id="cancel-delete">Cancel</button><button class="danger" id="confirm-delete">${icon('trash-2')}Delete record</button></div>`);
  dialog.querySelector('#cancel-delete').onclick = () => closeDialog();
  originRecovery.warning(dialog.querySelector('.modal'));
  dialog.querySelector('#confirm-delete').onclick = async e => {
    const submit = dialog.querySelector('#confirm-delete'); submit.disabled = true;
    const command = { generation: originGeneration, type: 'delete', recordId: record.id, expectedVersion: record.version, clientCommandId: crypto.randomUUID() };
    let confirmed = false;
    try {
      if (state.provider !== originProvider || state.info.generation !== originGeneration || state.authRequired) throw new Error('This deletion belongs to a different source or generation. Reopen the record on the intended source.');
      if (state.localUnavailable) throw new Error('The Local source is unavailable. No deletion was sent.');
      const result = await originRecovery.execute(command); confirmed = true;
      if (state.provider !== originProvider || state.info.generation !== originGeneration) {
        if (dialog.isConnected) formError(dialog.querySelector('.modal'), new Error('Deletion confirmed on the original source. The currently active source was not changed.'));
        toast('Deletion confirmed on the original source. Current source unchanged.'); return;
      }
      state.dirty = isLocal(); state.info = { ...state.info, revision: result.revision, recordCount: Math.max(0, state.info.recordCount - 1) };
      state.selected = null; renderDescriptor(); closeDialog(); await refreshQuery(); toast('Record deleted.');
    } catch (error) {
      if (dialog.isConnected) { formError(dialog.querySelector('.modal'), error); if (error.code === 'write_outcome_unknown') originRecovery.attachOutcome(dialog.querySelector('.modal'), command.clientCommandId); }
      submit.disabled = confirmed || error.code === 'write_outcome_unknown' || originRecovery.pending().length > 0;
    }
  };
}
function calendarUnit() { return displayedTimeUnit || state.rows?.presentation?.bands?.primary?.intervalUnit || state.unit; }
function timelineCenter() { return invertPosition(navigationMap(state.map), .5, state.fromMs, state.toMs, 1); }
function closeCalendar(restore = true) {
  calendar?.close(); calendar = null;
  document.querySelectorAll('[data-action="calendar"]').forEach(node => node.setAttribute('aria-expanded', 'false'));
  if (restore) calendarOpener?.focus();
}
function toggleCalendar() {
  if (calendar) { closeCalendar(); return; }
  if (!state.map || state.queryLoading) return;
  navigation?.cancel(); calendarOpener = document.activeElement;
  state.selected = null; renderDescriptor();
  calendar = openTimelineCalendar({ host: $('.workspace'), center: timelineCenter(), unit: calendarUnit(), updateIcons,
    onClose: closeCalendar, openRange: () => { closeCalendar(false); openRange(); },
    onSelect: async target => {
      if (state.authRequired || state.localUnavailable || state.generationRequired) throw new Error('Reconnect the active source before navigating.');
      navigation?.cancel();
      const previous = { query: state.query, fromMs: state.fromMs, toMs: state.toMs, domain: state.domain, transient: structuredClone(state.transient), preferencesDirty: state.preferencesDirty };
      const range = calendarRange(target, timeDecimal(state.toMs).minus(state.fromMs));
      Object.assign(state, range); followRange(range); rememberSetting('range', rangeIso());
      const pending = refreshQuery({ focusTime: target }), epoch = state.epoch;
      await pending;
      if (state.epoch === epoch && state.query === previous.query) {
        Object.assign(state, previous); render();
        throw new Error('Unable to load the selected date. The previous view is retained.');
      }
    },
  });
  calendar.update(timelineCenter(), calendarUnit());
  document.querySelectorAll('[data-action="calendar"]').forEach(node => node.setAttribute('aria-expanded', 'true'));
}
function rangeDate(value) { const date = new Date(value); return date.toLocaleDateString('en-GB', { timeZone: state.timeZone || 'UTC', day: '2-digit', month: 'short', year: 'numeric', ...(date.getUTCFullYear() <= 0 ? { era: 'short' } : {}) }); }
function openRange() {
  const historical = new Date(toIso(state.fromMs)).getUTCFullYear() <= 0 || new Date(toIso(state.toMs)).getUTCFullYear() <= 0;
  const dialog = openDialog('Date and time range', `<form id="range-form"><div class="form-grid"><label class="full">Start / UTC<input name="from" type="${historical ? 'text' : 'datetime-local'}" step="0.001" required value="${dateInput(toIso(state.fromMs))}"></label><label class="full">End / UTC<input name="to" type="${historical ? 'text' : 'datetime-local'}" step="0.001" required value="${dateInput(toIso(state.toMs))}"></label></div><div class="modal-actions"><button type="submit" class="primary-button">${icon('calendar-check')}Apply range</button></div></form>`);
  dialog.querySelector('form').onsubmit = async e => { e.preventDefault(); try { const from = inputIso(e.target.elements.from.value), to = inputIso(e.target.elements.to.value); if (toMs(to) <= toMs(from)) throw new Error('End must be later than start.'); state.fromMs = String(toMs(from)); state.toMs = String(toMs(to)); if (toMs(from) < toMs(state.domain.from) || toMs(to) > toMs(state.domain.to)) { state.domain = { from, to }; rememberSetting('overview', state.domain); } rememberSetting('range', { from, to }); closeDialog(); await refreshQuery(); } catch (error) { formError(e.target, error); } };
}

function openSettings(filtersOnly = false) {
  const models = state.info.models || state.snapshot.models || [];
  const dialog = openDialog(filtersOnly ? 'Filters' : 'Timeline settings', `<form id="settings-form"><div class="form-grid"><label class="full">Search<input name="search" type="search" value="${esc(state.search)}" placeholder="Search events and sessions"></label>${!filtersOnly ? `<label>Preset appearance<select name="model"><option value="custom">Current settings</option>${models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label><label>Appearance<select name="theme">${['light', 'dark', 'classic'].map(v => `<option value="${v}" ${v === state.theme ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label><label>Time scale<select name="scaleMode"><option value="adaptive" ${state.scaleMode === 'adaptive' ? 'selected' : ''}>Automatic</option><option value="uniform" ${state.scaleMode === 'uniform' ? 'selected' : ''}>Uniform</option></select></label><label>Display unit<select name="unit">${UNITS.map(v => `<option value="${v}" ${v === state.unit ? 'selected' : ''}>${v[0] + v.slice(1).toLowerCase()}</option>`).join('')}</select></label><label>Maximum local ratio<input name="ratio" type="number" min="1" max="32" step="any" value="${state.ratio}"></label><label>Density bins<input name="bins" type="number" min="16" max="256" step="1" value="${state.bins}"></label><label>Grouping<select name="groupBy">${[['none', 'None'], ['sourceId', 'Source'], ['kind', 'Record type']].map(([v, label]) => `<option value="${v}" ${v === state.groupBy ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Row height<input name="rowHeight" type="number" min="32" max="128" step="1" value="${state.rowHeight}"></label>` : ''}</div><div class="modal-actions"><button type="button" id="models-command">${icon('panels-top-left')}Model library</button><button type="button" id="source-command">${icon('database')}Sources</button><button type="button" id="new-command">${icon('plus')}Create record</button><button type="submit" class="primary-button">${icon('check')}Apply</button></div><p class="subtle">${isLocal() ? 'View preferences are included in the next JSON export.' : 'View preferences are temporary in this client.'} Display time zone: ${esc(state.timeZone || 'UTC')}.</p></form>`);
  dialog.querySelector('#models-command').onclick = () => openModels(); dialog.querySelector('#source-command').onclick = () => openSources(); dialog.querySelector('#new-command').onclick = () => openEditor();
  if (typeof state.provider.listConfiguration === 'function' && state.info.actor?.capabilities?.some(capability => ['*', 'configuration.read'].includes(capability))) {
    const command = document.createElement('button'); command.type = 'button'; command.id = 'configuration-command'; command.innerHTML = `${icon('sliders-horizontal')}Configuration`;
    command.onclick = () => openConfigurations().catch(showError); dialog.querySelector('.modal-actions').prepend(command); updateIcons();
  }
  const form = dialog.querySelector('form');
  const filterElement = document.createElement('div'); filterElement.className = 'structured-filters';
  form.querySelector('.form-grid').after(filterElement);
  const filterEditor = new FilterEditor(filterElement, { expression: state.filter.expression, ...searchOptions(), fieldTypes: state.fieldTypes, updateIcons });
  if (!filtersOnly) form.elements.model.onchange = () => { const model = models.find(m => m.id === form.elements.model.value); if (model) { const definition = model.versions?.at(-1)?.definition || model; form.elements.theme.value = definition.theme || 'light'; form.elements.rowHeight.value = definition.rowHeight || 32; form.elements.groupBy.value = definition.groupBy || 'none'; } };
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      const { expression, ...search } = filterEditor.value(form.elements.search.value);
      compileExpression(expression, { fieldTypes: state.fieldTypes }); compileSearch(search, { fieldTypes: state.fieldTypes });
      const previous = currentDefinition(), previousSearch = JSON.stringify(searchSettings());
      if (!filtersOnly) {
        for (const key of ['theme', 'scaleMode', 'unit', 'groupBy']) state[key] = form.elements[key].value;
        for (const key of ['ratio', 'bins', 'rowHeight']) state[key] = Number(form.elements[key].value);
        const next = currentDefinition(); for (const key of Object.keys(next)) if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) rememberSetting(key, next[key]);
      }
      Object.assign(state, search); state.filter = { ...state.filter, ...(expression ? { expression } : {}) };
      if (!expression) delete state.filter.expression;
      if (previousSearch !== JSON.stringify(searchSettings())) rememberSetting('search', searchSettings());
      $('#search').value = state.search;
      state.preferencesDirty = true; app.classList.toggle('dark', state.theme === 'dark'); closeDialog(); await refreshQuery();
    } catch (error) { formError(form, error); }
  };
}
async function exportSource() {
  const provider = state.provider, intent = sourceIntent, actor = structuredClone(state.info.actor), transient = structuredClone(state.transient);
  let snapshot = await provider.exportSnapshot();
  if (provider !== state.provider || intent !== sourceIntent) throw new Error('Export canceled because the active source changed.');
  if (!snapshot.manifest.legacy?.readOnly) snapshot = await exportWithPersonalPreferences(snapshot, transient, actor);
  if (provider !== state.provider || intent !== sourceIntent) throw new Error('Export canceled because the active source changed.');
  downloadJson(snapshot, `openbexi-timeline-${new Date().toISOString().slice(0, 10)}.json`);
  updateStatus(); toast('Complete JSON download requested. Keep changes until the downloaded file is verified.');
}
async function openTestDataset(id) {
  const entry = testDatasets.find(item => item.id === id);
  if (!entry) throw new Error('Unknown test dataset');
  const provider = createLocalProvider(entry.snapshot), origin = sourceIntent;
  try { await provider.initialize(); } catch (error) { provider.dispose(); throw error; }
  if (origin !== sourceIntent) { provider.dispose(); return; }
  const retained = localBranch && localBranch.provider !== state.provider && (localBranch.dirty || localBranch.preferencesDirty);
  if ((state.dirty || state.preferencesDirty || retained) && !window.confirm('Open this complete test snapshot and discard unexported changes in active or retained Local sources? Export first to keep them.')) { provider.dispose(); return; }
  if (localBranch && localBranch.provider !== state.provider) localBranch.provider.dispose();
  localBranch = null;
  closeDialog();
  await initialize(provider, entry.snapshot, { preserveView: false });
  if (state.provider === provider) toast(`${entry.title} / Complete local snapshot / ${entry.report.outputRecords} records`);
}
async function resetTestDataset() {
  const id = state.info.origin?.testDataset?.id || state.info.testDataset?.id;
  const entry = testDatasets.find(item => item.id === id);
  if (!entry) throw new Error('The active source is not a bundled test dataset');
  closeDialog(); navigation?.cancel();
  state.transient = {}; state.preferencesDirty = false; state.filter = { sourceId: 'all', kind: 'all' }; state.selected = null;
  adoptSettings(JSON.parse(entry.snapshot).settings);
  $('#source-filter').value = 'all'; $('#kind-filter').value = 'all'; $('.descriptor').hidden = true;
  await refreshQuery();
  toast('Reference view restored. Records were not changed.');
}
async function importFile(file) {
  const request = ++importIntent, origin = sourceIntent;
  const current = () => request === importIntent && origin === sourceIntent;
  if (file.size > LOCAL_LIMITS.bundleBytes) throw new Error('This JSON file exceeds the supported local snapshot size.');
  const snapshot = await file.text();
  if (!current()) return;
  const provider = createLocalProvider(snapshot);
  try { await provider.initialize(); } catch (error) { provider.dispose(); if (current()) throw error; return; }
  if (!current()) { provider.dispose(); return; }
  const retainedChanges = localBranch && localBranch.provider !== state.provider && (localBranch.dirty || localBranch.preferencesDirty);
  if ((state.dirty || state.preferencesDirty || retainedChanges) && !window.confirm('Replace the active source and discard unexported changes in active or retained Local sources? Export first to keep them.')) { provider.dispose(); return; }
  if (localBranch && localBranch.provider !== state.provider && localBranch.provider !== provider) { localBranch.provider.dispose(); localBranch = null; }
  const attempt = sourceIntent + 1;
  closeDialog();
  try { await initialize(provider, snapshot); if (state.provider === provider) toast(`Opened ${file.name}`); }
  catch (error) { if (state.provider !== provider) provider.dispose(); if (sourceIntent === attempt) toast(`Unable to open ${file.name}: ${error.message}`); }
}
function openSources() {
  const info = state.info;
  const dialog = openDialog('Source and connection', `<dl class="source-facts"><dt>Active provider</dt><dd>${isLocal() ? 'Local snapshot' : 'Server'}</dd><dt>Source</dt><dd>${esc(info.sourceName || 'Workspace')}</dd><dt>Records</dt><dd>${info.recordCount == null ? 'Not yet verified' : `${info.recordCount} in ${info.legacy?.lazy ? 'verified archive' : 'declared snapshot'}`}</dd><dt>Snapshot / UTC</dt><dd>${esc(info.snapshotAt || '-')}</dd><dt>Revision</dt><dd>${esc(info.revision)}</dd><dt>Storage</dt><dd>${isLocal() ? 'Browser memory / explicit JSON export' : 'JSON files on server'}</dd></dl>${state.dirty || state.preferencesDirty ? '<div class="warning-box">Local or view changes have not been exported. Switching sources does not upload or synchronize them.</div>' : ''}<section class="source-section"><h3>Local JSON</h3><div class="source-actions"><button id="import-json">${icon('folder-open')}Open JSON</button><button id="export-json">${icon('download')}Export complete JSON</button></div><input id="json-file" type="file" accept=".json,application/json" hidden></section><section class="source-section"><h3>Server connection</h3><form id="server-form"><div class="form-grid"><label class="full">Server URL<input name="baseUrl" type="url" value="${esc(location.protocol === 'file:' ? 'http://127.0.0.1:8765' : location.origin)}" required></label><label class="full">Bearer token<input name="token" type="password" autocomplete="off" required></label></div><div class="modal-actions"><button type="submit" class="primary-button">${icon('plug-zap')}Check connection</button></div></form><p class="subtle">Checking availability never switches the active source or uploads local changes. Tokens stay in memory.</p></section>`);
  const legacy = info.legacy || info.origin?.legacy;
  if (pathCatalog) addPathChooser(dialog);
  if (legacy?.readOnly) {
    const section = document.createElement('section'); section.className = 'source-section';
    section.innerHTML = `<h3>Read-only legacy JSON</h3><dl class="source-facts"><dt>Data status</dt><dd>${esc(legacy.coverage?.state || legacy.status || 'snapshot')}</dd><dt>${legacy.lazy ? 'Initial range start' : 'Archive start'}</dt><dd>${esc(legacy.domain?.from || '-')}</dd><dt>${legacy.lazy ? 'Initial range end' : 'Archive end'}</dt><dd>${esc(legacy.domain?.to || '-')}</dd><dt>Scope</dt><dd>${legacy.lazy ? 'On-demand server windows' : legacy.declaredRange ? 'Exported time interval' : 'Complete configured archive'}</dd></dl>`;
    dialog.querySelector('.source-facts').after(section);
    if (info.capabilities?.legacyReload && state.provider instanceof ServerProvider) {
      const provider = state.provider, reload = document.createElement('button');
      reload.innerHTML = `${icon('refresh-cw')}<span>Rescan JSON files</span>`;
      section.append(reload);
      reload.onclick = async () => {
        reload.disabled = true;
        try {
          await provider.reloadLegacy();
          if (state.provider !== provider || !reload.isConnected) return;
          closeDialog(); await reloadCommittedSource({ provider }); openSources();
        } catch (error) { if (reload.isConnected) { reload.disabled = false; formError(section, error); } }
      };
    }
  }
  dialog.querySelector('#import-json').onclick = () => dialog.querySelector('#json-file').click();
  dialog.querySelector('#export-json').disabled = !!state.localUnavailable;
  dialog.querySelector('#export-json').onclick = async () => { try { await exportSource(); openSources(); } catch (error) { formError(dialog.querySelector('.modal'), error); } };
  dialog.querySelector('#json-file').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { await importFile(file); } catch (error) { formError(dialog.querySelector('.modal'), error); }
  };
  dialog.querySelector('#server-form').onsubmit = async e => {
    e.preventDefault(); const form = e.target, submit = form.querySelector('[type=submit]'); submit.disabled = true;
    const origin = sourceIntent; let provider;
    try {
      provider = new ServerProvider({ baseUrl: form.elements.baseUrl.value, token: form.elements.token.value, workspaceId: 'default' });
      const info = await provider.initialize({ timeout: 2500 });
      if (!form.isConnected || origin !== sourceIntent) { provider.dispose(); return; }
      state.pendingServer = { provider, info }; openComparison();
    } catch (error) { provider?.dispose(); if (form.isConnected && origin === sourceIntent) formError(form, error); } finally { submit.disabled = false; }
  };
  updateIcons();
}
function preferenceStorage() { try { return localStorage; } catch { return null; } }
function persistPaths() {
  if (!savePathPreferences(preferenceStorage(), location.origin, pathPreferences)) toast('Path preferences could not be saved in this browser.');
}
function updatePathShortcut() {
  const select = $('#path-shortcut'); if (!select) return;
  select.hidden = !pathCatalog;
  if (!pathCatalog) return;
  const selected = state.provider?.localBrowser ? state.filter.sourceIds || pathPreferences.selected : [];
  const favorites = pathCatalog.sources.filter(source => pathPreferences.favorites.includes(source.id));
  const options = `<option value="selected">${selected.length} selected paths</option><option value="all">All approved paths</option>${favorites.map(source => `<option value="${esc(source.id)}">${esc(source.path)}</option>`).join('')}<option value="choose">Choose paths...</option>`;
  if (select.dataset.options !== options) { select.innerHTML = options; select.dataset.options = options; }
  select.value = selected.length === 1 && favorites.some(source => source.id === selected[0]) ? selected[0] : 'selected';
  select.title = pathCatalog.sources.filter(source => selected.includes(source.id)).map(source => source.path).join('\n') || 'Choose approved server paths';
}
async function applyPaths(selected) {
  const allowed = new Set(pathCatalog.sources.map(source => source.id));
  if (!Array.isArray(selected) || selected.some(id => !allowed.has(id))) throw new Error('Select an approved server path.');
  if (!state.provider?.localBrowser && (state.dirty || state.preferencesDirty) && !window.confirm('Switch to read-only server paths without uploading local changes?')) { updatePathShortcut(); return; }
  pathPreferences.selected = [...new Set(selected)]; persistPaths();
  closeDialog();
  if (!state.provider?.localBrowser) {
    await initialize(new ServerProvider({ baseUrl: location.origin, localBrowser: true }));
  } else {
    ++selectionIntent; state.selected = null; renderDescriptor();
    state.filter.sourceId = 'all'; state.filter.sourceIds = [...pathPreferences.selected]; $('#source-filter').value = 'all';
    updatePathShortcut(); await refreshQuery();
  }
}
function setGrouping(mode) {
  if (!['all', 'namespace'].includes(mode) || !state.info || state.authRequired || state.localUnavailable) return;
  navigation?.cancel(); state.groupBy = 'none'; state.presentation = groupedPresentation(state.presentation, mode);
  rememberSetting('groupBy', state.groupBy); rememberSetting('presentation', state.presentation);
  $('#grouping-mode').value = mode;
  refreshLayout();
}
function addPathChooser(dialog) {
  const server = dialog.querySelector('#server-form').closest('section');
  const advanced = document.createElement('details'); advanced.className = 'remote-connection';
  advanced.innerHTML = '<summary>Remote server connection</summary>'; server.before(advanced); advanced.append(server);
  const section = document.createElement('section'); section.className = 'source-section source-paths';
  section.innerHTML = `<h3>Server paths</h3><form id="path-form"><div class="path-list">${pathCatalog.sources.map(source => `<div class="path-choice"><label><input type="checkbox" name="path" value="${esc(source.id)}" ${pathPreferences.selected.includes(source.id) ? 'checked' : ''}><span><strong>${esc(source.namespace)}</strong><span class="path-name">${esc(source.path)}</span><small>${esc(source.template)}</small></span></label><button type="button" class="path-favorite" data-path-id="${esc(source.id)}" aria-label="Favorite ${esc(source.path)}" title="Favorite ${esc(source.path)}" aria-pressed="${pathPreferences.favorites.includes(source.id)}">${icon('star')}</button></div>`).join('')}</div><div class="modal-actions"><button type="button" id="select-paths">${icon('list-checks')}Select all</button><button type="submit" class="primary-button">${icon('check')}Use selected paths</button></div></form>`;
  dialog.querySelector('.source-facts').before(section);
  section.querySelector('#select-paths').onclick = () => { for (const node of section.querySelectorAll('[name=path]')) node.checked = true; };
  for (const node of section.querySelectorAll('.path-favorite')) node.onclick = () => {
    const id = node.dataset.pathId, favorites = new Set(pathPreferences.favorites);
    if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
    pathPreferences.favorites = [...favorites]; node.setAttribute('aria-pressed', String(favorites.has(id))); persistPaths(); updatePathShortcut();
  };
  section.querySelector('form').onsubmit = async event => {
    event.preventDefault(); const submit = section.querySelector('[type=submit]'); submit.disabled = true;
    try { await applyPaths([...section.querySelectorAll('[name=path]:checked')].map(node => node.value)); }
    catch (error) { if (section.isConnected) formError(section, error); else showError(error); }
    finally { submit.disabled = false; }
  };
}
function showLegacyCoverage(status = state.info?.legacy?.coverage) {
  if (!state.info?.legacy?.lazy || !status) return;
  const band = $('.server-startup'), partial = state.query?.coverage?.complete === false;
  band.hidden = status.complete && !partial;
  if (band.hidden) return;
  band.querySelector('span').textContent = status.complete
    ? 'Archive index ready. Refresh this view to include verified earlier sessions and automatic scaling.'
    : `Real source / ${status.indexedFiles ?? 0} files indexed. ${status.state === 'failed' || status.rejectedFiles ? 'Some archive data could not be verified.' : 'Checking older sessions in the background.'} Coverage and counts are provisional; automatic scaling is pending.`;
  const retry = band.querySelector('button'); retry.hidden = !status.complete; retry.disabled = false;
  retry.title = 'Refresh verified view'; retry.setAttribute('aria-label', 'Refresh verified view');
  retry.onclick = () => { void refreshQuery(); };
}
function monitorLegacyLoading(provider) {
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(async () => {
    if (provider !== state.provider || !state.info?.legacy?.lazy) return;
    try {
      const status = await provider.getLoadingStatus();
      if (provider !== state.provider) return;
      state.info.legacy.coverage = status;
      state.info.recordCount = status.recordCount;
      showLegacyCoverage(status);
    } catch { /* A loading-status failure must not erase the retained view. */ }
    if (provider === state.provider) monitorLegacyLoading(provider);
  }, 2000);
}
function scheduleLegacyOverview(provider, epoch) {
  clearTimeout(overviewTimer); overviewRequest?.abort();
  const domain = structuredClone(state.domain), filters = structuredClone(state.filter), search = searchOptions();
  $('.overview-count').textContent = 'Loading broader context';
  overviewTimer = setTimeout(async () => {
    if (provider !== state.provider || epoch !== state.epoch) return;
    const controller = overviewRequest = new AbortController(), options = { signal: controller.signal };
    let query;
    const current = () => provider === state.provider && epoch === state.epoch && !controller.signal.aborted;
    try {
      query = await provider.createQuery({ domain, filters, ...search, scaleMode: 'uniform', ratio: 1, bins: 64 }, options);
      const overview = await provider.getOverview(query.queryId, options);
      const zones = await provider.getZones(query.queryId, options);
      if (!current()) return;
      // Hold fresh context during a gesture; never move its map or geometry.
      while (navigation?.active && current()) await new Promise(resolve => setTimeout(resolve, 100));
      if (!current()) return;
      state.overview = overview; state.overviewZones = zones.items;
      renderOverview(); updateStatus();
    } catch (error) {
      if (current()) $('.overview-count').textContent = 'Broader context unavailable; visible data retained';
    } finally { if (query) await provider.releaseQuery(query.queryId).catch(() => {}); }
  }, 350);
}
async function startConfiguredServer(target) {
  configuredServer = true;
  startupDiscovery?.abort();
  const controller = startupDiscovery = new AbortController(), band = $('.server-startup');
  const show = (message, retry = false) => {
    band.hidden = false; band.querySelector('span').textContent = message;
    const button = band.querySelector('button'); button.hidden = !retry; button.disabled = false;
    button.title = 'Retry server connection'; button.setAttribute('aria-label', 'Retry server connection');
    button.onclick = async () => { await startConfiguredServer(await startupTarget()); };
  };
  $('.provider-status').textContent = `${target.sourceName} / Loading`;
  if (target.range) $('.range-button').textContent = `${new Date(target.range.from).toLocaleDateString('en-GB', { timeZone: 'UTC' })} / ${dateLabel(target.range.from)} - ${dateLabel(target.range.to)}`;
  show(`Opening ${target.sourceName}. Waiting for the configured source.`);
  if (target.mode === 'unavailable') { show('Configured server unavailable. Retry to reconnect. No sample dataset has been loaded.', true); return; }
  try {
    const result = await discoverStartupCatalog({ signal: controller.signal, onProgress: progress => {
      show(`${target.sourceName} / ${startupMessage(progress).replace('. Local snapshot remains active.', '.')}`);
    } });
    if (controller.signal.aborted) return;
    if (result.state !== 'ready') {
      show(result.state === 'failed' ? 'Configured source initialization failed. Check the server log and retry.' : 'Configured source is not ready. Retry to reconnect.', true); return;
    }
    pathCatalog = result.catalog;
    pathPreferences = loadPathPreferences(preferenceStorage(), location.origin, pathCatalog.sources);
    updatePathShortcut();
    await initialize(new ServerProvider({ baseUrl: location.origin, localBrowser: true }));
    if (state.info?.legacy?.lazy) showLegacyCoverage(); else band.hidden = true;
  } catch (error) { show(`Unable to open configured source: ${error.message}. Retry to reconnect.`, true); }
}
async function discoverLocalPaths() {
  if (location.protocol !== 'http:') return;
  startupDiscovery?.abort();
  const intent = sourceIntent, controller = startupDiscovery = new AbortController(), band = $('.server-startup');
  const current = () => startupDiscovery === controller && sourceIntent === intent && !controller.signal.aborted;
  let observedStartup = false;
  band.hidden = true;
  band.querySelector('button').onclick = () => { void discoverLocalPaths(); };
  const show = (message, retry = false) => {
    band.hidden = false; band.querySelector('span').textContent = message; band.querySelector('button').hidden = !retry;
  };
  try {
    const result = await discoverStartupCatalog({ signal: controller.signal, onProgress: progress => {
      if (!current()) { controller.abort(); return; }
      observedStartup = true; show(startupMessage(progress));
    } });
    if (!current()) { if (startupDiscovery === controller) band.hidden = true; return; }
    if (result.state !== 'ready') {
      if (result.state === 'failed') show('Server data initialization failed. Local snapshot remains active. Check the server log and restart.', true);
      else if (observedStartup || pathCatalog) show(result.state === 'timeout'
        ? 'Server is taking longer than expected. Local snapshot remains active. Retry to check startup.'
        : 'Server unavailable. Local snapshot remains active. Retry when the server is available.', true);
      return;
    }
    const { catalog } = result;
    pathCatalog = catalog; pathPreferences = loadPathPreferences(preferenceStorage(), location.origin, catalog.sources); updatePathShortcut();
    if (!state.dirty && !state.preferencesDirty && !changeRefreshBlocked()) {
      show('Server data ready. Connecting to server paths.');
      await initialize(new ServerProvider({ baseUrl: location.origin, localBrowser: true }));
      band.hidden = true;
    } else {
      show('Server data ready. Local snapshot remains active; select server paths in Sources.', true);
      const connect = band.querySelector('button'); connect.title = 'Choose source'; connect.setAttribute('aria-label', 'Choose source');
      connect.innerHTML = icon('database'); connect.onclick = () => { band.hidden = true; openSources(); }; updateIcons();
    }
  } catch { if (startupDiscovery === controller) show('Unable to connect to server paths. Check Sources and retry.', true); }
}
function openComparison() {
  const pending = state.pendingServer; if (!pending) return;
  const dialog = openDialog('Source comparison', `<div class="warning-box">Server available. ${isLocal() ? 'Local remains active.' : 'The current source remains active.'} No upload is queued and automatic synchronization is off.</div><table class="comparison"><thead><tr><th>Snapshot</th><th>Active source</th><th>Server</th></tr></thead><tbody><tr><td>Revision</td><td>${esc(state.info.revision)}</td><td>${esc(pending.info.revision)}</td></tr><tr><td>Records</td><td>${state.info.recordCount}</td><td>${pending.info.recordCount}</td></tr><tr><td>Workspace</td><td>${esc(state.info.workspaceId)}</td><td>${esc(pending.info.workspaceId)}</td></tr></tbody></table><p class="subtle">Counts may cover different scopes. They are not an additions/deletions comparison.</p>${state.dirty || state.preferencesDirty ? '<div class="warning-box">Unexported changes are active. Export them or explicitly discard them before switching.</div>' : ''}<div class="modal-actions"><button id="stay-source">Stay on current source</button><button id="export-before-switch">${icon('download')}Export JSON</button><button id="switch-source" class="primary-button">${icon('arrow-right-left')}Switch to server</button></div>`);
  dialog.querySelector('#stay-source').onclick = () => { pending.provider.dispose?.(); state.pendingServer = null; closeDialog(); };
  dialog.querySelector('#export-before-switch').onclick = async () => { try { await exportSource(); openComparison(); } catch (error) { formError(dialog.querySelector('.modal'), error); } };
  dialog.querySelector('#switch-source').onclick = async () => {
    if ((state.dirty || state.preferencesDirty) && !window.confirm('Switch sources without uploading unexported changes? Export a complete JSON snapshot first to keep them.')) return;
    const attempt = sourceIntent + 1;
    try { state.pendingServer = null; closeDialog(); await initialize(pending.provider); if (state.provider === pending.provider) toast('Server source active.'); }
    catch (error) {
      if (sourceIntent !== attempt) return;
      if (state.provider === pending.provider) showError(error);
      else toast(`Unable to switch source: ${error.message}`);
    }
  };
}

window.addEventListener('beforeunload', e => { if (state.dirty || state.preferencesDirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', event => {
  startupDiscovery?.abort();
  clearTimeout(loadingTimer); clearTimeout(overviewTimer); overviewRequest?.abort(); windowLoader?.dispose();
  if (!event.persisted && state.provider?.localBrowser) { state.provider.releaseNavigationQuery(state.query?.queryId); state.provider.dispose(); }
});
document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => { if (e.dataTransfer?.files.length) { e.preventDefault(); if (!bootPending && state.info) importFile(e.dataTransfer.files[0]).catch(showError); } });
window.addEventListener('error', e => { if (app && !state.info) { finishBoot(); app.innerHTML = `<p class="boot-status" role="alert">Unable to open timeline: ${esc(e.message)}</p>`; } });
Object.defineProperty(window, '__timelineDebug', { get: () => Object.freeze({
  providerKind: isLocal() ? 'local' : 'server', executionMode: state.provider?.executionMode ?? 'server',
  ready: !!state.query && !state.queryLoading && !state.loading && !state.searchPending && !navigation?.active && !state.authRequired && !state.localUnavailable && !state.generationRequired,
  providerId: state.provider?.identity, generation: state.info?.generation, sourceName: state.info?.sourceName,
  testDatasetId: state.info?.origin?.testDataset?.id || state.info?.testDataset?.id,
  bandCount: state.presentation?.bandLayout?.length || 2, recordCount: state.info?.recordCount,
  queryId: state.query?.queryId, layoutId: state.layout?.layoutId, mapId: state.map?.mapId,
  fromMs: state.fromMs, toMs: state.toMs, domain: state.domain ? { ...state.domain } : null,
  centerMs: state.map && state.fromMs !== null ? timelineCenter() : null,
  startRow: state.rows?.startRow, endRow: state.rows?.endRow, totalRows: state.rows?.totalRows,
  loadedCount: state.rows?.loadedCount, detailTotal: state.layout?.detailTotal, overviewTotal: state.overview?.total,
  pageCapacity: state.layout?.pageCapacity, layoutWidth: state.layout?.width, overviewMatched: state.overview?.matched,
  selectedId: state.selected?.id, search: state.search, scaleMode: state.scaleMode, dirty: state.dirty, view: state.view,
  scaleRatio: state.map?.ratio, scaleLimit: state.ratio, scaleStrategy: state.scaleStrategy,
  modelId: state.info?.settings?.modelId, modelVersion: state.info?.settings?.modelVersion,
  theme: state.theme, rowHeight: state.rowHeight, effectiveRowHeight: state.rows?.rowHeight || state.layout?.rowHeight,
  fontSize: state.fontSize, timeZone: state.timeZone || 'UTC',
  grouping: state.presentation?.grouping?.field || (state.groupBy === 'none' ? null : state.groupBy),
  selectedSourceIds: state.filter.sourceIds ? [...state.filter.sourceIds] : null, localPaths: !!state.provider?.localBrowser,
  interactionMode: recordGestures?.mode || 'navigate',
  navigationPhase: navigation?.phase || 'idle', navigationOffset: Number($('.plot-wrap')?.dataset.navigationOffset || 0),
  changeMode: changeMonitor?.state.mode, changePending: changeMonitor?.state.pending, changeRequired: changeMonitor?.state.required,
  queryRevision: state.query?.revision, queryGeneration: state.query?.generation,
  coverage: state.query?.coverage, loadingStatus: state.info?.legacy?.coverage, queryDomain: state.map?.domain,
}) });
(async () => {
  try {
    for (const style of ['normal', 'italic']) for (const weight of [400, 700]) await document.fonts.load(`${style} ${weight} 13px "Noto Sans"`, 'Timeline \u0101\u010c\u0142');
    shell();
    const target = await startupTarget();
    if (target.mode !== 'standalone') await startConfiguredServer(target);
    else { await initialize(createLocalProvider(initialSnapshot), initialSnapshot); await discoverLocalPaths(); }
    if (state.info && location.hash.startsWith('#view=')) openHelp(location.hash);
  }
  catch (error) { console.error(error); finishBoot(); app.innerHTML = `<section class="boot-status"><h1>${TITLE}</h1><p role="alert">${esc(error.message)}</p></section>`; }
})();
