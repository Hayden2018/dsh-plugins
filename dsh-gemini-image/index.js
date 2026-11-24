/**
 * Gemini image generation for DeepSeek Harness.
 *
 * One model-facing tool, `generate_image`, backed by the same Google credential
 * the profile already stores for its `google` chat provider (default reference
 * `GOOGLE_API_KEY`). The model is fixed to `gemini-nano-banana-2.1`: a `model`
 * argument would silently move cost and latency behind the caller's back.
 *
 * The returned JPEG is written into this package's `generated/` folder and
 * stored as a durable attachment, so the transcript shows the image and a
 * vision-capable model sees it; a text-only route receives the standard
 * omission placeholder instead of a failed request.
 *
 * An attached image rides every later request, so the default keeps only the
 * newest generated image in context: each new result logs the shipped
 * `image/offload` decision for the older ones. That decision replaces those
 * occurrences with placeholder text in every subsequent request while their
 * files stay on disk and `read_image` can still open them.
 * @module dsh-gemini-image
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

export const name = 'gemini-image';

/** The tool registry is the only mandatory dependency; everything else is optional. */
export const inject = ['tools'];

/** Efficient image generation and conversational editing model. */
const MODEL = 'gemini-nano-banana-2.1';

/** Interactions API endpoint; the model's image controls live in `response_format`. */
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** Credential reference the Google chat provider uses in this profile. */
const DEFAULT_CREDENTIAL_REF = 'GOOGLE_API_KEY';

const DEFAULT_ASPECT_RATIO = '1:1';
const DEFAULT_IMAGE_SIZE = '1K';

/** Every ratio the model accepts, including the wide and panoramic ones it added. */
const ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
];

/** 1K is the documented default; 4K is deliberately out of reach of this tool. */
const IMAGE_SIZES = ['1K', '2K'];

/** Reference images accepted per call, fanned out over both model budgets. */
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 20 * 1024 * 1024;

/** One generation takes roughly 20-30 s; this bounds a stalled connection. */
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Prefix of every file this plugin writes.
 *
 * It is the durable marker that later calls use to recognize their own images
 * in the session surface: it survives restarts, needs no side table, and can
 * never match a user attachment or a `read_image` block.
 */
const FILE_PREFIX = 'gemini-image-';

/**
 * Directory every generated image is written to: `generated/` inside this
 * package, beside the plugin's own files.
 *
 * Output lives here rather than in the session working directory so a
 * generation cannot litter the user's project with binaries. The folder is
 * git-ignored, created on demand, and the returned path is absolute, so a
 * caller can always open the file.
 */
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'generated');

/** Media types reference inputs may declare by extension. */
const REFERENCE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

/** Output media types mapped to the suffix their file gets. */
const OUTPUT_SUFFIXES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

/**
 * Plugin configuration.
 *
 * Both fields are `volatile`: the Harness settings surface projects live
 * fields into the plugin's row form on the Plugins page, and a value change
 * reaches the next call without restarting the plugin.
 */
export const Config = z.object({
  credentialRef: z
    .string()
    .default(DEFAULT_CREDENTIAL_REF)
    .volatile()
    .description(
      "Credential reference holding the Google API key. Defaults to the reference the profile's Google chat provider uses, so one key serves both."
    ),
  keepAllImages: z
    .boolean()
    .default(false)
    .volatile()
    .description(
      'Keep every generated image in the model context. Off keeps only the newest: older images become placeholder text in later requests, while their files stay on disk.'
    ),
});

/** The image descriptor rendered beside the path; the attachment id is durable. */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes'],
};

/** The structured outcome the tool declares and renders. */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string' },
      mediaType: { type: 'string' },
      bytes: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      aspectRatio: { type: 'string' },
      imageSize: { type: 'string' },
      caption: { type: 'string' },
      image: IMAGE_VALUE_SCHEMA,
    },
    required: ['path', 'mediaType', 'bytes'],
  },
  render: (_args, value) => {
    const lines = [`Generated image (${value.imageSize}, ${value.aspectRatio}): ${value.path}`];
    if (value.width !== undefined && value.height !== undefined) {
      lines.push(`${value.width}x${value.height} px, ${value.mediaType}, ${value.bytes} bytes`);
    }
    if (value.caption !== undefined && value.caption.length > 0) lines.push(value.caption);
    const blocks = [{ type: 'text', text: lines.join('\n') }];
    if (value.image !== undefined) blocks.push({ type: 'image', attachment: { ...value.image } });
    return blocks;
  },
};

/** A tool failure the model must read and act on, carrying a stable code. */
function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Read one volatile Config field, tolerating a raw (non-volatile) value.
 * @param field - the Config field, a Volatile reference or a plain value.
 * @param fallback - value used while the field is absent or empty.
 * @returns the live field value, or the fallback.
 */
