import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MUSTER_DATA_DIR = path.join(mkdtempSync(path.join(os.tmpdir(), 'muster-triage-')), '.local', 'data');
const {applyResult, buildPrompt} = await import('../server/triage.js');

const item = (n: number, text: string, author = 'Dana') => ({
  key: `teams:inbox:${n}`, module: 'teams', feed: 'inbox', source: 'Teams', id: String(n), title: author, text, author,
  time: new Date(Date.UTC(2026, 10, 24, 10, n)).toISOString(), read: false, added: 0,
});

test('the prompt lists open requests and new messages with short refs, oldest first', () => {
  const open = [{id: 'r1', title: 'Fix the Acme sync', summary: '64 users did not sync', people: ['Dana'], items: ['teams:inbox:1'], priority: 'high', kind: 'task', status: 'open', created: 0, updated: 0}] as any;
  const fresh = [item(2, 'logs are in s3'), item(3, 'thanks!', 'Pat')];
  const prompt = buildPrompt(open, fresh, new Map([[ 'teams:inbox:1', item(1, 'acme sync failed') ]]) as any);
  assert.match(prompt, /\[R1\] Fix the Acme sync \| 64 users did not sync \| from Dana \| latest: Dana: acme sync failed/);
  assert(prompt.indexOf('[m1]') < prompt.indexOf('[m2]'));
  assert.match(prompt, /\[m2\] 2026-11-24 10:03 UTC \| Teams .* from Pat\nthanks!/);
});

test('model answers become requests: follow-ups join open ones, non-requests and skipped messages are set aside', () => {
  const open = [{id: 'r1', title: 'Fix the Acme sync', summary: '', people: ['Dana'], items: ['teams:inbox:1'], priority: 'normal', kind: 'task', status: 'open', created: 0, updated: 0}];
  const store = {requests: [...open], triaged: [] as string[], ignored: [] as string[]};
  const fresh = [item(2, 'logs are in s3'), item(3, 'thanks!', 'Pat'), item(4, 'can you approve PR 12?', 'Sam'), item(5, 'lunch?', 'Lee')];
  applyResult(store as any, {
    requests: [
      {request: 'R1', title: 'Find why the Acme sync failed', summary: 'Logs in S3.', people: ['Dana'], priority: 'high', kind: 'task', items: ['m1', 'm9']},
      {request: 'new', title: 'Approve PR 12', summary: 'Sam needs a review.', people: ['Sam'], priority: 'normal', kind: 'review', items: ['m3', 'm1']},
      {request: 'new', title: 'Empty', summary: '', people: [], priority: 'low', kind: 'task', items: []},
    ],
    ignore: ['m2'],
  }, open as any, fresh as any, 1000);
  assert.equal(store.requests.length, 2, 'a new request with no messages is dropped');
  const [sync, pr] = store.requests;
  assert.deepEqual(sync.items, ['teams:inbox:1', 'teams:inbox:2']);
  assert.equal(sync.title, 'Find why the Acme sync failed');
  assert.equal(sync.priority, 'high');
  assert.deepEqual(pr.items, ['teams:inbox:4'], 'a message is used once, unknown refs are ignored');
  assert.equal(pr.kind, 'review');
  assert.deepEqual(store.ignored.sort(), ['teams:inbox:3', 'teams:inbox:5'], 'thanks and the skipped message are set aside');
  assert.equal(store.triaged.length, 4);
});
