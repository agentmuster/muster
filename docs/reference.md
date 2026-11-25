# Files, limits and development

## Files and limits

Private state defaults to `~/.local/share/muster` (set `MUSTER_DATA_DIR` to move it), with directory mode 700 and application state files mode 600. It contains the search database, local semantic model, login files, allowed hosts, browser pause state, managed threads, bounded display events, and native Pi transcripts. These files are not encrypted at rest. Keep FileVault and your desktop account protections enabled.

The display keeps a bounded recent transcript and event replay. Pi's managed JSONL transcript retains its full native context. Sign-ins last 12 hours, with at most 16 active. Each sign-in attempt waits 250 ms. A client gets eight attempts per 15 minutes, and all clients together get 200 failed attempts before sign-in pauses for everyone. Request bodies are capped at 512 KB, viewer messages at 8 KB, and Pi protocol records at about 4 MB. Larger Pi records are skipped; the app never reads them.

If the indexer is killed, the sidebar shows it as interrupted rather than running. Its last error is kept in `index-status.json`.

```sh
npm test
npm run typecheck
npm run build
npm audit
# Optional live checks against the running app:
npm run smoke:pi
npm run smoke:browser
```

The Pi smoke check makes one small model request using the installed account and leaves a saved test thread. The browser smoke check opens and closes only its own harmless local fixture tab, verifies streamed frames, typing and key input, and verifies explicit handback. It refuses to run during an existing takeover. Both read the password file in-process to sign in and never print it.

The tests use synthetic transcripts, a fake Pi process, and a fake DevTools endpoint, so they never touch real BrowserOS. They cover:
- the three parsers, injected-text filtering, partial and oversized records, files deleted mid-scan, and incremental refresh
- redaction in Python and JavaScript
- exact ticket retrieval among 250 noise sessions, varied scores, and semantic scoring
- authentication, per-client throttling, the global backstop, CSRF/Origin and Host checks, the allowed-hosts file, encoded viewer paths, and the internal listener
- viewer input validation, takeover handback, and WebSocket logout revocation
- Pi retry, failure and oversized-record handling, the output limit, process-tree pause and kill, restart recovery, and context retry with nonce-tagged excerpts

Current CopilotKit dependencies include Zod 3, which has an unresolved oversized-collection validation advisory. The app puts its runtime behind authentication and Origin checks, bounds request bodies before validation, and never wires unused Slack/Teams channels or client-supplied MCP servers. Overrides update Undici, Fastify Busboy, and graphql-scalars. The remaining dependency findings are documented limitations, not a clean security audit.

## Upgrading from Session desk

Muster used to be called Session desk. Older installs keep working without changes: `META_*` settings are read as their `MUSTER_*` names, and an existing `~/.local/share/meta-agent` data folder stays in use until a `~/.local/share/muster` folder exists. Settings saved in the browser carry over.
