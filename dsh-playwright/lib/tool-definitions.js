import { throwIfAborted } from './async.js';
import { formatResult } from './results.js';
import { SHOT_OUTPUT } from './screenshot.js';

// Keep parameter rules and nullable optional values identical across all tools.
const DESCRIPTIONS = {
  open: 'Open a URL and wait for the page to load; returns the final address and page title. url is required; waitUntil is optional (commit|domcontentloaded|load|networkidle, default domcontentloaded); timeout is the load timeout in ms, default 30000.',
  status:
    "Query the browser and current page state: online status, whether it is attached to your running browser, current URL, page title, tab count; when not attached it also names the configured endpoint the next action will attach to, or that it will launch the plugin's own browser. No arguments.",
  tabs: 'Manage open tabs. Pass {} to list all tabs (* marks the current one); if every field is required, pass {"index":null,"url":null,"close":false} to list, not index:0 as an omission placeholder. To switch, pass exactly one of index or url (a URL or title substring); add close:true to close that target. Passing both selectors or close:true without a target is an error. In attach mode this takes over a page you opened by hand. A stuck renderer is marked (not responding); title reads have a PW_RTT_TIMEOUT ms budget (default 1500), and a title-based match that misses says so in the error.',
  attach:
    'Attach to an already-running browser over CDP, reusing its logins, cookies, extensions and open tabs — no DSH restart needed. Without endpoint: keep the current endpoint if already attached, else use PW_CDP_ENDPOINT (auto when unset).',
  click:
    'Click an element on the page. selector accepts a CSS selector or a Playwright text selector (e.g. text=Login).',
  type: 'Click the element first, then type text character by character — good for input fields (optional delay simulates human typing speed).',
  fill: 'Fill an input field directly (faster than type; writes once, no per-character simulation).',
  press: 'Press a keyboard key on the page, e.g. Enter, Tab, Escape.',
  wait: 'Wait for the given number of milliseconds (e.g. for navigation or animations to finish).',
  extract:
    "Extract text from the page. Without selector, grabs the whole body's innerText; with selector, grabs that element's text.",
  html: "Extract HTML from the page. Without selector, grabs the whole page; with selector, grabs that element's outer HTML.",
  eval: 'Execute a JavaScript expression in the page context and return the result (for DOM diagnostics, visibility checks, etc.).',
  screenshot:
    'Take a screenshot of the current page as PNG and return the absolute file path; a model that accepts image input also sees the image itself (otherwise you get the path only, viewable with read_image).',
  close:
    'Close the browser instance to free resources (the next browser_open restarts it automatically). In attach mode this only disconnects; it never closes your browser.',
};

const PARAMETERS = {
  url: 'Full URL to open (with protocol, e.g. https://www.baidu.com)',
  waitUntil: 'Wait strategy: commit / domcontentloaded / load / networkidle; default domcontentloaded',
  timeout: 'Load timeout in ms, default 30000; 0 disables the timeout',
  timeoutClick: 'Element action timeout in ms, default 10000; 0 disables the timeout',
  selector: 'CSS selector or text= selector',
  selectorInput: 'CSS selector of the input field',
  text: 'Text to input',
  textFill: 'Text to fill',
  delay: 'Delay between keystrokes in ms, default 0',
  key: 'Key name, e.g. Enter / Tab / Escape / ArrowDown',
  ms: 'Milliseconds to wait, default 1000; 0 does not wait',
  selectorOpt: 'Optional CSS selector; defaults to whole-page text',
  limitText:
    'Max characters of returned text (non-negative integer), default 20000; 0 returns an empty result',
  selectorHtml: 'Optional CSS selector',
  limitHtml:
    'Max characters of returned HTML (non-negative integer), default 50000; 0 returns an empty result',
  expression: 'JS expression to evaluate, e.g. document.title or an IIFE',
  filename:
    'PNG output path or filename (use a .png suffix); absolute paths are used directly, relative paths resolve under PW_SHOT_DIR (default: plugin shots dir); default shot-<timestamp>.png',
  fullPage: 'Whether to capture the full page; default is viewport only',
  tabIndex:
    'Zero-based non-negative integer from the browser_tabs list; omit or pass null to list tabs or match by url',
  tabUrl:
    'Match a tab by non-empty URL or title substring; omit or pass null when selecting by index or listing',
  tabClose:
    'With index/url: true closes that target (destructive); false, null or omission does not close it',
  cdpEndpoint:
    'CDP endpoint: a channel name (chrome / msedge), http://127.0.0.1:9222, ws://…; comma-separate for fallbacks, auto = chrome then 9222; the special value launch switches back to a plugin-launched browser',
  cdpPage:
    'Pick the tab to drive by URL or title substring (overrides PW_CDP_PAGE); a miss is an error rather than an arbitrary pick',
};

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

