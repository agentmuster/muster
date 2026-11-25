import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MUSTER_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'muster-dialogs-'));
const {Dialogs, describeDialog} = await import('../server/browser.js');

/** Stands in for the BrowserOS connection: records commands, and Page.enable hangs on "frozen" tabs. */
function fakeCdp(frozen = new Set<string>()) {
  const sent: any[] = [];
  let next = 0;
  const cdp: any = {
    listeners: new Set<(message: any) => void>(),
    sent,
    emit: (message: any) => cdp.listeners.forEach((listener: any) => listener(message)),
    async send(method: string, params: any = {}, sessionId?: string) {
      sent.push({method, params, sessionId});
      if (method === 'Target.attachToTarget') return {sessionId: `s${++next}:${params.targetId}`};
      if (method === 'Page.enable' && frozen.has(String(sessionId).split(':')[1])) throw new Error('BrowserOS command timed out');
      return {};
    },
    async detach(sessionId: string) {
      sent.push({method: 'detach', sessionId});
    },
    async tabs() {
      return [];
    },
  };
  return cdp;
}

test('a dialog on a watched tab is recorded and answered through the session that saw it', async () => {
  const cdp = fakeCdp();
  const dialogs = new Dialogs(cdp);
  const seen: any[] = [];
  dialogs.listeners.add((target, dialog) => seen.push([target, dialog?.type ?? null]));
  assert.equal(await dialogs.watch('tab1'), true);
  assert.equal(await dialogs.watch('tab1'), true);
  assert.equal(cdp.sent.filter((c: any) => c.method === 'Target.attachToTarget').length, 1, 'one listening session per tab');
  const session = cdp.sent.find((c: any) => c.method === 'Page.enable').sessionId;

  cdp.emit({method: 'Page.javascriptDialogOpening', sessionId: session, params: {type: 'confirm', message: 'Delete it?', url: 'https://x'}});
  assert.equal(dialogs.dialog('tab1')?.message, 'Delete it?');
  assert.match(describeDialog(dialogs.dialog('tab1')!), /a confirm dialog: "Delete it\?"/);
  // Events on other sessions (the viewer's, a one-off agent session) are ignored.
  cdp.emit({method: 'Page.javascriptDialogClosed', sessionId: 'other', params: {}});
  assert.ok(dialogs.dialog('tab1'));

  await dialogs.answer('tab1', false);
  const handled = cdp.sent.find((c: any) => c.method === 'Page.handleJavaScriptDialog');
  assert.deepEqual(handled, {method: 'Page.handleJavaScriptDialog', params: {accept: false}, sessionId: session});
  assert.equal(dialogs.dialog('tab1'), undefined);
  await assert.rejects(dialogs.answer('tab1', true), /not showing a dialog/);
  assert.deepEqual(seen, [['tab1', 'confirm'], ['tab1', null]]);

  // A prompt gets the typed answer; an alert or confirm ignores text.
  cdp.emit({method: 'Page.javascriptDialogOpening', sessionId: session, params: {type: 'prompt', message: 'Name?', defaultPrompt: 'Copy'}});
  await dialogs.answer('tab1', true, 'Alex');
  assert.deepEqual(cdp.sent.at(-1).params, {accept: true, promptText: 'Alex'});
  cdp.emit({method: 'Page.javascriptDialogOpening', sessionId: session, params: {type: 'alert', message: 'Saved'}});
  assert.equal(describeDialog(dialogs.dialog('tab1')!), 'The page is showing an alert dialog: "Saved".');
  await dialogs.answer('tab1', true, 'ignored');
  assert.deepEqual(cdp.sent.at(-1).params, {accept: true});
});

test('a tab already frozen before watching is reported as stuck; closed tabs and disconnects are forgotten', async () => {
  const cdp = fakeCdp(new Set(['frozen']));
  const dialogs = new Dialogs(cdp);
  assert.equal(await dialogs.watch('frozen'), false);
  assert.ok(dialogs.stuck.has('frozen'));
  assert.ok(cdp.sent.some((c: any) => c.method === 'detach'), 'the failed session is released');

  await dialogs.watch('tab2');
  const session = dialogs.watched.get('tab2')!.session;
  cdp.emit({method: 'Target.detachedFromTarget', params: {sessionId: session}});
  assert.equal(dialogs.watched.has('tab2'), false);

  await dialogs.watch('tab3');
  cdp.emit({method: 'Page.javascriptDialogOpening', sessionId: dialogs.watched.get('tab3')!.session, params: {type: 'beforeunload'}});
  assert.match(describeDialog(dialogs.dialog('tab3')!), /a "Leave site\?" dialog/);
  cdp.emit({method: 'Disconnected'});
  assert.equal(dialogs.watched.size, 0);
  assert.equal(dialogs.stuck.size, 0);
});
