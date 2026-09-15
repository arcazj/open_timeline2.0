// Read-only source-method probes. Never starts the legacy server or writes its files.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const legacy = process.argv[2];
const jdk = process.argv[3];
if (!legacy || !jdk) throw new Error('Usage: node scripts/audit-sorting-filtering.mjs LEGACY_ROOT JDK_HOME');
const scratch = path.join(root, 'artifacts/sorting-filtering/probes');
const output = path.join(root, 'docs/sorting-filtering/evidence.json');
await mkdir(scratch, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const legacyJs = await readFile(path.join(legacy, 'src/openbexi_timeline.js'), 'utf8');
const java = await readFile(path.join(legacy, 'src/com/openbexi/timeline/data_browser/json_files_manager.java'), 'utf8');
const caseBytes = await readFile(path.join(root, 'docs/sorting-filtering/cases.json'));
const cases = JSON.parse(caseBytes);
const methods = {};
function extract(source, name, begin, end) {
  const start = source.indexOf(begin), stop = source.indexOf(end, start + begin.length);
  assert(start >= 0 && stop > start, `Missing audited method boundaries: ${name}`);
  const text = source.slice(start, stop);
  methods[name] = { startLine: source.slice(0, start).split('\n').length, sha256: hash(text) };
  return text;
}
const filter = extract(java, 'filterEvents', '    public JSONArray filterEvents(', '\n    public void reindexFiles');
const dates = extract(java, 'filterDates', '    JSONArray filterDates(', '\n    @Override\n    JSONArray searchEvents'.replaceAll('\n', java.includes('\r\n') ? '\r\n' : '\n'));
const search = extract(java, 'searchEvents', '    JSONArray searchEvents(', '\n    private String lookForIcon');
const harness = `import org.json.simple.*;
import org.json.simple.parser.JSONParser;
import java.util.*;
import java.util.regex.*;
public class LegacyFilterProbe {
  public String next_date = "NONE";
${filter}
${dates}
${search}
  static JSONArray ids(JSONArray records) { JSONArray out = new JSONArray(); for(Object r: records) out.add(((JSONObject)r).get("id")); return out; }
  static void yellow(JSONArray records, JSONArray out) { for(Object r: records) { JSONObject item=(JSONObject)r, render=(JSONObject)item.get("render"); if(render!=null && "#F8DF09".equals(render.get("backgroundColor"))) out.add(item.get("id")); if(item.get("activities")!=null) yellow((JSONArray)item.get("activities"),out); } }
  public static void main(String[] args) throws Exception {
    JSONParser parser = new JSONParser();
    JSONObject input=(JSONObject)parser.parse(new java.io.InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8));
    LegacyFilterProbe probe=new LegacyFilterProbe(); JSONArray results=new JSONArray();
    for(Object c:(JSONArray)input.get("filters")) {
      JSONObject test=(JSONObject)c, result=new JSONObject(); result.put("id",test.get("id"));
      JSONArray records=(JSONArray)parser.parse(input.get("records").toString());
      try { result.put("ids",ids(probe.filterEvents(records,(String)test.get("include"),(String)test.get("exclude")))); }
      catch(Exception e) { result.put("error",e.getClass().getSimpleName()); }
      results.add(result);
    }
    for(Object c:(JSONArray)input.get("searches")) {
      JSONObject test=(JSONObject)c, result=new JSONObject(); result.put("id",test.get("id"));
      JSONArray records=(JSONArray)parser.parse(input.get("records").toString());
      JSONArray returned=probe.searchEvents(records,(String)test.get("search")), marks=new JSONArray(); yellow(returned,marks);
      result.put("ids",ids(returned)); result.put("yellowIds",marks); results.add(result);
    }
    JSONObject date=(JSONObject)input.get("dates"), result=new JSONObject(); result.put("id",date.get("id"));
    result.put("ids",ids(probe.filterDates((JSONArray)date.get("records"),java.time.Instant.parse((String)date.get("from")).toEpochMilli(),java.time.Instant.parse((String)date.get("to")).toEpochMilli()))); results.add(result);
    System.out.println(results.toJSONString());
  }
}`;
await writeFile(path.join(scratch, 'LegacyFilterProbe.java'), harness);
const jar = path.resolve(legacy, 'lib/openbexi_timeline.jar');
const extension = process.platform === 'win32' ? '.exe' : '';
execFileSync(path.join(jdk, 'bin', `javac${extension}`), ['-encoding', 'UTF-8', '-cp', jar, path.join(scratch, 'LegacyFilterProbe.java')], { timeout: 30000, windowsHide: true, stdio: 'pipe' });
const observed = JSON.parse(execFileSync(path.join(jdk, 'bin', `java${extension}`), ['-cp', `${scratch}${path.delimiter}${jar}`, 'LegacyFilterProbe'], { input: caseBytes, timeout: 10000, windowsHide: true, encoding: 'utf8' }));
for (const test of cases.filters) {
  const actual = observed.find(item => item.id === test.id);
  if (test.expectedError) assert.equal(actual.error, test.expectedError, test.id);
  else assert.deepEqual(actual.ids, test.expectedIds, test.id);
}
for (const test of cases.searches) {
  const actual = observed.find(item => item.id === test.id);
  assert.deepEqual(actual.ids, test.expectedIds, test.id);
  assert.deepEqual(actual.yellowIds, test.expectedYellowIds, test.id);
}
assert.deepEqual(observed.find(item => item.id === cases.dates.id).ids, cases.dates.expectedLegacyIds);

const context = createContext({ console, OB_TIMELINE: function () {}, document: {} });
for (const name of ['ob_get_filter_value', 'ob_get_all_sorting_options', 'build_sessions_filter', 'create_new_bands']) {
  const start = `    OB_TIMELINE.prototype.${name} = function`;
  const body = extract(legacyJs, name, start, '\n    };') + '\n    };';
  // Include the original license notice with the extracted JavaScript.
  runInContext(legacyJs.slice(0, legacyJs.indexOf("import * as THREE")) + body, context, { timeout: 1000 });
}
const client = runInContext(`(() => {
  const tool = new OB_TIMELINE(); tool.name = 'audit'; tool.ob_scene = [{ model: new Map() }];
  document.getElementById = () => ({ value: '^Activity_(5_1|0_3)$' });
  const sanitized = tool.ob_get_filter_value(0);
  const narrow = tool.build_sessions_filter(0, ['alpha', 'beta']);
  const plainString = tool.build_sessions_filter(0, 'alpha');
  const inactive = tool.build_sessions_filter(0, '');
  tool.ob_scene[0].model = new Map([['namespace', Array.from({length: 15}, (_, i) => 'N' + i)]]);
  const fifteenValues = tool.ob_get_all_sorting_options(0);
  tool.ob_scene[0] = { bands: [{model:[{sortBy:'namespace'}], color:'#fff'}], sessions: {events:[
    {id:'b',data:{namespace:'SOURCE2'}}, {id:'a',data:{namespace:'SOURCE1'}}, {id:'c',data:{namespace:'SOURCE10'}}
  ]} };
  let groupOrder; tool.update_timeline_model = (...args) => { groupOrder = args[6]; };
  tool.create_new_bands(0);
  return {sanitized,narrow,plainString,inactive,fifteenValues,groupOrder};
})()`, context, { timeout: 1000 });
assert.equal(client.sanitized, 'Activity__PARL_5_1_PIPE_0_3_PARR_');
assert.equal(client.narrow, '^(?=.*(?:alpha))(?!.*(?:beta)).*$');
assert.equal(client.plainString, '^(?=.*(?:--|--))(?!.*(?:__|__)).*$');
assert.equal(client.inactive, null);
assert(!client.fifteenValues.includes('namespace'));
assert.deepEqual(Array.from(client.groupOrder), ['SOURCE2', 'SOURCE1', 'SOURCE10']);

const sourceFiles = [
  'src/openbexi_timeline.js', 'src/com/openbexi/timeline/data_browser/json_files_manager.java',
  'src/com/openbexi/timeline/data_browser/data_manager.java', 'src/com/openbexi/timeline/data_browser/data_configuration.java',
  'src/com/openbexi/timeline/data_browser/data_sources.java', 'src/com/openbexi/timeline/servlets/ob_handle_http_requests.java',
  'openbexi_test_timeline.html', 'openbexi_timeline_earthquake.html',
  'yaml/sources_default_test.yml', 'yaml/sources_earthquake.yml', 'filters/test_ob_timeline_2_filter_setting.json',
];
for (const file of await readdir(path.join(legacy, 'models'))) if (file.endsWith('.json')) sourceFiles.push(`models/${file}`);
sourceFiles.push('tests/models/regular_timeline.json');
const sources = {};
for (const file of sourceFiles) sources[file] = hash(await readFile(path.join(legacy, file)));
const current = {};
for (const file of ['client/src/data/filter-expression.js', 'client/src/data/query-configuration.js', 'client/src/ui/filter-editor.js', 'server/app/services/filters.py', 'server/app/services/table_query.py', 'server/app/services/legacy_sources.py', 'server/app/services/legacy_configuration.py']) current[file] = hash(await readFile(path.join(root, file)));
const report = { format: 'sorting-filtering-method-evidence', version: 1, status: 'passed', evidenceType: 'extracted unchanged method execution, not full legacy application qualification', currentBaseline: '2c3b0c17e3167577c00951ee456588c8ed9cd521', caseSha256: hash(caseBytes), javaRuntime: execFileSync(path.join(jdk, 'bin', `java${extension}`), ['--version'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/)[0], nodeRuntime: process.version, legacySources: sources, currentSources: current, methods, legacyResults: observed, clientResults: client, caseCount: 20, limitations: ['No full legacy Tomcat/UI execution', 'No production data copied or modified', 'No pathological regex execution', 'Future regex and UX requirements are not implemented'] };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log('Passed 14 Java cases and 6 client assertions; source hashes and results saved to docs/sorting-filtering/evidence.json');
