import {closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {processAlive} from './process-tree.js';

// Background work a thread's Pi started: async subagents (pi-subagents) and background workflows
// (pi-dynamic-workflows). Both keep run records on disk, keyed by the Pi session that launched them, so
// Muster reads those records instead of asking Pi. Subagents run in their own processes; workflows run
// inside the Pi process, so they stop when it does.

export type BackgroundItem = {
  kind: 'subagent' | 'workflow';
  id: string;
  title: string;
  task?: string;
  state: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';
  active: boolean;
  started?: number;
  ended?: number;
  tokens?: number;
  cost?: number;
  progress?: string;
  phase?: string;
  labels?: string[];
};
export type PiSession = {id?: string; file?: string};

const uid = typeof process.getuid === 'function' ? `uid-${process.getuid()}` : 'uid-0';
export const SUBAGENT_RUNS = process.env.MUSTER_SUBAGENT_RUNS || path.join(os.tmpdir(), `pi-subagents-${uid}`, 'async-subagent-runs');
export const WORKFLOW_PROJECTS = process.env.MUSTER_WORKFLOW_PROJECTS || path.join(os.homedir(), '.pi', 'workflows', 'projects');
/** Records older than this are history, not this session's current work. */
const WINDOW_MS = 24 * 60 * 60_000;
const TAIL_BYTES = 24_000;

function readJson(file: string) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const time = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || undefined : undefined);

function subagentState(raw: unknown, pid: unknown): BackgroundItem['state'] {
  const state = String(raw ?? '').toLowerCase();
  if (state === 'queued' || state === 'pending') return 'queued';
  if (state === 'running' || state === 'starting') {
    // A runner that died without writing its end state is not running.
    return typeof pid === 'number' && !processAlive(pid) ? 'stopped' : 'running';
  }
  if (state === 'paused' || state === 'needs_attention' || state === 'attention') return 'paused';
  if (state === 'complete' || state === 'completed' || state === 'succeeded' || state === 'done') return 'done';
  if (state === 'failed' || state === 'error') return 'failed';
  return 'stopped';
}

function workflowState(raw: unknown, piAlive: boolean): BackgroundItem['state'] {
  const state = String(raw ?? '').toLowerCase();
  if (state === 'completed' || state === 'done') return 'done';
  if (state === 'failed' || state === 'error') return 'failed';
  if (state === 'stopped' || state === 'cancelled') return 'stopped';
  // Workflows live inside Pi: without a live Pi, a "running" record was interrupted.
  if (!piAlive) return state === 'paused' ? 'paused' : 'stopped';
  if (state === 'queued') return 'queued';
  if (state === 'paused') return 'paused';
  return 'running';
}

const ACTIVE = new Set<BackgroundItem['state']>(['queued', 'running', 'paused']);

