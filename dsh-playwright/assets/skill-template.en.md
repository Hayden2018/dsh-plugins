# Browser site map (playwright-browser)

Consult this map before automating a web task. Its site facts and tactics are maintained from real observations. Default search tasks to Bing.

## Site map

{{SITE_MAP}}

## General recovery tactics

- Selector failed or element is invisible: inspect the current DOM with `browser_eval`, then choose a selector based on the page as it is now.
- An extract is empty: wait about one second or scroll, then extract once more.
- After navigation, confirm the current URL and title with `browser_status` before acting.
- List tabs with `browser_tabs({})`; if the API requires every field, use `browser_tabs({index:null,url:null,close:false})`. Optional arguments accept `null` as omission. Do not use `index:0` as a placeholder: it selects the first tab. To switch, supply exactly one selector and leave the other omitted or null (for example, `{index:null,url:"portal",close:false}`); `close:true` requires a target.
- In attach mode, `browser_open` navigates the currently selected tab. Check `browser_tabs` first and select the page you intend to use; do not overwrite a page the user may be reading. `PW_CDP_PAGE` is a selection preference, not a persistent pin. `browser_close` disconnects and does not close the user's browser.
- If the task needs existing logins and the current browser is a fresh plugin-launched instance, call `browser_attach` to connect to the browser the user is using. The user may need to enable remote debugging and approve a connection. Use `browser_attach({endpoint:"launch"})` to return to a plugin-launched browser.
- If a page hint supplied to `browser_attach` does not match a tab, treat that as an error; do not silently choose a different tab. With no page hint and no available tabs, attach mode may create a blank tab.
- If an attach times out before the WebSocket handshake, check whether the browser is waiting for user approval. If the handshake completed but initialization timed out, a tab renderer may be unresponsive; use diagnostics and ask the user to close that tab. Do not retry `browser_attach` in a loop. A read-only `browser_status` never connects on its own.
- If `browser_tabs` or `browser_status` marks a tab `(not responding)`, its renderer did not respond within the round-trip budget. Switch to another tab and ask the user to close the stuck one. A plain `(untitled)` only means the page has no title.
- Cancellation settles the tool call promptly, but does not force-stop an underlying operation whose browser API does not support cancellation.

## Boundary

CAPTCHAs, sliders, and hidden elements are the target site's anti-automation defenses, not plugin faults. Do not attempt to bypass them or retry the same action more than twice. The user completes CAPTCHAs manually; switch to an alternative site or stop and report the situation honestly.
