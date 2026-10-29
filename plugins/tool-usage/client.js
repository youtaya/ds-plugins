window.__ModuleLoader__.load({
  id: 'dsh-plugin-tool-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * Right-Sidebar opener shared by every entry that can reveal the stream.
     * It stays a no-op until the optional sidebar injection runs, so a profile
     * without the right Sidebar keeps every non-sidebar entry working.
     */
    let openStream = function () {};

    /** Locale namespace owned by this plugin. */
    const NS = 'tool-usage-ui';

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const ZH = {
      'view.label': '调用看板',
      'view.title': '调用看板',
      'view.subtitle': '按工具与轮次汇总本次会话的工具调用。',
      'view.generated': '更新于 {time}',
      'view.empty': '还没有工具调用数据。',
      'view.metric.calls': '调用次数',
      'view.metric.errors': '失败次数',
      'view.metric.failureRate': '失败率 {rate}%',
      'view.metric.total': '总耗时',
      'view.metric.avg': '平均耗时',
      'view.metric.max': '最慢耗时',
      'view.metric.tools': '工具种类',
      'view.metric.shell': 'Shell 命令数',
      'view.metric.turns': '轮次数',
      'view.byTool.title': '按工具统计',
      'view.byTool.tool': '工具',
      'view.byTool.calls': '次数',
      'view.byTool.errors': '失败',
      'view.byTool.avg': '平均',
      'view.byTool.max': '最慢',
      'view.byTool.share': '占比',
      'view.turns.title': '轮次时间线',
      'view.turn.turn': '轮次',
      'view.turn.status': '状态',
      'view.turn.calls': '调用',
      'view.turn.errors': '失败',
      'view.turn.time': '耗时',
      'view.turn.started': '时间',
      'view.calls.title': '最近调用',
      'view.calls.count': '显示 {shown} / {total} 次调用',
      'view.calls.empty': '没有符合条件的调用。',
      'view.filter.all': '全部',
      'view.filter.errors': '失败',
      'view.filter.shell': 'Shell',
      'summary.title': '工具调用看板 · 第 {turn} 轮',
      'summary.metric.calls': '调用次数',
      'summary.metric.errors': '失败次数',
      'summary.metric.total': '总耗时',
      'summary.metric.avg': '平均耗时',
      'summary.metric.tools': '工具种类',
      'summary.tool.failures': '{count} 失败',
      'summary.shell': 'Shell 命令 {count} 条',
      'summary.details.show': '查看 {count} 次调用明细',
      'summary.details.hide': '收起调用明细',
      'summary.details.omitted': '更早的调用已省略',
      'summary.footer': '在会话顶部「调用看板」查看整个会话的统计。',
      'outcome.open': '进行中',
      'outcome.completed': '已完成',
      'outcome.aborted': '已中断',
      'outcome.error': '失败',
      'outcome.max-tokens': '达到上限',
      'outcome.interrupted': '被打断',
      'outcome.blocked': '被阻止',
      'outcome.forked': '分叉',
      'status.ok': '成功',
      'status.error': '失败',
      'status.aborted': '中断',
      'status.running': '运行中',
      'turn.label': '第 {turn} 轮',
      'stream.tabTitle': '调用流',
      'stream.guideTitle': '调用流',
      'stream.guideDescription': '实时查看本次会话的 Shell 命令与工具调用。',
      'stream.headerButton': '调用流',
      'stream.headerButtonTitle': '打开调用流侧栏',
      'stream.title': '调用流',
      'stream.live': '实时',
      'stream.count': '共 {count} 次调用',
      'stream.latest': '最新 {limit} 条',
      'stream.empty': '等待工具调用…',
      'stream.fallback.bash': '执行 Shell 命令：{command}',
      'stream.fallback.read': '读取文件 {path}',
      'stream.fallback.write': '写入文件 {path}',
      'stream.fallback.edit': '编辑文件 {path}',
      'stream.fallback.glob': '查找文件 {pattern}',
      'stream.fallback.grep': '搜索内容 {pattern}',
      'stream.fallback.other': '调用工具 {tool}',
    };

    /** English dictionary; every key mirrors {@link ZH}. */
    const EN = {
      'view.label': 'Calls',
      'view.title': 'Call dashboard',
      'view.subtitle': 'Tool calls in this session, summarized by tool and turn.',
      'view.generated': 'Updated {time}',
      'view.empty': 'No tool-call data yet.',
      'view.metric.calls': 'Calls',
      'view.metric.errors': 'Failures',
      'view.metric.failureRate': 'Failure rate {rate}%',
      'view.metric.total': 'Total time',
      'view.metric.avg': 'Avg time',
      'view.metric.max': 'Slowest',
      'view.metric.tools': 'Tools',
      'view.metric.shell': 'Shell commands',
      'view.metric.turns': 'Turns',
      'view.byTool.title': 'By tool',
      'view.byTool.tool': 'Tool',
      'view.byTool.calls': 'Calls',
      'view.byTool.errors': 'Failed',
      'view.byTool.avg': 'Avg',
      'view.byTool.max': 'Max',
      'view.byTool.share': 'Share',
      'view.turns.title': 'Turn timeline',
      'view.turn.turn': 'Turn',
      'view.turn.status': 'Status',
      'view.turn.calls': 'Calls',
      'view.turn.errors': 'Failed',
      'view.turn.time': 'Duration',
      'view.turn.started': 'Time',
      'view.calls.title': 'Recent calls',
      'view.calls.count': 'Showing {shown} of {total} calls',
      'view.calls.empty': 'No matching calls.',
      'view.filter.all': 'All',
      'view.filter.errors': 'Failed',
      'view.filter.shell': 'Shell',
      'summary.title': 'Tool-call dashboard · Turn {turn}',
      'summary.metric.calls': 'Calls',
      'summary.metric.errors': 'Failures',
      'summary.metric.total': 'Total time',
      'summary.metric.avg': 'Avg time',
      'summary.metric.tools': 'Tools',
      'summary.tool.failures': '{count} failed',
      'summary.shell': '{count} shell commands',
      'summary.details.show': 'Show {count} call details',
      'summary.details.hide': 'Hide call details',
      'summary.details.omitted': 'Earlier calls omitted',
      'summary.footer': 'Open the Calls tab at the top of the session for whole-session stats.',
      'outcome.open': 'Running',
      'outcome.completed': 'Completed',
      'outcome.aborted': 'Aborted',
      'outcome.error': 'Failed',
      'outcome.max-tokens': 'Max tokens',
      'outcome.interrupted': 'Interrupted',
      'outcome.blocked': 'Blocked',
      'outcome.forked': 'Forked',
      'status.ok': 'OK',
      'status.error': 'Failed',
      'status.aborted': 'Aborted',
      'status.running': 'Running',
      'turn.label': 'Turn {turn}',
      'stream.tabTitle': 'Calls stream',
      'stream.guideTitle': 'Calls stream',
      'stream.guideDescription': "Watch this session's shell commands and tool calls live.",
      'stream.headerButton': 'Calls',
      'stream.headerButtonTitle': 'Open the Calls stream sidebar',
      'stream.title': 'Calls stream',
      'stream.live': 'Live',
      'stream.count': '{count} calls',
      'stream.latest': 'Latest {limit}',
      'stream.empty': 'Waiting for tool calls…',
      'stream.fallback.bash': 'Run shell command: {command}',
      'stream.fallback.read': 'Read file {path}',
      'stream.fallback.write': 'Write file {path}',
      'stream.fallback.edit': 'Edit file {path}',
      'stream.fallback.glob': 'Find files {pattern}',
      'stream.fallback.grep': 'Search content {pattern}',
      'stream.fallback.other': 'Call tool {tool}',
    };

    // ------------------------------------------------------------------
    // Helpers: formatting, call filtering, and projection derivation.
    // ------------------------------------------------------------------

    /** Selector identity: the components always render the whole wire view. */
    function identity(value) {
      return value;
    }

    /** Coerce an untrusted list field to an array. */
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    /** Coerce an untrusted numeric field to a finite number. */
    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    /** Format a duration: `123ms` under one second, otherwise `1.2s`. */
    function fmtMs(ms) {
      const value = Math.max(0, num(ms));
      if (value < 1000) return Math.round(value) + 'ms';
      return (value / 1000).toFixed(1) + 's';
    }

    /** Format an epoch-ms instant as local `HH:MM:SS`. */
    function fmtTime(epochMs) {
      if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return '--:--:--';
      const date = new Date(epochMs);
      return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map(function (part) { return part < 10 ? '0' + part : String(part); })
        .join(':');
    }

    /** Format a percentage with at most one decimal. */
    function fmtRate(rate) {
      return String(Math.round(rate * 10) / 10);
    }

    /** Re-read one of the allowed `--dsw-alias-*` tokens as a CSS color value. */
    function tokenVar(token) {
      return 'var(' + token + ')';
    }

    /** Status presentation for settled call rows (localized key + token). */
    const STATUS_META = {
      ok: { key: 'status.ok', token: '--dsw-alias-state-success-primary' },
      error: { key: 'status.error', token: '--dsw-alias-state-error-primary' },
      aborted: { key: 'status.aborted', token: '--dsw-alias-state-warn-primary' },
      running: { key: 'status.running', token: '--dsw-alias-brand-primary' },
    };

    /** Outcome presentation for turn pills (localized key + token). */
    const OUTCOME_META = {
      open: { key: 'outcome.open', token: '--dsw-alias-brand-primary' },
      completed: { key: 'outcome.completed', token: '--dsw-alias-state-success-primary' },
      aborted: { key: 'outcome.aborted', token: '--dsw-alias-state-warn-primary' },
      error: { key: 'outcome.error', token: '--dsw-alias-state-error-primary' },
      'max-tokens': { key: 'outcome.max-tokens', token: '--dsw-alias-state-warn-primary' },
      interrupted: { key: 'outcome.interrupted', token: '--dsw-alias-state-warn-primary' },
      blocked: { key: 'outcome.blocked', token: '--dsw-alias-state-idle-primary' },
      forked: { key: 'outcome.forked', token: '--dsw-alias-state-idle-primary' },
    };

    /** Resolve a settled call status to its presentation. */
    function statusMeta(status) {
      return STATUS_META[status] || { key: 'status.ok', token: '--dsw-alias-label-secondary' };
    }

    /** Resolve a turn outcome to its presentation. */
    function outcomeMeta(outcome) {
      return OUTCOME_META[outcome] || { key: 'outcome.open', token: '--dsw-alias-label-secondary' };
    }

    /** Filter a call list to one settled status (`all` passes everything valid). */
    function filterCalls(calls, filter) {
      const list = asArray(calls).filter(function (call) {
        return call !== null && typeof call === 'object';
      });
      if (filter === 'errors') {
        return list.filter(function (call) { return call.status === 'error'; });
      }
      if (filter === 'shell') {
        return list.filter(function (call) {
          return call.command !== null && call.command !== undefined;
        });
      }
      return list;
    }

    /** Group one turn's settled calls by tool name, sorted by calls desc then name. */
    function groupTools(calls) {
      const groups = new Map();
      asArray(calls).forEach(function (call) {
        if (call === null || typeof call !== 'object') return;
        const tool = typeof call.tool === 'string' && call.tool ? call.tool : '?';
        let group = groups.get(tool);
        if (group === undefined) {
          group = { tool: tool, calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
          groups.set(tool, group);
        }
        group.calls += 1;
        if (call.status === 'error') group.errors += 1;
        const duration = num(call.durationMs);
        group.totalMs += duration;
        if (duration > group.maxMs) group.maxMs = duration;
      });
      return Array.from(groups.values()).sort(function (left, right) {
        if (right.calls !== left.calls) return right.calls - left.calls;
        return left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0;
      });
    }

    /** Derive a single turn's aggregates from the session-wide call list. */
    function deriveTurn(view, turnNo) {
      const calls = turnNo === undefined
        ? []
        : asArray(view && view.calls).filter(function (call) {
          return call !== null && typeof call === 'object' && call.turn === turnNo;
        }).slice(0, 60);
      const tools = groupTools(calls);
      const names = new Set();
      let shellCount = 0;
      let totalMs = 0;
      calls.forEach(function (call) {
        if (typeof call.tool === 'string' && call.tool) names.add(call.tool);
        if (call.command !== null && call.command !== undefined) shellCount += 1;
        totalMs += num(call.durationMs);
      });
      return {
        calls: calls,
        tools: tools,
        toolCount: names.size,
        shellCount: shellCount,
        avgMs: calls.length > 0 ? totalMs / calls.length : 0,
        maxCalls: tools.length > 0 ? tools[0].calls : 1,
      };
    }

    /** Derive the session dashboard model without mutating the projection. */
    function deriveSession(view) {
      const totals = view !== null && view !== undefined && typeof view.totals === 'object' && view.totals !== null
        ? view.totals
        : {};
      const byTool = asArray(view && view.byTool);
      const turns = asArray(view && view.turns).slice().sort(function (left, right) {
        return num(right.turn) - num(left.turn);
      });
      const recent = asArray(view && view.calls).slice().sort(function (left, right) {
        return num(right.endTime) - num(left.endTime);
      }).slice(0, 60);
      let shellCalls = 0;
      recent.forEach(function (call) {
        if (call !== null && typeof call === 'object' && call.command !== null && call.command !== undefined) {
          shellCalls += 1;
        }
      });
      let maxToolCalls = 1;
      byTool.forEach(function (entry) {
        maxToolCalls = Math.max(maxToolCalls, num(entry && entry.calls));
      });
      const calls = num(totals.calls);
      const errors = num(totals.errors);
      let distinctToolCount = 0;
      byTool.forEach(function (entry) {
        if (entry !== null && typeof entry === 'object') distinctToolCount += 1;
      });
      return {
        totals: totals,
        byTool: byTool,
        turns: turns,
        recent: recent,
        shellCalls: shellCalls,
        maxToolCalls: maxToolCalls,
        failureRate: calls > 0 ? (errors / calls) * 100 : 0,
        knownToolCount: distinctToolCount,
      };
    }

    // ------------------------------------------------------------------
    // Stream helpers: one fixed-length, newest-first list with a fallback to
    // the Chat legacy slice when the Host has not registered the projection.
    // ------------------------------------------------------------------

    /** Right-Sidebar tab kind and implementation identity. */
    const STREAM_KIND = 'tool-usage-stream';
    const STREAM_TAB_ID = 'dsh-plugin-tool-usage-stream';
    /** The user asked for a fixed-length live list, not an unbounded log. */
    const STREAM_LIMIT = 50;

    /** Read one string argument from a PartialArguments-style view, guarded. */
    function legacyArgsText(args, key) {
      try {
        if (args === null || args === undefined || typeof args.text !== 'function') return undefined;
        // A still-streaming field may hold a prefix; only complete fields are shown.
        if (typeof args.complete === 'function' && args.complete(key) !== true) return undefined;
        const text = args.text(key);
        return typeof text === 'string' && text.length > 0 ? text : undefined;
      } catch (error) {
        return undefined;
      }
    }

    /** First present string argument among candidate key names. */
    function legacyArgsField(args, keys) {
      for (let index = 0; index < keys.length; index += 1) {
        const value = legacyArgsText(args, keys[index]);
        if (value !== undefined) return value;
      }
      return undefined;
    }

    /** One-line explanation for a legacy call when the Host projection is absent. */
    function fallbackSummary(t, tool, args, command) {
      const name = typeof tool === 'string' && tool ? tool : '?';
      const lower = name.toLowerCase();
      if (typeof command === 'string' && command.length > 0) {
        return t('stream.fallback.bash', { command: command });
      }
      if (lower.indexOf('read') === 0 || lower === 'cat') {
        return t('stream.fallback.read', {
          path: legacyArgsField(args, ['path', 'file_path', 'file']) || name,
        });
      }
      if (lower.indexOf('write') === 0) {
        return t('stream.fallback.write', {
          path: legacyArgsField(args, ['path', 'file_path', 'file']) || name,
        });
      }
      if (lower.indexOf('edit') === 0 || lower.indexOf('patch') === 0) {
        return t('stream.fallback.edit', {
          path: legacyArgsField(args, ['path', 'file_path', 'file']) || name,
        });
      }
      if (lower.indexOf('glob') === 0) {
        return t('stream.fallback.glob', {
          pattern: legacyArgsField(args, ['pattern', 'query']) || name,
        });
      }
      if (lower.indexOf('grep') === 0 || lower.indexOf('search') === 0) {
        return t('stream.fallback.grep', {
          pattern: legacyArgsField(args, ['pattern', 'query']) || name,
        });
      }
      return t('stream.fallback.other', { tool: name });
    }

    /** Trim a newest-first row list to the fixed stream length. */
    function finishStream(rows, total, turn, runningCount) {
      return {
        rows: rows.slice(0, STREAM_LIMIT),
        total: total,
        turn: turn,
        runningCount: runningCount,
        trimmed: rows.length > STREAM_LIMIT,
      };
    }

    /** Stream rows from the Host projection: running calls first, then settles. */
    function projectionStream(view) {
      const runningCalls = asArray(view && view.running);
      const settledCalls = asArray(view && view.calls);
      const runningRows = [];
      runningCalls.forEach(function (call, index) {
        if (call === null || typeof call !== 'object') return;
        const tool = typeof call.tool === 'string' && call.tool ? call.tool : '?';
        runningRows.push({
          key: call.callId || 'stream-running-' + index,
          tool: tool,
          summary: typeof call.summary === 'string' && call.summary ? call.summary : tool,
          command: typeof call.command === 'string' && call.command ? call.command : undefined,
          turn: typeof call.turn === 'number' ? call.turn : undefined,
          running: true,
          time: num(call.startTime),
          startTime: num(call.startTime),
          durationMs: 0,
          status: 'running',
        });
      });
      runningRows.sort(function (left, right) { return right.startTime - left.startTime; });
      const settledRows = [];
      settledCalls.forEach(function (call, index) {
        if (call === null || typeof call !== 'object') return;
        const tool = typeof call.tool === 'string' && call.tool ? call.tool : '?';
        settledRows.push({
          key: call.callId || 'stream-settled-' + index,
          tool: tool,
          summary: typeof call.summary === 'string' && call.summary ? call.summary : tool,
          command: typeof call.command === 'string' && call.command ? call.command : undefined,
          turn: typeof call.turn === 'number' ? call.turn : undefined,
          running: false,
          time: num(call.endTime),
          startTime: num(call.startTime),
          durationMs: num(call.durationMs),
          status: call.status === 'error' ? 'error' : call.status === 'aborted' ? 'aborted' : 'ok',
        });
      });
      settledRows.sort(function (left, right) { return right.time - left.time; });
      const turns = asArray(view && view.turns);
      let currentTurn;
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (turn !== null && typeof turn === 'object' && turn.endTime === null) {
          currentTurn = turn.turn;
          break;
        }
      }
      const rows = runningRows.concat(settledRows);
      if (currentTurn === undefined) {
        // No open turn: the newest known call still names the turn on screen.
        for (let index = 0; index < rows.length; index += 1) {
          if (typeof rows[index].turn === 'number') {
            currentTurn = rows[index].turn;
            break;
          }
        }
      }
      const total = num(view && view.totals && view.totals.calls) || rows.length;
      return finishStream(rows, total, currentTurn, runningRows.length);
    }

    /** Stream rows from the Chat legacy slice when no projection is registered. */
    function legacyStream(chat, t) {
      const legacy = chat !== null && chat !== undefined && typeof chat === 'object' ? chat.legacy : undefined;
      const runningCalls = asArray(legacy && legacy.runningCalls);
      const nodes = asArray(legacy && legacy.nodes);
      const runningRows = [];
      runningCalls.forEach(function (call, index) {
        if (call === null || typeof call !== 'object') return;
        const tool = typeof call.name === 'string' && call.name ? call.name : '?';
        const command = legacyArgsField(call.args, ['command', 'cmd']);
        runningRows.push({
          key: call.callId || 'stream-running-' + index,
          tool: tool,
          summary: fallbackSummary(t, tool, call.args, command),
          command: command,
          turn: typeof call.turn === 'number' ? call.turn : undefined,
          running: true,
          time: num(call.time),
          startTime: num(call.time),
          durationMs: 0,
          status: 'running',
        });
      });
      runningRows.sort(function (left, right) { return right.startTime - left.startTime; });
      const settledRows = [];
      nodes.forEach(function (node, index) {
        if (node === null || typeof node !== 'object' || node.kind !== 'tool-result') return;
        const tool = typeof node.name === 'string' && node.name ? node.name : '?';
        const command = legacyArgsField(node.args, ['command', 'cmd']);
        const callTime = typeof node.callTime === 'number' ? node.callTime : num(node.time);
        settledRows.push({
          key: node.callId || 'stream-settled-' + index,
          tool: tool,
          summary: fallbackSummary(t, tool, node.args, command),
          command: command,
          turn: undefined,
          running: false,
          time: num(node.time),
          startTime: callTime,
          durationMs: Math.max(0, num(node.time) - callTime),
          status: node.isError === true ? 'error' : 'ok',
        });
      });
      settledRows.sort(function (left, right) { return right.time - left.time; });
      const rows = runningRows.concat(settledRows);
      return finishStream(rows, rows.length, runningRows.length > 0 ? runningRows[0].turn : undefined,
        runningRows.length);
    }

    /** Derive the stream model: projection first, Chat legacy slice as fallback. */
    function deriveStream(view, chat, t) {
      if (view !== null && view !== undefined
        && (asArray(view.calls).length > 0 || asArray(view.running).length > 0)) {
        return projectionStream(view);
      }
      return legacyStream(chat, t);
    }

    // ------------------------------------------------------------------
    // Token-only stylesheet, owned by one effect and never written again.
    // ------------------------------------------------------------------

    const CSS = [
      '.tu-card,.tu-view{box-sizing:border-box;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);}',
      '.tu-dot{flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);}',
      '.tu-dot--pulse{animation:tu-pulse 1.4s ease-in-out infinite;}',
      '@keyframes tu-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}',
      '@media (prefers-reduced-motion:reduce){.tu-dot--pulse{animation:none;}}',
      '.tu-row{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;}',
      '.tu-badge{flex:none;max-width:45%;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tu-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tu-cmd{flex:1 1 100%;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tu-dur{flex:none;margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.tu-shell-hint,.tu-omitted{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.tu-card{width:100%;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;}',
      '.tu-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.tu-card-title{font-weight:600;font-size:13px;}',
      '.tu-card-duration{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.tu-pill{padding:0 8px;border-radius:999px;border:1px solid currentColor;font-size:11px;line-height:18px;white-space:nowrap;}',
      '.tu-chips{display:flex;flex-wrap:wrap;gap:6px;}',
      '.tu-chip{display:flex;flex-direction:column;gap:1px;min-width:64px;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);}',
      '.tu-chip-label{font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.tu-chip-value{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;}',
      '.tu-bars{display:flex;flex-direction:column;gap:4px;}',
      '.tu-bar-row{display:grid;grid-template-columns:minmax(56px,120px) 1fr auto;align-items:center;gap:8px;}',
      '.tu-bar-label{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tu-bar-track{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
      '.tu-bar-fill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);}',
      '.tu-bar-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.tu-bar-errors{margin-left:4px;font-size:11px;}',
      '.tu-toggle{align-self:flex-start;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;cursor:pointer;}',
      '.tu-toggle:hover{border-color:var(--dsw-alias-brand-primary);}',
      '.tu-details{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);}',
      '.tu-footer{padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.tu-view{width:100%;height:100%;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:14px;}',
      '.tu-view-head{display:flex;flex-direction:column;gap:2px;}',
      '.tu-view-headline{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}',
      '.tu-view-title{margin:0;font-size:16px;font-weight:600;}',
      '.tu-generated{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.tu-view-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.tu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;}',
      '.tu-metric{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}',
      '.tu-metric-value{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;}',
      '.tu-metric-label{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.tu-metric-hint{font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.tu-section{display:flex;flex-direction:column;gap:6px;}',
      '.tu-section-title{margin:0;font-size:13px;font-weight:600;}',
      '.tu-table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.tu-table th{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;font-weight:500;text-align:left;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.tu-table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle;}',
      '.tu-num{text-align:right;font-variant-numeric:tabular-nums;}',
      '.tu-share{display:flex;align-items:center;gap:6px;min-width:120px;}',
      '.tu-share-track{flex:1 1 auto;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
      '.tu-share-fill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);}',
      '.tu-open-row td{background:var(--dsw-alias-bg-layer-2);}',
      '.tu-focus-row td{outline:1px solid var(--dsw-alias-brand-primary);}',
      '.tu-calls-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.tu-filters{display:flex;gap:6px;flex-wrap:wrap;}',
      '.tu-filter{padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;cursor:pointer;}',
      '.tu-filter:hover{border-color:var(--dsw-alias-brand-primary);}',
      '.tu-filter--active{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-brand-primary);}',
      '.tu-calls-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.tu-call-list{display:flex;flex-direction:column;gap:4px;}',
      '.tu-turn-label{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.tu-calls-empty{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.tu-empty{max-width:420px;margin:24px auto;padding:20px 24px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:13px;text-align:center;color:var(--dsw-alias-label-secondary);}',
      '.tu-header-action{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;white-space:nowrap;}',
      '.tu-header-action:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.tu-header-action-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);}',
      '.tu-stream{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);}',
      '.tu-stream-head{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      '.tu-stream-title{font-weight:600;font-size:13px;white-space:nowrap;}',
      '.tu-stream-live{padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);font-size:10px;line-height:16px;white-space:nowrap;}',
      '.tu-stream-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
      '.tu-stream-turn{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.tu-stream-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px 10px;display:flex;flex-direction:column;gap:4px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent;}',
      '.tu-stream-hint{font-size:11px;color:var(--dsw-alias-label-secondary);padding-bottom:2px;}',
      '.tu-stream-empty{margin:auto;padding:16px;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:center;}',
      '.tu-stream-row{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;padding:3px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
      '.tu-stream-time{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.tu-stream-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.tu-stream-dur{flex:none;margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
    ].join('\n');

    // ------------------------------------------------------------------
    // Small shared render helpers.
    // ------------------------------------------------------------------

    /** A status dot carrying one of the allowed state tokens. */
    function statusDot(meta, pulsing) {
      return h('span', {
        className: pulsing ? 'tu-dot tu-dot--pulse' : 'tu-dot',
        'aria-hidden': true,
        style: { background: tokenVar(meta.token) },
      });
    }

    /** One tool-name badge. */
    function toolBadge(tool) {
      return h('span', { className: 'tu-badge', title: tool }, tool);
    }

    /** One metric chip: localized label above the value. */
    function metricChip(t, labelKey, value) {
      return h('div', { className: 'tu-chip', key: labelKey },
        h('span', { className: 'tu-chip-label' }, t(labelKey)),
        h('span', { className: 'tu-chip-value' }, String(value)),
      );
    }

    /** One metric card in the dashboard grid. */
    function metricCard(t, labelKey, value, hint) {
      return h('div', { className: 'tu-metric', key: labelKey },
        h('span', { className: 'tu-metric-value' }, String(value)),
        h('span', { className: 'tu-metric-label' }, t(labelKey)),
        hint ? h('span', { className: 'tu-metric-hint' }, hint) : null,
      );
    }

    /** A settled-call row: status dot, tool, summary, duration, optional command. */
    function callRow(call, index, t, options) {
      const meta = statusMeta(call.status);
      const tool = typeof call.tool === 'string' && call.tool ? call.tool : '?';
      const summary = typeof call.summary === 'string' && call.summary ? call.summary : tool;
      const showTurn = options && options.showTurn === true;
      return h('div', { className: 'tu-row', key: call.callId || 'call-' + index },
        statusDot(meta, false),
        toolBadge(tool),
        h('span', { className: 'tu-summary' }, summary),
        h('span', { className: 'tu-dur' }, fmtMs(call.durationMs)),
        showTurn ? h('span', { className: 'tu-turn-label' }, t('turn.label', { turn: num(call.turn) })) : null,
        call.command !== null && call.command !== undefined
          ? h('code', { className: 'tu-cmd', title: String(call.command) }, String(call.command))
          : null,
      );
    }

    // ------------------------------------------------------------------
    // Entry 1: per-turn dashboard card in the chat flow.
    // ------------------------------------------------------------------

    /** One per-tool bar row for a turn summary card. */
    function turnToolBar(t, group, maxCalls) {
      const width = Math.max(2, Math.round((group.calls / maxCalls) * 100));
      return h('div', { className: 'tu-bar-row', key: group.tool },
        h('span', { className: 'tu-bar-label', title: group.tool }, group.tool),
        h('span', { className: 'tu-bar-track' }, h('span', { className: 'tu-bar-fill', style: { width: width + '%' } })),
        h('span', { className: 'tu-bar-meta' },
          h('span', null, String(group.calls)),
          group.errors > 0
            ? h('span', {
              className: 'tu-bar-errors',
              style: { color: tokenVar('--dsw-alias-state-error-primary') },
            }, t('summary.tool.failures', { count: group.errors }))
            : null,
        ),
      );
    }

    /** Dashboard card rendered after a turn closes. */
    function TurnSummary(props) {
      const view = props.useProjection('toolUsage', identity);
      const openState = React.useState(false);
      const open = openState[0];
      const setOpen = openState[1];
      const turnNo = props.turn !== null && props.turn !== undefined && typeof props.turn.turn === 'number'
        ? props.turn.turn
        : undefined;
      const summary = turnNo === undefined
        ? undefined
        : asArray(view && view.turns).filter(function (item) {
          return item !== null && typeof item === 'object' && item.turn === turnNo;
        })[0];
      const derived = React.useMemo(function () { return deriveTurn(view, turnNo); }, [view, turnNo]);
      if (view === undefined || view === null || summary === undefined) return null;
      const t = props.t;
      const calls = num(summary.calls);
      if (calls === 0) return null;
      const errors = num(summary.errors);
      const totalMs = num(summary.totalMs);
      const avgMs = derived.calls.length > 0 ? derived.avgMs : totalMs / calls;
      const meta = outcomeMeta(summary.outcome);
      const bars = derived.tools.slice(0, 5);
      return h('div', { className: 'tu-card' },
        h('div', { className: 'tu-card-head' },
          h('span', { className: 'tu-card-title' }, t('summary.title', { turn: turnNo })),
          h('span', { className: 'tu-pill', style: { color: tokenVar(meta.token) } }, t(meta.key)),
          h('span', { className: 'tu-card-duration' }, fmtMs(totalMs)),
        ),
        h('div', { className: 'tu-chips' },
          metricChip(t, 'summary.metric.calls', calls),
          metricChip(t, 'summary.metric.errors', errors),
          metricChip(t, 'summary.metric.total', fmtMs(totalMs)),
          metricChip(t, 'summary.metric.avg', fmtMs(avgMs)),
          metricChip(t, 'summary.metric.tools', derived.toolCount),
        ),
        bars.length > 0
          ? h('div', { className: 'tu-bars' }, bars.map(function (group) {
            return turnToolBar(t, group, derived.maxCalls);
          }))
          : null,
        h('div', { className: 'tu-shell-hint' }, t('summary.shell', { count: derived.shellCount })),
        h('button', {
          type: 'button',
          className: 'tu-toggle',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () { setOpen(function (value) { return !value; }); },
        }, open ? t('summary.details.hide') : t('summary.details.show', { count: derived.calls.length })),
        open
          ? h('div', { className: 'tu-details' },
            derived.calls.map(function (call, index) { return callRow(call, index, t); }),
            calls > derived.calls.length
              ? h('div', { className: 'tu-omitted' }, t('summary.details.omitted'))
              : null,
          )
          : null,
        h('div', { className: 'tu-footer' }, t('summary.footer')),
      );
    }

    // ------------------------------------------------------------------
    // Entry 2: session dashboard view tab.
    // ------------------------------------------------------------------

    /** Filter buttons of the recent-call list. */
    const FILTERS = [
      { id: 'all', labelKey: 'view.filter.all' },
      { id: 'errors', labelKey: 'view.filter.errors' },
      { id: 'shell', labelKey: 'view.filter.shell' },
    ];

    /** Session-wide call dashboard registered as the `调用看板` view tab. */
    function UsageView(props) {
      const view = props.useProjection('toolUsage', identity);
      const filterState = React.useState('all');
      const filter = filterState[0];
      const setFilter = filterState[1];
      const focusState = React.useState(null);
      const focusTurn = focusState[0];
      const setFocusTurn = focusState[1];
      const viewRequest = props.viewRequest;
      const completeViewRequest = props.completeViewRequest;
      React.useEffect(function () {
        if (viewRequest === null || viewRequest === undefined) return undefined;
        const focus = typeof viewRequest === 'string'
          ? viewRequest
          : typeof viewRequest.focus === 'string' ? viewRequest.focus : undefined;
        if (typeof focus === 'string' && focus.indexOf('turn:') === 0) {
          const parsed = Number(focus.slice(5));
          if (Number.isFinite(parsed)) setFocusTurn(parsed);
        }
        if (typeof completeViewRequest === 'function') completeViewRequest();
        return undefined;
      }, [viewRequest, completeViewRequest]);
      const model = React.useMemo(function () { return deriveSession(view); }, [view]);
      if (view === undefined || view === null || num(view.totals && view.totals.calls) === 0) {
        const tEmpty = props.t;
        return h('div', { className: 'tu-view' },
          h('div', { className: 'tu-empty' }, tEmpty('view.empty')),
        );
      }
      const t = props.t;
      const totals = model.totals;
      const visibleCalls = filterCalls(model.recent, filter);
      const toolHeaders = ['view.byTool.tool', 'view.byTool.calls', 'view.byTool.errors',
        'view.byTool.avg', 'view.byTool.max', 'view.byTool.share'];
      const turnHeaders = ['view.turn.turn', 'view.turn.status', 'view.turn.calls',
        'view.turn.errors', 'view.turn.time', 'view.turn.started'];
      return h('div', { className: 'tu-view' },
        h('div', { className: 'tu-view-head' },
          h('div', { className: 'tu-view-headline' },
            h('h2', { className: 'tu-view-title' }, t('view.title')),
            h('span', { className: 'tu-generated' }, t('view.generated', { time: fmtTime(view.generatedAt) })),
          ),
          h('p', { className: 'tu-view-sub' }, t('view.subtitle')),
        ),
        h('div', { className: 'tu-grid' },
          metricCard(t, 'view.metric.calls', num(totals.calls)),
          metricCard(t, 'view.metric.errors', num(totals.errors),
            t('view.metric.failureRate', { rate: fmtRate(model.failureRate) })),
          metricCard(t, 'view.metric.total', fmtMs(num(totals.totalMs))),
          metricCard(t, 'view.metric.avg', fmtMs(num(totals.avgMs))),
          metricCard(t, 'view.metric.max', fmtMs(num(totals.maxMs))),
          metricCard(t, 'view.metric.tools', num(totals.tools) || model.knownToolCount),
          metricCard(t, 'view.metric.shell', model.shellCalls),
          metricCard(t, 'view.metric.turns', num(totals.turns)),
        ),
        h('section', { className: 'tu-section' },
          h('h3', { className: 'tu-section-title' }, t('view.byTool.title')),
          h('table', { className: 'tu-table' },
            h('thead', null, h('tr', null, toolHeaders.map(function (key) {
              return h('th', { key: key, className: key === 'view.byTool.tool' ? null : 'tu-num' }, t(key));
            }))),
            h('tbody', null, model.byTool.map(function (entry, index) {
              const calls = num(entry && entry.calls);
              const width = Math.round((calls / model.maxToolCalls) * 100);
              const tool = entry !== null && typeof entry === 'object' && typeof entry.tool === 'string'
                ? entry.tool
                : '?';
              return h('tr', { key: entry && entry.tool ? entry.tool : 'tool-' + index },
                h('td', null, toolBadge(tool)),
                h('td', { className: 'tu-num' }, String(calls)),
                h('td', { className: 'tu-num' }, String(num(entry && entry.errors))),
                h('td', { className: 'tu-num' }, fmtMs(num(entry && entry.avgMs))),
                h('td', { className: 'tu-num' }, fmtMs(num(entry && entry.maxMs))),
                h('td', null, h('span', { className: 'tu-share' },
                  h('span', { className: 'tu-share-track' },
                    h('span', { className: 'tu-share-fill', style: { width: width + '%' } })),
                  h('span', { className: 'tu-num' }, width + '%'),
                )),
              );
            })),
          ),
        ),
        h('section', { className: 'tu-section' },
          h('h3', { className: 'tu-section-title' }, t('view.turns.title')),
          h('table', { className: 'tu-table' },
            h('thead', null, h('tr', null, turnHeaders.map(function (key) {
              return h('th', { key: key, className: key === 'view.turn.turn' ? null : 'tu-num' }, t(key));
            }))),
            h('tbody', null, model.turns.map(function (turn, index) {
              const meta = outcomeMeta(turn && turn.outcome);
              const isOpen = turn && (turn.endTime === null || turn.endTime === undefined || turn.outcome === 'open');
              const isFocused = focusTurn !== null && turn && turn.turn === focusTurn;
              const className = [
                isOpen ? 'tu-open-row' : '',
                isFocused ? 'tu-focus-row' : '',
              ].filter(Boolean).join(' ');
              const durationMs = isOpen
                ? num(view.generatedAt) - num(turn && turn.startTime)
                : num(turn && turn.endTime) - num(turn && turn.startTime);
              return h('tr', { key: 'turn-' + num(turn && turn.turn) + '-' + index, className: className || null },
                h('td', null, t('turn.label', { turn: num(turn && turn.turn) })),
                h('td', null, h('span', { className: 'tu-pill', style: { color: tokenVar(meta.token) } },
                  t(meta.key))),
                h('td', { className: 'tu-num' }, String(num(turn && turn.calls))),
                h('td', { className: 'tu-num' }, String(num(turn && turn.errors))),
                h('td', { className: 'tu-num' }, fmtMs(durationMs)),
                h('td', { className: 'tu-num' }, fmtTime(turn && turn.startTime)),
              );
            })),
          ),
        ),
        h('section', { className: 'tu-section' },
          h('div', { className: 'tu-calls-head' },
            h('h3', { className: 'tu-section-title' }, t('view.calls.title')),
            h('div', { className: 'tu-filters' }, FILTERS.map(function (option) {
              const active = filter === option.id;
              return h('button', {
                key: option.id,
                type: 'button',
                className: active ? 'tu-filter tu-filter--active' : 'tu-filter',
                'aria-pressed': active ? 'true' : 'false',
                onClick: function () { setFilter(option.id); },
              }, t(option.labelKey));
            })),
            h('span', { className: 'tu-calls-count' },
              t('view.calls.count', { shown: visibleCalls.length, total: num(totals.settled) })),
          ),
          visibleCalls.length > 0
            ? h('div', { className: 'tu-call-list' }, visibleCalls.map(function (call, index) {
              return callRow(call, index, t, { showTurn: true });
            }))
            : h('div', { className: 'tu-calls-empty' }, t('view.calls.empty')),
        ),
      );
    }

    // ------------------------------------------------------------------
    // Entry 3: right-Sidebar live stream tab.
    // ------------------------------------------------------------------

    /** Session-header control that reveals the stream tab and auto-opens it once per Session mount. */
    function StreamHeaderButton(props) {
      const t = props.t;
      // Auto-open once when this Session starts running. The ref survives
      // re-renders, so a manual close is not undone by later status changes.
      const sessionRunning = typeof props.useSessionStatus === 'function'
        ? props.useSessionStatus(function (state) {
          try {
            if (state === null || state === undefined || typeof state.get !== 'function') return false;
            const status = state.get(props.sessionId);
            return status !== null && status !== undefined && status.running === true;
          } catch (error) {
            return false;
          }
        })
        : false;
      const autoOpened = React.useRef(false);
      React.useEffect(function () {
        if (sessionRunning !== true || autoOpened.current) return undefined;
        autoOpened.current = true;
        if (typeof props.openStream === 'function') {
          try {
            props.openStream();
          } catch (error) {
            /* a profile without the right Sidebar simply keeps the header button */
          }
        }
        return undefined;
      }, [sessionRunning, props.openStream]);
      return h('button', {
        type: 'button',
        className: 'tu-header-action',
        title: t('stream.headerButtonTitle'),
        'aria-label': t('stream.headerButtonTitle'),
        onClick: function () {
          if (typeof props.openStream === 'function') props.openStream();
        },
      },
        h('span', { className: 'tu-header-action-dot', 'aria-hidden': true }),
        h('span', null, t('stream.headerButton')),
      );
    }

    /** One fixed-length stream row: status, time, tool, explanation, command, duration. */
    function streamRow(row, now, t) {
      const meta = statusMeta(row.status);
      const durationMs = row.running ? now - row.startTime : row.durationMs;
      return h('div', { className: 'tu-stream-row', key: row.key },
        statusDot(meta, row.running),
        h('span', { className: 'tu-stream-time' }, fmtTime(row.time)),
        toolBadge(row.tool),
        h('span', { className: 'tu-stream-summary', title: row.summary }, row.summary),
        row.turn !== undefined
          ? h('span', { className: 'tu-turn-label' }, t('turn.label', { turn: row.turn }))
          : null,
        h('span', { className: 'tu-stream-dur' }, fmtMs(durationMs)),
        row.command !== undefined
          ? h('code', { className: 'tu-cmd', title: row.command }, row.command)
          : null,
      );
    }

    /**
     * Right-Sidebar stream body: a fixed header over a fixed-length, scrollable,
     * newest-first call list. Reads the Host projection when present and falls
     * back to the Chat legacy slice on hosts that never registered it.
     */
    function StreamBody(props) {
      const view = props.useProjection('toolUsage', identity);
      const chat = typeof props.useChat === 'function'
        ? props.useChat(function (value) { return value; })
        : undefined;
      const nowState = React.useState(function () { return Date.now(); });
      const now = nowState[0];
      const setNow = nowState[1];
      const t = props.t;
      const model = deriveStream(view, chat, t);
      const ticking = model.runningCount > 0;
      React.useEffect(function () {
        if (!ticking) return undefined;
        const timer = setInterval(function () { setNow(Date.now()); }, 500);
        return function () { clearInterval(timer); };
      }, [ticking]);
      return h('div', { className: 'tu-stream' },
        h('div', { className: 'tu-stream-head', role: 'status', 'aria-live': 'polite' },
          h('span', { className: 'tu-stream-title' }, t('stream.title')),
          ticking ? h('span', { className: 'tu-stream-live' }, t('stream.live')) : null,
          h('span', { className: 'tu-stream-count' }, t('stream.count', { count: model.total })),
          model.turn !== undefined
            ? h('span', { className: 'tu-stream-turn' }, t('turn.label', { turn: model.turn }))
            : null,
        ),
        h('div', { className: 'tu-stream-list' },
          model.trimmed
            ? h('div', { className: 'tu-stream-hint' }, t('stream.latest', { limit: STREAM_LIMIT }))
            : null,
          model.rows.length > 0
            ? model.rows.map(function (row) { return streamRow(row, now, t); })
            : h('div', { className: 'tu-stream-empty' }, t('stream.empty')),
        ),
      );
    }

    // ------------------------------------------------------------------
    // Plugin body.
    // ------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Dictionaries: both baseline locales are complete, zh is the default.
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        }, 'tool-usage: locale dictionaries');
        // One effect-owned stylesheet; no DOM writes anywhere else.
        ctx.effect(function () {
          if (typeof document === 'undefined' || document === null
            || typeof document.createElement !== 'function') {
            return function () {};
          }
          const style = document.createElement('style');
          style.textContent = CSS;
          style.setAttribute('data-tool-usage-ui', '');
          const parent = document.head || document.documentElement;
          if (parent === null || parent === undefined || typeof parent.appendChild !== 'function') {
            return function () {};
          }
          parent.appendChild(style);
          return function () {
            if (style.parentNode !== null && style.parentNode !== undefined
              && typeof style.parentNode.removeChild === 'function') {
              style.parentNode.removeChild(style);
            }
          };
        }, 'tool-usage: stylesheet');
        // The view tab label must follow the active locale without re-registration.
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'tool-usage-summary',
            order: 5,
            locale: NS,
          }, TurnSummary);
        });
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: 'tool-usage-calls',
            order: 20,
            locale: NS,
            label: function () { return t('view.label'); },
          }, UsageView);
        });
        // The right Sidebar is optional: this nested injection activates only when
        // its services exist, so a profile without them keeps every other entry.
        ctx.effect(function () {
          const scopeFiber = ctx.inject(['sidebarRight', 'sidebarRightTabs'], function (scope) {
            openStream = function (sessionId) {
              try {
                scope.sidebarRight.openTabIn(sessionId, STREAM_KIND);
              } catch (error) {
                /* old host or no right Sidebar: ignore */
              }
            };
            const disposers = [];
            disposers.push(scope.sidebarRightTabs.register({
              id: STREAM_TAB_ID,
              kind: STREAM_KIND,
              multiple: false,
              keepMounted: true,
              priority: 'extension',
              title: function () { return t('stream.tabTitle'); },
              guide: [{
                id: 'stream',
                order: 30,
                title: function () { return t('stream.guideTitle'); },
                description: function () { return t('stream.guideDescription'); },
              }],
            }));
            disposers.push(scope.slots.inject('sidebar.right.pane.tab', function () {
              return scope.slots.register({
                name: 'sidebar.right.pane.tab',
                key: STREAM_TAB_ID,
                locale: NS,
              }, StreamBody);
            }));
            disposers.push(scope.slots.inject('conversation.session.header.actions', function () {
              return scope.slots.register({
                name: 'conversation.session.header.actions',
                id: 'tool-usage-stream',
                order: 30,
                locale: NS,
                inject: function (sessionId) {
                  return { openStream: function () { openStream(sessionId); } };
                },
              }, StreamHeaderButton);
            }));
            return function disposeAll() {
              openStream = function () {};
              for (let index = disposers.length - 1; index >= 0; index -= 1) {
                const dispose = disposers[index];
                if (typeof dispose === 'function') dispose();
              }
            };
          });
          return function () {
            openStream = function () {};
            if (scopeFiber !== null && scopeFiber !== undefined
              && typeof scopeFiber.dispose === 'function') {
              void scopeFiber.dispose();
            }
          };
        }, 'tool-usage: right sidebar stream');
      },
    };
  },
});
