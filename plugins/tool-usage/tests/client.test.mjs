/**
 * Client-half tests for `plugins/tool-usage/client.js`.
 *
 * The bundle is plain browser JavaScript, so this suite evaluates it in a
 * `node:vm` context with a captured `window.__ModuleLoader__` and a hand-rolled
 * React stub. Components are rendered by calling them as functions with a fresh
 * hook dispatcher per mount; the resulting element tree is walked as plain
 * `{ type, props, children }` data and asserted on visible text.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const CLIENT_URL = new URL('../client.js', import.meta.url);
const SOURCE = await readFile(CLIENT_URL, 'utf8');

/** Fixed fake clock so duration text is deterministic. */
const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Synthetic projection (contract v0.2.0 wire shape).
// ---------------------------------------------------------------------------

function makeView() {
  return JSON.parse(JSON.stringify({
    v: 1,
    generatedAt: T0 - 600,
    language: 'zh',
    totals: {
      calls: 9,
      settled: 5,
      errors: 1,
      running: 4,
      totalMs: 3300,
      avgMs: 660,
      maxMs: 1000,
      tools: 3,
      turns: 2,
    },
    byTool: [
      {
        tool: 'bash', calls: 3, errors: 1, totalMs: 2500,
        avgMs: 833.33, maxMs: 1000, lastMs: 500, lastAt: T0 - 400,
      },
      {
        tool: 'read_file', calls: 1, errors: 0, totalMs: 500,
        avgMs: 500, maxMs: 500, lastMs: 500, lastAt: T0 - 44500,
      },
      {
        tool: 'grep', calls: 1, errors: 0, totalMs: 300,
        avgMs: 300, maxMs: 300, lastMs: 300, lastAt: T0 - 100,
      },
    ],
    turns: [
      {
        turn: 1, startTime: T0 - 60000, endTime: T0 - 40000,
        calls: 2, errors: 0, totalMs: 1500, outcome: 'completed',
      },
      {
        turn: 2, startTime: T0 - 5000, endTime: null,
        calls: 3, errors: 1, totalMs: 2800, outcome: 'open',
      },
    ],
    calls: [
      {
        callId: 'c1', tool: 'bash', summary: '安装依赖', command: 'pnpm install',
        turn: 1, step: 1, startTime: T0 - 55000, endTime: T0 - 54000,
        durationMs: 1000, status: 'ok', error: null,
      },
      {
        callId: 'c2', tool: 'read_file', summary: '读取配置', command: null,
        turn: 1, step: 2, startTime: T0 - 45000, endTime: T0 - 44500,
        durationMs: 500, status: 'ok', error: null,
      },
      {
        callId: 'c3', tool: 'bash', summary: '运行测试', command: 'pnpm test',
        turn: 2, step: 1, startTime: T0 - 2000, endTime: T0 - 1000,
        durationMs: 1000, status: 'ok', error: null,
      },
      {
        callId: 'c4', tool: 'bash', summary: '构建产物', command: 'pnpm build',
        turn: 2, step: 2, startTime: T0 - 900, endTime: T0 - 400,
        durationMs: 500, status: 'error', error: 'exit 1',
      },
      {
        callId: 'c5', tool: 'grep', summary: '搜索用法', command: null,
        turn: 2, step: 3, startTime: T0 - 400, endTime: T0 - 100,
        durationMs: 300, status: 'aborted', error: null,
      },
    ],
    running: [
      {
        callId: 'r1', tool: 'bash', summary: '启动服务', command: 'pnpm dev',
        turn: 2, step: 4, startTime: T0 - 900,
      },
      {
        callId: 'r2', tool: 'read_file', summary: '读取日志', command: null,
        turn: 2, step: 5, startTime: T0 - 800,
      },
      {
        callId: 'r3', tool: 'grep', summary: '', command: null,
        turn: 2, step: 6, startTime: T0 - 700,
      },
      {
        callId: 'r4', tool: 'bash', summary: '额外命令', command: 'ls -la',
        turn: 2, step: 7, startTime: T0 - 600,
      },
    ],
  }));
}

// ---------------------------------------------------------------------------
// React stub: hooks dispatch into whichever hook runtime is rendering.
// ---------------------------------------------------------------------------

let activeRuntime = null;

function hookRuntime() {
  if (activeRuntime === null) throw new Error('React hook called outside a component render');
  return activeRuntime;
}

function depsEqual(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (!Object.is(previous[index], next[index])) return false;
  }
  return true;
}

