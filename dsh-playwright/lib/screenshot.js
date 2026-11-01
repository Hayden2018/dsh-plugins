import fs from 'node:fs';
import path from 'node:path';
import { withAbort, throwIfAborted } from './async.js';
import { SHOT_DIR } from './settings.js';

/** Persist an inline image best-effort; the screenshot file remains authoritative. */
async function inlineImage(ctx, displayPath, data, signal) {
  try {
    const attachments = ctx.get('attachments');
    const limits = attachments && attachments.imageLimits;
    if (!limits) return undefined;
    if (Array.isArray(limits.mediaTypes) && !limits.mediaTypes.includes('image/png')) return undefined;
    const cap = Math.min(limits.maxImageBytes || Infinity, limits.maxMessageImageBytes || Infinity);
    if (data.byteLength > cap) return undefined;
    throwIfAborted(signal);
    const ref = await withAbort(
      attachments.saveImage({
        data,
        mediaType: 'image/png',
        name: path.basename(displayPath),
      }),
      signal
    );
    // Copy a plain JSON value for durable tool results; rendering adds ImageBlock.
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
    };
  } catch {
    // Missing service, image limits, or storage errors must not lose the file.
    throwIfAborted(signal);
    return undefined;
  }
}

export async function captureScreenshot(ctx, page, args, signal) {
  throwIfAborted(signal);
  const name = args.filename || `shot-${Date.now()}.png`;
  const abs = path.resolve(SHOT_DIR, name);
  const data = await page.screenshot({ fullPage: !!args.fullPage, signal });
  throwIfAborted(signal);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Let an already-started write finish rather than aborting it mid-file.
  // The caller can still settle promptly; the path is returned only on success.
  await withAbort(fs.promises.writeFile(abs, data), signal);
  const image = await inlineImage(ctx, abs, data, signal);
  return image ? { path: abs, image } : { path: abs };
}

function scaledNote(image) {
  const orig = image && image.originalDimensions;
  if (!orig || !image.width || !image.height) return '';
  const x = (orig.width / image.width).toFixed(2);
  const y = (orig.height / image.height).toFixed(2);
  return ` (downscaled from ${orig.width}x${orig.height} px; multiply coordinates by ${x === y ? x : `x ${x}, y ${y}`} to locate features in the original file)`;
}

// The screenshot alone has structured output so the path and image can coexist.
export const SHOT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      image: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          mediaType: {
            type: 'string',
            enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
          },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          name: { type: 'string' },
          originalDimensions: {
            type: 'object',
            additionalProperties: false,
            properties: { width: { type: 'integer' }, height: { type: 'integer' } },
            required: ['width', 'height'],
          },
        },
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      },
    },
    required: ['path'],
  },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: `Screenshot saved: ${value.path}${scaledNote(value.image)}` }];
    if (value.image) blocks.push({ type: 'image', attachment: { ...value.image } });
    return blocks;
  },
};
