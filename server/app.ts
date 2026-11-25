import express, {type NextFunction, type Request, type Response} from 'express';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {WebSocketServer} from 'ws';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {spawn, type ChildProcess} from 'node:child_process';
import {CopilotRuntime, copilotRuntimeNodeHttpEndpoint} from '@copilotkit/runtime';
import {
  DATA,
  PORT,
  allowedHost,
  allowedOrigin,
  allowedOrigins,
  auth,
  csrfSafe,
  hosts,
  isLoopbackAddress,
  savePrivate,
  secureRequest,
  sessionCookie,
  socketOriginFor,
} from './security.js';
import {canonicalCwd, jobs, LocalPiAgent, python, workspaceRoots} from './jobs.js';
import {ACTIVE_CONTENT} from './files.js';
import {modules} from './modules.js';
import {triage} from './triage.js';
import {pullRequests} from './pull-requests.js';
import {listCommands} from './commands.js';
import {backgroundDetail} from './background.js';
import {terminals} from './terminal.js';
import {PersistedRunner} from './runner.js';
import {THINKING_LEVELS, clearModelCache, compactionFor, listModels, piDefaults, runOptions, setCompactionThreshold} from './pi-config.js';
import {cancelFinder, getFinder, startFinder} from './finder.js';
import {readUserContent, uploadPath} from './uploads.js';
import {browserAction, cdp, takeover, viewerSocket} from './browser.js';
import {redact} from './redact.js';
import {processAlive} from './process-tree.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SOURCE_ID = /^[a-f0-9]{24}$/;
const INDEX_STATUS = path.join(DATA, 'index-status.json');

// Set by the /api session gate below.
const ownerOf = (req: Request) => (req as Request & {owner: string}).owner;

function contentSecurityPolicy() {
  const sockets = [...hosts()].map(socketOriginFor).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${sockets}`,
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (!allowedHost(req)) {
    res.status(403).json({error: 'Host not allowed'});
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy());
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfSafe(req)) {
    res.status(403).json({error: 'Same-origin request required'});
    return;
  }
  if (req.headers.origin && !allowedOrigin(req, false)) {
    res.status(403).json({error: 'Origin not allowed'});
    return;
  }
  next();
});
const smallJson = express.json({limit: '512kb'});
// CopilotKit posts the whole visible conversation, including saved tool output and new images
// (up to 8 of 10 MB each, base64), so it gets a larger limit. That parser runs only after the sign-in check on its route.
const chatJson = express.json({limit: '100mb'});
// Queued messages can carry images, so they get the chat route's larger limit.
const QUEUE_PATH = /^\/api\/threads\/[^/]+\/queue$/;
app.use((req, res, next) => {
  if (req.path.startsWith('/api/copilotkit')) next();
  else if (QUEUE_PATH.test(req.path)) chatJson(req, res, next);
  else smallJson(req, res, next);
});

app.get('/api/health', (_req, res) => {
  res.json({ok: true});
});

app.post('/api/login', async (req, res, next) => {
  try {
    const token = await auth.login(req, req.body?.password);
    res.setHeader('Set-Cookie', sessionCookie(token, secureRequest(req)));
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res, next) => {
  const session = auth.get(req);
  if (!session) {
    res.status(401).json({error: 'Sign in required'});
    return;
  }
  (req as Request & {owner: string}).owner = session.id;
  (req as Request & {signIn?: string}).signIn = session.access;
  next();
});

app.post('/api/logout', (req, res) => {
  auth.revoke(ownerOf(req));
  const secure = secureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `meta_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  res.json({ok: true});
});

function readIndexStatus(): any {
  let status: any = {running: false, phase: 'not indexed'};
  try {
    status = JSON.parse(readFileSync(INDEX_STATUS, 'utf8'));
  } catch {
    return status;
  }
  // An indexer that was killed cannot clear its own running flag.
  if (status.running && (typeof status.pid !== 'number' || !processAlive(status.pid))) {
    status = {...status, running: false, phase: 'interrupted', error: status.error || 'The indexer stopped before finishing.'};
  }
  return status;
}