/** The `react` module the bundle receives through its loader `require`. */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
  useState(initial) {
    const runtime = hookRuntime();
    const index = runtime.cursor;
    runtime.cursor += 1;
    if (!(index in runtime.slots)) {
      runtime.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    }
    const slot = runtime.slots[index];
    const setState = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (!Object.is(value, slot.value)) {
        slot.value = value;
        runtime.dirty = true;
      }
    };
    return [slot.value, setState];
  },
  useMemo(factory, deps) {
    const runtime = hookRuntime();
    const index = runtime.cursor;
    runtime.cursor += 1;
    const previous = runtime.slots[index];
    if (previous !== undefined && depsEqual(previous.deps, deps)) return previous.value;
    const value = factory();
    runtime.slots[index] = { value, deps: Array.isArray(deps) ? deps.slice() : deps };
    return value;
  },
  useCallback(callback, deps) {
    const runtime = hookRuntime();
    const index = runtime.cursor;
    runtime.cursor += 1;
    const previous = runtime.slots[index];
    if (previous !== undefined && depsEqual(previous.deps, deps)) return previous.value;
    runtime.slots[index] = { value: callback, deps: Array.isArray(deps) ? deps.slice() : deps };
    return callback;
  },
  useRef(initial) {
    const runtime = hookRuntime();
    const index = runtime.cursor;
    runtime.cursor += 1;
    if (!(index in runtime.slots)) runtime.slots[index] = { current: initial };
    return runtime.slots[index];
  },
  useEffect(effect, deps) {
    const runtime = hookRuntime();
    const index = runtime.cursor;
    runtime.cursor += 1;
    runtime.effects.push({ index, effect, deps });
  },
};

/**
 * Minimal function-component renderer: renders until state settles, then runs
 * the collected effects (and their cleanups before the next commit).
 */
