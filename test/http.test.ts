import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer, request, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import os from 'node:os';
import WebSocket, {WebSocketServer} from 'ws';

// The data folder sits inside a hidden folder, like the default ~/.local/share/muster.
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'muster-http-'));
const dir = path.join(tempRoot, '.local', 'share', 'muster');
const piAgentDir = path.join(tempRoot, 'pi-agent');
mkdirSync(dir, {recursive: true, mode: 0o700});
const port = 47957;
const base = `http://127.0.0.1:${port}`;
const fakePi = path.resolve(import.meta.dirname, 'fake-pi.mjs');
let child: ReturnType<typeof spawn>;
let fakeCdp: Server;
let cookie = '';

const password = () => readFileSync(path.join(dir, 'initial-password.txt'), 'utf8').trim();

function post(route: string, body: any = {}, extra: Record<string, string> = {}) {
  return fetch(base + route, {
    method: 'POST',
    headers: {origin: base, 'content-type': 'application/json', ...(cookie ? {cookie} : {}), ...extra},
    body: JSON.stringify(body),
  });
}

/** Raw request so the path and Host header are sent exactly as written. */
function raw(method: string, route: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{status: number; headers: Record<string, any>; body: string}>((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, method, path: route, headers}, res => {
      let text = '';
      res.on('data', chunk => (text += chunk));
      res.on('end', () => resolve({status: res.statusCode!, headers: res.headers, body: text}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Minimal stand-in for BrowserOS's DevTools endpoint: no tabs, every command succeeds. */
async function startFakeCdp() {
  const server = createServer((_req, res) => {
    const address = server.address() as AddressInfo;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/fake`}));
  });
  const sockets = new WebSocketServer({server});
  sockets.on('connection', ws => {
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      const result = message.method === 'Target.getTargets' ? {targetInfos: []} : {};
      ws.send(JSON.stringify({id: message.id, result}));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

before(async () => {
  fakeCdp = await startFakeCdp();
  chmodSync(fakePi, 0o755);
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      MUSTER_DATA_DIR: dir,
      MUSTER_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      MUSTER_WORKSPACE_ROOTS: dir,
      MUSTER_TRUST_CF_CONNECTING_IP: '1',
      BROWSEROS_CDP_URL: `http://127.0.0.1:${(fakeCdp.address() as AddressInfo).port}`,
      PI_BIN: fakePi,
      // Pi settings live in the temp folder, so the compaction test never touches the real ones.
      PI_CODING_AGENT_DIR: piAgentDir,
      FAKE_PI_SCENARIO: 'ok',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/api/health')).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test server failed to start');
});

after(async () => {
  child?.kill('SIGTERM');
  if (child?.exitCode === null) await once(child, 'exit');
  fakeCdp?.close();
  rmSync(tempRoot, {recursive: true, force: true});
});

test('authentication, CSRF, Host and bounded parser gates', async () => {
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await fetch(base + '/viewer')).status, 401);
  assert.equal((await fetch(base + '/viewer.html')).status, 401);
  assert.equal((await raw('GET', '/api/health', {host: 'attacker.example'})).status, 403);
  assert.equal((await post('/api/login', {password: 'wrong'}, {origin: 'https://attacker.example'})).status, 403);
  const noOrigin = await fetch(base + '/api/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(noOrigin.status, 403);

  const login = await post('/api/login', {password: password()});
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);

  assert.equal((await post('/api/threads', {cwd: '/tmp'})).status, 400);
  const status = await fetch(base + '/api/status', {headers: {cookie}});
  assert.equal(status.status, 200);
  const csp = status.headers.get('content-security-policy')!;
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(status.headers.get('permissions-policy')!, /microphone=\(\)/);
  const chatPage = await fetch(base + '/');
  assert.match(chatPage.headers.get('permissions-policy')!, /microphone=\(self\)/);
  const viewerPage = await fetch(base + '/viewer', {headers: {cookie}});
  assert.match(viewerPage.headers.get('permissions-policy')!, /microphone=\(\)/);
  assert.equal((await post('/api/copilotkit', {method: 'info'})).status, 200);
  const external = await post('/api/copilotkit', {method: 'agent/run', body: {forwardedProps: {mcpServers: []}}});
  assert.equal(external.status, 400);
  assert.equal((await post('/api/threads', {padding: 'x'.repeat(600_000)})).status, 413);
});

test('encoded and case-varied viewer paths cannot skip the sign-in check', async () => {
  const host = {host: `127.0.0.1:${port}`};
  for (const route of ['/%76iewer.html', '/%76iewer', '/viewer%2ehtml', '/assets/..%2fviewer.html', '/assets/%2e%2e/viewer.html']) {
    const response = await raw('GET', route, host);
    assert.notEqual(response.status, 200, route);
    assert(!response.body.includes('viewer.ts') && !response.body.includes('id="viewer"'), route);
  }
  assert.equal((await raw('GET', '/VIEWER.HTML', host)).status, 401);
  assert.equal((await raw('GET', '/', host)).status, 200);
});

test('a host added to the private allowed-hosts file works without a restart', async () => {
  const publicHost = 'quick-test.trycloudflare.com';
  assert.equal((await raw('GET', '/api/health', {host: publicHost})).status, 403);
  writeFileSync(path.join(dir, 'allowed-hosts'), publicHost + '\n', {mode: 0o600});
  const health = await raw('GET', '/api/health', {host: publicHost});
  assert.equal(health.status, 200);
  assert.match(health.headers['content-security-policy'], new RegExp(`wss://${publicHost}`));
  const origin = `https://${publicHost}`;
  const info = await raw('POST', '/api/copilotkit', {host: publicHost, origin, cookie, 'content-type': 'application/json'},
    JSON.stringify({method: 'info'}));
  assert.equal(info.status, 200);
  assert.equal(info.headers['access-control-allow-origin'], origin);
  const insecure = await raw('POST', '/api/copilotkit', {host: publicHost, origin: `http://${publicHost}`, cookie,
    'content-type': 'application/json'}, '{}');
  assert.equal(insecure.status, 403);
  rmSync(path.join(dir, 'allowed-hosts'));
  assert.equal((await raw('GET', '/api/health', {host: publicHost})).status, 403);
});

test('login throttling is per Cloudflare client, so other clients can still sign in', async () => {
  const attacker = {'cf-connecting-ip': '203.0.113.9'};
  for (let i = 0; i < 8; i++) assert.equal((await post('/api/login', {password: 'wrong'}, attacker)).status, 401);
  assert.equal((await post('/api/login', {password: password()}, attacker)).status, 429);
  assert.equal((await post('/api/login', {password: password()}, {'cf-connecting-ip': '198.51.100.7'})).status, 200);
});

test('the browser tool endpoint is not served on the public port', async () => {
  const response = await post('/internal/browser', {action: 'tabs'}, {authorization: 'Bearer anything'});
  assert.equal(response.status, 404);
});

test('the internal listener accepts only direct loopback requests addressed to itself', async () => {
  const listing = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN'], {encoding: 'utf8'});
  const ports = [...listing.matchAll(/127\.0\.0\.1:(\d+) \(LISTEN\)/g)].map(match => Number(match[1])).filter(p => p !== port);
  assert.equal(ports.length, 1, listing);
  const internalPort = ports[0];
  const call = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = request({host: '127.0.0.1', port: internalPort, method: 'POST', path: '/internal/browser',
        headers: {'content-type': 'application/json', authorization: 'Bearer not-a-job-token', ...headers}}, res => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end('{"action":"tabs"}');
    });
  const own = `127.0.0.1:${internalPort}`;
  assert.equal(await call({host: own}), 401, 'reaches the token check');
  assert.equal(await call({host: 'quick-test.trycloudflare.com'}), 403);
  assert.equal(await call({host: `localhost:${internalPort}`}), 403);
  assert.equal(await call({host: own, 'cf-connecting-ip': '203.0.113.9'}), 403);
  assert.equal(await call({host: own, 'x-forwarded-for': '203.0.113.9'}), 403);
});

test('search accepts queries that look like options, and a dead indexer is reported', async () => {
  const search = await fetch(base + '/api/search?q=' + encodeURIComponent('-h'), {headers: {cookie}});
  assert.equal(search.status, 200);
  assert(Array.isArray((await search.json()).results));
  writeFileSync(path.join(dir, 'index-status.json'), JSON.stringify({running: true, pid: 999_999, phase: 'reading'}));
  const status = await fetch(base + '/api/status', {headers: {cookie}}).then(r => r.json());
  assert.equal(status.index.running, false);
  assert.equal(status.index.phase, 'interrupted');
});

test('an open event stream sees runs started after it connected', async () => {
  const thread = await post('/api/threads', {cwd: dir, automatic: false}).then(r => r.json());
  const controller = new AbortController();
  const stream = await fetch(base + `/api/threads/${thread.id}/events`, {headers: {cookie}, signal: controller.signal});
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const readUntil = async (text: string) => {
    const deadline = Date.now() + 10_000;
    while (!received.includes(text)) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for ' + text);
      const {value, done} = await reader.read();
      if (done) throw new Error('Stream ended');
      received += decoder.decode(value);
    }
  };
  await readUntil('"type":"snapshot"');
  for (const prompt of ['first run', 'second run']) {
    received = '';
    assert.equal((await post(`/api/threads/${thread.id}/run`, {prompt})).status, 200);
    await readUntil('RUN_STARTED');
    await readUntil('fixture result');
    await readUntil('RUN_FINISHED');
  }
  controller.abort();
  const saved = await fetch(base + `/api/threads/${thread.id}`, {headers: {cookie}}).then(r => r.json());
  assert.equal(saved.run.status, 'completed');
  assert.equal(saved.events, undefined, 'status poll omits event history');
});

test('WebSocket needs auth and origin, and logout closes a live viewer without handback', async () => {
  await new Promise<void>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/browser/stream`, {headers: {origin: base}});
    ws.on('unexpected-response', (_req, res) => {
      assert.equal(res.statusCode, 403);
      resolve();
    });
    ws.on('error', () => {});
  });
  assert.equal((await post('/api/browser/takeover')).status, 200);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/browser/stream`, {headers: {origin: base, cookie}});
  const firstMessage = once(ws, 'message');
  await once(ws, 'open');
  assert.equal(JSON.parse(String((await firstMessage)[0])).type, 'tabs');
  const closed = once(ws, 'close');
  assert.equal((await post('/api/logout')).status, 200);
  await closed;
  assert.equal((await fetch(base + '/api/status', {headers: {cookie}})).status, 401);

  const login = await post('/api/login', {password: password()});
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const status = await fetch(base + '/api/status', {headers: {cookie}}).then(r => r.json());
  assert.equal(status.takeover, true);
  assert.equal(status.browser, true);
  assert.equal((await post('/api/browser/release')).status, 200);
});

