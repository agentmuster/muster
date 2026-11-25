// Live check of the remote viewer against BrowserOS. Opens and closes only its own local fixture tab.
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import WebSocket from 'ws';

const base = (process.env.MUSTER_URL || process.env.META_URL) || 'http://127.0.0.1:47831';
/** The same data folder the app uses: the old ~/.local/share/meta-agent only if the new one does not exist. */
function defaultDataDir() {
  const current = path.join(process.env.HOME, '.local/share/muster');
  const legacy = path.join(process.env.HOME, '.local/share/meta-agent');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}
const data = process.env.MUSTER_DATA_DIR || process.env.META_DATA_DIR || defaultDataDir();
const headers = {origin: base, 'content-type': 'application/json'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const password = fs.readFileSync(path.join(data, 'initial-password.txt'), 'utf8').trim();
const login = await fetch(base + '/api/login', {method: 'POST', headers, body: JSON.stringify({password})});
if (!login.ok) throw Error('Sign-in failed: ' + login.status);
const cookie = login.headers.get('set-cookie').split(';')[0];
headers.cookie = cookie;
const post = (route, body = {}) => fetch(base + route, {method: 'POST', headers, body: JSON.stringify(body)});
const status = () => fetch(base + '/api/status', {headers: {cookie}}).then(r => r.json());

if ((await status()).takeover) throw Error('Finish the existing human takeover before running this smoke test.');

const page = `<!doctype html><title>Muster smoke fixture</title>
<body style="font:20px sans-serif;padding:40px">
<h1>Browser bridge test</h1>
<input id="entry" style="font:inherit"><button id="submit" style="font:inherit">Apply</button>
<p id="result">Waiting</p>
<script>
document.getElementById('submit').onclick = () =>
  document.getElementById('result').textContent = document.getElementById('entry').value;
</script>`;
const fixture = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(page);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = 'http://127.0.0.1:' + fixture.address().port + '/';

// A separate DevTools connection, used only to locate elements and read back the result.
const info = await fetch((process.env.BROWSEROS_CDP_URL || 'http://127.0.0.1:9110') + '/json/version').then(r => r.json());
const devtools = new WebSocket(info.webSocketDebuggerUrl);
await new Promise(resolve => devtools.once('open', resolve));
let nextId = 0;
const pending = new Map();
devtools.on('message', raw => {
  const message = JSON.parse(raw);
  if (!message.id || !pending.has(message.id)) return;
  const [resolve, reject] = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, [resolve, reject]);
    devtools.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
  });

let target;
let sid;
let released = false;
try {
  console.log('takeover', (await post('/api/browser/takeover')).status);
  const viewer = new WebSocket(base.replace(/^http/, 'ws') + '/api/browser/stream', {headers: {origin: base, cookie}});
  await new Promise(resolve => viewer.once('open', resolve));
  let frames = 0;
  let firstFrame;
  const ready = new Promise(resolve => (firstFrame = resolve));
  viewer.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'frame') {
      frames++;
      target = message.target;
      if (frames === 1) firstFrame();
    }
    if (message.type === 'error') console.log('viewer error', message.message);
  });
  viewer.send(JSON.stringify({type: 'open', url: fixtureUrl}));
  await Promise.race([ready, sleep(15_000).then(() => Promise.reject(Error('No frame in 15s')))]);

  sid = (await cdp('Target.attachToTarget', {targetId: target, flatten: true})).sessionId;
  const geometry = await cdp(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify(Object.fromEntries(['entry', 'submit'].map(id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return [id, {x: r.x + r.width / 2, y: r.y + r.height / 2}];
      })))`,
      returnByValue: true,
    },
    sid,
  );
  const positions = JSON.parse(geometry.result.value);
  const click = point => {
    for (const event of ['mousePressed', 'mouseReleased']) viewer.send(JSON.stringify({type: 'pointer', event, button: 'left', ...point}));
  };
  click(positions.entry);
  // Select-all replaces this text only if the editing shortcut reaches the page.
  viewer.send(JSON.stringify({type: 'text', text: 'junk'}));
  viewer.send(JSON.stringify({type: 'shortcut', action: 'selectAll', event: 'keyDown'}));
  viewer.send(JSON.stringify({type: 'shortcut', action: 'selectAll', event: 'keyUp'}));
  viewer.send(JSON.stringify({type: 'text', text: 'REMOTE_IFRAME_XX'}));
  viewer.send(JSON.stringify({type: 'key', key: 'Backspace', event: 'keyDown'}));
  viewer.send(JSON.stringify({type: 'key', key: 'Backspace', event: 'keyUp'}));
  viewer.send(JSON.stringify({type: 'key', key: 'Backspace', event: 'keyDown', shift: true}));
  viewer.send(JSON.stringify({type: 'key', key: 'Backspace', event: 'keyUp', shift: true}));
  viewer.send(JSON.stringify({type: 'text', text: 'OK'}));
  click(positions.submit);
  await sleep(800);
  const result = await cdp('Runtime.evaluate', {expression: 'document.getElementById("result").textContent', returnByValue: true}, sid);
  if (result.result.value !== 'REMOTE_IFRAME_OK') throw Error('Remote input did not reach the fixture: ' + result.result.value);
  console.log('stream frames', frames, 'input proof', true);

  viewer.close();
  await sleep(300);
  console.log('still paused after disconnect', (await status()).takeover);
  console.log('handback', (await post('/api/browser/release')).status);
  released = true;
} finally {
  if (!released) await post('/api/browser/release');
  if (sid) await cdp('Target.detachFromTarget', {sessionId: sid}).catch(() => {});
  if (target) await cdp('Target.closeTarget', {targetId: target}).catch(() => {});
  devtools.close();
  fixture.close();
  await post('/api/logout');
  console.log('own fixture tab closed; other tabs unchanged');
}