function mount(component, props) {
  const runtime = { slots: [], cursor: 0, dirty: false, effects: [] };
  let tree = null;
  const commit = () => {
    const previousRuntime = activeRuntime;
    activeRuntime = runtime;
    try {
      let guard = 0;
      for (;;) {
        runtime.cursor = 0;
        runtime.dirty = false;
        runtime.effects = [];
        tree = component(props);
        if (runtime.dirty) {
          guard += 1;
          if (guard > 100) throw new Error('render loop did not settle');
          continue;
        }
        // Commit effects React-style: unchanged dependency arrays are skipped.
        for (const entry of runtime.effects) {
          const slot = runtime.slots[entry.index];
          if (slot !== undefined && depsEqual(slot.deps, entry.deps)) continue;
          if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup();
          const cleanup = entry.effect();
          runtime.slots[entry.index] = {
            deps: Array.isArray(entry.deps) ? entry.deps.slice() : entry.deps,
            cleanup: typeof cleanup === 'function' ? cleanup : undefined,
          };
        }
        if (runtime.dirty) {
          guard += 1;
          if (guard > 100) throw new Error('effect loop did not settle');
          continue;
        }
        return tree;
      }
    } finally {
      activeRuntime = previousRuntime;
    }
  };
  commit();
  return {
    get tree() {
      return tree;
    },
    rerender() {
      return commit();
    },
    dispose() {
      for (const slot of runtime.slots) {
        if (slot !== null && typeof slot === 'object' && typeof slot.cleanup === 'function') {
          slot.cleanup();
          slot.cleanup = undefined;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Element-tree inspection.
// ---------------------------------------------------------------------------

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const parts = [];
    for (const child of node) {
      const text = textOf(child);
      if (text !== '') parts.push(text);
    }
    return parts.join(' ');
  }
  if (typeof node !== 'object') return '';
  const children = Array.isArray(node.children) ? node.children : [];
  const parts = [];
  for (const child of children) {
    const text = textOf(child);
    if (text !== '') parts.push(text);
  }
  return parts.join(' ');
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) walk(child, visit);
}

function buttons(tree) {
  const found = [];
  walk(tree, (node) => {
    if (node.type === 'button') found.push(node);
  });
  return found;
}

function clickButton(tree, label) {
  const matches = buttons(tree).filter((node) => textOf(node).trim() === label);
  assert.equal(matches.length, 1,
    `expected exactly one button labelled ${JSON.stringify(label)}, found ${matches.length}`);
  assert.equal(typeof matches[0].props.onClick, 'function');
  matches[0].props.onClick();
}

function assertIncludes(text, needles) {
  for (const needle of needles) {
    assert.ok(text.includes(needle),
      `expected rendered text to include ${JSON.stringify(needle)}\nactual: ${text}`);
  }
}

function assertExcludes(text, needles) {
  for (const needle of needles) {
    assert.ok(!text.includes(needle),
      `expected rendered text NOT to include ${JSON.stringify(needle)}\nactual: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Client bundle loading (node:vm + captured __ModuleLoader__).
// ---------------------------------------------------------------------------

function loadClient() {
  const definitions = [];
  const timers = [];
  const clock = { now: T0 };
  const styleNodes = [];
  const head = {
    children: styleNodes,
    appendChild(node) {
      styleNodes.push(node);
      node.parentNode = this;
    },
    removeChild(node) {
      const index = styleNodes.indexOf(node);
      if (index >= 0) styleNodes.splice(index, 1);
      node.parentNode = null;
    },
  };
  const documentStub = {
    head,
    createElement(tagName) {
      return {
        tagName,
        textContent: '',
        attributes: {},
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
    },
  };
  // Deterministic Date: the component only reads Date.now() and formats epochs.
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }

    static now() {
      return clock.now;
    }
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          definitions.push(definition);
        },
      },
    },
    document: documentStub,
    setInterval(callback, ms) {
      const handle = { id: timers.length + 1, callback, ms, cleared: false };
      timers.push(handle);
      return handle.id;
    },
    clearInterval(id) {
      const handle = timers[id - 1];
      if (handle !== undefined) handle.cleared = true;
    },
    setTimeout(callback, ms) {
      return sandbox.setInterval(callback, ms);
    },
    clearTimeout(id) {
      sandbox.clearInterval(id);
    },
    console,
    Date: FakeDate,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });

  assert.equal(definitions.length, 1, 'client.js must call window.__ModuleLoader__.load exactly once');
  const definition = definitions[0];
  const requireCalls = [];
  const plugin = definition.factory((id) => {
    requireCalls.push(id);
    if (id !== 'react') throw new Error(`unexpected require(${JSON.stringify(id)})`);
    return React;
  });
  return {
    definition,
    plugin,
    requireCalls,
    timers,
    clock,
    styleNodes,
    sandbox,
    documentStub,
  };
}

const client = loadClient();

/** Invoke the plugin's apply() against a fake client root context. */
function applyPlugin(options = {}) {
  const registrations = [];
  const injections = [];
  const dictionaries = {};
  const openedTabs = [];
  const registeredTypes = [];
  const stylesBefore = client.styleNodes.length;
  const withSidebar = options.withSidebar !== false;
  const sidebarRight = {
    openTabIn(sessionId, kind) {
      openedTabs.push([sessionId, kind]);
    },
  };
  const sidebarRightTabs = {
    register(definition) {
      registeredTypes.push(definition);
      return () => {};
    },
  };
  const locale = {
    register(namespace, dicts) {
      dictionaries[namespace] = dicts;
      return () => {};
    },
    bind(namespace) {
      return (key, params) => {
        const dicts = dictionaries[namespace];
        let template = dicts && dicts.zh ? dicts.zh[key] : undefined;
        if (typeof template !== 'string') template = key;
        if (params !== null && params !== undefined) {
          for (const name of Object.keys(params)) {
            template = template.split('{' + name + '}').join(String(params[name]));
          }
        }
        return template;
      };
    },
  };
  const slots = {
    inject(name, callback) {
      injections.push(name);
      const result = callback();
      return typeof result === 'function' ? result : () => {};
    },
    register(registerOptions, component) {
      registrations.push({ options: registerOptions, component });
      return () => {};
    },
  };
  const ctx = {
    effect(fn) {
      const result = fn();
      return typeof result === 'function' ? result : () => {};
    },
    get(name) {
      return name === 'sidebarRight' && withSidebar ? sidebarRight : undefined;
    },
    inject(deps, callback) {
      assert.deepEqual([...deps], ['sidebarRight', 'sidebarRightTabs']);
      if (!withSidebar) return { dispose() {} };
      const scope = {
        sidebarRight,
        sidebarRightTabs,
        slots,
        locale,
        effect: ctx.effect,
        get: ctx.get,
      };
      const dispose = callback(scope);
      return { dispose: typeof dispose === 'function' ? dispose : () => {} };
    },
    slots,
    locale,
  };
  client.plugin.apply(ctx);
  return {
    ctx,
    registrations,
    injections,
    dictionaries,
    dicts: dictionaries['tool-usage-ui'],
    styleCount: client.styleNodes.length - stylesBefore,
    openedTabs,
    registeredTypes,
    sidebarRight,
    sidebarRightTabs,
  };
}

/** Dictionary-backed translate with missing-key tracking (returns the key when absent). */
function createTranslate(dicts, language) {
  const missing = new Set();
  const used = [];
  const t = (key, params) => {
    assert.equal(typeof key, 'string', 'translation keys must be strings');
    used.push(key);
    let template = dicts && dicts[language] ? dicts[language][key] : undefined;
    if (typeof template !== 'string') {
      missing.add(key);
      template = key;
    }
    if (params !== null && params !== undefined) {
      for (const name of Object.keys(params)) {
        template = template.split('{' + name + '}').join(String(params[name]));
      }
    }
    return template;
  };
  return { t, missing, used };
}

function assertNoMissingKeys(translate) {
  assert.deepEqual([...translate.missing], [],
    `missing ${translate.missing.size} locale key(s) for the rendered components`);
}

function propsFor(options) {
  const translate = createTranslate(options.applied.dicts, options.language || 'zh');
  const chat = options.chat;
  const sessionId = options.sessionId === undefined ? 'session-1' : options.sessionId;
  const sessionRunning = typeof options.sessionRunning === 'function'
    ? options.sessionRunning
    : () => options.sessionRunning === true;
  const statuses = new Map();
  const props = {
    useProjection(key, selector) {
      assert.equal(key, 'toolUsage', 'components must read the toolUsage projection');
      if (typeof selector === 'function') return selector(options.view);
      return options.view;
    },
    useChat(selector) {
      if (typeof selector === 'function') return selector(chat);
      return chat;
    },
    useSessionStatus(selector) {
      statuses.set(sessionId, { running: sessionRunning() === true });
      if (typeof selector === 'function') return selector(statuses);
      return statuses;
    },
    t: translate.t,
    sessionId,
    openStream: options.openStream === undefined ? () => {} : options.openStream,
    turn: { turn: options.turn === undefined ? 1 : options.turn },
    seq: 7,
    viewRequest: options.viewRequest === undefined ? null : options.viewRequest,
    completeViewRequest: options.completeViewRequest === undefined
      ? () => {}
      : options.completeViewRequest,
  };
  return { props, translate };
}

function mountComponent(applied, id, options) {
  // Keyed sidebar registrations are addressed by their key instead of an id.
  const registration = applied.registrations.find(
    (entry) => entry.options.id === id || entry.options.key === id,
  );
  assert.ok(registration !== undefined, `no slot registration with id or key ${id}`);
  assert.equal(typeof registration.component, 'function');
  const { props, translate } = propsFor({ applied, ...options });
  const harness = mount(registration.component, props);
  return { harness, translate, props, registration };
}

function renderAndDispose(applied, id, options) {
  const mounted = mountComponent(applied, id, options);
  const text = textOf(mounted.harness.tree);
  mounted.harness.dispose();
  return { text, translate: mounted.translate };
}

// ---------------------------------------------------------------------------
// Stream fixtures: projection rows, Chat legacy fallback, and the fake args view.
// ---------------------------------------------------------------------------

/** Fake PartialArguments view with text()/complete() readers. */
function fakeArgs(fields) {
  return {
    text(key) {
      return Object.hasOwn(fields, key) ? fields[key] : undefined;
    },
    complete(key) {
      return Object.hasOwn(fields, key);
    },
  };
}

/** A Chat snapshot with only the legacy slice the stream fallback reads. */
function makeLegacyChat() {
  return {
    legacy: {
      runningCalls: [
        {
          callId: 'lr1', phase: 'start', name: 'bash',
          args: fakeArgs({ command: 'pnpm dev' }), time: T0 - 900, turn: 2, step: 1,
        },
      ],
      nodes: [
        {
          kind: 'tool-result', callId: 'ln1', name: 'bash',
          args: fakeArgs({ command: 'pnpm test' }), callTime: T0 - 3000, time: T0 - 2000, isError: false,
        },
        {
          kind: 'tool-result', callId: 'ln2', name: 'read_file',
          args: fakeArgs({ path: 'src/index.ts' }), callTime: T0 - 2500, time: T0 - 2000, isError: false,
        },
        {
          kind: 'tool-result', callId: 'ln3', name: 'grep',
          args: fakeArgs({ pattern: 'openStream' }), callTime: T0 - 2000, time: T0 - 1900, isError: true,
        },
        {
          kind: 'tool-result', callId: 'ln4', name: 'todo_write',
          args: fakeArgs({}), callTime: T0 - 1800, time: T0 - 1700, isError: false,
        },
      ],
      turnTimings: new Map(),
      turnEnds: new Map(),
      partial: null,
    },
  };
}

/** A projection with `settledCount` settled calls plus two running ones. */
function makeStreamView(settledCount) {
  const calls = [];
  for (let index = 0; index < settledCount; index += 1) {
    calls.push({
      callId: 'stream-call-' + index,
      tool: index % 2 === 0 ? 'bash' : 'read_file',
      summary: '调用 ' + index,
      command: index % 2 === 0 ? 'echo ' + index : null,
      turn: 2,
      step: index + 1,
      startTime: T0 - 100000 + index * 1000,
      endTime: T0 - 100000 + index * 1000 + 500,
      durationMs: 500,
      status: 'ok',
      error: null,
    });
  }
  return {
    v: 1,
    generatedAt: T0,
    language: 'zh',
    totals: {
      calls: settledCount + 2,
      settled: settledCount,
      errors: 0,
      running: 2,
      totalMs: settledCount * 500,
      avgMs: 500,
      maxMs: 500,
      tools: 2,
      turns: 1,
    },
    byTool: [],
    turns: [{
      turn: 2, startTime: T0 - 5000, endTime: null,
      calls: settledCount + 2, errors: 0, totalMs: 0, outcome: 'open',
    }],
    calls,
    running: [
      {
        callId: 'stream-run-1', tool: 'bash', summary: '启动服务', command: 'pnpm dev',
        turn: 2, step: 99, startTime: T0 - 900,
      },
      {
        callId: 'stream-run-2', tool: 'read_file', summary: '读取日志', command: null,
        turn: 2, step: 100, startTime: T0 - 800,
      },
    ],
  };
}

/** Count rendered stream rows. */
function streamRows(tree) {
  const rows = [];
  walk(tree, (node) => {
    const className = node.props && typeof node.props.className === 'string' ? node.props.className : '';
    if (className === 'tu-stream-row') rows.push(node);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('bundle uses the loader format, requires only react, and exposes inject/apply', () => {
  assert.equal(client.definition.id, 'dsh-plugin-tool-usage');
  assert.deepEqual(client.requireCalls, ['react']);
  assert.doesNotMatch(SOURCE, /@deepseek-ai\//);
  assert.doesNotMatch(SOURCE, /\bfetch\s*\(/);
  assert.doesNotMatch(SOURCE, /document\.body/);
  assert.match(SOURCE, /setInterval\s*\(/);
  assert.ok(Array.isArray(client.plugin.inject));
  assert.ok(client.plugin.inject.includes('slots'));
  assert.ok(client.plugin.inject.includes('locale'));
  assert.equal(typeof client.plugin.apply, 'function');
});

test('apply registers the two conversation entries, the sidebar body, and the header action', () => {
  const applied = applyPlugin();
  assert.deepEqual(applied.injections, [
    'conversation.chat.turnTail',
    'conversation.view',
    'sidebar.right.pane.tab',
    'conversation.session.header.actions',
  ]);
  assert.equal(applied.registrations.length, 4);
  const expected = [
    ['conversation.chat.turnTail', 'tool-usage-summary', 5],
    ['conversation.view', 'tool-usage-calls', 20],
  ];
  expected.forEach(([name, id, order], index) => {
    const entry = applied.registrations[index];
    assert.equal(entry.options.name, name);
    assert.equal(entry.options.id, id);
    assert.equal(entry.options.order, order);
    assert.equal(entry.options.locale, 'tool-usage-ui');
    assert.equal(typeof entry.component, 'function');
  });
  const view = applied.registrations[1].options;
  assert.equal(typeof view.label, 'function');
  assert.equal(view.label(), '调用看板');

  // Keyed right-Sidebar body under the tab definition's id.
  const body = applied.registrations[2];
  assert.equal(body.options.name, 'sidebar.right.pane.tab');
  assert.equal(body.options.key, 'dsh-plugin-tool-usage-stream');
  assert.equal(body.options.locale, 'tool-usage-ui');
  assert.equal(typeof body.component, 'function');
  // Header action can reopen the tab manually.
  const headerAction = applied.registrations[3];
  assert.equal(headerAction.options.name, 'conversation.session.header.actions');
  assert.equal(headerAction.options.id, 'tool-usage-stream');
  assert.equal(headerAction.options.order, 30);
  assert.equal(headerAction.options.locale, 'tool-usage-ui');
  assert.equal(typeof headerAction.options.inject, 'function');
  const face = headerAction.options.inject('session-7');
  assert.equal(typeof face.openStream, 'function');
  applied.openedTabs.length = 0;
  face.openStream();
  assert.deepEqual(applied.openedTabs, [['session-7', 'tool-usage-stream']]);

  // Sidebar tab type definition.
  assert.equal(applied.registeredTypes.length, 1);
  const definition = applied.registeredTypes[0];
  assert.equal(definition.id, 'dsh-plugin-tool-usage-stream');
  assert.equal(definition.kind, 'tool-usage-stream');
  assert.equal(definition.multiple, false);
  assert.equal(definition.keepMounted, true);
  assert.equal(definition.priority, 'extension');
  assert.equal(definition.title(), '调用流');
  assert.equal(definition.guide.length, 1);
  assert.equal(definition.guide[0].id, 'stream');
  assert.equal(definition.guide[0].order, 30);
  assert.equal(definition.guide[0].title(), '调用流');
  assert.equal(definition.guide[0].description(), '实时查看本次会话的 Shell 命令与工具调用。');
  assert.equal(applied.styleCount, 1, 'apply must create exactly one effect-owned style element');
});

test('a profile without the right sidebar keeps the conversation entries', () => {
  const applied = applyPlugin({ withSidebar: false });
  assert.equal(applied.registrations.length, 2);
  assert.deepEqual(applied.injections, [
    'conversation.chat.turnTail',
    'conversation.view',
  ]);
  assert.equal(applied.registeredTypes.length, 0);
  assert.equal(applied.openedTabs.length, 0);
});

test('locale namespace has complete, parallel zh and en dictionaries', () => {
  const applied = applyPlugin();
  assert.ok(applied.dicts, 'tool-usage-ui dictionaries must be registered');
  assert.ok(applied.dicts.zh && applied.dicts.en);
  const zhKeys = Object.keys(applied.dicts.zh).sort();
  const enKeys = Object.keys(applied.dicts.en).sort();
  assert.deepEqual(enKeys, zhKeys);
  assert.ok(zhKeys.length >= 72, `expected a complete dictionary, got ${zhKeys.length} keys`);
  assert.equal(applied.dicts.zh['view.label'], '调用看板');
  assert.equal(applied.dicts.en['view.label'], 'Calls');
  assert.equal(applied.dicts.zh['summary.footer'],
    '在会话顶部「调用看板」查看整个会话的统计。');
  assert.equal(applied.dicts.zh['stream.tabTitle'], '调用流');
  assert.equal(applied.dicts.en['stream.tabTitle'], 'Calls stream');
  assert.equal(applied.dicts.zh['stream.fallback.bash'], '执行 Shell 命令：{command}');
  assert.equal(applied.dicts.en['stream.fallback.bash'], 'Run shell command: {command}');
});

test('stream header action auto-opens the stream once when the session starts running', () => {
  const applied = applyPlugin();
  let running = false;
  const opened = [];
  const mounted = mountComponent(applied, 'tool-usage-stream', {
    sessionRunning: () => running,
    openStream: () => { opened.push('opened'); },
  });
  assert.deepEqual(opened, [], 'an idle session must not open the panel');
  running = true;
  mounted.harness.rerender();
  assert.deepEqual(opened, ['opened']);
  mounted.harness.rerender();
  assert.deepEqual(opened, ['opened'], 'the ref guard stops later automatic opens');
  assertNoMissingKeys(mounted.translate);
  mounted.harness.dispose();
});

test('stream header action opens the sidebar stream tab', () => {
  const applied = applyPlugin();
  const opened = [];
  const mounted = mountComponent(applied, 'tool-usage-stream', {
    openStream: () => { opened.push('opened'); },
  });
  const text = textOf(mounted.harness.tree);
  assertIncludes(text, ['调用流']);
  const headerButtons = buttons(mounted.harness.tree);
  assert.equal(headerButtons.length, 1);
  assert.equal(headerButtons[0].props.title, '打开调用流侧栏');
  clickButton(mounted.harness.tree, '调用流');
  assert.deepEqual(opened, ['opened']);
  assertNoMissingKeys(mounted.translate);
  mounted.harness.dispose();
});

test('stream body renders projection rows newest first with a live ticking header', () => {
  const applied = applyPlugin();
  client.clock.now = T0;
  const timerStart = client.timers.length;
  const { harness, translate } = mountComponent(applied, 'dsh-plugin-tool-usage-stream', {
    view: makeView(),
  });
  const text = textOf(harness.tree);
  assertIncludes(text, [
    '调用流',
    '实时',
    '共 9 次调用',
    '第 2 轮',
    '启动服务',
    'pnpm dev',
    '搜索用法',
    '运行测试',
    '600ms', // r4 elapsed at the fake clock
  ]);
  // Running rows first (newest start first), then settled rows newest end first.
  assert.ok(text.indexOf('额外命令') < text.indexOf('搜索用法'),
    'running rows must stay at the top of the stream');
  assert.ok(text.indexOf('搜索用法') < text.indexOf('运行测试'),
    'settled rows must be newest first');
  assert.equal(streamRows(harness.tree).length, 9);
  const interval = client.timers.slice(timerStart).find((timer) => timer.ms === 500);
  assert.ok(interval !== undefined, 'running stream rows must tick every 500ms');
  client.clock.now = T0 + 1000;
  interval.callback();
  harness.rerender();
  assertIncludes(textOf(harness.tree), ['1.6s']);
  assertNoMissingKeys(translate);
  harness.dispose();
  assert.equal(client.timers[interval.id - 1].cleared, true, 'interval must be cleared on unmount');
});

test('stream body fixes the list at 50 rows and hints at the trim', () => {
  const applied = applyPlugin();
  client.clock.now = T0;
  const view = makeStreamView(60);
  const mounted = mountComponent(applied, 'dsh-plugin-tool-usage-stream', { view });
  const text = textOf(mounted.harness.tree);
  assert.equal(streamRows(mounted.harness.tree).length, 50);
  assertIncludes(text, ['最新 50 条', '共 62 次调用', '启动服务']);
  // Newest settled rows survive; the oldest fall outside the fixed window.
  assertIncludes(text, ['调用 59', '调用 12']);
  assertExcludes(text, ['调用 0 ', '调用 11 ']);
  assert.ok(text.indexOf('启动服务') < text.indexOf('调用 59'));
  assertNoMissingKeys(mounted.translate);
  mounted.harness.dispose();
});

test('stream body falls back to the Chat legacy slice without a projection', () => {
  const applied = applyPlugin();
  client.clock.now = T0;
  const timerStart = client.timers.length;
  const { harness, translate } = mountComponent(applied, 'dsh-plugin-tool-usage-stream', {
    view: undefined,
    chat: makeLegacyChat(),
  });
  const text = textOf(harness.tree);
  assertIncludes(text, [
    '调用流',
    '实时',
    '共 5 次调用',
    '第 2 轮',
    '执行 Shell 命令：pnpm test',
    '读取文件 src/index.ts',
    '搜索内容 openStream',
    'pnpm dev',
    '900ms', // running call elapsed
    '1.0s', // settled duration from time - callTime
  ]);
  assert.ok(text.indexOf('pnpm dev') < text.indexOf('搜索内容 openStream'));
  assert.ok(text.indexOf('搜索内容 openStream') < text.indexOf('执行 Shell 命令：pnpm test'));
  const interval = client.timers.slice(timerStart).find((timer) => timer.ms === 500);
  assert.ok(interval !== undefined, 'fallback running rows must tick too');
  client.clock.now = T0 + 1000;
  interval.callback();
  harness.rerender();
  assertIncludes(textOf(harness.tree), ['1.9s']);
  assertNoMissingKeys(translate);
  harness.dispose();
});

test('stream body fallback speaks English', () => {
  const applied = applyPlugin();
  client.clock.now = T0;
  const { text, translate } = renderAndDispose(applied, 'dsh-plugin-tool-usage-stream', {
    view: undefined,
    chat: makeLegacyChat(),
    language: 'en',
  });
  assertIncludes(text, [
    'Calls stream',
    'Live',
    '5 calls',
    'Run shell command: pnpm test',
    'Read file src/index.ts',
    'Search content openStream',
    'Call tool',
  ]);
  assertNoMissingKeys(translate);
});

test('stream body shows its empty state', () => {
  const applied = applyPlugin();
  const mounted = mountComponent(applied, 'dsh-plugin-tool-usage-stream', { view: undefined });
  const text = textOf(mounted.harness.tree);
  assertIncludes(text, ['调用流', '共 0 次调用', '等待工具调用…']);
  assert.equal(streamRows(mounted.harness.tree).length, 0);
  assertNoMissingKeys(mounted.translate);
  mounted.harness.dispose();
});

test('per-turn card shows the turn dashboard, expanded on demand', () => {
  const applied = applyPlugin();
  const view = makeView();
  const { harness, translate } = mountComponent(applied, 'tool-usage-summary', {
    view,
    turn: 1,
  });
  const collapsed = textOf(harness.tree);
  assertIncludes(collapsed, [
    '工具调用看板 · 第 1 轮',
    '已完成',
    '调用次数',
    '失败次数',
    '总耗时',
    '平均耗时',
    '工具种类',
    '1.5s', // total duration
    '750ms', // average of this turn's settled calls
    'Shell 命令 1 条',
    '查看 2 次调用明细',
    '在会话顶部「调用看板」查看整个会话的统计。',
  ]);
  // Per-tool bars for this turn.
  assertIncludes(collapsed, ['bash', 'read_file']);
  // Per-turn call counts: 2 calls, 0 failures, 2 distinct tools.
  assert.match(collectClassText(harness.tree, 'tu-chip', '调用次数'), /调用次数 2/);
  assert.match(collectClassText(harness.tree, 'tu-chip', '失败次数'), /失败次数 0/);
  assert.match(collectClassText(harness.tree, 'tu-chip', '工具种类'), /工具种类 2/);
  // Details are collapsed by default.
  assertExcludes(collapsed, ['pnpm install', '读取配置']);
  clickButton(harness.tree, '查看 2 次调用明细');
  harness.rerender();
  const opened = textOf(harness.tree);
  assertIncludes(opened, ['收起调用明细', '安装依赖', 'pnpm install', '读取配置']);
  assertNoMissingKeys(translate);
  harness.dispose();

  // A turn with failures surfaces them in per-tool bars and the outcome pill.
  const failedTurn = renderAndDispose(applied, 'tool-usage-summary', {
    view: makeView(),
    turn: 2,
    language: 'zh',
  });
  assertIncludes(failedTurn.text, [
    '工具调用看板 · 第 2 轮',
    '进行中',
    '2.8s',
    '600ms',
    '1 失败',
    'Shell 命令 2 条',
  ]);
  assertNoMissingKeys(failedTurn.translate);
});

test('per-turn card renders nothing without projection, turn, or calls', () => {
  const applied = applyPlugin();
  const noProjection = mountComponent(applied, 'tool-usage-summary', {
    view: undefined,
    turn: 1,
  });
  assert.equal(noProjection.harness.tree, null);
  noProjection.harness.dispose();

  const noTurn = mountComponent(applied, 'tool-usage-summary', {
    view: makeView(),
    turn: 99,
  });
  assert.equal(noTurn.harness.tree, null);
  noTurn.harness.dispose();

  const emptyTurn = makeView();
  emptyTurn.turns.push({
    turn: 3, startTime: T0, endTime: T0 + 10, calls: 0, errors: 0, totalMs: 0, outcome: 'completed',
  });
  const zeroCalls = mountComponent(applied, 'tool-usage-summary', {
    view: emptyTurn,
    turn: 3,
  });
  assert.equal(zeroCalls.harness.tree, null);
  zeroCalls.harness.dispose();
});

test('dashboard view renders totals, by-tool table, turn timeline, and recent calls', () => {
  const applied = applyPlugin();
  const { harness, translate } = mountComponent(applied, 'tool-usage-calls', {
    view: makeView(),
  });
  const text = textOf(harness.tree);
  assertIncludes(text, [
    '调用看板',
    '按工具与轮次汇总本次会话的工具调用。',
    '更新于 ',
    '调用次数',
    '失败次数',
    '失败率 11.1%',
    '总耗时',
    '平均耗时',
    '最慢耗时',
    '工具种类',
    'Shell 命令数',
    '轮次数',
    '按工具统计',
    '轮次时间线',
    '最近调用',
    '全部',
    '失败',
    'Shell',
    'pnpm test',
    '第 2 轮',
    '第 1 轮',
  ]);
  // Newest turn first in the timeline.
  assert.ok(text.indexOf('第 2 轮') < text.indexOf('第 1 轮'),
    'turn timeline must be newest-first');
  // Shell command count derived from settled calls with a command line.
  const shellCard = collectClassText(harness.tree, 'tu-metric', 'Shell 命令数');
  assert.ok(shellCard.includes('3'), `expected 3 shell calls in metric card, got: ${shellCard}`);
  const callsCard = collectClassText(harness.tree, 'tu-metric', '调用次数');
  assert.ok(callsCard.includes('9'), `expected 9 total calls, got: ${callsCard}`);
  const errorsCard = collectClassText(harness.tree, 'tu-metric', '失败次数');
  assert.ok(errorsCard.includes('1'), `expected 1 failed call, got: ${errorsCard}`);
  assertNoMissingKeys(translate);
  harness.dispose();
});

/** Text of the first element with one class that carries a localized label. */
function collectClassText(tree, className, label) {
  const matches = [];
  walk(tree, (node) => {
    if (node.type !== 'div') return;
    const value = node.props && typeof node.props.className === 'string' ? node.props.className : '';
    if (value === className) matches.push(textOf(node));
  });
  const match = matches.find((entry) => entry.includes(label));
  assert.ok(match !== undefined,
    `no .${className} carrying ${label}; found: ${JSON.stringify(matches)}`);
  return match;
}

test('dashboard filters switch between all, failures, and shell commands', () => {
  const applied = applyPlugin();
  const { harness } = mountComponent(applied, 'tool-usage-calls', { view: makeView() });
  const initial = textOf(harness.tree);
  assertIncludes(initial, ['运行测试', '构建产物', '搜索用法', '安装依赖']);

  clickButton(harness.tree, '失败');
  harness.rerender();
  const failures = textOf(harness.tree);
  assertIncludes(failures, ['构建产物', '显示 1 / 5 次调用']);
  assertExcludes(failures, ['运行测试', '搜索用法', '安装依赖']);

  clickButton(harness.tree, 'Shell');
  harness.rerender();
  const shell = textOf(harness.tree);
  assertIncludes(shell, ['pnpm test', 'pnpm build', 'pnpm install', '显示 3 / 5 次调用']);
  assertExcludes(shell, ['搜索用法', '读取配置']);

  clickButton(harness.tree, '全部');
  harness.rerender();
  const all = textOf(harness.tree);
  assertIncludes(all, ['搜索用法', '显示 5 / 5 次调用']);
  harness.dispose();
});

test('dashboard view renders an empty state without projection or calls', () => {
  const applied = applyPlugin();
  const missing = renderAndDispose(applied, 'tool-usage-calls', { view: undefined });
  assertIncludes(missing.text, ['还没有工具调用数据。']);

  const empty = makeView();
  empty.totals.calls = 0;
  const noCalls = renderAndDispose(applied, 'tool-usage-calls', { view: empty });
  assertIncludes(noCalls.text, ['还没有工具调用数据。']);
});

test('dashboard consumes a focus viewRequest and acknowledges it', () => {
  const applied = applyPlugin();
  const completeCalls = [];
  const view = makeView();
  const { harness } = mountComponent(applied, 'tool-usage-calls', {
    view,
    viewRequest: { focus: 'turn:1' },
    completeViewRequest: () => { completeCalls.push(true); },
  });
  assert.equal(completeCalls.length, 1, 'handled viewRequest must call completeViewRequest once');
  // The focused turn row gets the highlight class.
  const focused = [];
  walk(harness.tree, (node) => {
    const className = node.props && typeof node.props.className === 'string' ? node.props.className : '';
    if (className.includes('tu-focus-row')) focused.push(node);
  });
  assert.equal(focused.length, 1);
  harness.dispose();
});

test('English dictionaries render the same entries', () => {
  const applied = applyPlugin();
  const stream = renderAndDispose(applied, 'dsh-plugin-tool-usage-stream', {
    view: makeView(),
    language: 'en',
  });
  assertIncludes(stream.text, ['Calls stream', 'pnpm dev', 'Turn 2']);
  assertNoMissingKeys(stream.translate);

  const dashboard = renderAndDispose(applied, 'tool-usage-calls', {
    view: makeView(),
    language: 'en',
  });
  assertIncludes(dashboard.text, [
    'Call dashboard',
    'Calls',
    'Failures',
    'Recent calls',
    'Turn timeline',
    'Showing 5 of 5 calls',
  ]);
  assertNoMissingKeys(dashboard.translate);

  const summary = renderAndDispose(applied, 'tool-usage-summary', {
    view: makeView(),
    language: 'en',
    turn: 1,
  });
  assertIncludes(summary.text, ['Tool-call dashboard · Turn 1', 'Completed', '750ms']);
  assertNoMissingKeys(summary.translate);
});
