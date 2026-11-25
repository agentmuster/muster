import './viewer.css';

const root = document.querySelector<HTMLDivElement>('#viewer')!;
root.innerHTML = `
  <div class="toolbar">
    <select id="tabs" aria-label="Choose BrowserOS tab"><option>Connecting…</option></select>
    <button id="refresh">Refresh tabs</button>
    <input id="url" placeholder="https://…" aria-label="Navigate or open a page"/>
    <button id="go">Go</button>
    <button id="new">New tab</button>
    <button id="fit" hidden title="Back to fitting the whole page">1× · Fit</button>
  </div>
  <div id="notice" role="status">Choose the tab you want to control.</div>
  <div id="stuck" hidden>
    <span id="stuck-text"></span>
    <button type="button" id="close-tab">Close tab</button>
  </div>
  <div id="screen" tabindex="0" aria-label="Remote browser page. Click to focus, then type.">
    <img id="frame" draggable="false" alt="Live desktop BrowserOS page"/>
    <form id="dialog" hidden role="alertdialog" aria-labelledby="dialog-kind" aria-describedby="dialog-message">
      <strong id="dialog-kind"></strong>
      <p id="dialog-message"></p>
      <input id="dialog-text" aria-label="Answer for the page" autocomplete="off" hidden/>
      <div>
        <button type="button" id="dialog-cancel">Cancel</button>
        <button id="dialog-ok">OK</button>
      </div>
    </form>
  </div>
  <form id="typing">
    <input id="text" type="password" autocomplete="off" placeholder="Mobile keyboard: type here, then Send"
      aria-label="Text to send directly to focused browser field"/>
    <button>Send text</button>
    <button type="button" id="tab">Tab</button>
    <button type="button" id="enter">Enter</button>
    <button type="button" id="back">⌫</button>
  </form>`;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabs = el<HTMLSelectElement>('tabs');
const url = el<HTMLInputElement>('url');
const screen = el<HTMLDivElement>('screen');
const img = el<HTMLImageElement>('frame');
const notice = el<HTMLDivElement>('notice');
const dialogBox = el<HTMLFormElement>('dialog');
const dialogText = el<HTMLInputElement>('dialog-text');
const stuck = el<HTMLDivElement>('stuck');

type PageDialog = {type: string; message: string; defaultPrompt: string; url: string};

/** A dialog the page opened. The page is frozen until it is answered here or at the desktop. */
function showDialog(dialog: PageDialog | null) {
  dialogBox.hidden = !dialog;
  if (!dialog) {
    if (haveFrame) notice.textContent = 'Human control active. Click a field in the page, then use your keyboard or the input below.';
    return;
  }
  const leave = dialog.type === 'beforeunload';
  el('dialog-kind').textContent = leave ? 'Leave this page?' : `The page asks (${dialog.type})`;
  el('dialog-message').textContent = dialog.message || (leave ? 'Changes you made may not be saved.' : '');
  dialogText.hidden = dialog.type !== 'prompt';
  dialogText.value = dialog.defaultPrompt || '';
  el('dialog-cancel').hidden = dialog.type === 'alert';
  el('dialog-cancel').textContent = leave ? 'Stay' : 'Cancel';
  el('dialog-ok').textContent = leave ? 'Leave' : 'OK';
  notice.textContent = 'The page is waiting for an answer to this dialog. Nothing else works on it until then.';
  (dialogText.hidden ? el('dialog-ok') : dialogText).focus();
}
dialogBox.onsubmit = event => {
  event.preventDefault();
  send({type: 'dialog', accept: true, text: dialogText.value});
  dialogBox.hidden = true;
};
el('dialog-cancel').onclick = () => {
  send({type: 'dialog', accept: false});
  dialogBox.hidden = true;
};
el('close-tab').onclick = () => {
  if (!confirm('Close this tab in BrowserOS? Anything unsaved on it is lost.')) return;
  send({type: 'close'});
  stuck.hidden = true;
};

