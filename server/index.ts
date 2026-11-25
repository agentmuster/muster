import {existsSync} from 'node:fs';

process.umask(0o077);
try {
  if (existsSync('.env')) process.loadEnvFile('.env');
} catch {
  // A malformed .env falls back to the process environment.
}
// Older installs set META_* names; they keep working as MUSTER_*.
const {adoptLegacyEnv} = await import('./env.js');
adoptLegacyEnv();
process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
process.env.DO_NOT_TRACK = '1';
// Dynamic import ensures telemetry settings are in place before runtime initialization.
await import('./app.js');
