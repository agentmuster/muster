import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const data = mkdtempSync(path.join(os.tmpdir(), 'muster-files-data-'));
const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'muster-files-work-')));
const outside = realpathSync(mkdtempSync(path.join(os.homedir(), '.muster-files-outside-')));
process.env.MUSTER_DATA_DIR = data;
process.env.MUSTER_WORKSPACE_ROOTS = work;
const fakePi = path.resolve(import.meta.dirname, 'fake-pi.mjs');
chmodSync(fakePi, 0o755);
process.env.PI_BIN = fakePi;

const {Jobs} = await import('../server/jobs.js');
const {checkShareable, shareRoots} = await import('../server/files.js');
const {takeover} = await import('../server/browser.js');
takeover.paused = false;
const noContext = {search: async () => ({results: [], warnings: []}), context: async () => []};

after(() => {
  for (const folder of [data, work, outside]) rmSync(folder, {recursive: true, force: true});
});

const put = (file: string, text = 'x') => {
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, text);
  return file;
};

test('only ordinary files inside the folder or /tmp can be shared, never credentials', () => {
  // Roots without the temp folder, so the test's "outside" folder really is outside.
  const roots = [path.join(work, 'project')];
  const report = put(path.join(work, 'project/out/report.pdf'));
  assert.equal(checkShareable(report, roots).path, report);
  for (const secret of ['.env', '.env.local', 'id_ed25519', 'server.pem', 'aws-credentials.txt', '.ssh/config', '.npmrc']) {
    assert.throws(() => checkShareable(put(path.join(work, 'project', secret)), roots), /Credential/, secret);
  }
  assert.throws(() => checkShareable(put(path.join(outside, 'notes.txt')), roots), /Only files inside/);
  assert.throws(() => checkShareable(path.join(work, 'project/out'), roots), /regular files/);
  assert.throws(() => checkShareable(path.join(work, 'project/missing.txt'), roots), /not found/);
  assert.throws(() => checkShareable('project/out/report.pdf', roots), /absolute/);
  // A harmless-looking link to a key is judged by what it points at.
  const key = put(path.join(outside, '.ssh/id_rsa'));
  symlinkSync(key, path.join(work, 'project/innocent.txt'));
  assert.throws(() => checkShareable(path.join(work, 'project/innocent.txt'), roots), /Credential/);
  // The app's own data (password, sign-ins, threads) is off limits even if a thread runs there.
  assert.throws(() => checkShareable(put(path.join(data, 'sessions.json')), [data]), /own data/);
  assert(shareRoots(work).includes(realpathSync(os.tmpdir())));
});

test('files written by the agent are listed automatically; share_file adds others', async () => {
  const manager = new Jobs(noContext);
  const thread = manager.create(work, [], false);
  process.env.FAKE_PI_SCENARIO = 'write';
  process.env.FAKE_PI_WRITE_FILE = path.join(work, 'report.md');
  const live = await manager.start(thread.id, 'write a report');
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (live.done) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });
  assert.deepEqual(thread.files?.map(file => [file.name, file.via]), [['report.md', 'write']]);

  // The agent's share_file tool goes through the same checks.
  const chart = put(path.join(work, 'charts/latency.png'), 'png');
  const shared = manager.shareFile(thread.id, 'charts/latency.png', 'share');
  assert.equal(shared.path, chart);
  assert.throws(() => manager.shareFile(thread.id, put(path.join(work, '.env')), 'share'), /Credential/);

  // Served files are checked again: a file swapped for a link to a secret is refused.
  rmSync(chart);
  symlinkSync(put(path.join(outside, 'secret-token.txt')), chart);
  assert.throws(() => manager.sharedFile(thread.id, shared.id), /Credential|Only files inside/);
  assert.throws(() => manager.sharedFile(thread.id, 'nope'), /not shared/);

  manager.unshareFile(thread.id, shared.id);
  assert.deepEqual(new Jobs(noContext).get(thread.id).files?.map(file => file.name), ['report.md']);
});

const done = (live: any) =>
  new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (live.done) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

test('the version before the first change is kept, and files are sorted into code changes and artifacts', () => {
  const manager = new Jobs(noContext);
  const thread = manager.create(work, [], false);
  const file = put(path.join(work, 'src/billing.py'), 'a = 1\nb = 2\nc = 3\n');
  manager.saveBaseline(thread.id, 'src/billing.py');
  writeFileSync(file, 'a = 1\nb = 20\nc = 3\nd = 4\n');
  // A second save keeps the first version: the diff covers everything this thread changed.
  manager.saveBaseline(thread.id, file);
  const edited = manager.shareFile(thread.id, file, 'edit');
  assert.deepEqual([edited.kind, edited.created, edited.linesAdded, edited.linesRemoved], ['change', false, 2, 1]);
  const diff = manager.fileDiff(thread.id, edited.id);
  assert.match(diff.patch, /^-b = 2$/m);
  assert.match(diff.patch, /^\+b = 20$/m);
  assert.match(diff.patch, /^\+d = 4$/m);

  // New files: source is a code change, a report is an artifact; shared files are artifacts.
  manager.saveBaseline(thread.id, 'scripts/run.sh');
  manager.saveBaseline(thread.id, 'SUMMARY.md');
  put(path.join(work, 'scripts/run.sh'), '#!/bin/bash\necho hi\n');
  put(path.join(work, 'SUMMARY.md'), '# Report\n');
  const script = manager.shareFile(thread.id, 'scripts/run.sh', 'write');
  const report = manager.shareFile(thread.id, 'SUMMARY.md', 'write');
  assert.deepEqual([script.kind, script.created, script.linesAdded], ['change', true, 2]);
  assert.deepEqual([report.kind, report.created], ['artifact', true]);
  assert.match(manager.fileDiff(thread.id, script.id).patch, /^--- \/dev\/null$/m);
  put(path.join(work, 'out.csv'), 'a,b\n');
  assert.equal(manager.shareFile(thread.id, 'out.csv', 'share').kind, 'artifact');
  assert.throws(() => manager.fileDiff(thread.id, manager.shareFile(thread.id, 'out.csv', 'share').id), /No earlier version/);

  // Credentials are never copied, and nothing outside the folder is tracked.
  assert.throws(() => manager.saveBaseline(thread.id, '.env'), /Credential/);
  assert.throws(() => manager.saveBaseline(thread.id, path.join(outside, 'x.py')), /Only files inside/);
  assert.equal(Object.keys(thread.baselines!).length, 3);
});

test("without a saved version, an edit's patch is undone to recover the file before the edit", async () => {
  const manager = new Jobs(noContext);
  const thread = manager.create(work, [], false);
  const file = put(path.join(work, 'calc.py'), 'x = 1\ny = 2\nz = 3\n');
  process.env.FAKE_PI_SCENARIO = 'edit';
  process.env.FAKE_PI_WRITE_FILE = file;
  await done(await manager.start(thread.id, 'edit it'));
  const entry = thread.files!.find(candidate => candidate.name === 'calc.py')!;
  assert.deepEqual([entry.kind, entry.linesAdded, entry.linesRemoved], ['change', 1, 1]);
  const diff = manager.fileDiff(thread.id, entry.id);
  assert.match(diff.patch, /^-y = 2$/m);
  assert.match(diff.patch, /^\+y = 3$/m);
});
