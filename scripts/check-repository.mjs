import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = fileURLToPath(new URL('../', import.meta.url));
const forbidden = /(^|\/)(node_modules|\.venv|venv|__pycache__|\.idea|\.vscode|\.pytest_cache|\.ruff_cache)(\/|$)|^(dist|runtime|var|tmp|artifacts|test-results|playwright-report|coverage)\/|^(yaml|config)\/local\/|(^|\/)\.env(?:$|\.(?!example$))|(^|\/)local-browser-key\.json$|\/control\/identities\.json$|\.(?:log|pyc|pem|key|p12|pfx)$/i;
const documentationPdfs = new Set([
  'output/pdf/OpenBEXI_Timeline_Implementation_Preview.pdf',
  'output/pdf/OpenBEXI_Local_Source_Paths.pdf',
  'output/pdf/OpenBEXI_Legacy_JSON_Preview.pdf',
  'output/pdf/OpenBEXI_Hazard_Comparison.pdf',
  'output/pdf/local-test-data.pdf',
  'output/pdf/OpenBEXI_Timeline_Sorting_Filtering_Prompt.pdf',
]);
const credentialPatterns = [
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];

export function pathProblems(files) {
  const errors = [], seen = new Map();
  for (const file of files) {
    if (forbidden.test(file) || (file.startsWith('output/') && !documentationPdfs.has(file))) errors.push(`Excluded local/generated path: ${file}`);
    if (file.includes('\\') || file.split('/').some(part => part === '..' || part === '.')) errors.push(`Nonportable path: ${file}`);
    const lower = file.toLowerCase();
    if (seen.has(lower) && seen.get(lower) !== file) errors.push(`Case-colliding paths: ${seen.get(lower)} and ${file}`);
    seen.set(lower, file);
  }
  return errors;
}

export function hasCredential(text) {
  return credentialPatterns.some(pattern => pattern.test(text));
}

export function documentationProblems(file, source, files) {
  const errors = [];
  marked.walkTokens(marked.lexer(source), token => {
    if (!['link', 'image'].includes(token.type)) return;
    const href = token.href;
    if (!href || /^(?:https?:|mailto:|#)/i.test(href)) return;
    if (/^(?:[a-z]:|\/|\\)/i.test(href)) { errors.push(`Machine-local documentation link in ${file}`); return; }
    let target;
    try { target = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(href.split(/[?#]/)[0]))); }
    catch { errors.push(`Invalid documentation link in ${file}`); return; }
    if (!files.has(target) && ![...files].some(name => name.startsWith(`${target}/`))) errors.push(`Unpublished documentation target: ${file} -> ${target}`);
  });
  return errors;
}

export function checkRepository({ staged = false, build = false } = {}) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const names = [...new Set(git(['ls-files', '-z', '--cached', ...(staged ? [] : ['--others', '--exclude-standard'])]).toString('utf8').split('\0').filter(Boolean))];
  const files = new Set(names), errors = pathProblems(names);
  const contents = file => staged ? git(['show', `:${file}`]) : readFileSync(path.join(root, file));
  let bytes = 0;
  for (const file of names) {
    if (!staged && lstatSync(path.join(root, file)).isSymbolicLink()) { errors.push(`Review symlink before publication: ${file}`); continue; }
    const data = contents(file);
    bytes += data.length;
    if (data.length > 50 * 1024 * 1024) errors.push(`File exceeds 50 MiB publication limit: ${file}`);
    if (/\.(?:md|json|yml|yaml|js|mjs|py|html|css|xml|toml|txt)$/.test(file) && hasCredential(data.toString('utf8'))) errors.push(`Possible credential in ${file} (value suppressed)`);
  }
  for (const file of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/publishing.md']) {
    if (!files.has(file)) { errors.push(`Missing publication document: ${file}`); continue; }
    errors.push(...documentationProblems(file, contents(file).toString('utf8'), files));
  }
  if (build) {
    const manifest = JSON.parse(readFileSync(path.join(root, 'dist/build-manifest.json'), 'utf8'));
    for (const file of Object.keys(manifest.inputs)) {
      if (!file.startsWith('node_modules/') && !files.has(file)) errors.push(`Build depends on an unpublished input: ${file}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return `${names.length} publication files, ${(bytes / 1024 / 1024).toFixed(1)} MiB; paths, credential patterns, documentation links${build ? ', and build inputs' : ''} checked. Licensing and manual secret review are still required.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(checkRepository({ staged: process.argv.includes('--staged'), build: process.argv.includes('--build') })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
