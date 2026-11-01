/**
 * Prompt Editor Client half.
 *
 * A Settings page that previews the selected agent mode's real system-prompt
 * sections (assembled on the Host without creating a Session), then edits the
 * per-mode text appended after them for later Sessions.
 *
 * The Host loads this file directly as one classic script, so it is the shipped
 * artifact: everything it needs is in this file and no build step exists. The
 * HarnessSelect component is inlined for that reason; the sections below are
 * dictionaries, styles, controller, mode select, editor page, row entry, and
 * registration.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-editor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // --- Shared HarnessSelect component -------------------------------------
    // Inlined from the former workspace component components/HarnessSelect.js:
    // a sibling-file import cannot resolve in the browser because the client
    // half is a single classic script. The component styles itself from Harness
    // theme tokens and owns its listbox keyboard and placement behavior.
    /** Element id of the stylesheet installed by the component. */
    const STYLE_ID = 'dsh-harness-select-styles';

    /** Stylesheets already inserted per document, with the number of live users. */
    const stylesheets = new Map();

    /** Component CSS. Every color is a theme token; no literal colors here. */
    const HARNESS_SELECT_CSS = `
.dsh-hselect-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: auto;
  min-width: 260px;
  max-width: 100%;
  min-height: 36px;
  padding: 6px 10px 6px 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
}

.dsh-hselect-trigger:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2);
}

.dsh-hselect-trigger:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.dsh-hselect-trigger[aria-expanded='true'] {
  border-color: var(--dsw-alias-state-business-primary);
}

.dsh-hselect-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dsh-hselect-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-hselect-placeholder {
  color: var(--dsw-alias-label-tertiary);
}

.dsh-hselect-chevron {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--dsw-alias-label-caption);
  transition: transform 120ms ease;
}

.dsh-hselect-trigger[aria-expanded='true'] .dsh-hselect-chevron {
  transform: rotate(180deg);
}

@media (prefers-reduced-motion: reduce) {
  .dsh-hselect-chevron {
    transition: none;
  }
}

.dsh-hselect-menu {
  position: fixed;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: 0;
  box-sizing: border-box;
  padding: 4px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: var(--dsw-elevation-prominent);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.dsh-hselect-option {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
}

.dsh-hselect-option:hover:not(:disabled),
.dsh-hselect-option:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}

.dsh-hselect-option:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dsh-hselect-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dsh-hselect-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dsh-hselect-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-hselect-description {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 16px;
  white-space: normal;
}

.dsh-hselect-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

.dsh-hselect-check {
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 3px;
  color: var(--dsw-alias-label-primary);
  visibility: hidden;
}

.dsh-hselect-option[aria-selected='true'] .dsh-hselect-check {
  visibility: visible;
}
    `;

    /**
     * Insert the component stylesheet once and return an idempotent disposer.
     * @param doc - document that owns the stylesheet.
     * @returns release callback; removes the sheet when its last user leaves.
     */
    function installHarnessSelectStyles(doc = globalThis.document) {
      if (doc === undefined) return () => {};
      let entry = stylesheets.get(doc);
      if (entry === undefined) {
        const element = doc.createElement('style');
        element.id = STYLE_ID;
        element.textContent = HARNESS_SELECT_CSS;
        doc.head.appendChild(element);
        entry = { element, users: 0 };
        stylesheets.set(doc, entry);
      }
      entry.users += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.users -= 1;
        if (entry.users > 0) return;
        entry.element.remove();
        stylesheets.delete(doc);
      };
    }

    /**
     * Decide where the dropdown fits beside its trigger.
     * Pure so layout rules stay testable without a DOM.
     * @param options - trigger and menu measurements, item count, and viewport bounds.
     * @returns side, clamped left edge, width, and a height cap (null when the
     * list should not scroll).
     */
    function computeMenuPlacement({
      trigger,
      viewportWidth,
      viewportHeight,
      menuWidth,
      menuHeight,
      itemCount = 0,
      noScrollBelow = 6,
      minWidth = 0,
      maxHeight = 320,
      margin = 8,
    }) {
      const spaceBelow = viewportHeight - trigger.bottom - 4 - margin;
      const spaceAbove = trigger.top - 4 - margin;
      const measuredHeight = Math.max(menuHeight, 0);
      // Short lists never scroll: their real height drives the side choice, and no
      // max-height is applied. The comparison also leaves a scrollbar out when a
      // long list already fits, since scrollHeight excludes the card's border while
      // a max-height would include it.
      const scrollAllowed = itemCount >= noScrollBelow;
      const layoutHeight = scrollAllowed ? Math.min(measuredHeight, maxHeight) : measuredHeight;
      const side = layoutHeight > spaceBelow && spaceAbove > spaceBelow ? 'top' : 'bottom';
      const available = side === 'top' ? spaceAbove : spaceBelow;
      const cap = Math.min(maxHeight, available);
      const cappedHeight = scrollAllowed && cap < measuredHeight ? Math.max(0, cap) : null;
      const width = Math.min(
        Math.max(menuWidth, minWidth, trigger.width),
        Math.max(0, viewportWidth - margin * 2)
      );
      const left = Math.min(Math.max(trigger.left, margin), Math.max(margin, viewportWidth - width - margin));
      return { side, left, width, maxHeight: cappedHeight };
    }

    /**
     * Build the select component for a React runtime.
     * @param React - the React runtime (`require('react')` in a Client half).
     * @returns the `HarnessSelect` component.
     */
    function createHarnessSelect(React) {
      const h = React.createElement;
      const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React;
      const useInsertion = React.useInsertionEffect ?? useLayoutEffect;

      const ChevronIcon = (props) =>
        h(
          'svg',
          {
            ...props,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('path', { d: 'm4 6 4 4 4-4' })
        );

      const CheckIcon = (props) =>
        h(
          'svg',
          {
            ...props,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('path', { d: 'm3.5 8.5 3 3 6-6.5' })
        );

      /**
       * Accessible listbox styled as a Harness form control.
       * @param props - controlled value, options, and change callback.
       * @returns the trigger and, while open, the dropdown card.
       */
      function HarnessSelect(props) {
        const {
          id,
          labelledBy,
          describedBy,
          value,
          options = [],
          onChange,
          disabled = false,
          placeholder = 'Select…',
          minMenuWidth = 280,
          maxMenuHeight = 320,
          noScrollBelow = 6,
          className,
        } = props;

        useInsertion(() => installHarnessSelectStyles(), []);

        const triggerRef = useRef(null);
        const menuRef = useRef(null);
        const optionRefs = useRef([]);
        const [open, setOpen] = useState(false);
        const [activeIndex, setActiveIndex] = useState(0);
        const [anchor, setAnchor] = useState(null);
        const [menuStyle, setMenuStyle] = useState(null);

        const selectedIndex = options.findIndex((option) => option.value === value);
        const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

        const closeMenu = useCallback((restoreFocus) => {
          setOpen(false);
          setMenuStyle(null);
          if (restoreFocus) triggerRef.current?.focus();
        }, []);

        const openMenu = useCallback(() => {
          if (disabled || options.length === 0) return;
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect === undefined) return;
          setAnchor({ top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width });
          setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
          setMenuStyle(null);
          setOpen(true);
        }, [disabled, options.length, selectedIndex]);

        const move = useCallback(
          (offset) => {
            setActiveIndex((current) => {
              if (options.length === 0) return 0;
              return (current + offset + options.length) % options.length;
            });
          },
          [options.length]
        );

        const choose = useCallback(
          (index) => {
            const option = options[index];
            if (option === undefined || option.disabled === true) return;
            if (option.value !== value) onChange?.(option.value);
            closeMenu(true);
          },
          [options, value, onChange, closeMenu]
        );

        useLayoutEffect(() => {
          if (!open) return undefined;
          const place = () => {
            const menu = menuRef.current;
            const trigger = triggerRef.current;
            if (menu === null || trigger === null) return;
            const rect = trigger.getBoundingClientRect();
            const menuHeight = menu.scrollHeight;
            const placement = computeMenuPlacement({
              trigger: { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width },
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              menuWidth: menu.offsetWidth || minMenuWidth,
              menuHeight,
              itemCount: options.length,
              noScrollBelow,
              minWidth: minMenuWidth,
              maxHeight: maxMenuHeight,
            });
            const next = {
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              ...(placement.side === 'top'
                ? { bottom: window.innerHeight - rect.top + 4 }
                : { top: rect.bottom + 4 }),
            };
            setMenuStyle((current) =>
              current !== null &&
              current.left === next.left &&
              current.width === next.width &&
              current.maxHeight === next.maxHeight &&
              current.top === next.top &&
              current.bottom === next.bottom
                ? current
                : next
            );
          };
          place();
          window.addEventListener('resize', place);
          window.addEventListener('scroll', place, true);
          return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
          };
        }, [open, maxMenuHeight, minMenuWidth, noScrollBelow, options.length]);

        useLayoutEffect(() => {
          if (!open) return;
          const option = optionRefs.current[activeIndex];
          option?.focus({ preventScroll: true });
          option?.scrollIntoView?.({ block: 'nearest' });
        }, [open, activeIndex]);

        useEffect(() => {
          if (!open) return undefined;
          const onPointerDown = (event) => {
            if (triggerRef.current?.contains(event.target)) return;
            if (menuRef.current?.contains(event.target)) return;
            closeMenu(false);
          };
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closeMenu(true);
          };
          document.addEventListener('pointerdown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown, true);
          return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }, [open, closeMenu]);

        const onTriggerKeyDown = (event) => {
          if (
            event.key !== 'ArrowDown' &&
            event.key !== 'ArrowUp' &&
            event.key !== 'Enter' &&
            event.key !== ' '
          )
            return;
          event.preventDefault();
          openMenu();
        };

        // Focus leaving the control and its list closes the list. Tab therefore
        // behaves normally: focus moves on first, then the now-hidden card goes.
        const onBlur = (event) => {
          const next = event.relatedTarget;
          if (
            next instanceof Node &&
            (triggerRef.current?.contains(next) === true || menuRef.current?.contains(next) === true)
          )
            return;
          if (open) closeMenu(false);
        };

        const onMenuKeyDown = (event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            move(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            move(-1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            setActiveIndex(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            setActiveIndex(options.length - 1);
          }
        };

        const triggerLabel = selected !== undefined ? selected.label : placeholder;
        const listId = id === undefined ? undefined : `${id}-listbox`;
        const menuPlacement =
          menuStyle === null
            ? anchor === null
              ? { visibility: 'hidden' }
              : {
                  visibility: 'hidden',
                  left: anchor.left,
                  width: Math.max(anchor.width, minMenuWidth),
                  top: anchor.bottom + 4,
                }
            : { visibility: 'visible', ...menuStyle };

        return h(
          React.Fragment,
          null,
          h(
            'button',
            {
              ref: triggerRef,
              id,
              type: 'button',
              className: ['dsh-hselect-trigger', className].filter(Boolean).join(' '),
              'aria-haspopup': 'listbox',
              'aria-expanded': open,
              'aria-controls': open ? listId : undefined,
              'aria-labelledby': labelledBy,
              'aria-describedby': describedBy,
              disabled: disabled || options.length === 0,
              onClick: () => {
                if (open) closeMenu(true);
                else openMenu();
              },
              onKeyDown: onTriggerKeyDown,
              onBlur,
            },
            h(
              'span',
              {
                className:
                  selected === undefined ? 'dsh-hselect-value dsh-hselect-placeholder' : 'dsh-hselect-value',
              },
              triggerLabel
            ),
            h(ChevronIcon, { className: 'dsh-hselect-chevron' })
          ),
          open
            ? h(
                'div',
                {
                  ref: menuRef,
                  id: listId,
                  role: 'listbox',
                  className: 'dsh-hselect-menu',
                  style: menuPlacement,
                  'aria-labelledby': labelledBy,
                  onKeyDown: onMenuKeyDown,
                  onBlur,
                },
                options.map((option, index) =>
                  h(
                    'button',
                    {
                      key: option.value,
                      ref: (node) => {
                        optionRefs.current[index] = node;
                      },
                      type: 'button',
                      role: 'option',
                      tabIndex: -1,
                      'aria-selected': option.value === value,
                      disabled: option.disabled === true,
                      className: 'dsh-hselect-option',
                      onClick: () => choose(index),
                    },
                    h(
                      'span',
                      { className: 'dsh-hselect-copy' },
                      h(
                        'span',
                        { className: 'dsh-hselect-line' },
                        h('span', { className: 'dsh-hselect-label' }, option.label),
                        option.badge === undefined
                          ? null
                          : h('span', { className: 'dsh-hselect-badge' }, option.badge)
                      ),
                      option.description === undefined
                        ? null
                        : h('span', { className: 'dsh-hselect-description' }, option.description)
                    ),
                    h(CheckIcon, { className: 'dsh-hselect-check' })
                  )
                )
              )
            : null
        );
      }

      return HarnessSelect;
    }

    // The mode control is a Harness-styled listbox. A factory failure must not
    // blank the settings entry: the native select below remains the fallback.
    let HarnessSelect = null;
    try {
      HarnessSelect = createHarnessSelect(React);
    } catch (error) {
      console.error('prompt-editor: custom mode select unavailable; using the native select', error);
    }

    const NS = 'settings.promptEditor';
    const CONFIG_NS = 'prompt-editor';
    const ROW_CONFIG_KEY = 'dsh-prompt-editor#prompt-editor';
    const PREVIEW_URL = '/prompt-editor/preview';

    // --- Locale dictionaries -------------------------------------------------
    const en = {
      nav: 'Prompt Editor',
      title: 'Prompt Editor',
      description: "Preview each agent mode's system prompt and add instructions for that mode.",
      summary: 'Per-mode system-prompt additions with a read-only preview.',
      mode: 'Agent mode',
      modeHint:
        'Each mode is an agent preset. The preview is read-only; the text you add is appended after it.',
      defaultBadge: 'default',
      brokenBadge: 'broken',
      globalMode: 'Global (no preset)',
      previewTitle: 'Existing system prompt',
      previewHint:
        "Assembled from the mode's global and preset-scoped sections. Tool schemas and runtime context are not shown.",
      previewLoading: 'Assembling preview…',
      previewEmpty: '(No system-prompt sections.)',
      warnings: 'Notes',
      likelyComplete: 'This mode uses a complete prompt. There is no per-mode addition to edit.',
      editorTitle: 'Additional instructions for this mode',
      editorHint:
        'This text is appended after the prompt above for new and resumed sessions. It does not replace the existing prompt.',
      editorPlaceholder: 'Add mode-specific instructions here…',
      save: 'Save for new sessions',
      saving: 'Saving…',
      saved: 'Saved. New and resumed sessions will use this text.',
      syncAll: 'Sync to all modes',
      syncing: 'Syncing…',
      syncHint:
        'Save this text for the current mode and replace the saved addition in every other agent mode.',
      syncNeedText: 'Enter text before syncing to all modes.',
      syncConfirm: 'Apply this text to every agent mode? This replaces the saved addition for each mode.',
      syncedAll: 'Synced to all modes. New and resumed sessions will use this text.',
      syncFailed: 'Could not sync the text.',
      clear: 'Clear addition',
      clearing: 'Clearing…',
      clearConfirm: 'Clear the additional instructions for this mode?',
      loadingSettings: 'Loading settings…',
      unavailable: "This plugin's settings are unavailable.",
      notWritable: 'Settings are read-only.',
      loadPresetsFailed: 'Could not load agent modes.',
      previewFailed: 'Could not assemble the preview.',
      saveFailed: 'Could not save the text.',
      refresh: 'Refresh preview',
      sections: 'sections',
      defaultMode: 'Default',
      unsaved: 'Unsaved changes',
    };

    const zh = {
      nav: '提示词编辑器',
      title: '提示词编辑器',
      description: '预览各智能体模式的系统提示词，并为该模式追加指令。',
      summary: '按智能体模式预览系统提示词，并追加该模式的专属指令。',
      mode: '智能体模式',
      modeHint: '每个模式对应一个智能体预设。上方预览只读，下方文本会追加到其后。',
      defaultBadge: '默认',
      brokenBadge: '异常',
      globalMode: '全局（无预设）',
      previewTitle: '现有系统提示词',
      previewHint: '由全局与预设作用域的提示词分区组装；不包含工具 schema 与运行时上下文。',
      previewLoading: '正在组装预览…',
      previewEmpty: '（当前没有系统提示词分区。）',
      warnings: '说明',
      likelyComplete: '该模式使用完整提示词，没有可编辑的模式专属附加内容。',
      editorTitle: '该模式的附加指令',
      editorHint: '这些文本会追加到上方提示词之后，用于新建或恢复的会话；它不会替换现有提示词。',
      editorPlaceholder: '在此填写该模式的附加指令…',
      save: '保存给新会话',
      saving: '保存中…',
      saved: '已保存。新建与恢复的会话会使用这些文本。',
      syncAll: '同步到所有模式',
      syncing: '同步中…',
      syncHint: '将当前文本保存到当前模式，并替换所有其他智能体模式已保存的附加内容。',
      syncNeedText: '请先输入文本，再同步到所有模式。',
      syncConfirm: '将此文本应用到所有智能体模式？这会替换每个模式已保存的附加内容。',
      syncedAll: '已同步到所有模式。新建与恢复的会话会使用这些文本。',
      syncFailed: '无法同步文本。',
      clear: '清除附加内容',
      clearing: '清除中…',
      clearConfirm: '清除该模式的附加指令？',
      loadingSettings: '正在加载设置…',
      unavailable: '该插件的设置不可用。',
      notWritable: '设置为只读。',
      loadPresetsFailed: '无法加载智能体模式。',
      previewFailed: '无法组装预览。',
      saveFailed: '无法保存文本。',
      refresh: '刷新预览',
      sections: '个分区',
      defaultMode: '默认',
      unsaved: '有未保存修改',
    };

    // --- Styles --------------------------------------------------------------
    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '0',
        maxWidth: '980px',
        color: 'var(--dsw-alias-label-primary)',
        boxSizing: 'border-box',
      },
      title: { margin: 0, fontSize: '20px', fontWeight: 600 },
      description: { margin: 0, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '16px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      hint: {
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      row: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
      select: {
        minWidth: '260px',
        maxWidth: '100%',
        padding: '6px 12px',
        borderRadius: 'var(--dsw-radius-md)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
      badge: {
        padding: '2px 7px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        lineHeight: 1.6,
      },
      pre: {
        margin: 0,
        padding: '12px',
        maxHeight: '340px',
        overflow: 'auto',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      textarea: {
        minHeight: '170px',
        width: '100%',
        boxSizing: 'border-box',
        resize: 'vertical',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: 1.55,
        fontFamily: 'inherit',
      },
      warning: {
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      error: {
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      note: {
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      primary: {
        padding: '8px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
      },
      sync: {
        padding: '8px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
      },
      secondary: {
        padding: '8px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      subtle: {
        padding: '6px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        cursor: 'pointer',
      },
      list: {
        margin: 0,
        paddingLeft: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
    };

    // --- Controller ----------------------------------------------------------
    class PromptEditorController {
      constructor(ctx) {
        this.ctx = ctx;
        this.form = ctx.configForms.get(CONFIG_NS);
      }

      subscribe(listener) {
        return this.form.subscribe(listener);
      }

      state() {
        return this.form.getSnapshot();
      }

      prompts() {
        const value = this.form.getSnapshot().value;
        if (value === null || typeof value !== 'object') return {};
        const prompts = value.prompts;
        return prompts !== null && typeof prompts === 'object' ? prompts : {};
      }

      textFor(preset) {
        const value = this.prompts()[preset];
        return typeof value === 'string' ? value : '';
      }

      async listPresets() {
        const result = await this.ctx.remote.agentPresets.list();
        if (result === null || result === undefined || result.ok !== true) {
          throw new Error(result?.error?.message ?? 'agent preset list failed');
        }
        const rows = Array.isArray(result.value?.presets) ? result.value.presets : [];
        return rows
          .filter(
            (row) =>
              row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id.length > 0
          )
          .map((row) => ({
            id: row.id,
            name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
            description: typeof row.description === 'string' ? row.description : '',
            isDefault: row.isDefault === true,
            broken: typeof row.broken === 'string' && row.broken.length > 0 ? row.broken : null,
          }));
      }

      async preview(preset) {
        const query =
          preset !== undefined && preset.length > 0 && preset !== '*'
            ? `?preset=${encodeURIComponent(preset)}`
            : '';
        const response = await fetch(`${PREVIEW_URL}${query}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) {
          if (response.status === 401) throw new Error('Sign in again to read the system prompt.');
          if (response.status === 403) throw new Error('This account may not read the system prompt.');
          throw new Error(`Preview request failed (${response.status}).`);
        }
        const result = await response.json();
        if (result === null || typeof result !== 'object' || result.ok !== true) {
          throw new Error(result?.error?.message ?? 'preview failed');
        }
        return result;
      }

      async save(preset, text) {
        const state = this.form.getSnapshot();
        if (state.status !== 'ready' || state.writable !== true) {
          throw new Error('settings are not writable');
        }
        const next = { ...this.prompts(), [preset]: text };
        const accepted = await this.form.set('prompts', next);
        if (!accepted) throw new Error('host rejected the settings change');
      }

      /**
       * Write the same text for every mode in one config update. The Host reads
       * this map when a Session is created, so no extra Host endpoint is needed.
       */
      async saveAll(preset, text, presets) {
        const state = this.form.getSnapshot();
        if (state.status !== 'ready' || state.writable !== true) {
          throw new Error('settings are not writable');
        }
        // Keys outside the current mode list (including the no-preset fallback)
        // stay untouched, so syncing never edits a hidden entry.
        const next = { ...this.prompts() };
        const targets = new Set(Array.isArray(presets) ? presets : []);
        if (typeof preset === 'string' && preset.length > 0) targets.add(preset);
        for (const id of targets) {
          if (typeof id === 'string' && id.length > 0) next[id] = text;
        }
        const accepted = await this.form.set('prompts', next);
        if (!accepted) throw new Error('host rejected the settings change');
      }

      async clear(preset) {
        const state = this.form.getSnapshot();
        if (state.status !== 'ready' || state.writable !== true) {
          throw new Error('settings are not writable');
        }
        const next = { ...this.prompts() };
        delete next[preset];
        const accepted = await this.form.set('prompts', next);
        if (!accepted) throw new Error('host rejected the settings change');
      }
    }

    // --- Mode select ---------------------------------------------------------
    /** Native mode picker kept as the fallback for the custom component. */
    function NativeModeSelect({ id, value, modes, disabled, onChange, t }) {
      return h(
        'select',
        {
          id,
          style: styles.select,
          value,
          disabled,
          onChange: (event) => onChange(event.target.value),
        },
        modes.map((row) =>
          h(
            'option',
            { key: row.id, value: row.id },
            `${row.name}${row.isDefault ? ` · ${t('defaultBadge')}` : ''}${row.broken !== null ? ` · ${t('brokenBadge')}` : ''}`
          )
        )
      );
    }

    /**
     * Keep the settings page usable if the custom control ever fails to render:
     * React error boundaries only catch render/lifecycle errors, which is where
     * a component dependency mismatch would surface.
     */
    class ModeSelectBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error('prompt-editor: mode select failed; using the native select', error);
      }

      render() {
        return this.state.failed ? this.props.fallback() : this.props.children;
      }
    }

    // --- Editor page ---------------------------------------------------------
    function PromptEditorEditor(props) {
      const controller = props.controller;
      const t = typeof props.t === 'function' ? props.t : (key) => (en[key] !== undefined ? en[key] : key);

      const [mode, setMode] = React.useState('');
      const [modes, setModes] = React.useState([]);
      const [modesError, setModesError] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [previewError, setPreviewError] = React.useState(null);
      const [previewLoading, setPreviewLoading] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [dirty, setDirty] = React.useState(false);
      const [actionError, setActionError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [pending, setPending] = React.useState(null);
      const [formTick, setFormTick] = React.useState(0);
      const [previewTick, setPreviewTick] = React.useState(0);
      const dirtyRef = React.useRef(false);
      const previewRequest = React.useRef(0);

      const form = controller.state();
      const writable = form.status === 'ready' && form.writable === true;
      const saving = pending !== null;

      React.useEffect(() => {
        const off = controller.subscribe(() => {
          setFormTick((value) => value + 1);
        });
        return off;
      }, [controller]);

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const rows = await controller.listPresets();
            if (cancelled) return;
            if (rows.length === 0) {
              setModes([{ id: '*', name: t('globalMode'), isDefault: true, broken: null }]);
              setMode('*');
            } else {
              setModes(rows);
              setMode(rows.find((row) => row.isDefault)?.id ?? rows[0].id);
            }
            setModesError(null);
          } catch (error) {
            if (cancelled) return;
            setModes([{ id: '*', name: t('globalMode'), isDefault: true, broken: null }]);
            setMode('*');
            setModesError(`${t('loadPresetsFailed')} ${String(error?.message ?? error)}`);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [controller]);

      React.useEffect(() => {
        if (mode.length === 0) return;
        setDraft(controller.textFor(mode));
        setDirty(false);
        dirtyRef.current = false;
        setActionError(null);
        setNotice(null);
      }, [controller, mode]);

      React.useEffect(() => {
        if (mode.length === 0 || dirtyRef.current) return;
        setDraft(controller.textFor(mode));
      }, [controller, mode, formTick]);

      React.useEffect(() => {
        if (mode.length === 0) return;
        const request = ++previewRequest.current;
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(true);
        controller
          .preview(mode)
          .then((result) => {
            if (request !== previewRequest.current) return;
            setPreview(result);
            setPreviewLoading(false);
          })
          .catch((error) => {
            if (request !== previewRequest.current) return;
            setPreviewError(String(error?.message ?? error));
            setPreviewLoading(false);
          });
      }, [controller, mode, previewTick]);

      const selectedMode = modes.find((row) => row.id === mode);
      const modeName = selectedMode?.name ?? mode;
      const canSave = writable && dirty && !saving;
      const canSync = writable && !saving && modes.length > 0 && mode.length > 0 && draft.trim().length > 0;
      const statusText =
        form.status === 'loading'
          ? t('loadingSettings')
          : form.status === 'unavailable'
            ? t('unavailable')
            : form.writable !== true
              ? t('notWritable')
              : null;

      const changeMode = (nextMode) => {
        setDirty(false);
        dirtyRef.current = false;
        setMode(nextMode);
      };

      // The menu shows what a preset is for, matching the host's preset chip.
      const modeOptions = modes.map((row) => ({
        value: row.id,
        label: row.name,
        ...(row.isDefault ? { badge: t('defaultBadge') } : {}),
        ...(row.broken !== null && typeof row.broken === 'string'
          ? { description: row.broken }
          : typeof row.description === 'string' && row.description.length > 0
            ? { description: row.description }
            : {}),
      }));

      const nativeModeSelect = () =>
        h(NativeModeSelect, {
          id: 'prompt-editor-mode',
          value: mode,
          modes,
          disabled: modes.length === 0,
          onChange: changeMode,
          t,
        });

      const save = async () => {
        if (!canSave) return;
        setPending('save');
        setActionError(null);
        setNotice(null);
        try {
          await controller.save(mode, draft);
          setDirty(false);
          dirtyRef.current = false;
          setNotice(t('saved'));
        } catch (error) {
          setActionError(`${t('saveFailed')} ${String(error?.message ?? error)}`);
        } finally {
          setPending(null);
        }
      };

      const syncAll = async () => {
        if (!canSync) return;
        if (modes.length > 1 && !window.confirm(t('syncConfirm'))) return;
        setPending('sync');
        setActionError(null);
        setNotice(null);
        try {
          await controller.saveAll(
            mode,
            draft,
            modes.map((row) => row.id)
          );
          setDirty(false);
          dirtyRef.current = false;
          setNotice(t('syncedAll'));
        } catch (error) {
          setActionError(`${t('syncFailed')} ${String(error?.message ?? error)}`);
        } finally {
          setPending(null);
        }
      };

      const clear = async () => {
        if (!writable || saving) return;
        if (draft.trim().length > 0 && !window.confirm(t('clearConfirm'))) return;
        setPending('clear');
        setActionError(null);
        setNotice(null);
        try {
          await controller.clear(mode);
          setDraft('');
          setDirty(false);
          dirtyRef.current = false;
          setNotice(t('saved'));
        } catch (error) {
          setActionError(`${t('saveFailed')} ${String(error?.message ?? error)}`);
        } finally {
          setPending(null);
        }
      };

      // The page is three cards. Each render helper closes over the page state
      // and returns one card, so the outer tree stays a short list.
      const renderModeCard = () =>
        h(
          'div',
          { style: styles.card },
          h(
            'label',
            {
              id: 'prompt-editor-mode-label',
              htmlFor: 'prompt-editor-mode',
              style: styles.cardTitle,
            },
            t('mode')
          ),
          h(
            'div',
            { style: styles.row },
            h(
              ModeSelectBoundary,
              { fallback: nativeModeSelect },
              HarnessSelect === null
                ? nativeModeSelect()
                : h(HarnessSelect, {
                    id: 'prompt-editor-mode',
                    labelledBy: 'prompt-editor-mode-label',
                    value: mode,
                    options: modeOptions,
                    disabled: modes.length === 0,
                    onChange: changeMode,
                  })
            ),
            selectedMode?.isDefault ? h('span', { style: styles.badge }, t('defaultBadge')) : null,
            dirty ? h('span', { style: styles.badge }, t('unsaved')) : null
          ),
          h('p', { style: styles.hint }, t('modeHint')),
          modesError === null && selectedMode?.broken
            ? h('div', { style: styles.error, role: 'alert' }, selectedMode.broken)
            : null
        );

      const renderPreviewCard = () =>
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('h3', { style: styles.cardTitle }, t('previewTitle')),
            h('span', { style: styles.badge }, modeName),
            preview !== null
              ? h('span', { style: styles.badge }, `${preview.sectionCount} ${t('sections')}`)
              : null,
            h(
              'button',
              {
                type: 'button',
                style: styles.subtle,
                disabled: previewLoading || mode.length === 0,
                onClick: () => setPreviewTick((value) => value + 1),
              },
              t('refresh')
            )
          ),
          h('p', { style: styles.hint }, t('previewHint')),
          previewLoading ? h('p', { style: styles.note, role: 'status' }, t('previewLoading')) : null,
          previewError !== null
            ? h('div', { style: styles.error, role: 'alert' }, `${t('previewFailed')} ${previewError}`)
            : null,
          preview !== null
            ? h(
                React.Fragment,
                null,
                h(
                  'pre',
                  { style: styles.pre, 'aria-label': t('previewTitle') },
                  preview.prompt.length > 0 ? preview.prompt : t('previewEmpty')
                ),
                preview.warnings?.length > 0
                  ? h(
                      'ul',
                      { style: styles.list },
                      preview.warnings.map((warning, index) => h('li', { key: index }, warning))
                    )
                  : null
              )
            : null,
          preview?.likelyComplete
            ? h('div', { style: styles.warning, role: 'alert' }, t('likelyComplete'))
            : null
        );

      const renderEditorCard = () =>
        preview !== null && preview.likelyComplete !== true
          ? h(
              'div',
              { style: styles.card },
              h('label', { htmlFor: 'prompt-editor-text', style: styles.cardTitle }, t('editorTitle')),
              h('p', { style: styles.hint }, t('editorHint')),
              h('textarea', {
                id: 'prompt-editor-text',
                style: styles.textarea,
                value: draft,
                placeholder: t('editorPlaceholder'),
                disabled: !writable || saving,
                onChange: (event) => {
                  setDraft(event.target.value);
                  setDirty(true);
                  dirtyRef.current = true;
                  setNotice(null);
                  setActionError(null);
                },
              }),
              h(
                'div',
                { style: styles.actions },
                h(
                  'button',
                  { type: 'button', style: styles.primary, disabled: !canSave, onClick: save },
                  pending === 'save' ? t('saving') : t('save')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.sync,
                    disabled: !canSync,
                    title: draft.trim().length === 0 ? t('syncNeedText') : t('syncHint'),
                    onClick: syncAll,
                  },
                  pending === 'sync' ? t('syncing') : t('syncAll')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.secondary,
                    disabled: !writable || saving,
                    onClick: clear,
                  },
                  pending === 'clear' ? t('clearing') : t('clear')
                ),
                dirty ? h('span', { style: styles.hint }, t('unsaved')) : null
              ),
              notice !== null ? h('p', { style: styles.note, role: 'status' }, notice) : null,
              actionError !== null ? h('div', { style: styles.error, role: 'alert' }, actionError) : null
            )
          : null;

      return h(
        'section',
        { style: styles.page },
        statusText !== null ? h('div', { style: styles.note, role: 'status' }, statusText) : null,
        modesError !== null ? h('div', { style: styles.error, role: 'alert' }, modesError) : null,
        renderModeCard(),
        renderPreviewCard(),
        renderEditorCard()
      );
    }

    // --- Row entry -----------------------------------------------------------
    /**
     * The Plugins page asks for a summary one-liner on the row and for the full
     * editor once the row's configure control is opened.
     */
    function PromptEditorSection(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => (en[key] !== undefined ? en[key] : key);
      if (props.view === 'summary') return h('span', null, t('summary'));
      return h(PromptEditorEditor, props);
    }

    // --- Registration --------------------------------------------------------
    return {
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.agentPresets'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prompt-editor: dictionaries');
        const controller = new PromptEditorController(ctx);
        ctx.effect(
          () =>
            ctx.configForms.whileServed([CONFIG_NS], () =>
              ctx.slots.inject('plugins.row.config', () =>
                ctx.slots.register(
                  {
                    name: 'plugins.row.config',
                    key: ROW_CONFIG_KEY,
                    locale: NS,
                    inject: () => ({ controller }),
                  },
                  PromptEditorSection
                )
              )
            ),
          'prompt-editor: plugin row page'
        );
      },
    };
  },
});
