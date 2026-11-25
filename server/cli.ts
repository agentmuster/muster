// agentmuster module …: list, browse, install, update, roll back and remove modules from a terminal. It changes the
// same files the app does; a running Muster notices the change the next time the module list is read.
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
process.umask(0o077);
try {
  if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // A malformed .env falls back to the process environment.
}
const {adoptLegacyEnv} = await import('./env.js');
adoptLegacyEnv();
const {DATA} = await import('./security.js');
const {MODULES_HOME, modules} = await import('./modules.js');
const {ModuleInstaller, OFFICIAL_REGISTRY} = await import('./module-install.js');

const installer = new ModuleInstaller(
  modules,
  MODULES_HOME,
  path.join(DATA, 'modules'),
  (process.env.MUSTER_MODULE_REGISTRIES || OFFICIAL_REGISTRY).split(',').map(url => url.trim().replace(/\/+$/, '')).filter(Boolean),
);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf('--' + name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, value && !value.startsWith('--') ? 2 : 1);
  return value && !value.startsWith('--') ? value : '';
};
const yes = flag('yes') !== undefined;
const refresh = flag('refresh') !== undefined;
const git = flag('git');
const folder = flag('folder');
const sub = flag('path');
const ref = flag('ref');
const [group, command, target] = args;

const USAGE = `Usage:
  agentmuster module list
  agentmuster module browse [--refresh]
  agentmuster module add <id> [--yes]                 from the module repository
  agentmuster module add --git <https-url> [--path <folder-in-repo>] [--ref <branch-or-tag>] [--yes]
  agentmuster module add --folder </absolute/path> [--yes]
  agentmuster module update <id> [--yes]
  agentmuster module rollback <id>
  agentmuster module remove <id> [--yes]`;

async function ask(question: string) {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('Add --yes to confirm when not running in a terminal.');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  const answer = await rl.question(question + ' [y/N] ');
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function review(request: Record<string, unknown>) {
  const preview = await installer.preview(request);
  console.log(`\n${preview.update ? 'Update' : 'Install'} ${preview.name} ${preview.version}${preview.update ? ` (from ${preview.update.from})` : ''}`);
  console.log(`From ${preview.source}${preview.reviewed ? ' · official' : ' · NOT REVIEWED'}`);
  const labels: Record<string, string> = {
    network: 'Websites',
    connectors: 'Accounts on this desktop',
    secrets: 'Secrets',
    tools: 'Agent tools',
    feeds: 'Inbox feeds',
    actions: 'Actions',
    providers: 'Provides',
  };
  for (const [key, label] of Object.entries(labels)) {
    const items = (preview.permissions as Record<string, string[]>)[key];
    if (!items.length) continue;
    const added = (preview.update?.added as Record<string, string[]> | undefined)?.[key] ?? [];
    console.log(`  ${label}: ${items.map(item => (added.includes(item) ? `${item} (new)` : item)).join(', ')}`);
  }
  if (preview.dependencies.length) console.log(`  npm packages (install scripts off): ${preview.dependencies.join(', ')}`);
  if (!(await ask(`${preview.update ? 'Update' : 'Install'} it?`))) return console.log('Nothing changed.');
  const done = await installer.install(preview.token);
  const on = modules.enabled(done.id);
  console.log(`${done.updated ? 'Updated' : 'Installed'} ${done.id} ${done.version}. ${on ? 'It is on, with its saved settings.' : 'Turn it on in Muster under ⋮ → Modules.'}`);
}

try {
  if (group !== 'module' || !command) {
    console.log(USAGE);
    process.exit(group ? 1 : 0);
  }
  installer.ensureSdkLink();
  const registry = installer.registryUrls[0];
  if (command === 'list') {
    const lock = installer.lock();
    const list = modules.list();
    if (!list.length) console.log('No modules installed.');
    for (const module of list) {
      const info = installer.info(module.id);
      console.log(`${module.id} ${module.version} ${module.enabled ? 'on' : 'off'}${info ? ` · ${info.source}` : ' · added by hand'}${lock[module.id]?.previous ? ` · can roll back to ${lock[module.id].previous!.version}` : ''}`);
    }
  } else if (command === 'browse') {
    const data = await installer.browse(refresh);
    for (const r of data.registries) {
      console.log(`${r.url}${r.official ? ' (official)' : ''}${r.error ? ` · error: ${r.error}` : ''}`);
      for (const m of r.modules) {
        const state = m.installed ? (m.updateAvailable ? `installed ${m.installed.version}, update to ${m.version}` : 'installed') : m.version;
        console.log(`  ${m.id.padEnd(28)} ${state.padEnd(30)} ${m.description}`);
      }
    }
  } else if (command === 'add' || command === 'update') {
    if (git !== undefined) await review({git, path: sub, ref});
    else if (folder !== undefined) await review({folder: path.resolve(folder)});
    else if (target) await review({registry, id: target, refresh: true});
    else throw new Error('Name a module, or give --git or --folder.');
  } else if (command === 'rollback' && target) {
    const done = await installer.rollback(target);
    console.log(`${done.id} is back to ${done.version}.`);
  } else if (command === 'remove' && target) {
    if (await ask(`Remove ${target}, its settings and its saved secrets?`)) {
      await installer.remove(target);
      console.log(`Removed ${target}.`);
    } else console.log('Nothing changed.');
  } else {
    console.log(USAGE);
    process.exit(1);
  }
  process.exit(0);
} catch (error: any) {
  console.error(error.message);
  process.exit(1);
}
