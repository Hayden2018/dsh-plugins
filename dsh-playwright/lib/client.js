/** Shipped classic-script Client half: no build step or private Client imports. */
window.__ModuleLoader__.load({
  id: 'playwright-browser',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'plugins.playwrightBrowser';
    const CONFIG_NS = 'playwright-browser';
    const en = {
      title: 'Browser attachment',
      toggle: 'Attempt auto approve on browser attachment',
      hint: 'Try to approve local Chrome debugging prompts on Windows. Off by default; supports 10 languages. Grants access to tabs and signed-in sessions—use only with trusted local apps and no other pending debugging requests.',
      failed: 'Could not save this option. Reload the page and try again.',
      saving: 'Saving…',
    };
    const zh = {
      title: '浏览器连接',
      toggle: '连接浏览器时尝试自动批准',
      hint: '尝试自动批准 Windows 本地 Chrome 的调试请求。默认关闭，支持 10 种语言。此操作会授予标签页和已登录会话的访问权限；请仅在信任本地应用且没有其他待批准调试请求时使用。',
      failed: '无法保存此选项。请重新加载页面后重试。',
      saving: '正在保存…',
    };
    // Same switch dimensions, keyboard semantics and tokens as the host Switch.
    const css = `
.pw-approval-section { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); }
.pw-approval-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 22px; }
.pw-approval-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.pw-approval-label { font-size: 14px; line-height: 22px; }
.pw-approval-hint { margin: 0; color: var(--dsw-alias-label-caption); font-size: 13px; line-height: 20px; }
.pw-approval-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 20px; }
.pw-approval-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer; }
.pw-approval-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.pw-approval-switch:disabled { cursor: default; opacity: 0.5; }
.pw-approval-switch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.pw-approval-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-switch-thumb); transition: transform 120ms ease; }
.pw-approval-switch[aria-checked='true'] .pw-approval-thumb { background: var(--dsw-alias-label-primary-foreground); transform: translateX(16px); }
@media (prefers-reduced-motion: reduce) { .pw-approval-thumb { transition: none; } }
`;

    function ApprovalSettings({ scope, t }) {
      const subscribe = React.useCallback((listener) => scope.subscribe(listener), [scope]);
      const snapshot = React.useCallback(() => scope.getSnapshot(), [scope]);
      const state = React.useSyncExternalStore(subscribe, snapshot, snapshot);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(null);
      const busy = React.useRef(false);
      const mounted = React.useRef(false);
      const id = React.useId();
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);
      if (state.status !== 'ready' || typeof state.value?.attemptAutoApprove !== 'boolean') return null;
      const checked = state.value.attemptAutoApprove;
      async function toggle() {
        if (busy.current || !state.writable) return;
        busy.current = true;
        setSaving(true);
        setError(null);
        try {
          const accepted = await scope.mutate([
            { op: 'set', path: ['attemptAutoApprove'], value: !checked },
          ], state.revision);
          if (!accepted && mounted.current) setError(t('failed'));
        } catch {
          if (mounted.current) setError(t('failed'));
        } finally {
          busy.current = false;
          if (mounted.current) setSaving(false);
        }
      }
      return h('section', { className: 'pw-approval-section', 'aria-busy': saving },
        h('style', null, css),
        h('h4', { className: 'pw-approval-title' }, t('title')),
        h('div', { className: 'pw-approval-row' },
          h('span', { id: `${id}-label`, className: 'pw-approval-label' }, t('toggle')),
          h('button', {
            type: 'button', role: 'switch', className: 'pw-approval-switch',
            'aria-checked': checked, 'aria-labelledby': `${id}-label`,
            'aria-describedby': `${id}-hint`, disabled: saving || !state.writable,
            onClick: toggle,
          }, h('span', { className: 'pw-approval-thumb' }))
        ),
        h('p', { id: `${id}-hint`, className: 'pw-approval-hint' }, t('hint')),
        saving ? h('p', { className: 'pw-approval-hint', role: 'status' }, t('saving')) : null,
        error ? h('p', { className: 'pw-approval-error', role: 'alert' }, error) : null
      );
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'playwright-browser: dictionaries');
        const scope = ctx.configForms.get(CONFIG_NS);
        // The Host exposes this namespace only on Windows. Never use navigator:
        // a phone can configure a Windows host, and vice versa.
        ctx.effect(() => ctx.configForms.whileServed([CONFIG_NS], () =>
          ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config', key: 'playwright-browser', locale: NS,
            inject: () => ({ scope }),
          }, ApprovalSettings))
        ), 'playwright-browser: attachment option');
      },
    };
  },
});
