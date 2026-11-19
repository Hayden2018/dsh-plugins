/**
 * Preset-side tool policy for the bundled Chat mode.
 *
 * Chat answers with web research and the knowledge graph only. Its preset
 * mounts nothing but the web tools, so the tools it could still see come from
 * two other places, and they need two different mechanisms:
 *
 * - Global tools registered at the composition root by other bundles (working
 *   directory, agent team, the browser bundle, session search, …). This row
 *   restricts them inside the Chat preset's scope, which every Agent composed
 *   into that preset inherits, and re-sweeps on `tools/change` so a bundle
 *   installed later is caught too.
 * - Tools a Host plugin registers in the Agent's OWN scope — the CUA provider's
 *   `cua_run_code` is one. Those are exempt from every scoped restriction by
 *   design (a scope's own registrations survive its own filters), so a
 *   restriction cannot hide them. The row therefore also installs a filtered
 *   native tool executor in the preset scope: it narrows the model-facing
 *   catalog in `describe()` and keeps native execution semantics by subclassing
 *   the deployment's own executor class, resolved from the installed Host.
 *
 * A `tools/pre-execute` guard closes the last gap: a call outside the allowlist
 * fails with a clear reason even though the schema is no longer advertised.
 *
 * Names are kept by exact match (`web_search`, `web_fetch`) or by the `kg_`
 * prefix, the Knowledge Graph bundle's tools. Prefix matching means a profile
 * without that bundle simply has none to keep, and an Agent without any of them
 * still composes.
 *
 * All three contributions are owned by the preset scope: they lift when the
 * preset unloads and never touch another preset's or the global view.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin name for loader diagnostics. */
export const name = 'prompt-editor-chat-tools';

/** The tool registry is the only service this row requires to activate. */
export const inject = ['tools'];

/** Plugin package holding the deployment's native tool executor class. */
const EXECUTOR_PACKAGE = '@deepseek-ai/dsh-tool-executor-native';

/** Preset-mounted web tools; kept even if another layer registers the names. */
const KEPT_TOOLS = new Set(['web_search', 'web_fetch']);

/** Name prefix of the Knowledge Graph bundle's tools. */
const KEPT_PREFIX = 'kg_';

export const Config = z.object({
  /**
   * Absolute module path of the deployment's native tool executor. Empty asks
   * this row to resolve the package from the installed Host.
   */
  executorPath: z.string().default(''),
});

/** Whether one tool is allowed to remain visible in Chat mode. */
function kept(name) {
  return KEPT_TOOLS.has(name) || name.startsWith(KEPT_PREFIX);
}

/**
 * Resolve a module namespace for the executor package.
 * @param requireFrom - `createRequire` base filename, or undefined for a bare import.
 * @returns the imported namespace.
 */
async function importExecutorFrom(requireFrom) {
  const specifier =
    requireFrom === undefined
      ? EXECUTOR_PACKAGE
      : pathToFileURL(createRequire(requireFrom).resolve(EXECUTOR_PACKAGE)).href;
  return import(specifier);
}

/**
 * Load the deployment's native tool executor class.
 *
 * The plugin's own module scope cannot see the Host's packages: the bundle is
 * a linked package with only its declared dependencies beside it. The class is
 * therefore resolved from the same installed Host the Loader uses, through the
 * profile directory, the installation directory, or the Loader's own resolver.
 * @param ctx - preset scope context.
 * @param config - row config, which may pin the module path.
 * @returns the class, or undefined when no base provides it.
 */
async function loadNativeToolExecutor(ctx, config) {
  const pinned = typeof config?.executorPath === 'string' ? config.executorPath.trim() : '';
  if (pinned.length > 0) {
    try {
      return await import(pathToFileURL(pinned).href);
    } catch (error) {
      ctx.logger?.warn?.(`prompt-editor: cannot import the pinned tool executor: ${String(error)}`);
    }
  }

  const bases = [];
  const profileDir = ctx.get('profileContext')?.dir;
  if (typeof profileDir === 'string' && profileDir.length > 0) bases.push(join(profileDir, 'package.json'));
  const installDir = (process.env.DSH_INSTALL_DIR ?? '').trim();
  if (installDir.length > 0) bases.push(join(installDir, 'package.json'));
  for (const base of bases) {
    try {
      return await importExecutorFrom(base);
    } catch {
      // Try the next installation base.
    }
  }

  const loader = ctx.get('loader');
  if (loader !== undefined) {
    try {
      return await loader.import(EXECUTOR_PACKAGE);
    } catch {
      // Fall through to a plain import.
    }
  }
  try {
    return await importExecutorFrom(undefined);
  } catch {
    return undefined;
  }
}

