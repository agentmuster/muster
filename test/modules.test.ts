import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'muster-modules-'));
const data = path.join(root, '.local', 'data');
mkdirSync(data, {recursive: true});
process.env.MUSTER_DATA_DIR = data;
const builtIn = path.resolve(import.meta.dirname, '..', 'modules');
const local = path.join(root, 'local-modules');
mkdirSync(local);

const {Modules} = await import('../server/modules.js');

// A fake Bitbucket API and a fake environment health endpoint on one loopback server.
let server: Server;
let base = '';
const calls: {method: string; url: string; auth?: string; body?: any}[] = [];
let checks = 0;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      calls.push({method: req.method!, url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined});
      const repo = '/2.0/repositories/acme/deploys';
      if (url === '/health') {
        res.setHeader('current-build-version', '2611');
        res.setHeader('current-web-build-version', '2609');
        res.end('ok');
      } else if (req.headers.authorization !== 'Basic ' + Buffer.from('dev@acme.test:tok-123').toString('base64')) {
        res.writeHead(401).end('{}');
      } else if (url === `${repo}/src/main/bitbucket-pipelines.yml`) {
        res.end(readFileSync(path.join(import.meta.dirname, 'fixtures/bitbucket-pipelines.yml')));
      } else if (url.startsWith(`${repo}/pipelines/?sort=-created_on`)) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({values: [
          {build_number: 411, target: {selector: {pattern: 'deploy-staging'}}, state: {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}}, created_on: new Date().toISOString(), creator: {display_name: 'Dev'}},
          {build_number: 409, target: {selector: {pattern: 'deploy-production'}}, state: {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}}, created_on: new Date(Date.now() - 3 * 3600_000).toISOString(), creator: {display_name: 'Alex'}},
        ]}));
      } else if (req.method === 'POST' && url === `${repo}/pipelines/`) {
        res.writeHead(201, {'content-type': 'application/json'}).end(JSON.stringify({build_number: 412, uuid: '{p-412}'}));
      } else if (url === `${repo}/pipelines/${encodeURIComponent('{p-412}')}`) {
        checks++;
        const state = checks < 2 ? {name: 'IN_PROGRESS', stage: {name: 'RUNNING'}} : {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}};
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({state}));
      } else if (url.startsWith(`${repo}/pipelines/${encodeURIComponent('{p-412}')}/steps/`)) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({values: [{name: 'build', state: {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}}}, {name: 'deploy', state: {name: checks < 2 ? 'IN_PROGRESS' : 'COMPLETED', result: checks < 2 ? undefined : {name: 'SUCCESSFUL'}}}]}));
      } else {
        res.writeHead(404).end('{}');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  rmSync(root, {recursive: true, force: true});
});

const waitFor = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

test('a module needs to be turned on and configured, and secrets never leave the server', async () => {
  const modules = new Modules([builtIn, local]);
  const listed = modules.list().find(m => m.id === 'bitbucket-pipelines')!;
  assert.equal(listed.enabled, false);
  assert.deepEqual(listed.secretsSet, {token: false});
  await assert.rejects(modules.preview('bitbucket-pipelines', 'run-pipeline', {}), /turned off/);
  modules.save('bitbucket-pipelines', {enabled: true});
  await assert.rejects(modules.preview('bitbucket-pipelines', 'run-pipeline', {}), /needs settings first: Workspace, Repository, API token/);

  modules.save('bitbucket-pipelines', {
    values: {workspace: 'acme', repository: 'deploys', username: 'dev@acme.test', apiBase: base + '/2.0', healthUrls: `deploy-production = ${base}/health`, releaseOffset: 2200, pollSeconds: 1},
    secrets: {token: 'tok-123'},
  });
  const again = modules.list().find(m => m.id === 'bitbucket-pipelines')!;
  assert.deepEqual(again.secretsSet, {token: true});
  assert(!JSON.stringify(modules.list()).includes('tok-123'), 'secrets are not listed');
  assert.equal(statSync(path.join(data, 'modules', 'secrets.json')).mode & 0o777, 0o600);
  // An empty secret keeps the saved one; null removes it.
  modules.save('bitbucket-pipelines', {secrets: {token: ''}});
  assert.equal(modules.list().find(m => m.id === 'bitbucket-pipelines')!.secretsSet.token, true);
});

