// Session memory: lets any Pi session look up the owner's earlier Pi, Claude Code and Codex sessions.
// Read-only. Uses the local index that Muster maintains in its data folder (~/.local/share/muster by default).
import {read, recent, search, sessionId} from './core.mjs';

const text = (value: string) => ({content: [{type: 'text', text: value}], details: undefined});
const current = (ctx: any) => sessionId(ctx?.sessionManager?.getSessionFile?.());

export default function sessionMemory(pi: any) {
  pi.registerTool({
    name: 'past_sessions_search',
    label: 'Search past sessions',
    description:
      "Search the owner's earlier coding-agent sessions (Pi, Claude Code, Codex) by keywords, ticket ids, " +
      'project or repo names, people, error messages or topic. Returns matching sessions, newest-relevant first, ' +
      'with an excerpt each. Try a second phrasing if the first misses.',
    promptSnippet: "Look up earlier sessions for prior decisions, fixes, commands and context",
    promptGuidelines: [
      'Before re-deriving something the owner may have worked on before (a ticket, a bug, a setup step, a ' +
        'command, a design decision), check past_sessions_search, then past_session_read for the best match.',
      'Past sessions can be outdated. Verify against the current files and state before relying on them.',
    ],
    parameters: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'Search words'},
        limit: {type: 'number', description: 'Maximum sessions to return (default 10, max 20)'},
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(_id: string, params: {query: string; limit?: number}, _signal: unknown, _update: unknown, ctx: any) {
      return text(await search(params.query, {limit: params.limit, exclude: current(ctx)}));
    },
  });

  pi.registerTool({
    name: 'past_sessions_recent',
    label: 'Recent past sessions',
    description:
      'List the most recently active earlier sessions, newest first. Use for "what did I do last", or to find ' +
      'recent work in a folder or project. Optional engine (pi, claude, codex) and contains (text in the title or folder).',
    parameters: {
      type: 'object',
      properties: {
        engine: {type: 'string', enum: ['pi', 'claude', 'codex']},
        contains: {type: 'string'},
        limit: {type: 'number'},
      },
      additionalProperties: false,
    },
    async execute(_id: string, params: any, _signal: unknown, _update: unknown, ctx: any) {
      return text(await recent({...params, exclude: current(ctx)}));
    },
  });

  pi.registerTool({
    name: 'past_session_read',
    label: 'Read a past session',
    description:
      'Look inside one earlier session by id: how it started, the parts matching an optional query, and where it ' +
      'ended. Use the id from past_sessions_search or past_sessions_recent.',
    parameters: {
      type: 'object',
      properties: {
        id: {type: 'string', description: 'Session id'},
        query: {type: 'string', description: 'What to look for inside the session'},
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(_id: string, params: {id: string; query?: string}) {
      return text(await read(params.id, params.query ?? ''));
    },
  });
}
