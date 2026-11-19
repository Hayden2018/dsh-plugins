/**
 * Browser transfers for the workspace file view, browser half.
 *
 * Contributes one Download control to two existing preview extension points,
 * so every previewed file — PDF, XLSX, DOCX, image, HTML, text, or a binary no
 * renderer claims — can be saved to the reader's own machine:
 *
 *  - `sidebar.right.tab.document.actions` (the document header, next to the
 *    native "Open" control), and
 *  - `sidebar.right.tab.document.unpreviewable` (the empty state whose only
 *    stock action launches a native application on the Host).
 *
 * Both point at `/api/file-download` (this plugin's Host half), which answers
 * `Content-Disposition: attachment` and streams without the image-sized cap
 * `/api/file` applies. The link is a real `<a download>`, so a middle-click or
 * "Save link as" also works, and the browser never renders the file.
 *
 * It also contributes an Upload control to `sidebar.right.tab.files.actions`,
 * the workspace file view's top-right action row: pick one file, watch the
 * button's circular progress ring fill, and the Host stores it in the
 * displayed workspace directory. One transfer at a time; the Host refuses a
 * second one for the same Session. The ring and the result toast are the only
 * feedback, and a failed transfer leaves no partial file behind.
 *
 * This file is served raw as a classic script: every side effect, including
 * JSX runtime work, belongs inside the factory.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-io',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');
    var react_jsx_runtime = require('react/jsx-runtime');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    const NS = 'fileIo';

    /**
     * Simplified Chinese dictionary (the key-set source of truth).
     */
    const zh = {
      'action.download': '下载',
      'action.downloadHint': '下载到这台设备',
      'action.empty': '下载文件',
      'action.upload': '上传文件',
      'upload.hint': '上传文件到此工作区（最大 100 MB）',
      'upload.uploading': '正在上传 {name}… {percent}%',
      'upload.done': '已上传 {name}',
      'upload.tooLarge': '文件超过 100 MB 的上传上限。',
      'upload.exists': '工作区中已存在同名文件。',
      'upload.busy': '正在上传另一个文件，请稍后再试。',
      'upload.unsupported': '此工作区当前不支持上传。',
      'upload.denied': '没有上传到此工作区的权限。',
      'upload.expired': '此会话已不可用，请重新打开工作区。',
      'upload.notFound': '工作区文件夹已不存在。',
      'upload.noSpace': '主机磁盘空间不足。',
      'upload.aborted': '上传已停止。',
      'upload.failed': '上传失败。',
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'action.download': 'Download',
      'action.downloadHint': 'Download to this device',
      'action.empty': 'Download file',
      'action.upload': 'Upload file',
      'upload.hint': 'Upload a file to this workspace (max 100 MB)',
      'upload.uploading': 'Uploading {name}… {percent}%',
      'upload.done': 'Uploaded {name}',
      'upload.tooLarge': 'This file is larger than the 100 MB upload limit.',
      'upload.exists': 'A file with this name already exists in this workspace.',
      'upload.busy': 'Another upload is already running.',
      'upload.unsupported': 'This workspace cannot receive uploads.',
      'upload.denied': 'You cannot upload to this workspace.',
      'upload.expired': 'This session is no longer available.',
      'upload.notFound': 'The workspace folder no longer exists.',
      'upload.noSpace': 'The Host is out of disk space.',
      'upload.aborted': 'The upload was stopped.',
      'upload.failed': 'Upload failed.',
    };

    /** Route this plugin's Host half claims; document-relative like every app route. */
    const ROUTE = 'api/file-download';

    /** Route the upload action claims; document-relative as well. */
    const UPLOAD_ROUTE = 'api/file-upload';

    /** The Host's inclusive per-file cap, checked here first for a fast refusal. */
    const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

    /**
     * Host failure codes that have their own sentence. An unmapped code falls
     * back to the generic failure line.
     */
    const UPLOAD_ERROR_KEYS = {
      'upload/too-large': 'upload.tooLarge',
      'upload/exists': 'upload.exists',
      'upload/not-regular-file': 'upload.exists',
      'upload/busy': 'upload.busy',
      'upload/unsupported': 'upload.unsupported',
      'upload/unsupported-content-type': 'upload.failed',
      'upload/outside-workspace': 'upload.denied',
      'upload/denied': 'upload.denied',
      'upload/session-unknown': 'upload.expired',
      'upload/not-found': 'upload.notFound',
      'upload/no-space': 'upload.noSpace',
      'upload/aborted': 'upload.aborted',
    };

    /** Style hook: the document header's own controls are 28px icon buttons. */
    const CSS = [
      // Download related buttons
      '.dfd-tool{box-sizing:border-box;width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;',
      'padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);',
      'cursor:pointer;text-decoration:none;margin-right:6px}',
      '.dfd-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dfd-empty{box-sizing:border-box;min-height:32px;display:inline-flex;align-items:center;gap:6px;padding:0 14px;',
      'border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,8px);',
      'background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-decoration:none;',
      'font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1}',
      '.dfd-empty:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dfd-empty svg{flex:none}',
      // The upload control lives beside the workspace directory opener in
      // the files page's header, so it keeps that row's 28px hit target and
      // draws its percentage as a ring in the same square.
      '.dfu-root{display:inline-flex;flex:none;align-items:center;margin-right:6px}',
      '.dfu-tool{position:relative;box-sizing:border-box;width:28px;height:28px;flex:none;display:inline-flex;align-items:center;',
      'justify-content:center;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer}',
      ".dfu-tool:hover:not([data-state='uploading']){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".dfu-tool[data-state='uploading']{cursor:progress;color:var(--dsw-alias-state-business-primary)}",
      ".dfu-tool[data-state='success']{color:var(--dsw-alias-state-success-primary)}",
      ".dfu-tool[data-state='error']{color:var(--dsw-alias-state-error-primary)}",
      // The ring is a masked conic gradient: --dfu-progress carries the
      // percentage the XHR reports, the track stays the hairline border.
      // It is the whole uploading indicator, so the arc itself is the
      // progress readout — no spinner, no second layer. `corner-shape:round`
      // keeps the 50% radius a true circle under DSH's global superellipse.
      '.dfu-ring{position:absolute;inset:5px;border-radius:50%;corner-shape:round;pointer-events:none;',
      'background:conic-gradient(var(--dsw-alias-state-business-primary) calc(var(--dfu-progress,0)*1%),',
      'var(--dsw-alias-border-l3,rgba(0,0,0,.12)) 0);',
      '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.5px));',
      'mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.5px))}',
      '.dfu-input{display:none}',
    ].join('');

    /**
     * Inject this plugin's stylesheet once per document.
     *
     * A page that hot-reloads the bundle keeps its earlier `<style>` tag, so
     * the content is refreshed in place: a stale tag would leave the new
     * upload control unstyled (and its hidden file input visible).
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      const existing = document.querySelector('style[data-plugin-css="dsh-file-io"]');
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-file-io';
      tag.dataset.pluginCss = 'dsh-file-io';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * Build the authenticated attachment URL for one absolute path.
     *
     * App-owned browser routes are document-relative (the rule the built-in
     * previews follow), so the URL resolves against `document.baseURI`
     * rather than hard-coding a leading slash.
     * @param {string} absolutePath - Absolute path reported by the file resource.
     * @returns {string | undefined} the URL, or undefined for an unsupported base.
     */
    function downloadUrl(absolutePath) {
      try {
        return new URL(`${ROUTE}?path=${encodeURIComponent(absolutePath)}`, document.baseURI).href;
      } catch {
        return undefined;
      }
    }

    /**
     * Build the authenticated upload URL for one destination directory.
     * @param {string} directory - Absolute directory the file view displays.
     * @param {string} sessionId - Session whose workspace confines the write.
     * @param {string} name - The file's own name.
     * @returns {string | undefined} the URL, or undefined for an unsupported base.
     */
    function uploadUrl(directory, sessionId, name) {
      try {
        const query = new URLSearchParams({ sessionId, directory, name });
        return new URL(`${UPLOAD_ROUTE}?${query.toString()}`, document.baseURI).href;
      } catch {
        return undefined;
      }
    }

    /**
     * The last path segment, in either separator spelling.
     * @param {string} path - Any path.
     * @returns {string} the file's base name, or the path itself.
     */
    function fileNameOf(path) {
      const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      return at < 0 ? path : path.slice(at + 1);
    }

    /**
     * The sentence for one Host failure code.
     * @param {(key: string, params?: Record<string, unknown>) => string} t - Namespace-bound copy.
     * @param {string | undefined} code - Host failure code.
     * @returns {string} localized copy.
     */
    function uploadErrorText(t, code) {
      const key = code === undefined ? undefined : UPLOAD_ERROR_KEYS[code];
      return key === undefined ? t('upload.failed') : t(key);
    }

    /**
     * Parse one upload response without trusting its content type.
     * @param {XMLHttpRequest} xhr - finished request.
     * @returns {object | null} the parsed JSON object, or null.
     */
    function parseUploadResult(xhr) {
      try {
        const value = JSON.parse(xhr.responseText);
        return typeof value === 'object' && value !== null ? value : null;
      } catch {
        return null;
      }
    }

    /**
     * The document header's Download control: a 28px icon link beside the
     * preview's own tools.
     * @param {object} props - Slot owner inputs (`absolutePath`) plus copy.
     * @returns {object} the link, or null without a usable path.
     */
    function HeaderDownloadAction(props) {
      const { absolutePath, t } = props;
      if (typeof absolutePath !== 'string' || absolutePath.length === 0) return null;
      const href = downloadUrl(absolutePath);
      if (href === undefined) return null;
      return react_jsx_runtime.jsx(primitives.Tooltip, {
        label: t('action.downloadHint'),
        side: 'bottom',
        delayMs: 500,
        children: react_jsx_runtime.jsx('a', {
          className: 'dfd-tool',
          href,
          download: fileNameOf(absolutePath),
          'aria-label': t('action.download'),
          'data-file-download': 'preview',
          children: react_jsx_runtime.jsx(primitives.IconDownloadOutlineRegular, { size: 15 }),
        }),
      });
    }

    /**
     * The unpreviewable state's Download control: a labelled link where the
     * stock empty state offers a native "Open" instead.
     * @param {object} props - Slot owner inputs (`absolutePath`) plus copy.
     * @returns {object} the link, or null without a usable path.
     */
    function EmptyDownloadAction(props) {
      const { absolutePath, t } = props;
      if (typeof absolutePath !== 'string' || absolutePath.length === 0) return null;
      const href = downloadUrl(absolutePath);
      if (href === undefined) return null;
      return react_jsx_runtime.jsx('a', {
        className: 'dfd-empty',
        href,
        download: fileNameOf(absolutePath),
        'data-file-download': 'empty',
        children: [
          react_jsx_runtime.jsx(primitives.IconDownloadOutlineRegular, { size: 15 }, 'icon'),
          react_jsx_runtime.jsx('span', { children: t('action.empty') }, 'label'),
        ],
      });
    }

    /**
     * The workspace file view's Upload control, in its top-right action row.
     *
     * One `<input type="file">` is driven by the button; the chosen file goes
     * to `/api/file-upload` through XHR so `upload.onprogress` can paint the
     * percentage ring. A second transfer is refused by the busy guard and
     * again by the Host, whose per-Session lock answers 429. Every outcome —
     * success, refusal, or transport failure — ends in a sentence on a
     * Toast, so the header itself stays one icon wide.
     * @param {object} props - Slot owner inputs (`absolutePath`, `sessionId`)
     *   plus the standard slot props and copy.
     * @returns {object} the control, or null without a workspace and Session.
     */
    function FilesUploadAction(props) {
      const { absolutePath, sessionId, t } = props;
      const [phase, setPhase] = react.useState('idle');
      const [percent, setPercent] = react.useState(0);
      const [activeName, setActiveName] = react.useState('');
      const [toast, setToast] = react.useState(null);
      const inputRef = react.useRef(null);
      const xhrRef = react.useRef(null);
      const busyRef = react.useRef(false);
      const seqRef = react.useRef(0);
      const timerRef = react.useRef(null);
      const aliveRef = react.useRef(true);

      // Leaving the file view cancels its transfer: the Host stops reading
      // and deletes its staging file if anything is still in flight.
      react.useEffect(function () {
        aliveRef.current = true;
        return function () {
          aliveRef.current = false;
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          const xhr = xhrRef.current;
          xhrRef.current = null;
          busyRef.current = false;
          if (xhr !== null) xhr.abort();
        };
      }, []);

      const usable =
        typeof absolutePath === 'string' &&
        absolutePath.length > 0 &&
        typeof sessionId === 'string' &&
        sessionId.length > 0;

      /** Show one result sentence, replacing any earlier one. */
      const announce = function (text, tone) {
        seqRef.current += 1;
        setToast({ seq: seqRef.current, text: text, tone: tone });
      };

      /** Cancel the pending return to idle, so it cannot outlive this outcome. */
      const clearSettle = function () {
        if (timerRef.current === null) return;
        clearTimeout(timerRef.current);
        timerRef.current = null;
      };

      /** Return the button to idle after the outcome stays readable. */
      const settle = function () {
        clearSettle();
        timerRef.current = setTimeout(function () {
          timerRef.current = null;
          if (!aliveRef.current || busyRef.current) return;
          setPhase('idle');
          setPercent(0);
          setActiveName('');
        }, 2500);
      };

      /** Close one transfer: remember the outcome, then show it. */
      const finish = function (ok, text) {
        busyRef.current = false;
        xhrRef.current = null;
        if (!aliveRef.current) return;
        setPhase(ok ? 'success' : 'error');
        if (!ok) setPercent(0);
        announce(text, ok ? 'success' : 'error');
        settle();
      };

      /** Send one file to the displayed directory. */
      const uploadFile = function (file) {
        if (!aliveRef.current || busyRef.current) return;
        // A new attempt supersedes the previous outcome: its timer must not
        // reset this transfer, and its toast must not describe this one.
        clearSettle();
        setToast(null);
        if (file.size > MAX_UPLOAD_BYTES) {
          setPhase('error');
          setPercent(0);
          announce(t('upload.tooLarge'), 'error');
          settle();
          return;
        }
        const url = uploadUrl(absolutePath, sessionId, file.name);
        if (url === undefined) {
          setPhase('error');
          setPercent(0);
          announce(t('upload.failed'), 'error');
          settle();
          return;
        }
        busyRef.current = true;
        setPhase('uploading');
        setPercent(0);
        setActiveName(file.name);
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        if (xhr.upload !== null) {
          xhr.upload.onprogress = function (event) {
            if (!aliveRef.current || !event.lengthComputable || event.total <= 0) return;
            setPercent(Math.min(100, Math.round((event.loaded / event.total) * 100)));
          };
        }
        xhr.onload = function () {
          if (!aliveRef.current) return;
          const result = parseUploadResult(xhr);
          if (xhr.status >= 200 && xhr.status < 300 && result !== null && result.ok === true) {
            finish(true, t('upload.done', { name: file.name }));
            return;
          }
          const code = result !== null && result.error !== undefined ? result.error.code : undefined;
          finish(false, uploadErrorText(t, code));
        };
        xhr.onerror = function () {
          finish(false, t('upload.failed'));
        };
        xhr.onabort = function () {
          finish(false, t('upload.aborted'));
        };
        try {
          xhr.send(file);
        } catch {
          finish(false, t('upload.failed'));
        }
      };

      /** Open the browser's file chooser; a second transfer is refused. */
      const pick = function () {
        if (busyRef.current) return;
        const input = inputRef.current;
        if (input === null) return;
        input.value = '';
        input.click();
      };

      /** Take exactly one chosen file, keeping the picker reusable. */
      const chosen = function (event) {
        const input = event.currentTarget;
        // Read the File itself before clearing the input: `input.files` is a
        // live list, and resetting the value empties it.
        const file = input.files !== null && input.files.length > 0 ? input.files[0] : undefined;
        input.value = '';
        if (file === undefined) return;
        uploadFile(file);
      };

      if (!usable) return null;

      const uploading = phase === 'uploading';
      const label = uploading
        ? t('upload.uploading', { name: activeName, percent: percent })
        : phase === 'success'
          ? t('upload.done', { name: activeName })
          : t('upload.hint');
      const icon =
        phase === 'success'
          ? react_jsx_runtime.jsx(primitives.IconCheckCircleOutlineRegular, { size: 15 })
          : react_jsx_runtime.jsx(primitives.IconUploadOutlineRegular, { size: 15 });
      return react_jsx_runtime.jsx('span', {
        className: 'dfu-root',
        children: [
          react_jsx_runtime.jsx(
            primitives.Tooltip,
            {
              label,
              side: 'bottom',
              delayMs: 500,
              children: react_jsx_runtime.jsx('button', {
                type: 'button',
                className: 'dfu-tool',
                'data-file-upload': 'files',
                'data-state': phase,
                'aria-label': label,
                'aria-busy': uploading ? 'true' : undefined,
                'aria-disabled': uploading ? 'true' : undefined,
                onClick: pick,
                style: uploading ? { '--dfu-progress': percent } : undefined,
                // While uploading the ring is the only drawing: its arc
                // fills with the percentage, with no icon or spinner.
                children: uploading
                  ? react_jsx_runtime.jsx('span', { className: 'dfu-ring', 'aria-hidden': 'true' }, 'ring')
                  : icon,
              }),
            },
            'tool'
          ),
          react_jsx_runtime.jsx(
            'input',
            {
              ref: inputRef,
              type: 'file',
              className: 'dfu-input',
              'data-file-upload-input': 'files',
              tabIndex: -1,
              'aria-hidden': 'true',
              onChange: chosen,
            },
            'input'
          ),
          toast === null
            ? null
            : react_jsx_runtime.jsx(
                primitives.Toast,
                {
                  key: toast.seq,
                  text: toast.text,
                  tone: toast.tone === 'success' ? 'success' : undefined,
                  icon:
                    toast.tone === 'success'
                      ? undefined
                      : react_jsx_runtime.jsx(primitives.IconWarningOutlineRegular, { size: 15 }),
                  holdMs: toast.tone === 'success' ? 3000 : 5000,
                  onDone: function () {
                    if (aliveRef.current) setToast(null);
                  },
                },
                'toast'
              ),
        ],
      });
    }

    /** Required Client services: the slot registry and copy. */
    const inject = ['slots', 'locale'];

    /**
     * Register dictionaries, both Download contributions, and the workspace
     * Upload contribution.
     * @param {object} ctx - Client root context carrying the slots and locale.
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyles();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-io: dictionaries');

      // Preview download button
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.document.actions', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.document.actions',
                id: 'file-io',
                locale: NS,
              },
              HeaderDownloadAction
            )
          ),
        'file-io: document header action'
      );

      // No preview download button
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.document.unpreviewable',
                id: 'file-io',
                locale: NS,
              },
              EmptyDownloadAction
            )
          ),
        'file-io: unpreviewable action'
      );

      // Upload button
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.files.actions', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.tab.files.actions',
                id: 'file-io',
                locale: NS,
              },
              FilesUploadAction
            )
          ),
        'file-io: workspace upload action'
      );
    }

    exports.inject = inject;
    exports.apply = apply;
    // Exposed for the unit tests: pure helpers and the slot components,
    // none of which reads browser state outside `document.baseURI`.
    exports.downloadUrl = downloadUrl;
    exports.uploadUrl = uploadUrl;
    exports.fileNameOf = fileNameOf;
    exports.ensureStyles = ensureStyles;
    exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
    exports.HeaderDownloadAction = HeaderDownloadAction;
    exports.EmptyDownloadAction = EmptyDownloadAction;
    exports.FilesUploadAction = FilesUploadAction;
    return module.exports;
  },
});
