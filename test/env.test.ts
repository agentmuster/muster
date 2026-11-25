import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {adoptLegacyEnv, defaultDataDir} from '../server/env.js';

test('settings from before the rename keep working under their MUSTER_ names', () => {
  const env: NodeJS.ProcessEnv = {META_DATA_DIR: '/old', META_ALLOWED_HOSTS: 'a:1', MUSTER_ALLOWED_HOSTS: 'b:2', OTHER: 'x'};
  adoptLegacyEnv(env);
  assert.equal(env.MUSTER_DATA_DIR, '/old');
  assert.equal(env.MUSTER_ALLOWED_HOSTS, 'b:2', 'a new name already set wins');
  assert.equal(env.MUSTER_OTHER, undefined);
});

test('an existing old data folder is kept until a new one exists', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'muster-home-'));
  try {
    const current = path.join(home, '.local/share/muster');
    const legacy = path.join(home, '.local/share/meta-agent');
    assert.equal(defaultDataDir({}, home), current, 'a fresh install uses the new folder');
    mkdirSync(legacy, {recursive: true});
    assert.equal(defaultDataDir({}, home), legacy, 'an older install keeps its data');
    mkdirSync(current, {recursive: true});
    assert.equal(defaultDataDir({}, home), current);
    assert.equal(defaultDataDir({MUSTER_DATA_DIR: '/custom'}, home), '/custom');
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});
