// Replaces the owner password. Saved sign-ins are tied to the old password and stop working once the app restarts.
import {existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {createAccount} from '../server/account.js';
import {defaultDataDir} from '../server/env.js';

process.umask(0o077);
if (existsSync('.env')) process.loadEnvFile('.env');
const data = path.resolve(process.env.MUSTER_DATA_DIR || process.env.META_DATA_DIR || defaultDataDir(process.env));
mkdirSync(data, {recursive: true, mode: 0o700});
const file = createAccount(data);
console.log(`New owner password written to ${file} (mode 600).`);
console.log('Restart the app to apply it and sign out every existing session.');
