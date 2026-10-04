import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { UPSTREAM, DEFAULT_DIR, checkSubset, scanImports, buildClosure, readArchive } from '../scripts/kakao-subset.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const subset = path.join(dir, 'sdk'); fs.cpSync(DEFAULT_DIR, subset, { recursive: true });
  return subset;
}
function modules(source, extras = {}) {
  return new Map(Object.entries({ [UPSTREAM.entrypoint]: source, ...extras }).map(([key, value]) => [key, Buffer.from(value)]));
}

test('subset source manifest preserves the pinned archive, license qualification and complete dynamic closure', () => {
  const result = checkSubset();
  assert.equal(result.runtimeModules, 22); assert.equal(result.files, 29);
  const manifest = JSON.parse(fs.readFileSync(path.join(DEFAULT_DIR, 'source-manifest.json')));
  assert.equal(manifest.upstream.sha256, 'e72b7af4ad4a61c6263c9814438019ae043a1a339520addfddfa9591b5e4e22a');
  assert.equal(manifest.license.declared, 'MIT');
  assert.equal(manifest.license.standaloneTopLevelLicense, false);
  assert.equal(manifest.license.originalPackageLicenseField, null);
  assert.deepEqual(manifest.dependencies, { bson: '6.10.4', zod: '4.6.5' });
  const dynamic = manifest.closure.modules.flatMap(module => module.imports.filter(edge => edge.kind === 'dynamic'));
  assert.deepEqual(dynamic, [{ specifier: './ensure-auth.js', kind: 'dynamic', target: 'dist/src/platforms/kakaotalk/ensure-auth.js' }]);
  for (const file of manifest.files) assert.match(file.upstreamPath, /^package\//);
  assert.match(fs.readFileSync(path.join(DEFAULT_DIR, 'provenance/README.upstream.md'), 'utf8'), /## License\n\nMIT\s*$/);
  const notice = fs.readFileSync(path.join(DEFAULT_DIR, 'src/platforms/kakaotalk/protocol/NOTICE.md'), 'utf8');
  assert.match(notice, /No code was\ncopied/);
  assert.match(notice, /KakaoForge Non-Commercial \/ No Abuse License/);
  const license = fs.readFileSync(path.join(DEFAULT_DIR, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License\n\nCopyright \(c\) agent-messenger contributors\n\(https:\/\/github\.com\/agent-messenger\/agent-messenger\)/);
  assert.match(license, /The above copyright notice and this permission notice shall be included in all\ncopies/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DEFAULT_DIR, 'package.json'))).license, 'MIT');
});

test('AST graph includes multiline imports, side-effect imports, reexports and literal dynamic imports', () => {
  assert.deepEqual(scanImports(`import {\n a as b\n} from './one.js';\nimport './two.js';\nexport * from './three.js';\nexport { x } from './four.js';\nawait import('./five.js');\n// import('ignored')\nconst text = "import('also ignored')";`),
    ['one', 'two', 'three', 'four', 'five'].map((name, index) => ({ specifier: `./${name}.js`, kind: index === 4 ? 'dynamic' : 'static' })));
  const closure = buildClosure(modules(`export * from './other.js';`, {
    'dist/src/platforms/kakaotalk/other.js': `await import('./index.js'); import { z } from 'zod';`,
  }));
  assert.equal(closure.modules.length, 2); assert.deepEqual(closure.external, ['zod']);
});

test('nonliteral imports and alternative executable loaders fail closed instead of silently dropping edges', () => {
  for (const source of ["import(name)", "import('./' + name)", 'import(`./${name}.js`)',
    "require('./hidden.js')", "const load = require; load('./hidden.js')", "import { createRequire } from 'node:module'",
    "eval('import(unknown)')", "new Function('return 1')"])
    assert.throws(() => scanImports(source), /non-literal|unsupported executable loader/);
  assert.throws(() => scanImports('import {'), SyntaxError);
});

test('missing static/dynamic targets, escape paths, unexpected externals and new loader builtins are rejected', () => {
  for (const source of ["import './missing.js'", "await import('./missing.js')", "export * from './missing.js'",
    "import '../../../../escape.js'", "import 'node-forge'", "import 'node:module'", "import 'node:child_process'",
    "import 'zod/not-reviewed'", "import 'https://example.invalid/module.js'"])
    assert.throws(() => buildClosure(modules(source)), /missing|unsafe path|out-of-bound|unexpected/);
});

test('source verifier rejects byte changes, missing files, extra executable files and symlinks', t => {
  for (const mutate of [
    dir => fs.appendFileSync(path.join(dir, UPSTREAM.entrypoint), '\n// unauthorized change\n'),
    dir => fs.unlinkSync(path.join(dir, 'dist/src/platforms/kakaotalk/ensure-auth.js')),
    dir => fs.writeFileSync(path.join(dir, 'dist/extra.js'), 'export {};'),
    dir => fs.symlinkSync(path.join(dir, 'README.md'), path.join(dir, 'linked.md')),
  ]) {
    const dir = fixture(t); mutate(dir);
    assert.throws(() => checkSubset(dir), /hash mismatch|missing|extra|symlink/);
  }
});

test('manifest and metadata tampering cannot silently change the declared license or dependencies', t => {
  for (const [filename, change] of [
    ['source-manifest.json', value => { value.license.declared = 'invented-license'; }],
    ['package.json', value => { value.dependencies['node-forge'] = '1.4.0'; }],
  ]) {
    const dir = fixture(t), filenameFull = path.join(dir, filename);
    const value = JSON.parse(fs.readFileSync(filenameFull)); change(value);
    fs.writeFileSync(filenameFull, `${JSON.stringify(value, null, 2)}\n`);
    assert.throws(() => checkSubset(dir), /manifest|metadata/);
  }
});

test('MIT license notice cannot be removed or altered', t => {
  const altered = fixture(t);
  fs.writeFileSync(path.join(altered, 'LICENSE'), 'All rights reserved\n');
  assert.throws(() => checkSubset(altered), /metadata mismatch: LICENSE/);
  const removed = fixture(t);
  fs.rmSync(path.join(removed, 'LICENSE'));
  assert.throws(() => checkSubset(removed), /metadata mismatch: LICENSE/);
});

test('lock and physical install contain only the Kakao subset, bson, zod and development parser', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/@kakao-ai-bridge/kakao-sdk',
    'node_modules/acorn', 'node_modules/bson', 'node_modules/zod', 'vendor/kakao-sdk'].sort());
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(pkg.overrides, undefined); assert.equal(pkg.optionalDependencies, undefined);
  assert.deepEqual(pkg.dependencies, { '@kakao-ai-bridge/kakao-sdk': 'file:vendor/kakao-sdk', bson: '6.10.4' });
  assert.deepEqual(pkg.devDependencies, { acorn: '8.18.0' });
  for (const name of ['agent-messenger', 'node-forge', 'node-kms', 'node-jose', 'uuid', 'thrift', 'webex-message-handler']) {
    assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, name);
    assert.throws(() => require.resolve(`${name}/package.json`), { code: 'MODULE_NOT_FOUND' }, name);
  }
});

test('extractor rejects an unpinned archive before parsing or creating output', t => {
  const dir = fixture(t), archive = path.join(path.dirname(dir), 'not-upstream.tgz');
  fs.writeFileSync(archive, 'not the pinned upstream artifact');
  assert.throws(() => readArchive(archive), /SHA256 mismatch/);
});
