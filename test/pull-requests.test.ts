import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import prModule, {parsePrUrl, snapshot, checkBlockers} from '../modules/bitbucket-pull-requests/index.js';
import type {ModuleContext} from '../server/module-api.js';
import {sessionPrUrls} from '../shared/pr-links.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'muster-pr-tests-'));
process.env.MUSTER_DATA_DIR = path.join(root, 'data');
const {PullRequests} = await import('../server/pull-requests.js');
const {Modules} = await import('../server/modules.js');
after(() => rmSync(root, {recursive: true, force: true}));
const url = 'https://bitbucket.org/acme/server/pull-requests/123';
const sha = 'a'.repeat(40), target = 'b'.repeat(40);
const diff = 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n';

function fixture() {
  let pr: any = {id: 123, title: 'Fix redirect', description: 'Keep the callback URL.', state: 'OPEN', author: {uuid: 'author'},
    source: {commit: {hash: sha.slice(0, 12)}, branch: {name: 'fix'}}, destination: {commit: {hash: target.slice(0, 12)}, branch: {name: 'staging'}},
    participants: [{approved: true, user: {uuid: 'reviewer'}}]};
  const data = {
    pr, diff, checks: {checks: [{key: 'git_mergeability_check', name: 'Conflicts', status: 'PASSED', blocking: false}]},
    statuses: [{state: 'SUCCESSFUL', name: 'tests'}] as any[], tasks: [] as any[], conflicts: [] as any[], denied: '', mergedState: 'MERGED',
    writes: [] as any[],
    full: {source: sha, destination: target},
  };
  const ctx: ModuleContext = {
    settings: {username: 'owner@example.test', minApprovals: 1, allowedBranches: 'staging, main'},
    secret: () => 'fake-token', log() {},
    async fetch(raw, options) {
      assert.equal(new Headers(options?.headers).get('authorization'), 'Basic ' + Buffer.from('owner@example.test:fake-token').toString('base64'));
      const commit = /\/2\.0\/repositories\/acme\/server\/commit\/([a-f0-9]+)$/.exec(new URL(raw).pathname);
      if (commit) {
        // Bitbucket's PR object has 12-character hashes; the commit endpoint returns the full one.
        const full = [data.full.source, data.full.destination].find(hash => hash.startsWith(commit[1]));
        return full ? Response.json({hash: full}) : new Response('{}', {status: 404});
      }
      const route = new URL(raw).pathname.replace('/2.0/repositories/acme/server/pullrequests/123', '') || '/';
      if (route === data.denied) return new Response('{}', {status: 403});
      if (options?.method === 'POST') {
        assert.equal(route, '/merge');
        data.writes.push(JSON.parse(String(options.body)));
        return Response.json({state: data.mergedState});
      }
      if (route === '/') return Response.json(data.pr);
      if (route === '/diff') return new Response(data.diff);
      if (route === '/statuses') return Response.json({values: data.statuses});
      if (route === '/tasks') return Response.json({values: data.tasks});
      if (route === '/conflicts') return Response.json({values: data.conflicts});
      if (route === '/mergeability/checks') return Response.json(data.checks);
      throw new Error('Unexpected request: ' + raw);
    },
  };
  return {ctx, data};
}

test('only assistant-posted complete Bitbucket PR links are listed and duplicates collapse', () => {
  const messages = [
    {role: 'user', content: 'Review https://bitbucket.org/acme/server/pull-requests/99'},
    {role: 'assistant', content: `Created [PR #123](${url}). Also ${url}/diff. Bad: ${url}evil and https://bitbucket.org.evil/acme/server/pull-requests/4`},
    {role: 'assistant', content: [{type: 'text', text: url + '#comment-5'}]},
  ];
  assert.deepEqual(sessionPrUrls(messages), [url]);
  assert.equal(parsePrUrl(url + '?x=1#y').url, url);
  for (const bad of ['http://bitbucket.org/acme/server/pull-requests/1', 'https://bitbucket.org.evil/acme/server/pull-requests/1', 'https://u:p@bitbucket.org/acme/server/pull-requests/1', 'https://bitbucket.org/acme/server/pull-requests/new']) assert.throws(() => parsePrUrl(bad));
});