function liveValue(field, fallback) {
  const value = typeof field?.get === 'function' ? field.get() : field;
  return value === undefined || value === null || value === '' ? fallback : value;
}

/**
 * Resolve the Google API key from the credential seam, falling back to the
 * process environment when no credential service is mounted.
 * @param ctx - host context carrying the optional `credentials` service.
 * @param reference - credential reference name.
 * @returns the key, or undefined while it is not configured.
 */
async function resolveApiKey(ctx, reference) {
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    const hit = await credentials.resolve(reference);
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value;
  }
  const fromEnvironment = process.env[reference];
  return fromEnvironment !== undefined && fromEnvironment.length > 0 ? fromEnvironment : undefined;
}

/**
 * Name the missing credential exactly as the user must fix it.
 * @param reference - credential reference name.
 * @param configured - whether the seam knows the reference at all.
 * @returns the model-facing failure.
 */
function missingKeyError(reference, configured) {
  const remedy =
    'add a Google API key in Settings > Models (it is stored as the ' +
    reference +
    ' credential), or export ' +
    reference +
    ' before starting the Harness';
  return toolError(
    'GEMINI_API_KEY_MISSING',
    configured === false
      ? `Image generation needs a Google API key and none is configured: ${remedy}, then call generate_image again.`
      : `Image generation could not read a Google API key: its value is empty. Replace it in Settings > Models, or export ${reference}, then call generate_image again.`
  );
}

/**
 * Resolve the session's working directory, used only to interpret a relative
 * reference-image path a caller typed by hand.
 * @param ctx - host context carrying the optional `workingDirectory` service.
 * @param session - calling session, when the call came from an agent.
 * @returns an absolute directory path.
 */
function sessionDirectory(ctx, session) {
  try {
    if (session !== undefined) {
      const directory = ctx.get('workingDirectory')?.get(session);
      if (typeof directory === 'string' && directory.length > 0) return directory;
    }
  } catch {
    // A missing or throwing directory service must not block generation.
  }
  return process.cwd();
}

/**
 * Read one reference image into the inline block the Interactions API takes.
 * @param path - model-supplied path, absolute or relative to a candidate directory.
 * @param directories - directories a relative path is tried against, in order.
 * @returns the inline image block.
 */
async function referenceBlock(path, directories) {
  const candidates = isAbsolute(path) ? [path] : directories.map((directory) => resolve(directory, path));
  const mediaType = REFERENCE_MEDIA_TYPES.get(extname(candidates[0]).toLowerCase());
  if (mediaType === undefined) {
    throw toolError(
      'GEMINI_REFERENCE_UNSUPPORTED',
      `reference image "${path}" must be a PNG, JPEG, WebP, or GIF file; convert it first.`
    );
  }
  let data;
  let unreadable;
  for (const candidate of candidates) {
    try {
      data = await readFile(candidate);
      break;
    } catch (error) {
      unreadable ??= error;
    }
  }
  if (data === undefined) {
    throw toolError(
      'GEMINI_REFERENCE_UNREADABLE',
      `reference image "${path}" could not be read (${
        unreadable instanceof Error ? unreadable.message : String(unreadable)
      }); a relative path is tried against the working directory and the plugin's generated folder.`
    );
  }
  if (data.byteLength > MAX_REFERENCE_BYTES) {
    throw toolError(
      'GEMINI_REFERENCE_TOO_LARGE',
      `reference image "${path}" is ${data.byteLength} bytes; each reference must stay under ${MAX_REFERENCE_BYTES} bytes.`
    );
  }
  return {
    block: { type: 'image', data: data.toString('base64'), mime_type: mediaType },
    bytes: data.byteLength,
  };
}

/**
 * Translate a failed HTTP answer into a message that names the user's next step.
 * @param response - the failed response.
 * @param body - its already-read text.
 * @param reference - credential reference named in a credential failure.
 * @returns the model-facing failure.
 */
function requestFailure(response, body, reference) {
  let detail = '';
  try {
    detail = String(JSON.parse(body)?.error?.message ?? '').trim();
  } catch {
    detail = body.slice(0, 400).trim();
  }
  const suffix = detail.length > 0 ? ` Google said: ${detail}` : '';
  if (response.status === 401 || response.status === 403) {
    return toolError(
      'GEMINI_API_KEY_REJECTED',
      `Google rejected the ${reference} credential (HTTP ${response.status}). Replace it in Settings > Models.${suffix}`
    );
  }
  if (response.status === 429) {
    return toolError(
      'GEMINI_RATE_LIMITED',
      `The Google image quota or rate limit is exhausted (HTTP 429); wait and retry.${suffix}`
    );
  }
  return toolError(
    'GEMINI_REQUEST_FAILED',
    `Gemini image generation failed (HTTP ${response.status}).${suffix}`
  );
}

