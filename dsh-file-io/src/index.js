/**
 * Browser transfers for the workspace file view, Host half.
 *
 * Registers two authenticated Fetch routes:
 *
 *  - `/api/file-download` (GET/HEAD) streams any file the Sidebar previews as
 *    an attachment.
 *  - `/api/file-upload` (POST) receives one browser file into the workspace
 *    directory the file view displays.
 *
 * Both live under `/api`, so the Connection carrier applies its trust fence and
 * browser authentication before either handler runs — the same boundary
 * `/api/file` uses, so the download route reads exactly the files the Host
 * already exposes.
 *
 * Why a dedicated download route instead of `/api/file`:
 *  - `/api/file` answers with `Content-Type` and no `Content-Disposition`, so a
 *    remote browser renders the file (PDF viewer, XLSX grid) instead of saving
 *    it, and it caps the body at the image-attachment limit (~20 MB), which a
 *    real PDF or workbook can exceed.
 *  - This route always answers `Content-Disposition: attachment`, streams in
 *    chunks instead of buffering, carries no image-sized cap, and supports
 *    `Range` so a resumed download picks up where it stopped.
 *
 * Why an upload route at all: the filesystem seam is read-only for binary
 * content (`writeText` is UTF-8 only), so a workspace upload has to publish raw
 * bytes itself. The route confines the destination to the session's workspace
 * root, stages the body in a hidden sibling file, and renames it into place
 * only after the transfer finishes — an interrupted or refused upload leaves
 * no trace in the workspace.
 *
 * Neither route is restricted by extension: authentication is the access
 * boundary, exactly as it is for `/api/file`.
 */
import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

/** Exact pathname claimed on the shared `/api` Fetch channel for downloads. */
const ROUTE_PATH = '/api/file-download';

/** Exact pathname claimed on the shared `/api` Fetch channel for uploads. */
const UPLOAD_PATH = '/api/file-upload';

/** Inclusive byte cap on one uploaded file: 100 MiB. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Longest accepted file name in UTF-8 bytes, the smallest common filesystem cap. */
const MAX_UPLOAD_NAME_BYTES = 255;

/** Bytes read from the filesystem per stream pull. */
const CHUNK_BYTES = 1024 * 1024;

/** Headers every response carries: private, sniff-proof, and not cached. */
const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Escape one value for an RFC 5987 `filename*` parameter.
 *
 * `encodeURIComponent` leaves a handful of characters that the grammar
 * excludes from `attr-char` (`'`, `(`, `)`, `*`), so a filename such as
 * `report (final).pdf` would otherwise produce a header some parsers reject.
 * @param {string} value - Raw filename.
 * @returns {string} the percent-encoded parameter value.
 */
function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Build the ASCII-only fallback name of a `Content-Disposition` header.
 *
 * The grammar's quoted-string is ASCII on purpose; anything else is replaced so
 * a legacy client that ignores `filename*` still saves a plausible name
 * instead of a broken header.
 * @param {string} name - Raw filename.
 * @returns {string} an ASCII fallback, never empty.
 */
function asciiFallback(name) {
  const replaced = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  return replaced.length === 0 ? 'download' : replaced;
}

/**
 * Build the `Content-Disposition: attachment` value for one filename.
 *
 * Both the ASCII fallback and the UTF-8 form are sent, so a Chinese filename
 * survives in every browser while an old one still gets a usable name.
 * @param {string} name - Raw filename, typically the file's base name.
 * @returns {string} the header value.
 */
