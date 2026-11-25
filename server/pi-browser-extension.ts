// Loaded explicitly by the installed Pi CLI. No browser credentials enter this module.
export default function (pi: any) {
  pi.registerTool({
    name: 'browseros',
    label: 'BrowserOS',
    description:
      'Control the persistent BrowserOS browser. Actions: tabs, open(url), navigate(tab,url), read(tab), ' +
      'click(tab,selector), type(tab,selector,text), screenshot(tab), dialog(tab,accept,text), close(tab), ' +
      'request_help(tab). A page showing an alert, confirm, prompt or "Leave site?" dialog is frozen until it is ' +
      'answered: dialog with accept true (OK) or false (Cancel), plus text for a prompt. Only accept a ' +
      'confirmation that deletes, sends, pays or publishes something when the owner asked for exactly that; ' +
      'otherwise call request_help. Pass the sign-in tab ' +
      'to request_help so the owner sees it first. Use request_help for every ' +
      'login, password, MFA, OAuth consent, CAPTCHA, or sensitive credential step. Human takeover pauses the run ' +
      'until the owner returns control. Do not use bash or other tools to bypass this browser gate.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tabs', 'open', 'navigate', 'read', 'click', 'type', 'screenshot', 'dialog', 'close', 'request_help'],
        },
        accept: {type: 'boolean', description: 'For dialog: true clicks OK, false clicks Cancel.'},
        tab: {type: 'string'},
        url: {type: 'string'},
        selector: {type: 'string'},
        text: {type: 'string'},
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const response = await fetch((process.env.MUSTER_INTERNAL_URL ?? process.env.META_INTERNAL_URL) + '/internal/browser', {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + (process.env.MUSTER_JOB_TOKEN ?? process.env.META_JOB_TOKEN)},
        body: JSON.stringify(params),
      });
      const data = (await response.json()) as any;
      if (!response.ok) throw new Error(data.error || 'Browser action failed');
      const content = data.image
        ? [{type: 'image', data: data.image, mimeType: 'image/jpeg'}]
        : [{type: 'text', text: String(data.text || 'Done')}];
      return {content, details: {}};
    },
  });
}
