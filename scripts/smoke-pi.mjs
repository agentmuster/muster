// Live check: CopilotKit → installed Pi → streamed reply → saved managed thread. Makes one small model request.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const base = (process.env.MUSTER_URL || process.env.META_URL) || 'http://127.0.0.1:47831';
/** The same data folder the app uses: the old ~/.local/share/meta-agent only if the new one does not exist. */
function defaultDataDir() {
  const current = path.join(process.env.HOME, '.local/share/muster');
  const legacy = path.join(process.env.HOME, '.local/share/meta-agent');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}
const data = process.env.MUSTER_DATA_DIR || process.env.META_DATA_DIR || defaultDataDir();
const headers = {origin: base, 'content-type': 'application/json'};

const password = fs.readFileSync(path.join(data, 'initial-password.txt'), 'utf8').trim();
const login = await fetch(base + '/api/login', {method: 'POST', headers, body: JSON.stringify({password})});
if (!login.ok) throw Error('Sign-in failed: ' + login.status);
headers.cookie = login.headers.get('set-cookie').split(';')[0];

const status = await fetch(base + '/api/status', {headers}).then(r => r.json());
if (status.takeover) throw Error('Human takeover is active. Finish it before running this smoke test.');

const thread = await fetch(base + '/api/threads', {
  method: 'POST',
  headers,
  body: JSON.stringify({cwd: status.defaultCwd, automatic: false, sources: []}),
}).then(r => r.json());

const run = {
  method: 'agent/run',
  params: {agentId: 'pi'},
  body: {
    threadId: thread.id,
    runId: randomUUID(),
    messages: [{id: randomUUID(), role: 'user', content: 'Reply with exactly META_AGENT_READY. Do not use any tools.'}],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  },
};
const response = await fetch(base + '/api/copilotkit', {
  method: 'POST',
  headers,
  body: JSON.stringify(run),
  signal: AbortSignal.timeout(90_000),
});
const stream = await response.text();
if (!response.ok || !stream.includes('RUN_FINISHED') || !stream.includes('META')) {
  throw Error('Pi round trip failed: ' + stream.slice(-1200));
}

const saved = await fetch(base + '/api/threads/' + thread.id, {headers}).then(r => r.json());
if (saved.run.status !== 'completed' || saved.messages.at(-1).content.trim() !== 'META_AGENT_READY') {
  throw Error('Saved result did not match');
}
console.log('CopilotKit → installed Pi → streamed response → saved managed thread: passed');
console.log('Managed smoke thread:', thread.id);
await fetch(base + '/api/logout', {method: 'POST', headers, body: '{}'});
