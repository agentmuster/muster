import WebSocket from 'ws';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {DATA, savePrivate} from './security.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const COMMAND_TIMEOUT_MS = 8000;
const HANDSHAKE_TIMEOUT_MS = 5000;

type Pending = {resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout};

/** One shared connection to BrowserOS's loopback Chrome DevTools Protocol endpoint. */
export class CDP {
  socket?: WebSocket;
  id = 0;
  pending = new Map<number, Pending>();
  listeners = new Set<(message: any) => void>();
  connecting?: Promise<void>;

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open() {
    const endpoint = new URL(process.env.BROWSEROS_CDP_URL || 'http://127.0.0.1:9110');
    if (!LOOPBACK.includes(endpoint.hostname)) throw new Error('BrowserOS CDP must be loopback');
    const info = (await fetch(new URL('/json/version', endpoint), {signal: AbortSignal.timeout(4000)}).then(r =>
      r.json(),
    )) as any;
    const socketUrl = new URL(info.webSocketDebuggerUrl);
    if (!LOOPBACK.includes(socketUrl.hostname)) throw new Error('Non-local BrowserOS debugger refused');

    const ws = new WebSocket(socketUrl, {handshakeTimeout: HANDSHAKE_TIMEOUT_MS, perMessageDeflate: false});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('BrowserOS did not accept the debugger connection in time'));
      }, HANDSHAKE_TIMEOUT_MS + 1000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.socket = ws;
    ws.on('error', () => {});
    ws.on('message', raw => this.receive(raw.toString()));
    ws.on('close', () => {
      if (this.socket === ws) this.socket = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('BrowserOS disconnected'));
      }
      this.pending.clear();
      for (const listener of this.listeners) listener({method: 'Disconnected'});
    });
  }

  private receive(raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  async send(method: string, params: any = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<any> {
    await this.connect();
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('BrowserOS command timed out'));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.socket!.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }

  async tabs() {
    const result = await this.send('Target.getTargets');
    return result.targetInfos
      .filter((target: any) => target.type === 'page' && /^https?:\/\//.test(target.url))
      .map((target: any) => ({id: target.targetId, title: target.title.slice(0, 180), url: target.url.slice(0, 1200)}));
  }

  async attach(targetId: string) {
    const tabs = await this.tabs();
    if (!tabs.some((tab: any) => tab.id === targetId)) throw new Error('Tab is no longer available');
    return (await this.send('Target.attachToTarget', {targetId, flatten: true})).sessionId as string;
  }

  async detach(sessionId: string) {
    await this.send('Target.detachFromTarget', {sessionId}).catch(() => {});
  }
}

export const cdp = new CDP();

// JavaScript dialogs

export type PageDialog = {type: string; message: string; defaultPrompt: string; url: string; opened: number};
const MAX_WATCHED_TABS = 30;
const WATCH_TIMEOUT_MS = 3000;

/**
 * alert(), confirm(), prompt() and "Leave site?" freeze a page: screenshots, clicks and the live view all hang
 * until someone answers. Chrome only lets a debugger answer a dialog if it was listening when the dialog
 * opened; otherwise it waits on the desktop window. So every tab the agent or the viewer touches keeps one
 * listening session, and answers go through it.
 */
export class Dialogs {
  /** targetId → listening session and the dialog it is showing, if any. */
  watched = new Map<string, {session: string; dialog?: PageDialog}>();
  /** Tabs that stopped answering before they were watched: usually a dialog only the desktop can see. */
  stuck = new Set<string>();
  listeners = new Set<(targetId: string, dialog?: PageDialog) => void>();
  private starting = new Map<string, Promise<void>>();

  constructor(private cdp: CDP) {
    cdp.listeners.add(message => this.receive(message));
  }

  private targetOf(session: string) {
    for (const [target, entry] of this.watched) if (entry.session === session) return target;
    return undefined;
  }

  private notify(target: string, dialog?: PageDialog) {
    for (const listener of this.listeners) listener(target, dialog);
  }

  private receive(message: any) {
    if (message.method === 'Disconnected') {
      for (const target of this.watched.keys()) this.notify(target);
      this.watched.clear();
      this.stuck.clear();
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      const target = this.targetOf(message.params?.sessionId);
      if (target) {
        this.watched.delete(target);
        this.notify(target);
      }
      return;
    }
    const target = message.sessionId ? this.targetOf(message.sessionId) : undefined;
    if (!target) return;
    if (message.method === 'Page.javascriptDialogOpening') {
      const p = message.params ?? {};
      const dialog = {
        type: String(p.type || 'alert'),
        message: String(p.message ?? '').slice(0, 2000),
        defaultPrompt: String(p.defaultPrompt ?? '').slice(0, 500),
        url: String(p.url ?? '').slice(0, 500),
        opened: Date.now(),
      };
      this.watched.get(target)!.dialog = dialog;
      this.notify(target, dialog);
    }
    if (message.method === 'Page.javascriptDialogClosed') {
      this.watched.get(target)!.dialog = undefined;
      this.stuck.delete(target);
      this.notify(target);
    }
  }

  /** Starts listening on a tab. Returns false when the tab is not answering (see stuck). */
  async watch(target: string) {
    if (this.watched.has(target)) return true;
    let starting = this.starting.get(target);
    if (!starting) {
      starting = this.start(target).finally(() => this.starting.delete(target));
      this.starting.set(target, starting);
    }
    await starting;
    return this.watched.has(target);
  }

  private async start(target: string) {
    if (this.watched.size >= MAX_WATCHED_TABS) await this.prune();
    const session = (await this.cdp.send('Target.attachToTarget', {targetId: target, flatten: true})).sessionId as string;
    try {
      await this.cdp.send('Page.enable', {}, session, WATCH_TIMEOUT_MS);
    } catch {
      // A page with a dialog nobody was listening for cannot even enable events.
      this.stuck.add(target);
      await this.cdp.detach(session);
      return;
    }
    this.stuck.delete(target);
    this.watched.set(target, {session});
  }

  /** Stops watching tabs that were closed. */
  private async prune() {
    const open = new Set((await this.cdp.tabs()).map((tab: any) => tab.id));
    for (const [target, entry] of this.watched) {
      if (!open.has(target)) {
        this.watched.delete(target);
        await this.cdp.detach(entry.session);
      }
    }
  }

  dialog(target: string) {
    return this.watched.get(target)?.dialog;
  }

  async answer(target: string, accept: boolean, text?: string) {
    const entry = this.watched.get(target);
    if (!entry?.dialog) throw new Error('That tab is not showing a dialog the app can answer.');
    const params: any = {accept};
    if (accept && entry.dialog.type === 'prompt') params.promptText = String(text ?? entry.dialog.defaultPrompt).slice(0, 2000);
    await this.cdp.send('Page.handleJavaScriptDialog', params, entry.session);
    entry.dialog = undefined;
    this.notify(target);
  }
}

export const dialogs = new Dialogs(cdp);

export function describeDialog(dialog: PageDialog) {
  const kind = dialog.type === 'beforeunload' ? 'a "Leave site?"' : (/^[aeiou]/.test(dialog.type) ? 'an ' : 'a ') + dialog.type;
  return `The page is showing ${kind} dialog${dialog.message ? `: "${dialog.message.slice(0, 300)}"` : ''}.`;
}

const STUCK_TAB =
  'This tab is not responding. It is most likely showing a dialog that opened before the app was watching it, ' +
  'which only someone at the desktop can answer. Close the tab, or answer the dialog at the desktop.';

// Human takeover

const pauseFile = path.join(DATA, 'browser-pause.json');

export class Takeover {
  private saved = existsSync(pauseFile) ? JSON.parse(readFileSync(pauseFile, 'utf8')) : {};
  paused = this.saved.paused === true;
  owner?: string;
  /** The tab the agent last used or asked help for, so the viewer can open it directly. */
  agentTab?: string = typeof this.saved.agentTab === 'string' ? this.saved.agentTab : undefined;
  clients = new Set<WebSocket>();
  onPause = () => {};
  onResume = () => {};
  inflight = 0;

  async begin(owner: string) {
    if (this.owner && this.owner !== owner && this.clients.size) {
      throw new Error('Browser is controlled by another signed-in device');
    }
    this.paused = true;
    this.owner = owner;
    savePrivate(pauseFile, {paused: true, agentTab: this.agentTab});
    this.onPause();
    // Let app browser operations finish before showing credential entry.
    const deadline = Date.now() + 10_000;
    while (this.inflight && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    if (this.inflight) throw new Error('An agent browser action is still finishing. Retry takeover.');
  }

  release(owner: string) {
    if (this.owner && this.owner !== owner) throw new Error('Takeover belongs to another device');
    for (const ws of this.clients) ws.close(1000, 'Control returned');
    this.clients.clear();
    this.owner = undefined;
    this.paused = false;
    savePrivate(pauseFile, {paused: false, agentTab: this.agentTab});
    this.onResume();
  }

  /** Sign-out or expiry closes viewers but keeps the agent paused until an explicit return. */
  revoke(owner: string) {
    if (this.owner !== owner) return;
    for (const ws of this.clients) ws.close(1008, 'Sign-in expired');
    this.clients.clear();
    this.owner = undefined;
  }

  async agent<T>(fn: () => Promise<T>): Promise<T> {
    if (this.paused) throw new Error('Browser paused for human sign-in. Wait for explicit return of control.');
    this.inflight++;
    try {
      return await fn();
    } finally {
      this.inflight--;
    }
  }
}

export const takeover = new Takeover();

// Input validation

export function checkedUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without credentials are allowed');
  }
  return url.href;
}

