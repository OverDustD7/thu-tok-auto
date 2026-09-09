'use strict';
// THU Tok Auto — Client half.
// shell.overlay: [●][Get][Auto] buttons + in-box elapsed timer, above the settings cluster.
const OUTER = {
  // 'slots' is a hard dependency: on a fresh page load the client apply() runs before the slots
  // service is ready, and a ctx.get('slots') + undefined check silently skips the whole injection
  // (observed: after a page refresh the buttons vanished while client status stayed 'running').
  inject: ['timer', 'slots'],
  apply(ctx) {
    const report = function (tag, msg) {
      try { host.call('mmtok/clientlog', { tag: tag, err: String(msg && msg.message || msg) }).catch(function () {}); } catch (e) {}
    };
    try {
      const store = {
        auto: false, busy: false, lastGetAt: 0, loggedIn: false, status: 'idle', err: '',
        expiresAt: 0, browserOpen: false, provider: '', credentialWritten: false,
      };
      const listeners = new Set();
      const emit = function () {
        const s = Object.assign({}, store);
        listeners.forEach(function (fn) { fn(s); });
      };
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      const fmt = function (ms) {
        if (!ms || ms < 0) return '--:--';
        const sec = Math.floor(ms / 1000);
        const hh = Math.floor(sec / 3600);
        if (hh >= 100) return 'Too Long!';
        return pad(hh) + ':' + pad(Math.floor((sec % 3600) / 60));
      };
      const expiresText = function (at) {
        if (!at) return '';
        const ms = at - Date.now();
        if (ms <= 0) return '已过期';
        const min = Math.floor(ms / 60000);
        return '剩余 ' + Math.floor(min / 60) + 'h' + pad(min % 60) + 'm';
      };
      const statusText = function (s) {
        let t = '';
        if (s.busy) t = '获取中…';
        else if (s.status === 'needs-login') t = s.browserOpen ? '需要登录 · 窗口已打开' : '需要登录';
        else if (s.status === 'error') t = '出错：' + (s.err || '');
        else if (s.status === 'expired') t = 'token 已过期 · 点 Get';
        else if (s.status === 'ok') {
          t = s.credentialWritten ? ('已写入 ' + (s.provider || 'DeepSeek (THU)')) : 'token 已获取';
          const ex = expiresText(s.expiresAt);
          if (ex) t += ' · ' + ex;
        } else if (s.status === 'refreshing') t = '获取中…';
        else t = '未获取 · 点 Get';
        if (s.err && s.status !== 'error') t += ' · ' + s.err;
        return t;
      };
      const titleText = function (s) {
        const parts = ['THU Tok Auto'];
        if (s.lastGetAt) parts.push('距上次获取 ' + fmt(Date.now() - s.lastGetAt));
        if (s.expiresAt) parts.push('token ' + expiresText(s.expiresAt));
        if (s.auto) parts.push('Auto 开启：超过 05:50 自动刷新');
        parts.push('Get / Auto 在左下角侧边栏');
        return parts.join(' · ');
      };

      const refresh = function () {
        return host.call('mmtok/state').then(function (s) {
          if (!s) return;
          store.auto = !!s.auto; store.busy = !!s.busy; store.lastGetAt = s.lastGetAt || 0;
          store.loggedIn = !!s.loggedIn; store.status = s.status || 'idle'; store.err = s.err || '';
          store.expiresAt = s.expiresAt || 0;
          store.browserOpen = !!s.browserOpen; store.provider = s.provider || '';
          store.credentialWritten = !!s.credentialWritten;
          emit();
        }).catch(function (e) { report('state', e); });
      };

      const runGet = function () {
        if (store.busy) return Promise.resolve();
        store.busy = true;
        emit();
        return host.call('mmtok/get-tok', {}).then(function (r) {
          if (r && r.loginRequired) {
            return host.call('mmtok/open-login', {}).catch(function (e) { report('open-login', e); });
          }
        }).catch(function (e) { report('get-tok', e); })
          .then(function () { return refresh(); });
      };

      let tick = 0;
      ctx.interval(function () {
        tick++;
        if (tick % 10 === 1) refresh();
      }, 1000);

      ctx.effect(function () {
        host.call('mmtok/init').then(refresh).catch(function () { return refresh(); });
      });

      // ------------------------------------------------------------ components
      const useStore = function () {
        const [s, setS] = React.useState(store);
        React.useEffect(function () {
          const fn = function (next) { setS(next); };
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        }, []);
        return s;
      };

      const Actions = function (props) {
        const s = useStore();
        const [now, setNow] = React.useState(Date.now());
        React.useEffect(function () {
          const d = ctx.interval(function () { setNow(Date.now()); }, 1000);
          return d;
        }, []);
        const btnCls = function (extra) { return 'mmtok-btn' + (extra || ''); };
        const dotCls = 'mmtok-dot mmtok-' + (s.busy ? 'busy' : s.status === 'ok' ? 'ok' : 'off');
        const elapsed = s.lastGetAt ? now - s.lastGetAt : 0;
        return React.createElement('div', { className: 'mmtok-box' },
          React.createElement('div', { className: 'mmtok-btns', title: titleText(s) },
            React.createElement('span', { className: dotCls }),
            React.createElement('button', {
              className: s.busy ? btnCls(' mmtok-disabled') : btnCls(),
              disabled: s.busy ? true : undefined,
              title: statusText(s) + '\n点击获取最新 token：校园网自动签发并写入 THU Tok Auto (MadModel) 模型配置',
              onClick: function () { runGet(); },
            }, s.busy ? '…' : 'Get'),
            React.createElement('button', {
              className: s.auto ? btnCls(' mmtok-auto-on') : btnCls(),
              title: s.auto ? 'Auto 已开启：计时超过 05:50 自动 Get（点击关闭）' : '开启 Auto：计时超过 05:50 自动 Get',
              onClick: function () {
                const next = !s.auto;
                host.call('mmtok/set-auto', { on: next }).then(function (r) {
                  store.auto = !!(r && r.auto);
                }).then(function () { return refresh(); }).catch(function (e) { report('set-auto', e); });
              },
            }, s.auto ? 'Auto ✓' : 'Auto'),
            React.createElement('span', { className: 'mmtok-sep' }),
            React.createElement('span', { className: 'mmtok-elapsed' }, fmt(elapsed)),
            React.createElement('span', { className: 'mmtok-timer-status' },
              s.busy ? '…' : (s.status === 'needs-login' ? '⚠' : '')),
          ),
        );
      };

      // ------------------------------------------------------------ style
      styles.insert(
        '.mmtok-box{position:fixed;left:8px;bottom:114px;z-index:900;pointer-events:auto;}' +
        '.mmtok-btns{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:7px;background:transparent;border:1px solid rgba(128,128,128,.4);width:max-content;}' +
        '.mmtok-btn{font-size:14px;line-height:1.5;padding:0 6px;border-radius:5px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;white-space:nowrap;flex:none;}' +
        '.mmtok-btn:hover{border-color:rgba(128,128,128,.85);background:rgba(128,128,128,.18);}' +
        '.mmtok-btn.mmtok-auto-on{background:#4caf50;color:#fff;border-color:#4caf50;}' +
        '.mmtok-btn.mmtok-auto-on:hover{background:#43a047;border-color:#43a047;color:#fff;}' +
        '.mmtok-disabled{opacity:.5;cursor:default;}' +
        '.mmtok-dot{width:8px;height:8px;border-radius:50%;flex:none;}' +
        '.mmtok-ok{background:#4caf50;}' +
        '.mmtok-busy{background:#ffb300;animation:mmtok-pulse 1s infinite;}' +
        '.mmtok-off{background:#9e9e9e;}' +
        '@keyframes mmtok-pulse{0%,100%{opacity:1}50%{opacity:.3}}' +
        '.mmtok-sep{width:1px;height:14px;background:rgba(128,128,128,.5);flex:none;}' +
        '.mmtok-elapsed{font-size:14px;font-variant-numeric:tabular-nums;color:inherit;user-select:none;line-height:1;font-family:ui-monospace,Consolas,monospace;}' +
        '.mmtok-timer-status{min-width:8px;color:#ffb300;font-size:14px;}'
      );

      // ------------------------------------------------------------ slots
      // Hard dependency injected above, so ctx.slots is guaranteed ready here.
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'mmtok-actions',
          order: 5,
          label: function () { return 'THU Tok Auto'; },
        }, Actions);
      });
      return;
    } catch (e) {
      report('apply', e);
      console.error('[thu-tok-auto] client apply', e);
      return;
    }
  },
};
return OUTER;
