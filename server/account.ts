import {randomBytes, scryptSync} from 'node:crypto';
import {chmodSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export function writePrivate(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, {mode: 0o600});
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Creates a new random owner password. Writes only its scrypt hash and the private password file. */
export function createAccount(dataDir: string) {
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  writePrivate(path.join(dataDir, 'auth.json'), JSON.stringify({salt, hash}, null, 2));
  writePrivate(path.join(dataDir, 'initial-password.txt'), password + '\n');
  return path.join(dataDir, 'initial-password.txt');
}
