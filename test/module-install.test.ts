import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Installing from a module repository: a local git repository with registry.json stands in for muster-modules,
// and a fake npm records how dependencies are installed.

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'muster-install-')));
const data = path.join(root, 'data');
process.env.MUSTER_DATA_DIR = data;
const home = path.join(root, 'modules-home');
const state = path.join(data, 'modules');
const repo = path.join(root, 'registry-repo');
const registryUrl = `file://${repo}`;
after(() => rmSync(root, {recursive: true, force: true}));

const {Modules} = await import('../server/modules.js');
const {ModuleInstaller, SDK_DIR, checkGitUrl, newerVersion} = await import('../server/module-install.js');

const fakeNpm = path.join(root, 'fake-npm.mjs');
writeFileSync(fakeNpm, `#!/usr/bin/env node
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(path.join(root, 'npm-calls.log'))}, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}) + '\\n');
mkdirSync('node_modules/left-pad', {recursive: true});
writeFileSync('node_modules/left-pad/index.js', 'module.exports = s => "  " + s;');
`, {mode: 0o755});

const git = (...args: string[]) => execFileSync('git', args, {cwd: repo, encoding: 'utf8', env: {...process.env, GIT_TERMINAL_PROMPT: '0'}});

function writeModule(id: string, version: string, network: string[], extra: object = {}) {
  const dir = path.join(repo, 'packages', id);
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({
    id, name: id === 'demo' ? 'Demo' : id, version, apiVersion: 1, entry: './index.ts', network,
    settings: [{key: 'token', label: 'API token', type: 'secret'}],
    tools: [{name: `${id.replace(/-/g, '_')}_hello`, description: 'Says hello', parameters: {type: 'object'}}],
    actions: [{id: 'ping', title: 'Ping'}],
    ...extra,
  }));
  // Installed modules import the SDK that Muster links into the modules folder.
  writeFileSync(path.join(dir, 'index.ts'), `import {defineModule} from '@agentmuster/module-sdk';
export default defineModule({
  tools: {${id.replace(/-/g, '_')}_hello: () => 'hello from ${id} ${version}'},
  actions: {ping: {preview: () => ({summary: 'Ping'}), run: async () => ({text: 'pong'})}},
});
`);
}

function writeRegistry(entries: object[]) {
  writeFileSync(path.join(repo, 'registry.json'), JSON.stringify({format: 1, modules: entries}));
  git('add', '-A');
  git('-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-q', '-m', 'update');
}

mkdirSync(repo, {recursive: true});
git('init', '-q');
writeModule('demo', '1.0.0', ['api.example.test']);
writeModule('withdeps', '1.0.0', []);
writeFileSync(path.join(repo, 'packages/withdeps/package.json'), JSON.stringify({name: 'withdeps', dependencies: {'left-pad': '1.3.0'}, devDependencies: {typescript: '5.9.0'}}));
writeRegistry([
  {id: 'demo', name: 'Demo', description: 'A demo module', version: '1.0.0', path: 'packages/demo', categories: ['testing']},
  {id: 'withdeps', name: 'With deps', description: 'Has an npm dependency', version: '1.0.0', path: 'packages/withdeps'},
  {id: 'escape', name: 'Escape', description: 'Points outside', version: '1.0.0', path: '../outside'},
]);

const modules = new Modules([home]);
const installer = new ModuleInstaller(modules, home, state, [registryUrl], {git: 'git', npm: fakeNpm});

test('only https and local file git URLs are accepted', () => {
  assert.equal(checkGitUrl('https://github.com/acme/modules/'), 'https://github.com/acme/modules');
  for (const bad of ['ssh://git@github.com/acme/x', 'ext::sh -c touch /tmp/x', 'git@github.com:acme/x.git', '-uhttps://x', 'https://user:pass@github.com/x', 'file://relative', 'http://example.com/x']) {
    assert.throws(() => checkGitUrl(bad), /https git URL|credentials/, bad);
  }
  assert(newerVersion('1.2.0', '1.1.9'));
  assert(newerVersion('1.10.0', '1.9.0'));
  assert(!newerVersion('1.0.0', '1.0.0'));
});

