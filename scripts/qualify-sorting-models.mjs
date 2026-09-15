import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { dryRunLegacyVisualModel } from '../client/src/data/legacy-visual-adapter.js';
import { adaptLegacyPresentation } from '../client/src/data/legacy-presentation.js';
import { canonicalJson } from '../client/src/data/data-provider.js';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { 'legacy-root': { type: 'string', default: 'C:/projects/openbexi_timeline' }, 'skip-sources': { type: 'boolean', default: false } } });
const legacyRoot = path.resolve(values['legacy-root']);
const evidence = JSON.parse(await readFile(path.join(root, 'docs/sorting-filtering/evidence.json'), 'utf8'));
const models = Object.keys(evidence.legacySources).filter(name => /^(?:tests\/)?models\/.+\.json$/.test(name));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const baseline = new Map();
for (const model of models) baseline.set(model, await readFile(path.join(legacyRoot, model)));
const backend = JSON.parse(execFileSync(python, ['scripts/qualify-sorting-models.py'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 180000,
  input: JSON.stringify({ legacyRoot, models, profiles: values['skip-sources'] ? [] : ['yaml/multiple_sources_test.yml', 'yaml/earthquake_volcano_data.yml'].map(name => path.join(root, name)) }), maxBuffer: 16 * 1024 * 1024 }));

function runtimeDisposition(pointer, source) {
  const params = /^\/params\/0\/([^/]+)$/.exec(pointer);
  if (params) {
    const field = params[1];
    if (field === 'name') return ['provenance-only', 'Authored alias, not a catalog identity.'];
    if (field === 'title') return ['mapped', '/name'];
    if (field === 'date') return ['mapped', '/viewHints/focus'];
    if (['timeZone', 'fontSize'].includes(field)) return ['mapped', `/definition/${field}`];
    if (['fontWeight', 'fontStyle'].includes(field)) return ['mapped-or-band-override', `/definition/presentation/labels/${field}`];
    if (field === 'fontFamily') return ['explicit-substitution', 'Embedded measured Noto Sans; not exact historical font geometry.'];
    if (field === 'camera') return ['matched-profile', 'Orthographic 2D only.'];
    if (['top', 'left', 'width', 'height'].includes(field)) return ['responsive-replacement', 'Responsive viewport, not authored fixed page geometry.'];
    if (['data', 'data_default_port', 'data_sse_port'].includes(field)) return ['not-executed', 'Only operator-selected read-only sources may provide data.'];
  }
  const band = /^\/bands\/(\d+)\/([^/]+)(?:\/model\/0\/([^/]+))?$/.exec(pointer);
  const model = /^\/bands\/(\d+)\/model\/0\/([^/]+)$/.exec(pointer);
  if (model) {
    if (model[2] === 'alternateColor') return ['inactive', 'No verified legacy consumer for band.model.alternateColor.'];
    if (model[2] === 'sortBy') return Number(model[1]) === 0 ? ['mapped', 'Primary safe JSON Pointer grouping, deterministic codepoint default.'] : ['not-applied', 'Overview follows main grouping; an independent overview sort model is not implemented.'];
  }
  if (band) {
    const index = Number(band[1]), field = band[2], role = index ? 'overview' : 'primary';
    const direct = { color: 'backgroundColor', textColor: 'textColor', dateColor: 'dateColor', SessionColor: 'sessionColor', eventColor: 'eventColor', sessionHeight: 'barHeight', defaultEventSize: 'pointRadius', intervalUnit: 'intervalUnit', dateFormat: 'dateFormat', intervalUnitPos: 'axisPosition' };
    if (direct[field]) return [field === 'dateFormat' ? 'mapped-with-correction' : 'mapped', `/definition/presentation/bands/${role}/${direct[field]}`];
    if (field === 'name') return ['role-selection', 'Primary/overview band identification, not an authored label.'];
    if (field === 'height') return ['mapped', `/viewHints/bands/${role}/heightFraction`];
    if (field === 'intervalPixels') return ['mapped', `/viewHints/bands/${role}/intervalPixels`];
    if (field === 'subIntervalPixels') return source.bands[index].subIntervalPixels === 'NONE' ? ['matched-disabled', 'No minor subdivisions.'] : source.bands[index].intervalUnit === 'HOUR' && Number(source.bands[index].intervalPixels) >= 60 ? ['derived-not-exact', 'Four quarter-hour subdivisions, not arbitrary authored pixel divisions.'] : ['unsupported', 'No implemented subdivision mapping for this interval.'];
    if (field === 'fontFamily') return ['explicit-substitution', 'Embedded measured Noto Sans.'];
    if (['fontSize', 'fontWeight', 'fontStyle', 'textBackgroundColor'].includes(field)) return index === 0 ? ['mapped', `/definition/presentation/labels/${field === 'textBackgroundColor' ? 'backgroundColor' : field}`] : ['not-applied', 'Independent overview-label typography is not implemented.'];
  }
  return ['unsupported', 'No verified runtime mapping; not silently treated as implemented.'];
}

