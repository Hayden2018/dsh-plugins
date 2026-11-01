/** English presentation only; page-derived text and values are never translated. */
const titleLabel = (result) => (result.unresponsive ? '(not responding)' : '(untitled)');
const pageTitle = (result) => result.title || titleLabel(result);

function tabsHint(count) {
  return (
    `\nNote: ${count} tab(s) did not respond within the title-read budget (possible causes include a stuck renderer or a paused debugger). ` +
    'Switch tabs or inspect the browser before retrying page operations.'
  );
}

function formatTabs(rows) {
  const stuck = rows.filter((tab) => tab.unresponsive).length;
  return (
    `${rows.length} open tab(s) (* = current):\n` +
    rows.map((tab) => `[${tab.index}]${tab.current ? '*' : ' '} ${pageTitle(tab)} — ${tab.url}`).join('\n') +
    (stuck ? tabsHint(stuck) : '')
  );
}

function formatStatus(result) {
  if (result.error) return `Error: ${result.error}`;
  if (result.open) {
    const connection =
      result.mode === 'attached'
        ? `attached to your running browser: ${result.endpoint}`
        : 'plugin-launched instance';
    return (
      `Browser online (${connection})\nCurrent URL: ${result.url}\nPage title: ${pageTitle(result)}\nTabs: ${result.tabs}` +
      (result.matched ? `\n(tab selected by "${result.matched}")` : '')
    );
  }
  if (result.stalePage) {
    return (
      `The browser is still online, but the tab it was tracking has been closed (${result.tabs} tab(s) open).\n` +
      "The next page operation will select or create a tab; browser_attach's page argument selects a specific existing one."
    );
  }
  if (result.needAttach) {
    return (
      `Not attached yet (configured endpoint: ${result.configured}).\n` +
      'The next page operation attaches to that endpoint; a status query deliberately does NOT open a CDP connection.\n' +
      'Call browser_attach to connect. If Chrome shows an "Allow remote debugging?" dialog, click Allow.'
    );
  }
  return (
    "Browser is not open (no CDP endpoint is configured, so the next page operation launches the plugin's own browser).\n" +
    'A status query deliberately does not open any connection.'
  );
}

/** Preserve ordinary string outputs and the screenshot's structured value. */
export function formatResult(op, result) {
  if (result === null || result === undefined) return '(empty result)';
  switch (op) {
    case 'open':
      return `Page opened: ${result.url}\nPage title: ${pageTitle(result)}`;
    case 'status':
      return formatStatus(result);
    case 'attach':
      return result.attached
        ? `Attached to browser\nEndpoint: ${result.endpoint}\nCurrent URL: ${result.url}\nPage title: ${pageTitle(result)}\nTabs: ${result.tabs}`
        : 'Switched to a plugin-launched browser (starts on the next action; your own browser is untouched)';
    case 'tabs':
      if (result.tabs) return formatTabs(result.tabs);
      if (result.closed) return 'Tab closed';
      if (result.closeTimedOut)
        return 'Closing the tab timed out (its renderer may be unresponsive); it may still be open';
      if (result.closeFailed) return `Failed to close the tab: ${result.closeFailed}`;
      return `Current tab switched: ${result.url}\nPage title: ${pageTitle(result)}`;
    case 'extract':
      return String(result.text || '');
    case 'html':
      return String(result.html || '');
    case 'eval':
      return String(result.value || '');
    case 'screenshot':
      return result;
    case 'click':
    case 'type':
    case 'fill':
    case 'press':
    case 'wait':
      return `OK: ${op}`;
    case 'close':
      return result.detached
        ? 'Disconnected from your browser (it was NOT closed and keeps running)'
        : 'Browser instance closed (the next page operation starts it again)';
    default:
      return JSON.stringify(result);
  }
}