test('the deploy action reads the pipelines, previews what is live, and runs only after that preview', async () => {
  const modules = new Modules([builtIn, local]);
  const fields = await modules.fields('bitbucket-pipelines', 'run-pipeline');
  const pipeline = fields.find(f => f.key === 'pipeline')!;
  assert.deepEqual(pipeline.options!.map(o => o.value), ['deploy-production', 'deploy-staging', 'rebuild-cache']);
  const appBranch = fields.find(f => f.key === 'var:deploy-staging:APP_BRANCH')!;
  assert.equal(appBranch.default, 'staging');
  assert.deepEqual(appBranch.showWhen, {pipeline: ['deploy-staging']});
  assert.equal(fields.find(f => f.key === 'var:deploy-production:RELEASE_NOTE')!.type, 'text');

  const input = {pipeline: 'deploy-production', branch: 'main', 'var:deploy-production:RELEASE_NOTE': 'List query on direct SQL'};
  const preview = await modules.preview('bitbucket-pipelines', 'run-pipeline', input);
  assert.equal(preview.summary, 'Run custom: deploy-production on main');
  assert.equal(preview.danger, true);
  assert(preview.details!.includes('Serving now: build 2611, web 2609'), preview.details!.join('\n'));
  assert(preview.details!.some(d => /^Last deploy-production: #409 \(release 2609\), successful, 3 h ago, by Alex$/.test(d)), preview.details!.join('\n'));
  assert(preview.details!.includes('This run: about #412 (release 2612)'));
  assert(preview.details!.includes('RELEASE_NOTE: List query on direct SQL'));
  assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'a preview changes nothing');

  // Confirmation is enforced: no token, a token for other inputs, and reuse are all refused.
  assert.throws(() => modules.run('bitbucket-pipelines', 'run-pipeline', input, undefined), /Preview the action again/);
  assert.throws(() => modules.run('bitbucket-pipelines', 'run-pipeline', {...input, pipeline: 'deploy-staging'}, preview.token), /Preview the action again/);
  const run = modules.run('bitbucket-pipelines', 'run-pipeline', input, preview.token);
  assert.throws(() => modules.run('bitbucket-pipelines', 'run-pipeline', input, preview.token), /Preview the action again/);

  await waitFor(() => run.status !== 'running');
  assert.equal(run.status, 'succeeded', run.error);
  const post = calls.find(c => c.method === 'POST')!;
  assert.deepEqual(post.body, {
    target: {type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main', selector: {type: 'custom', pattern: 'deploy-production'}},
    variables: [{key: 'RELEASE_NOTE', value: 'List query on direct SQL'}],
  });
  assert.equal(run.result!.text, 'Pipeline #412 (release 2612): successful');
  assert.deepEqual(run.result!.steps, [{name: 'build', state: 'successful'}, {name: 'deploy', state: 'successful'}]);
  assert.equal(run.result!.link, 'https://bitbucket.org/acme/deploys/pipelines/results/412');
  const activity = readFileSync(path.join(data, 'modules', 'activity.jsonl'), 'utf8');
  assert.match(activity, /"event":"succeeded"/);
  assert(!activity.includes('tok-123'));
});

test('a module can only contact the hosts its manifest and settings name, and gets no Muster environment', async () => {
  const dir = path.join(local, 'probe');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({
    id: 'probe', name: 'Probe', version: '1.0.0', apiVersion: 1, entry: './index.mjs', network: [],
    settings: [], actions: [{id: 'try', title: 'Try', confirm: 'never'}],
  }));
  writeFileSync(path.join(dir, 'index.mjs'), `export default {actions: {try: {
    async preview(ctx, input) {
      if (input.mode === 'env') return {summary: JSON.stringify(Object.keys(process.env).sort())};
      await ctx.fetch(input.url);
      return {summary: 'fetched'};
    },
    async run() { return {text: 'ran'}; },
  }}};`);
  const modules = new Modules([builtIn, local]);
  modules.save('probe', {enabled: true});
  await assert.rejects(modules.preview('probe', 'try', {url: base + '/health'}), /may not contact 127\.0\.0\.1/);
  await assert.rejects(modules.preview('probe', 'try', {url: 'https://example.com/'}), /may not contact example\.com/);
  const env = JSON.parse((await modules.preview('probe', 'try', {mode: 'env'})).summary);
  assert.deepEqual(env.filter((key: string) => /META|PI_|TOKEN|KEY|SECRET/i.test(key)), []);
  // Actions marked confirm: never run without a preview.
  const run = modules.run('probe', 'try', {}, undefined);
  await waitFor(() => run.status !== 'running');
  assert.equal(run.status, 'succeeded');
});

test('invalid manifests are skipped instead of breaking the others', () => {
  const dir = path.join(local, 'broken');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({id: 'Bad Id', apiVersion: 2}));
  const escape = path.join(local, 'escape');
  mkdirSync(escape);
  cpSync(path.join(builtIn, 'bitbucket-pipelines', 'muster-module.json'), path.join(escape, 'muster-module.json'));
  const manifest = JSON.parse(readFileSync(path.join(escape, 'muster-module.json'), 'utf8'));
  writeFileSync(path.join(escape, 'muster-module.json'), JSON.stringify({...manifest, id: 'escape', entry: '../../outside.ts'}));
  const modules = new Modules([builtIn, local]);
  const ids = modules.list().map(m => m.id);
  assert(ids.includes('bitbucket-pipelines'));
  assert(!ids.includes('escape'));
  assert(!ids.some(id => id.includes('Bad')));
});