const records = [];
for (const model of models) {
  const bytes = baseline.get(model), text = bytes.toString('utf8'), source = JSON.parse(text);
  const dry = await dryRunLegacyVisualModel(text, { sourcePath: model });
  let adapted, runtime;
  try { adapted = adaptLegacyPresentation(source); runtime = { status: 'adapted-with-explicit-substitutions', canonicalResultSha256: hash(canonicalJson(adapted)), diagnostics: adapted.diagnostics }; }
  catch (error) { runtime = { status: 'blocked', code: error.code, message: error.message }; }
  const server = backend.models.find(item => item.path === model);
  const properties = dry.dispositions.filter(item => item.disposition !== 'container').map(item => {
    const [status, detail] = runtimeDisposition(item.pointer, source);
    return { pointer: item.pointer, catalogDryRun: { disposition: item.disposition, reason: item.reason, ...(item.target ? { target: item.target } : {}) },
      runtime: { status: adapted ? status : 'model-blocked', detail }, ...(item.valueSha256 ? { restrictedValueSha256: item.valueSha256 } : {}) };
  });
  const after = await readFile(path.join(legacyRoot, model));
  records.push({ path: model, beforeSha256: hash(bytes), afterSha256: hash(after), unchanged: hash(bytes) === hash(after),
    matchesEarlierAuditHash: hash(bytes) === evidence.legacySources[model],
    catalogDryRun: { status: dry.status, canCreate: dry.canCreate, counts: dry.counts }, clientRuntime: runtime, serverRuntime: server,
    providerAdapterParity: runtime.status === server.status && runtime.canonicalResultSha256 === server.canonicalResultSha256,
    propertyCounts: Object.fromEntries([...new Set(properties.map(item => item.runtime.status))].sort().map(status => [status, properties.filter(item => item.runtime.status === status).length])), properties });
}
const result = { format: 'openbexi-model-coverage-v1', generatedAt: new Date().toISOString(), nodeVersion: process.version, pythonVersion: backend.pythonVersion,
  qualification: 'Runtime adapter parity and complete per-property disposition; not pixel-perfect historical rendering qualification.',
  expectedModelCount: 8, models: records, realSourceWindows: backend.sources,
  privacy: 'No raw records, descriptor text, configured connector values or unhashed source record paths are emitted.',
  limitations: ['Archive-wide indexing and all-record completeness are not qualified by foreground window probes.', 'Cross-partition long-session correctness is covered by synthetic tests, not asserted for unscanned production partitions.', 'Historical exact glyph/layout parity is not claimed for font substitution or responsive geometry.', 'Catalog visual dry-run remains deliberately stricter than the runtime compatibility adapter.'] };