/**
 * Mount a native executor whose catalog keeps only this mode's tools.
 * @param ctx - preset scope context.
 * @param config - row config.
 */
async function mountFilteredExecutor(ctx, config) {
  const namespace = await loadNativeToolExecutor(ctx, config);
  const NativeToolExecutor = namespace?.NativeToolExecutor ?? namespace?.default?.NativeToolExecutor;
  if (typeof NativeToolExecutor !== 'function') {
    ctx.logger?.warn?.(
      'prompt-editor: the native tool executor could not be loaded; tools registered in the Agent scope stay visible in Chat'
    );
    return;
  }
  /** Native execution with this mode's tool catalog. */
  class ChatToolExecutor extends NativeToolExecutor {
    describe(definitions) {
      return super.describe(definitions.filter((definition) => kept(definition.name)));
    }
  }
  ctx.tools.setExecutor(new ChatToolExecutor(ctx));
}

/**
 * Deny every other tool in this preset's scope.
 * @param ctx - preset scope context; the restriction applies to its Agents.
 * @param config - row config.
 */
export async function apply(ctx, config) {
  /** Global names this row already denied; each is denied once. */
  const denied = new Set();
  /** Restriction disposers, lifted with the preset although teardown also does it. */
  const lifts = [];
  let disposed = false;
  let sweeping = false;
  let again = false;

  /** Deny one batch, keeping `denied` truthful when the registry refuses it. */
  const deny = (names) => {
    for (const name of names) denied.add(name);
    try {
      lifts.push(ctx.tools.restrict({ deny: names }));
    } catch (error) {
      for (const name of names) denied.delete(name);
      ctx.logger?.warn?.(
        `prompt-editor: could not hide global tools in Chat mode: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  /**
   * Deny newly seen global tools. `restrict()` emits `tools/change` itself, so
   * a sweep that is already running records the re-entry and loops instead of
   * nesting.
   */
  const sweep = () => {
    if (disposed) return;
    if (sweeping) {
      again = true;
      return;
    }
    sweeping = true;
    try {
      do {
        again = false;
        let names;
        try {
          names = ctx.tools
            .definitions()
            .map((definition) => definition.name)
            .filter((name) => !denied.has(name) && !kept(name));
        } catch (error) {
          // A registry that cannot be read leaves the preset usable with the
          // tools it already has; the next change retries.
          ctx.logger?.warn?.(
            `prompt-editor: could not read the global tool registry: ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        if (names.length > 0) deny(names);
      } while (again && !disposed);
    } finally {
      sweeping = false;
    }
  };

  sweep();
  ctx.on('tools/change', sweep);

  // Hiding a schema is not an execution policy: refuse a call outside the
  // allowlist as well, including tools another plugin registered in this
  // Agent's own scope.
  ctx.tools.guard((execution) =>
    kept(execution.name)
      ? undefined
      : { reason: `The "${execution.name}" tool is not available in Chat mode.` }
  );

  ctx.effect(
    () => () => {
      disposed = true;
      for (const lift of lifts.splice(0)) {
        try {
          lift();
        } catch {
          // The preset scope already disposed this restriction.
        }
      }
      denied.clear();
    },
    'prompt-editor: Chat tool filter'
  );

  try {
    await mountFilteredExecutor(ctx, config);
  } catch (error) {
    // Keep the mode usable: the registry restriction and the guard still apply.
    ctx.logger?.warn?.(`prompt-editor: filtered tool executor unavailable: ${String(error)}`);
  }
}
