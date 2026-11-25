import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {matchPrLink, sessionPrLinks, validTemplate} from '../shared/pr-links.js';
import {prFingerprint} from '../packages/module-sdk/index.ts';

const root = mkdtempSync(path.join(os.tmpdir(), 'muster-pr-tests-'));
process.env.MUSTER_DATA_DIR = path.join(root, 'data');
const {PullRequests, REVIEWED_PR} = await import('../server/pull-requests.js');
const {Modules} = await import('../server/modules.js');
after(() => rmSync(root, {recursive: true, force: true}));

const url = 'https://git.example.test/acme/server/pulls/123';
const sha = 'a'.repeat(40);
const target = 'b'.repeat(40);
const diff = 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n';
const providers = [{module: 'fakegit', links: [{host: 'git.example.test', path: '/{owner}/{repo}/pulls/{number}'}]}];

test('PR links come from assistant messages and match a provider template exactly', () => {
  const messages = [
    {role: 'user', content: 'Review https://git.example.test/acme/server/pulls/99'},
    {role: 'assistant', content: `Created [PR #123](${url}). Also ${url}/files. Bad: ${url}evil, https://git.example.test.evil/acme/server/pulls/4 and http://git.example.test/a/b/pulls/5`},
    {role: 'assistant', content: [{type: 'text', text: url + '#comment-5. Done.'}]},
  ];
  assert.deepEqual(sessionPrLinks(messages, providers), [{url, module: 'fakegit', repository: 'acme/server', number: '123'}]);
  assert.deepEqual(sessionPrLinks(messages, []), [], 'no provider, no PR links');
  for (const bad of [
    'https://u:p@git.example.test/acme/server/pulls/1',
    'https://git.example.test:8443/acme/server/pulls/1',
    'https://git.example.test/acme/server/pulls/new',
    'https://git.example.test/acme/server/issues/1',
    'https://git.example.test/acme/../pulls/1',
  ]) assert.equal(matchPrLink(bad, providers), undefined, bad);
  assert(validTemplate({host: 'bitbucket.org', path: '/{owner}/{repo}/pull-requests/{number}'}));
  for (const bad of [
    {host: 'bitbucket.org', path: '/{owner}/{repo}'},
    {host: 'bitbucket.org', path: '/{a}/{a}/{number}'},
    {host: 'BitBucket', path: '/{number}'},
    {host: 'bitbucket.org', path: '/../{number}'},
    {host: 'bitbucket.org', path: '/x/{number}/{number}'},
  ]) assert.equal(validTemplate(bad), false, JSON.stringify(bad));
});

// A provider module that reads the PR from a file the test controls and records merges in another.
const modulesDir = path.join(root, 'modules');
const stateFile = path.join(root, 'pr.json');
const mergedFile = path.join(root, 'merged.jsonl');
const writePr = (pr: object) => writeFileSync(stateFile, JSON.stringify(pr));
const basePr = {url, title: 'Fix redirect', state: 'OPEN', source: sha, destination: target, sourceBranch: 'fix', target: 'staging', approvals: 0, statuses: [], blockers: [], diff};

function provider(id: string, host: string) {
  const dir = path.join(modulesDir, id);
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({
    id, name: id, version: '1.0.0', apiVersion: 1, entry: './index.mjs', network: [], settings: [],
    actions: [{id: 'merge', title: 'Merge reviewed PR', policy: 'reviewed-pr'}],
    providers: {pullRequests: {links: [{host, path: '/{owner}/{repo}/pulls/{number}'}], mergeAction: 'merge'}},
  }));
  writeFileSync(path.join(dir, 'index.mjs'), `
import {appendFileSync, readFileSync} from 'node:fs';
const read = () => JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
export default {
  providers: {pullRequests: {snapshot: async (ctx, input) => ({...read(), url: input.url, fingerprint: 'not trusted'})}},
  actions: {merge: {
    preview: (ctx, input) => ({summary: 'Merge ' + input.url, danger: true}),
    run: (ctx, input) => { appendFileSync(${JSON.stringify(mergedFile)}, JSON.stringify(input) + '\\n'); return {text: 'Merged'}; },
  }},
};`);
}
provider('fakegit', 'git.example.test');
provider('othergit', 'other.example.test');

async function settle(run: {status: string}) {
  for (let i = 0; run.status === 'running' && i < 200; i++) await new Promise(r => setTimeout(r, 25));
}