if (records.length !== 8 || records.some(item => !item.unchanged || !item.providerAdapterParity) || backend.sources.some(item => !item.allReadFilesUnchanged)) throw new Error('Qualification found changed inputs or divergent provider model adaptation');
const lines = ['# Model and Source Coverage', '', `Generated: ${result.generatedAt}. Node ${process.version}; Python ${backend.pythonVersion}.`, '', result.qualification, '',
  '## Model Ledger', '', '| Model | JS/Python adapter | Catalog dry-run | Input unchanged | Properties |', '| --- | --- | --- | --- | --- |',
  ...records.map(item => `| ${item.path} | ${item.providerAdapterParity ? 'Same adapted result' : 'Divergent'} | ${item.catalogDryRun.status} | ${item.unchanged ? 'Yes' : 'NO'} | ${item.properties.length} individually classified |`), '',
  'All eight configured models can be adapted at runtime with explicit corrections/substitutions. This does **not** mean that every authored property has equivalent behavior. The JSON ledger records every property, its runtime disposition, and its independent catalog dry-run disposition. Disabled connectors are never activated.', '',
  'Shared limitations: measured Noto Sans replaces legacy font geometry; fixed placement becomes responsive; independent overview sort/label typography is not applied; inactive alternate-color declarations are not fabricated. Subdivision conversion is explicitly limited to the supported quarter-hour rule. Catalog creation remains blocked until unsupported/restricted properties are reviewed.', '',
  '## Bounded Real Sources', '', '| Profile | Probe | Metadata ready | Window read | Records | Namespace groups | All configured sources |', '| --- | --- | --- | --- | --- | --- | --- |',
  ...backend.sources.map(item => `| ${item.profile} | ${item.probe}: ${item.status}${item.code ? ` (${item.code})` : ''} | ${item.metadataReadyMs ?? '-'} ms | ${item.foregroundWindowMs ?? '-'} ms | ${item.records ?? '-'} | ${item.logicalNamespaceGroups ?? '-'} | ${item.allConfiguredSourcesRepresented ? 'Yes' : 'No'} |`), '',
  'These are single-run, local, foreground-only probes, not percentile benchmarks or full archive scans. Background reconciliation was disabled to bound work. All windows deliberately report incomplete archive coverage. The representative-source probe selects nearby partitions containing record files using directory metadata, with a 31-day maximum span. `no_record_partitions` means a configured source has only empty/descriptor-only date directories, so real combined-source qualification is unavailable; this is not counted as a pass. The Python reader used the repository YAML profiles and only allowlisted `/yyyy/mm/dd` partitions. Sample descriptor lookups use the record identity and namespace. The JSON ledger records sample statuses and before/after hashes without descriptor contents.', '',
  ...backend.sources.map(item => `- ${item.profile}, ${item.probe}: descriptor sample ${JSON.stringify(item.descriptorSampleStatus ?? {})}; crossing-start sessions ${item.sessionsCrossingStart ?? 'not measured'}; all files actually read unchanged: ${item.allReadFilesUnchanged ? 'yes' : 'NO'}.`), '',
  '## Reproduce', '', '```powershell', 'node scripts/qualify-sorting-models.mjs --legacy-root C:/projects/openbexi_timeline', '# Models only, without local production data:', 'node scripts/qualify-sorting-models.mjs --legacy-root C:/projects/openbexi_timeline --skip-sources', '```', '',
  'The command writes only these generated reports and disposable application state outside legacy authorities. It verifies source hashes after reading. Synthetic cross-partition coverage: `tests/server/test_partitioned_legacy_repository.py`; real-HTTP ordering/grouping/collapse parity: `tests/integration/ordering-v2-parity.test.mjs`.', '',
  'Detailed evidence: [model-coverage.json](model-coverage.json).', ''];
const output = path.join(root, 'docs/sorting-filtering');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'model-coverage.json'), JSON.stringify(result, null, 2) + '\n');
await writeFile(path.join(output, 'model-coverage.md'), lines.join('\n'));
console.log(JSON.stringify({ models: records.length, unchanged: records.every(item => item.unchanged), adapterParity: records.every(item => item.providerAdapterParity), sources: backend.sources.map(item => ({ profile: item.profile, status: item.status, records: item.records, unchanged: item.allReadFilesUnchanged })) }));
