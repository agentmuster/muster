/** Canonical Bitbucket PR links posted by the assistant, not URLs in imported or user messages. */
export function sessionPrUrls(messages: {role: string; content?: unknown}[]) {
  const urls = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const text = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : '';
    for (const match of text.matchAll(/https:\/\/bitbucket\.org\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/pull-requests\/[1-9][0-9]*(?=$|[\s\])}>.,?!#\/])/g)) {
      urls.add(match[0]);
    }
  }
  return [...urls];
}
