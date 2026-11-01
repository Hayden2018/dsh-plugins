/**
 * Prompt Editor Host half.
 *
 * Adds one agent-scoped prompt section per live Agent. The section is captured
 * when the Agent is created (and refreshed when a blank Session switches agent
 * preset) from the per-preset text stored on this plugin's Config. The section
 * is appended after every first-party section and is literal text.
 *
 * The preview route assembles a preset's standing scope without creating a
 * Session or Agent, so the settings page can show what that mode really
 * contributes before the user edits anything.
 */

import z from '@deepseek-ai/schemastery';

export const name = 'prompt-editor';

/** The prompt registry is the reason this plugin exists. */
export const inject = ['systemPrompt'];

export const Config = z.object({
  /**
   * Per-preset appended text. The whole map is volatile so the settings page
   * can edit it live without remounting this plugin.
   */
  prompts: z.dict(z.string()).default({}).volatile(),
});

const SECTION_NAME = 'prompt-editor:appended';
const SECTION_ORDER = 20_000;
const PREVIEW_PATH = '/prompt-editor/preview';
const MAX_PREVIEW_CHARS = 200_000;

/** Read the current plain prompt map from a volatile Config reference. */
function promptMap(config) {
  const value = config?.prompts;
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get() ?? {};
  }
  return value ?? {};
}

/** Return the appended text configured for one preset (or the shared fallback). */
function textFor(config, preset) {
  const map = promptMap(config);
  const specific = map[preset];
  if (typeof specific === 'string') return specific;
  const fallback = map['*'];
  return typeof fallback === 'string' ? fallback : '';
}

/** Resolve the preset currently composed into an Agent without creating anything. */
function presetOf(ctx, agent) {
  const presets = ctx.get('agentPresets');
  if (presets !== undefined) {
    try {
      const id = presets.composedPreset?.(agent.ctx);
      if (typeof id === 'string' && id.length > 0) return id;
    } catch {
      // An Agent without a preset binding is a normal fallback case.
    }
  }
  const header = agent?.session?.header?.agentPreset;
  return typeof header === 'string' && header.length > 0 ? header : '*';
}

/** Interpolate a preview without making an unresolved variable fail the read. */
function renderPreviewSections(sections, variables, unresolved) {
  return sections
    .map((section) => {
      if (section.interpolate === false) return section.text;
      return section.text.replace(/\{\{([^{}]*)\}\}/g, (whole, name) => {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) {
          unresolved.add(name.length === 0 ? '{{}}' : name);
          return whole;
        }
        if (!Object.prototype.hasOwnProperty.call(variables, name) || variables[name] === undefined) {
          unresolved.add(name);
          return whole;
        }
        return String(variables[name]);
      });
    })
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/** One JSON response for the preview route. */
function sendJson(res, status, value, head = false) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  if (head) res.end();
  else res.end(body);
}

