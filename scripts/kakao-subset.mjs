import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isBuiltin } from 'node:module';
import { parse } from 'acorn';

export const UPSTREAM = Object.freeze({
  name: 'agent-messenger', version: '2.38.1',
  gitHead: '801d7c441e5d52c6840954134b4d16994e0df5a3',
  archiveUrl: 'https://registry.npmjs.org/agent-messenger/-/agent-messenger-2.38.1.tgz',
  sha256: 'e72b7af4ad4a61c6263c9814438019ae043a1a339520addfddfa9591b5e4e22a',
  integrity: 'sha512-p2NMTVCi8jethIpp1BDOg1uEyR2Ofq6a0wrAuNeDBwP2nqgV507IQJiFlUCSUi2nltk1AS9LhrjWt3dFXlUiQA==',
  entrypoint: 'dist/src/platforms/kakaotalk/index.js',
});
export const SUBSET_PACKAGE = Object.freeze({
  name: '@kakao-ai-bridge/kakao-sdk', version: '2.38.1-kakao.1', private: true,
  description: 'Unmodified KakaoTalk-only runtime subset of agent-messenger 2.38.1; not the full upstream SDK',
  type: 'module', license: 'SEE LICENSE IN UPSTREAM-LICENSE.md',
  engines: { node: '>=22.13.0 <25' },
  exports: { '.': `./${UPSTREAM.entrypoint}`, './package.json': './package.json' },
  dependencies: { bson: '6.10.4', zod: '4.6.5' },
  upstream: { name: UPSTREAM.name, version: UPSTREAM.version, sha256: UPSTREAM.sha256 },
});
export const DEFAULT_DIR = fileURLToPath(new URL('../vendor/kakao-sdk/', import.meta.url));
export const LICENSE_EXPLANATION = `# Upstream license declaration and provenance

The exact agent-messenger 2.38.1 npm archive README declares, verbatim:

## License

MIT

The complete unmodified README is retained in provenance/README.upstream.md.
The archive has no standalone top-level LICENSE and its package.json does not
contain a license field. We rely on that explicit upstream MIT declaration;
we do not fabricate a copyright holder, year, or missing upstream license text.
This file is a provenance explanation, not a new license grant or legal opinion.

The original Kakao protocol NOTICE is retained verbatim at
 src/platforms/kakaotalk/protocol/NOTICE.md
and its original archive path and SHA256 are recorded in source-manifest.json.
It says the implementation was written from scratch, with no code copied from
its listed protocol references. In particular, it distinguishes references
with no license or non-commercial terms from copied/adapted code. Those claims
are upstream's statements, not an independent legal clearance by this bridge.
All selected JavaScript bytes and their existing comments are unchanged.
The unrelated LINE vendor licenses cover omitted LINE code, not this subset.
The bridge wrapper remains separately UNLICENSED pending its owner's decision.

Exact archive: ${UPSTREAM.archiveUrl}
Archive SHA256: ${UPSTREAM.sha256}
Upstream gitHead: ${UPSTREAM.gitHead}
For public/commercial distribution requiring a complete signed-off license
chain, obtain upstream's standalone license/copyright clarification.
`;
export const SUBSET_README = `# Kakao-only SDK subset (not the full agent-messenger package)

This private local package exposes the original KakaoTalk JavaScript public
entrypoint from agent-messenger 2.38.1, plus its complete reachable runtime
module closure: 22 byte-identical JavaScript files. The original literal
runtime import of ensure-auth.js is included. No other messenger, upstream
CLI, native optional integration, or its dependencies is shipped or installed.
The only external runtime packages are bson 6.10.4 and zod 4.6.5.

The scope/name/version identify this as a bridge-maintained subset, not an
upstream release. Original dist/src paths are preserved. This is a JavaScript
runtime subset: upstream type declarations, TypeScript build sources and source
maps are not distributed. Unmodified sourceMappingURL comments therefore do
not supply source maps. No protocol/auth/client code is patched or bundled.

See UPSTREAM-LICENSE.md, provenance/README.upstream.md and the original protocol
NOTICE for attribution and the missing-standalone-license qualification.
source-manifest.json records upstream archive hashes, every copied file hash,
and every static/dynamic import edge. From the bridge root run:

    npm run vendor:check
    npm run vendor:check -- --archive /path/to/agent-messenger-2.38.1.tgz
    npm run vendor:extract -- --archive /path/to/agent-messenger-2.38.1.tgz --out /new/empty/directory

The archive is not shipped. Extraction rejects any archive other than the pinned
SHA256/SHA512 artifact; verification with --archive compares every copied byte.
Checks fail on tampering, extra/missing files, unknown externals, non-literal
imports, missing dynamic targets or unsupported executable module loaders.
These checks are integrity/closure guards, not a proof that upstream is safe.
`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function insist(value, message) { if (!value) throw new Error(message); }
function safePath(name) {
  insist(typeof name === 'string' && name && !name.includes('\\') && !path.posix.isAbsolute(name)
    && !name.split('/').some(part => part === '..' || part === '.' || part === ''), `unsafe path: ${name}`);
  return name;
}