test('browsing lists the repository, skipping entries that point outside it', async () => {
  const listing = await installer.browse();
  const registry = listing.registries[0];
  assert.equal(registry.error, undefined);
  assert.match(registry.commit!, /^[a-f0-9]{40}$/);
  assert.deepEqual(registry.modules.map(m => m.id), ['demo', 'withdeps']);
  assert.equal(registry.modules[0].installed, null);
});

test('installing shows what the module can reach, then installs it switched off and able to load the SDK', async () => {
  const preview = await installer.preview({registry: registryUrl, id: 'demo'});
  assert.equal(preview.id, 'demo');
  assert.equal(preview.reviewed, false, 'only the official repository counts as reviewed');
  assert.deepEqual(preview.permissions.network, ['api.example.test']);
  assert.deepEqual(preview.permissions.tools, ['demo_hello']);
  assert.deepEqual(preview.permissions.secrets, ['API token']);
  assert.equal(preview.update, null);
  assert.equal(existsSync(path.join(home, 'demo')), false, 'nothing is installed before the owner confirms');

  await assert.rejects(installer.install('not-a-token'), /Review the module again/);
  const done = await installer.install(preview.token);
  assert.deepEqual(done, {id: 'demo', version: '1.0.0', updated: false});
  await assert.rejects(installer.install(preview.token), /Review the module again/, 'a token works once');

  const lock = installer.lock().demo;
  assert.equal(lock.source.kind, 'registry');
  assert.match(lock.hash, /^[a-f0-9]{64}$/);
  assert.equal(modules.list().find(m => m.id === 'demo')!.enabled, false);
  assert.equal(readlinkSync(path.join(home, 'node_modules/@agentmuster/module-sdk')), SDK_DIR);

  modules.save('demo', {enabled: true, secrets: {token: 'secret-1'}});
  assert.equal((await modules.callTool('demo_hello', {})).trim(), 'hello from demo 1.0.0');
});

test('dependencies install with npm scripts off and without dev dependencies', async () => {
  const preview = await installer.preview({registry: registryUrl, id: 'withdeps'});
  assert.deepEqual(preview.dependencies, ['left-pad']);
  await installer.install(preview.token);
  const call = JSON.parse(readFileSync(path.join(root, 'npm-calls.log'), 'utf8').trim().split('\n').at(-1)!);
  assert.deepEqual(call.args.slice(0, 4), ['install', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps']);
  assert(existsSync(path.join(home, 'withdeps/node_modules/left-pad/index.js')));
});

test('an update shows only what is new, keeps the on/off setting, and can be rolled back', async () => {
  writeModule('demo', '1.1.0', ['api.example.test', 'files.example.test']);
  writeRegistry([{id: 'demo', name: 'Demo', description: 'A demo module', version: '1.1.0', path: 'packages/demo'}]);
  const listing = await installer.browse(true);
  const entry = listing.registries[0].modules.find(m => m.id === 'demo')!;
  assert.deepEqual(entry.installed, {version: '1.0.0'});
  assert.equal(entry.updateAvailable, true);

  const preview = await installer.preview({registry: registryUrl, id: 'demo'});
  assert.equal(preview.update!.from, '1.0.0');
  assert.deepEqual(preview.update!.added.network, ['files.example.test']);
  assert.equal(preview.update!.sourceChanged, false);
  await installer.install(preview.token);
  assert.equal(modules.list().find(m => m.id === 'demo')!.enabled, true);
  assert.equal((await modules.callTool('demo_hello', {})).trim(), 'hello from demo 1.1.0');
  assert.equal(installer.lock().demo.previous!.version, '1.0.0');

  await installer.rollback('demo');
  assert.equal(modules.manifests.get('demo')!.version, '1.0.0');
  assert.equal((await modules.callTool('demo_hello', {})).trim(), 'hello from demo 1.0.0');
  assert.equal(installer.lock().demo.previous!.version, '1.1.0', 'rolling back again goes forward');
});

test('a stage that changed after review, or a module with a symbolic link, is refused', async () => {
  const preview = await installer.preview({registry: registryUrl, id: 'demo'});
  const staged = (installer as any).staged.get(preview.token).dir;
  writeFileSync(path.join(staged, 'index.ts'), 'export default {}; // changed');
  await assert.rejects(installer.install(preview.token), /changed after it was reviewed/);

  const folder = path.join(root, 'linky');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'muster-module.json'), readFileSync(path.join(repo, 'packages/demo/muster-module.json')));
  symlinkSync('/etc/hosts', path.join(folder, 'hosts'));
  await assert.rejects(installer.preview({folder}), /symbolic link/);
});

