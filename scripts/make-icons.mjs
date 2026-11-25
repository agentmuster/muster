#!/usr/bin/env node
// Generates the app icon with OpenAI's newest image model and writes every size the PWA, iOS and the
// favicon need into web/public/icons.
//
//   node scripts/make-icons.mjs generate [--env-file path --env-key NAME] [--model id] [--count 3]
//                                        [--prompt-file path] [--prefix name]
//   node scripts/make-icons.mjs pick N        build all sizes from candidate N
//
// The key comes from OPENAI_API_KEY, or from a variable in an .env file. It is never printed.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ICONS = path.join(ROOT, 'web/public/icons');
const WORK = path.join(ROOT, 'scripts/.icon-candidates');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf('--' + name);
  return at >= 0 ? args[at + 1] : fallback;
};

// The prompt behind the current icon; pass --prompt-file to try others.
const PROMPT = readFileSync(path.join(ROOT, 'scripts/icon-prompts/muster-color-dark.txt'), 'utf8').trim();

function apiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  const file = option('env-file');
  const name = option('env-key', 'OPENAI_API_KEY');
  if (!file) throw new Error('Set OPENAI_API_KEY or pass --env-file and --env-key.');
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && match[1] === name) return match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  throw new Error(`${name} not found in ${file}`);
}

async function openai(key, route, body) {
  const response = await fetch('https://api.openai.com/v1/' + route, {
    method: body ? 'POST' : 'GET',
    headers: {authorization: 'Bearer ' + key, ...(body ? {'content-type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${route}: ${data.error?.message || response.status}`);
  return data;
}

/** The most recently released gpt-image model this account can use. */
async function newestImageModel(key) {
  const {data} = await openai(key, 'models');
  const models = data.filter(model => /^gpt-image/.test(model.id)).sort((a, b) => b.created - a.created);
  if (!models.length) throw new Error('No gpt-image model is available to this key.');
  console.log('Image models available:', models.map(model => model.id).join(', '));
  return models[0].id;
}

async function generate() {
  const key = apiKey();
  const model = option('model') || (await newestImageModel(key));
  const count = Number(option('count', 3));
  console.log(`Generating ${count} candidates with ${model}…`);
  const promptFile = option('prompt-file');
  const prompt = promptFile ? readFileSync(promptFile, 'utf8').trim() : PROMPT;
  const prefix = option('prefix', 'candidate');
  const result = await openai(key, 'images/generations', {model, prompt, size: '1024x1024', quality: 'high', n: count});
  mkdirSync(WORK, {recursive: true});
  result.data.forEach((image, index) => {
    const file = path.join(WORK, `${prefix}-${index + 1}.png`);
    writeFileSync(file, Buffer.from(image.b64_json, 'base64'));
    console.log('Wrote', file);
  });
  writeFileSync(path.join(WORK, 'model.txt'), model + '\n');
}

function magick(...parts) {
  execFileSync('magick', parts.map(String), {stdio: 'ignore'});
}

function pick(name) {
  const source = path.join(WORK, /^\d+$/.test(name) ? `candidate-${name}.png` : `${name}.png`);
  if (!existsSync(source)) throw new Error(`No ${source}; run generate first.`);
  mkdirSync(ICONS, {recursive: true});
  const out = name => path.join(ICONS, name);
  execFileSync('cp', [source, path.join(ROOT, 'scripts/icon-source-1024.png')]);
  // Regular icons use the full-bleed art; iOS rounds the corners itself.
  for (const [size, name] of [
    [512, 'icon-512.png'],
    [192, 'icon-192.png'],
    [180, 'apple-touch-icon.png'],
  ]) {
    magick(source, '-resize', `${size}x${size}`, out(name));
  }
  // Android may cut icons to a circle 80% wide, so the maskable icon gets extra margin, filled with the
  // art's own corner color.
  const corner = execFileSync('magick', [source, '-format', '%[pixel:p{8,8}]', 'info:'], {encoding: 'utf8'}).trim();
  magick(source, '-resize', '78%', '-background', corner, '-gravity', 'center', '-extent', '1024x1024', '-resize', '512x512', out('maskable-512.png'));
  // Favicons crop in on the symbol so it stays legible in a browser tab.
  for (const size of [48, 32, 16]) {
    magick(source, '-gravity', 'center', '-crop', '780x780+0+0', '+repage', '-resize', `${size}x${size}`, out(`favicon-${size}.png`));
  }
  magick(out('favicon-48.png'), out('favicon-32.png'), out('favicon-16.png'), out('favicon.ico'));
  console.log('Icons written to', ICONS);
}

const command = args[0];
if (command === 'generate') await generate();
else if (command === 'pick') pick(String(args[1] || 1));
else console.log('Usage: make-icons.mjs generate [--env-file F --env-key NAME] [--model ID] [--count N] | pick N');
