// Loaded by the installed Pi CLI for app threads when enabled modules offer agent tools, such as Teams
// search. The app passes the tool list in META_MODULE_TOOLS; each call runs in the module's own process.

type ToolSpec = {name: string; label: string; description: string; parameters: Record<string, unknown>};

export default function (pi: any) {
  let tools: ToolSpec[] = [];
  try {
    tools = JSON.parse((process.env.MUSTER_MODULE_TOOLS ?? process.env.META_MODULE_TOOLS) || '[]');
  } catch {
    return;
  }
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id: string, params: any, signal?: AbortSignal) {
        const response = await fetch((process.env.MUSTER_INTERNAL_URL ?? process.env.META_INTERNAL_URL) + '/internal/module-tool', {
          method: 'POST',
          headers: {'content-type': 'application/json', authorization: 'Bearer ' + (process.env.MUSTER_JOB_TOKEN ?? process.env.META_JOB_TOKEN)},
          body: JSON.stringify({name: tool.name, input: params ?? {}}),
          signal,
        });
        const data = (await response.json()) as any;
        if (!response.ok) throw new Error(data.error || `${tool.name} failed`);
        return {content: [{type: 'text', text: String(data.text ?? '')}], details: {}};
      },
    });
  }
}
