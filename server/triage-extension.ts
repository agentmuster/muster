// Loaded by the Inbox triage Pi run. Its one tool records how new messages group into requests.

const text = (value: string) => ({content: [{type: 'text', text: value}], details: {}});

export default function (pi: any) {
  pi.registerTool({
    name: 'submit_requests',
    label: 'Submit requests',
    description:
      'Report the grouping once, then stop. Every new message ref (m1, m2, …) must appear exactly once: in one ' +
      "request's items, or in ignore. request is an open request's ref (R1, R2, …) to add to it, or \"new\".",
    parameters: {
      type: 'object',
      properties: {
        requests: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              request: {type: 'string', description: 'R-ref of an open request this continues, or "new"'},
              title: {type: 'string', description: 'Imperative and specific, under 80 characters'},
              summary: {type: 'string', description: 'One to three sentences with the details needed to act'},
              people: {type: 'array', items: {type: 'string'}, description: 'Who is asking'},
              priority: {type: 'string', enum: ['high', 'normal', 'low']},
              kind: {type: 'string', enum: ['task', 'question', 'decision', 'review']},
              items: {type: 'array', items: {type: 'string'}, description: 'm-refs of the new messages in it'},
            },
            required: ['request', 'title', 'summary', 'people', 'priority', 'kind', 'items'],
            additionalProperties: false,
          },
        },
        ignore: {type: 'array', items: {type: 'string'}, description: 'm-refs that ask nothing of the owner: thanks, FYIs, updates, small talk'},
      },
      required: ['requests', 'ignore'],
      additionalProperties: false,
    },
    async execute() {
      return text('Recorded. Stop now.');
    },
  });
}
