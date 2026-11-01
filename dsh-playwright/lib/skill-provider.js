/**
 * playwright-browser-tips — bundled English site-map skill provider.
 *
 * The framework is code-owned in assets/skill-template.en.md; the community
 * site data is in assets/site-map.json (shape documented in
 * SITE-MAP-SPEC.md). Only the table is generated from contributed entries.
 *
 * Requires a profile with the `skills` service. Base-backed profiles such as
 * web, headless, acp, and sdk-app provide it.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderSkillTemplate } from './site-map.js';

const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url));
const TEMPLATE_URL = new URL('../assets/skill-template.en.md', import.meta.url);
const SITE_MAP_URL = new URL('../assets/site-map.json', import.meta.url);
// Mirrors @deepseek-ai/dsh-skill BUNDLED_SKILL_RANK (600) without importing
// the harness package: same precedence layer as other packaged providers,
// still overridable by same-name project/user skills.
const RANK = 600;
const INVOCATION = { modelInvocable: true, userInvocable: true };
const DESCRIPTION =
  'Site map for the playwright-browser browser_* tools: per-site facts and tactics maintained from real testing (search engines, anti-automation behavior), plus recovery patterns for failed selectors and empty extracts. Use before automating a site for the first time, when a browser_* tool fails or returns empty, or when automating search or login flows.';

const CANDIDATE = {
  name: 'playwright-browser-tips',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: 'playwright-browser-tips',
  source: 'bundled',
  resourceBase: { kind: 'directory', path: ASSETS_DIR },
  rank: RANK,
  locator: TEMPLATE_URL,
};

/** Render the English framework with the contributed site table injected. */
async function renderBody() {
  const [template, rawMap] = await Promise.all([
    readFile(TEMPLATE_URL, 'utf8'),
    readFile(SITE_MAP_URL, 'utf8'),
  ]);
  const { sites } = JSON.parse(rawMap);
  return renderSkillTemplate(template, sites);
}

const provider = {
  name: 'playwright-browser-tips',
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate) {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: CANDIDATE.resourceBase,
      content: await renderBody(),
    };
  },
};

/** Cordis plugin name. */
export const name = 'playwright-browser-tips';
/** Service required by the skill registry. */
export const inject = ['skills'];

/** Register the tips provider on ctx.skills. */
export function apply(ctx) {
  ctx.skills.registerProvider(() => provider);
}