function contentDisposition(name) {
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/**
 * Resolve a `Range` header against one file's length.
 * @param {string | null} header - Raw request header, or null when absent.
 * @param {number} size - Complete file size in bytes.
 * @returns {{start: number, end: number} | "invalid" | undefined} the window,
 *   `"invalid"` when the header asks outside the file, or `undefined` to serve
 *   the complete body.
 */
function parseRange(header, size) {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return undefined;
  const [, first, last] = match;
  if (first === '' && last === '') return undefined;
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return 'invalid';
  return { start, end };
}

/**
 * Stream `[start, start + length)` out of one resolved file without buffering
 * the complete content.
 * @param {object} fs - Host filesystem service.
 * @param {object} target - Resolved filesystem target.
 * @param {number} start - 0-based first byte.
 * @param {number} length - Byte count to send.
 * @param {AbortSignal} signal - Request lifetime; aborts a read when the client leaves.
 * @returns {ReadableStream<Uint8Array>} the response body.
 */
function streamBytes(fs, target, start, length, signal) {
  let offset = start;
  let remaining = length;
  return new ReadableStream({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const want = Math.min(CHUNK_BYTES, remaining);
      let bytes;
      try {
        bytes = await fs.readByteRange(target, { offset, length: want }, signal);
      } catch (error) {
        // A vanished client aborts the read; closing is the clean end of an
        // already-gone response, while a real read fault must surface.
        if (signal.aborted) {
          try {
            controller.close();
          } catch {
            /* The stream is already closed by the client. */
          }
          return;
        }
        controller.error(error);
        return;
      }
      if (bytes.byteLength === 0) {
        controller.close();
        return;
      }
      try {
        controller.enqueue(bytes);
      } catch {
        return;
      }
      offset += bytes.byteLength;
      remaining -= bytes.byteLength;
    },
  });
}

/**
 * Plain-text failure with the same private cache policy as a success.
 * @param {Request} request - The request being answered.
 * @param {number} status - HTTP status.
 * @param {string} message - Body text.
 * @returns {Response} the failure response.
 */
function failure(request, status, message) {
  return new Response(request.method === 'HEAD' ? null : message, { status, headers: BASE_HEADERS });
}

/**
 * Serve one file as an attachment: metadata, HEAD, and byte ranges.
 * @param {Request} request - Authenticated Fetch request.
 * @param {object} fs - Host filesystem service.
 * @returns {Promise<Response>} the complete response.
 */
async function serve(request, fs) {
  const path = new URL(request.url).searchParams.get('path');
  if (path === null || path.length === 0) return failure(request, 400, 'missing path');
  if (path.includes('\0') || !isAbsolute(path)) return failure(request, 400, 'absolute path required');

  let target;
  let info;
  try {
    target = await fs.resolve(path, { signal: request.signal });
    info = await fs.stat(target, request.signal);
  } catch (error) {
    if (error instanceof Error && typeof error.code === 'string') {
      const status =
        { FS_NOT_FOUND: 404, FS_PERMISSION_DENIED: 403, FS_SANDBOX_DENIED: 403, FS_ABORTED: 499 }[
          error.code
        ] ?? 500;
      return failure(request, status, error.code);
    }
    throw error;
  }
  if (info === undefined) return failure(request, 404, 'not found');
  if (info.type !== 'file') return failure(request, 403, 'not a regular file');

  const displayPath = target.displayPath ?? path;
  const size = info.size ?? 0;
  const range = parseRange(request.headers.get('range'), size);

  /** @type {Record<string, string>} */
  const headers = {
    ...BASE_HEADERS,
    'Accept-Ranges': 'bytes',
    // A download is never rendered: the octet-stream type plus `nosniff`
    // above means no browser can turn this response into a document.
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(basename(displayPath)),
  };

  if (range === 'invalid') {
    headers['Content-Range'] = `bytes */${String(size)}`;
    return new Response(null, { status: 416, headers });
  }

  const window = range === undefined ? { start: 0, end: size - 1 } : range;
  const length = size === 0 ? 0 : window.end - window.start + 1;
  if (range !== undefined)
    headers['Content-Range'] = `bytes ${String(window.start)}-${String(window.end)}/${String(size)}`;
  headers['Content-Length'] = String(length);

  if (request.method === 'HEAD' || length === 0) {
    return new Response(null, { status: range === undefined ? 200 : 206, headers });
  }
  return new Response(streamBytes(fs, target, window.start, length, request.signal), {
    status: range === undefined ? 200 : 206,
    headers,
  });
}