test('a PR snapshot pins the source, destination and complete diff and checks the live gates', async () => {
  const {ctx, data} = fixture();
  const state = await snapshot(ctx, {url});
  assert.equal(state.source, sha);
  assert.equal(state.destination, target);
  assert.equal(state.diff, diff);
  assert.equal(state.fingerprint.length, 64);
  assert.deepEqual(state.blockers, []);
  // A PR without builds can merge, even if an old saved setting asks for one; failed or pending builds still block.
  data.statuses = [];
  assert.deepEqual((await snapshot({...ctx, settings: {...ctx.settings, requireBuild: 'yes'}}, {url})).blockers, []);
  data.statuses = [{state: 'INPROGRESS'}];
  assert.match((await snapshot(ctx, {url})).blockers.join(' '), /pending/);
  data.statuses = [{state: 'SUCCESSFUL', name: 'tests'}];
  data.pr.draft = true;
  data.pr.participants = [{approved: true, user: {uuid: 'author'}}];
  data.statuses = [{state: 'INPROGRESS'}];
  data.tasks = [{state: 'UNRESOLVED'}];
  data.conflicts = [{path: 'test.ts'}];
  const blocked = await snapshot(ctx, {url});
  assert.match(blocked.blockers.join(' '), /draft.*conflicts.*unresolved.*pending.*human approvals/);
  assert.deepEqual(data.writes, []);
});

test('unknown checks and denied checks do not enable merge', async () => {
  assert(checkBlockers({something: 'new'}).length);
  assert(checkBlockers({values: [{name: 'new check', status: 'UNRECOGNIZED', blocking: false}]}).length);
  assert.deepEqual(checkBlockers({checks: [{name: 'Approval', status: 'FAILED', blocking: true}]}), ['Approval']);
  assert(checkBlockers({checks: [{name: 'Advisory', status: 'FAILED', blocking: false}]}).length);
  assert(checkBlockers({checks: [{name: 'Unavailable', status: 'UNKNOWN', blocking: false}]}).length);
  const {ctx, data} = fixture();
  data.denied = '/mergeability/checks';
  await assert.rejects(snapshot(ctx, {url}), /403/);
  assert.deepEqual(data.writes, []);
});

