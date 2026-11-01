# Site map specification

The `playwright-browser-tips` skill renders its site table from `assets/site-map.json`. Contributions should change only that data file. The English template and framework guidance are code-owned. English is the sole maintained language for the map and skill; do not add Han characters to plugin-owned prose. The validator checks the data shape, English-owned strings, the exact template placeholder, and rendered table rows.

## Entry schema (version 1)

`assets/site-map.json` must be an object:

| Field     | Type   | Rules                                                                                                         |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `version` | number | Must be `1`.                                                                                                  |
| `sites`   | array  | Must contain at least one entry. Array order is priority order: earlier rows win when multiple entries apply. |

Each item in `sites` is an object with these fields:

| Field                | Type             | Rules                                                                                                                                                                                       |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`             | string           | Bare lowercase hostname with no scheme or path, such as `example.com`.                                                                                                                      |
| `site`               | string           | Display name, such as `Example`.                                                                                                                                                            |
| `task`               | string           | Task covered, such as `search`, `login`, or `download`. Use one entry per `domain` + `task`.                                                                                                |
| `behavior`           | string           | What the site actually does under automation, based on observation.                                                                                                                         |
| `tactic`             | string           | What the agent should do while respecting the boundary below.                                                                                                                               |
| `lastVerified`       | string           | Real calendar date in `YYYY-MM-DD` format.                                                                                                                                                  |
| `verifiedBy`         | string, optional | Provenance, such as `playwright-browser 0.2.0` or a GitHub handle.                                                                                                                          |
| `manualIntervention` | `true`, optional | Include when the task needs a human step, such as CAPTCHA completion, login, or waiting out a rate limit. Say what the human needs to do in `tactic`; omit this field for autonomous tasks. |

## Content rules

1. **Describe behavior, not structure.** Explain what the site does and what to do about it. Do not include CSS selectors, XPath, or DOM paths; they become stale and can mislead the agent.
2. **Do not circumvent defenses.** Tactics must not defeat CAPTCHAs, sliders, hidden elements, or bot detection. Detect a block, stop retrying, switch to an alternative, or hand off honestly. The user completes CAPTCHAs; the agent never does.
3. **Keep observations current.** A row claims to have been verified on its date. Re-check before changing `lastVerified`, and remove entries that no longer hold.
4. **Keep each entry focused.** Use one row per site and task. If a tactic needs several sentences, narrow the entry.
5. **Write English-only owned text.** Do not add Han characters to map fields or the English skill framework. Browser output may contain any language; report it as observed without stripping or rewriting that content.

## Verification runbook

Every new entry must come from a real run against the live site using the plugin's launch configuration. The DuckDuckGo entry (2026-09-03) is an example of the full loop:

1. Drive the real task with the plugin's `playwright-core`, `PW_CHROMIUM_PATH` or automatic browser discovery, and the task's natural steps. A failed first attempt is useful evidence, not noise.
2. Characterize a failure before concluding. Re-run with diagnostics such as page title, available form controls, and full body text. A short body excerpt can hide a challenge or login notice.
3. Run a control on the same network path. For search, Bing is the known working control in this map. Without a control, an environment failure can be mistaken for a site fact.
4. Record only observable behavior and a tactic that switches or hands off instead of circumventing. Set today's date and provenance.
5. Validate the contribution with `node scripts/validate-site-map.js` and include its output in the pull request.

A minimal probe for step 1 (adjust the URL and task steps as appropriate):

```bash
cd <plugin checkout> && node --input-type=module -e "
import { chromium } from 'playwright-core'
import { BROWSER_LOCALE, CHROMIUM_PATH } from './lib/settings.js'
const browser = await chromium.launch({
  headless: process.env.PW_HEADLESS !== 'false',
  executablePath: CHROMIUM_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const page = await (await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: BROWSER_LOCALE,
  })).newPage()
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
  console.log('title:', await page.title())
} finally {
  await browser.close()
}
"
```

Agents submitting entries should include relevant probe output or transcript excerpts and the control-run result in the pull request description.

## Validation

After editing `assets/site-map.json`, run:

```bash
node scripts/validate-site-map.js
```

The validator checks the schema, true calendar dates, English-owned text, the template's single exact `{{SITE_MAP}}` placeholder, and that every site row is rendered into the skill table. Include its output with the contribution.
