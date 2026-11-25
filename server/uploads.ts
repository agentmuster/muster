import {randomUUID} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {DATA} from './security.js';

// Images pasted, dropped or attached in the chat. They are stored privately on the desktop and sent to
// Pi with the prompt; saved threads keep a signed-in link instead of the image data.

export const UPLOADS = path.join(DATA, 'uploads');
mkdirSync(UPLOADS, {recursive: true, mode: 0o700});

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 8;
export const UPLOAD_ID = /^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/;

export type PiImage = {type: 'image'; data: string; mimeType: string};
export type PromptParts = {text: string; images: PiImage[]; parts: any[]};

/** The file signature, so a mislabelled file cannot pass as an image. */
function sniff(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * Splits a chat message into prompt text and images. Accepts AG-UI content parts with inline base64
 * image data; anything else (other file types, remote URLs) is rejected with a message for the owner.
 */
export function readUserContent(content: unknown): PromptParts {
  if (typeof content === 'string') return {text: content, images: [], parts: []};
  if (!Array.isArray(content)) return {text: '', images: [], parts: []};
  const texts: string[] = [];
  const images: PiImage[] = [];
  const parts: any[] = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
      continue;
    }
    const source = part?.source;
    if (part?.type !== 'image' || source?.type !== 'data' || typeof source.value !== 'string') {
      throw new Error('Only images (PNG, JPEG, GIF or WebP) can be attached.');
    }
    if (images.length >= MAX_IMAGES) throw new Error(`Attach at most ${MAX_IMAGES} images per message.`);
    const bytes = Buffer.from(source.value, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Each image must be 10 MB or smaller.');
    const mimeType = sniff(bytes);
    if (!mimeType) throw new Error('Only images (PNG, JPEG, GIF or WebP) can be attached.');
    const name = `${randomUUID()}.${IMAGE_TYPES[mimeType]}`;
    const file = path.join(UPLOADS, name);
    writeFileSync(file, bytes, {mode: 0o600});
    chmodSync(file, 0o600);
    images.push({type: 'image', data: bytes.toString('base64'), mimeType});
    parts.push({type: 'image', source: {type: 'url', value: '/api/uploads/' + name, mimeType}});
  }
  const text = texts.join('\n');
  return {text, images, parts: text ? [{type: 'text', text}, ...parts] : parts};
}

export function uploadPath(name: string) {
  if (!UPLOAD_ID.test(name)) return undefined;
  const file = path.join(UPLOADS, name);
  return existsSync(file) ? file : undefined;
}

/**
 * Saves an image a tool returned (a file the agent read, a browser screenshot) so the chat can show it.
 * Returns its signed-in link, or undefined for anything that is not a supported image under the size limit.
 */
export function saveToolImage(data: unknown) {
  if (typeof data !== 'string' || data.length > MAX_IMAGE_BYTES * 1.4) return undefined;
  const bytes = Buffer.from(data, 'base64');
  const mimeType = sniff(bytes);
  if (!mimeType || bytes.length > MAX_IMAGE_BYTES) return undefined;
  const name = `${randomUUID()}.${IMAGE_TYPES[mimeType]}`;
  const file = path.join(UPLOADS, name);
  writeFileSync(file, bytes, {mode: 0o600});
  chmodSync(file, 0o600);
  return '/api/uploads/' + name;
}
