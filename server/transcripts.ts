import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import readline from 'node:readline';
import {redact} from './redact.js';

// Turns an earlier session file into chat messages (AG-UI shape) so a continued or split thread
// shows its history, and into bounded text excerpts that seed a Pi thread split from Claude Code or Codex.

const TEXT_LIMIT = 8000;
const TOOL_LIMIT = 3000;
const MAX_LINE = 4_000_000;

type Message = {id: string; role: string; content: string; toolCallId?: string; toolCalls?: any[]};

const clip = (text: string, limit: number) => {
  const clean = redact(text);
  return clean.length > limit ? clean.slice(0, limit) + `\n… ${clean.length - limit} more characters` : clean;
};

function blockText(content: unknown, types = ['text', 'input_text', 'output_text']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => (types.includes(block?.type) && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

function toolArgs(args: unknown) {
  try {
    const json = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    JSON.parse(json);
    return json.length > 4000 ? JSON.stringify({truncated: json.slice(0, 4000)}) : json;
  } catch {
    return JSON.stringify({value: String(args).slice(0, 4000)});
  }
}

/** Text the harness injected into user turns, such as environment or IDE context. */
const BOILERPLATE =
  /^\s*<(environment_context|recommended_plugins|ide_|local-command|command-|system-reminder|user_instructions|browser_instruction)/;
const boilerplate = (text: string) => BOILERPLATE.test(text);

async function* lines(file: string) {
  const input = readline.createInterface({input: createReadStream(file, {encoding: 'utf8'}), crlfDelay: Infinity});
  for await (const line of input) {
    if (!line || line.length > MAX_LINE) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A partial last line or a malformed record.
    }
  }
}

function piMessage(entry: any): Message[] {
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    return entry.summary
      ? [{id: entry.id, role: 'assistant', content: clip('Summary of earlier conversation:\n\n' + entry.summary, TEXT_LIMIT)}]
      : [];
  }
  if (entry.type !== 'message') return [];
  const message = entry.message ?? {};
  if (message.role === 'user') {
    const text = blockText(message.content);
    return text.trim() ? [{id: entry.id, role: 'user', content: clip(text, TEXT_LIMIT)}] : [];
  }
  if (message.role === 'assistant') {
    const blocks: any[] = Array.isArray(message.content) ? message.content : [];
    const out: Message[] = [];
    const thinking = blocks.filter(b => b.type === 'thinking' && b.thinking).map(b => b.thinking).join('\n\n');
    if (thinking.trim()) out.push({id: entry.id + '-thinking', role: 'reasoning', content: clip(thinking, TEXT_LIMIT)});
    const text = blockText(blocks);
    const toolCalls = blocks
      .filter(b => b.type === 'toolCall' && b.id)
      .map(b => ({id: b.id, type: 'function', function: {name: String(b.name), arguments: toolArgs(b.arguments)}}));
    if (text.trim() || toolCalls.length) {
      out.push({id: entry.id, role: 'assistant', content: clip(text, TEXT_LIMIT), ...(toolCalls.length ? {toolCalls} : {})});
    }
    return out;
  }
  if (message.role === 'toolResult') {
    const text = blockText(message.content) || '(no output)';
    const content = clip((message.isError ? 'Error: ' : '') + text, TOOL_LIMIT);
    return [{id: entry.id, role: 'tool', toolCallId: String(message.toolCallId), content}];
  }
  return [];
}

/** Messages on the active branch of a Pi session, oldest first, limited to the most recent ones. */
export async function piTranscript(file: string, limit = 200): Promise<Message[]> {
  const entries = new Map<string, {parentId: string | null; messages: Message[]}>();
  let leaf: string | undefined;
  for await (const entry of lines(file)) {
    if (!entry || typeof entry.id !== 'string' || entry.type === 'session') continue;
    entries.set(entry.id, {parentId: entry.parentId ?? null, messages: piMessage(entry)});
    leaf = entry.id;
  }
  const chain: Message[][] = [];
  const seen = new Set<string>();
  for (let id = leaf; id && !seen.has(id); id = entries.get(id)?.parentId ?? undefined) {
    seen.add(id);
    const entry = entries.get(id);
    if (!entry) break;
    if (entry.messages.length) chain.push(entry.messages);
  }
  return dropOrphans(chain.reverse().flat().slice(-limit));
}