function recentEntries(dir: string, since: number) {
  try {
    return readdirSync(dir)
      .map(name => {
        try {
          return {name, mtime: statSync(path.join(dir, name)).mtimeMs};
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is {name: string; mtime: number} => !!entry && entry.mtime >= since);
  } catch {
    return [];
  }
}

function subagents(session: PiSession, since: number): BackgroundItem[] {
  const items: BackgroundItem[] = [];
  for (const {name} of recentEntries(SUBAGENT_RUNS, since)) {
    const status = readJson(path.join(SUBAGENT_RUNS, name, 'status.json'));
    if (!status || (status.sessionId !== session.file && status.sessionId !== session.id)) continue;
    const steps: any[] = Array.isArray(status.steps) ? status.steps : [];
    const agents = steps.map(step => String(step?.agent ?? '')).filter(Boolean);
    const state = subagentState(status.state, status.pid);
    const task = steps.map(step => step?.description ?? step?.task).find(value => typeof value === 'string');
    items.push({
      kind: 'subagent',
      id: String(status.runId ?? name),
      title: agents.length ? agents.join(status.mode === 'parallel' ? ' + ' : ' → ') : 'subagent',
      task: typeof task === 'string' ? task.slice(0, 400) : undefined,
      state,
      active: ACTIVE.has(state),
      started: time(status.startedAt),
      ended: time(status.endedAt),
      tokens: typeof status.totalTokens?.total === 'number' ? status.totalTokens.total : undefined,
      cost: typeof status.totalCost?.costUsd === 'number' ? status.totalCost.costUsd : undefined,
      progress: steps.length > 1 ? `${steps.filter(step => /complete|done|success/i.test(String(step?.status))).length}/${steps.length} steps` : undefined,
    });
  }
  return items;
}

function workflows(session: PiSession, since: number, piAlive: boolean): BackgroundItem[] {
  const items: BackgroundItem[] = [];
  let projects: string[] = [];
  try {
    projects = readdirSync(WORKFLOW_PROJECTS);
  } catch {
    return items;
  }
  for (const project of projects) {
    const runs = path.join(WORKFLOW_PROJECTS, project, 'runs');
    for (const {name} of recentEntries(runs, since)) {
      if (!name.endsWith('.json')) continue;
      const record = readJson(path.join(runs, name));
      const index = record?.index;
      if (!index || (index.sessionId !== session.id && index.parentSessionFile !== session.file)) continue;
      const summary = record.summary ?? {};
      const state = workflowState(index.status, piAlive);
      items.push({
        kind: 'workflow',
        id: String(index.runId ?? name.replace(/\.json$/, '')),
        title: String(index.workflowName ?? 'workflow'),
        state,
        active: ACTIVE.has(state),
        started: time(index.startedAt),
        ended: time(index.completedAt),
        tokens: typeof index.tokenUsage?.total === 'number' ? index.tokenUsage.total : undefined,
        cost: typeof index.tokenUsage?.cost === 'number' ? index.tokenUsage.cost : undefined,
        progress: typeof summary.total === 'number' && summary.total ? `${summary.done ?? 0}/${summary.total} agents` : undefined,
        phase: typeof index.currentPhase === 'string' ? index.currentPhase : undefined,
        labels: Array.isArray(summary.activeLabels) ? summary.activeLabels.map(String).slice(0, 8) : undefined,
      });
    }
  }
  return items;
}

/** Work this Pi session launched in the last day, newest first. */
export function scanBackground(session: PiSession | undefined, piAlive: boolean, now = Date.now()): BackgroundItem[] {
  if (!session || (!session.id && !session.file)) return [];
  const since = now - WINDOW_MS;
  return [...subagents(session, since), ...workflows(session, since, piAlive)].sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
}

/** The last part of a text file, for following a run's output. */
function tail(file: string) {
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString('utf8');
    return size > length ? '…' + text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  }
}

const SAFE_ID = /^[\w.-]{1,200}$/;

/** One run's record and the end of its output, if it belongs to this session. */
export function backgroundDetail(session: PiSession | undefined, piAlive: boolean, kind: string, id: string) {
  if (!SAFE_ID.test(id)) return undefined;
  const item = scanBackground(session, piAlive).find(entry => entry.kind === kind && entry.id === id);
  if (!item) return undefined;
  let output = '';
  let steps: {agent: string; status: string}[] | undefined;
  if (kind === 'subagent') {
    const dir = path.join(SUBAGENT_RUNS, id);
    const status = readJson(path.join(dir, 'status.json')) ?? {};
    steps = (Array.isArray(status.steps) ? status.steps : []).map((step: any) => ({agent: String(step?.agent ?? ''), status: String(step?.status ?? '')}));
    // Only files inside the run's own folder are read.
    const candidates = [status.outputFile, path.join(dir, 'output-0.log')].filter((file): file is string => typeof file === 'string');
    const file = candidates.find(candidate => path.resolve(candidate).startsWith(dir + path.sep) && existsSync(candidate));
    if (file) output = tail(file);
  } else {
    for (const project of readdirSync(WORKFLOW_PROJECTS)) {
      const log = path.join(WORKFLOW_PROJECTS, project, 'runs', id + '.log');
      if (existsSync(log)) {
        output = tail(log);
        break;
      }
    }
  }
  return {...item, steps, output};
}
