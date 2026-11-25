// Finds the local Muster, signs in with the desktop key from its data folder, and reads what needs the owner.
// No Electron here, so it can be tested with plain Node.
import {existsSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ACTIVE = ['running', 'preparing', 'paused'];

/** KEY=value lines of an .env file; a missing file is empty. */
export function readEnvFile(file) {
  const values = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return values;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const expand = (value, home) => (value.startsWith('~/') ? path.join(home, value.slice(2)) : value);

/**
 * Where Muster is: ~/.config/muster/desktop.json ({url, port, dataDir, serviceLabel}) wins, then the installer's
 * ~/.muster/.env, then the defaults. The data folder is chosen the way the server chooses it.
 */
export function locate(home = os.homedir()) {
  const config = readJson(path.join(home, '.config/muster/desktop.json'));
  const env = readEnvFile(path.join(config.installDir ? expand(config.installDir, home) : path.join(home, '.muster'), '.env'));
  const port = config.port ?? env.PORT ?? '47831';
  const url = (config.url ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  let dataDir = config.dataDir ?? env.MUSTER_DATA_DIR ?? env.META_DATA_DIR;
  if (dataDir) dataDir = expand(dataDir, home);
  else {
    const current = path.join(home, '.local/share/muster');
    const legacy = path.join(home, '.local/share/meta-agent');
    dataDir = !existsSync(current) && existsSync(legacy) ? legacy : current;
  }
  const serviceLabel = config.serviceLabel ?? 'io.agentmuster.muster';
  return {url, dataDir, serviceLabel, plist: path.join(home, 'Library/LaunchAgents', serviceLabel + '.plist')};
}

export class MusterClient {
  constructor(where, fetchImpl = fetch) {
    this.where = where;
    this.fetch = fetchImpl;
    /** The session token; the window gets the same one as its cookie. */
    this.token = undefined;
    this.onToken = () => {};
  }

  async health() {
    try {
      const response = await this.fetch(this.where.url + '/api/health', {signal: AbortSignal.timeout(3000)});
      return response.ok;
    } catch {
      return false;
    }
  }

  async signIn() {
    const keyFile = path.join(this.where.dataDir, 'desktop-key');
    if (!existsSync(keyFile)) throw Object.assign(new Error(`No desktop key in ${this.where.dataDir}. Update Muster, then try again.`), {code: 'NO_KEY'});
    const key = readFileSync(keyFile, 'utf8').trim();
    const response = await this.fetch(this.where.url + '/api/desktop/session', {
      method: 'POST',
      headers: {origin: this.where.url, authorization: 'Bearer ' + key, 'content-type': 'application/json'},
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) throw Object.assign(new Error('This Muster is too old for the desktop app. Update it, then try again.'), {code: 'OLD'});
    if (!response.ok) throw Object.assign(new Error((await response.json().catch(() => ({}))).error || `Sign-in failed (${response.status})`), {code: 'SIGN_IN'});
    const {token} = await response.json();
    this.token = token;
    this.onToken(token);
    return token;
  }

  /** GET an API route as the owner, signing in again once if the sign-in has ended. */
  async get(route) {
    if (!this.token) await this.signIn();
    let response = await this.request(route);
    if (response.status === 401) {
      await this.signIn();
      response = await this.request(route);
    }
    if (!response.ok) throw new Error(`${route}: ${response.status}`);
    return response.json();
  }

  request(route) {
    return this.fetch(this.where.url + '/api' + route, {headers: {cookie: 'meta_session=' + this.token}, signal: AbortSignal.timeout(5000)});
  }
}

/** Threads that started needing the owner since the last look. The first look only records what is waiting. */
export function newlyWaiting(previous, threads) {
  const next = new Map();
  for (const thread of threads) if (thread.attention) next.set(thread.id, thread.attention.at);
  const fresh = previous ? threads.filter(thread => thread.attention && previous.get(thread.id) !== thread.attention.at) : [];
  return {next, fresh};
}

/** Threads with a reply or background work running, which a restart would stop. */
export const running = threads => threads.filter(thread => ACTIVE.includes(thread.run?.status) || thread.background?.active > 0);