const finite = (x: any, min: number, max: number) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;

const KEYS: Record<string, {code: string; keyCode: number}> = {
  Enter: {code: 'Enter', keyCode: 13},
  Tab: {code: 'Tab', keyCode: 9},
  Backspace: {code: 'Backspace', keyCode: 8},
  Escape: {code: 'Escape', keyCode: 27},
  ArrowLeft: {code: 'ArrowLeft', keyCode: 37},
  ArrowUp: {code: 'ArrowUp', keyCode: 38},
  ArrowRight: {code: 'ArrowRight', keyCode: 39},
  ArrowDown: {code: 'ArrowDown', keyCode: 40},
  Delete: {code: 'Delete', keyCode: 46},
  Home: {code: 'Home', keyCode: 36},
  End: {code: 'End', keyCode: 35},
  PageUp: {code: 'PageUp', keyCode: 33},
  PageDown: {code: 'PageDown', keyCode: 34},
};

// BrowserOS runs on macOS, where editing shortcuts need explicit editor commands over CDP.
const SHORTCUTS: Record<string, {key: string; keyCode: number; shift?: boolean}> = {
  selectAll: {key: 'a', keyCode: 65},
  copy: {key: 'c', keyCode: 67},
  cut: {key: 'x', keyCode: 88},
  undo: {key: 'z', keyCode: 90},
  redo: {key: 'z', keyCode: 90, shift: true},
};

