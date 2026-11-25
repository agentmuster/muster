#!/usr/bin/env node
// The agentmuster command. Service commands (start, stop, restart, status, logs, update, uninstall) are handled
// here; everything else runs Muster's TypeScript CLI with tsx from Muster's own dependencies.
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync, unlinkSync, lstatSync, readlinkSync} from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const [command, ...rest] = process.argv.slice(2);
const home = os.homedir();
const label = 'io.agentmuster.muster';
const plist = path.join(home, 'Library/LaunchAgents', label + '.plist');
const unit = path.join(home, '.config/systemd/user/muster.service');
const mac = process.platform === 'darwin';
const domain = mac ? `gui/${process.getuid()}` : '';

const USAGE = `Usage:
  agentmuster start        run Muster in this terminal (when it isn't installed as a service)
  agentmuster stop         stop the Muster service
  agentmuster restart      restart the Muster service; running replies stop and can be resumed
  agentmuster status       is the service running, and where it answers
  agentmuster logs         follow Muster's log
  agentmuster update       fetch the latest Muster, rebuild and restart
  agentmuster uninstall    remove the service and this command; keeps the app folder and your data
  agentmuster module …     list, install, update and remove modules (agentmuster module help)`;

function run(file, args, options = {}) {
  return spawnSync(file, args, {stdio: 'inherit', ...options}).status ?? 1;
}

function envValue(name) {
  try {
    const line = readFileSync(path.join(root, '.env'), 'utf8').split('\n').findLast(row => row.startsWith(name + '='));
    return line?.slice(name.length + 1).trim() || undefined;
  } catch {
    return undefined;
  }
}

function dataDir() {
  if (process.env.MUSTER_DATA_DIR) return path.resolve(process.env.MUSTER_DATA_DIR);
  const current = path.join(home, '.local/share/muster');
  const legacy = path.join(home, '.local/share/meta-agent');
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

function serviceKind() {
  if (mac && existsSync(plist)) return 'launchd';
  if (!mac && existsSync(unit)) return 'systemd';
  return undefined;
}

function needService() {
  const kind = serviceKind();
  if (!kind) {
    console.error('Muster isn\'t installed as a service. Use "agentmuster start", or install with https://agentmuster.io/install.sh');
    process.exit(1);
  }
  return kind;
}

const port = envValue('PORT') || process.env.PORT || '47831';
const url = `http://127.0.0.1:${port}`;

switch (command) {
  case 'start':
    process.exit(run(process.execPath, ['--import', tsx, path.join(root, 'server/index.ts')], {cwd: root}));
  case 'stop':
    if (needService() === 'launchd') process.exit(run('launchctl', ['bootout', `${domain}/${label}`]));
    process.exit(run('systemctl', ['--user', 'stop', 'muster']));
  case 'restart':
    if (needService() === 'launchd') {
      const loaded = spawnSync('launchctl', ['print', `${domain}/${label}`], {stdio: 'ignore'}).status === 0;
      process.exit(loaded ? run('launchctl', ['kickstart', '-k', `${domain}/${label}`]) : run('launchctl', ['bootstrap', domain, plist]));
    }
    process.exit(run('systemctl', ['--user', 'restart', 'muster']));
  case 'status': {
    const kind = serviceKind();
    let answering = false;
    try {
      answering = (await fetch(url + '/api/health', {signal: AbortSignal.timeout(2000)})).ok;
    } catch {}
    console.log(`App folder   ${root}`);
    console.log(`Data folder  ${dataDir()}`);
    console.log(`Service      ${kind ? (kind === 'launchd' ? label : 'muster (systemd user service)') : 'not installed'}`);
    console.log(`Address      ${url} ${answering ? '(answering)' : '(not answering)'}`);
    process.exit(answering ? 0 : 1);
  }
  case 'logs':
    process.exit(run('tail', ['-n', '50', '-f', path.join(dataDir(), 'logs/app.log')]));
  case 'update':
    process.exit(run('bash', [path.join(root, 'install.sh')], {env: {...process.env, MUSTER_DIR: root, MUSTER_SERVICE: serviceKind() ? '1' : '0'}}));
  case 'uninstall': {
    const kind = serviceKind();
    if (kind === 'launchd') {
      spawnSync('launchctl', ['bootout', `${domain}/${label}`], {stdio: 'ignore'});
      unlinkSync(plist);
    } else if (kind === 'systemd') {
      spawnSync('systemctl', ['--user', 'disable', '--now', 'muster'], {stdio: 'ignore'});
      unlinkSync(unit);
      spawnSync('systemctl', ['--user', 'daemon-reload'], {stdio: 'ignore'});
    }
    const link = path.join(process.env.MUSTER_BIN_DIR || path.join(home, '.local/bin'), 'agentmuster');
    try {
      if (lstatSync(link).isSymbolicLink() && path.resolve(path.dirname(link), readlinkSync(link)).startsWith(root)) rmSync(link);
    } catch {}
    console.log(`Removed the service and the agentmuster command.
Kept the app in ${root} and your threads, index and settings in ${dataDir()}. Delete them with:
  rm -rf ${JSON.stringify(root)} ${JSON.stringify(dataDir())}`);
    process.exit(0);
  }
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    console.log(USAGE);
    process.exit(0);
  default: {
    const result = spawnSync(process.execPath, ['--import', tsx, path.join(root, 'server/cli.ts'), command, ...rest], {stdio: 'inherit'});
    process.exit(result.status ?? 1);
  }
}
