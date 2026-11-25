import importlib.util
import json
import os
import pathlib
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('indexer', pathlib.Path(__file__).parents[1] / 'engine/indexer.py')
idx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(idx)

TOPICS = [
    'kubernetes ingress certificate renewal failing on staging cluster',
    'react table virtualization performance with ten thousand rows',
    'stripe webhook signature verification rejecting events',
    'postgres migration adding index concurrently locks table',
    'oauth login redirect loop after cookie domain change',
    'terraform state drift on s3 bucket policy',
    'python packaging wheel build fails on arm64',
    'css grid layout breaks on safari mobile viewport',
]


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.data = self.root / 'data'
        self.sources = self.root / 'sources'
        self.sources.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, rows, tail=b''):
        path = self.sources / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b''.join(json.dumps(r).encode() + b'\n' for r in rows) + tail)
        return path

    def pi_session(self, name, cwd, *texts):
        rows = [{'type': 'session', 'id': name, 'cwd': cwd}]
        for i, text in enumerate(texts):
            role = 'user' if i % 2 == 0 else 'assistant'
            content = text if role == 'user' else [{'type': 'text', 'text': text}]
            rows.append({'type': 'message', 'message': {'role': role, 'content': content}})
        return self.write(name + '.jsonl', rows)

    def test_pi_messages_summaries_branches_and_redaction(self):
        p = self.write('pi.jsonl', [
            {'type': 'session', 'id': 'abc', 'cwd': '/work'},
            {'type': 'message', 'id': 'b', 'parentId': 'a',
             'message': {'role': 'user', 'content': 'AUTH-412 redirect login password=supersecret123'}},
            {'type': 'message', 'message': {'role': 'system', 'content': 'Do not index me'}},
            {'type': 'message', 'message': {'role': 'toolResult', 'content': 'PRIVATE TOOL OUTPUT'}},
            {'type': 'compaction', 'summary': 'Decision: test the callback'},
            {'type': 'session_info', 'name': 'OAuth work'},
        ], b'{"type":"message"')
        meta, msgs = idx.parse_session(p, 'pi')
        self.assertEqual(meta['title'], 'OAuth work')
        self.assertEqual(len(msgs), 2)
        self.assertIn('[redacted]', msgs[0][2])
        self.assertEqual(msgs[0][3], 'a')
        self.assertNotIn('supersecret', str(msgs))

    def test_claude_sidechains_blocks_and_malformed(self):
        p = self.write('claude.jsonl', [
            {'type': 'queue-operation', 'operation': 'enqueue'},
            {'type': 'user', 'sessionId': 'session-c', 'cwd': '/claude', 'gitBranch': 'fix', 'isSidechain': True,
             'message': {'role': 'user', 'content': [
                 {'type': 'text', 'text': 'AUTH-412 investigate cookie'},
                 {'type': 'image', 'source': 'PRIVATE'}]}},
            {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
                {'type': 'thinking', 'thinking': 'PRIVATE'},
                {'type': 'tool_use', 'name': 'bash'},
                {'type': 'text', 'text': 'Cookie domain mismatch'}]}},
        ], b'not json\n')
        meta, msgs = idx.parse_session(p, 'claude')
        self.assertEqual(meta['sidechain'], 1)
        self.assertEqual(meta['branch'], 'fix')
        self.assertEqual(len(msgs), 2)
        self.assertNotIn('PRIVATE', str(msgs))

    def test_codex_prefers_typed_prompt_and_response_assistant(self):
        p = self.write('codex.jsonl', [
            {'type': 'session_meta', 'payload': {'session_id': 'native', 'cwd': '/codex'}},
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [
                {'type': 'input_text', 'text': '<environment_context>\n<cwd>/codex</cwd>\n</environment_context>'}]}},
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Fix AUTH-412'}},
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [
                {'type': 'input_text', 'text': 'Fix AUTH-412'}]}},
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [
                {'type': 'output_text', 'text': 'Resolved cookie path'}]}},
            {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'Resolved cookie path'}},
        ])
        meta, msgs = idx.parse_session(p, 'codex')
        self.assertEqual(meta['native_id'], 'native')
        self.assertEqual(meta['title'], 'Fix AUTH-412')
        self.assertEqual([m[1] for m in msgs], ['user', 'assistant'])

    def test_codex_fallback(self):
        p = self.write('fallback.jsonl', [
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'legacy question'}}])
        self.assertEqual(len(idx.parse_session(p, 'codex')[1]), 1)

    def test_boilerplate_is_not_indexed_or_used_as_title(self):
        p = self.write('claude-boiler.jsonl', [
            {'type': 'user', 'cwd': '/w', 'message': {'role': 'user', 'content':
                '<local-command-caveat>Caveat: The messages below were generated by the user</local-command-caveat>'}},
            {'type': 'user', 'message': {'role': 'user', 'content': [
                {'type': 'text', 'text': '<ide_opened_file>The user opened the file /w/a.ts</ide_opened_file>'},
                {'type': 'text', 'text': 'Why does checkout total round wrong?'}]}},
            {'type': 'user', 'message': {'role': 'user', 'content':
                '<command-name>/model</command-name>\n<command-message>model</command-message>'}},
            {'type': 'user', 'message': {'role': 'user', 'content': '<system-reminder>\nunterminated reminder'}},
            {'type': 'user', 'message': {'role': 'user', 'content': 'Base directory for this skill: /x'}},
        ])
        meta, msgs = idx.parse_session(p, 'claude')
        self.assertEqual(meta['title'], 'Why does checkout total round wrong?')
        self.assertEqual([m[2] for m in msgs], ['Why does checkout total round wrong?'])
        codex = self.write('codex-boiler.jsonl', [
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [
                {'type': 'input_text', 'text': '<recommended_plugins>\nHere is a list\n</recommended_plugins>'}]}},
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [
                {'type': 'input_text', 'text': 'Add retry to the uploader'}]}},
        ])
        self.assertEqual(idx.parse_session(codex, 'codex')[0]['title'], 'Add retry to the uploader')

    def test_redaction_patterns(self):
        secrets = {
            'env key': 'OPENAI_API_KEY=abcdefgh12345678',
            'env password': 'DB_PASSWORD=hunter2hunter2',
            'json password': '{"password": "correct-horse-battery"}',
            'github pat': 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
            'github token': 'ghp_abcdefghijklmnopqrstuvwxyz0123',
            'slack': 'xoxb-123456789012-abcdefghijkl',
            'google': 'AIza' + 'A' * 35,
            'jwt': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
            'pem': '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
            'basic': 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==',
            'bearer': 'Authorization: Bearer abcdefghijklmnop.qrstu',
            'url creds': 'postgres://admin:s3cretpass@db.internal:5432/app',
            'anthropic': 'sk-ant-api03-abcdefghijklmnopqrstuv',
            'aws': 'AKIAABCDEFGHIJKLMNOP',
        }
        sensitive = {
            'env key': 'abcdefgh12345678', 'env password': 'hunter2hunter2', 'json password': 'correct-horse',
            'github pat': 'github_pat_11', 'github token': 'ghp_abc', 'slack': 'xoxb-1234', 'google': 'AIzaAAA',
            'jwt': 'eyJhbGci', 'pem': 'MIIEpAIBAAKCAQEA', 'basic': 'dXNlcjpw', 'bearer': 'abcdefghijklmnop',
            'url creds': 's3cretpass', 'anthropic': 'sk-ant', 'aws': 'AKIAABCD',
        }
        for name, text in secrets.items():
            with self.subTest(name):
                self.assertNotIn(sensitive[name], idx.redact(text))
        self.assertEqual(idx.redact('max_tokens: 4096 and the token budget'), 'max_tokens: 4096 and the token budget')
        self.assertIn('db.internal', idx.redact(secrets['url creds']))

    def test_titles_and_cwd_are_redacted(self):
        p = self.write('pi-title.jsonl', [
            {'type': 'session', 'id': 't', 'cwd': '/tmp/ghp_abcdefghijklmnopqrstuvwxyz0123'},
            {'type': 'session_info', 'name': 'rotate OPENAI_API_KEY=abcdefgh12345678'},
        ])
        meta, _ = idx.parse_session(p, 'pi')
        self.assertNotIn('abcdefgh12345678', meta['title'])
        self.assertNotIn('ghp_abc', meta['cwd'])

    def test_incremental_exact_search_context_and_deletion(self):
        p = self.write('pi.jsonl', [
            {'type': 'session', 'id': 'one', 'cwd': '/work'},
            {'type': 'message', 'message': {'role': 'user', 'content': 'AUTH-412 cookie redirect loop'}}])
        before = p.stat().st_mtime_ns
        state = idx.index(self.data, [('pi', self.sources)])
        self.assertEqual(state['sessions'], 1)
        self.assertEqual(state['errors'], 0)
        found = idx.search('AUTH-412', self.data)['results']
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0]['ticket'])
        self.assertGreaterEqual(found[0]['score'], 10)
        ctx = idx.context([found[0]['id']], 'cookie', self.data)
        self.assertEqual(ctx[0]['line'], 2)
        self.assertEqual(ctx[0]['path'], str(p.resolve()))
        self.assertEqual(p.stat().st_mtime_ns, before)
        self.assertEqual(idx.index(self.data, [('pi', self.sources)])['updated'], 0)
        with p.open('a') as f:
            f.write(json.dumps({'type': 'message', 'message': {'role': 'assistant', 'content': 'Fixed AUTH-412'}}) + '\n')
        self.assertEqual(idx.index(self.data, [('pi', self.sources)])['updated'], 1)
        p.unlink()
        self.assertEqual(idx.index(self.data, [('pi', self.sources)])['sessions'], 0)

    def test_ticket_found_among_noise_sessions(self):
        for i in range(250):
            topic = TOPICS[i % len(TOPICS)]
            self.pi_session(f'noise{i}', f'/repo{i % 9}',
                            f'Ticket PROJ-{i + 1000} about {topic}. Build 100 and step 1 of 100.',
                            f'Looked at {topic}; 100 retries, version 1.0.0 issue #{i + 5000}.')
        long_text = ('Background on the billing export. ' * 60) + 'The real fix for PROJ-100 is idempotent writes.'
        self.pi_session('target', '/billing', long_text, 'Added idempotency key to the export writer.')
        state = idx.index(self.data, [('pi', self.sources)])
        self.assertEqual(state['errors'], 0)
        results = idx.search('PROJ-100', self.data)['results']
        self.assertTrue(results[0]['ticket'])
        self.assertEqual(results[0]['cwd'], '/billing')
        self.assertEqual(sum(r['ticket'] for r in results), 1, 'PROJ-1000 must not match PROJ-100')
        issue = idx.search('#5007', self.data)['results']
        self.assertTrue(issue[0]['ticket'])
        self.assertIn('#5007', issue[0]['excerpt'])

    def test_semantic_contributes_and_scores_vary(self):
        partial = [
            'oauth login redirect loop after cookie domain change',
            'login page redirect goes to the wrong locale',
            'oauth token refresh fails after expiry',
            'nginx redirect rules for the docs site',
            'login button styling on the settings page',
        ]
        now = time.time()
        for i in range(40):
            topic = partial[i] if i < len(partial) else TOPICS[i % len(TOPICS)]
            path = self.pi_session(f's{i}', f'/repo{i}', f'Investigate {topic} in service {i}',
                                   f'Root cause for {topic}: configuration detail number {i}.')
            os.utime(path, (now - i * 86400, now - i * 86400))
        state = idx.index(self.data, [('pi', self.sources)])
        self.assertEqual(state['semantic'], 'ready')
        semantic = idx.semantic_search('cookie redirect after login', self.data)
        self.assertTrue(semantic)
        self.assertGreater(max(semantic.values()), 0.1)
        found = idx.search('oauth login redirect loop', self.data)
        self.assertEqual(found['warnings'], [])
        results = found['results']
        self.assertGreater(len({r['score'] for r in results}), 3)
        self.assertIn('oauth', results[0]['title'])
        self.assertTrue(any(r['semantic'] > 0 for r in results))
        self.assertGreater(results[0]['score'], results[-1]['score'])

    def test_semantic_failure_is_reported(self):
        self.pi_session('only', '/w', 'hello world')
        idx.index(self.data, [('pi', self.sources)])
        (self.data / 'semantic.npz').write_bytes(b'not a model')
        idx._semantic_cache.clear()
        found = idx.search('hello', self.data)
        self.assertEqual(len(found['results']), 1)
        self.assertTrue(found['warnings'])

    def test_deleted_file_mid_scan_is_skipped(self):
        first = self.pi_session('a', '/w', 'first session text')
        second = self.pi_session('b', '/w', 'second session text')
        original = idx.parse_session
        calls = []

        def parse_and_delete(path, engine):
            calls.append(path)
            if len(calls) == 1:
                (second if path.name == first.name else first).unlink()
            return original(path, engine)

        idx.parse_session = parse_and_delete
        try:
            state = idx.index(self.data, [('pi', self.sources)])
        finally:
            idx.parse_session = original
        self.assertEqual(state['phase'], 'ready')
        self.assertEqual(state['sessions'], 1)
        self.assertEqual(state['skipped'], 1)

    def test_stale_schema_requires_rebuild(self):
        self.pi_session('a', '/w', 'text')
        idx.index(self.data, [('pi', self.sources)])
        db = idx.connect(self.data)
        db.execute("UPDATE meta SET value='0' WHERE key='schema'")
        db.commit()
        db.close()
        self.assertTrue(idx.search('text', self.data)['warnings'])
        self.assertEqual(idx.index(self.data, [('pi', self.sources)])['sessions'], 1)

    def test_status_records_pid(self):
        self.pi_session('a', '/w', 'text')
        idx.index(self.data, [('pi', self.sources)])
        status = json.loads((self.data / 'index-status.json').read_text())
        self.assertEqual(status['pid'], os.getpid())
        self.assertFalse(status['running'])

    def test_oversized_record_does_not_consume_next_line(self):
        p = self.sources / 'large.jsonl'
        kept = json.dumps({'type': 'message', 'message': {'role': 'user', 'content': 'kept'}}).encode()
        p.write_bytes(b'x' * (idx.MAX_LINE + 100) + b'\n' + kept + b'\n')
        self.assertEqual(idx.parse_session(p, 'pi')[1][0][2], 'kept')