/**
 * Collect the image and caption from a completed interaction.
 * @param interaction - parsed Interactions API response.
 * @returns the last image block, its MIME type, and any caption text.
 */
function readInteraction(interaction) {
  const outputs = Array.isArray(interaction?.steps)
    ? interaction.steps.filter((step) => step?.type === 'model_output')
    : [];
  const blocks = outputs.flatMap((step) => (Array.isArray(step.content) ? step.content : []));
  const images = blocks.filter((block) => block?.type === 'image' && typeof block.data === 'string');
  const caption = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n');
  if (images.length === 0) {
    throw toolError(
      'GEMINI_NO_IMAGE',
      caption.length > 0
        ? `The model returned no image and said: ${caption}`
        : 'The model returned no image. The prompt may have been refused by safety filters; rephrase it and retry.'
    );
  }
  const image = images[images.length - 1];
  return { data: image.data, mediaType: image.mime_type ?? 'image/jpeg', caption };
}

/**
 * Log one durable omission of every earlier generated image this plugin wrote.
 *
 * The shipped `image/offload` decision is the Harness's own "omit this image
 * occurrence from model requests" record: replay-safe because its type is part
 * of the session format, visible in the transcript, and reversible in no way
 * that would resurrect context. Every step here is best effort — losing a
 * context trim must never lose the image the user just asked for.
 * @param session - the calling session, when the call came from an agent.
 * @param logger - host logger for a diagnostic.
 * @returns how many occurrences were omitted.
 */
function trimEarlierImages(session, logger) {
  if (session === undefined) return 0;
  const targets = [];
  try {
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq);
      if (event?.type !== 'tool/result') continue;
      const message = session.deriveEventMessage(event);
      if (message === undefined || !Array.isArray(message.content)) continue;
      const imageIndexes = [];
      let index = 0;
      for (const block of message.content) {
        if (block?.type !== 'image') continue;
        const fileName = block.attachment?.name;
        if (block.offloaded !== true && typeof fileName === 'string' && fileName.startsWith(FILE_PREFIX)) {
          imageIndexes.push(index);
        }
        index += 1;
      }
      if (imageIndexes.length > 0) targets.push({ seq, imageIndexes });
    }
    if (targets.length === 0) return 0;
    session.append('image/offload', { targets });
    return targets.reduce((total, target) => total + target.imageIndexes.length, 0);
  } catch (error) {
    logger?.warn?.(
      'gemini-image: could not trim earlier images from context: %s',
      error instanceof Error ? error.message : String(error)
    );
    return 0;
  }
}

/**
 * Mount the `generate_image` tool.
 * @param ctx - host plugin context.
 * @param config - resolved plugin Config.
 */