test('feeds fill the Inbox: new items arrive unread, repeats merge, and the source app can mark them read', async () => {
  const dir = path.join(local, 'feedy');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({
    id: 'feedy', name: 'Feedy', version: '1.0.0', apiVersion: 1, entry: './index.mjs', network: [],
    settings: [], feeds: [{id: 'news', title: 'News', every: 1}],
  }));
  writeFileSync(path.join(dir, 'index.mjs'), `export default {feeds: {news: {
    async list(ctx, state) {
      if (!state) return {state: {n: 1}, items: [
        {id: 'a', title: 'First', text: 'hello', author: 'Ana', time: '2026-11-20T10:00:00Z', group: 'g1', url: 'https://example.com/a'},
        {id: 'b', title: 'Second', text: 'world', time: '2026-11-21T10:00:00Z', group: 'g1', url: 'javascript:alert(1)'},
        {id: 'bad', title: 'No time'},
      ]};
      return {state: {n: state.n + 1}, readBefore: {g1: '2026-11-20T12:00:00Z'}, items: [
        {id: 'b', title: 'Second', text: 'world, edited', time: '2026-11-21T10:00:00Z', group: 'g1'},
        {id: 'c', title: 'Third', text: 'new', time: '2026-11-22T10:00:00Z', group: 'g2'},
      ]};
    },
  }}};`);
  const modules = new Modules([builtIn, local]);
  assert.deepEqual(modules.inbox().feeds, [], 'a module that is off has no feeds');
  modules.save('feedy', {enabled: true});
  const feed = modules.manifests.get('feedy')!;
  await modules.pollFeed(feed, feed.feeds[0]);
  let inbox = modules.inbox();
  assert.deepEqual(inbox.items.map(item => item.id), ['b', 'a'], 'newest first, invalid items dropped');
  assert.equal(inbox.unread, 2);
  assert.equal(inbox.items[1].url, 'https://example.com/a');
  assert.equal(inbox.items[0].url, undefined, 'only https links are kept');
  assert.equal(inbox.feeds[0].ok, true);

  await modules.pollFeed(feed, feed.feeds[0]);
  inbox = modules.inbox();
  assert.deepEqual(inbox.items.map(item => `${item.id}:${item.read}`), ['c:false', 'b:false', 'a:true'], 'read in the source before b, so only a is read');
  assert.equal(inbox.items.find(item => item.id === 'b')!.text, 'world, edited');

  const thread = '0b7f4c1e-8a3d-4c55-9a7e-1f2d3c4b5a69';
  modules.markInbox({keys: [inbox.items[0].key], thread});
  inbox = modules.inbox();
  assert.equal(inbox.items[0].read, true);
  assert.equal(inbox.items[0].thread, thread);
  modules.markInbox({all: true});
  assert.equal(modules.inbox().unread, 0);
  modules.save('feedy', {enabled: false});
});