/** Claude Code and Codex sessions are linear; keep the last messages of the main conversation. */
export async function foreignTranscript(engine: string, file: string, limit = 120): Promise<Message[]> {
  const out: Message[] = [];
  const push = (message: Message) => {
    out.push(message);
    if (out.length > limit * 2) out.splice(0, out.length - limit);
  };
  for await (const record of lines(file)) {
    if (engine === 'claude') {
      if (record.isSidechain || !['user', 'assistant'].includes(record.type)) continue;
      const content = record.message?.content;
      const id = String(record.uuid ?? randomUUID());
      if (record.type === 'user') {
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_result') {
              const text = blockText(block.content) || (typeof block.content === 'string' ? block.content : '(no output)');
              push({id: id + block.tool_use_id, role: 'tool', toolCallId: String(block.tool_use_id), content: clip(text, TOOL_LIMIT)});
            }
          }
        }
        const text = blockText(content);
        if (text.trim() && !boilerplate(text)) push({id, role: 'user', content: clip(text, TEXT_LIMIT)});
      } else {
        const blocks: any[] = Array.isArray(content) ? content : [];
        const thinking = blocks.filter(b => b.type === 'thinking' && b.thinking).map(b => b.thinking).join('\n\n');
        if (thinking.trim()) push({id: id + '-thinking', role: 'reasoning', content: clip(thinking, TEXT_LIMIT)});
        const text = blockText(blocks);
        const toolCalls = blocks
          .filter(b => b.type === 'tool_use' && b.id)
          .map(b => ({id: b.id, type: 'function', function: {name: String(b.name), arguments: toolArgs(b.input)}}));
        if (text.trim() || toolCalls.length) {
          push({id, role: 'assistant', content: clip(text, TEXT_LIMIT), ...(toolCalls.length ? {toolCalls} : {})});
        }
      }
    } else if (engine === 'codex' && record.type === 'response_item') {
      const p = record.payload ?? {};
      const id = String(p.id ?? randomUUID());
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        const text = blockText(p.content);
        if (text.trim() && !boilerplate(text)) push({id, role: p.role, content: clip(text, TEXT_LIMIT)});
      } else if (p.type === 'function_call' && p.call_id) {
        const call = {id: p.call_id, type: 'function', function: {name: String(p.name), arguments: toolArgs(p.arguments)}};
        push({id, role: 'assistant', content: '', toolCalls: [call]});
      } else if (p.type === 'function_call_output' && p.call_id) {
        const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        push({id, role: 'tool', toolCallId: String(p.call_id), content: clip(output, TOOL_LIMIT)});
      } else if (p.type === 'reasoning') {
        const text = (p.summary ?? []).map((s: any) => s?.text ?? '').join('\n');
        if (text.trim()) push({id, role: 'reasoning', content: clip(text, TEXT_LIMIT)});
      }
    }
  }
  return dropOrphans(out.slice(-limit));
}

/** Tool results whose call fell outside the kept window would render without context. */
function dropOrphans(messages: Message[]) {
  const calls = new Set(messages.flatMap(m => (m.toolCalls ?? []).map((c: any) => c.id)));
  return messages.filter(m => m.role !== 'tool' || calls.has(m.toolCallId));
}

/** The end of a conversation as cited excerpts, for seeding a Pi thread split from another tool. */
export function transcriptExcerpts(
  messages: Message[],
  source: {session: string; engine: string; title: string; path: string},
  budget = 24_000,
) {
  const out: any[] = [];
  let remaining = budget;
  for (const message of [...messages].reverse()) {
    if (!['user', 'assistant'].includes(message.role) || !message.content.trim()) continue;
    const text = message.content.slice(0, Math.min(3000, remaining));
    if (!text) break;
    out.unshift({...source, line: 0, branch: '', role: message.role, text});
    remaining -= text.length;
  }
  return out;
}