// Deliberately narrow tar reader: the pinned archive has only regular entries.
// Hashes are authenticated before decompression; no archive paths are executed.
export function readArchive(archive) {
  const bytes = fs.readFileSync(archive);
  insist(sha256(bytes) === UPSTREAM.sha256, 'upstream archive SHA256 mismatch');
  insist(`sha512-${createHash('sha512').update(bytes).digest('base64')}` === UPSTREAM.integrity,
    'upstream archive SHA512 mismatch');
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map();
  const text = b => b.toString('utf8').split('\0')[0];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      insist(tar.subarray(offset).every(byte => byte === 0), 'nonzero tar trailer');
      break;
    }
    const checksum = Number.parseInt(text(header.subarray(148, 156)).trim(), 8);
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    insist(checksum === sum, 'tar header checksum mismatch');
    const prefix = text(header.subarray(345, 500));
    const name = safePath(`${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`);
    insist(name.startsWith('package/'), `unexpected archive root: ${name}`);
    insist(header[156] === 48 || header[156] === 0, `unsupported tar entry: ${name}`);
    const sizeText = text(header.subarray(124, 136)).trim();
    insist(/^[0-7]+$/.test(sizeText), `invalid tar size: ${name}`);
    const size = Number.parseInt(sizeText, 8);
    insist(Number.isSafeInteger(size) && offset + 512 + size <= tar.length, `truncated tar entry: ${name}`);
    const relative = name.slice('package/'.length);
    insist(!files.has(relative), `duplicate archive entry: ${name}`);
    files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// An AST parser prevents regex-based omission of multiline or dynamic imports.