test('a folder installs as not reviewed; removing deletes the module, its settings and its secrets', async () => {
  const folder = path.join(root, 'folder-module');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'muster-module.json'), JSON.stringify({id: 'from-folder', name: 'From folder', version: '0.1.0', apiVersion: 1, entry: './index.ts', network: [], settings: []}));
  writeFileSync(path.join(folder, 'index.ts'), 'export default {};');
  const preview = await installer.preview({folder});
  assert.equal(preview.reviewed, false);
  assert.equal(preview.source, folder);
  await installer.install(preview.token);
  assert(modules.manifests.has('from-folder'));

  await installer.remove('demo');
  assert.equal(existsSync(path.join(home, 'demo')), false);
  assert.equal(existsSync(path.join(home, '.previous', 'demo')), false);
  assert.equal(installer.lock().demo, undefined);
  const secrets = JSON.parse(readFileSync(path.join(state, 'secrets.json'), 'utf8'));
  assert.equal(secrets.demo, undefined);
  assert.equal(modules.manifests.has('demo'), false);
  assert.match(readFileSync(path.join(state, 'activity.jsonl'), 'utf8'), /"event":"remove","module":"demo"/);
});

test('an id the repository did not list, an unknown repository, and a locked desktop are refused', async () => {
  writeModule('liar', '1.0.0', [], {id: 'someone-else'});
  writeRegistry([{id: 'liar', name: 'Liar', description: '', version: '1.0.0', path: 'packages/liar'}]);
  await installer.browse(true);
  await assert.rejects(installer.preview({registry: registryUrl, id: 'liar'}), /lists liar, but its manifest says someone-else/);
  await assert.rejects(installer.preview({registry: 'https://example.com/other-modules', id: 'demo'}), /not in the list/);
  process.env.MUSTER_MODULE_INSTALL_DISABLED = '1';
  try {
    assert.throws(() => installer.preview({registry: registryUrl, id: 'demo'}), /turned off on this desktop/);
    assert.throws(() => installer.remove('withdeps'), /turned off on this desktop/);
  } finally {
    delete process.env.MUSTER_MODULE_INSTALL_DISABLED;
  }
});

test('the command line installs from the repository, and a running Muster notices', async () => {
  writeModule('demo', '1.2.0', ['api.example.test']);
  writeRegistry([{id: 'demo', name: 'Demo', description: 'A demo module', version: '1.2.0', path: 'packages/demo'}]);
  const env = {...process.env, MUSTER_DATA_DIR: data, MUSTER_MODULES_DIR: home, MUSTER_MODULE_REGISTRIES: registryUrl};
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/agentmuster.mjs'), 'module', ...args], {env, encoding: 'utf8'});
  const refused = cli('add', 'demo');
  assert.notEqual(refused.status, 0, 'without a terminal it asks for --yes');
  const added = cli('add', 'demo', '--yes');
  assert.equal(added.status, 0, added.stderr + added.stdout);
  assert.match(added.stdout, /Websites: api\.example\.test/);
  assert.match(added.stdout, /Installed demo 1\.2\.0/);
  const listed = cli('list');
  assert.match(listed.stdout, /demo 1\.2\.0 off/);
  installer.syncFromDisk();
  assert.equal(modules.manifests.get('demo')!.version, '1.2.0');
});
