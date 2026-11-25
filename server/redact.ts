// Best-effort secret redaction. Keep in step with SECRET_PATTERNS in engine/indexer.py.
const KEY_NAMES =
  'api[_-]?key|apikey|password|passwd|pwd|secret|client[_-]?secret|' +
  'access[_-]?token|refresh[_-]?token|auth[_-]?token|token|private[_-]?key';

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]'],
  [/\bbasic\s+[A-Za-z0-9+/]{12,}={0,2}/gi, 'Basic [redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[redacted]@'],
  [
    new RegExp(
      `(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_-])*(?:${KEY_NAMES})["']?\\s*[:=]\\s*)(["']?)[^\\s"',;}]{8,}`,
      'gi',
    ),
    '$1$2[redacted]',
  ],
];

export function redact(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}