const MODIFIER = {alt: 1, ctrl: 2, meta: 4, shift: 8};

function modifiers(message: any) {
  let bits = 0;
  for (const [name, bit] of Object.entries(MODIFIER)) {
    const value = message[name];
    if (value !== undefined && typeof value !== 'boolean') throw new Error('Invalid modifier');
    if (value) bits |= bit;
  }
  return bits;
}

export function validateInput(m: any): {method: string; params: Record<string, unknown>} {
  if (!m || typeof m !== 'object') throw new Error('Invalid input');
  if (m.type === 'pointer') {
    const events = ['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'];
    if (
      !finite(m.x, 0, 20000) ||
      !finite(m.y, 0, 20000) ||
      !events.includes(m.event) ||
      !['left', 'right', 'none'].includes(m.button || 'left')
    ) {
      throw new Error('Invalid pointer');
    }
    const wheel = m.event === 'mouseWheel';
    if (wheel && (!finite(m.deltaX, -3000, 3000) || !finite(m.deltaY, -3000, 3000))) throw new Error('Invalid scroll');
    return {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: m.event,
        x: m.x,
        y: m.y,
        button: m.button || 'left',
        clickCount: m.event === 'mouseMoved' || wheel ? 0 : 1,
        ...(wheel ? {deltaX: m.deltaX, deltaY: m.deltaY} : {}),
      },
    };
  }
  if (m.type === 'text' && typeof m.text === 'string' && m.text.length <= 4096) {
    return {method: 'Input.insertText', params: {text: m.text}};
  }
  if (m.type === 'key' && Object.hasOwn(KEYS, m.key) && ['keyDown', 'keyUp'].includes(m.event)) {
    const key = KEYS[m.key];
    return {
      method: 'Input.dispatchKeyEvent',
      params: {type: m.event, key: m.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: modifiers(m)},
    };
  }
  if (m.type === 'shortcut' && Object.hasOwn(SHORTCUTS, m.action) && ['keyDown', 'keyUp'].includes(m.event)) {
    const shortcut = SHORTCUTS[m.action];
    const down = m.event === 'keyDown';
    return {
      method: 'Input.dispatchKeyEvent',
      params: {
        type: down ? 'rawKeyDown' : 'keyUp',
        key: shortcut.key,
        code: 'Key' + shortcut.key.toUpperCase(),
        windowsVirtualKeyCode: shortcut.keyCode,
        modifiers: MODIFIER.meta | (shortcut.shift ? MODIFIER.shift : 0),
        ...(down ? {commands: [m.action]} : {}),
      },
    };
  }
  throw new Error('Unsupported input');
}