/**
 * Sessions with a transfer in flight. The product rule is one upload at a
 * time; enforcing it here as well as in the browser keeps two tabs (or a retry
 * after a lost response) from racing over the same destination name.
 * @type {Set<string>}
 */
const uploadingSessions = new Set();

/**
 * A refusal the upload route can answer without becoming a 500.
 */
class UploadFailure extends Error {
  /**
   * @param {number} status - HTTP status to answer with.
   * @param {string} code - stable code the browser localizes.
   */
  constructor(status, code) {
    super(code);
    this.name = 'UploadFailure';
    this.status = status;
    this.code = code;
  }
}

/**
 * One file name accepted for creation inside the displayed directory.
 *
 * Only the name's own bytes are accepted: a separator would escape the
 * directory, NUL would truncate the native call, and `.`/`..` name the
 * directory itself. Everything else is handed to the host filesystem, whose
 * refusal arrives as a mapped failure rather than a silent skip.
 * @param {string | null} raw - the `name` query parameter.
 * @returns {string | undefined} the accepted name, or undefined to refuse.
 */
function uploadFileName(raw) {
  if (raw === null || raw.length === 0) return undefined;
  if (raw === '.' || raw === '..' || raw.includes('\0')) return undefined;
  if (raw.includes('/') || raw.includes('\\')) return undefined;
  for (const character of raw) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return undefined;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_UPLOAD_NAME_BYTES) return undefined;
  return raw;
}

/**
 * Answer one upload refusal as JSON, so the browser can localize the code.
 * @param {Request} request - the request being answered.
 * @param {number} status - HTTP status.
 * @param {string} code - stable failure code.
 * @returns {Response} the failure response.
 */
function uploadFailure(request, status, code) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ ok: false, error: { code } }), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Stream the request body into an open file, enforcing the byte cap before any
 * chunk is written past it.
 * @param {ReadableStream<Uint8Array> | null} body - request body.
 * @param {import("node:fs/promises").FileHandle} handle - staging file.
 * @param {AbortSignal} signal - request lifetime.
 * @returns {Promise<number>} bytes written.
 */
