/* @local/arknights — Web panel client half.
 *
 * Plain browser JavaScript: no JSX, no TypeScript, no bundler step. The Harness
 * Web GUI loads this file and its `factory(require)` registers a lazy client
 * plugin whose id equals the package name. React comes from the page's module
 * table (`require('react')`). No package import, no JSX, no build step.
 *
 * It registers exactly two slots:
 *   - `sidebar.panellist` (list, id `arknights`): the inline SVG icon, props
 *     `{ size, active }` supplied by the sidebar row.
 *   - `main` (keyed, key `arknights`): the panel body.
 *
 * Host interface (docs/contracts.md §5 / §9):
 *   GET  /arknights/status  -> status JSON, polled every 3 s while mounted
 *   POST /arknights/action  -> { ok, text, status? } | { ok:false, error }
 */
window.__ModuleLoader__.load({
  id: '@local/arknights',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    const NS = 'arknights';
    const PANEL_ID = 'arknights';
    const STATUS_URL = '/arknights/status';
    const ACTION_URL = '/arknights/action';
    const POLL_INTERVAL_MS = 3000;
    const REQUEST_TIMEOUT_MS = 8000;
    const EVENT_LIMIT = 5;

    /** Integrated Strategies themes accepted by MAA. */
    const ROGUE_THEMES = ['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden'];
    /** Integrated Strategies modes accepted by MAA. */
    const ROGUE_MODES = ['Exp', 'Invest', 'Start', 'DeepExploration'];

    /* ------------------------------------------------------------------ *
     * Dictionaries — mirror of locale/zh.json and locale/en.json, embedded
     * because the browser half has no filesystem access. They are flattened
     * to dot keys: the locale runtime looks dictionaries up by exact key.
     * ------------------------------------------------------------------ */
    const ZH_NESTED = {
      meta: {
        title: '明日方舟 · 打关卡',
        description: '用本机 MAA + MuMu 模拟器打《明日方舟》：指定关卡就打那关（能代理走代理，不能代理抄作业）、按主线顺序推关、跑集成战略，并带状态面板与关卡账本；另含「明日方舟」智能体预设用的 7 个查询/排查工具。',
      },
      panel: {
        title: '明日方舟',
        subtitle: '打关卡 · 推关 · 肉鸽',
        status: '状态',
        emulator: '模拟器',
        connection: '连接',
        task: '任务',
        ledger: '关卡账本',
        events: '最近事件',
        offline: '状态不可用（Host 未响应）',
        loading: '读取中…',
      },
      labels: {
        stage: '关卡',
        stagesHint: '例如 5-10 或 5-10,6-5',
        times: '次数',
        from: '起点',
        chapter: '章节',
        theme: '主题',
        mode: '模式',
        fullStar: '满星',
        missing: '未满星',
        prime: '已领源石',
        running: '进行中',
        idle: '空闲',
        connected: '已连接',
        disconnected: '未连接',
        emulatorRunning: '运行中',
        emulatorStopped: '未启动',
        adbOnline: 'adb 在线',
        adbOffline: 'adb 离线',
      },
      actions: {
        preview: '预览',
        fight: '打关卡',
        push: '推关',
        rogue: '肉鸽',
        stop: '停止',
        refresh: '刷新',
        confirm: '确认执行',
        cancel: '取消',
      },
      hints: {
        confirmNeeded: '先预览，再点「确认执行」才会真正开打',
        noStage: '请先填写关卡代码',
        stopped: '已发送停止指令',
        actionFailed: '操作失败',
      },
    };

    const EN_NESTED = {
      meta: {
        title: 'Arknights · Stage Runner',
        description: 'Play Arknights through the local MAA core and MuMu emulator: fight exactly the stage you name (auto-deploy when available, otherwise a community copilot solution), push through main-story stages, and run Integrated Strategies, with a status panel and a stage ledger.',
      },
      panel: {
        title: 'Arknights',
        subtitle: 'Stage · Push · Roguelike',
        status: 'Status',
        emulator: 'Emulator',
        connection: 'Connection',
        task: 'Task',
        ledger: 'Stage ledger',
        events: 'Recent events',
        offline: 'Status unavailable (host not responding)',
        loading: 'Loading…',
      },
      labels: {
        stage: 'Stage',
        stagesHint: 'e.g. 5-10 or 5-10,6-5',
        times: 'Runs',
        from: 'From',
        chapter: 'Chapter',
        theme: 'Theme',
        mode: 'Mode',
        fullStar: 'Full star',
        missing: 'Not full star',
        prime: 'Prime claimed',
        running: 'Running',
        idle: 'Idle',
        connected: 'Connected',
        disconnected: 'Disconnected',
        emulatorRunning: 'Running',
        emulatorStopped: 'Stopped',
        adbOnline: 'adb online',
        adbOffline: 'adb offline',
      },
      actions: {
        preview: 'Preview',
        fight: 'Fight',
        push: 'Push',
        rogue: 'Roguelike',
        stop: 'Stop',
        refresh: 'Refresh',
        confirm: 'Run',
        cancel: 'Cancel',
      },
      hints: {
        confirmNeeded: 'Preview first; press Run to actually start',
        noStage: 'Enter a stage code first',
        stopped: 'Stop sent',
        actionFailed: 'Action failed',
      },
    };

    /** Flatten `{ a: { b: 'x' } }` into `{ 'a.b': 'x' }`. */
    function flattenDictionary(source, prefix, out) {
      const target = out || {};
      if (!source || typeof source !== 'object') return target;
      for (const key of Object.keys(source)) {
        const value = source[key];
        const path = prefix ? prefix + '.' + key : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          flattenDictionary(value, path, target);
        } else if (typeof value === 'string') {
          target[path] = value;
        }
      }
      return target;
    }

    const ZH = flattenDictionary(ZH_NESTED, '', {});
    const EN = flattenDictionary(EN_NESTED, '', {});

    /** Browser-derived fallback language; zh* -> zh, everything else -> en. */
    function detectLanguage() {
      try {
        let tag = '';
        if (typeof navigator !== 'undefined' && navigator) {
          tag = String(navigator.language || (navigator.languages && navigator.languages[0]) || '');
        }
        return tag.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      } catch (err) {
        return 'en';
      }
    }

    const FALLBACK_DICTIONARY = detectLanguage() === 'zh' ? ZH : EN;

    /** Translate without the locale service (only when `locale` is missing). */
    function fallbackTranslate(key, params) {
      let template = FALLBACK_DICTIONARY[key];
      if (typeof template !== 'string') return String(key);
      if (params && typeof params === 'object') {
        template = template.replace(/\{(\w+)\}/g, function (match, name) {
          return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
        });
      }
      return template;
    }

    /** Live translation state: replaced by the locale service bound `t` in apply. */
    const i18n = { t: fallbackTranslate, namespace: null };

    /* ------------------------------------------------------------------ *
     * Locale registration
     * ------------------------------------------------------------------ */

    /**
     * Register the `arknights` dictionaries with the client locale service and
     * bind a live translator. The documented form is `register(ns, { zh, en })`;
     * the shipped built-in locale ids are `zh`/`en` (the locale runtime maps
     * `zh` to `zh-CN` only for `<html lang>`). Falls back to the embedded
     * dictionary if the service is unavailable. Never throws.
     */
    function registerDictionaries(ctx) {
      let locale;
      try {
        locale = ctx.get('locale');
      } catch (err) {
        locale = undefined;
      }
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') return;

      // Dictionary lifetime rides the plugin fiber (HMR / unload safe).
      ctx.effect(function () {
        const disposers = [];
        const keep = function (disposer) {
          if (typeof disposer === 'function') disposers.push(disposer);
        };
        try {
          keep(locale.register(NS, { zh: ZH, en: EN }));
        } catch (err) {
          // Older/simpler shape: one locale at a time.
          try {
            keep(locale.register(NS, 'zh', ZH));
          } catch (zhErr) {
            /* another owner already registered it — binding below still works */
          }
          try {
            keep(locale.register(NS, 'en', EN));
          } catch (enErr) {
            /* same */
          }
        }
        return function () {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (err) {
              /* disposing a dictionary must never break unmount */
            }
          }
        };
      }, 'arknights: locale dictionaries');

      try {
        const bound = locale.bind(NS);
        if (typeof bound === 'function') {
          const probe = bound('panel.title');
          if (typeof probe === 'string' && probe !== 'panel.title' && probe !== '') {
            i18n.t = function (key, params) {
              return bound(key, params);
            };
            i18n.namespace = NS;
          }
        }
      } catch (err) {
        // Keep the embedded dictionary; never fail activation over i18n.
      }
    }

    /* ------------------------------------------------------------------ *
     * Small safe-access helpers (the status JSON may be partial while the
     * sidecar boots, so every field access is guarded).
     * ------------------------------------------------------------------ */

    function asRecord(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }

    function asCount(value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    }

    /* ------------------------------------------------------------------ *
     * Sidebar icon: inline SVG, sized by the owner's `size` prop (16 expanded /
     * 18 collapsed) and tinted with `currentColor`, so the row's theme color
     * (including its active state) is inherited. No hard-coded colors.
     * ------------------------------------------------------------------ */

    function ArknightsIcon(props) {
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 20;
      const active = !!(props && props.active);
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', color: 'inherit' },
        },
        h('path', {
          d: 'M12 2.4 20.2 6v5.3c0 4.7-3.3 8.6-8.2 10.3-4.9-1.7-8.2-5.6-8.2-10.3V6z',
          fill: active ? 'currentColor' : 'none',
          fillOpacity: active ? 0.18 : 0,
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.4 15.6V8.5l3.6 3.7 3.6-3.7v7.1',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Panel styles. Colors come only from --dsw-alias-* theme tokens; the
     * inline SVG above is the sole place allowed its own color expression
     * (and it uses `currentColor`). Rendered as a React <style> element, so it
     * disappears with the panel on unmount.
     * ------------------------------------------------------------------ */
    const PANEL_CSS = [
      '.ark-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;flex:1 1 auto;min-height:0;height:100%;overflow-y:auto;padding:16px 20px 24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:20px}',
      '.ark-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.ark-titles{min-width:0}',
      '.ark-title{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.ark-subtitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.ark-card-title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ark-status{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ark-dot{flex:none;width:8px;height:8px;border-radius:50%}',
      '.ark-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ark-offline{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.ark-stats{display:flex;flex-wrap:wrap;gap:18px}',
      '.ark-stat{display:inline-flex;align-items:baseline;gap:6px}',
      '.ark-stat-num{font-size:16px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.ark-stat-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}',
      '.ark-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.ark-field-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-input,.ark-select{box-sizing:border-box;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.ark-input{width:112px}',
      '.ark-input-num{width:64px}',
      '.ark-select{max-width:160px}',
      '.ark-input::placeholder{color:var(--dsw-alias-label-caption)}',
      '.ark-input:focus,.ark-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.ark-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;border:.5px solid transparent;border-radius:6px;font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-primary);background:0 0}',
      '.ark-btn:disabled{opacity:.5;cursor:default}',
      '.ark-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.ark-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.ark-btn-secondary{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.ark-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.ark-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.ark-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.ark-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}',
      '.ark-result{max-height:200px;overflow-y:auto;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}',
      '.ark-result-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.ark-events{display:flex;flex-direction:column;gap:4px;max-height:120px;margin:0;padding:0;overflow-y:auto;list-style:none}',
      '.ark-event{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:12px;line-height:18px}',
      '.ark-event-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.ark-event-task{flex:none;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.ark-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}',
      '.ark-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:auto;padding-top:4px}',
    ].join('\n');

    /* ------------------------------------------------------------------ *
     * Panel body: status polling, the ledger summary, the fight / push /
     * rogue / stop actions, the result area, recent events and refresh.
     * ------------------------------------------------------------------ */

    function ArknightsPanel(props) {
      const providedT = props && typeof props.t === 'function' ? props.t : null;
      const t = providedT || i18n.t;

      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [offline, setOffline] = React.useState(false);
      const [result, setResult] = React.useState(null); // { text, error }
      const [busy, setBusy] = React.useState(false);

      const [stage, setStage] = React.useState('');
      const [times, setTimes] = React.useState('1');
      const [fromStage, setFromStage] = React.useState('');
      const [chapter, setChapter] = React.useState('');
      const [rogueTheme, setRogueTheme] = React.useState('Sarkaz');
      const [rogueMode, setRogueMode] = React.useState('Exp');
      const [fightArmed, setFightArmed] = React.useState(false);
      const [pushArmed, setPushArmed] = React.useState(false);

      const mountedRef = React.useRef(true);
      const abortRef = React.useRef(null);
      const pollInFlightRef = React.useRef(false);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      const fetchStatus = React.useCallback(function () {
        if (pollInFlightRef.current) return;
        pollInFlightRef.current = true;

        let controller = null;
        let timer = null;
        let timedOut = false;
        try {
          controller = typeof AbortController === 'function' ? new AbortController() : null;
        } catch (err) {
          controller = null;
        }
        abortRef.current = controller;
        if (controller) {
          try {
            timer = setTimeout(function () {
              timedOut = true;
              try {
                controller.abort();
              } catch (err) {
                /* ignore */
              }
            }, REQUEST_TIMEOUT_MS);
          } catch (err) {
            timer = null;
          }
        }

        const finish = function () {
          pollInFlightRef.current = false;
          if (timer !== null) {
            try {
              clearTimeout(timer);
            } catch (err) {
              /* ignore */
            }
            timer = null;
          }
          if (abortRef.current === controller) abortRef.current = null;
        };

        let request;
        try {
          const init = { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' };
          if (controller) init.signal = controller.signal;
          request = fetch(STATUS_URL, init);
        } catch (err) {
          finish();
          if (mountedRef.current) {
            setOffline(true);
            setLoading(false);
          }
          return;
        }

        Promise.resolve(request)
          .then(function (response) {
            if (!response || !response.ok) throw new Error('status request failed');
            return response.json();
          })
          .then(function (data) {
            if (!mountedRef.current) return;
            setStatus(asRecord(data));
            setOffline(false);
            setLoading(false);
          })
          .catch(function (err) {
            if (!mountedRef.current) return;
            if (err && err.name === 'AbortError' && !timedOut) return; // superseded by unmount
            setOffline(true);
            setLoading(false);
          })
          .then(finish, finish);
      }, []);

      // Poll only while the panel is mounted; the first read happens at once.
      React.useEffect(
        function () {
          fetchStatus();
          const timer = setInterval(fetchStatus, POLL_INTERVAL_MS);
          return function () {
            clearInterval(timer);
            const active = abortRef.current;
            abortRef.current = null;
            pollInFlightRef.current = false;
            if (active) {
              try {
                active.abort();
              } catch (err) {
                /* ignore */
              }
            }
          };
        },
        [fetchStatus],
      );

      /* ---- action plumbing ---- */

      function reportUnexpected(err) {
        try {
          console.error('arknights: handler failed', err);
          setResult({ text: t('hints.actionFailed'), error: true });
        } catch (e) {
          /* never throw out of an event handler */
        }
      }

      /** Wrap an event handler so nothing can escape into React. */
      function safeHandler(handler) {
        return function (event) {
          try {
            const outcome = handler(event);
            if (outcome && typeof outcome.then === 'function') {
              outcome.then(undefined, reportUnexpected);
            }
          } catch (err) {
            reportUnexpected(err);
          }
        };
      }

      /**
       * POST an action and render its outcome. Always resolves (never rejects).
       * Returns the parsed response object or null.
       */
      function runAction(body, fallbackKey) {
        const payload = asRecord(body) || {};
        try {
          if (mountedRef.current) setBusy(true);
        } catch (err) {
          /* ignore */
        }

        let request;
        try {
          request = fetch(ACTION_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
          });
        } catch (err) {
          console.error('arknights: action request failed', err);
          try {
            if (mountedRef.current) {
              setBusy(false);
              setResult({ text: t('hints.actionFailed'), error: true });
            }
          } catch (e) {
            /* ignore */
          }
          return Promise.resolve(null);
        }

        return Promise.resolve(request)
          .then(function (response) {
            const parse =
              response && typeof response.json === 'function'
                ? Promise.resolve(response.json()).then(
                    function (data) {
                      return data;
                    },
                    function () {
                      return null;
                    },
                  )
                : Promise.resolve(null);
            return parse;
          })
          .then(function (data) {
            if (!mountedRef.current) return null;
            const record = asRecord(data);
            if (!record) {
              setResult({ text: t('hints.actionFailed'), error: true });
              return null;
            }
            if (record.ok === true) {
              const text =
                typeof record.text === 'string' && record.text ? record.text : t(fallbackKey || 'hints.actionFailed');
              setResult({ text: text, error: false });
              if (asRecord(record.status)) setStatus(record.status);
              // A started task changes the status soon; refresh without waiting.
              if (payload.action !== 'stop') {
                try {
                  fetchStatus();
                } catch (err) {
                  /* ignore */
                }
              }
              return record;
            }
            const message =
              (record.error && typeof record.error.message === 'string' && record.error.message) ||
              (typeof record.text === 'string' && record.text ? record.text : '') ||
              t('hints.actionFailed');
            setResult({ text: message, error: true });
            if (asRecord(record.status)) setStatus(record.status);
            return record;
          })
          .catch(function (err) {
            console.error('arknights: action failed', err);
            try {
              if (mountedRef.current) setResult({ text: t('hints.actionFailed'), error: true });
            } catch (e) {
              /* ignore */
            }
            return null;
          })
          .then(function (value) {
            try {
              if (mountedRef.current) setBusy(false);
            } catch (err) {
              /* ignore */
            }
            return value;
          });
      }

      function fightBody(confirm) {
        const stages = String(stage || '').trim();
        if (!stages) return null;
        const parsed = parseInt(String(times || '').trim(), 10);
        return {
          action: 'fight',
          stages: stages,
          times: isFinite(parsed) && parsed > 0 ? parsed : 1,
          confirm: !!confirm,
        };
      }

      function pushBody(confirm) {
        const from = String(fromStage || '').trim();
        const parsedChapter = parseInt(String(chapter || '').trim(), 10);
        return {
          action: 'push',
          from: from || null,
          chapter: isFinite(parsedChapter) && parsedChapter > 0 ? parsedChapter : null,
          confirm: !!confirm,
        };
      }

      function onPreview() {
        const body = fightBody(false);
        if (!body) {
          setResult({ text: t('hints.noStage'), error: true });
          return;
        }
        setFightArmed(true);
        runAction(body, 'hints.actionFailed');
      }

      function onFight() {
        const confirming = fightArmed;
        const body = fightBody(confirming);
        if (!body) {
          setResult({ text: t('hints.noStage'), error: true });
          return;
        }
        setFightArmed(!confirming);
        const pending = runAction(body, 'hints.actionFailed');
        pending.then(function (response) {
          if (!mountedRef.current) return;
          if (!response || response.ok !== true) setFightArmed(false);
        }, function () {
          if (mountedRef.current) setFightArmed(false);
        });
      }

      function onPush() {
        const confirming = pushArmed;
        const body = pushBody(confirming);
        setPushArmed(!confirming);
        const pending = runAction(body, 'hints.actionFailed');
        pending.then(function (response) {
          if (!mountedRef.current) return;
          if (!response || response.ok !== true) setPushArmed(false);
        }, function () {
          if (mountedRef.current) setPushArmed(false);
        });
      }

      function onRogue() {
        runAction({ action: 'rogue', theme: rogueTheme, mode: rogueMode }, 'hints.actionFailed');
      }

      function onStop() {
        runAction({ action: 'stop' }, 'hints.stopped');
      }

      function onRefresh() {
        fetchStatus();
      }

      function onStageChange(event) {
        const target = event && event.target ? event.target : null;
        setStage(target ? String(target.value) : '');
        setFightArmed(false); // the plan belongs to the previous stage code
      }

      function onTimesChange(event) {
        const target = event && event.target ? event.target : null;
        setTimes(target ? String(target.value) : '');
        setFightArmed(false);
      }

      function onFromChange(event) {
        const target = event && event.target ? event.target : null;
        setFromStage(target ? String(target.value) : '');
        setPushArmed(false);
      }

      function onChapterChange(event) {
        const target = event && event.target ? event.target : null;
        setChapter(target ? String(target.value) : '');
        setPushArmed(false);
      }

      function onThemeChange(event) {
        const target = event && event.target ? event.target : null;
        const value = target ? String(target.value) : '';
        setRogueTheme(ROGUE_THEMES.indexOf(value) >= 0 ? value : ROGUE_THEMES[3]);
      }

      function onModeChange(event) {
        const target = event && event.target ? event.target : null;
        const value = target ? String(target.value) : '';
        setRogueMode(ROGUE_MODES.indexOf(value) >= 0 ? value : ROGUE_MODES[0]);
      }

      /* ---- derived view state (all optional-chained) ---- */

      const sidecar = asRecord(status && status.sidecar);
      const emulator = asRecord(status && status.emulator);
      const connection = asRecord(status && status.connection);
      const tasks = asRecord(status && status.tasks);
      const ledger = asRecord(status && status.ledger);
      const connected = connection && connection.connected === true;
      const emulatorRunning = emulator && emulator.running === true;
      const taskRunning = tasks && tasks.running === true;
      const coreVersion =
        sidecar && typeof sidecar.coreVersion === 'string' && sidecar.coreVersion ? sidecar.coreVersion : '—';
      const currentTask = tasks && typeof tasks.current === 'string' ? tasks.current : '';

      let dotColor = 'var(--dsw-alias-state-idle-primary)';
      let summary = t('panel.loading');
      if (!loading) {
        if (offline || !status) {
          dotColor = 'var(--dsw-alias-state-error-primary)';
          summary = t('panel.offline');
        } else {
          dotColor = connected
            ? 'var(--dsw-alias-state-success-primary)'
            : sidecar && sidecar.alive
              ? 'var(--dsw-alias-state-warn-primary)'
              : 'var(--dsw-alias-state-error-primary)';
          const parts = [
            'MAA ' + coreVersion,
            t('panel.emulator') + ' ' + (emulatorRunning ? t('labels.emulatorRunning') : t('labels.emulatorStopped')),
            t('panel.connection') + ' ' + (connected ? t('labels.connected') : t('labels.disconnected')),
            t('panel.task') + ' ' + (taskRunning ? t('labels.running') : t('labels.idle')),
          ];
          if (currentTask) parts.push(currentTask);
          summary = parts.join(' · ');
        }
      }

      const fullStar = asCount(ledger && ledger.fullStar);
      const missing = asCount(ledger && ledger.missing);
      const prime = asCount(ledger && ledger.primeClaimed);

      const rawEvents = status && Array.isArray(status.events) ? status.events : [];
      const recentEvents = rawEvents
        .filter(function (item) {
          return asRecord(item) !== null;
        })
        .slice(-EVENT_LIMIT)
        .reverse(); // newest first

      /* ---- render ---- */

      return h(
        'div',
        { className: 'ark-panel' },
        h('style', { key: 'arknights-style' }, PANEL_CSS),

        h(
          'header',
          { className: 'ark-head' },
          h(
            'div',
            { className: 'ark-titles' },
            h('div', { className: 'ark-title' }, t('panel.title')),
            h('div', { className: 'ark-subtitle' }, t('panel.subtitle')),
          ),
        ),

        // 1. Status: dot + one-line summary (MAA version / emulator / connection / task).
        h(
          'section',
          { className: 'ark-card' },
          h('div', { className: 'ark-card-title' }, t('panel.status')),
          h(
            'div',
            { className: 'ark-status' },
            h('span', {
              className: 'ark-dot',
              'aria-hidden': 'true',
              style: { background: dotColor },
            }),
            h('span', { className: 'ark-summary', title: summary }, summary),
          ),
          offline ? h('div', { className: 'ark-offline' }, t('panel.offline')) : null,
        ),

        // 2. Stage ledger summary.
        h(
          'section',
          { className: 'ark-card' },
          h('div', { className: 'ark-card-title' }, t('panel.ledger')),
          h(
            'div',
            { className: 'ark-stats' },
            h(
              'span',
              { className: 'ark-stat' },
              h('span', { className: 'ark-stat-num' }, String(fullStar)),
              h('span', { className: 'ark-stat-label' }, t('labels.fullStar')),
            ),
            h(
              'span',
              { className: 'ark-stat' },
              h('span', { className: 'ark-stat-num' }, String(missing)),
              h('span', { className: 'ark-stat-label' }, t('labels.missing')),
            ),
            h(
              'span',
              { className: 'ark-stat' },
              h('span', { className: 'ark-stat-num' }, String(prime)),
              h('span', { className: 'ark-stat-label' }, t('labels.prime')),
            ),
          ),
        ),

        // 3. Fight a requested stage (preview -> confirm).
        h(
          'section',
          { className: 'ark-card' },
          h(
            'div',
            { className: 'ark-row' },
            h(
              'label',
              { className: 'ark-field' },
              h('span', { className: 'ark-field-label' }, t('labels.stage')),
              h('input', {
                className: 'ark-input',
                type: 'text',
                value: stage,
                placeholder: t('labels.stagesHint'),
                'aria-label': t('labels.stage'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: safeHandler(onStageChange),
              }),
            ),
            h(
              'label',
              { className: 'ark-field' },
              h('span', { className: 'ark-field-label' }, t('labels.times')),
              h('input', {
                className: 'ark-input ark-input-num',
                type: 'number',
                min: 1,
                step: 1,
                value: times,
                'aria-label': t('labels.times'),
                onChange: safeHandler(onTimesChange),
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ark-btn ark-btn-secondary',
                disabled: busy,
                onClick: safeHandler(onPreview),
              },
              t('actions.preview'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ark-btn ark-btn-primary',
                disabled: busy,
                onClick: safeHandler(onFight),
              },
              fightArmed ? t('actions.confirm') : t('actions.fight'),
            ),
          ),
          fightArmed ? h('div', { className: 'ark-hint' }, t('hints.confirmNeeded')) : null,
        ),

        // 4. Push stages.
        h(
          'section',
          { className: 'ark-card' },
          h(
            'div',
            { className: 'ark-row' },
            h(
              'label',
              { className: 'ark-field' },
              h('span', { className: 'ark-field-label' }, t('labels.from')),
              h('input', {
                className: 'ark-input',
                type: 'text',
                value: fromStage,
                'aria-label': t('labels.from'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: safeHandler(onFromChange),
              }),
            ),
            h(
              'label',
              { className: 'ark-field' },
              h('span', { className: 'ark-field-label' }, t('labels.chapter')),
              h('input', {
                className: 'ark-input ark-input-num',
                type: 'number',
                min: 1,
                step: 1,
                value: chapter,
                'aria-label': t('labels.chapter'),
                onChange: safeHandler(onChapterChange),
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ark-btn ark-btn-primary',
                disabled: busy,
                onClick: safeHandler(onPush),
              },
              pushArmed ? t('actions.confirm') : t('actions.push'),
            ),
          ),
        ),

        // 5. Integrated Strategies.
        h(
          'section',
          { className: 'ark-card' },
          h(
            'div',
            { className: 'ark-row' },
            h(
              'label',
              { className: 'ark-field' },
              h('span', { className: 'ark-field-label' }, t('labels.theme')),
              h(
                'select',
                {
                  className: 'ark-select',
                  value: rogueTheme,
                  'aria-label': t('labels.theme'),
                  onChange: safeHandler(onThemeChange),
                },
                ROGUE_THEMES.map(function (theme) {
                  return h('option', { key: theme, value: theme }, theme);
                }),
              ),
            ),
            h(
              'label',
              { className: 'ark-field' },
              h('span', { className: 'ark-field-label' }, t('labels.mode')),
              h(
                'select',
                {
                  className: 'ark-select',
                  value: rogueMode,
                  'aria-label': t('labels.mode'),
                  onChange: safeHandler(onModeChange),
                },
                ROGUE_MODES.map(function (mode) {
                  return h('option', { key: mode, value: mode }, mode);
                }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ark-btn ark-btn-primary',
                disabled: busy,
                onClick: safeHandler(onRogue),
              },
              t('actions.rogue'),
            ),
          ),
        ),

        // 6. Stop.
        h(
          'div',
          { className: 'ark-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'ark-btn ark-btn-danger',
              disabled: busy,
              onClick: safeHandler(onStop),
            },
            t('actions.stop'),
          ),
        ),

        // Result area for the latest action / plan text.
        result
          ? h(
              'div',
              {
                className: 'ark-result' + (result.error ? ' ark-result-error' : ''),
                role: 'status',
              },
              result.text,
            )
          : null,

        // 7. Recent events (newest first, at most five).
        h(
          'section',
          { className: 'ark-card' },
          h('div', { className: 'ark-card-title' }, t('panel.events')),
          recentEvents.length === 0
            ? h('div', { className: 'ark-empty' }, '—')
            : h(
                'ul',
                { className: 'ark-events' },
                recentEvents.map(function (event, index) {
                  const name =
                    (typeof event.name === 'string' && event.name) ||
                    (typeof event.code === 'number' ? '—' : '—');
                  const task = typeof event.task === 'string' && event.task ? event.task : '';
                  const key = typeof event.seq === 'number' ? 'seq-' + event.seq : 'ev-' + index;
                  return h(
                    'li',
                    { className: 'ark-event', key: key },
                    h('span', { className: 'ark-event-name', title: name }, name),
                    task ? h('span', { className: 'ark-event-task' }, task) : null,
                  );
                }),
              ),
        ),

        // 8. Refresh.
        h(
          'footer',
          { className: 'ark-footer' },
          h('span', { className: 'ark-empty' }),
          h(
            'button',
            {
              type: 'button',
              className: 'ark-btn ark-btn-secondary',
              disabled: busy,
              onClick: safeHandler(onRefresh),
            },
            t('actions.refresh'),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Client plugin body
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        registerDictionaries(ctx);

        // `locale` on a registration injects a live `t` prop and re-renders the
        // entry on a language switch; omit it when the service is unavailable.
        const localeOption = i18n.namespace ? { locale: i18n.namespace } : {};

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            Object.assign(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 5,
                label: function () {
                  return i18n.t('panel.title');
                },
              },
              localeOption,
            ),
            ArknightsIcon,
          );
        });

        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            Object.assign({ name: 'main', key: PANEL_ID }, localeOption),
            ArknightsPanel,
          );
        });
      },
    };
  },
});