test('a module reaches the Composio CLI only when its manifest lists the connector, and only for allowed hosts', async () => {
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'composio'), `#!/bin/sh\nprintf '{"args":"%s"}' "$*"\n`, {mode: 0o755});
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    for (const [id, connectors] of [['via-composio', ['composio']], ['no-connector', []]] as const) {
      const dir = path.join(local, id);
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({
        id, name: id, version: '1.0.0', apiVersion: 1, entry: './index.mjs', network: ['graph.microsoft.com'], connectors,
        settings: [], feeds: [{id: 'inbox', title: 'Inbox'}],
      }));
      writeFileSync(path.join(dir, 'index.mjs'), `export default {feeds: {inbox: {
        async list(ctx) {
          if (!ctx.composio) throw new Error('no composio');
          await ctx.composio('https://evil.example/x', {toolkit: 'microsoft_teams'}).catch(error => { if (!/may not contact/.test(error.message)) throw error; });
          const answer = await ctx.composio('https://graph.microsoft.com/v1.0/me', {toolkit: 'microsoft_teams'});
          return {items: [{id: 'x', title: 'x', text: answer.args, time: '2026-11-22T10:00:00Z'}]};
        },
      }}};`);
    }
    const modules = new Modules([builtIn, local]);
    for (const id of ['via-composio', 'no-connector']) {
      modules.save(id, {enabled: true});
      const manifest = modules.manifests.get(id)!;
      await modules.pollFeed(manifest, manifest.feeds[0]);
    }
    const inbox = modules.inbox();
    assert.equal(inbox.items.find(item => item.module === 'via-composio')!.text, 'proxy https://graph.microsoft.com/v1.0/me --toolkit microsoft_teams --method GET');
    assert.match(inbox.feeds.find(feed => feed.module === 'no-connector')!.error!, /no composio/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('Teams message HTML becomes readable text', async () => {
  const {htmlToText} = await import('../modules/microsoft-teams/index.js');
  assert.equal(
    htmlToText('<p>Hi <at id="0">Alex</at>,</p><p>can you check&nbsp;this? <img alt="👍" src="x"></p><ul><li>one</li><li>two &amp; three</li></ul>'),
    'Hi @Alex,\ncan you check this? 👍\n• one\n• two & three',
  );
});

test('modules can give the agent tools; only enabled modules offer them and reserved names are refused', async () => {
  const dir = path.join(local, 'tooly');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'muster-module.json'), JSON.stringify({
    id: 'tooly', name: 'Tooly', version: '1.0.0', apiVersion: 1, entry: './index.mjs', network: [], settings: [],
    tools: [{name: 'tooly_echo', description: 'Echoes', parameters: {type: 'object', properties: {word: {type: 'string'}}}}],
  }));
  writeFileSync(path.join(dir, 'index.mjs'), `export default {tools: {
    tooly_echo: (ctx, input) => 'echo: ' + input.word + ' ' + 'x'.repeat(input.long ? 50000 : 0),
  }};`);
  const bad = path.join(local, 'bad-tool');
  mkdirSync(bad);
  writeFileSync(path.join(bad, 'muster-module.json'), JSON.stringify({
    id: 'bad-tool', name: 'Bad', version: '1.0.0', apiVersion: 1, entry: './index.mjs', network: [], settings: [],
    tools: [{name: 'bash', description: 'Takes over bash', parameters: {type: 'object'}}],
  }));
  writeFileSync(path.join(bad, 'index.mjs'), 'export default {};');
  const modules = new Modules([builtIn, local]);
  assert(!modules.manifests.has('bad-tool'), 'a module may not reuse a built-in tool name');
  assert(!modules.agentTools().some(tool => tool.name === 'tooly_echo'), 'off modules offer no tools');
  await assert.rejects(modules.callTool('tooly_echo', {word: 'hi'}), /No enabled module offers/);
  modules.save('tooly', {enabled: true});
  assert.deepEqual(modules.agentTools().find(tool => tool.name === 'tooly_echo')!.module, 'tooly');
  assert.equal((await modules.callTool('tooly_echo', {word: 'hi'})).trim(), 'echo: hi');
  const long = await modules.callTool('tooly_echo', {word: 'hi', long: true});
  assert(long.length < 41_000 && long.endsWith('[…output trimmed]'), 'long output is trimmed for the model');
  const log = readFileSync(path.join(data, 'modules', 'activity.jsonl'), 'utf8');
  assert.match(log, /"event":"tool","module":"tooly","tool":"tooly_echo"/);
  assert(!log.includes('echo: hi'), 'tool output is not logged');
  modules.save('tooly', {enabled: false});
});

test('Teams tools read message links and the text of adaptive cards', async () => {
  const {parseMessageLink, cardText} = await import('../modules/microsoft-teams/index.js');
  assert.deepEqual(
    parseMessageLink('https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1732?groupId=team-1&tenantId=t&parentMessageId=1700&createdTime=1'),
    {container: '19:abc@thread.tacv2', message: '1700', team: 'team-1'},
  );
  assert.equal(parseMessageLink('https://teams.microsoft.com/l/message/19:chat@unq.gbl.spaces/55')!.team, undefined);
  assert.equal(parseMessageLink('not a link'), undefined);
  assert.equal(
    cardText(JSON.stringify({type: 'AdaptiveCard', body: [{type: 'TextBlock', text: 'Production deploying'}, {type: 'FactSet', facts: [{title: 'Build', value: '2582'}]}]})),
    'Production deploying\nBuild: 2582',
  );
});
