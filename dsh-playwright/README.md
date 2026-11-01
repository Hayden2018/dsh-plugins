# playwright-browser

[![Release](https://img.shields.io/github/v/release/whklwhkl/dsh-playwright)](https://github.com/whklwhkl/dsh-playwright/releases)
[![License: MIT](https://img.shields.io/github/license/whklwhkl/dsh-playwright)](../LICENSE)

Browser automation for DSH (DeepSeek Harness): a set of `browser_*` tools that use Playwright to open pages, click, fill forms, inspect page content, and take screenshots.

> Compatibility: exercised with [dsh 0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2). The plugin declares `@deepseek-ai/dsh: ^0.2.0-rc.2` in both `peerDependencies` and `engines.dsh`. DSH's plugin compatibility gate rejects an incompatible peer range; update the plugin's declared range when targeting a newer DSH line. The optional peer avoids an unmet-peer warning when the profile supplies DSH itself; it does not bypass the compatibility gate.

- Uses `playwright-core` in the host process; no external bridge service is required.
- Launches a browser on first use and closes a plugin-launched browser when the plugin unloads.
- Can attach to an already-running Chrome or Edge over CDP, reusing its login state, cookies, extensions, and tabs.
- Cancellation settles the tool call promptly. Where Playwright supports cancellation, its signal is forwarded; an underlying API without cancellation support may continue running until it settles.
- Failures are reported as failed tool results. Check `isError` rather than relying on error-message wording.
- Page text, HTML, URLs, and other browser-originated values are returned as received, without language filtering or translation.
- Screenshots are returned as PNG paths and, when the profile attachment service and model support it, as image content.

## Tools

| Tool                 | What it does                                                 |
| -------------------- | ------------------------------------------------------------ |
| `browser_open`       | Open a URL and return the final URL and page title           |
| `browser_status`     | Report browser and current-page state without attaching      |
| `browser_attach`     | Attach to or switch to an already-running browser at runtime |
| `browser_tabs`       | List, select, or close tabs                                  |
| `browser_click`      | Click an element selected by CSS or `text=`                  |
| `browser_type`       | Type character by character, optionally with a delay         |
| `browser_fill`       | Fill an input quickly                                        |
| `browser_press`      | Press a key such as Enter, Tab, or Escape                    |
| `browser_wait`       | Wait for a number of milliseconds                            |
| `browser_extract`    | Extract text from the page or an element                     |
| `browser_html`       | Extract HTML from the page or an element                     |
| `browser_eval`       | Evaluate a JavaScript expression in the page context         |
| `browser_screenshot` | Save a PNG and return its absolute path                      |
| `browser_close`      | Close a launched browser or disconnect from an attached one  |

### Optional arguments and tab selection

Every optional argument accepts `null`, which behaves exactly like omission. Required arguments do not become nullable. For model APIs that require every declared field, use `null` for unused options—not `0` or `""` as placeholders.

```js
browser_tabs({}); // list all tabs
browser_tabs({ index: null, url: null, close: false }); // same list, all fields supplied
browser_tabs({ index: 0, url: null, close: false }); // select tab 0, not list
browser_tabs({ index: null, url: 'portal', close: false }); // match URL or title
browser_tabs({ index: 2, url: null, close: true }); // close tab 2
browser_attach({ endpoint: null, page: 'portal' }); // default endpoint, select a page
```

Tab indices are zero-based non-negative integers. Supply at most one of `index` and `url`; passing both, an empty `url`, or `close: true` without a target is an error. Listing does not require an index.

`browser_open.waitUntil` accepts `commit`, `domcontentloaded` (default), `load`, or `networkidle`. `browser_click`, `browser_type`, and `browser_fill` have an optional element-action `timeout` (default 10000 ms); navigation defaults to 30000 ms. An explicit timeout of `0` disables that Playwright timeout. `browser_wait.ms: 0` does not wait, and extraction `limit: 0` returns an empty result.

## Install into a DSH profile

From any directory, install into a profile (this example uses `web`):

```bash
dsh plugin --profile web add git+https://github.com/whklwhkl/dsh-playwright.git
```

`dsh plugin` forwards the install source to pnpm in the profile and adds the bundle to `dsh.profile.bundles`. Registry package names, `github:<user>/<repo>`, and local paths are supported. Restart DSH after installation so the bundle is loaded for profile sessions.

For local development, install the checkout as a symlink:

```bash
dsh plugin --profile web add link:/path/to/dsh-playwright
```

A linked checkout does not install its dependencies for you. Run `pnpm install` in the checkout first; otherwise the host cannot load `playwright-core` and the tools will not register. Restart DSH after plugin changes. On DSH versions without `dsh plugin`, add `playwright-browser` to the profile dependencies and `dsh.profile.bundles`, then install the profile dependencies.

## Prepare a browser

`playwright-core` does not download a browser during package installation. To install the Chromium build matching this checkout's installed `playwright-core`, run this from the plugin checkout after `pnpm install`:

```bash
pnpm exec playwright-core install chromium
```

Alternatively, set `PW_CHROMIUM_PATH` for the DSH process to an existing Chromium-family executable:

```bash
export PW_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Linux example: export PW_CHROMIUM_PATH="/usr/bin/google-chrome"
```

This package requires **Node.js 20 or later**. Browser compatibility depends on the installed Playwright and browser versions; arbitrary Chromium-family builds are not guaranteed to work.

## Attach to an open browser

A plugin-launched browser starts with a fresh profile. To reuse a browser you are already using, enable CDP attach mode:

```bash
export PW_CDP_ENDPOINT=chrome
# Or: export PW_CDP_ENDPOINT=http://127.0.0.1:9222
# Or: export PW_CDP_ENDPOINT=auto
```

For the `chrome` channel, Chrome 136 and later may require enabling remote debugging in the target browser at `chrome://inspect/#remote-debugging` and approving each new CDP connection. A pending approval can look like a connection timeout. The exact prompts and behavior depend on the browser version.

To use a debugging port, start Chrome with a dedicated user-data directory (Chrome 136+ ignores the remote-debugging-port flag for the default data directory) after fully closing that browser instance:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug"
```

That directory has its own browser profile, so sign in to sites there as needed. CDP compatibility varies; the plugin does not guarantee support for arbitrary Chromium versions.

You can also attach at runtime without restarting DSH:

| Call                                     | Effect                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `browser_attach`                         | Reuse the current attachment, or use `PW_CDP_ENDPOINT` (`auto` if unset)           |
| `browser_attach({ endpoint: "chrome" })` | Attach to a channel, HTTP/WebSocket endpoint, `auto`, or comma-separated fallbacks |
| `browser_attach({ page: "portal" })`     | Keep the browser and select a tab by URL/title substring; a miss is an error       |
| `browser_attach({ endpoint: "launch" })` | Disconnect and return to a plugin-launched browser                                 |

In attach mode, `browser_status` does not establish a connection. Repeating `browser_attach` to the same endpoint reuses the current connection. `browser_tabs` lists tabs (`*` marks the selected tab); pass an index or URL/title substring to select one, and `close: true` to close it. If there are no tabs and no page hint, attach can succeed without a selected page; the next page operation creates a blank tab. A supplied page hint is a strict match: if no tab matches, attach fails rather than silently selecting another page.

`browser_open` navigates the currently selected tab. Check `browser_tabs` before using it if the user may be reading a page. `PW_CDP_PAGE` is a page-selection preference for attach; it is not a persistent pin. `browser_close` only disconnects in attach mode and does not close the user's browser. `PW_HEADLESS` and `PW_CHROMIUM_PATH` do not affect an attached browser.

## Configuration

| Variable           | Default                             | Description                                                                                                                                                                                               |
| ------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PW_LANG`          | unset                               | Legacy launch-page locale mapping only: exact `en` maps to `en-US`; every other value maps to `zh-CN`. It does not change tool, error, or skill messages. An attached browser's locale is left untouched. |
| `PW_CHROMIUM_PATH` | automatic discovery                 | Use a specific browser executable for a plugin-launched browser                                                                                                                                           |
| `PW_HEADLESS`      | `true`                              | Set to `false` to show a plugin-launched browser window; ignored in attach mode                                                                                                                           |
| `PW_SHOT_DIR`      | `shots/` under the plugin directory | Screenshot directory. Relative overrides are resolved from the DSH process working directory; absolute screenshot filenames are used directly.                                                            |
| `PW_CDP_ENDPOINT`  | unset                               | Enable attach mode with a channel, `http://…`, `ws://…`, comma-separated fallbacks, or `auto` (Chrome, then port 9222)                                                                                    |
| `PW_CDP_PAGE`      | unset                               | Prefer a tab by URL or title substring when attaching; not a persistent pin                                                                                                                               |
| `PW_CDP_TIMEOUT`   | `90000`                             | Attach connection budget in milliseconds                                                                                                                                                                  |
| `PW_RTT_TIMEOUT`   | `1500`                              | Budget for incidental page round-trips such as reading a title                                                                                                                                            |

## Bundled skill: playwright-browser-tips

The bundle includes an English `playwright-browser-tips` skill with per-site observations and tactics, plus general recovery guidance. It is loaded on demand for first-time site automation, browser tool failures or empty results, and search or login flows. Users can also invoke it with `/playwright-browser-tips`.

The skill requires a profile with the skill registry; profiles backed by `dsh-base` (including web, headless, acp, and sdk-app) provide one. A same-name project or user skill takes precedence over the bundled skill. Site-map contributions must follow [SITE-MAP-SPEC.md](./SITE-MAP-SPEC.md) and update only `assets/site-map.json`; the code-owned guidance retains the boundary that CAPTCHAs are completed manually by the user.

## Troubleshooting

| Symptom                                                          | Suggested action                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Executable doesn't exist ... ms-playwright`                     | Install Chromium from the plugin checkout with `pnpm exec playwright-core install chromium`, or use `PW_CHROMIUM_PATH`.                                             |
| `Could not connect to chrome: DevToolsActivePort file not found` | Enable remote debugging for the target browser or start it with a dedicated `--user-data-dir` and remote-debugging port.                                            |
| `http://127.0.0.1:9222` returns 404 for `/json/version/`         | The browser may expose only a WebSocket endpoint; try the `chrome` channel instead.                                                                                 |
| `connect ECONNREFUSED 127.0.0.1:9222`                            | Confirm the browser is running with the expected debugging port and that the endpoint is reachable.                                                                 |
| Attach times out before WebSocket handshake                      | Check the browser window for a remote-debugging approval prompt. Do not retry in a loop.                                                                            |
| Attach completes the handshake but initialization times out      | A tab may have an unresponsive renderer. Check the diagnostics, close the stuck tab in the browser, and retry once.                                                 |
| A tab is marked `(not responding)`                               | Its renderer did not respond within the round-trip budget. Switch to another tab and close the stuck one in the browser.                                            |
| `browser_open` overwrote the page being read                     | Expected in attach mode: it navigates the selected tab. Select a different tab first with `browser_tabs`.                                                           |
| `net::ERR_CONNECTION_CLOSED` or another `net::ERR_*`             | Check the site/network and avoid repeated retries; switch to an alternative source if automation is blocked.                                                        |
| A CAPTCHA, slider, or anti-automation challenge appears          | Stop and report it. The user must complete CAPTCHAs manually; do not attempt to bypass the challenge.                                                               |
| Element is not visible or a selector stopped working             | Inspect the current DOM with `browser_eval` and choose a selector based on the page as it is now.                                                                   |
| Screenshot returns a path but no image                           | The profile attachment service or model may not support inline images, or the image may exceed deployment limits. The saved path remains available to `read_image`. |

## Developer module map

| Area              | Module                                                 | Responsibility                                                                 |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Composition       | [`lib/index.js`](./lib/index.js)                       | Assemble the browser session, operations, and public tools.                    |
| Browser lifecycle | [`lib/browser-session.js`](./lib/browser-session.js)   | Own launch/attach state, current page, and tab selection.                      |
| Configuration     | [`lib/settings.js`](./lib/settings.js)                 | Resolve environment-backed browser settings and absolute screenshot directory. |
| Async control     | [`lib/async.js`](./lib/async.js)                       | Handle cancellation races and bounded page round-trips.                        |
| CDP               | [`lib/cdp.js`](./lib/cdp.js)                           | Resolve attach endpoints and produce connection diagnostics.                   |
| Browser actions   | [`lib/operations.js`](./lib/operations.js)             | Implement page operations against the session.                                 |
| Public contracts  | [`lib/tool-definitions.js`](./lib/tool-definitions.js) | Register tool schemas, descriptions, and argument handling.                    |
| Results           | [`lib/results.js`](./lib/results.js)                   | Format successful tool values without translating page-derived content.        |
| Screenshots       | [`lib/screenshot.js`](./lib/screenshot.js)             | Save PNGs and optionally attach image content.                                 |
| Bundled skill     | [`lib/skill-provider.js`](./lib/skill-provider.js)     | Register the English site-map skill and render its table.                      |

## Community and support

This plugin is part of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ecosystem and uses the `dsh-plugin` topic for discoverability.

- Plugin issues and feature requests: [Issues](https://github.com/whklwhkl/dsh-playwright/issues) and [Discussions](https://github.com/whklwhkl/dsh-playwright/discussions)
- DSH framework feedback: [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)