/** Describe an error without exposing a stack to the browser. */
function errorView(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'preview-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Assemble one preset's system prompt without creating a Session or Agent.
 * @param routeCtx - context carrying systemPrompt and optional agentPresets.
 * @param presetId - explicit preset, or undefined for the current default.
 */
async function buildPreview(routeCtx, presetId) {
  const presets = routeCtx.get('agentPresets');
  const warnings = [
    'This preview shows system-prompt sections only. Tool schemas and runtime context are not included.',
  ];
  let lease;
  try {
    if (presets !== undefined) {
      lease = presetId === undefined ? await presets.acquireScope() : await presets.acquireScope(presetId);
    } else {
      warnings.push('Agent presets are unavailable; this preview uses the global composition.');
    }

    const assembly = await routeCtx.systemPrompt.assemble(lease === undefined ? {} : { scope: lease.key });

    // A fresh Session has a default provider/model; fill those two built-in
    // variables so the common persona template renders in the preview.
    const variables = { ...assembly.variables };
    try {
      const selection = routeCtx.get('agentDefaultModel')?.currentSelection?.();
      if (selection !== undefined && selection !== null) {
        if (variables.provider === undefined) variables.provider = selection.provider;
        if (variables.model === undefined) variables.model = selection.model;
      }
    } catch {
      // The preview remains useful with unresolved variables.
    }

    const unresolved = new Set();
    let prompt = renderPreviewSections(assembly.sections, variables, unresolved);
    if (prompt.length > MAX_PREVIEW_CHARS) {
      prompt = `${prompt.slice(0, MAX_PREVIEW_CHARS)}\n\n… preview truncated …`;
      warnings.push(`The preview was truncated at ${MAX_PREVIEW_CHARS} characters.`);
    }

    const likelyComplete = assembly.sections.length === 1;
    if (assembly.sections.length === 0) {
      warnings.push('This composition currently contributes no system-prompt sections.');
    }
    if (unresolved.size > 0) {
      warnings.push(`Unresolved template variables: ${[...unresolved].join(', ')}.`);
    }

    return {
      ok: true,
      preset: presetId ?? (presets === undefined ? null : (presets.defaultId ?? null)),
      sectionCount: assembly.sections.length,
      sectionNames: assembly.sections.map((section) => section.name),
      likelyComplete,
      prompt,
      warnings,
    };
  } catch (error) {
    return { ok: false, error: errorView(error), warnings };
  } finally {
    if (lease !== undefined) {
      try {
        await lease[Symbol.asyncDispose]();
      } catch {
        // A retained preset revision is allowed to fail its final collection.
      }
    }
  }
}

/**
 * Mount the prompt section and the authenticated preview route.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin Config.
 */
export function apply(ctx, config) {
  /** One captured section per live Agent. */
  const entries = new Map();

  const disposeEntry = (entry) => {
    try {
      entry.dispose();
    } catch (error) {
      ctx.logger?.warn?.(`prompt-editor: section disposal failed: ${String(error)}`);
    }
  };

  ctx.on('agent/created', ({ agent }) => {
    if (agent?.ctx?.systemPrompt === undefined) return;
    try {
      const capture = { text: textFor(config, presetOf(ctx, agent)) };
      const dispose = agent.ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        // User-authored text is literal; braces must not become variables.
        interpolate: false,
        text: () => capture.text,
      });
      entries.set(agent.id, { capture, dispose });
    } catch (error) {
      // Never fail Agent creation because the optional prompt addition failed.
      ctx.logger?.warn?.(`prompt-editor: could not attach to agent ${String(agent?.id)}: ${String(error)}`);
    }
  });

  // A Session may switch preset while it is still blank. Keep the captured
  // text aligned with the newly mounted composition.
  ctx.on('agent-preset/selected', (sessionId, preset) => {
    const entry = entries.get(sessionId);
    if (entry !== undefined) entry.capture.text = textFor(config, preset);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const entry = entries.get(agent?.id);
    if (entry === undefined) return;
    entries.delete(agent.id);
    disposeEntry(entry);
  });

  ctx.effect(
    () => () => {
      for (const entry of entries.values()) disposeEntry(entry);
      entries.clear();
    },
    'prompt-editor: prompt sections'
  );

  // Preview route: authenticated, read-only, and no Session is created.
  ctx.inject(['webServer', 'connection', 'systemPrompt'], (routeCtx) => {
    const handler = async (req, res) => {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }

      let rejection;
      try {
        rejection = routeCtx.connection.requestRejection(req);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: errorView(error) }, method === 'HEAD');
        return;
      }
      if (rejection !== undefined) {
        res.writeHead(rejection);
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }

      let presetId;
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const raw = url.searchParams.get('preset');
        if (raw !== null && raw.length > 0 && raw !== '*') {
          if (raw.length > 160 || /[\u0000-\u001f\u007f]/.test(raw)) {
            sendJson(
              res,
              400,
              { ok: false, error: { code: 'invalid-preset', message: 'Invalid preset id.' } },
              method === 'HEAD'
            );
            return;
          }
          presetId = raw;
        }
      } catch {
        sendJson(
          res,
          400,
          { ok: false, error: { code: 'invalid-url', message: 'Invalid request URL.' } },
          method === 'HEAD'
        );
        return;
      }

      const preview = await buildPreview(routeCtx, presetId);
      sendJson(res, 200, preview, method === 'HEAD');
    };

    routeCtx.effect(
      () => routeCtx.webServer.register({ kind: 'exact', path: PREVIEW_PATH, handler }),
      'prompt-editor: preview route'
    );
  });
}
