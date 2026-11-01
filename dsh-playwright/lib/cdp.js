import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { FAST_TIMEOUT_MS } from './settings.js';
import { throwIfAborted, withAbort } from './async.js';

function channelProfileDirs(channel) {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    if (channel === 'chrome') return [path.join(home, 'Library/Application Support/Google/Chrome')];
    if (channel === 'msedge') return [path.join(home, 'Library/Application Support/Microsoft Edge')];
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    if (channel === 'chrome') return [path.join(local, 'Google/Chrome/User Data')];
    if (channel === 'msedge') return [path.join(local, 'Microsoft/Edge/User Data')];
  } else {
    if (channel === 'chrome')
      return [path.join(home, '.config/google-chrome'), path.join(home, '.config/chromium')];
    if (channel === 'msedge') return [path.join(home, '.config/microsoft-edge')];
  }
  return [];
}

function readDevToolsActivePort(channel) {
  for (const dir of channelProfileDirs(channel)) {
    const file = path.join(dir, 'DevToolsActivePort');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split('\n');
    const port = Number.parseInt(String(lines[0] || '').trim(), 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    let wsPath = String(lines[1] || '').trim();
    if (wsPath && !wsPath.startsWith('/')) wsPath = `/${wsPath}`;
    return { dir, file, port, wsPath };
  }
  return null;
}

function channelWsEndpoint(channel) {
  const info = readDevToolsActivePort(channel);
  if (!info) {
    const dirs = channelProfileDirs(channel).join(', ') || '(unsupported platform)';
    throw new Error(
      `Could not connect to ${channel}: DevToolsActivePort was not found under ${dirs}. Open chrome://inspect/#remote-debugging and turn on "Allow remote debugging for this browser instance".`
    );
  }
  // Preserve Chrome's full DevToolsActivePort path: the GUID on line two is required
  // on newer Chrome, and Playwright's built-in channel resolver drops it.
  return `ws://127.0.0.1:${info.port}${info.wsPath}`;
}

export function cdpCandidates(endpoint) {
  if (!endpoint) return [];
  const list = endpoint === 'auto' ? ['chrome', 'http://127.0.0.1:9222'] : String(endpoint).split(',');
  const candidates = [];
  for (const item of list) {
    const candidate = item.trim();
    if (!candidate) continue;
    if (candidate === 'chrome' || candidate === 'msedge') {
      try {
        candidates.push(channelWsEndpoint(candidate));
      } catch {
        // An unavailable channel is skipped so later configured fallbacks still run.
      }
      continue;
    }
    candidates.push(candidate);
  }
  return candidates;
}

function endpointUrl(endpoint) {
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function endpointPort(url) {
  if (!url) return null;
  const defaultPort = url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
  const port = Number(url.port || defaultPort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function endpointHost(url) {
  return url ? url.hostname.replace(/^\[|\]$/g, '') : null;
}

function httpBase(endpoint) {
  const url = endpointUrl(endpoint);
  if (!url) return null;
  const websocket = url.protocol === 'ws:' || url.protocol === 'wss:';
  url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (websocket) {
    // A browser WS URL ends in /devtools/browser/<guid>; retain a reverse-proxy
    // prefix while probing its HTTP /json endpoints.
    pathname = pathname.replace(/\/devtools\/browser(?:\/[^/]*)?$/i, '');
  }
  url.pathname = pathname || '/';
  url.search = '';
  url.hash = '';
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
}

function portLive(port, host, timeout = 400, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = net.connect({ port, host });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      sock.destroy();
      callback(value);
    };
    const timer = setTimeout(() => finish(resolve, false), timeout);
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        finish(reject, error);
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    sock.once('connect', () => finish(resolve, true));
    sock.once('timeout', () => finish(resolve, false));
    sock.once('error', () => finish(resolve, false));
  });
}

async function httpProbe(url, signal) {
  try {
    const response = await withAbort(fetch(url, { signal: AbortSignal.timeout(FAST_TIMEOUT_MS) }), signal);
    let body = null;
    if (response.ok) {
      try {
        body = await withAbort(response.json(), signal);
      } catch {
        throwIfAborted(signal);
      }
    }
    const looksLikeCdp = Boolean(
      body &&
      (typeof body.webSocketDebuggerUrl === 'string' ||
        (typeof body.Browser === 'string' && typeof body['Protocol-Version'] === 'string'))
    );
    return { status: response.status, looksLikeCdp };
  } catch {
    throwIfAborted(signal);
    return { status: null, looksLikeCdp: false };
  }
}

async function listTargetsForDiagnosis(endpoint, signal) {
  const base = httpBase(endpoint);
  if (!base) return null;
  try {
    const response = await withAbort(
      fetch(`${base}/json/list`, { signal: AbortSignal.timeout(FAST_TIMEOUT_MS) }),
      signal
    );
    if (!response.ok) return null;
    const list = await withAbort(response.json(), signal);
    const pages = (Array.isArray(list) ? list : []).filter((target) => target.type === 'page');
    if (!pages.length) return null;
    return pages.map((target) => `${target.title || '(untitled)'} — ${target.url}`);
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

function matchesKnownActivePort(endpoint, url) {
  if (!url || !['127.0.0.1', 'localhost', '::1'].includes(endpointHost(url))) return false;
  const port = endpointPort(url);
  if (!port) return false;
  for (const channel of ['chrome', 'msedge']) {
    const info = readDevToolsActivePort(channel);
    if (!info || info.port !== port) continue;
    if (!url.pathname || url.pathname === '/' || url.pathname === info.wsPath) return true;
  }
  return false;
}

/** Returns English diagnostics and whether a proven relevant timeout should stop fallbacks. */
export async function diagnoseEndpoint(endpoint, error, signal) {
  throwIfAborted(signal);
  const full = String(error && error.message ? error.message : error);
  const first = full.split('\n')[0];
  const handshakeDone = /<ws connected>/.test(full);
  const url = endpointUrl(endpoint);
  const port = endpointPort(url);
  const host = endpointHost(url);
  const lines = [first];
  let listening = false;
  if (port && host) {
    listening = await portLive(port, host, 400, signal);
    lines.push(`port ${host}:${port}: ${listening ? 'listening' : 'NOT listening'}`);
  }

  const base = httpBase(endpoint);
  let probe = { status: null, looksLikeCdp: false };
  if (base) {
    const probeUrl = `${base}/json/version`;
    probe = await httpProbe(probeUrl, signal);
    lines.push(`${probeUrl} → HTTP ${probe.status === null ? 'no response' : probe.status}`);
  }

  const activePortMatch = matchesKnownActivePort(endpoint, url);
  for (const channel of ['chrome', 'msedge']) {
    const info = readDevToolsActivePort(channel);
    if (info) {
      lines.push(
        `DevToolsActivePort(${channel}): ${info.dir} → port ${info.port}, path ${info.wsPath || '(none)'}`
      );
    }
  }

  const timeout = /\btimeout\b|timed out|time out/i.test(first);
  const stopRetrying = Boolean(
    listening && timeout && (handshakeDone || probe.looksLikeCdp || activePortMatch)
  );
  if (stopRetrying) {
    if (handshakeDone) {
      lines.push(
        'HINT: the WebSocket handshake completed, but initialization did not finish. Attaching waits for existing tabs to initialize; a stuck renderer or paused debugger may be responsible. Close the unresponsive tab and retry, or lower PW_CDP_TIMEOUT to fail faster.'
      );
      const pages = await listTargetsForDiagnosis(endpoint, signal);
      if (pages) lines.push(`Current page targets (to identify a stuck tab):\n  ${pages.join('\n  ')}`);
    } else {
      lines.push(
        'HINT: the endpoint appears to be a live CDP service, but the WebSocket handshake timed out. Chrome may be waiting for approval in an "Allow remote debugging?" dialog. Approve the connection and retry; raise PW_CDP_TIMEOUT if you need more time.'
      );
    }
  }
  return { blob: lines.join('\n'), stopRetrying };
}
