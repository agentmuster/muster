#!/usr/bin/env node
// Command-line access to the same session memory, for agents without the Pi extension
// (Claude Code, Codex). Usage:
//   session-memory search "<words>" [--limit N]
//   session-memory recent [--engine pi|claude|codex] [--contains TEXT] [--limit N]
//   session-memory read <id> ["<what to look for>"]
import {read, recent, search} from '../core.mjs';

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const words = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else words.push(rest[i]);
}
const limit = flags.limit ? Number(flags.limit) : undefined;

try {
  if (command === 'search' && words.length) console.log(await search(words.join(' '), {limit}));
  else if (command === 'recent') console.log(await recent({engine: flags.engine, contains: flags.contains, limit}));
  else if (command === 'read' && words[0]) console.log(await read(words[0], words.slice(1).join(' ')));
  else {
    console.error('Usage: session-memory search "<words>" | recent [--engine E] [--contains T] | read <id> ["<query>"]');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
