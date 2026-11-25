// Muster's menu-bar app: a tray icon with the number of threads waiting for you, a native notification when one
// starts waiting, Muster in its own window, and start/restart for the Muster service. It talks to the Muster
// already running on this computer; it doesn't run one itself.
import {app, BrowserWindow, dialog, Menu, nativeImage, Notification, session, shell, Tray} from 'electron';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {locate, MusterClient, newlyWaiting, running} from './muster.mjs';

const ASSETS = path.join(import.meta.dirname, 'assets');
const INSTALL_URL = 'https://agentmuster.io/#install';
const POLL_MS = 5000;
const where = locate();
const client = new MusterClient(where);
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

let tray;
let window;
let state = {up: false, error: '', threads: [], waiting: []};
let seen = null;
let settings = {notifications: true};
try {
  settings = {...settings, ...JSON.parse(readFileSync(settingsFile, 'utf8'))};
} catch {}
const saveSettings = () => {
  mkdirSync(path.dirname(settingsFile), {recursive: true});
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
};

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => openWindow());
// A menu-bar app keeps running with no window open.
app.on('window-all-closed', () => {});

// The window shares the app's sign-in as its cookie, so it never shows the password form.
client.onToken = token =>
  void session.defaultSession.cookies.set({
    url: where.url,
    name: 'meta_session',
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    expirationDate: Date.now() / 1000 + 30 * 24 * 60 * 60,
  });

function launchctl(...args) {
  return spawnSync('launchctl', args, {encoding: 'utf8'});
}
const domain = () => `gui/${process.getuid()}`;
const serviceInstalled = () => existsSync(where.plist);
const serviceLoaded = () => launchctl('print', `${domain()}/${where.serviceLabel}`).status === 0;

async function restartService() {
  const busy = running(state.threads);
  if (busy.length) {
    const {response} = await dialog.showMessageBox({
      type: 'warning',
      message: `${busy.length === 1 ? 'A reply is' : `${busy.length} replies are`} still running.`,
      detail: 'Restarting Muster stops them. You can resume them afterwards.',
      buttons: ['Restart anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  const result = serviceLoaded()
    ? launchctl('kickstart', '-k', `${domain()}/${where.serviceLabel}`)
    : launchctl('bootstrap', domain(), where.plist);
  if (result.status !== 0) dialog.showErrorBox('Muster', `Couldn't start Muster: ${(result.stderr || '').trim() || 'launchctl failed'}`);
  setTimeout(poll, 2000);
}

function openWindow(threadId) {
  const target = where.url + '/' + (threadId ? `?thread=${encodeURIComponent(threadId)}` : '');
  if (window && !window.isDestroyed()) {
    if (threadId) void window.loadURL(target);
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    title: 'Muster',
    backgroundColor: '#0e1119',
    show: false,
    webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false},
  });
  // Links to other sites open in the default browser; Muster's own pages stay in the window.
  const own = url => url === where.url || url.startsWith(where.url + '/');
  window.webContents.setWindowOpenHandler(({url}) => {
    if (!own(url) && /^https?:/.test(url)) void shell.openExternal(url);
    return {action: own(url) ? 'allow' : 'deny'};
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (own(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    window = undefined;
    app.dock?.hide();
  });
  app.dock?.show();
  void (async () => {
    if (!client.token) await client.signIn().catch(() => {});
    await window.loadURL(target).catch(() => {});
  })();
}

/** The thread on screen in the focused window, which needs no notification. */
function threadOnScreen() {
  if (!window || window.isDestroyed() || !window.isFocused()) return undefined;
  try {
    return new URL(window.webContents.getURL()).searchParams.get('thread') || undefined;
  } catch {
    return undefined;
  }
}

const debug = (...args) => process.env.MUSTER_DESKTOP_DEBUG === '1' && console.log('[muster-desktop]', ...args);

function notify(thread) {
  if (!settings.notifications || !Notification.isSupported() || thread.id === threadOnScreen()) return;
  debug('notify', thread.id, thread.title, thread.attention.label);
  const shown = new Notification({title: thread.title.slice(0, 80), body: thread.attention.label});
  shown.on('click', () => openWindow(thread.id));
  shown.show();
}

async function poll() {
  const up = await client.health();
  let error = '';
  let threads = [];
  if (up) {
    try {
      threads = await client.get('/threads');
    } catch (e) {
      error = e.message;
    }
  }
  if (up && !error) {
    const {next, fresh} = newlyWaiting(seen, threads);
    seen = next;
    for (const thread of fresh) notify(thread);
  }
  state = {up, error, threads, waiting: threads.filter(thread => thread.attention)};
  debug('poll', JSON.stringify({up, error, threads: threads.length, waiting: state.waiting.length}));
  render();
}

function render() {
  const count = state.waiting.length;
  tray.setTitle(count ? ` ${count}` : '');
  tray.setToolTip(!state.up ? 'Muster isn’t running' : count ? `Muster: ${count} waiting for you` : 'Muster');
  const items = [];
  if (!state.up) items.push({label: 'Muster isn’t running', enabled: false});
  else if (state.error) items.push({label: state.error, enabled: false});
  else items.push({label: count ? `${count} waiting for you` : 'Nothing waiting', enabled: false});
  for (const thread of state.waiting.slice(0, 8)) {
    items.push({label: `${thread.title.slice(0, 48)} · ${thread.attention.label.slice(0, 40)}`, click: () => openWindow(thread.id)});
  }
  items.push({type: 'separator'});
  items.push({label: 'Open Muster', accelerator: 'CommandOrControl+O', enabled: state.up, click: () => openWindow()});
  if (serviceInstalled()) {
    items.push({label: state.up ? 'Restart Muster' : 'Start Muster', click: () => void restartService()});
  } else if (!state.up) {
    items.push({label: 'Install Muster…', click: () => void shell.openExternal(INSTALL_URL)});
  }
  items.push({type: 'separator'});
  items.push({
    label: 'Notifications',
    type: 'checkbox',
    checked: settings.notifications,
    click: item => {
      settings.notifications = item.checked;
      saveSettings();
    },
  });
  items.push({
    label: 'Open at login',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: item => app.setLoginItemSettings({openAtLogin: item.checked}),
  });
  items.push({type: 'separator'});
  items.push({label: `Muster at ${where.url.replace(/^https?:\/\//, '')}`, enabled: false});
  items.push({label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => app.quit()});
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

app.whenReady().then(() => {
  app.dock?.hide();
  // The usual app menu, so copy, paste, reload and close work in the window.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{role: 'appMenu'}, {role: 'editMenu'}, {role: 'viewMenu'}, {role: 'windowMenu'}]),
  );
  // Notifications come from this app; the page's own would repeat them.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(['clipboard-sanitized-write', 'media'].includes(permission)),
  );
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  render();
  void poll();
  setInterval(() => void poll(), POLL_MS);
  // Opened by hand, show Muster; started at login, stay in the menu bar.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) void client.health().then(up => up && openWindow());
});
// Opening the app again (Finder, Spotlight or the Dock) shows the window.
app.on('activate', () => openWindow());