test('an image sent in a message can be loaded back, though the data folder is under a hidden folder', async () => {
  const thread = await (await post('/api/threads', {cwd: dir, automatic: false})).json();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const queued = await (await post(`/api/threads/${thread.id}/queue`, {text: 'see this', images: [{type: 'image', source: {type: 'data', value: png, mimeType: 'image/png'}}]})).json();
  const link = queued.parts.find((part: any) => part.type === 'image').source.value;
  const image = await fetch(base + link, {headers: {cookie}});
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'), png);
  assert.equal((await fetch(base + link)).status, 401, 'needs sign-in');
  assert.match(image.headers.get('cache-control')!, /max-age=86400/);
  // The suffix the page adds to skip browser-cached errors is ignored by the server.
  assert.equal((await fetch(base + link + '?v=2', {headers: {cookie}})).status, 200);
  // An error must never be cached by the browser.
  const missing = await fetch(base + '/api/uploads/00000000-0000-0000-0000-000000000000.png', {headers: {cookie}});
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.headers.get('cache-control') ?? '', /max-age/);
  await post(`/api/threads/${thread.id}/queue/${queued.id}/remove`);
});

test('the terminal is off until turned on, needs sign-in and the right origin, and runs a real shell', async () => {
  const socketUrl = (id: string) => `ws://127.0.0.1:${port}/api/terminal/stream?id=${id}`;
  const opened = (ws: WebSocket) =>
    new Promise<number>(resolve => {
      ws.once('open', () => resolve(101));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => resolve(0));
    });
  const state = await (await fetch(base + '/api/terminal', {headers: {cookie}})).json();
  assert.equal(state.enabled, false);
  const refused = await post('/api/terminal/sessions', {});
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /Turn on the terminal/);

  assert.equal((await post('/api/terminal/settings', {enabled: true})).status, 200);
  assert.equal((await post('/api/terminal/sessions', {cwd: '/'})).status, 400, 'only inside workspace roots');
  const {id} = await (await post('/api/terminal/sessions', {cwd: dir})).json();

  // No sign-in, or another site's origin: refused before the upgrade.
  assert.equal(await opened(new WebSocket(socketUrl(id), {headers: {origin: base}})), 403);
  assert.equal(await opened(new WebSocket(socketUrl(id), {headers: {origin: 'https://attacker.example', cookie}})), 403);

  const ws = new WebSocket(socketUrl(id), {headers: {origin: base, cookie}});
  assert.equal(await opened(ws), 101);
  let output = '';
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'output' || message.type === 'ready') output += message.data ?? message.replay ?? '';
  });
  ws.send(JSON.stringify({type: 'resize', cols: 101, rows: 33}));
  ws.send(JSON.stringify({type: 'input', data: 'echo "typed-secret-$((6*7))"; stty size; pwd\r'}));
  const deadline = Date.now() + 15_000;
  while (!(output.includes('typed-secret-42') && output.includes('33 101')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert.match(output, /typed-secret-42/);
  assert.match(output, /33 101/);
  assert(output.includes(path.basename(dir)), 'starts in the chosen folder');

  // Closing the terminal ends the shell and its connection; turning the terminal off closes the rest.
  const closedSocket = new Promise(resolve => ws.once('close', resolve));
  await post(`/api/terminal/sessions/${id}/close`);
  await closedSocket;
  const second = await (await post('/api/terminal/sessions', {cwd: dir})).json();
  await post('/api/terminal/settings', {enabled: false});
  const after = await (await fetch(base + '/api/terminal', {headers: {cookie}})).json();
  assert.equal(after.enabled, false);
  assert(!after.sessions.some((s: any) => s.id === second.id));
  assert.equal(await opened(new WebSocket(socketUrl(second.id), {headers: {origin: base, cookie}})), 403);
  const log = readFileSync(path.join(dir, 'logs', 'terminal.jsonl'), 'utf8');
  assert.match(log, /"event":"started"/);
  assert(!log.includes('typed-secret'), 'what is typed is not logged');
});