test('merge is a single write after rechecking exact commits and diff; it keeps the source branch', async () => {
  const {ctx, data} = fixture();
  const pr = await snapshot(ctx, {url});
  const input = {url, source: pr.source, destination: pr.destination, fingerprint: pr.fingerprint};
  const action = prModule.actions!.merge;
  const preview = await action.preview(ctx, input);
  assert.match(preview.summary, /staging/);
  data.pr.source.commit.hash = 'c'.repeat(12);
  data.full.source = 'c'.repeat(40);
  await assert.rejects(action.run(ctx, input, () => {}), /changed since the review/);
  data.pr.source.commit.hash = sha.slice(0, 12);
  data.full.source = sha;
  data.pr.destination.commit.hash = 'd'.repeat(12);
  data.full.destination = 'd'.repeat(40);
  await assert.rejects(action.run(ctx, input, () => {}), /changed since the review/);
  data.pr.destination.commit.hash = target.slice(0, 12);
  data.full.destination = target;
  data.diff += '\n+another line';
  await assert.rejects(action.run(ctx, input, () => {}), /changed since the review/);
  data.diff = diff;
  data.statuses = [{state: 'FAILED'}];
  await assert.rejects(action.run(ctx, input, () => {}), /Merge blocked/);
  assert.deepEqual(data.writes, []);
  data.statuses = [{state: 'SUCCESSFUL'}];
  const result = await action.run(ctx, input, () => {});
  assert.match(result!.text!, /Merged #123 into staging/);
  assert.deepEqual(data.writes, [{merge_strategy: 'merge_commit', close_source_branch: false, message: 'Merge PR #123: Fix redirect'}]);
  data.mergedState = 'PENDING';
  await assert.rejects(action.run(ctx, input, () => {}), /not confirmed MERGED/);
  assert.equal(data.writes.length, 2, 'an uncertain merge is not retried');
});

test('the owner signs off on the exact diff they read, and any change needs another review', async () => {
  const {ctx, data} = fixture();
  const host: any = {
    list: () => [{id: 'bitbucket-pull-requests', enabled: true, missing: []}],
    // The real path goes through the module's child process; here the module code runs directly.
    callTool: async (_name: string, input: any) => JSON.stringify(await snapshot(ctx, input)),
  };
  const service = new PullRequests(path.join(root, 'reviews'), host);
  const thread: any = {id: 'thread-a', messages: [{role: 'assistant', content: url}]};
  const key = service.list(thread).prs[0].key;
  assert.throws(() => service.input(thread, key), /Review the current diff first/);

  const shown = await service.snapshot(thread, key);
  assert.equal(shown.diff, diff);
  assert.equal(shown.review, undefined);
  // A push between opening the diff and signing off is caught.
  data.diff += '+sneaky\n';
  await assert.rejects(service.markReviewed(thread, key, shown), /changed since you opened the diff/);
  data.diff = diff;
  const review = await service.markReviewed(thread, key, shown);
  assert.equal(review.source, sha);
  assert.equal(service.list(thread).prs[0].review!.fingerprint, shown.fingerprint);

  const input = service.input(thread, key);
  service.requireReview(input);
  assert.throws(() => service.requireReview({...input, source: 'e'.repeat(40)}), /Review the current diff first/);
  assert.throws(() => service.requireReview({...input, destination: 'e'.repeat(40)}), /Review the current diff first/);
  assert.throws(() => service.requireReview({...input, fingerprint: 'bad'}), /Review the current diff first/);
  // A PR the assistant never linked in this session is not reachable.
  assert.throws(() => service.input({id: 'other', messages: []} as any, key), /No such PR/);
  assert.equal(data.writes.length, 0, 'reviewing never writes to Bitbucket');
});

test('a module action with a policy fails closed through generic preview and run routes', async () => {
  const moduleRoot = path.join(root, 'modules'), dir = path.join(moduleRoot, 'guarded');
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({id: 'guarded', name: 'Guarded', version: '1', apiVersion: 1, entry: './index.mjs', settings: [], network: [],
    actions: [{id: 'merge', title: 'Merge', policy: 'reviewed-bitbucket-pr', confirm: 'never'}]}));
  writeFileSync(path.join(dir, 'index.mjs'), 'export default {actions:{merge:{preview:()=>({summary:"merge"}),run:()=>({text:"done"})}}};');
  const host = new Modules([moduleRoot]);
  host.save('guarded', {enabled: true});
  await assert.rejects(host.preview('guarded', 'merge', {}), /policy.*not available/);
  assert.throws(() => host.run('guarded', 'merge', {}, undefined), /policy.*not available/);
  host.actionPolicies.set('reviewed-bitbucket-pr', () => { throw new Error('Review required'); });
  await assert.rejects(host.preview('guarded', 'merge', {}), /Review required/);
  assert.throws(() => host.run('guarded', 'merge', {}, undefined), /Review required/);
  host.actionPolicies.set('reviewed-bitbucket-pr', () => {});
  const preview = await host.preview('guarded', 'merge', {});
  assert.throws(() => host.run('guarded', 'merge', {}, undefined), /Preview the action/);
  assert.throws(() => host.run('guarded', 'merge', {changed: true}, preview.token), /Preview the action/);
  const run = host.run('guarded', 'merge', {}, preview.token);
  assert.throws(() => host.run('guarded', 'merge', {}, preview.token), /Preview the action/);
  for (let i = 0; run.status === 'running' && i < 100; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(run.status, 'succeeded');
});
