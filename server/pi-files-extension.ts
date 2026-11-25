// Loaded explicitly by the installed Pi CLI for app threads. Lists a desktop file in the thread's Files
// panel; the app checks the path and serves it only to the signed-in owner.
export default function (pi: any) {
  // Before the agent writes or edits a file, the app keeps the version it is about to change, so the Files
  // panel can show a diff. A failure here must never block the tool.
  pi.on('tool_call', async (event: any) => {
    if ((event.toolName !== 'write' && event.toolName !== 'edit') || typeof event.input?.path !== 'string') return undefined;
    try {
      await fetch((process.env.MUSTER_INTERNAL_URL ?? process.env.META_INTERNAL_URL) + '/internal/baseline', {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + (process.env.MUSTER_JOB_TOKEN ?? process.env.META_JOB_TOKEN)},
        body: JSON.stringify({path: event.input.path}),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // No diff for this file, but the tool runs as normal.
    }
    return undefined;
  });

  pi.registerTool({
    name: 'share_file',
    label: 'Share file',
    description:
      "Show a file from this computer in the app's Files panel so the owner can open, preview or download it, " +
      'including from their phone. Use it for files you produce that the owner should see: reports, images, ' +
      'PDFs, exports, archives, logs. Files written with the write or edit tools are listed automatically. ' +
      "Only files inside the thread's folder or /tmp can be shared, never credentials or keys.",
    parameters: {
      type: 'object',
      properties: {
        path: {type: 'string', description: 'Path of the file, absolute or relative to the working folder.'},
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const response = await fetch((process.env.MUSTER_INTERNAL_URL ?? process.env.META_INTERNAL_URL) + '/internal/share', {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + (process.env.MUSTER_JOB_TOKEN ?? process.env.META_JOB_TOKEN)},
        body: JSON.stringify({path: params.path}),
      });
      const data = (await response.json()) as any;
      if (!response.ok) throw new Error(data.error || 'Could not share the file');
      return {content: [{type: 'text', text: `Shared ${data.name} (${data.size} bytes) in the Files panel.`}], details: {}};
    },
  });
}