// Remote viewer

const FRAME_BUFFER_LIMIT = 2_000_000;
/** Width in device pixels for fallback screenshots; about 60 KB per frame. */
const SHOT_WIDTH = 1200;

export async function viewerSocket(ws: WebSocket, owner: string) {
  if (!takeover.paused || takeover.owner !== owner) {
    ws.close(1008, 'Take control first');
    return;
  }
  takeover.clients.add(ws);
  // A second viewer for this sign-in replaces the first without returning agent control.
  for (const old of takeover.clients) if (old !== ws) old.close(1000, 'Viewer replaced');

  let sid: string | undefined;
  let target: string | undefined;
  let closed = false;
  let chain = Promise.resolve();
  let lastMessage = Date.now();
  let queued = 0;
  // Frames are acknowledged only after delivery. Chrome stops sending until the ack, which
  // throttles the stream to what the remote connection can absorb.
  let heldFrame: {params: any; session: string} | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  // BrowserOS keeps most tabs hidden, and a hidden tab sends no screencast frames. When the
  // screencast is silent, screenshots stand in: on attach, after each input, and every few seconds.
  let lastFrameAt = 0;
  let lastShotAt = 0;
  let capturing = false;
  const shotTimers = new Set<NodeJS.Timeout>();
  // The viewer shows dialogs on its own tab and finishes attaching once one is answered.
  const onDialog = (tab: string, dialog?: PageDialog) => {
    if (tab !== target || closed) return;
    send({type: 'dialog', dialog: dialog ?? null});
    if (!dialog && !sid) {
      chain = chain
        .then(() => attach(tab))
        .catch(error => {
          send({type: 'error', message: error.message});
        });
    }
    if (!dialog) refreshSoon();
  };
  dialogs.listeners.add(onDialog);

  const send = (message: any) => {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount >= FRAME_BUFFER_LIMIT) return false;
    ws.send(JSON.stringify(message));
    return true;
  };

  const deliverFrame = (params: any, session: string) => {
    if (session !== sid) return true;
    if (!send({type: 'frame', data: params.data, metadata: params.metadata, target})) return false;
    lastFrameAt = Date.now();
    void cdp.send('Page.screencastFrameAck', {sessionId: params.sessionId}, session).catch(() => {});
    return true;
  };

  const drain = () => {
    if (drainTimer) return;
    drainTimer = setInterval(() => {
      if (closed || !heldFrame) {
        clearInterval(drainTimer);
        drainTimer = undefined;
        return;
      }
      if (ws.bufferedAmount < FRAME_BUFFER_LIMIT / 2 && deliverFrame(heldFrame.params, heldFrame.session)) {
        heldFrame = undefined;
      }
    }, 100);
  };

  const listener = (message: any) => {
    if (message.method === 'Page.screencastFrame' && message.sessionId === sid) {
      if (!deliverFrame(message.params, message.sessionId)) {
        // Keep only the newest undelivered frame; release the older one so Chrome can continue.
        if (heldFrame) {
          void cdp
            .send('Page.screencastFrameAck', {sessionId: heldFrame.params.sessionId}, heldFrame.session)
            .catch(() => {});
        }
        heldFrame = {params: message.params, session: message.sessionId};
        drain();
      }
    }
    if (message.method === 'Disconnected') {
      sid = undefined;
      heldFrame = undefined;
      send({type: 'error', message: 'BrowserOS disconnected. Choose the tab again to reconnect.'});
    }
  };
  cdp.listeners.add(listener);

  const capture = async () => {
    const session = sid;
    if (!session || closed || capturing || ws.bufferedAmount >= FRAME_BUFFER_LIMIT / 2) return;
    // A page showing a dialog cannot be captured; the call would hang.
    if (target && dialogs.dialog(target)) return;
    capturing = true;
    try {
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, session);
      const css = metrics.cssVisualViewport;
      const ratio = metrics.visualViewport.clientWidth / css.clientWidth || 1;
      const scale = Math.min(1, SHOT_WIDTH / (css.clientWidth * ratio));
      const shot = await cdp.send(
        'Page.captureScreenshot',
        {format: 'jpeg', quality: 60, clip: {x: css.pageX, y: css.pageY, width: css.clientWidth, height: css.clientHeight, scale}},
        session,
      );
      if (session !== sid || closed) return;
      lastShotAt = Date.now();
      send({type: 'frame', data: shot.data, metadata: {deviceWidth: css.clientWidth, deviceHeight: css.clientHeight}, target});
    } catch {
      // A tab that is navigating can refuse a capture; the next attempt follows shortly.
    } finally {
      capturing = false;
    }
  };

  /** Refreshes the picture after input unless the live screencast already did. */
  const refreshSoon = () => {
    const since = Date.now();
    for (const delay of [150, 700, 1800]) {
      const timer = setTimeout(() => {
        shotTimers.delete(timer);
        if (lastFrameAt < since) void capture();
      }, delay);
      shotTimers.add(timer);
    }
  };

  const idleShots = setInterval(() => {
    const now = Date.now();
    if (sid && now - lastFrameAt > 2500 && now - lastShotAt > 2500) void capture();
  }, 1000);

  const stop = async () => {
    const previous = sid;
    sid = undefined;
    heldFrame = undefined;
    if (previous) {
      await cdp.send('Page.stopScreencast', {}, previous).catch(() => {});
      await cdp.detach(previous);
    }
  };

  const attach = async (id: string) => {
    await stop();
    if (closed) return;
    target = id;
    const watching = await dialogs.watch(id);
    if (closed) return;
    if (!watching) {
      send({type: 'attached', target: id});
      send({type: 'stuck', message: STUCK_TAB});
      return;
    }
    const open = dialogs.dialog(id);
    if (open) {
      // Page events and pictures hang until the dialog is answered; attaching resumes after that.
      send({type: 'attached', target: id});
      send({type: 'dialog', dialog: open});
      return;
    }
    // BrowserOS keeps most tabs in the background, where pages draw no frames and never finish handling a
    // scroll. Bring the tab the person chose to the front of its window.
    await cdp.send('Target.activateTarget', {targetId: id}).catch(() => {});
    sid = await cdp.attach(id);
    await cdp.send('Page.enable', {}, sid);
    if (closed) {
      await stop();
      return;
    }
    await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1}, sid);
    // The viewer may have closed while the screencast was starting.
    if (closed) {
      await stop();
      return;
    }
    send({type: 'attached', target: id});
    if (!lastFrameAt || Date.now() - lastFrameAt > 300) await capture();
  };

  const handle = async (raw: string) => {
    if (closed || ws.readyState !== WebSocket.OPEN || !takeover.paused || takeover.owner !== owner) return;
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON');
    }
    if (m.type === 'tabs') {
      send({type: 'tabs', tabs: await cdp.tabs()});
      return;
    }
    if (m.type === 'attach' && typeof m.id === 'string' && m.id.length < 128) {
      await attach(m.id);
      return;
    }
    if (m.type === 'open') {
      const created = await cdp.send('Target.createTarget', {url: checkedUrl(m.url)});
      send({type: 'tabs', tabs: await cdp.tabs()});
      await attach(created.targetId);
      return;
    }
    if (m.type === 'dialog') {
      if (!target || typeof m.accept !== 'boolean') throw new Error('Choose a tab');
      await dialogs.answer(target, m.accept, typeof m.text === 'string' ? m.text : undefined);
      return;
    }
    if (m.type === 'close') {
      if (!target) throw new Error('Choose a tab');
      const closing = target;
      await stop();
      target = undefined;
      await cdp.send('Target.closeTarget', {targetId: closing});
      send({type: 'tabs', tabs: await cdp.tabs()});
      send({type: 'closed'});
      return;
    }
    if (target && dialogs.dialog(target)) throw new Error('Answer the dialog first.');
    if (m.type === 'navigate') {
      if (!sid) throw new Error('Choose a tab');
      await cdp.send('Page.navigate', {url: checkedUrl(m.url)}, sid);
      return;
    }
    if (!sid) throw new Error('Choose a tab');
    const command = validateInput(m);
    await cdp.send(command.method, command.params, sid);
    if (m.event !== 'mouseMoved') refreshSoon();
  };

  // Scrolls and hover moves are sent without waiting their turn: a page can take long to finish them, and
  // a trackpad sends dozens a second. A few may be in flight; the rest are dropped, as a busy page would.
  let looseInFlight = 0;
  const loose = (m: any) => {
    if (!sid || (target && dialogs.dialog(target)) || looseInFlight >= 4) return;
    const command = validateInput(m);
    looseInFlight++;
    cdp
      .send(command.method, command.params, sid, 4000)
      .catch(() => {})
      .finally(() => {
        looseInFlight--;
      });
    if (m.event === 'mouseWheel') refreshSoon();
  };

  ws.on('message', raw => {
    lastMessage = Date.now();
    const text = raw.toString();
    let quick: any;
    try {
      quick = JSON.parse(text);
    } catch {
      quick = undefined;
    }
    // Keep-alives are answered at once, never behind slow page commands.
    if (quick?.type === 'ping') {
      send({type: 'pong'});
      return;
    }
    if (quick?.type === 'pointer' && (quick.event === 'mouseWheel' || quick.event === 'mouseMoved')) {
      if (closed || !takeover.paused || takeover.owner !== owner) return;
      try {
        loose(quick);
      } catch (error: any) {
        send({type: 'error', message: error.message});
      }
      return;
    }
    // A page that stopped answering backs up input; drop it rather than closing the viewer.
    if (queued >= 64) {
      send({type: 'error', message: 'The page is not keeping up, so some input was dropped.'});
      return;
    }
    queued++;
    chain = chain
      .then(() => handle(text))
      .catch(error => {
        send({type: 'error', message: error.message});
      })
      .finally(() => {
        queued--;
      });
  });

  const heartbeat = setInterval(() => {
    if (Date.now() - lastMessage > 45_000) ws.close(1001, 'Viewer disconnected. Agent stays paused.');
  }, 10_000);

  ws.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    clearInterval(idleShots);
    for (const timer of shotTimers) clearTimeout(timer);
    if (drainTimer) clearInterval(drainTimer);
    takeover.clients.delete(ws);
    cdp.listeners.delete(listener);
    dialogs.listeners.delete(onDialog);
    void stop();
  });

  const tabs = await cdp.tabs();
  const suggested = suggestTab(tabs, takeover.agentTab);
  send({type: 'tabs', tabs, suggested});
  if (suggested) {
    chain = chain.then(() => attach(suggested)).catch(error => {
      send({type: 'error', message: error.message});
    });
  }
}