app.get('/api/status', async (req, res) => {
  let browser = true;
  try {
    await cdp.connect();
  } catch {
    browser = false;
  }
  res.json({
    index: readIndexStatus(),
    browser,
    takeover: takeover.paused,
    workspaceRoots,
    defaultCwd: workspaceRoots[0],
    engine: 'pi',
    historyProviders: ['pi', 'claude', 'codex'],
    signIn: (req as Request & {signIn?: string}).signIn
      ? {method: 'access', email: (req as Request & {signIn?: string}).signIn}
      : {method: 'password'},
  });
});

let indexProcess: ChildProcess | undefined;
let lastIndexStart = 0;

/**
 * Runs the incremental indexer unless one is already running. Only changed session files are parsed,
 * so background runs take seconds. It runs at low CPU priority so it does not compete with agents.
 */
export function startIndex(full = false) {
  if (indexProcess || readIndexStatus().running) return false;
  lastIndexStart = Date.now();
  const python = process.env.PYTHON || 'python3';
  const child = spawn('nice', ['-n', '10', python, path.join(ROOT, 'engine/indexer.py'), 'index', '--', full ? 'full' : ''], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  indexProcess = child;
  let stderr = '';
  child.stderr!.on('data', data => {
    stderr = (stderr + data).slice(-2000);
  });
  child.on('error', () => {
    indexProcess = undefined;
  });
  child.on('close', code => {
    indexProcess = undefined;
    if (code === 0) return;
    const status = readIndexStatus();
    const lastLine = stderr.trim().split('\n').at(-1) || `Indexer exited with ${code}`;
    savePrivate(INDEX_STATUS, {...status, running: false, phase: 'failed', error: status.error || redact(lastLine)});
  });
  return true;
}

const INDEX_INTERVAL_MS = Math.max(1, Number(process.env.MUSTER_INDEX_INTERVAL_MIN || 2)) * 60_000;
setInterval(() => startIndex(), INDEX_INTERVAL_MS).unref();
setTimeout(() => startIndex(), 5_000).unref();

app.post('/api/index', (_req, res) => {
  if (!startIndex(true)) {
    res.status(409).json({error: 'Index already running'});
    return;
  }
  res.json({ok: true});
});

app.get('/api/search', async (req, res, next) => {
  try {
    const query = String(req.query.q || '');
    if (query.length > 500) {
      res.status(400).json({error: 'Search is too long'});
      return;
    }
    res.json(await python('search', query));
  } catch (error) {
    next(error);
  }
});

app.get('/api/sources/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!SOURCE_ID.test(id)) {
      res.status(400).end();
      return;
    }
    const source = await python('preview', id);
    if (!source) {
      res.status(404).end();
      return;
    }
    res.json(source);
  } catch (error) {
    next(error);
  }
});

/**
 * Reload: forget cached model lists and refresh the session index. Pi itself starts fresh for every
 * run, so new extensions, skills and settings already apply to the next message.
 */
app.post('/api/reload', (_req, res) => {
  clearModelCache();
  startIndex();
  res.json({ok: true});
});

/** A workspace folder, or undefined when the path is missing or outside the workspace roots. */
function workspaceCwd(value: string) {
  try {
    return canonicalCwd(value);
  } catch {
    return undefined;
  }
}

// All merge entry points, including generic Actions, require a saved passing review.
modules.actionPolicies.set('reviewed-bitbucket-pr', input => pullRequests.requireReview(input));

// Auto-compact point for a model, as Pi resolves it for a folder.
app.get('/api/compaction', async (req, res, next) => {
  try {
    const model = String(req.query.model ?? '');
    if (!(await listModels()).some(item => item.id === model)) return res.status(400).json({error: 'Unknown model.'});
    const cwd = typeof req.query.cwd === 'string' ? workspaceCwd(req.query.cwd) : undefined;
    res.json(compactionFor(model, cwd));
  } catch (error) {
    next(error);
  }
});