// This is a bounded source-closure verifier, not a general JavaScript sandbox.
export function scanImports(source, filename = 'module.js') {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const edges = [];
  function edge(node, kind) {
    insist(node?.type === 'Literal' && typeof node.value === 'string', `non-literal ${kind} in ${filename}`);
    edges.push({ specifier: node.value, kind });
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration') edge(node.source, 'static');
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) edge(node.source, 'static');
    if (node.type === 'ImportExpression') edge(node.source, 'dynamic');
    if (node.type === 'Identifier' && ['require', 'createRequire', 'eval', 'Function'].includes(node.name)) {
      throw new Error(`unsupported executable loader ${node.name} in ${filename}`);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  return edges;
}
export function buildClosure(files, entrypoint = UPSTREAM.entrypoint) {
  const queue = [entrypoint], modules = new Map(), external = new Set(), builtins = new Set();
  while (queue.length) {
    const filename = safePath(queue.pop());
    if (modules.has(filename)) continue;
    insist(filename.endsWith('.js') && files.has(filename), `missing runtime module: ${filename}`);
    const bytes = files.get(filename);
    const edges = scanImports(bytes.toString('utf8'), filename).map(edge => {
      const specifier = edge.specifier;
      if (specifier.startsWith('.')) {
        const target = safePath(path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier)));
        insist(target.startsWith('dist/src/') && target.endsWith('.js') && files.has(target),
          `missing or out-of-bound ${edge.kind} import: ${filename} -> ${specifier}`);
        queue.push(target);
        return { ...edge, target };
      }
      if (isBuiltin(specifier)) {
        // These builtins alone were observed in the pinned closure. A change
        // needs explicit review, particularly module/vm/worker/child_process.
        insist(['events', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:net', 'node:os', 'node:path', 'node:tls'].includes(specifier),
          `unexpected builtin import: ${specifier}`);
        builtins.add(specifier);
      } else {
        insist(Object.hasOwn(SUBSET_PACKAGE.dependencies, specifier), `unexpected external import: ${specifier}`);
        external.add(specifier);
      }
      return edge;
    });
    modules.set(filename, { path: filename, sha256: sha256(bytes), bytes: bytes.length, imports: edges });
  }
  return { modules: [...modules.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    external: [...external].sort(), builtins: [...builtins].sort() };
}
export function makeSubset(archive) {
  const files = readArchive(archive), closure = buildClosure(files), output = new Map();
  insist(closure.modules.length === 22, 'pinned Kakao closure must contain 22 modules');
  insist(json(closure.external) === json(Object.keys(SUBSET_PACKAGE.dependencies).sort()), 'dependency/closure mismatch');
  const originalPackage = JSON.parse(files.get('package.json'));
  insist(originalPackage.name === UPSTREAM.name && originalPackage.version === UPSTREAM.version, 'upstream package identity mismatch');
  const copied = closure.modules.map(module => ({ path: module.path, upstreamPath: `package/${module.path}`,
    sha256: module.sha256, bytes: module.bytes, role: 'runtime' }));
  for (const module of closure.modules) output.set(module.path, files.get(module.path));
  for (const [source, destination, role] of [
    ['README.md', 'provenance/README.upstream.md', 'license-declaration'],
    ['src/platforms/kakaotalk/protocol/NOTICE.md', 'src/platforms/kakaotalk/protocol/NOTICE.md', 'protocol-notice'],
  ]) {
    insist(files.has(source), `missing upstream notice: ${source}`);
    const bytes = files.get(source); output.set(destination, bytes);
    copied.push({ path: destination, upstreamPath: `package/${source}`, sha256: sha256(bytes), bytes: bytes.length, role });
  }
  insist(/(?:^|\n)## License\n\nMIT\s*$/.test(files.get('README.md').toString('utf8')), 'upstream MIT declaration changed');
  const manifest = {
    schemaVersion: 1, upstream: { ...UPSTREAM, packageJsonSha256: sha256(files.get('package.json')) },
    subset: { name: SUBSET_PACKAGE.name, version: SUBSET_PACKAGE.version, runtimeModuleCount: 22,
      sourceModification: 'none', sourceMapsAndTypes: 'not distributed; JS sourceMappingURL comments unchanged' },
    license: { declared: 'MIT', declaration: 'provenance/README.upstream.md', standaloneTopLevelLicense: false,
      originalPackageLicenseField: originalPackage.license ?? null,
      archiveNoticeInventory: [...files.keys()].filter(name => /(?:^|\/)(?:licen[sc]e(?:\.[^/]*)?|notice(?:\.[^/]*)?|copying)$/i.test(name)).sort() },
    dependencies: SUBSET_PACKAGE.dependencies,
    files: copied.sort((a, b) => a.path.localeCompare(b.path, 'en')), closure,
  };
  output.set('source-manifest.json', Buffer.from(json(manifest)));
  output.set('package.json', Buffer.from(json(SUBSET_PACKAGE)));
  output.set('UPSTREAM-LICENSE.md', Buffer.from(LICENSE_EXPLANATION));
  output.set('README.md', Buffer.from(SUBSET_README));
  return output;
}
function diskFiles(directory) {
  const found = new Map();
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      insist(!entry.isSymbolicLink(), `symlink forbidden: ${name}`);
      if (entry.isDirectory()) visit(name);
      else { insist(entry.isFile(), `non-file: ${name}`); found.set(name, fs.readFileSync(path.join(directory, name))); }
    }
  }
  visit(); return found;
}
export function checkSubset(directory = DEFAULT_DIR, archive) {
  const actual = diskFiles(directory);
  // This digest was recorded from the pinned archive extraction. Updating the
  // upstream revision requires deliberate review of both the script and ledger.
  insist(actual.has('source-manifest.json')
    && sha256(actual.get('source-manifest.json')) === 'dc18830248519efd3a541bb845519e8180a50fe36b7ddf4c5e9de565991d67da',
  'pinned source manifest hash mismatch');
  const manifest = JSON.parse(actual.get('source-manifest.json'));
  insist(manifest.schemaVersion === 1 && manifest.upstream.sha256 === UPSTREAM.sha256
    && manifest.upstream.version === UPSTREAM.version && manifest.upstream.entrypoint === UPSTREAM.entrypoint,
  'manifest upstream identity mismatch');
  for (const [name, expected] of [['package.json', json(SUBSET_PACKAGE)], ['UPSTREAM-LICENSE.md', LICENSE_EXPLANATION], ['README.md', SUBSET_README]]) {
    insist(actual.get(name)?.toString('utf8') === expected, `generated metadata mismatch: ${name}`);
  }
  const expectedNames = ['package.json', 'source-manifest.json', 'UPSTREAM-LICENSE.md', 'README.md'];
  for (const file of manifest.files) {
    safePath(file.path); expectedNames.push(file.path);
    insist(actual.has(file.path) && actual.get(file.path).length === file.bytes
      && sha256(actual.get(file.path)) === file.sha256, `source hash mismatch or missing: ${file.path}`);
  }
  insist(new Set(expectedNames).size === expectedNames.length, 'duplicate manifest path');
  insist(json([...actual.keys()].sort()) === json(expectedNames.sort()), 'extra or missing subset file');
  const closure = buildClosure(actual);
  insist(closure.modules.length === 22 && manifest.subset.runtimeModuleCount === 22, 'wrong runtime module count');
  insist(json(closure) === json(manifest.closure), 'runtime import closure mismatch');
  insist(json(closure.modules.map(module => module.path).sort())
    === json(manifest.files.filter(file => file.role === 'runtime').map(file => file.path).sort()), 'unreachable runtime file');
  if (archive) {
    const expected = makeSubset(archive);
    insist(json([...actual.keys()].sort()) === json([...expected.keys()].sort()), 'archive file list mismatch');
    for (const [name, bytes] of expected) insist(actual.get(name)?.equals(bytes), `archive byte mismatch: ${name}`);
  }
  return { ok: true, package: SUBSET_PACKAGE.name, version: SUBSET_PACKAGE.version,
    runtimeModules: closure.modules.length, files: actual.size, dependencies: closure.external,
    originalArchiveCompared: Boolean(archive), sourceManifestSha256: sha256(actual.get('source-manifest.json')) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = 'check', ...args] = process.argv.slice(2); const options = {};
    while (args.length) { const key = args.shift(); insist(['--archive', '--out'].includes(key) && args[0], `bad option: ${key}`); options[key] = args.shift(); }
    const out = path.resolve(options['--out'] || DEFAULT_DIR);
    if (command === 'extract') {
      insist(options['--archive'], 'extract requires --archive');
      insist(!fs.existsSync(out) || fs.readdirSync(out).length === 0, 'output directory must be absent or empty');
      const files = makeSubset(options['--archive']);
      for (const [name, bytes] of files) { const target = path.join(out, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
    } else insist(command === 'check', `unknown command: ${command}`);
    console.log(JSON.stringify(checkSubset(out, options['--archive']), null, 2));
  } catch (error) { console.error(`Kakao subset verification failed: ${error.message}`); process.exitCode = 1; }
}
