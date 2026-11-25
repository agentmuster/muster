import {defineConfig} from 'vite';
import path from 'node:path';
import {readFileSync} from 'node:fs';

// Icons the browser or iOS fetch on their own may arrive without the sign-in cookie, so Cloudflare Access
// would answer with its login page. Embedding them in the HTML avoids that request.
const icon = (file: string) => 'data:image/png;base64,' + readFileSync(path.resolve('web/public/icons', file)).toString('base64');
const embeddedIcons = {
  name: 'embedded-icons',
  transformIndexHtml(_html: string, context: {path: string}) {
    const tags = [{tag: 'link', attrs: {rel: 'icon', type: 'image/png', sizes: '32x32', href: icon('favicon-32.png')}, injectTo: 'head' as const}];
    // The iPhone Home Screen icon, for the chat page only.
    if (context.path.endsWith('/index.html')) {
      tags.push({tag: 'link', attrs: {rel: 'apple-touch-icon', sizes: '180x180', href: icon('apple-touch-icon.png')} as any, injectTo: 'head' as const});
    }
    return tags;
  },
};
export default defineConfig({root:'web',plugins:[embeddedIcons],build:{outDir:'../dist',emptyOutDir:true,rollupOptions:{input:{main:path.resolve('web/index.html'),viewer:path.resolve('web/viewer.html')}}},server:{host:'127.0.0.1'}});
