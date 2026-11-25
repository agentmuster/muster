import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendDictation, Dictation, type DictationState, type Recognition} from '../web/dictation.js';

class FakeRecognition implements Recognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  onstart: Recognition['onstart'] = null;
  onend: Recognition['onend'] = null;
  onresult: Recognition['onresult'] = null;
  onerror: Recognition['onerror'] = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() { this.started++; }
  stop() { this.stopped++; }
  abort() { this.aborted++; }
  result(parts: [string, boolean][]) {
    this.onresult?.({resultIndex: 0, results: parts.map(([transcript, isFinal]) => ({isFinal, 0: {transcript}}))});
  }
}

function setup(Constructor = FakeRecognition) {
  let draft = 'Please check';
  const changes: DictationState[] = [];
  const voice = new Dictation(Constructor, words => { draft = appendDictation(draft, words); }, state => changes.push(state), 'en-GB');
  return {voice, changes, draft: () => draft, edit: (value: string) => { draft = value; }};
}

test('dictation starts only on request, shows interim words separately and appends final words once', () => {
  const {voice, draft, edit} = setup();
  assert.equal(voice.state.phase, 'idle');
  voice.start();
  const rec = FakeRecognition.instances.at(-1)!;
  assert.equal(rec.started, 1);
  assert.equal(rec.lang, 'en-GB');
  assert.equal(rec.continuous, true);
  assert.equal(rec.interimResults, true);
  voice.start();
  assert.equal(rec.started, 1, 'no double start');
  rec.onstart?.();
  rec.result([['the logs', false]]);
  assert.equal(draft(), 'Please check');
  assert.equal(voice.state.interim, 'the logs');
  edit('Please check today');
  rec.result([['the logs', true], ['and', false]]);
  assert.equal(draft(), 'Please check today the logs');
  rec.result([['the logs', true], ['and deployment', true]]);
  assert.equal(draft(), 'Please check today the logs and deployment');
  rec.result([['the logs', true], ['and deployment', true]]);
  assert.equal(draft(), 'Please check today the logs and deployment', 'repeated results are not duplicated');
  assert.equal(voice.state.interim, '');
});

test('stop lets final words arrive, and a later session starts with fresh result indexes', () => {
  const {voice, draft} = setup();
  voice.start();
  const rec = FakeRecognition.instances.at(-1)!;
  rec.onstart?.();
  voice.stop();
  assert.equal(voice.state.phase, 'stopping');
  assert.equal(rec.stopped, 1);
  rec.result([['the report', true]]);
  rec.onend?.();
  assert.equal(voice.state.phase, 'idle');
  assert.equal(draft(), 'Please check the report');
  voice.start();
  const next = FakeRecognition.instances.at(-1)!;
  next.result([['tomorrow', true]]);
  next.onend?.();
  assert.equal(draft(), 'Please check the report tomorrow');
});

test('cancel and disposal release the microphone and ignore late results', () => {
  const {voice, draft, changes} = setup();
  voice.start();
  const rec = FakeRecognition.instances.at(-1)!;
  const late = rec.onresult!;
  voice.cancel();
  assert.equal(rec.aborted, 1);
  late({resultIndex: 0, results: [{isFinal: true, 0: {transcript: 'do not insert'}}]});
  assert.equal(draft(), 'Please check');
  voice.start();
  const next = FakeRecognition.instances.at(-1)!;
  const before = changes.length;
  voice.dispose();
  assert.equal(next.aborted, 1);
  assert.equal(changes.length, before, 'no React update after unmount');
  voice.start();
  assert.equal(next.started, 1);
});

test('unsupported browsers, permission denial, network errors and start failures keep the draft', () => {
  const unsupported = new Dictation(undefined, () => assert.fail('unexpected transcript'), () => {});
  unsupported.start();
  assert.match(unsupported.state.error, /not supported/);
  const {voice, draft} = setup();
  for (const error of ['not-allowed', 'network', 'audio-capture', 'no-speech']) {
    voice.start();
    const rec = FakeRecognition.instances.at(-1)!;
    rec.onerror?.({error});
    assert.equal(voice.state.phase, 'idle');
    assert.ok(voice.state.error);
    assert.equal(rec.aborted, 1);
    assert.equal(draft(), 'Please check');
  }
  class Broken extends FakeRecognition {
    start() { throw new Error('blocked'); }
  }
  const failed = setup(Broken).voice;
  failed.start();
  assert.equal(failed.state.phase, 'idle');
  assert.match(failed.state.error, /could not start/);
});

test('appending speech preserves whitespace and empty results do not change the draft', () => {
  assert.equal(appendDictation('', 'hello'), 'hello');
  assert.equal(appendDictation('hello\n', 'world'), 'hello\nworld');
  assert.equal(appendDictation('hello', '  world  '), 'hello world');
  assert.equal(appendDictation('hello', ''), 'hello');
});
