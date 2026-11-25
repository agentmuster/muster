import {spawn} from 'node:child_process';
import {PI_BIN} from './pi-config.js';
import {piSetup} from './jobs.js';

// The slash commands a thread's Pi accepts: extension commands, prompt templates and skills. They depend on the
// folder (project prompts and skills), so each folder is asked once and cached for a while.

export type SlashCommand = {name: string; description: string; source: string};

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, {at: number; commands: Promise<SlashCommand[]>}>();

function ask(cwd: string): Promise<SlashCommand[]> {
  const {args, env} = piSetup();
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, ['--mode', 'rpc', '--no-session', ...args], {
      cwd,
      env: {...process.env, ...env},
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = '';
    const done = (error?: Error, commands?: SlashCommand[]) => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(commands!);
    };
    const timer = setTimeout(() => done(new Error('Pi did not list its commands in time.')), 60_000);
    child.on('error', error => done(error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.type !== 'response' || record.command !== 'get_commands') continue;
        if (record.success === false) return done(new Error(String(record.error || 'Pi could not list its commands.')));
        const list: SlashCommand[] = (record.data?.commands ?? [])
          .filter((c: any) => typeof c?.name === 'string' && /^[\w:.\-/]{1,80}$/.test(c.name))
          .map((c: any) => ({name: c.name, description: String(c.description ?? '').slice(0, 300), source: String(c.source ?? '')}));
        return done(undefined, list);
      }
    });
    child.stdin.write(JSON.stringify({id: 'commands', type: 'get_commands'}) + '\n');
  });
}

/** Commands for a folder, from cache when fresh. A failed lookup is not cached. */
export function listCommands(cwd: string, fresh = false) {
  const hit = cache.get(cwd);
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.commands;
  const commands = ask(cwd);
  cache.set(cwd, {at: Date.now(), commands});
  commands.catch(() => cache.delete(cwd));
  return commands;
}