const STREAM = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/browser/stream`;
let ws: WebSocket;
// A dropped connection (a phone switching networks, a stalled tunnel) reconnects on its own and reopens the tab.
let retries = 0;
let reopen = '';
let width = 1;
let height = 1;
let haveFrame = false;
let selected = '';

const send = (message: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};

type Modifiers = {shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean};
function key(name: string, modifiers: Modifiers = {}) {
  send({type: 'key', key: name, event: 'keyDown', ...modifiers});
  send({type: 'key', key: name, event: 'keyUp', ...modifiers});
}

function shortcut(action: string) {
  send({type: 'shortcut', action, event: 'keyDown'});
  send({type: 'shortcut', action, event: 'keyUp'});
}

function sendText(text: string) {
  for (let i = 0; i < text.length; i += 4096) send({type: 'text', text: text.slice(i, i + 4096)});
}

setInterval(() => send({type: 'ping'}), 12_000);

function onOpen() {
  retries = 0;
  notice.textContent = reopen ? 'Reconnected. Reopening the tab…' : 'Connected. Loading tabs…';
}

function tabLabel(tab: {title: string; url: string}) {
  let host = '';
  try {
    host = new URL(tab.url).host.replace(/^www\./, '');
  } catch {
    // Keep the title alone.
  }
  const title = (tab.title || tab.url).slice(0, 80);
  return host && !title.toLowerCase().includes(host) ? `${title} — ${host}` : title;
}

function showSelected(id: string) {
  if (![...tabs.options].some(option => option.value === id)) return;
  tabs.value = id;
  selected = id;
  url.value = tabs.selectedOptions[0].dataset.url || '';
}
function onClose(event: CloseEvent) {
  // A replaced connection closing late must not undo the new one.
  if (event.target !== ws) return;
  // 1000 means control was returned or another viewer took over; 1008 means sign-in or control is missing.
  if (event.code !== 1000 && event.code !== 1008 && retries < 6) {
    retries++;
    reopen = selected;
    notice.textContent = 'Connection lost. Reconnecting…';
    setTimeout(connect, Math.min(8000, 500 * 2 ** retries));
    return;
  }
  img.removeAttribute('src');
  haveFrame = false;
  notice.textContent =
    event.code === 1000 && event.reason
      ? event.reason + '.'
      : 'Viewer disconnected. The agent remains paused. Close and reopen the viewer to reconnect.';
}
function onError() {
  if (!retries) notice.textContent = 'Could not connect. Take browser control in the app before opening this panel.';
}
function connect() {
  ws = new WebSocket(STREAM);
  ws.onopen = onOpen;
  ws.onclose = onClose;
  ws.onerror = onError;
  ws.onmessage = onMessage;
}

function onMessage(event: MessageEvent) {
  const m = JSON.parse(event.data);
  if (m.type === 'tabs') {
    const previous = reopen || tabs.value;
    tabs.replaceChildren();
    const initial = document.createElement('option');
    initial.value = '';
    initial.text = 'Choose a BrowserOS tab…';
    tabs.add(initial);
    // Newest tabs first; the agent's own tab tends to be the most recent.
    for (const tab of [...m.tabs].reverse()) {
      const option = document.createElement('option');
      option.value = tab.id;
      option.text = (tab.id === m.suggested ? '★ ' : '') + tabLabel(tab);
      option.dataset.url = tab.url;
      tabs.add(option);
    }
    if (m.suggested) {
      showSelected(m.suggested);
      notice.textContent = 'Opening the tab the agent needs help with…';
    } else if ([...tabs.options].some(option => option.value === previous)) {
      tabs.value = previous;
    } else {
      notice.textContent = 'Choose the tab you want to control.';
    }
    if (reopen && reopen !== m.suggested && [...tabs.options].some(option => option.value === reopen)) {
      showSelected(reopen);
      send({type: 'attach', id: reopen});
    }
    reopen = '';
  }
  if (m.type === 'dialog') showDialog(m.dialog);
  if (m.type === 'stuck') {
    el('stuck-text').textContent = m.message;
    stuck.hidden = false;
    notice.textContent = 'Choose another tab, or close this one.';
  }
  if (m.type === 'closed') {
    img.removeAttribute('src');
    haveFrame = false;
    selected = '';
    tabs.value = '';
    showDialog(null);
    notice.textContent = 'Tab closed. Choose another tab.';
  }
  if (m.type === 'attached') {
    stuck.hidden = true;
    showSelected(m.target);
    if (!haveFrame) notice.textContent = 'Loading the page picture…';
  }
  if (m.type === 'frame') {
    img.src = 'data:image/jpeg;base64,' + m.data;
    width = m.metadata.deviceWidth || img.naturalWidth;
    height = m.metadata.deviceHeight || img.naturalHeight;
    haveFrame = true;
    notice.textContent = 'Human control active. Click a field in the page, then use your keyboard or the input below.';
  }
  if (m.type === 'error') notice.textContent = m.message;
}
connect();

tabs.onchange = () => {
  selected = tabs.value;
  if (!selected) return;
  dialogBox.hidden = true;
  stuck.hidden = true;
  img.removeAttribute('src');
  haveFrame = false;
  zoom = 1;
  applyZoom();
  notice.textContent = 'Opening tab…';
  send({type: 'attach', id: selected});
  url.value = tabs.selectedOptions[0].dataset.url || '';
};
el('refresh').onclick = () => send({type: 'tabs'});

function navigate(open: boolean) {
  let value = url.value.trim();
  if (!value) return;
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  send({type: open ? 'open' : 'navigate', url: value});
}
el('go').onclick = () => navigate(false);
el('new').onclick = () => navigate(true);
url.onkeydown = event => {
  if (event.key === 'Enter') navigate(!selected);
};

/** Maps a pointer position on the letterboxed image to page coordinates. */
function point(event: {clientX: number; clientY: number}) {
  const rect = img.getBoundingClientRect();
  const ratio = img.naturalWidth / img.naturalHeight;
  const visibleWidth = Math.min(rect.width, rect.height * ratio);
  const visibleHeight = visibleWidth / ratio;
  const x = ((event.clientX - rect.left - (rect.width - visibleWidth) / 2) / visibleWidth) * width;
  const y = ((event.clientY - rect.top - (rect.height - visibleHeight) / 2) / visibleHeight) * height;
  return {x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y))};
}

const clamp = (value: number) => Math.max(-3000, Math.min(3000, value));

// Local zoom: pinch (or ctrl-wheel / trackpad pinch) magnifies the picture on this device only.
// Taps still land on the right spot because point() measures the transformed image.
let zoom = 1;
let panX = 0;
let panY = 0;
const MAX_ZOOM = 6;
const fit = el<HTMLButtonElement>('fit');

function applyZoom() {
  const width = screen.clientWidth;
  const height = screen.clientHeight;
  zoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
  panX = Math.min(0, Math.max(width - width * zoom, panX));
  panY = Math.min(0, Math.max(height - height * zoom, panY));
  img.style.transform = zoom === 1 ? '' : `translate(${panX}px, ${panY}px) scale(${zoom})`;
  fit.hidden = zoom === 1;
  fit.textContent = `${zoom.toFixed(1)}× · Fit`;
}

/** Zooms by a factor while keeping the given screen point fixed under the finger or cursor. */
function zoomAt(clientX: number, clientY: number, nextZoom: number, from = {zoom, panX, panY}) {
  const rect = screen.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const contentX = (x - from.panX) / from.zoom;
  const contentY = (y - from.panY) / from.zoom;
  zoom = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
  panX = x - contentX * zoom;
  panY = y - contentY * zoom;
  applyZoom();
}

fit.onclick = () => {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyZoom();
};
window.addEventListener('resize', applyZoom);

const touches = new Map<number, {x: number; y: number}>();
let touchStart: {x: number; y: number; clientX: number; clientY: number; panX: number; panY: number} | undefined;
let pinch: {distance: number; midX: number; midY: number; zoom: number; panX: number; panY: number} | undefined;
// Once two fingers touched, the gesture is a zoom; lifting the last finger must not click.
let gesture = false;

/** The browser's current finger list is the source of truth, so a missed touchend cannot leave a stale finger. */
const syncTouches = (event: TouchEvent) => {
  touches.clear();
  for (const touch of event.touches) touches.set(touch.identifier, {x: touch.clientX, y: touch.clientY});
};

const twoFingers = () => {
  const [a, b] = [...touches.values()];
  return {distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2};
};

// Fingers use touch events: their coordinates stay in page space while the picture is transformed,
// which captured touch pointer events do not reliably do. Mouse and pen use pointer events below.
screen.addEventListener(
  'touchstart',
  event => {
    if (!haveFrame) return;
    event.preventDefault();
    screen.focus();
    syncTouches(event);
    if (touches.size >= 2) {
      gesture = true;
      touchStart = undefined;
      pinch = {...twoFingers(), zoom, panX, panY};
    } else if (touches.size === 1) {
      const [touch] = event.changedTouches;
      gesture = false;
      touchStart = {...point(touch), clientX: touch.clientX, clientY: touch.clientY, panX, panY};
    }
  },
  {passive: false},
);

screen.addEventListener(
  'touchmove',
  event => {
    if (!haveFrame) return;
    event.preventDefault();
    syncTouches(event);
    if (pinch && touches.size >= 2) {
      // The page point under the starting midpoint follows the fingers' midpoint.
      const now = twoFingers();
      const rect = screen.getBoundingClientRect();
      const contentX = (pinch.midX - rect.left - pinch.panX) / pinch.zoom;
      const contentY = (pinch.midY - rect.top - pinch.panY) / pinch.zoom;
      zoom = Math.min(MAX_ZOOM, Math.max(1, pinch.zoom * (now.distance / pinch.distance)));
      panX = now.midX - rect.left - contentX * zoom;
      panY = now.midY - rect.top - contentY * zoom;
      applyZoom();
      return;
    }
    // One finger on a magnified picture pans it instead of scrolling the remote page.
    const [touch] = event.changedTouches;
    if (touchStart && zoom > 1 && touch) {
      const dx = touch.clientX - touchStart.clientX;
      const dy = touch.clientY - touchStart.clientY;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        panX = touchStart.panX + dx;
        panY = touchStart.panY + dy;
        applyZoom();
      }
    }
  },
  {passive: false},
);

const endTouches = (event: TouchEvent, cancelled: boolean) => {
  if (!haveFrame) return;
  event.preventDefault();
  syncTouches(event);
  if (touches.size < 2) pinch = undefined;
  if (touches.size > 0) return;
  const start = touchStart;
  touchStart = undefined;
  const [touch] = event.changedTouches;
  if (cancelled || gesture || !start || !touch) return;
  const dx = start.clientX - touch.clientX;
  const dy = start.clientY - touch.clientY;
  if (Math.abs(dx) > 15 || Math.abs(dy) > 15) {
    // At normal size a swipe scrolls the remote page; when magnified it already panned the picture.
    if (zoom === 1) {
      const at = point(touch);
      send({type: 'pointer', event: 'mouseWheel', button: 'none', ...at, deltaX: clamp(dx * 2), deltaY: clamp(dy * 2)});
    }
    return;
  }
  const at = {x: start.x, y: start.y};
  send({type: 'pointer', event: 'mousePressed', button: 'left', ...at});
  send({type: 'pointer', event: 'mouseReleased', button: 'left', ...at});
};
screen.addEventListener('touchend', event => endTouches(event, false), {passive: false});
screen.addEventListener('touchcancel', event => endTouches(event, true), {passive: false});

screen.onpointerdown = event => {
  if (!haveFrame || event.pointerType === 'touch') return;
  event.preventDefault();
  screen.focus();
  send({type: 'pointer', event: 'mousePressed', button: event.button === 2 ? 'right' : 'left', ...point(event)});
};
screen.onpointerup = event => {
  if (!haveFrame || event.pointerType === 'touch') return;
  event.preventDefault();
  send({type: 'pointer', event: 'mouseReleased', button: event.button === 2 ? 'right' : 'left', ...point(event)});
};

screen.oncontextmenu = event => event.preventDefault();
// Safari's own page zoom would otherwise take the pinch.
for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
  screen.addEventListener(name, event => event.preventDefault(), {passive: false} as AddEventListenerOptions);
}

screen.addEventListener(
  'wheel',
  event => {
    if (!haveFrame) return;
    event.preventDefault();
    // Trackpad pinch arrives as a wheel event with ctrlKey.
    if (event.ctrlKey) {
      zoomAt(event.clientX, event.clientY, zoom * Math.exp(-event.deltaY / 100));
      return;
    }
    // A trackpad fires dozens of wheel events a second; send their sum about twenty times a second.
    wheel.dx += event.deltaX;
    wheel.dy += event.deltaY;
    wheel.at = point(event);
    wheel.timer ??= setTimeout(flushWheel, 50);
  },
  {passive: false},
);
const wheel: {dx: number; dy: number; at?: {x: number; y: number}; timer?: ReturnType<typeof setTimeout>} = {dx: 0, dy: 0};
function flushWheel() {
  wheel.timer = undefined;
  if (wheel.at && (wheel.dx || wheel.dy)) {
    send({type: 'pointer', event: 'mouseWheel', button: 'none', ...wheel.at, deltaX: clamp(wheel.dx), deltaY: clamp(wheel.dy)});
  }
  wheel.dx = 0;
  wheel.dy = 0;
}

const MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super',
  'NumLock', 'ScrollLock', 'Dead', 'Process', 'Unidentified', 'AltGraph',
]);
const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Delete', 'Home', 'End', 'PageUp', 'PageDown',
]);
const SHORTCUTS: Record<string, string> = {a: 'selectAll', c: 'copy', x: 'cut', z: 'undo'};

screen.onkeydown = event => {
  if (!haveFrame || MODIFIER_KEYS.has(event.key)) return;
  const command = event.metaKey || event.ctrlKey;
  // Let the paste event read this device's clipboard.
  if (command && event.key.toLowerCase() === 'v') return;
  event.preventDefault();
  if (command) {
    const letter = event.key.toLowerCase();
    if (letter === 'z' && event.shiftKey) shortcut('redo');
    else if (SHORTCUTS[letter]) shortcut(SHORTCUTS[letter]);
    return;
  }
  if (event.key.length === 1) {
    sendText(event.key);
    return;
  }
  if (NAMED_KEYS.has(event.key)) key(event.key, {shift: event.shiftKey, alt: event.altKey});
};

document.addEventListener('paste', event => {
  if (!haveFrame || document.activeElement !== screen) return;
  const text = event.clipboardData?.getData('text/plain');
  if (!text) return;
  event.preventDefault();
  sendText(text);
});

el<HTMLFormElement>('typing').onsubmit = event => {
  event.preventDefault();
  const input = el<HTMLInputElement>('text');
  if (input.value) {
    sendText(input.value);
    input.value = '';
  }
};
el('enter').onclick = () => key('Enter');
el('tab').onclick = () => key('Tab');
el('back').onclick = () => key('Backspace');

window.addEventListener('pagehide', () => {
  img.removeAttribute('src');
  el<HTMLInputElement>('text').value = '';
  ws.close();
});