async function writeBody(body, handle, signal) {
  if (body === null) return 0;
  const reader = body.getReader();
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return received;
      received += value.byteLength;
      if (received > MAX_UPLOAD_BYTES) throw new UploadFailure(413, 'upload/too-large');
      await handle.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Discard a request body that a refusal never read.
 *
 * The HTTP bridge answers a streaming route with `Connection: close` when its
 * body was left unread, then destroys the socket — which a browser reports as a
 * network error instead of the refusal the handler wrote. Consuming the body
 * first lets the carrier end the response normally, so a rejected upload still
 * shows its own sentence. The cap keeps an already-oversized body bounded.
 * @param {ReadableStream<Uint8Array> | null} body - request body.
 * @param {AbortSignal} signal - request lifetime.
 * @returns {Promise<void>} resolves once drained, aborted, or over the cap.
 */
async function drainBody(body, signal) {
  if (body === null) return;
  let received = 0;
  try {
    const reader = body.getReader();
    try {
      while (received <= MAX_UPLOAD_BYTES) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) return;
        received += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    // The client left, or the body ran past the cap: the refusal still goes out.
  }
}

/**
 * Map one thrown value onto a JSON refusal.
 * @param {Request} request - the request being answered.
 * @param {unknown} error - the thrown value.
 * @returns {Response} the failure response.
 */
function uploadFailureOf(request, error) {
  if (error instanceof UploadFailure) return uploadFailure(request, error.status, error.code);
  if (request.signal.aborted) return uploadFailure(request, 499, 'upload/aborted');
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  /** @type {Record<string, [number, string] | undefined>} */
  const mapped = {
    FS_NOT_FOUND: [404, 'upload/not-found'],
    FS_PERMISSION_DENIED: [403, 'upload/denied'],
    FS_SANDBOX_DENIED: [403, 'upload/denied'],
    FS_ABORTED: [499, 'upload/aborted'],
    EACCES: [403, 'upload/denied'],
    EPERM: [403, 'upload/denied'],
    ENOENT: [404, 'upload/not-found'],
    ENOSPC: [507, 'upload/no-space'],
    EEXIST: [409, 'upload/exists'],
    EISDIR: [409, 'upload/not-regular-file'],
    EINVAL: [400, 'upload/bad-request'],
  };
  const outcome = code === undefined ? undefined : mapped[code];
  if (outcome !== undefined) return uploadFailure(request, outcome[0], outcome[1]);
  console.warn('[dsh-file-io] upload failed:', error);
  return uploadFailure(request, 500, 'upload/failed');
}

/**
 * Resolve the session's workspace root, the only directory uploads may enter.
 * @param {object} ctx - Host context.
 * @param {string} sessionId - Session identity from the request.
 * @param {AbortSignal} signal - request lifetime.
 * @returns {Promise<string>} the absolute workspace root.
 */
async function workspaceRootOf(ctx, sessionId, signal) {
  const workspaceFiles = ctx.get('workspaceFiles');
  if (workspaceFiles === undefined) throw new UploadFailure(501, 'upload/unsupported');
  const scope = await workspaceFiles.scopeOf(sessionId, signal);
  if (scope === undefined) throw new UploadFailure(404, 'upload/session-unknown');
  return scope.workspaceRoot;
}

/**
 * Receive one file into the displayed workspace directory.
 *
 * The body is staged in a hidden sibling file and published with one rename, so
 * the final name either does not exist or holds the complete file. An existing
 * file is refused: replacing workspace content without a confirmation surface
 * would be a silent data loss.
 * @param {Request} request - authenticated Fetch request.
 * @param {object} ctx - Host context carrying `fs` and the policy services.
 * @param {{sessionId: string, directory: string, name: string, declared: string | null}} input -
 *   validated request fields.
 * @param {{started: boolean}} consumed - set once the body is being read, so a
 *   refusal can tell a body that still needs draining from one already read.
 * @returns {Promise<Response>} the JSON outcome.
 */
async function receive(request, ctx, input, consumed) {
  const { sessionId, directory, name, declared } = input;
  const workspaceRoot = await workspaceRootOf(ctx, sessionId, request.signal);

  // The user action still respects the Session's write policy: a read-only
  // execution world must not receive files through a browser route.
  const policy = ctx.get('sandboxPolicy');
  if (policy !== undefined) {
    const session = ctx.get('sessions')?.get(sessionId);
    if (policy.resolve(session === undefined ? {} : { session }).mode === 'read-only') {
      throw new UploadFailure(403, 'upload/denied');
    }
  }

  const root = await ctx.fs.resolve(workspaceRoot, { signal: request.signal });
  const target = await ctx.fs.resolve(directory, { signal: request.signal });
  const info = await ctx.fs.stat(target, request.signal);
  if (info === undefined) throw new UploadFailure(404, 'upload/not-found');
  if (info.type !== 'directory') throw new UploadFailure(400, 'upload/bad-request');
  if (!ctx.fs.contains(root, target)) throw new UploadFailure(403, 'upload/outside-workspace');

  // Raw bytes need host-filesystem access; a remote execution world cannot be
  // written through that seam, so refuse instead of writing the wrong machine.
  const hostDirectory = ctx.fs.processPathFromHostPath(ctx.fs.processPath(target));
  if (hostDirectory === undefined) throw new UploadFailure(501, 'upload/unsupported');

  const destination = join(hostDirectory, name);
  const existing = await lstat(destination).catch((error) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (existing !== undefined) {
    throw new UploadFailure(409, existing.isFile() ? 'upload/exists' : 'upload/not-regular-file');
  }

  const staging = join(hostDirectory, `.dsh-upload-${randomUUID()}.part`);
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let handle;
  let created = false;
  let published = false;
  try {
    handle = await open(staging, 'wx');
    created = true;
    consumed.started = true;
    const received = await writeBody(request.body, handle, request.signal);
    if (declared !== null && received !== Number(declared)) throw new UploadFailure(400, 'upload/incomplete');
    await handle.close();
    handle = undefined;
    // The final cancellation checkpoint before publication: a client that
    // left has nothing published on its behalf.
    request.signal.throwIfAborted();
    await rename(staging, destination);
    published = true;
    return new Response(JSON.stringify({ ok: true, value: { name, bytes: received } }), {
      headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  } finally {
    await handle?.close().catch(() => {});
    // Only the file this request created may be removed: an `open` that lost
    // the exclusive-create race must not delete the file that won it.
    if (created && !published) await unlink(staging).catch(() => {});
  }
}

/**
 * Serve one workspace upload: validate the request, then receive it.
 * @param {Request} request - authenticated Fetch request.
 * @param {object} ctx - Host context carrying `fs` and the policy services.
 * @returns {Promise<Response>} the JSON outcome.
 */
async function upload(request, ctx) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...BASE_HEADERS, Allow: 'POST' } });
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/octet-stream')
    return uploadFailure(request, 415, 'upload/unsupported-content-type');

  const params = new URL(request.url).searchParams;
  const sessionId = params.get('sessionId');
  const directory = params.get('directory');
  const name = uploadFileName(params.get('name'));
  if (sessionId === null || sessionId.length === 0 || sessionId.length > 256)
    return uploadFailure(request, 400, 'upload/bad-request');
  if (directory === null || directory.length === 0 || directory.includes('\0') || !isAbsolute(directory)) {
    return uploadFailure(request, 400, 'upload/bad-request');
  }
  if (name === undefined) return uploadFailure(request, 400, 'upload/bad-request');

  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) return uploadFailure(request, 400, 'upload/bad-request');
    if (length > MAX_UPLOAD_BYTES) return uploadFailure(request, 413, 'upload/too-large');
  }

  if (uploadingSessions.has(sessionId)) {
    // Same reason as the drained refusals below: an unread streaming body
    // makes the carrier reset the socket, hiding this code from the browser.
    await drainBody(request.body, request.signal);
    return uploadFailure(request, 429, 'upload/busy');
  }
  uploadingSessions.add(sessionId);
  const consumed = { started: false };
  try {
    return await receive(request, ctx, { sessionId, directory, name, declared }, consumed);
  } catch (error) {
    // A refusal decided before the transfer leaves the body unread; drain it
    // so the refusal reaches the browser as a response, not a reset socket.
    if (!consumed.started) await drainBody(request.body, request.signal);
    return uploadFailureOf(request, error);
  } finally {
    uploadingSessions.delete(sessionId);
  }
}

/**
 * Host plugin body: claim `/api/file-download` and `/api/file-upload` for the
 * plugin lifetime.
 *
 * `connection` supplies the authenticated Fetch channel (and therefore the
 * trust fence); `fs` supplies paths, reads, and the execution world's access
 * policy. Upload additionally reads `workspaceFiles`, `sandboxPolicy`, and
 * `sessions` when the deployment mounts them.
 * @param {object} ctx - Host context carrying `connection` and `fs`.
 * @returns {void}
 */
function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => serve(request, ctx.fs),
      }),
    `file-io: GET ${ROUTE_PATH}`
  );

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: UPLOAD_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: (request) => upload(request, ctx),
      }),
    `file-io: POST ${UPLOAD_PATH}`
  );
}

const inject = ['connection', 'fs'];

export {
  apply,
  asciiFallback,
  contentDisposition,
  encodeRfc5987,
  inject,
  MAX_UPLOAD_BYTES,
  parseRange,
  serve,
  upload,
  uploadFileName,
  UPLOAD_PATH,
};