test('the auto-compact point is saved per model in Pi settings, keeping the rest of the file', async () => {
  mkdirSync(piAgentDir, {recursive: true});
  const settingsFile = path.join(piAgentDir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({defaultModel: 'claude-opus-5-5', compaction: {keepRecentTokens: 30000}}));
  const headers = {origin: base, 'content-type': 'application/json', cookie};
  const model = 'claude-bridge/claude-opus-5-5';
  const read = async () => (await fetch(`${base}/api/compaction?model=${encodeURIComponent(model)}`, {headers})).json();
  assert.deepEqual(await read(), {reserveTokens: 16384, source: 'default', enabled: true, defaultReserve: 16384});

  const save = (body: unknown) => fetch(base + '/api/compaction', {method: 'POST', headers, body: JSON.stringify(body)});
  const saved = await save({model, contextWindow: 1_000_000, threshold: 500_000});
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).source, 'model');
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), {
    defaultModel: 'claude-opus-5-5',
    compaction: {keepRecentTokens: 30000, modelOverrides: {[model]: {reserveTokens: 500_000}}},
  });
  assert.equal((await read()).reserveTokens, 500_000);

  assert.equal((await save({model: 'nope/model', contextWindow: 1_000_000, threshold: 500_000})).status, 400);
  assert.equal((await save({model, contextWindow: 1_000_000, threshold: 2_000_000})).status, 400);
  assert.equal((await fetch(base + '/api/compaction', {method: 'POST', headers: {...headers, cookie: ''}, body: '{}'})).status, 401);

  assert.equal((await save({model, contextWindow: 1_000_000, threshold: null})).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), {defaultModel: 'claude-opus-5-5', compaction: {keepRecentTokens: 30000}});
});

test('session PR endpoints require sign-in, origin and membership in the session', async () => {
  const created = await (await post('/api/threads', {cwd: dir, automatic: false})).json();
  const route = `/api/threads/${created.id}/pull-requests`;
  assert.equal((await fetch(base + route)).status, 401);
  const view = await (await fetch(base + route, {headers: {cookie}})).json();
  assert.deepEqual(view, {configured: false, prs: []});
  assert.equal((await post(route + '/missing/review', {})).status, 404);
  assert.equal((await post(route + '/missing/preview', {})).status, 404);
  assert.equal((await post(route + '/missing/merge', {})).status, 404);
  assert.equal((await post(route + '/missing/merge', {}, {origin: 'https://attacker.example'})).status, 403);
});
