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

### Optional Windows auto-approval

In **Plugins → Playwright browser**, enable **Attempt auto approve on browser attachment** to attempt native Chrome consent approval. This option is **off by default** and is persisted as the live plugin Config field `attemptAutoApprove`; changing it does not disconnect the browser. Switching it off also stops a pending approval helper. The helper and toggle are unavailable on non-Windows **hosts**, regardless of the OS running the Web UI.

Enabling this option grants automation access to the attached browser's tabs and signed-in sessions. It does not enable Chrome remote debugging for you. Approval is attempted only for a local `ws://` browser endpoint whose port and full path match Chrome's default-profile `DevToolsActivePort`, and only in windows owned by the `chrome.exe` listening on that port. Remote endpoints, HTTP endpoints, Edge, and plugin-launched browsers are not auto-approved. If the endpoint address resolves to multiple listening process owners, the helper declines to guess.

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