if __name__ == '__main__':
    unittest.main()


def write(path, rows):
    path.write_text(''.join(json.dumps(row) + '\n' for row in rows))


class BridgeMirrorTest(unittest.TestCase):
    def test_claude_copies_of_pi_bridge_sessions_are_not_indexed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            pi_dir, claude_dir, data = root / 'pi', root / 'claude' / 'proj', root / 'data'
            pi_dir.mkdir(); claude_dir.mkdir(parents=True)
            write(pi_dir / 's.jsonl', [
                {'type': 'session', 'id': 'pi-1', 'cwd': '/w'},
                {'type': 'message', 'id': 'a', 'parentId': None, 'message': {'role': 'user', 'content': 'Fix the billing export'}},
            ])
            write(claude_dir / 'bridge-copy.jsonl', [
                {'type': 'user', 'cwd': '/w', 'sessionId': 'bridge-copy', 'message': {'role': 'user', 'content': 'Fix the billing export'}},
                {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
                    {'type': 'tool_use', 'id': 't1', 'name': 'mcp__custom-tools__bash', 'input': {'command': 'ls'}}]}},
            ])
            write(claude_dir / 'interactive.jsonl', [
                {'type': 'user', 'cwd': '/w', 'sessionId': 'interactive', 'message': {'role': 'user', 'content': 'Fix the billing export'}},
                {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
                    {'type': 'tool_use', 'id': 't1', 'name': 'Bash', 'input': {'command': 'ls'}}]}},
            ])
            state = idx.index(data, [('pi', root / 'pi'), ('claude', root / 'claude')])
            self.assertEqual(state['sessions'], 2)
            self.assertEqual(state['mirrors'], 1)
            found = idx.search('billing export', data)['results']
            engines = sorted(r['engine'] for r in found)
            self.assertEqual(engines, ['claude', 'pi'])
            self.assertNotIn('bridge-copy', [r['native_id'] for r in found])
            self.assertNotIn('bridge-copy', [r['native_id'] for r in idx.recent(data)])