test('the owner reviews the exact diff a provider shows, and only then can that provider merge it', async () => {
  writePr(basePr);
  const modules = new Modules([modulesDir]);
  modules.actionPolicies.set(REVIEWED_PR, (input, call) => service.requireReview(input, call));
  const service = new PullRequests(path.join(root, 'reviews'), modules);
  const thread: any = {id: 'thread-a', messages: [{role: 'assistant', content: `PR: ${url}`}]};

  let view = service.list(thread);
  assert.equal(view.prs.length, 1);
  assert.equal(view.prs[0].module, 'fakegit');
  assert.equal(view.prs[0].configured, false, 'the module is off');
  const key = view.prs[0].key;
  await assert.rejects(service.snapshot(thread, key), /turned off/);
  modules.save('fakegit', {enabled: true});
  modules.save('othergit', {enabled: true});

  const shown = await service.snapshot(thread, key);
  assert.equal(shown.diff, diff);
  assert.equal(shown.fingerprint, prFingerprint(url, sha, target, diff), 'Muster computes the fingerprint itself');
  assert.throws(() => service.merge(thread, key), /Review the current diff first/);

  // A push between opening the diff and signing off is caught.
  writePr({...basePr, diff: diff + '+sneaky\n'});
  await assert.rejects(service.markReviewed(thread, key, shown), /changed since you opened the diff/);
  writePr(basePr);
  await service.markReviewed(thread, key, shown);
  view = service.list(thread);
  assert.equal(view.prs[0].review!.source, sha);

  // The merge action runs only through its own module, for the reviewed revision, after a preview.
  const merge = service.merge(thread, key);
  assert.deepEqual(merge, {module: 'fakegit', action: 'merge', input: {url, source: sha, destination: target, fingerprint: shown.fingerprint}});
  assert.throws(() => modules.run('fakegit', 'merge', merge.input, undefined), /Preview the action again/);
  await assert.rejects(modules.preview('othergit', 'merge', merge.input), /not handled by this module/);
  await assert.rejects(modules.preview('fakegit', 'merge', {...merge.input, source: 'c'.repeat(40)}), /Review the current diff first/);
  const preview = await modules.preview('fakegit', 'merge', merge.input);
  const run = modules.run('fakegit', 'merge', merge.input, preview.token);
  await settle(run);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(readFileSync(mergedFile, 'utf8').trim().split('\n').length, 1);

  // A PR the assistant never linked in this session is not reachable from it.
  assert.throws(() => service.merge({id: 'other', messages: []} as any, key), /No such PR/);
});

test('a provider that returns another PR or no commits is refused', async () => {
  const modules = new Modules([modulesDir]);
  modules.save('fakegit', {enabled: true});
  const service = new PullRequests(path.join(root, 'reviews-2'), modules);
  const thread: any = {id: 'thread-b', messages: [{role: 'assistant', content: url}]};
  const key = service.list(thread).prs[0].key;
  writePr({...basePr, source: 'not-a-hash'});
  await assert.rejects(service.snapshot(thread, key), /no commit hashes/);
  writePr({...basePr, diff: undefined});
  await assert.rejects(service.snapshot(thread, key), /no usable diff/);
  writePr(basePr);
  assert.equal(existsSync(path.join(root, 'reviews-2')), false, 'nothing was recorded');
});

test('a module action with a policy fails closed through generic preview and run routes', async () => {
  const moduleRoot = path.join(root, 'guarded-modules'), dir = path.join(moduleRoot, 'guarded');
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({id: 'guarded', name: 'Guarded', version: '1', apiVersion: 1, entry: './index.mjs', settings: [], network: [],
    actions: [{id: 'merge', title: 'Merge', policy: 'reviewed-pr', confirm: 'never'}]}));
  writeFileSync(path.join(dir, 'index.mjs'), 'export default {actions:{merge:{preview:()=>({summary:"merge"}),run:()=>({text:"done"})}}};');
  const host = new Modules([moduleRoot]);
  host.save('guarded', {enabled: true});
  await assert.rejects(host.preview('guarded', 'merge', {}), /policy.*not available/);
  assert.throws(() => host.run('guarded', 'merge', {}, undefined), /policy.*not available/);
  host.actionPolicies.set('reviewed-pr', () => { throw new Error('Review required'); });
  await assert.rejects(host.preview('guarded', 'merge', {}), /Review required/);
  assert.throws(() => host.run('guarded', 'merge', {}, undefined), /Review required/);
  host.actionPolicies.set('reviewed-pr', () => {});
  const preview = await host.preview('guarded', 'merge', {});
  assert.throws(() => host.run('guarded', 'merge', {}, undefined), /Preview the action/, 'a policy forces confirmation even if the manifest says never');
  assert.throws(() => host.run('guarded', 'merge', {changed: true}, preview.token), /Preview the action/);
  const run = host.run('guarded', 'merge', {}, preview.token);
  assert.throws(() => host.run('guarded', 'merge', {}, preview.token), /Preview the action/);
  await settle(run);
  assert.equal(run.status, 'succeeded');
});
