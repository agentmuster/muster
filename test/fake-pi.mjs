#!/usr/bin/env node
// Stands in for `pi --mode rpc` in tests. FAKE_PI_SCENARIO selects the protocol sequence.
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createTwoFilesPatch} from 'diff';
import {spawn} from 'node:child_process';

if (process.argv.includes('--list-models')) {
  process.stdout.write('provider       model              context  max-out  thinking  images\n');
  process.stdout.write('openai-codex   gpt-6.1-sol        500K     128K     yes       yes\n');
  if (!process.argv.includes('--no-extensions')) {
    process.stdout.write('claude-bridge  claude-opus-5-5    1M       128K     yes       yes\n');
  }
  process.exit(0);
}

const scenario = process.env.FAKE_PI_SCENARIO || 'ok';
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const reply = text => [
  {type: 'message_start', message: {role: 'assistant'}},
  {type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: text}},
  {type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text}], stopReason: 'stop'}},
];
const failed = message => ({
  type: 'message_end',
  message: {role: 'assistant', content: [], stopReason: 'error', errorMessage: message},
});

function run(prompt) {
  if (process.env.FAKE_PI_PROMPT_FILE) writeFileSync(process.env.FAKE_PI_PROMPT_FILE, prompt);
  emit({id: 'task', type: 'response', command: 'prompt', success: true});
  switch (scenario) {
    case 'ok':
      return [...reply(process.env.FAKE_PI_REPLY || 'fixture result'), {type: 'agent_end', messages: [], willRetry: false}, {type: 'agent_settled'}];
    case 'retry':
      return [
        {type: 'message_start', message: {role: 'assistant'}},
        failed('529 overloaded'),
        {type: 'agent_end', messages: [], willRetry: true},
        {type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '529 overloaded'},
        ...reply('recovered result'),
        {type: 'auto_retry_end', success: true, attempt: 2},
        {type: 'agent_settled'},
      ];
    case 'retry-fail':
      return [
        failed('529 overloaded'),
        {type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 10, errorMessage: '529 overloaded'},
        {type: 'auto_retry_end', success: false, attempt: 1, finalError: 'provider still overloaded'},
        {type: 'agent_settled'},
      ];
    case 'read-image': {
      // Pi's read tool returning an image, plus a fake "image" that is really text.
      const png = process.env.FAKE_PI_IMAGE
        ? readFileSync(process.env.FAKE_PI_IMAGE).toString('base64')
        : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
      const call = {type: 'toolCall', id: 'r1', name: 'read', arguments: {path: '/tmp/chart.png'}};
      return [
        {type: 'message_start', message: {role: 'assistant'}},
        {type: 'message_end', message: {role: 'assistant', content: [call], stopReason: 'toolUse'}},
        {type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: {path: '/tmp/chart.png'}},
        {
          type: 'tool_execution_end',
          toolCallId: 'r1',
          toolName: 'read',
          result: {content: [{type: 'text', text: 'Read image file [image/png]'}, {type: 'image', data: png, mimeType: 'image/png'},
            {type: 'image', data: Buffer.from('not an image').toString('base64'), mimeType: 'image/png'}]},
          isError: false,
        },
        {type: 'message_start', message: {role: 'assistant'}},
        ...reply('The chart shows one pixel.').slice(1),
        {type: 'agent_end', messages: [], willRetry: false},
        {type: 'agent_settled'},
      ];
    }
    case 'edit': {
      // Edits FAKE_PI_WRITE_FILE the way Pi's edit tool does, reporting a patch of the change.
      const file = process.env.FAKE_PI_WRITE_FILE;
      const before = readFileSync(file, 'utf8');
      const after = before.replace('y = 2', 'y = 3');
      writeFileSync(file, after);
      const patch = createTwoFilesPatch(file, file, before, after, undefined, undefined, {context: 4});
      return [
        {type: 'message_start', message: {role: 'assistant'}},
        {type: 'tool_execution_start', toolCallId: 'e1', toolName: 'edit', args: {path: file, edits: []}},
        {
          type: 'tool_execution_end',
          toolCallId: 'e1',
          toolName: 'edit',
          result: {content: [{type: 'text', text: 'Edited'}], details: {patch}},
          isError: false,
        },
        ...reply('Edited the file.'),
        {type: 'agent_end', messages: [], willRetry: false},
        {type: 'agent_settled'},
      ];
    }
    case 'write': {
      // Writes FAKE_PI_WRITE_FILE through a "write" tool call, as Pi's write tool would.
      const file = process.env.FAKE_PI_WRITE_FILE;
      writeFileSync(file, '# Report\n\nAll good.\n');
      return [
        {type: 'message_start', message: {role: 'assistant'}},
        {type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: {path: file, content: '...'}},
        {type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', result: {content: [{type: 'text', text: 'Wrote file'}]}, isError: false},
        ...reply('Wrote the report.'),
        {type: 'agent_end', messages: [], willRetry: false},
        {type: 'agent_settled'},
      ];
    }
    case 'tools': {
      const call = {type: 'toolCall', id: 'call_1', name: 'bash', arguments: {command: 'cat .env'}};
      return [
        {type: 'message_start', message: {role: 'assistant'}},
        {type: 'message_update', assistantMessageEvent: {type: 'thinking_start', contentIndex: 0}},
        {type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', contentIndex: 0, delta: 'Check the '}},
        {type: 'message_update', assistantMessageEvent: {type: 'thinking_delta', contentIndex: 0, delta: 'env file.'}},
        {type: 'message_update', assistantMessageEvent: {type: 'thinking_end', contentIndex: 0, content: '**Locating** the env file.'}},
        {type: 'message_update', assistantMessageEvent: {type: 'text_delta', contentIndex: 1, delta: 'Looking.'}},
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{type: 'thinking', thinking: '**Locating** the env file.'}, {type: 'text', text: 'Looking.'}, call],
            stopReason: 'toolUse',
          },
        },
        {type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: {command: 'cat .env'}},
        {
          type: 'tool_execution_end',
          toolCallId: 'call_1',
          toolName: 'bash',
          result: {content: [{type: 'text', text: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456'}]},
          isError: false,
        },
        ...reply('The key is set.'),
        {type: 'agent_settled'},
      ];
    }
    case 'error-settle':
      return [failed('context too large'), {type: 'agent_settled'}];
    case 'oversized': {
      const big = 'x'.repeat(5_000_000);
      return [...reply('done after big record'), {type: 'agent_end', messages: [{blob: big}], willRetry: false}, {type: 'agent_settled'}];
    }
    case 'flood': {
      const records = [{type: 'message_start', message: {role: 'assistant'}}];
      for (let i = 0; i < 140; i++) {
        records.push({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'y'.repeat(1000)}});
      }
      const summary = {role: 'assistant', content: [{type: 'text', text: 'final summary'}], stopReason: 'stop'};
      records.push({type: 'message_end', message: summary});
      records.push({type: 'agent_settled'});
      return records;
    }
    case 'tree': {
      // A detached grandchild in its own process group, like Pi's bash tool.
      const ticks = process.env.FAKE_PI_TICKS;
      const child = spawn(process.execPath, ['-e', `setInterval(()=>require('fs').appendFileSync(${JSON.stringify(ticks)},'x'),40)`], {
        detached: true,
        stdio: 'ignore',
      });
      writeFileSync(process.env.FAKE_PI_CHILD_PID, String(child.pid));
      appendFileSync(ticks, '');
      return [];
    }
    case 'hang':
      return [];
  }
  return [];
}

if (process.env.FAKE_PI_ARGS_FILE) writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(process.argv.slice(2)));

