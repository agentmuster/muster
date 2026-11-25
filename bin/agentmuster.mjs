#!/usr/bin/env node
// The agentmuster command. Runs Muster's TypeScript entry points with tsx from Muster's own dependencies.
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const result = spawnSync(process.execPath, ['--import', tsx, path.join(root, 'server/cli.ts'), ...process.argv.slice(2)], {stdio: 'inherit'});
process.exit(result.status ?? 1);