/**
 * The tab to open first: the one the agent used or asked help for, else the newest sign-in page.
 * Target.getTargets lists newer tabs later.
 */
export function suggestTab(tabs: {id: string; url: string}[], agentTab?: string) {
  if (agentTab && tabs.some(tab => tab.id === agentTab)) return agentTab;
  const signIn = /sign[-_]?in|log[-_]?in|\/auth|oauth|sso|consent|verify/i;
  return tabs.filter(tab => signIn.test(tab.url)).at(-1)?.id;
}

// Agent browser tool, called by the Pi extension through the loopback-only internal listener.

export async function browserAction(action: any) {
  if (action.action === 'request_help') {
    if (typeof action.tab === 'string') takeover.agentTab = action.tab;
    await takeover.begin('agent-request');
    takeover.owner = undefined;
    return {
      text: 'Human sign-in requested. Agent paused. Open Browser in the app and take control. Return control explicitly after sign-in.',
    };
  }
  return takeover.agent(async () => {
    if (action.action === 'tabs') {
      const tabs = (await cdp.tabs()).map((tab: any) => {
        const dialog = dialogs.dialog(tab.id);
        return dialog ? {...tab, dialog: {type: dialog.type, message: dialog.message.slice(0, 300)}} : tab;
      });
      return {text: JSON.stringify(tabs)};
    }
    if (action.action === 'open') {
      const created = await cdp.send('Target.createTarget', {url: checkedUrl(action.url)});
      takeover.agentTab = created.targetId;
      await dialogs.watch(created.targetId).catch(() => false);
      return {text: JSON.stringify({id: created.targetId})};
    }
    if (typeof action.tab !== 'string' || action.tab.length > 128) throw new Error('A tab ID is required');
    const tab = action.tab;
    takeover.agentTab = tab;
    if (action.action === 'close') {
      await cdp.send('Target.closeTarget', {targetId: tab});
      return {text: 'Closed'};
    }
    // Listen for dialogs before acting, so one the action opens can be answered.
    const watching = await dialogs.watch(tab);
    if (action.action === 'dialog') {
      if (typeof action.accept !== 'boolean') throw new Error('dialog needs accept: true (OK) or false (Cancel)');
      if (!watching) throw new Error(STUCK_TAB + ' Call request_help, or close the tab.');
      const dialog = dialogs.dialog(tab);
      if (!dialog) throw new Error('This tab is not showing a dialog.');
      await dialogs.answer(tab, action.accept, typeof action.text === 'string' ? action.text : undefined);
      return {text: `${action.accept ? 'Accepted' : 'Dismissed'} the ${dialog.type} dialog.`};
    }
    if (!watching) throw new Error(STUCK_TAB + ' Call request_help, or close the tab.');
    const open = dialogs.dialog(tab);
    if (open) throw new Error(describeDialog(open) + ' ' + ANSWER_HINT);
    const sid = await cdp.attach(tab);
    try {
      const result = await tabAction(action, sid);
      // A click can open a dialog; it shows up a moment later.
      if (action.action === 'click' && result.text === 'Clicked') {
        await new Promise(resolve => setTimeout(resolve, 400));
        const opened = dialogs.dialog(tab);
        if (opened) return {text: 'Clicked. ' + describeDialog(opened) + ' ' + ANSWER_HINT};
      }
      return result;
    } catch (error: any) {
      const opened = dialogs.dialog(tab);
      if (opened) throw new Error(describeDialog(opened) + ' ' + ANSWER_HINT);
      throw error;
    } finally {
      await cdp.detach(sid);
    }
  });
}