// Moves the auto-compact point for a model in the owner's Pi settings. threshold null restores Pi's default.
app.post('/api/compaction', async (req, res, next) => {
  try {
    const {model, contextWindow, threshold, cwd} = req.body ?? {};
    if (typeof model !== 'string' || !(await listModels()).some(item => item.id === model)) {
      return res.status(400).json({error: 'Unknown model.'});
    }
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 8_000 || contextWindow > 20_000_000) {
      return res.status(400).json({error: 'Invalid context window.'});
    }
    if (threshold !== null && (!Number.isSafeInteger(threshold) || threshold < 4_000 || threshold > contextWindow)) {
      return res.status(400).json({error: 'The auto-compact point must be inside the context window.'});
    }
    setCompactionThreshold(model, contextWindow, threshold);
    const folder = typeof cwd === 'string' ? workspaceCwd(cwd) : undefined;
    res.json(compactionFor(model, folder));
  } catch (error) {
    next(error);
  }
});

app.get('/api/models', async (_req, res, next) => {
  try {
    res.json({defaults: piDefaults(), thinkingLevels: THINKING_LEVELS, models: await listModels()});
  } catch (error) {
    next(error);
  }
});

app.get('/api/threads', (_req, res) => {
  res.json(jobs.list());
});

app.get('/api/uploads/:name', (req, res) => {
  const file = uploadPath(String(req.params.name));
  if (!file) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Disposition', 'inline');
  // The data folder usually sits under ~/.local; without dotfiles, a hidden folder in the path means 404.
  // Only a delivered image may be cached; an error must not stick in the browser.
  res.sendFile(file, {dotfiles: 'allow', headers: {'Cache-Control': 'private, max-age=86400'}}, error => {
    if (!error) return;
    res.setHeader('Cache-Control', 'no-store');
    if (!res.headersSent) res.status(404).end();
  });
});

app.post('/api/finder', async (req, res, next) => {
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query || query.length > 2000) {
      res.status(400).json({error: 'Describe what you are looking for in 1–2,000 characters'});
      return;
    }
    // Pick up sessions written since the last background pass; the finder's first searches follow shortly.
    if (Date.now() - lastIndexStart > 60_000) startIndex();
    res.json(await startFinder(query, await runOptions({model: req.body?.model, thinking: req.body?.thinking})));
  } catch (error) {
    next(error);
  }
});

app.get('/api/finder/:id', (req, res) => {
  const finder = getFinder(String(req.params.id));
  if (!finder) {
    res.status(404).json({error: 'Search expired. Run it again.'});
    return;
  }
  res.json(finder);
});

app.post('/api/finder/:id/cancel', (req, res) => {
  cancelFinder(String(req.params.id));
  res.json({ok: true});
});

app.post('/api/threads/from-session', async (req, res, next) => {
  try {
    const {sessionId, action, cwd} = req.body || {};
    if (typeof sessionId !== 'string' || !SOURCE_ID.test(sessionId) || !['continue', 'split', 'new'].includes(action)) {
      res.status(400).json({error: 'Invalid session action'});
      return;
    }
    const fallback = typeof cwd === 'string' && cwd ? cwd : workspaceRoots[0];
    res.json(await jobs.createFromSession(sessionId, action, fallback));
  } catch (error) {
    next(error);
  }
});

app.post('/api/threads', (req, res, next) => {
  try {
    const {cwd, sources, automatic} = req.body || {};
    const validSources =
      sources === undefined || (Array.isArray(sources) && sources.every((x: unknown) => typeof x === 'string' && SOURCE_ID.test(x)));
    if (typeof cwd !== 'string' || !validSources) {
      res.status(400).json({error: 'Invalid thread settings'});
      return;
    }
    res.json(jobs.create(cwd, sources, automatic !== false));
  } catch (error) {
    next(error);
  }
});