/** Register the public browser_* contracts without exposing session internals. */
export function registerBrowserTools(ctx, ops) {
  function registerTool(op, description, props, required = [], output = TEXT_OUTPUT) {
    const requiredKeys = new Set(required);
    const properties = {};
    for (const [key, spec] of Object.entries(props)) {
      const { description: parameterDescription, ...schema } = spec;
      properties[key] = requiredKeys.has(key)
        ? { ...schema, description: parameterDescription }
        : {
            oneOf: [schema, { type: 'null' }],
            description: parameterDescription + ' Optional; omit or pass null to use the default behavior.',
          };
    }
    ctx.tools.register({
      name: 'browser_' + op,
      description,
      parameters: { type: 'object', additionalProperties: false, properties, required },
      output,
      async execute(args, exec) {
        const signal = exec && exec.signal;
        throwIfAborted(signal);
        // Some model APIs require every property. Optional nulls mean omission,
        // never tab 0 or the literal string "null"; required fields stay required.
        const resolved = Object.fromEntries(
          Object.entries(args || {}).filter(([key, value]) => value !== null || requiredKeys.has(key))
        );
        return formatResult(op, await ops[op](resolved, signal));
      },
    });
  }

  registerTool(
    'open',
    DESCRIPTIONS.open,
    {
      url: { type: 'string', description: PARAMETERS.url },
      waitUntil: {
        type: 'string',
        enum: ['commit', 'domcontentloaded', 'load', 'networkidle'],
        description: PARAMETERS.waitUntil,
      },
      timeout: { type: 'number', description: PARAMETERS.timeout },
    },
    ['url']
  );
  registerTool('status', DESCRIPTIONS.status, {});
  registerTool('attach', DESCRIPTIONS.attach, {
    endpoint: { type: 'string', description: PARAMETERS.cdpEndpoint },
    page: { type: 'string', description: PARAMETERS.cdpPage },
  });
  registerTool('tabs', DESCRIPTIONS.tabs, {
    index: { type: 'integer', description: PARAMETERS.tabIndex },
    url: { type: 'string', description: PARAMETERS.tabUrl },
    close: { type: 'boolean', description: PARAMETERS.tabClose },
  });
  registerTool(
    'click',
    DESCRIPTIONS.click,
    {
      selector: { type: 'string', description: PARAMETERS.selector },
      timeout: { type: 'number', description: PARAMETERS.timeoutClick },
    },
    ['selector']
  );
  registerTool(
    'type',
    DESCRIPTIONS.type,
    {
      selector: { type: 'string', description: PARAMETERS.selectorInput },
      text: { type: 'string', description: PARAMETERS.text },
      delay: { type: 'number', description: PARAMETERS.delay },
      timeout: { type: 'number', description: PARAMETERS.timeoutClick },
    },
    ['selector', 'text']
  );
  registerTool(
    'fill',
    DESCRIPTIONS.fill,
    {
      selector: { type: 'string', description: PARAMETERS.selectorInput },
      text: { type: 'string', description: PARAMETERS.textFill },
      timeout: { type: 'number', description: PARAMETERS.timeoutClick },
    },
    ['selector', 'text']
  );
  registerTool(
    'press',
    DESCRIPTIONS.press,
    {
      key: { type: 'string', description: PARAMETERS.key },
    },
    ['key']
  );
  registerTool('wait', DESCRIPTIONS.wait, {
    ms: { type: 'number', description: PARAMETERS.ms },
  });
  registerTool('extract', DESCRIPTIONS.extract, {
    selector: { type: 'string', description: PARAMETERS.selectorOpt },
    limit: { type: 'integer', description: PARAMETERS.limitText },
  });
  registerTool('html', DESCRIPTIONS.html, {
    selector: { type: 'string', description: PARAMETERS.selectorHtml },
    limit: { type: 'integer', description: PARAMETERS.limitHtml },
  });
  registerTool(
    'eval',
    DESCRIPTIONS.eval,
    {
      expression: { type: 'string', description: PARAMETERS.expression },
    },
    ['expression']
  );
  registerTool(
    'screenshot',
    DESCRIPTIONS.screenshot,
    {
      filename: { type: 'string', description: PARAMETERS.filename },
      fullPage: { type: 'boolean', description: PARAMETERS.fullPage },
    },
    undefined,
    SHOT_OUTPUT
  );
  registerTool('close', DESCRIPTIONS.close, {});
}