// Session branching for Retry: get_fork_messages, fork and get_state, with the branch written on the next reply.
const sessionArg = process.argv[process.argv.indexOf('--session') + 1];
let branch = '';

let input = '';
let attempts = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const command = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    handle(command);
  }
});

function handle(command) {
  if (process.env.FAKE_PI_COMMAND_FILE && command.type === 'prompt') {
    writeFileSync(process.env.FAKE_PI_COMMAND_FILE, JSON.stringify(command));
  }
  if (command.type === 'get_commands') {
    emit({id: command.id, type: 'response', command: 'get_commands', success: true, data: {commands: [
      {name: 'code-review', description: 'Review the current diff with several reviewers', source: 'extension'},
      {name: 'workflows', description: 'Open the workflows navigator', source: 'extension'},
      {name: 'parallel-review', description: 'Review in parallel', source: 'prompt'},
      {name: 'skill:no-ai-slop', description: 'Edit drafts into sharper, more human writing', source: 'skill'},
      {name: 'skill:tenant-preprod-refresh', description: 'Refresh a customer tenant into Pre-Prod', source: 'skill'},
    ]}});
    return;
  }
  if (command.type === 'get_fork_messages') {
    const messages = JSON.parse(process.env.FAKE_PI_FORK_MESSAGES || '[]');
    emit({id: command.id, type: 'response', command: 'get_fork_messages', success: true, data: {messages}});
    return;
  }
  if (command.type === 'fork') {
    if (process.env.FAKE_PI_FORK_FILE) writeFileSync(process.env.FAKE_PI_FORK_FILE, JSON.stringify(command));
    if (scenario === 'fork-fail') {
      emit({id: command.id, type: 'response', command: 'fork', success: false, error: 'Entry not found'});
      return;
    }
    branch = sessionArg.replace(/[^/]*$/, 'branch-' + process.pid + '.jsonl');
    emit({id: command.id, type: 'response', command: 'fork', success: true, data: {text: 'x', cancelled: false}});
    return;
  }
  if (command.type === 'get_state') {
    emit({id: command.id, type: 'response', command: 'get_state', success: true,
      data: {sessionFile: branch || sessionArg, sessionId: branch ? 'branch-' + process.pid : 'own'}});
    return;
  }
  if (branch && command.type === 'prompt') writeFileSync(branch, '{"type":"session"}\n');
  if (command.type === 'get_session_stats') {
    emit({id: command.id, type: 'response', command: 'get_session_stats', success: true,
      data: {contextUsage: {tokens: 12000, contextWindow: 200000, percent: 6}}});
    return;
  }
  if (command.type === 'compact') {
    const done = () => emit({id: command.id, type: 'response', command: 'compact', success: true,
      data: {tokensBefore: 190000, estimatedTokensAfter: 30000}});
    if (scenario === 'slow') setTimeout(done, Number(process.env.FAKE_PI_DELAY || 4000));
    else done();
    return;
  }
  // 'overflow': the first attempt is rejected as too long; after compaction the retry succeeds.
  if (scenario === 'overflow' && command.type === 'prompt') {
    attempts += 1;
    emit({id: 'task', type: 'response', command: 'prompt', success: true});
    if (attempts === 1) {
      emit({type: 'message_start', message: {role: 'assistant'}});
      emit(failed('Prompt is too long'));
      emit({type: 'agent_settled'});
    } else {
      for (const record of reply('recovered after compaction')) emit(record);
      emit({type: 'agent_settled'});
    }
    return;
  }
  // Steering: Pi acknowledges, then reports the message when it hands it to the model. A message containing
  // "never delivered" is acknowledged but never handed over.
  if (command.type === 'steer' && scenario !== 'slow') {
    emit({id: command.id, type: 'response', command: 'steer', success: true});
    if (!String(command.message).includes('never delivered')) {
      setTimeout(() => {
        emit({type: 'message_start', message: {role: 'user', content: command.message}});
        emit({type: 'message_end', message: {role: 'user', content: [{type: 'text', text: command.message}]}});
      }, 30);
    }
    return;
  }
  // 'slow': each prompt streams a little, then finishes after FAKE_PI_DELAY ms (compaction too).
  if (scenario === 'slow' && command.type === 'steer') {
    emit({id: command.id, type: 'response', command: 'steer', success: true});
    return;
  }
  if (scenario === 'slow' && command.type === 'prompt') {
    emit({id: 'task', type: 'response', command: 'prompt', success: true});
    const [start, update, end] = reply('slow reply to: ' + String(command.message).slice(0, 60));
    emit(start);
    emit(update);
    setTimeout(() => {
      emit(end);
      emit({type: 'agent_end', messages: [], willRetry: false});
      emit({type: 'agent_settled'});
    }, Number(process.env.FAKE_PI_DELAY || 4000));
    return;
  }
  // 'dialog': an extension asks a question and the run only finishes once it is answered.
  if (command.type === 'extension_ui_response') {
    for (const record of reply(command.cancelled ? 'dialog dismissed' : 'dialog answered: ' + (command.value ?? command.confirmed))) emit(record);
    emit({type: 'agent_settled'});
    return;
  }
  // 'background': "start background" launches a fake async subagent; it reports back by itself later.
  if (scenario === 'background' && command.type === 'prompt') {
    emit({id: 'task', type: 'response', command: 'prompt', success: true});
    if (!String(command.message).includes('start background')) {
      setTimeout(() => {
        for (const record of reply('follow-up answered by ' + process.pid)) emit(record);
        emit({type: 'agent_settled'});
      }, 50);
      return;
    }
    const runDir = process.env.MUSTER_SUBAGENT_RUNS + '/bg-' + process.pid;
    mkdirSync(runDir, {recursive: true});
    const status = {runId: 'bg-' + process.pid, sessionId: sessionArg, state: 'running', pid: process.pid, mode: 'single',
      steps: [{agent: 'worker', description: 'fake background task', status: 'running'}], startedAt: Date.now(),
      outputFile: runDir + '/output-0.log', totalTokens: {total: 1234}, totalCost: {costUsd: 0.01}};
    writeFileSync(runDir + '/status.json', JSON.stringify(status));
    writeFileSync(runDir + '/output-0.log', 'worker: looking into it\n');
    setTimeout(() => {
      for (const record of reply('started background work')) emit(record);
      emit({type: 'agent_settled'});
    }, 50);
    setTimeout(() => {
      writeFileSync(runDir + '/status.json', JSON.stringify({...status, state: 'complete', endedAt: Date.now(), steps: [{...status.steps[0], status: 'complete'}]}));
      appendFileSync(runDir + '/output-0.log', 'worker: done\n');
      emit({type: 'agent_start'});
      emit({type: 'message_end', message: {role: 'custom', display: true, content: 'Background task completed: **worker**\n\nworker:\nall good'}});
      for (const record of reply('background result: done')) emit(record);
      emit({type: 'agent_settled'});
    }, Number(process.env.FAKE_PI_DELAY || 1500));
    return;
  }
  if (scenario === 'dialog') {
    emit({id: 'task', type: 'response', command: 'prompt', success: true});
    emit({type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick a branch', options: ['main', 'dev']});
    return;
  }
  const records = run(command.message);
  setTimeout(() => {
    for (const record of records) emit(record);
  }, 50);
}
setInterval(() => {}, 1000);
