import {chmodSync, existsSync, readFileSync, readdirSync, statSync, appendFileSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type WebSocket from 'ws';
import {writePrivate} from './account.js';
import {DATA} from './security.js';

// A shell on the desktop, opened from the Actions panel. Off until the owner turns it on; only signed-in
// sessions that pass the same Host and Origin checks as the browser viewer can attach. Sessions outlive a
// dropped connection for a while, so a phone that sleeps can come back to the same shell.

const require = createRequire(import.meta.url);
const STATE_FILE = path.join(DATA, 'terminal.json');
const LOG_FILE = path.join(DATA, 'logs', 'terminal.jsonl');
const MAX_SESSIONS = 4;
const DETACHED_MS = 30 * 60_000;
const REPLAY_BYTES = 256 * 1024;
const MAX_INPUT = 64 * 1024;

type Pty = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: {exitCode: number; signal?: number}) => void): void;
};

export type TerminalSession = {
  id: string;
  cwd: string;
  created: number;
  lastSeen: number;
  replay: string;
  clients: Set<WebSocket>;
  pty: Pty;
  exited?: number;
};

/** node-pty's spawn helper can be installed without its execute bit (a 077 umask); restore it. */
function loadPty() {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const dir of [path.join(root, 'prebuilds'), path.join(root, 'build', 'Release')]) {
    if (!existsSync(dir)) continue;
    const helpers = dir.endsWith('Release') ? [path.join(dir, 'spawn-helper')] : readdirSync(dir).map(name => path.join(dir, name, 'spawn-helper'));
    for (const helper of helpers) {
      try {
        if (existsSync(helper) && !(statSync(helper).mode & 0o100)) chmodSync(helper, 0o755);
      } catch {
        // Spawning reports the problem if this mattered.
      }
    }
  }
  return require('node-pty') as {spawn(file: string, args: string[], options: object): Pty};
}

function log(event: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(LOG_FILE), {recursive: true, mode: 0o700});
    appendFileSync(LOG_FILE, JSON.stringify({at: Date.now(), ...event}) + '\n', {mode: 0o600});
  } catch {
    // Logging is best effort.
  }
}

export class Terminals {
  sessions = new Map<string, TerminalSession>();
  private pty?: ReturnType<typeof loadPty>;
  private owners = new Map<WebSocket, string>();

  constructor() {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Turned on by the owner in the app; MUSTER_TERMINAL_DISABLED=1 keeps it off whatever the setting. */
  enabled() {
    if (process.env.MUSTER_TERMINAL_DISABLED === '1') return false;
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled === true;
    } catch {
      return false;
    }
  }

  setEnabled(enabled: boolean, owner: string) {
    if (process.env.MUSTER_TERMINAL_DISABLED === '1') throw new Error('The terminal is disabled on this desktop (MUSTER_TERMINAL_DISABLED).');
    writePrivate(STATE_FILE, JSON.stringify({enabled}));
    log({event: enabled ? 'enabled' : 'disabled', owner: owner.slice(0, 12)});
    if (!enabled) for (const session of [...this.sessions.values()]) this.kill(session.id);
  }

  list() {
    return [...this.sessions.values()].map(session => ({
      id: session.id,
      cwd: session.cwd,
      created: session.created,
      attached: session.clients.size,
      exited: session.exited,
    }));
  }

  create(cwd: string, owner: string) {
    if (!this.enabled()) throw new Error('Turn on the terminal first.');
    const live = [...this.sessions.values()].filter(session => session.exited === undefined);
    if (live.length >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} terminals can be open. Close one first.`);
    this.pty ??= loadPty();
    const shell = process.env.SHELL || '/bin/zsh';
    // The owner's normal login shell, without Muster's own settings in its environment.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(MUSTER_|META_|COPILOTKIT_|BROWSEROS_CDP)/.test(key)),
    ) as Record<string, string>;
    const pty = this.pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: existsSync(cwd) ? cwd : os.homedir(),
      env: {...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', MUSTER_TERMINAL: '1'},
    });
    const session: TerminalSession = {id: randomUUID(), cwd, created: Date.now(), lastSeen: Date.now(), replay: '', clients: new Set(), pty};
    pty.onData(data => {
      session.replay = (session.replay + data).slice(-REPLAY_BYTES);
      for (const ws of session.clients) if (ws.readyState === 1) ws.send(JSON.stringify({type: 'output', data}));
    });
    pty.onExit(({exitCode}) => {
      session.exited = exitCode;
      for (const ws of session.clients) if (ws.readyState === 1) ws.send(JSON.stringify({type: 'exit', code: exitCode}));
      log({event: 'exited', id: session.id, code: exitCode});
      setTimeout(() => this.sessions.delete(session.id), 5 * 60_000).unref();
    });
    this.sessions.set(session.id, session);
    log({event: 'started', id: session.id, cwd, owner: owner.slice(0, 12), shell});
    return session;
  }

  kill(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.exited === undefined) {
      try {
        session.pty.kill('SIGHUP');
      } catch {
        // Already gone.
      }
    }
    for (const ws of session.clients) ws.close(1000, 'Terminal closed');
    this.sessions.delete(id);
    log({event: 'closed', id});
  }

  /** Connects a viewer socket to a session: replays recent output, then streams both ways. */
  attach(ws: WebSocket, id: string, owner: string, stillSignedIn: () => boolean) {
    const session = this.sessions.get(id);
    if (!session || !this.enabled()) {
      ws.close(1008, 'No such terminal');
      return;
    }
    session.clients.add(ws);
    session.lastSeen = Date.now();
    this.owners.set(ws, owner);
    log({event: 'attached', id, owner: owner.slice(0, 12)});
    ws.send(JSON.stringify({type: 'ready', id, replay: session.replay, exited: session.exited}));

    // Signing out or an expired sign-in ends the connection; the shell keeps running until it is closed.
    const check = setInterval(() => {
      if (!stillSignedIn() || !this.enabled()) ws.close(1008, 'Sign in again');
    }, 30_000);
    ws.on('message', raw => {
      session.lastSeen = Date.now();
      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (session.exited !== undefined) return;
      if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= MAX_INPUT) {
        session.pty.write(message.data);
      } else if (message.type === 'resize') {
        const cols = Math.trunc(Number(message.cols));
        const rows = Math.trunc(Number(message.rows));
        if (cols >= 10 && cols <= 500 && rows >= 4 && rows <= 300) session.pty.resize(cols, rows);
      } else if (message.type === 'ping') {
        ws.send(JSON.stringify({type: 'pong'}));
      }
    });
    ws.on('close', () => {
      clearInterval(check);
      session.clients.delete(ws);
      this.owners.delete(ws);
      session.lastSeen = Date.now();
    });
  }

  /** Closes the connections of a sign-in that was revoked. */
  revoke(owner: string) {
    for (const [ws, id] of this.owners) if (id === owner) ws.close(1008, 'Signed out');
  }

  /** Shells nobody has looked at for half an hour are closed. */
  private sweep() {
    for (const session of [...this.sessions.values()]) {
      if (!session.clients.size && Date.now() - session.lastSeen > DETACHED_MS) this.kill(session.id);
    }
  }
}

export const terminals = new Terminals();