export function apply(ctx, config = {}) {
  const credentialReference = () => liveValue(config?.credentialRef, DEFAULT_CREDENTIAL_REF);

  const definition = {
    name: 'generate_image',
    description:
      "Generate or edit one image with Gemini Nano Banana 2.1 and save it under the plugin's generated folder. " +
      'Returns the absolute path; a model that accepts image input also sees the image itself. ' +
      'Takes about 20-30 seconds per image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description:
            'What to draw or change. Be specific about subject, style, lighting, and any text to render, and name each reference image\'s role here (for example "the person in image 1", "the product in image 2").',
        },
        aspect_ratio: {
          oneOf: [{ type: 'string', enum: ASPECT_RATIOS }, { type: 'null' }],
          description: `Output aspect ratio; default ${DEFAULT_ASPECT_RATIO}. Optional; omit or pass null to use the default.`,
        },
        image_size: {
          oneOf: [{ type: 'string', enum: IMAGE_SIZES }, { type: 'null' }],
          description: `Output resolution; default ${DEFAULT_IMAGE_SIZE}. 2K costs about 50% more output tokens than 1K. Optional; omit or pass null to use the default.`,
        },
        reference_images: {
          oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
          description:
            'Up to 4 absolute paths of images to keep consistent or to edit. All four may target one character or one product: the model holds up to 4 characters or up to 10 objects faithful, so spend the four on the role the prompt depends on most. Optional; omit or pass null to generate from text alone.',
        },
      },
      required: ['prompt'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const signal = exec?.signal;
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
      if (prompt.length === 0) throw toolError('GEMINI_BAD_PROMPT', 'prompt must be a non-empty string.');

      const aspectRatio = args?.aspect_ratio ?? DEFAULT_ASPECT_RATIO;
      if (!ASPECT_RATIOS.includes(aspectRatio)) {
        throw toolError(
          'GEMINI_BAD_ASPECT_RATIO',
          `aspect_ratio must be one of ${ASPECT_RATIOS.join(', ')}.`
        );
      }
      const imageSize = args?.image_size ?? DEFAULT_IMAGE_SIZE;
      if (!IMAGE_SIZES.includes(imageSize)) {
        throw toolError('GEMINI_BAD_IMAGE_SIZE', `image_size must be one of ${IMAGE_SIZES.join(', ')}.`);
      }

      const references = Array.isArray(args?.reference_images)
        ? args.reference_images.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
        : [];
      if (references.length > MAX_REFERENCE_IMAGES) {
        throw toolError(
          'GEMINI_TOO_MANY_REFERENCES',
          `reference_images accepts at most ${MAX_REFERENCE_IMAGES} paths; this call passed ${references.length}.`
        );
      }

      const reference = credentialReference();
      const apiKey = await resolveApiKey(ctx, reference);
      if (apiKey === undefined) {
        const configured =
          ctx.get('credentials') === undefined
            ? undefined
            : (await ctx.get('credentials').describe(reference)).configured;
        throw missingKeyError(reference, configured);
      }

      const session = exec?.agent?.session;
      const referenceDirectories = [sessionDirectory(ctx, session), OUTPUT_DIR];

      // Build the input: a bare string for text-to-image, ordered blocks when
      // references take part. Reference order is the order the prompt names.
      const blocks = [{ type: 'text', text: prompt }];
      let referenceBytes = 0;
      for (const path of references) {
        const prepared = await referenceBlock(path, referenceDirectories);
        referenceBytes += prepared.bytes;
        if (referenceBytes > MAX_REFERENCE_TOTAL_BYTES) {
          throw toolError(
            'GEMINI_REFERENCES_TOO_LARGE',
            `the reference images total more than ${MAX_REFERENCE_TOTAL_BYTES} bytes; use smaller copies.`
          );
        }
        blocks.push(prepared.block);
      }

      const body = {
        model: MODEL,
        input: blocks.length === 1 ? prompt : blocks,
        response_format: { type: 'image', aspect_ratio: aspectRatio, image_size: imageSize },
      };

      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (signal !== undefined) signals.push(signal);
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      const text = await response.text();
      if (!response.ok) throw requestFailure(response, text, reference);

      let interaction;
      try {
        interaction = JSON.parse(text);
      } catch {
        throw toolError(
          'GEMINI_BAD_RESPONSE',
          'Gemini returned a response that is not valid JSON; retry the call.'
        );
      }
      if (interaction?.status !== 'completed') {
        throw toolError(
          'GEMINI_INCOMPLETE',
          `Gemini returned status ${String(interaction?.status)} instead of completed; retry the call.`
        );
      }
      const generated = readInteraction(interaction);
      const suffix = OUTPUT_SUFFIXES.get(generated.mediaType) ?? '.jpg';
      const data = Buffer.from(generated.data, 'base64');
      if (data.byteLength === 0) {
        throw toolError('GEMINI_EMPTY_IMAGE', 'Gemini returned an empty image; retry the call.');
      }

      const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
      const fileName = `${FILE_PREFIX}${stamp}-${randomBytes(3).toString('hex')}${suffix}`;
      const target = join(OUTPUT_DIR, fileName);
      await mkdir(OUTPUT_DIR, { recursive: true });
      await writeFile(target, data);

      // The attachment is what the transcript renders and what the model sees;
      // its failure must not lose the file that is already on disk.
      let image;
      try {
        const attachments = ctx.get('attachments');
        if (attachments !== undefined) {
          const ref = await attachments.saveImage({ data, mediaType: generated.mediaType, name: fileName });
          image = {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            ...(ref.width === undefined ? {} : { width: ref.width }),
            ...(ref.height === undefined ? {} : { height: ref.height }),
            ...(ref.name === undefined ? {} : { name: ref.name }),
          };
        }
      } catch (error) {
        ctx.logger?.warn?.(
          'gemini-image: stored the file but not the inline attachment: %s',
          error instanceof Error ? error.message : String(error)
        );
      }

      // Only after the new image is durable: drop the older ones from the model
      // context unless the profile asked to keep them all.
      if (liveValue(config?.keepAllImages, false) !== true) trimEarlierImages(session, ctx.logger);

      return {
        path: target,
        mediaType: generated.mediaType,
        bytes: data.byteLength,
        aspectRatio,
        imageSize,
        ...(generated.caption.length === 0 ? {} : { caption: generated.caption }),
        ...(image === undefined ? {} : { image }),
      };
    },
  };

  ctx.effect(() => ctx.tools.register(definition), 'gemini-image: generate_image');
}
