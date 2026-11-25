import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain JavaScript shared with the Electron app.
import {locate, MusterClient, newlyWaiting, readEnvFile, running} from '../desktop/muster.mjs';

const home = mkdtempSync(path.join(os.tmpdir(), 'muster-desktop-'));
after(() => rmSync(home, {recursive: true, force: true}));

test('the desktop app finds Muster from its config, the installer .env, or the defaults', () => {
  const legacy = path.join(home, '.local/share/meta-agent');
  mkdirSync(legacy, {recursive: true});
  assert.deepEqual(locate(home), {
    url: 'http://127.0.0.1:47831',
    dataDir: legacy,
    serviceLabel: 'io.agentmuster.muster',
    plist: path.join(home, 'Library/LaunchAgents/io.agentmuster.muster.plist'),
  });

  mkdirSync(path.join(home, '.muster'));
  writeFileSync(path.join(home, '.muster/.env'), 'PORT=47900\n# note\nMUSTER_DATA_DIR="~/muster-data"\n');
  assert.deepEqual(readEnvFile(path.join(home, '.muster/.env')), {PORT: '47900', MUSTER_DATA_DIR: '~/muster-data'});
  const installed = locate(home);
  assert.equal(installed.url, 'http://127.0.0.1:47900');
  assert.equal(installed.dataDir, path.join(home, 'muster-data'));

  mkdirSync(path.join(home, '.config/muster'), {recursive: true});
  writeFileSync(path.join(home, '.config/muster/desktop.json'), JSON.stringify({url: 'http://127.0.0.1:47831/', serviceLabel: 'com.example.muster'}));
  const configured = locate(home);
  assert.equal(configured.url, 'http://127.0.0.1:47831');
  assert.equal(configured.serviceLabel, 'com.example.muster');
  assert.equal(configured.dataDir, path.join(home, 'muster-data'));
});

test('the client signs in with the desktop key and again when its sign-in ends', async () => {
  const dataDir = path.join(home, 'data');
  mkdirSync(dataDir);
  const calls: {url: string; init: any}[] = [];
  let valid = 'first';
  let issued = 0;
  const fakeFetch = async (url: string, init: any = {}) => {
    calls.push({url, init});
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status});
    if (url.endsWith('/api/desktop/session')) {
      if (init.headers.authorization !== 'Bearer the-key' || init.headers.origin !== 'http://127.0.0.1:1') return json(401, {error: 'Incorrect desktop key'});
      valid = ['first', 'second'][issued++];
      return json(200, {cookie: 'meta_session', token: valid});
    }
    if (init.headers?.cookie !== 'meta_session=' + valid) return json(401, {error: 'Sign in required'});
    return json(200, [{id: 't1'}]);
  };
  const client = new MusterClient({url: 'http://127.0.0.1:1', dataDir}, fakeFetch);
  await assert.rejects(() => client.get('/threads'), /No desktop key/);

  writeFileSync(path.join(dataDir, 'desktop-key'), 'the-key\n');
  const tokens: string[] = [];
  client.onToken = (token: string) => tokens.push(token);
  assert.deepEqual(await client.get('/threads'), [{id: 't1'}]);
  valid = 'expired-on-server';
  assert.deepEqual(await client.get('/threads'), [{id: 't1'}]);
  assert.deepEqual(tokens, ['first', 'second'], 'each new sign-in is handed to the window');
});

test('only threads that newly need the owner raise a notification', () => {
  const waiting = (id: string, at: number) => ({id, attention: {kind: 'reply', label: 'Reply ready', at}});
  const first = newlyWaiting(null, [waiting('a', 1), {id: 'b'}]);
  assert.deepEqual(first.fresh, [], 'what is already waiting at start is not announced');
  const second = newlyWaiting(first.next, [waiting('a', 1), waiting('b', 5)]);
  assert.deepEqual(second.fresh.map((t: any) => t.id), ['b']);
  const third = newlyWaiting(second.next, [waiting('a', 9), waiting('b', 5)]);
  assert.deepEqual(third.fresh.map((t: any) => t.id), ['a'], 'a thread waiting again after a new reply is announced again');
  assert.deepEqual(
    running([{id: 'x', run: {status: 'running'}}, {id: 'y', run: {status: 'completed'}}, {id: 'z', background: {active: 2}}]).map((t: any) => t.id),
    ['x', 'z'],
  );
});