const ANSWER_HINT =
  'The page is frozen until it is answered. Use action "dialog" with accept true (OK) or false (Cancel), ' +
  'plus text for a prompt, or call request_help to let the owner decide.';

async function tabAction(action: any, sid: string) {
  if (action.action === 'navigate') {
    await cdp.send('Page.navigate', {url: checkedUrl(action.url)}, sid);
    return {text: 'Navigated'};
  }
  if (action.action === 'screenshot') {
    const shot = await cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: 60}, sid);
    return {image: shot.data};
  }
  if (action.action === 'read') {
    const read = await cdp.send(
      'Runtime.evaluate',
      {expression: 'document.body?.innerText?.slice(0,24000) || ""', returnByValue: true},
      sid,
    );
    return {text: read.result.value};
  }
  if (action.action === 'click' || action.action === 'type') {
    if (typeof action.selector !== 'string' || action.selector.length > 1000) throw new Error('CSS selector required');
    const selector = JSON.stringify(action.selector);
    const expression =
      action.action === 'click'
        ? // Clicked after returning, so a dialog the click opens cannot freeze this call.
          `(()=>{const e=document.querySelector(${selector});if(!e)return 'Not found';setTimeout(()=>e.click());return 'Clicked';})()`
        : `(()=>{const e=document.querySelector(${selector});if(!e)return 'Not found';` +
          `if(e.type==='password'||e.autocomplete==='one-time-code')return 'Human sign-in required; call request_help';` +
          `e.focus();return 'Focused';})()`;
    const evaluated = await cdp.send('Runtime.evaluate', {expression, returnByValue: true}, sid);
    const text = evaluated.result.value;
    if (action.action === 'type' && text === 'Focused') {
      if (typeof action.text !== 'string' || action.text.length > 4000) throw new Error('Invalid text');
      await cdp.send('Input.insertText', {text: action.text}, sid);
      return {text: 'Typed'};
    }
    return {text};
  }
  throw new Error('Unsupported browser action');
}
