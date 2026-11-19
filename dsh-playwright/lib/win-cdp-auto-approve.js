import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromeApprovalTarget } from './cdp.js';
import { CHROME_CONSENT_LABELS } from './chrome-consent-labels.js';

export const AUTO_APPROVE_SUPPORTED = process.platform === 'win32';

/**
 * Only scan Chrome's small native dialog subtree, never a tab's accessibility DOM.
 * The listening process must itself be chrome.exe; unrelated Chrome instances and
 * other applications' similarly named buttons are excluded by ProcessId.
 */
function approvalScript({ port, host }, timeoutMs) {
  const addresses =
    host === '127.0.0.1'
      ? ['127.0.0.1', '0.0.0.0']
      : host === '::1'
        ? ['::1', '::']
        : ['127.0.0.1', '::1', '0.0.0.0', '::'];
  const addressList = addresses.map((address) => `'${address}'`).join(', ');
  // Base64 JSON avoids PowerShell quoting issues and preserves non-Latin labels.
  const labelData = Buffer.from(JSON.stringify(CHROME_CONSENT_LABELS), 'utf8').toString('base64');
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$end = [DateTime]::UtcNow.AddMilliseconds(${Math.ceil(timeoutMs)})
$parentId = ${process.pid}
$parentStarted = (Get-Process -Id $parentId).StartTime
$owners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @(${addressList}) } |
    Select-Object -ExpandProperty OwningProcess -Unique)
# Different browser instances may bind the same port on different addresses.
# In particular localhost can resolve either way: never guess between owners.
if ($owners.Count -ne 1) { exit 0 }
$chrome = Get-Process -Id $owners[0] -ErrorAction SilentlyContinue
if (!$chrome -or $chrome.ProcessName -ne 'chrome') { exit 0 }
$chromeId = $chrome.Id
$chromeStarted = $chrome.StartTime
$chromeClass = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Chrome_WidgetWin_1')
$browserRootClass = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'BrowserRootView')
$labels = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${labelData}')))
function Normalize-ConsentLabel([string]$text) {
    # Preserve words, punctuation and case. Strip only bidi display controls and
    # fold whitespace, including French NBSP/narrow NBSP, for UIA presentation.
    $normalized = $text.Normalize([Text.NormalizationForm]::FormC)
    $normalized = [regex]::Replace($normalized, '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]', '')
    return [regex]::Replace($normalized, '\s+', ' ').Trim()
}
foreach ($label in $labels) {
    $label.title = Normalize-ConsentLabel $label.title
    $label.allow = Normalize-ConsentLabel $label.allow
}
$buttonType = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
while ([DateTime]::UtcNow -lt $end) {
    $parent = Get-Process -Id $parentId -ErrorAction SilentlyContinue
    if (!$parent -or $parent.StartTime -ne $parentStarted) { exit 0 }
    $chrome = Get-Process -Id $chromeId -ErrorAction SilentlyContinue
    if (!$chrome -or $chrome.StartTime -ne $chromeStarted) { exit 0 }
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, $chromeClass)
    foreach ($window in $windows) {
        try {
            if ($window.Current.ProcessId -ne $chromeId) { continue }
            $root = $window.FindFirst([System.Windows.Automation.TreeScope]::Children, $browserRootClass)
            if (!$root) { continue }
            $dialog = $null
            $dialogTitle = $null
            $matchingLabels = @()
            # Enumerate only native direct children, never NonClientView's web DOM.
            $panes = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($pane in $panes) {
                if ($pane.Current.ClassName -cne 'Chrome_WidgetWin_1') { continue }
                $title = Normalize-ConsentLabel $pane.Current.Name
                $titleMatches = @($labels | Where-Object {
                    [string]::Equals($_.title, $title, [StringComparison]::Ordinal)
                })
                if ($titleMatches.Count -eq 0) { continue }
                # More than one matching native prompt is ambiguous; do not guess.
                if ($dialog) { exit 0 }
                $dialog = $pane
                $dialogTitle = $title
                $matchingLabels = $titleMatches
            }
            if (!$dialog) { continue }
            # Invoking earlier can reset Chrome's 500ms activation-protector timer.
            Start-Sleep -Milliseconds 800
            if ([DateTime]::UtcNow -ge $end) { exit 0 }
            $parent = Get-Process -Id $parentId -ErrorAction SilentlyContinue
            if (!$parent -or $parent.StartTime -ne $parentStarted) { exit 0 }
            # A dialog may be replaced while waiting: recheck its identity/labels.
            $currentTitle = Normalize-ConsentLabel $dialog.Current.Name
            if ($dialog.Current.ProcessId -ne $chromeId -or
                $dialog.Current.ClassName -cne 'Chrome_WidgetWin_1' -or
                ![string]::Equals($currentTitle, $dialogTitle, [StringComparison]::Ordinal)) { continue }
            $buttons = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonType)
            $allowButtons = @($buttons | Where-Object {
                $buttonName = Normalize-ConsentLabel $_.Current.Name
                @($matchingLabels | Where-Object {
                    [string]::Equals($_.allow, $buttonName, [StringComparison]::Ordinal)
                }).Count -gt 0
            })
            if ($allowButtons.Count -ne 1) { continue }
            $button = $allowButtons[0]
            if ($button.Current.ProcessId -eq $chromeId -and $button.Current.IsEnabled) {
                $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                # Do not approve subsequent requests while Playwright initializes
                # tabs: Chrome's accessibility tree does not identify the client.
                exit 0
            }
        } catch {
            # Windows/dialogs may disappear between UIA calls. Keep watching
            # until one invocation succeeds or the attachment settles.
        }
    }
    Start-Sleep -Milliseconds 200
}
`;
}

/** Start an opt-in, bounded helper. Failure never replaces the normal CDP result. */
export function startChromeAutoApprove(endpoint, { enabled, signal, timeoutMs, onError = () => {} }) {
  const noop = () => {};
  if (!AUTO_APPROVE_SUPPORTED || signal?.aborted || !enabled()) return noop;
  const target = chromeApprovalTarget(endpoint);
  if (target === null) return noop;

  let child;
  let stopped = false;
  let watchdog;
  let preferenceWatch;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(watchdog);
    clearInterval(preferenceWatch);
    signal?.removeEventListener('abort', stop);
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* Cleanup must not change the attach outcome. */
      }
    }
  }
  try {
    const executable = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    child = spawn(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(approvalScript(target, timeoutMs), 'utf16le').toString('base64'),
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    child.once('error', (error) => {
      stop();
      onError(error);
    });
    child.once('exit', (code) => {
      const failed = !stopped && code !== null && code !== 0;
      stop();
      if (failed) onError(new Error(`Windows CDP approval helper exited with code ${code}`));
    });
    signal?.addEventListener('abort', stop, { once: true });
    watchdog = setTimeout(stop, timeoutMs);
    watchdog.unref();
    // Switching off must also withdraw an approval attempt already in progress.
    preferenceWatch = setInterval(() => {
      if (!enabled()) stop();
    }, 200);
    preferenceWatch.unref();
    if (signal?.aborted) stop();
  } catch (error) {
    stop();
    onError(error);
  }
  return stop;
}
