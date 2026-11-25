import {execFileSync} from 'node:child_process';

// Pi's bash tool starts each command in its own process group, so signalling Pi's group alone
// misses them. These helpers walk the parent/child table from the Pi process instead.

type Row = {pid: number; ppid: number; pgid: number};

function table(): Row[] {
  const output = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], {encoding: 'utf8'});
  return output
    .trim()
    .split('\n')
    .map(line => line.trim().split(/\s+/).map(Number))
    .filter(parts => parts.length === 3 && parts.every(Number.isFinite))
    .map(([pid, ppid, pgid]) => ({pid, ppid, pgid}));
}

let ownGroup: number | undefined;
function serverGroup(rows: Row[]) {
  ownGroup ??= rows.find(row => row.pid === process.pid)?.pgid;
  return ownGroup;
}

/** Process groups of rootPid and every descendant still parented beneath it. */
export function treeGroups(rootPid: number): number[] {
  const rows = table();
  const children = new Map<number, Row[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) || []), row]);
  const groups = new Set<number>();
  const root = rows.find(row => row.pid === rootPid);
  if (!root) return [];
  const queue = [root];
  while (queue.length) {
    const row = queue.shift()!;
    groups.add(row.pgid);
    queue.push(...(children.get(row.pid) || []));
  }
  const own = serverGroup(rows);
  return [...groups].filter(group => group > 1 && group !== own);
}

function signalGroups(groups: Iterable<number>, signal: NodeJS.Signals) {
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch {
      // The group already exited.
    }
  }
}

/**
 * Signals the whole tree. Walks twice so a child spawned between the first walk and the first
 * SIGSTOP is still caught. Returns every group that was signalled.
 */
export function signalTree(rootPid: number, signal: NodeJS.Signals, known: number[] = []) {
  const groups = new Set(known);
  for (let pass = 0; pass < 2; pass++) {
    for (const group of treeGroups(rootPid)) groups.add(group);
    signalGroups(groups, signal);
  }
  return [...groups];
}

export function groupAlive(group: number) {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error: any) {
    return error.code === 'EPERM';
  }
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === 'EPERM';
  }
}

export function commandLine(pid: number) {
  try {
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {encoding: 'utf8'}).trim();
  } catch {
    return '';
  }
}

/** SIGTERM the tree (continuing stopped processes so they can exit), then SIGKILL survivors. */
export function killTree(rootPid: number, known: number[] = [], graceMs = 3000) {
  const groups = signalTree(rootPid, 'SIGTERM', known);
  signalGroups(groups, 'SIGCONT');
  setTimeout(() => signalGroups(groups.filter(groupAlive), 'SIGKILL'), graceMs).unref();
  return groups;
}
