import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const dir = mkdtempSync(path.join(os.tmpdir(), 'muster-sessions-'));
process.env.MUSTER_DATA_DIR = path.join(dir, 'data');
process.env.MUSTER_WORKSPACE_ROOTS = dir;
const fakePi = path.resolve(import.meta.dirname, 'fake-pi.mjs');
chmodSync(fakePi, 0o755);
process.env.PI_BIN = fakePi;
mkdirSync(process.env.MUSTER_DATA_DIR, {recursive: true});

const {Jobs} = await import('../server/jobs.js');
const {takeover} = await import('../server/browser.js');
const {piTranscript, foreignTranscript} = await import('../server/transcripts.js');
takeover.paused = false;
after(() => rmSync(dir, {recursive: true, force: true}));

const noContext = {search: async () => ({results: [], warnings: []}), context: async () => []};
const jsonl = (records: unknown[]) => records.map(r => JSON.stringify(r)).join('\n') + '\n';

// A Pi session with an abandoned branch: b2 is not on the active path ending at a4.
const piFile = path.join(dir, 'pi-session.jsonl');
writeFileSync(piFile, jsonl([
  {type: 'session', version: 3, id: 'pi-1', cwd: dir},
  {type: 'message', id: 'a1', parentId: null, message: {role: 'user', content: 'Fix the login redirect'}},
  {type: 'message', id: 'b2', parentId: 'a1', message: {role: 'assistant', content: [{type: 'text', text: 'abandoned branch'}]}},
  {
    type: 'message', id: 'a2', parentId: 'a1',
    message: {role: 'assistant', content: [
      {type: 'thinking', thinking: 'Check the router'},
      {type: 'text', text: 'Looking at the router.'},
      {type: 'toolCall', id: 'call-1', name: 'read', arguments: {path: 'router.ts'}},
    ]},
  },
  {type: 'message', id: 'a3', parentId: 'a2', message: {role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{type: 'text', text: 'export const routes = []'}], isError: false}},
  {type: 'message', id: 'a4', parentId: 'a3', message: {role: 'assistant', content: [{type: 'text', text: 'The redirect drops the return URL.'}]}},
]));

const claudeFile = path.join(dir, 'claude-session.jsonl');
writeFileSync(claudeFile, jsonl([
  {type: 'user', uuid: 'u1', message: {role: 'user', content: '<environment_context>noise</environment_context>'}},
  {type: 'user', uuid: 'u2', message: {role: 'user', content: 'Deploy the billing fix'}},
  {type: 'assistant', uuid: 'u3', message: {role: 'assistant', content: [
    {type: 'text', text: 'Running the deploy.'},
    {type: 'tool_use', id: 'tu-1', name: 'Bash', input: {command: 'npm run deploy'}},
  ]}},
  {type: 'user', uuid: 'u4', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tu-1', content: 'deployed v42'}]}},
  {type: 'assistant', uuid: 'u5', isSidechain: true, message: {role: 'assistant', content: [{type: 'text', text: 'subagent noise'}]}},
  {type: 'assistant', uuid: 'u6', message: {role: 'assistant', content: [{type: 'text', text: 'Billing fix is live as v42.'}]}},
]));

// Registers both files in the test index, as the indexer would.
execFileSync('python3', [path.resolve(import.meta.dirname, '../engine/indexer.py'), 'recent'], {input: '{}'});
execFileSync('python3', ['-c', `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("INSERT INTO sessions VALUES('aaaaaaaaaaaaaaaaaaaaaaaa','pi-1','pi',?,?,'Login redirect',1,1,0,4,'')", (sys.argv[2], sys.argv[4]))
db.execute("INSERT INTO sessions VALUES('bbbbbbbbbbbbbbbbbbbbbbbb','c-1','claude',?,?,'Billing deploy',1,1,0,4,'')", (sys.argv[3], sys.argv[4]))
db.commit()
`, path.join(process.env.MUSTER_DATA_DIR, 'index.sqlite'), piFile, claudeFile, dir]);

test('Pi transcripts follow the active branch and keep thinking, tool calls and results', async () => {
  const messages = await piTranscript(piFile);
  assert.deepEqual(messages.map(m => m.role), ['user', 'reasoning', 'assistant', 'tool', 'assistant']);
  assert(!messages.some(m => m.content.includes('abandoned')));
  assert.equal(messages[2].toolCalls![0].function.name, 'read');
  assert.equal(messages[3].toolCallId, 'call-1');
});

test('Claude transcripts skip injected context and sidechains', async () => {
  const messages = await foreignTranscript('claude', claudeFile);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[0].content, 'Deploy the billing fix');
  assert(!messages.some(m => m.content.includes('subagent noise')));
});

test('continue resumes the original Pi file and blocks a second continue', async () => {
  const argsFile = path.join(dir, 'continue-args.json');
  process.env.FAKE_PI_ARGS_FILE = argsFile;
  process.env.FAKE_PI_SCENARIO = 'ok';
  const jobs = new Jobs(noContext);
  const thread = await jobs.createFromSession('aaaaaaaaaaaaaaaaaaaaaaaa', 'continue', dir);
  assert.equal(thread.messages.length, 5);
  assert.equal(thread.piSession?.mode, 'continue');
  await assert.rejects(jobs.createFromSession('aaaaaaaaaaaaaaaaaaaaaaaa', 'continue', dir), /already open/);
  const live = await jobs.start(thread.id, 'carry on');
  await new Promise(resolve => live.bus.on('event', (e: any) => e.type === 'RUN_FINISHED' && resolve(null)));
  const args: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.equal(args[args.indexOf('--session') + 1], piFile);
  delete process.env.FAKE_PI_ARGS_FILE;
});

test('split forks a Pi session on the first run', async () => {
  const argsFile = path.join(dir, 'split-args.json');
  process.env.FAKE_PI_ARGS_FILE = argsFile;
  const jobs = new Jobs(noContext);
  const thread = await jobs.createFromSession('aaaaaaaaaaaaaaaaaaaaaaaa', 'split', dir);
  assert.equal(thread.piSession?.mode, 'fork');
  const live = await jobs.start(thread.id, 'try another approach');
  await new Promise(resolve => live.bus.on('event', (e: any) => e.type === 'RUN_FINISHED' && resolve(null)));
  const args: string[] = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.equal(args[args.indexOf('--fork') + 1], piFile);
  assert.equal(args[args.indexOf('--session-id') + 1], (thread.piSession as any).id);
  assert(!args.includes('--session'));
  delete process.env.FAKE_PI_ARGS_FILE;
});

test('Claude sessions cannot be continued in place; split carries the conversation as context', async () => {
  const jobs = new Jobs(noContext);
  await assert.rejects(jobs.createFromSession('bbbbbbbbbbbbbbbbbbbbbbbb', 'continue', dir), /Only Pi sessions/);
  const thread = await jobs.createFromSession('bbbbbbbbbbbbbbbbbbbbbbbb', 'split', dir);
  assert.equal(thread.piSession, undefined);
  assert.equal(thread.contextPrepared, true);
  assert(thread.context.some((c: any) => c.text.includes('Billing fix is live')));
  assert.equal(thread.messages.at(-1).content, 'Billing fix is live as v42.');
});

test('new starts fresh and retrieves from the chosen session on the first message', async () => {
  const jobs = new Jobs(noContext);
  const thread = await jobs.createFromSession('bbbbbbbbbbbbbbbbbbbbbbbb', 'new', dir);
  assert.deepEqual(thread.sources, ['bbbbbbbbbbbbbbbbbbbbbbbb']);
  assert.equal(thread.messages.length, 0);
  assert(!thread.contextPrepared);
});