app.get('/api/threads/:id', (req, res, next) => {
  try {
    // Events and live output travel over the event stream, not the 4-second status poll.
    const {events, output, ...thread} = jobs.get(String(req.params.id));
    res.json(thread);
  } catch (error) {
    next(error);
  }
});

/** Compacts a thread's Pi conversation (or only measures it with ?measure=1) as a background run. */
// The owner's answer to a question an extension asked (ask_user_question and other dialogs).
app.post('/api/threads/:id/question', (req, res, next) => {
  try {
    jobs.answer(String(req.params.id), req.body ?? {});
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

// Subagents and workflows the thread's Pi started in the background.
app.get('/api/threads/:id/background', (req, res, next) => {
  try {
    res.json(jobs.background(String(req.params.id)));
  } catch (error) {
    next(error);
  }
});

app.get('/api/threads/:id/background/:kind/:run', (req, res, next) => {
  try {
    const id = String(req.params.id);
    const state = jobs.background(id);
    const detail = backgroundDetail(state.session, state.alive, String(req.params.kind), String(req.params.run));
    if (!detail) return res.status(404).json({error: 'No such background run in this thread.'});
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

app.post('/api/threads/:id/background/stop', (req, res, next) => {
  try {
    jobs.stopBackground(String(req.params.id));
    res.json(jobs.background(String(req.params.id)));
  } catch (error) {
    next(error);
  }
});

// Slash commands the thread's Pi accepts, for the message box's / menu.
app.get('/api/threads/:id/commands', async (req, res, next) => {
  try {
    const thread = jobs.get(String(req.params.id));
    res.json({commands: await listCommands(thread.cwd, req.query.fresh === '1')});
  } catch (error) {
    next(error);
  }
});

app.get('/api/threads/:id/pull-requests', (req, res, next) => {
  try { res.json(pullRequests.list(jobs.get(String(req.params.id)))); } catch (error) { next(error); }
});
// The PR's live state and full diff, for the owner to review.
app.get('/api/threads/:id/pull-requests/:key/diff', async (req, res, next) => {
  try { res.json(await pullRequests.snapshot(jobs.get(String(req.params.id)), String(req.params.key))); } catch (error) { next(error); }
});
// The owner's sign-off on the exact revision they read.
app.post('/api/threads/:id/pull-requests/:key/reviewed', async (req, res, next) => {
  try { res.json(await pullRequests.markReviewed(jobs.get(String(req.params.id)), String(req.params.key), req.body ?? {})); } catch (error) { next(error); }
});
app.post('/api/threads/:id/pull-requests/:key/preview', async (req, res, next) => {
  try {
    const input = pullRequests.input(jobs.get(String(req.params.id)), String(req.params.key));
    res.json(await modules.preview('bitbucket-pull-requests', 'merge', input));
  } catch (error) { next(error); }
});
app.post('/api/threads/:id/pull-requests/:key/merge', (req, res, next) => {
  try {
    const input = pullRequests.input(jobs.get(String(req.params.id)), String(req.params.key));
    res.json(modules.run('bitbucket-pull-requests', 'merge', input, req.body?.token));
  } catch (error) { next(error); }
});

app.post('/api/threads/:id/context', async (req, res, next) => {
  try {
    const task = req.query.measure ? 'stats' : 'compact';
    const options = await runOptions({model: req.body?.model, thinking: req.body?.thinking});
    const live = await jobs.start(String(req.params.id), '', undefined, {...options, task});
    res.json({runId: live.runId, task});
  } catch (error) {
    next(error);
  }
});

/** Queues a message for a busy thread. Images arrive inline and are checked and saved like chat images. */
app.post('/api/threads/:id/queue', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    const content = readUserContent([...(text ? [{type: 'text', text}] : []), ...images]);
    const options = await runOptions({model: req.body?.model, thinking: req.body?.thinking});
    res.json(jobs.enqueue(String(req.params.id), content, options));
  } catch (error) {
    next(error);
  }
});

app.post('/api/threads/:id/queue/:item/remove', (req, res, next) => {
  try {
    jobs.removeQueued(String(req.params.id), String(req.params.item));
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

app.post('/api/threads/:id/queue/:item/send', async (req, res, next) => {
  try {
    res.json(await jobs.sendNow(String(req.params.id), String(req.params.item)));
  } catch (error) {
    next(error);
  }
});

app.post('/api/threads/:id/queue/release', (req, res, next) => {
  try {
    jobs.releaseQueue(String(req.params.id));
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

/**
 * A file shared in a thread. Pages and SVGs run in a CSP sandbox with an opaque origin, so they cannot
 * call the app's API or read its cookies. ?download=1 saves instead of previewing.
 */
app.get('/api/threads/:id/files/:file', (req, res, next) => {
  try {
    const file = jobs.sharedFile(String(req.params.id), String(req.params.file));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The app's own policy would block PDF viewers and a report's inline scripts; files get their own.
    res.setHeader(
      'Content-Security-Policy',
      ACTIVE_CONTENT.test(file.path)
        ? "sandbox allow-scripts allow-popups allow-downloads allow-forms; frame-ancestors 'self'"
        : "frame-ancestors 'self'",
    );
    if (req.query.download) res.attachment(file.name);
    res.sendFile(file.path, {dotfiles: 'allow', lastModified: true, cacheControl: false}, error => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

/** What the thread changed in a file, as a unified diff. ?context=all shows the whole file. */
app.get('/api/threads/:id/files/:file/diff', (req, res, next) => {
  try {
    const context = req.query.context === 'all' ? 100_000 : 4;
    res.json(jobs.fileDiff(String(req.params.id), String(req.params.file), context));
  } catch (error) {
    next(error);
  }
});

app.post('/api/threads/:id/files/:file/remove', (req, res, next) => {
  try {
    jobs.unshareFile(String(req.params.id), String(req.params.file));
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

/** Runs the thread's last message again on a Pi branch that leaves out the reply it got. */
app.post('/api/threads/:id/retry', async (req, res, next) => {
  try {
    res.json(await jobs.retry(String(req.params.id), {model: req.body?.model, thinking: req.body?.thinking}));
  } catch (error) {
    next(error);
  }
});

/** The owner has this thread open: its finished reply is no longer unread. */
app.post('/api/threads/:id/seen', (req, res, next) => {
  try {
    jobs.markSeen(String(req.params.id));
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

// Terminal: a shell on the desktop, off until the owner turns it on.

app.get('/api/terminal', (_req, res) => {
  res.json({
    enabled: terminals.enabled(),
    locked: process.env.MUSTER_TERMINAL_DISABLED === '1',
    sessions: terminals.list(),
    defaultCwd: workspaceRoots[0],
  });
});

app.post('/api/terminal/settings', (req, res, next) => {
  try {
    terminals.setEnabled(req.body?.enabled === true, ownerOf(req));
    res.json({enabled: terminals.enabled(), sessions: terminals.list()});
  } catch (error) {
    next(error);
  }
});

app.post('/api/terminal/sessions', (req, res, next) => {
  try {
    const cwd = canonicalCwd(typeof req.body?.cwd === 'string' && req.body.cwd ? req.body.cwd : workspaceRoots[0]);
    const session = terminals.create(cwd, ownerOf(req));
    res.json({id: session.id, cwd: session.cwd});
  } catch (error) {
    next(error);
  }
});

app.post('/api/terminal/sessions/:id/close', (req, res) => {
  terminals.kill(String(req.params.id));
  res.json({sessions: terminals.list()});
});

// Modules: integrations with their own settings and actions (Settings → Modules, the Actions panel).

app.get('/api/modules', (_req, res) => {
  res.json({modules: modules.list(), runs: modules.recentRuns()});
});

app.post('/api/modules/reload', (_req, res) => {
  modules.reload();
  res.json({modules: modules.list()});
});

app.post('/api/modules/:id/settings', (req, res, next) => {
  try {
    modules.save(String(req.params.id), req.body ?? {});
    res.json({modules: modules.list()});
  } catch (error) {
    next(error);
  }
});

app.post('/api/modules/:id/actions/:action/fields', async (req, res, next) => {
  try {
    res.json({fields: await modules.fields(String(req.params.id), String(req.params.action))});
  } catch (error) {
    next(error);
  }
});

app.post('/api/modules/:id/actions/:action/preview', async (req, res, next) => {
  try {
    const input = req.body?.input && typeof req.body.input === 'object' ? req.body.input : {};
    res.json(await modules.preview(String(req.params.id), String(req.params.action), input));
  } catch (error) {
    next(error);
  }
});

app.post('/api/modules/:id/actions/:action/run', (req, res, next) => {
  try {
    const input = req.body?.input && typeof req.body.input === 'object' ? req.body.input : {};
    res.json(modules.run(String(req.params.id), String(req.params.action), input, req.body?.token));
  } catch (error) {
    next(error);
  }
});

app.get('/api/modules/runs/:run', (req, res) => {
  const run = modules.runs.get(String(req.params.run));
  if (!run) {
    res.status(404).json({error: 'No such run.'});
    return;
  }
  res.json(run);
});

// Inbox: items from module feeds, such as Teams messages directed at the owner.
const inboxView = () => ({...modules.inbox(), ...triage.view()});

app.get('/api/inbox', (_req, res) => {
  res.json(inboxView());
});

app.post('/api/inbox/refresh', (_req, res) => {
  void modules.pollDue(true).then(() => triage.schedule(500));
  res.json(inboxView());
});

// Groups messages into requests again now, for messages that have not been grouped.
app.post('/api/inbox/regroup', (_req, res) => {
  triage.schedule(0);
  res.json(inboxView());
});

app.post('/api/inbox/mark', (req, res) => {
  modules.markInbox(req.body ?? {});
  res.json(inboxView());
});

app.post('/api/inbox/requests/:id', (req, res, next) => {
  try {
    triage.mark(String(req.params.id), req.body ?? {});
    res.json(inboxView());
  } catch (error) {
    next(error);
  }
});

app.post('/api/threads/:id/stop', (req, res) => {
  jobs.stop(String(req.params.id));
  res.json({ok: true});
});

app.post('/api/threads/:id/run', async (req, res, next) => {
  try {
    const live = await jobs.start(String(req.params.id), String(req.body?.prompt || ''));
    res.json({runId: live.runId});
  } catch (error) {
    next(error);
  }
});

app.get('/api/threads/:id/events', (req, res, next) => {
  let thread;
  try {
    thread = jobs.get(String(req.params.id));
  } catch (error) {
    next(error);
    return;
  }
  const owner = ownerOf(req);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  let sequence = Number(req.headers['last-event-id']) || 0;
  const write = (event: any) => {
    if (!auth.sessions.has(owner)) {
      res.end();
      return;
    }
    res.write(`id: ${++sequence}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  // Reconnects get the saved state, then live events from any run on this thread.
  write({type: 'snapshot', messages: thread.messages, run: thread.run, output: thread.output || ''});
  const bus = jobs.threadBus(thread.id);
  bus.on('event', write);
  const heartbeat = setInterval(() => {
    if (!auth.sessions.has(owner)) res.end();
    else res.write(': heartbeat\n\n');
  }, 10_000);
  const revoked = (id: string) => {
    if (id === owner) res.end();
  };
  auth.revokeListeners.add(revoked);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('event', write);
    auth.revokeListeners.delete(revoked);
  });
});

app.post('/api/browser/takeover', async (req, res, next) => {
  try {
    await takeover.begin(ownerOf(req));
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

app.post('/api/browser/release', (req, res, next) => {
  try {
    takeover.release(ownerOf(req));
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

const runtime = new CopilotRuntime({
  agents: {pi: new LocalPiAgent()},
  runner: new PersistedRunner(jobs, {maxThreads: 32, maxRunsPerThread: 8, maxBytes: 8_000_000}),
});
const copilotEndpoint = copilotRuntimeNodeHttpEndpoint({
  runtime,
  endpoint: '/api/copilotkit',
  logLevel: 'error',
  cors: {origin: (origin: string) => (allowedOrigins().includes(origin) ? origin : null), credentials: true},
});

app.use('/api/copilotkit', chatJson, (req, res, next) => {
  // Client-supplied tool servers, actions and cloud integrations are disabled.
  const serialized = JSON.stringify(req.body || {});
  if (/"(?:mcpServers|mcpEndpoints|remoteEndpoints|cloud)"\s*:/.test(serialized)) {
    res.status(400).json({error: 'External integrations are disabled'});
    return;
  }
  req.url = req.originalUrl;
  delete req.headers['x-forwarded-host'];
  Promise.resolve(copilotEndpoint(req, res)).catch(next);
});

// Pages are explicit routes. Static serving is limited to hashed build assets, so encoded paths
// such as /%76iewer.html cannot reach an HTML file around the sign-in check.
app.get(['/viewer', '/viewer.html'], (req, res) => {
  if (!auth.get(req)) {
    res.status(401).send('Sign in to view BrowserOS');
    return;
  }
  res.sendFile(path.join(DIST, 'viewer.html'), {dotfiles: 'allow'});
});
app.use('/assets', express.static(path.join(DIST, 'assets'), {index: false, etag: false, redirect: false}));
// The installable-app files. The service worker is always fetched fresh so updates reach installed apps.
app.use(
  '/icons',
  express.static(path.join(DIST, 'icons'), {
    index: false,
    redirect: false,
    setHeaders: res => res.setHeader('Cache-Control', 'public, max-age=86400'),
  }),
);
app.get(['/manifest.webmanifest', '/offline.html'], (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(DIST, req.path.slice(1)), {dotfiles: 'allow'});
});
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(DIST, 'sw.js'), {dotfiles: 'allow'});
});
app.get('/favicon.ico', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(DIST, 'icons', 'favicon.ico'), {dotfiles: 'allow'});
});
app.get(['/', '/index.html'], (_req, res) => {
  // Only the chat page may request a microphone. The viewer and file previews keep it disabled.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  // Always check for a newer page, so a reload (or reopening the installed app) picks up a new build.
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(DIST, 'index.html'), {dotfiles: 'allow'});
});
app.use((_req, res) => {
  res.status(404).json({error: 'Not found'});
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(error.status || 400).json({error: error.message || 'Request failed'});
});

// Loopback-only listener for the Pi browser tool. The tunnel forwards only the main port, and this
// listener also rejects proxied requests and any Host other than its own loopback address.

const internal = express();
internal.disable('x-powered-by');
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];
export const internalServer = createServer(internal);

internal.use((req, res, next) => {
  const port = (internalServer.address() as AddressInfo | null)?.port;
  const proxied = PROXY_HEADERS.some(header => req.headers[header] !== undefined);
  if (!isLoopbackAddress(req.socket.remoteAddress) || proxied || req.headers.host !== `127.0.0.1:${port}`) {
    res.status(403).json({error: 'Local agent access only'});
    return;
  }
  next();
});
internal.use(express.json({limit: '64kb'}));
// Called just before the agent writes or edits a file, to keep the version it is about to change.
internal.post('/internal/baseline', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const thread = token ? jobs.threadForToken(token) : undefined;
  if (!thread) {
    res.status(401).json({error: 'Invalid agent capability'});
    return;
  }
  try {
    jobs.saveBaseline(thread.id, String(req.body?.path || ''));
    res.json({ok: true});
  } catch (error: any) {
    // Files outside the folder, credentials and the like are simply not tracked.
    res.json({ok: false, reason: error.message});
  }
});

internal.post('/internal/share', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const thread = token ? jobs.threadForToken(token) : undefined;
  if (!thread) {
    res.status(401).json({error: 'Invalid agent capability'});
    return;
  }
  try {
    const entry = jobs.shareFile(thread.id, String(req.body?.path || ''), 'share');
    res.json({name: entry.name, size: entry.size});
  } catch (error: any) {
    res.status(400).json({error: error.message || 'Could not share the file'});
  }
});

// Module tools the agent calls, such as searching Teams. Read-only by convention; run in the module's process.
internal.post('/internal/module-tool', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const thread = token ? jobs.threadForToken(token) : undefined;
  if (!thread) {
    res.status(401).json({error: 'Invalid agent capability'});
    return;
  }
  try {
    const input = req.body?.input && typeof req.body.input === 'object' ? req.body.input : {};
    res.json({text: await modules.callTool(String(req.body?.name || ''), input, thread.id)});
  } catch (error: any) {
    res.status(400).json({error: error.message || 'The tool failed'});
  }
});

internal.post('/internal/browser', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token || !jobs.hasToken(token)) {
    res.status(401).json({error: 'Invalid agent capability'});
    return;
  }
  try {
    if (req.body?.action === 'request_help') {
      const thread = jobs.threadForToken(token);
      if (thread) jobs.markHelp(thread.id, typeof req.body.text === 'string' ? req.body.text : '');
    }
    res.json(await browserAction(req.body));
  } catch (error: any) {
    res.status(error.status || 400).json({error: error.message || 'Browser action failed'});
  }
});

// Main server

export const server = createServer(app);
const sockets = new WebSocketServer({noServer: true, maxPayload: 8192, perMessageDeflate: false});

const terminalSockets = new WebSocketServer({noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false});

server.on('upgrade', (req, socket, head) => {
  const session = auth.get(req);
  const terminal = /^\/api\/terminal\/stream\?id=([a-f0-9-]{36})$/.exec(req.url ?? '');
  if (terminal) {
    if (!session || !allowedHost(req) || !allowedOrigin(req, true) || !terminals.enabled()) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    terminalSockets.handleUpgrade(req, socket, head, ws => {
      terminals.attach(ws, terminal[1], session.id, () => !!auth.sessions.get(session.id) && auth.sessions.get(session.id)!.expires > Date.now());
    });
    return;
  }
  const allowed =
    req.url === '/api/browser/stream' &&
    allowedHost(req) &&
    allowedOrigin(req, true) &&
    session &&
    takeover.paused &&
    takeover.owner === session.id;
  if (!allowed) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, ws => {
    void viewerSocket(ws, session.id).catch(() => ws.close(1011, 'BrowserOS unavailable'));
  });
});

auth.revokeListeners.add(id => takeover.revoke(id));
auth.revokeListeners.add(id => terminals.revoke(id));

internalServer.listen(0, '127.0.0.1', () => {
  jobs.internalUrl = `http://127.0.0.1:${(internalServer.address() as AddressInfo).port}`;
  server.listen(PORT, '127.0.0.1', () => {
    if (process.env.MUSTER_INBOX_DISABLED !== '1') {
      modules.itemListeners.add(() => triage.schedule());
      modules.startInbox();
      // Messages that arrived while Muster was down, or before grouping existed.
      triage.schedule(20_000);
    }
    console.log(`Muster listening on http://127.0.0.1:${PORT}. Login credential: ${path.join(DATA, 'initial-password.txt')}`);
  });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    jobs.shutdown();
    for (const ws of sockets.clients) ws.close();
    internalServer.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
