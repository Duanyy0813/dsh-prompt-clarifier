// 模拟浏览器 __ModuleLoader__ + 迷你 React（hooks 按组件隔离、deps 浅比、
// effect 先 cleanup 再跑；并模拟真实 React 的“hook 只能在渲染期调用”纪律）。
// 单挂载点弹窗版：按钮 + 弹窗都在 conversation.input.right 内。
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}
let hooks = [];
let idx = 0;
let effects = [];
const runEffectsFor = (fn, slotsAll) => {
  const pending = effects;
  effects = [];
  let slots = slotsAll.get(fn);
  if (slots === undefined) { slots = new Map(); slotsAll.set(fn, slots); }
  for (const { i, fn: body, deps } of pending) {
    let slot = slots.get(i);
    if (slot === undefined) { slot = { init: false }; slots.set(i, slot); }
    if (!slot.init || !sameDeps(slot.deps, deps)) {
      if (typeof slot.cleanup === 'function') { try { slot.cleanup(); } catch { /* ignore */ } }
      slot.cleanup = body();
      slot.deps = deps;
      slot.init = true;
    }
  }
};
const FakeReact = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  memo: (f) => f,
  Fragment: 'fragment',
  useState: (init) => {
    const i = idx++;
    hooks[i] ??= [typeof init === 'function' ? init() : init];
    const slot = hooks[i];
    return [slot[0], (v) => { slot[0] = typeof v === 'function' ? v(slot[0]) : v; }];
  },
  useRef: (init) => {
    const i = idx++;
    hooks[i] ??= [{ current: init }];
    return hooks[i][0];
  },
  useCallback: (f, deps) => {
    const i = idx++;
    const slot = hooks[i] ??= { init: false };
    if (!slot.init || !sameDeps(slot.deps, deps)) { slot.fn = f; slot.deps = deps; slot.init = true; }
    return slot.fn;
  },
  useMemo: (f, deps) => {
    const i = idx++;
    const slot = hooks[i] ??= { init: false };
    if (!slot.init || !sameDeps(slot.deps, deps)) { slot.val = f(); slot.deps = deps; slot.init = true; }
    return slot.val;
  },
  useEffect: (fn, deps) => { effects.push({ i: idx++, fn, deps }); },
};

let registered = null;
globalThis.window = { __ModuleLoader__: { load(m) { registered = m; } } };
let domText = '原始：改个按钮颜色';
// 组合输入（IME）事件注册表：让组件能挂 compositionstart/end 监听。
const docListeners = new Map();
const addDocListener = (type, fn) => { if (!docListeners.has(type)) docListeners.set(type, new Set()); docListeners.get(type).add(fn); };
const removeDocListener = (type, fn) => { docListeners.get(type)?.delete(fn); };
const dispatchDocument = (type) => { for (const fn of docListeners.get(type) ?? []) fn({ type }); };
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  querySelectorAll: (sel) => (sel === '[contenteditable="true"]' ? [{ textContent: domText }] : []),
  addEventListener: addDocListener,
  removeEventListener: removeDocListener,
  dispatchEvent: () => true,
};
new Function('window', 'require', 'document', src)(
  globalThis.window,
  (id) => { if (id !== 'react') throw new Error('unexpected require ' + id); return FakeReact; },
  globalThis.document,
);
console.log('module id:', registered.id);

const ctx = {
  slots: {
    byName: {},
    register(opts, Comp) { this.byName[opts.name] = { Comp, opts }; return () => {}; },
    inject(name, cb) { console.log('slots.inject ->', name); cb.call(ctx, ctx); },
  },
};
registered.factory((id) => { if (id === 'react') return FakeReact; throw new Error(id); }).apply(ctx);
console.log('registered slots:', Object.keys(ctx.slots.byName).join(' , '));

// 渲染期纪律：hook 只能在渲染中调用（事件回调里调用会抛 Invalid hook call）。
let renderDepth = 0;
function renderNode(node) {
  if (Array.isArray(node)) return node.map(renderNode);
  if (node && typeof node === 'object') {
    if (typeof node.type === 'function') {
      const savedHooks = hooks, savedIdx = idx, savedEffects = effects;
      hooks = []; idx = 0; effects = [];
      renderDepth++;
      let out;
      try { out = renderNode(node.type(node.props)); } finally {
        renderDepth--;
        hooks = savedHooks; idx = savedIdx; effects = savedEffects;
      }
      return out;
    }
    return { ...node, kids: node.kids.map(renderNode) };
  }
  return node;
}

function makeEnv(setDraftImpl, sessionKey, initialSelection, opts = {}) {
  let draft = '原始：改个按钮颜色';
  // 宿主的普通消息提交不会移动 input.phase（恒为 plain），所以按钮是否亮「优化中」
  // 由 Host 的 pending 回答（CASE16）；phase 保留在快照里只为贴近真实 props 形状。
  let phase = opts.phase ?? 'plain';
  // 默认模拟“右侧选择器已选中 q/qmodel”；传 null 模拟“没有选中可用模型”；
  // 传 'no-projection' 模拟宿主没提供该投影（老版本）→ 客户端回退让 Host 决定。
  let selection = initialSelection === undefined
    ? { lastUsed: { provider: 'q', model: 'qmodel' }, next: { provider: 'q', model: 'qmodel' } }
    : initialSelection;
  const inputActions = {
    setDraft: (t) => {
      const r = setDraftImpl(t, (v) => { draft = v; domText = v; }, () => draft);
      if (typeof r === 'string') { draft = r; domText = r; }
      return r;
    },
  };
  const props = {
    useInput: (sel) => {
      if (renderDepth === 0) throw new Error('Invalid hook call: useInput() called outside of render');
      return sel(phase === undefined ? { draft } : { draft, phase });
    },
    // 宿主真实钩子：useProjection(key) 在渲染期返回该会话投影的 wire view。
    useProjection: (key) => {
      if (renderDepth === 0) throw new Error('Invalid hook call: useProjection() called outside of render');
      return key === 'modelSelection' && selection !== 'no-projection' ? selection : undefined;
    },
    inputActions,
    sessionId: sessionKey,
  };
  const effectSlots = new Map();
  let rootHooks = [];
  function render() {
    const entry = ctx.slots.byName['conversation.input.right'];
    if (entry === undefined) throw new Error('trigger slot not registered');
    hooks = rootHooks; idx = 0; effects = [];
    renderDepth++;
    let tree;
    try { tree = renderNode(entry.Comp(props)); } finally { renderDepth--; }
    runEffectsFor(entry.Comp, effectSlots);
    return tree;
  }
  return {
    get draft() { return draft; },
    setDraft(v) { draft = v; },
    get selection() { return selection; },
    setSelection(next) { selection = next; },
    get phase() { return phase; },
    setPhase(next) { phase = next; },
    render,
  };
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  for (const kid of node.kids ?? []) findAll(kid, pred, out);
  return out;
}
const byText = (text) => (n) => n.type === 'button' && visibleText(n).includes(text);
// 胶囊按钮的可见文案被压短（提示词优化·自动/提示词优化·关闭/提示词优化+圆点），按 data 钩子找按钮更稳。
const byTrigger = (n) => n.type === 'button' && n.props && n.props['data-prompt-clarifier'] === 'trigger';
// 可见文本：跳过 aria-hidden 的等宽占位副本。
function visibleText(node) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (node.props && node.props["aria-hidden"] === true) return "";
  let out = "";
  for (const kid of node.kids ?? []) out += visibleText(kid);
  return out;
}

function allText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  let out = '';
  for (const kid of node.kids ?? []) out += allText(kid) + ' ';
  return out;
}

let fetchCalls = [];
const optimizeCalls = (from) => fetchCalls.slice(from).filter((c) => c && c.body && c.body.action === "optimize");
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
  return {
    ok: true,
    json: async () => ({
      status: 'ok',
      optimized: '把登录页提交按钮的底色从 #3b82f6 换成品牌蓝 #247bbf',
      needs_clarification: true,
      questions: [{ id: 'q1', question: '改哪个按钮？', options: [{ label: '提交按钮' }, { label: '取消按钮' }] }],
      notes: '',
    }),
  };
};

async function openPopup(env) {
  const tree = env.render();
  const btn = findAll(tree, byTrigger)[0];
  if (!btn) throw new Error('trigger button not rendered');
  btn.props.onClick();               // 事件回调：必须在渲染期之外
  await new Promise((r) => setTimeout(r, 10));
  return env.render();
}

// ==== 0) 单一挂载点 + 弹窗定位性质 ====
{
  const names = Object.keys(ctx.slots.byName);
  console.log('CASE0 mounts:', names.join(','));
  console.assert(names.length === 1 && names[0] === 'conversation.input.right', 'CASE0 FAIL — must be a single input.right mount');
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's0');
  const idle = env.render();
  const popupsIdle = findAll(idle, (n) => n.props && n.props.style && n.props.style.position === 'absolute');
  console.log('CASE0 idle popups:', popupsIdle.length);
  console.assert(popupsIdle.length === 0, 'CASE0 FAIL — nothing may float when idle');
  // 可见文案：按钮 = 「优化·自动」，默认开启；aria/title 由同一组 key 驱动。
  const idleBtn = findAll(idle, (n) => n.type === 'button' && n.props && n.props['data-prompt-clarifier'] === 'trigger')[0];
  const idleText = visibleText(idleBtn).trim();
  console.log('CASE0 button label:', JSON.stringify(idleText), '| pressed:', idleBtn.props['aria-pressed'], '| title:', JSON.stringify(String(idleBtn.props.title).slice(0, 18)));
  console.assert(idleText === '提示词优化·自动', 'CASE0 FAIL — default label must be 提示词优化·自动, got ' + idleText);
  console.assert(idleBtn.props['aria-pressed'] === 'true', 'CASE0 FAIL — auto mode must default to ON');
  // 悬停提示：只显示「名称 + 状态」，不留长说明。
  const title0 = String(idleBtn.props.title);
  console.assert(title0 === '提示词优化（开启）', 'CASE0 FAIL — tooltip must be name + state, got ' + title0);
  console.assert(title0.length <= 20 && !title0.includes('右键') && !title0.includes('发送消息'), 'CASE0 FAIL — tooltip must not carry the long explanation');
  // 内部标识保持不变（只动文案与交互，不改 hook 属性）。
  console.assert(idleBtn.props['data-prompt-clarifier'] === 'trigger', 'CASE0 FAIL — internal hook attribute must stay unchanged');
  await openPopup(env);
  const tree = env.render();
  const popup = findAll(tree, (n) => n.props && n.props['data-prompt-clarifier'] === 'panel')[0];
  const st = popup && popup.props.style;
  console.log('CASE0 popup anchor:', st && st.position, '|', st && st.bottom, '| zIndex:', st && st.zIndex, '| maxHeight:', st && String(st.maxHeight));
  console.assert(st && st.position === 'absolute', 'CASE0 FAIL — popup must be absolute (no layout height)');
  console.assert(st && typeof st.bottom === 'string' && st.bottom.includes('100%'), 'CASE0 FAIL — popup must open above the button');
  console.assert(st && st.maxHeight !== undefined, 'CASE0 FAIL — popup must cap its height');
  console.assert(popup.props.role === 'dialog', 'CASE0 FAIL — popup should be a dialog');
  // 弹窗必须是 button 的兄弟节点，不能嵌在 button 里（非法 HTML）。
  const btnEl = findAll(tree, byTrigger)[0];
  console.assert(!allText(btnEl).includes('建议的优化版本'), 'CASE0 FAIL — popup must not be inside the button');
  console.assert(tree.props.style.position === 'relative', 'CASE0 FAIL — wrapper must be the positioning context');
}

// ==== 1) 点击发请求 + 正常写回 ====
{
  domText = '原始：改个按钮颜色';
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's1');
  const before = fetchCalls.length;
  const tree = await openPopup(env);
  const called = optimizeCalls(before);
  console.log('CASE1 click dispatched:', called.length === 1, '| text:', JSON.stringify(called[0]?.body?.text));
  console.assert(called.length === 1 && called[0].url === '/api/prompt-clarifier', 'CASE1 FAIL — click must POST once');
  console.assert(called[0]?.body?.text === '原始：改个按钮颜色', 'CASE1 FAIL — must send live draft');
  const replace = findAll(tree, byText('替换草稿'))[0];
  console.assert(!!replace, 'CASE1 FAIL — replace button missing');
  replace.props.onClick();
  await new Promise((r) => setTimeout(r, 20));
  env.render();
  const t2 = allText(env.render());
  console.log('CASE1 draft:', JSON.stringify(env.draft), '| receipt:', t2.includes('已写回输入框'));
  console.assert(env.draft.includes('品牌蓝'), 'CASE1 FAIL draft not updated');
  console.assert(t2.includes('已写回输入框'), 'CASE1 FAIL no receipt');
}

// ==== 2) setDraft 抛错 → 可见失败弹窗 ====
{
  domText = '原始：改个按钮颜色';
  const env = makeEnv(() => { throw new Error('editor locked'); }, 's2');
  const tree = await openPopup(env);
  findAll(tree, byText('替换草稿'))[0].props.onClick();
  await new Promise((r) => setTimeout(r, 20));
  const t = allText(env.render());
  console.log('CASE2 failure popup:', t.includes('写回输入框失败'), '| textarea:', findAll(env.render(), (n) => n.type === 'textarea').length);
  console.assert(t.includes('写回输入框失败'), 'CASE2 FAIL');
}

// ==== 3) setDraft 被吞 → 读回校验兜出失败 ====
{
  domText = '原始：改个按钮颜色';
  const env = makeEnv(() => undefined, 's3');
  const tree = await openPopup(env);
  findAll(tree, byText('替换草稿'))[0].props.onClick();
  env.render();
  await new Promise((r) => setTimeout(r, 900));
  const t = allText(env.render());
  console.log('CASE3 swallowed -> popup:', t.includes('写回输入框失败'), '| clipboard:', t.includes('剪贴板'));
  console.assert(t.includes('写回输入框失败'), 'CASE3 FAIL — read-back must catch swallowed write');
}

// ==== 4) prop 滞后但 DOM 已是目标 → 判成功 ====
{
  domText = '原始：改个按钮颜色';
  const env = makeEnv((t) => { domText = t; return undefined; }, 's4');
  const tree = await openPopup(env);
  findAll(tree, byText('替换草稿'))[0].props.onClick();
  env.render();
  await new Promise((r) => setTimeout(r, 900));
  const t = allText(env.render());
  console.log('CASE4 stale-prop -> receipt:', t.includes('已写回输入框'), '| no false failure:', !t.includes('写回输入框失败'));
  console.assert(t.includes('已写回输入框'), 'CASE4 FAIL — DOM read-back must count as success');
}

// ==== 5) 渐变 CSS：幂等 + 约束（独立模块实例）====
{
  let reg2 = null;
  const headNodes = [];
  const richDoc = {
    documentElement: { lang: 'zh-CN' },
    head: { appendChild: (n) => headNodes.push(n) },
    getElementById: (id) => headNodes.find((n) => n.id === id) ?? null,
    createElement: (tag) => ({ tag, id: '', textContent: '' }),
    querySelectorAll: () => [],
  };
  new Function('window', 'require', 'document', src)(
    { __ModuleLoader__: { load(m) { reg2 = m; } } },
    (id) => (id === 'react' ? FakeReact : (() => { throw new Error(id); })()),
    richDoc,
  );
  const ctx2 = { slots: { register() { return () => {}; }, inject(name, cb) { cb.call(ctx2, ctx2); } } };
  const f = () => reg2.factory((id) => (id === 'react' ? FakeReact : (() => { throw new Error(id); })()));
  f().apply(ctx2); f().apply(ctx2);
  const styles = headNodes.filter((n) => n.tag === 'style');
  const css = styles[0]?.textContent ?? '';
  console.log('CASE5 style nodes:', styles.length, '| gradient:', /background-image:linear-gradient/.test(css));
  console.assert(styles.length === 1, 'CASE5 FAIL — CSS injected exactly once');
  console.assert(/background-image:linear-gradient/.test(css), 'CASE5 FAIL — must use background-image');
  console.assert(css.includes('background-size:') && css.includes(':hover') && css.includes('prefers-reduced-motion'), 'CASE5 FAIL — animated states required');

  // 5b) 蓝色为主的多色渐变 + 缓慢流动 + 不碰尺寸/布局
  const grad = css.match(/background-image:linear-gradient\(([^;]+)\)/)[1];
  const stops = [...grad.matchAll(/#([0-9a-fA-F]{6})\s+([\d.]+)%/g)]
    .map(([, hex]) => ({ r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), hex }));
  const isBlue = (c) => c.b > c.r + 24 && c.b > c.g + 12;
  const blueCount = stops.filter(isBlue).length;
  console.log('CASE5b stops:', stops.length, '| blue-dominant:', blueCount, '| first:', stops[0]?.hex, '| distinct hues:', new Set(stops.map((c) => c.hex)).size);
  console.assert(stops.length >= 6, 'CASE5b FAIL — need several colour stops for the 炫彩 look');
  console.assert(new Set(stops.map((c) => c.hex)).size >= 6, 'CASE5b FAIL — stops must actually differ (multi-colour)');
  console.assert(blueCount / stops.length >= 0.75, 'CASE5b FAIL — gradient must be blue-dominant');
  console.assert(isBlue(stops[0]), 'CASE5b FAIL — first stop must be blue');
  console.assert(stops[0].hex === stops[stops.length - 1].hex, 'CASE5b FAIL — first/last stop must match for a seamless loop');

  const anim = css.match(/animation:dsh-pc-flow ([0-9.]+)s ([a-z-]+) (infinite)/);
  console.log('CASE5b animation:', anim ? `${anim[1]}s ${anim[2]} ${anim[3]}` : 'MISSING');
  console.assert(anim && anim[3] === 'infinite', 'CASE5b FAIL — must loop forever');
  console.assert(anim && Number(anim[1]) >= 10, 'CASE5b FAIL — flow must be slow (>=10s)');
  console.assert(/@keyframes dsh-pc-flow\{/.test(css), 'CASE5b FAIL — CSS keyframes must drive it (no JS timer)');
  // 只改视觉：触发按钮的规则里不得出现尺寸/布局属性。
  const rule = css.match(/\[data-prompt-clarifier="trigger"\]\{([^}]*)\}/)[1];
  const banned = ['width:', 'height:', 'min-width:', 'min-height:', 'padding:', 'margin:', 'position:', 'display:', 'font-size:', 'line-height:', 'inset:'];
  const hit = banned.filter((p) => rule.includes(p));
  console.log('CASE5b layout props leaked into trigger rule:', hit.length ? hit.join(',') : 'none');
  console.assert(hit.length === 0, 'CASE5b FAIL — button size/layout must stay untouched');

  // 5c) OFF 态必须置灰：有 [data-auto-mode="off"] 规则、色标中性灰、停掉流动动画
  const offBlock = css.match(/\[data-prompt-clarifier="trigger"\]\[data-auto-mode="off"\]\{([^}]*)\}/);
  console.assert(offBlock !== null, 'CASE5c FAIL — an OFF-state rule keyed on data-auto-mode is required');
  const offRule = offBlock[1];
  const offGrad = offRule.match(/background-image:linear-gradient\(([^;]+)\)/)[1];
  const offStops = [...offGrad.matchAll(/#([0-9a-fA-F]{6})/g)]
    .map(([, hex]) => ({ r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), hex }));
  const isGray = (c) => Math.abs(c.r - c.g) <= 10 && Math.abs(c.g - c.b) <= 12 && Math.abs(c.r - c.b) <= 14;
  const grayCount = offStops.filter(isGray).length;
  console.log('CASE5c OFF stops:', offStops.map((c) => c.hex).join(','), '| neutral-gray:', grayCount, '/', offStops.length, '| animation off:', offRule.includes('animation:none'));
  console.assert(offStops.length >= 2, 'CASE5c FAIL — OFF needs its own gradient stops');
  console.assert(grayCount === offStops.length, 'CASE5c FAIL — every OFF stop must be a neutral gray');
  console.assert(offRule.includes('animation:none'), 'CASE5c FAIL — OFF must stop the flowing animation');
  // AUTO 规则不能被 OFF 规则污染：仍必须是蓝色主导。
  console.assert(blueCount / stops.length >= 0.75, 'CASE5c FAIL — AUTO palette must stay blue');
}

// ==== 6) 弹层材质必须对齐宿主「模型选择器」弹层的配方 ====
{
  domText = '原始：改个按钮颜色';
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's6');
  await openPopup(env);
  const tree = env.render();
  // pending/review 之类可能同时存在，但只能有一个弹层容器。
  const surfaces = findAll(tree, (n) => n.props && n.props['data-prompt-clarifier'] === 'panel');
  console.log('CASE6 popup surfaces:', surfaces.length);
  console.assert(surfaces.length === 1, 'CASE6 FAIL — must render exactly one popup surface (stacked panels cause the overlap)');
  const st = surfaces[0].props.style;
  // 宿主配方：specific-menu + menu-backdrop-filter + elevation-prominent
  //          + stroke 描边色 border-l1 + radius-lg + z-index 1100 + border:0
  const hostRecipe = {
    background: 'var(--dsw-specific-menu',
    backdropFilter: 'var(--dsw-menu-backdrop-filter',
    boxShadow: 'var(--dsw-elevation-prominent',
    strokeColor: 'var(--dsw-alias-border-l1',
    radius: 'var(--dsw-radius-lg',
  };
  console.log('CASE6 material:', JSON.stringify({
    bg: String(st.background).slice(0, 26), blur: String(st.backdropFilter).slice(0, 30),
    shadow: String(st.boxShadow).slice(0, 30), radius: String(st.borderRadius).slice(0, 22),
    z: st.zIndex, border: st.border,
  }));
  console.assert(String(st.background).startsWith(hostRecipe.background), 'CASE6 FAIL — surface must use --dsw-specific-menu');
  console.assert(String(st.backdropFilter).startsWith(hostRecipe.backdropFilter), 'CASE6 FAIL — must carry the host menu blur');
  console.assert(String(st.boxShadow).startsWith(hostRecipe.boxShadow), 'CASE6 FAIL — must use --dsw-elevation-prominent');
  console.assert(st['--dsw-elevation-stroke-color'] && String(st['--dsw-elevation-stroke-color']).startsWith(hostRecipe.strokeColor), 'CASE6 FAIL — stroke color must be border-l1');
  console.assert(String(st.borderRadius).startsWith(hostRecipe.radius), 'CASE6 FAIL — radius must be --dsw-radius-lg');
  console.assert(st.zIndex === 1100, 'CASE6 FAIL — z-index must match host menus (1100)');
  console.assert(st.border === 0, 'CASE6 FAIL — host menus use border:0 (edge comes from the stroke shadow)');
  console.assert(st.position === 'absolute' && String(st.bottom).includes('100%'), 'CASE6 FAIL — must still float above the button');
  // 内层区块不得再叠第二层底（宿主的 option 行是 transparent）。
  const cards = findAll(tree, (n) => n.props && n.props.style && n.props.style.border === 0 && n.props.style.background === 'transparent');
  console.log('CASE6 transparent inner sections:', cards.length);
  console.assert(cards.length >= 1, 'CASE6 FAIL — inner sections should be transparent like host menu rows');
}

// ==== 7) 触发按钮的标志必须是 DeepSeek 鲸鱼（照抄 primitives 的 FishLogo）====
{
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's7');
  const idle = env.render();
  const svgs = findAll(idle, (n) => n.type === 'svg');
  const whale = svgs.find((s) => s.props.viewBox === '0 0 23.16 17.04');
  console.log('CASE7 idle svgs:', svgs.length, '| whale:', !!whale);
  console.assert(!!whale, 'CASE7 FAIL — trigger must render the whale svg (viewBox 0 0 23.16 17.04)');
  const st = whale.props.style || {};
  console.log('CASE7 size:', whale.props.width, 'x', String(whale.props.height).slice(0, 6),
    '| fill:', whale.props.fill, '| aria-hidden:', whale.props['aria-hidden'], '| flex:', st.flex);
  console.assert(whale.props.width === 14, 'CASE7 FAIL — whale width should be 14');
  console.assert(Math.abs(whale.props.height - 14 * 17.04 / 23.16) < 1e-9, 'CASE7 FAIL — height must follow the host aspect ratio');
  console.assert(whale.props.fill === 'none' && whale.props['aria-hidden'] === true, 'CASE7 FAIL — host markup is fill=none + aria-hidden');
  console.assert(st.flex === '0 0 auto', 'CASE7 FAIL — icon must not shrink inside the pill');
  const path = findAll(whale, (n) => n.type === 'path')[0];
  const d = String(path && path.props.d);
  console.log('CASE7 path:', d.slice(0, 26), '| len:', d.length, '| fill:', path && path.props.fill);
  console.assert(d.startsWith('M22.9168'), 'CASE7 FAIL — must be the real DeepSeek whale path');
  console.assert(d.length > 3000, 'CASE7 FAIL — whale path truncated');
  console.assert(path && path.props.fill === 'currentColor', 'CASE7 FAIL — whale must inherit button color (#fff on gradient)');
  // 忙碌态保留既有旋转进度指示，不出鲸鱼。
  findAll(idle, byTrigger)[0].props.onClick();
  const busyTree = env.render();
  const busyWhale = findAll(busyTree, (n) => n.type === 'svg' && n.props.viewBox === '0 0 23.16 17.04').length;
  console.log('CASE7 busy whale count:', busyWhale);
  console.assert(busyWhale === 0, 'CASE7 FAIL — busy keeps the spinner, not the whale');
  await new Promise((r) => setTimeout(r, 10));
}

// ==== 8) 用右侧模型选择器“此刻选中的模型”，且不改动选择器状态 ====
{
  // a) 默认选中 q/qmodel → 请求必须带上它
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's8a');
  let before = fetchCalls.length;
  await openPopup(env);
  let body = optimizeCalls(before)[0]?.body;
  console.log('CASE8a payload route:', body && body.provider, '/', body && body.model);
  console.assert(body && body.provider === 'q' && body.model === 'qmodel', 'CASE8a FAIL — must send the selected model');

  // b) 改选成 p/m 后再次点击 → 用新的（实时读取，不是缓存的旧值）
  env.setSelection({ lastUsed: { provider: 'q', model: 'qmodel' }, next: { provider: 'p', model: 'm' } });
  before = fetchCalls.length;
  findAll(env.render(), byTrigger)[0].props.onClick();
  await new Promise((r) => setTimeout(r, 10));
  body = optimizeCalls(before)[0]?.body;
  console.log('CASE8b payload route after switch:', body && body.provider, '/', body && body.model);
  console.assert(body && body.provider === 'p' && body.model === 'm', 'CASE8b FAIL — must re-read the selection on every click');

  // c) 选择器里没有可用模型 → 提示先选，且**不发请求**
  const empty = makeEnv((t, commit) => { commit(t); return t; }, 's8c', { lastUsed: null, next: null });
  before = fetchCalls.length;
  const tree = empty.render();
  findAll(tree, byTrigger)[0].props.onClick();
  await new Promise((r) => setTimeout(r, 10));
  const shown = allText(empty.render());
  console.log('CASE8c requests:', fetchCalls.length - before, '| prompt shown:', shown.includes('请先在右侧模型选择器里选一个模型'));
  console.assert(optimizeCalls(before).length === 0, 'CASE8c FAIL — must not call the API without a model');
  console.assert(shown.includes('请先在右侧模型选择器里选一个模型'), 'CASE8c FAIL — must prompt the user to pick a model');

  // d) 宿主没提供该投影（老版本）→ 不猜，交给 Host 回退路由
  const legacy = makeEnv((t, commit) => { commit(t); return t; }, 's8d', 'no-projection');
  before = fetchCalls.length;
  await openPopup(legacy);
  body = optimizeCalls(before)[0]?.body;
  console.log('CASE8d legacy payload route:', body && body.provider, '| has provider key:', !!(body && 'provider' in body));
  console.assert(body && !('provider' in body), 'CASE8d FAIL — without the projection, leave routing to the Host');

  // e) 我们从不调用 selectModel（选择器自身的显示/选中状态不得被改动）
  console.log('CASE8e selectModel calls:', typeof globalThis.__selectModelCalls === 'object' ? globalThis.__selectModelCalls.length : 0);
  console.assert(!globalThis.__selectModelCalls || globalThis.__selectModelCalls.length === 0, 'CASE8e FAIL — plugin must not change the selection');
}

// ==== 9) 自动模式开关：可开启/关闭，并把状态同步给 Host ====
{
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's9');
  const findTrig = (tree) => findAll(tree, (n) => n.type === 'button' && n.props && n.props['data-prompt-clarifier'] === 'trigger')[0];
  const trigText = (node) => visibleText(node).trim();
  let tree = env.render();
  let trig = findTrig(tree);
  console.log('CASE9a default:', JSON.stringify(trigText(trig)), '| pressed:', trig.props['aria-pressed'], '| auto-mode attr:', trig.props['data-auto-mode']);
  console.assert(trigText(trig) === '提示词优化·自动', 'CASE9a FAIL — default label must be 提示词优化·自动');
  console.assert(trig.props['aria-pressed'] === 'true', 'CASE9a FAIL — default must be ON');
  console.assert(trig.props['data-auto-mode'] === 'on', 'CASE9a FAIL — data attribute must say on');
  // 独立的开关按钮已取消
  console.assert(!findAll(tree, (n) => n.props && n.props['data-prompt-clarifier'] === 'auto-toggle')[0], 'CASE9a FAIL — the separate toggle must be gone');

  // 等宽占位：两种文案叠在同一网格单元，AUTO 的不可见副本常驻以占住最宽的宽度，
  // 所以 OFF 状态下按钮宽度也不会缩水。
  const sizer = findAll(trig, (n) => n.props && n.props['data-prompt-clarifier'] === 'label-sizer')[0];
  const slot = sizer && sizer.props.style;
  const items = findAll(trig, (n) => n.props && n.props.style && n.props.style.gridArea === '1 / 1');
  console.log('CASE9a sizer:', sizer && JSON.stringify(allText(sizer).trim()), '| hidden:', sizer && sizer.props.style.visibility, '| grid items sharing one cell:', items.length);
  console.assert(!!sizer, 'CASE9a FAIL — a hidden width reservation copy is required');
  console.assert(sizer.props.style.visibility === 'hidden' && sizer.props['aria-hidden'] === true, 'CASE9a FAIL — the reservation copy must be invisible to users and AT');
  console.assert(allText(sizer).trim() === '提示词优化·自动', 'CASE9a FAIL — the reservation copy must be the widest (AUTO) variant');
  console.assert(items.length === 2, 'CASE9a FAIL — both labels must occupy the same grid cell so width = max of them');

  // 左键 = 立即分析（与手动调用一致），且不改模式
  let before = fetchCalls.length;
  trig.props.onClick();
  await new Promise((r) => setTimeout(r, 10));
  tree = env.render();
  trig = findTrig(tree);
  let posts = fetchCalls.slice(before).filter((c) => c.body && c.body.action === 'setAuto');
  let optimized = optimizeCalls(before);
  console.log('CASE9b left-click -> optimize:', optimized.length, '| setAuto:', posts.length, '| label:', JSON.stringify(trigText(trig)));
  console.assert(optimized.length === 1, 'CASE9b FAIL — left click must open the panel (run the analysis)');
  console.assert(posts.length === 0, 'CASE9b FAIL — left click must not toggle AUTO/OFF');
  console.assert(trigText(trig) === '提示词优化·自动', 'CASE9b FAIL — mode must stay AUTO after a left click');

  // 右键 = 切换 AUTO → OFF，并吃掉浏览器右键菜单
  before = fetchCalls.length;
  let prevented = false;
  trig.props.onContextMenu({ preventDefault: () => { prevented = true; } });
  await new Promise((r) => setTimeout(r, 10));
  tree = env.render();
  trig = findTrig(tree);
  posts = fetchCalls.slice(before).filter((c) => c.body && c.body.action === 'setAuto');
  optimized = optimizeCalls(before);
  console.log('CASE9c right-click -> label:', JSON.stringify(trigText(trig)), '| setAuto:', JSON.stringify(posts[0]?.body), '| prevented:', prevented, '| optimize:', optimized.length);
  console.assert(prevented === true, 'CASE9c FAIL — must suppress the native context menu');
  console.assert(posts.length === 1 && posts[0].body.enabled === false, 'CASE9c FAIL — right click must switch the Host to OFF');
  console.assert(trigText(trig) === '提示词优化·关闭', 'CASE9c FAIL — off label must be 提示词优化·关闭');
  console.assert(trig.props['aria-pressed'] === 'false' && trig.props['data-auto-mode'] === 'off', 'CASE9c FAIL — state must flip to off');
  console.log('CASE9c tooltip:', JSON.stringify(trig.props.title));
  console.assert(String(trig.props.title) === '提示词优化（关闭）', 'CASE9c FAIL — OFF tooltip must be name + 关闭');
  console.assert(optimized.length === 0, 'CASE9c FAIL — right click must not run analysis');

  // 再右键一次 = 切回 AUTO
  before = fetchCalls.length;
  trig.props.onContextMenu({ preventDefault: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  tree = env.render();
  trig = findTrig(tree);
  posts = fetchCalls.slice(before).filter((c) => c.body && c.body.action === 'setAuto');
  console.log('CASE9d right-click again -> label:', JSON.stringify(trigText(trig)), '| setAuto:', JSON.stringify(posts[0]?.body));
  console.assert(posts.length === 1 && posts[0].body.enabled === true, 'CASE9d FAIL — right click must switch back to AUTO');
  console.assert(trigText(trig) === '提示词优化·自动', 'CASE9d FAIL — on label must come back');
}

// ==== 10) Host 报“空输出”时给出可操作的提示（与“解析失败”区分）====
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.action === 'optimize') {
      return { ok: true, json: async () => ({ status: 'failed', reason: 'empty-model-output', timing: { outChars: 0, attempt: 2 } }) };
    }
    return prevFetch(url, init);
  };
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's10');
  const tree = env.render();
  findAll(tree, byTrigger)[0].props.onClick();
  await new Promise((r) => setTimeout(r, 10));
  const shown = allText(env.render());
  globalThis.fetch = prevFetch;
  console.log('CASE10 empty-output hint:', shown.includes('没有返回内容'));
  console.assert(shown.includes('没有返回内容'), 'CASE10 FAIL — empty output must surface an actionable hint');
  console.assert(!shown.includes('无法解析'), 'CASE10 FAIL — must not mislabel empty output as a parse error');
}

// ==== 11a) AUTO 且有追问：取回结果并弹面板（行为不变）====
{
  const prevFetch = globalThis.fetch;
  const autoReview = {
    status: 'ok', optimized: '自动改写后的稿子', needsClarification: true,
    questions: [{ id: 'q1', question: '改哪个按钮？', options: [{ label: '提交按钮' }] }], notes: '',
  };
  const startedAt = Date.now();
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.action === 'latestAuto') {
      const ready = Date.now() - startedAt > 1000;
      return { ok: true, json: async () => (ready ? { review: autoReview, at: Date.now() } : { review: null }) };
    }
    return prevFetch(url, init);
  };
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's11a');
  env.setDraft('改个按钮颜色');
  env.render();
  env.setDraft('');
  env.render();
  await new Promise((r) => setTimeout(r, 3200));
  const tree = env.render();
  globalThis.fetch = prevFetch;
  const ta = findAll(tree, (n) => n.type === 'textarea' && typeof n.props.value === 'string')[0];
  const shown = allText(tree);
  console.log('CASE11a panel:', !!findAll(tree, (n) => n.props && n.props['data-prompt-clarifier'] === 'panel')[0],
    '| refined text:', !!ta && ta.props.value.includes('自动改写后的稿子'),
    '| has question:', shown.includes('改哪个按钮？'));
  console.assert(!!findAll(tree, (n) => n.props && n.props['data-prompt-clarifier'] === 'panel')[0], 'CASE11a FAIL — with questions the panel must pop');
  console.assert(!!ta && ta.props.value.includes('自动改写后的稿子'), 'CASE11a FAIL — panel must show the refined draft');
  console.assert(shown.includes('改哪个按钮？'), 'CASE11a FAIL — clarification questions must render');
}

// ==== 11b) AUTO 且无需追问：不得再弹额外框（避免与注入结果重复）====
{
  const prevFetch = globalThis.fetch;
  const autoReview = { status: 'ok', optimized: '自动改写后的稿子', needsClarification: false, questions: [], notes: '' };
  const startedAt = Date.now();
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.action === 'latestAuto') {
      const ready = Date.now() - startedAt > 1000;
      return { ok: true, json: async () => (ready ? { review: autoReview, at: Date.now() } : { review: null }) };
    }
    return prevFetch(url, init);
  };
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's11b');
  env.setDraft('把首页标题改成鲸鱼图标');
  env.render();
  env.setDraft('');
  env.render();
  await new Promise((r) => setTimeout(r, 3200));
  const tree = env.render();
  globalThis.fetch = prevFetch;
  const panelCount = findAll(tree, (n) => n.props && n.props['data-prompt-clarifier'] === 'panel').length;
  console.log('CASE11b panels without questions:', panelCount, '| replace btn:', !!findAll(tree, byText('替换草稿'))[0]);
  console.assert(panelCount === 0, 'CASE11b FAIL — must not show a duplicate box when nothing needs clarifying');
  console.assert(!findAll(tree, byText('替换草稿'))[0], 'CASE11b FAIL — no leftover action entry from the removed box');
}

// ==== 12) 优化进行中：按钮切换为「优化中」，结束后恢复 ====
{
  const prevFetch = globalThis.fetch;
  const review = { status: 'ok', optimized: '优化中的改写稿', needsClarification: true, questions: [{ id: 'q', question: '哪个按钮？', options: [] }], notes: '' };
  const startedAt = Date.now();
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.action === 'latestAuto') {
      const ready = Date.now() - startedAt > 1000;
      // 未出结果时 Host 报 pending（它正在分析这段文本）→ 按钮进「优化中」。
      return { ok: true, json: async () => (ready
        ? { review, at: Date.now(), pending: null }
        : { review: null, at: null, pending: { text: '把一个按钮改成蓝色', startedAt } }) };
    }
    return prevFetch(url, init);
  };
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's12');
  const findTrig = (tree) => findAll(tree, (n) => n.type === 'button' && n.props && n.props['data-prompt-clarifier'] === 'trigger')[0];
  env.setDraft('把一个按钮改成蓝色');
  env.render();
  env.setDraft('');
  // 刚发送：还没拿到结果 → 按钮应是「优化中」+ 加载动画 + 禁用
  // （有 300ms 防抖确认 + setOptimizing 在 effect 里，所以要等一拍再多渲染一次）
  env.render();
  await new Promise((r) => setTimeout(r, 900));
  let tree = env.render();
  let trig = findTrig(tree);
  const busyLabel = visibleText(trig).trim();
  const spinner = findAll(trig, (n) => n.type === 'svg' && n.props && String(n.props.style && n.props.style.animation || '').includes('dsh-pc-spin'))[0];
  // 宽度稳定：进行中与常态必须共用同一套等宽槽（同一份 label-sizer）+ 固定图标槽
  const sizerBusy = findAll(trig, (n) => n.props && n.props['data-prompt-clarifier'] === 'label-sizer')[0];
  const iconSlot = findAll(trig, (n) => n.props && n.props.style && n.props.style.width === 14 && n.props.style.flex === '0 0 auto')[0];
  // 极短态用「3 个呼吸圆点」占住右侧余量（宽度恒定、只变透明度），所以必须真的渲染出来。
  const dots = findAll(trig, (n) => n.props && n.props['data-prompt-clarifier'] === 'dots')[0];
  console.log('CASE12a during: label:', JSON.stringify(busyLabel), '| disabled:', trig.props.disabled, '| spinner:', !!spinner,
    '| sizer:', !!sizerBusy, '| icon slot:', !!iconSlot, '| dots:', dots ? dots.kids.length : 0);
  console.assert(busyLabel === '提示词优化', 'CASE12a FAIL — button must read 提示词优化 while optimizing');
  console.assert(trig.props.disabled === true, 'CASE12a FAIL — button must be disabled while optimizing');
  console.assert(!!spinner, 'CASE12a FAIL — a loading spinner is required');
  console.assert(!!dots && dots.kids.length === 3, 'CASE12a FAIL — 3 breathing dots must occupy the idle leftover width');
  console.assert(!!sizerBusy && allText(sizerBusy).trim() === '提示词优化·自动', 'CASE12a FAIL — busy state must keep the same width sizer as idle');
  console.assert(!!iconSlot, 'CASE12a FAIL — the icon must sit in the fixed 14px slot so width cannot shift');
  // 三态等长：AUTO / OFF 文案必须同宽（各 2 字），否则 sizer 保不住宽度就会跳。
  console.assert('提示词优化·自动'.length === '提示词优化·关闭'.length, 'CASE12a FAIL — AUTO/OFF labels must be equal length so the pill width cannot jump');

  // 结果到达后：恢复成 AUTO 标签、可点击
  await new Promise((r) => setTimeout(r, 3200));
  tree = env.render();
  trig = findTrig(tree);
  const restored = visibleText(trig).trim();
  console.log('CASE12b after: label:', JSON.stringify(restored), '| disabled:', trig.props.disabled);
  console.assert(restored === '提示词优化·自动', 'CASE12b FAIL — button must restore after optimization');
  console.assert(trig.props.disabled === false, 'CASE12b FAIL — button must be clickable again');
  globalThis.fetch = prevFetch;
}

// ==== 13) 输入法组合输入期间按 Enter 不得触发优化；组合结束后正常触发 ====
{
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.action === 'latestAuto') {
      // 只有“组合结束后真的发出去的那段文本”在分析中 → 组合期间不会亮按钮。
      const pending = body.text === '修改按钮颜色并加深' ? { text: body.text, startedAt: Date.now() } : null;
      return { ok: true, json: async () => ({ review: null, at: null, pending }) };
    }
    return prevFetch(url, init);
  };
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's13');
  const findTrig = (tree) => findAll(tree, (n) => n.type === 'button' && n.props && n.props['data-prompt-clarifier'] === 'trigger')[0];
  const labelOf = (tree) => {
    const node = findTrig(tree);
    return { text: visibleText(node).trim(), disabled: node.props.disabled };
  };

  // a) 组合输入中：草稿瞬时为空 + 回车确认候选词 → 不得进入“优化中”
  env.setDraft('修改按钮颜色');
  env.render();
  dispatchDocument('compositionstart');
  env.setDraft('');                 // 组合期间草稿瞬时为空
  env.render();
  env.render();
  await new Promise((r) => setTimeout(r, 700));   // 越过 300ms 防抖 + 首轮探询
  let state = labelOf(env.render());
  console.log('CASE13a while composing:', JSON.stringify(state));
  console.assert(state.text !== '提示词优化' && state.disabled !== true, 'CASE13a FAIL — IME composition must not trigger optimizing');
  dispatchDocument('compositionend');

  // b) 组合结束后正常输入并回车 → 正常进入“优化中”
  await new Promise((r) => setTimeout(r, 160));   // 越过 compositionend 的 120ms 缓冲
  env.setDraft('修改按钮颜色并加深');
  env.render();
  env.setDraft('');
  env.render();
  await new Promise((r) => setTimeout(r, 900));
  state = labelOf(env.render());
  console.log('CASE13b after composition ends:', JSON.stringify(state));
  console.assert(state.text === '提示词优化' && state.disabled === true, 'CASE13b FAIL — a real send after composition must enter optimizing');
  globalThis.fetch = prevFetch;
}

// ==== 14) 挂载时按会话查询 Host 状态；Host 说 OFF 就显示 OFF ====
{
  const prevFetch = globalThis.fetch;
  const getUrls = [];
  globalThis.fetch = async (url, init) => {
    if (!init) { getUrls.push(String(url)); return { ok: true, json: async () => ({ ok: true, auto: false, autoConfigured: true, analysisBudgetMs: 60000 }) }; }
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.action === 'setAuto') return { ok: true, json: async () => ({ ok: true, auto: body.enabled }) };
    if (body && body.action === 'latestAuto') return { ok: true, json: async () => ({ review: null }) };
    return prevFetch(url, init);
  };
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's14');
  env.render();
  await new Promise((r) => setTimeout(r, 20));
  const tree = env.render();
  const findTrig = (t) => findAll(t, (n) => n.type === 'button' && n.props && n.props['data-prompt-clarifier'] === 'trigger')[0];
  const trig = findTrig(tree);
  console.log('CASE14 GET urls:', JSON.stringify(getUrls), '| label:', JSON.stringify(visibleText(trig).trim()));
  console.assert(getUrls.some((u) => u.startsWith('/api/prompt-clarifier?sessionId=s14')), 'CASE14 FAIL — mount must query the Host scoped to this session');
  console.assert(visibleText(trig).trim() === '提示词优化·关闭', 'CASE14 FAIL — without a local pref the Host state wins');
  globalThis.fetch = prevFetch;
}

// ==== 15) AUTO 失败/跳过的占位结果：轮询立即收尾，不弹面板，按钮恢复 ====
{
  const prevFetch = globalThis.fetch;
  const startedAt = Date.now();
  let latestCalls = 0;
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.action === 'latestAuto') {
      latestCalls += 1;
      const ready = Date.now() - startedAt > 1000;
      // Host 在失败/跳过时缓存的是 {status, reason, questions:[]}，没有 optimized。
      return { ok: true, json: async () => (ready
        ? { review: { status: 'failed', reason: 'empty-model-output', questions: [] }, at: Date.now() }
        : { review: null }) };
    }
    return prevFetch(url, init);
  };
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's15');
  const findTrig = (t) => findAll(t, (n) => n.type === 'button' && n.props && n.props['data-prompt-clarifier'] === 'trigger')[0];
  env.setDraft('把这段足够长的话发出去触发自动分析');
  env.render();
  env.setDraft('');
  env.render();
  await new Promise((r) => setTimeout(r, 2600));
  const tree = env.render();
  const label = visibleText(findTrig(tree)).trim();
  const panels = findAll(tree, (n) => n.props && n.props['data-prompt-clarifier'] === 'panel').length;
  const callsAfterDone = latestCalls;
  await new Promise((r) => setTimeout(r, 1600));
  console.log('CASE15 label:', JSON.stringify(label), '| panels:', panels, '| latestAuto calls:', callsAfterDone, '->', latestCalls);
  console.assert(label !== '提示词优化', 'CASE15 FAIL — a failed auto result must end the optimizing state');
  console.assert(panels === 0, 'CASE15 FAIL — nothing to clarify means no panel');
  console.assert(latestCalls === callsAfterDone, 'CASE15 FAIL — polling must stop once the placeholder result arrives');
  globalThis.fetch = prevFetch;
}

// ==== 16) 触发时机：「优化中」只由 Host 的 pending 回答 ====
// 线上两次 bug：
//   ① 旧判定把“草稿由非空变空”当成已发送 → 在输入框里打字/回车，按钮就进「优化中」。
//   ② 改成认 input.phase 的 'submitting' → 宿主**从不**为普通消息移动这个 phase
//      （uic-client.js beginDetached：mint an ordinary send that leaves the phase plain），
//      于是按钮再也不亮。
// 现在的契约：草稿清空只发起一次探询；Host 回 pending 才点亮按钮并轮询结果。
{
  const prevFetch = globalThis.fetch;
  const latestCalls = [];
  let pending = null;      // Host 正在分析这段文本
  let review = null;       // 分析已出结果
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (body && body.action === 'latestAuto') {
      latestCalls.push(body.text);
      return { ok: true, json: async () => ({ review, at: review === null ? null : Date.now(), pending }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const env = makeEnv((t, commit) => { commit(t); return t; }, 's16');
  const findTrig = (t) => findAll(t, (n) => n.type === 'button' && n.props && n.props['data-prompt-clarifier'] === 'trigger')[0];
  const labelOf = (t) => visibleText(findTrig(t)).trim();

  // a) 输入阶段：草稿被宿主瞬时清空，但 Host 并没有在分析 → 按钮不得进「优化中」
  env.setDraft('把按钮改成蓝色并加圆角');
  env.render();
  env.setDraft('');
  env.render();
  await new Promise((r) => setTimeout(r, 900));   // 越过 300ms 防抖 + 首轮探询
  const idleLabel = labelOf(env.render());
  console.log('CASE16a typing-only:', JSON.stringify(idleLabel), '| latestAuto calls:', latestCalls.length);
  console.assert(idleLabel !== '提示词优化', 'CASE16a FAIL — clearing the draft without Host pending must not enter optimizing');
  console.assert(latestCalls.length >= 1, 'CASE16a FAIL — the clear must at least probe the Host');
  latestCalls.length = 0;

  // b) 真发送：Host 开始分析这段文本 → 按钮进「优化中」
  pending = { text: '把登录页提交按钮改成蓝色并加圆角，注意暗色模式', startedAt: Date.now() };
  env.setDraft('把登录页提交按钮改成蓝色并加圆角，注意暗色模式');
  env.render();
  env.setDraft('');
  env.render();
  await new Promise((r) => setTimeout(r, 900));
  const busyLabel = labelOf(env.render());
  console.log('CASE16b on submit:', JSON.stringify(busyLabel), '| latestAuto calls:', latestCalls.length);
  console.assert(busyLabel === '提示词优化', 'CASE16b FAIL — Host pending must put the button into optimizing');

  // c) 结果到达 → 按钮复原、轮询停止，且分析的是真正发出的那段文本
  review = { status: 'ok', optimized: '改成蓝色圆角', questions: [], needsClarification: false };
  pending = null;
  await new Promise((r) => setTimeout(r, 1700));
  const doneLabel = labelOf(env.render());
  const callsAfterDone = latestCalls.length;
  await new Promise((r) => setTimeout(r, 1700));
  console.log('CASE16c settled:', JSON.stringify(doneLabel), '| first text:', JSON.stringify(latestCalls[0]), '| calls:', callsAfterDone, '->', latestCalls.length);
  console.assert(doneLabel !== '提示词优化', 'CASE16c FAIL — a settled review must restore the button');
  console.assert(latestCalls[0] === '把登录页提交按钮改成蓝色并加圆角，注意暗色模式', 'CASE16c FAIL — the poll must analyse the text that was actually sent');
  console.assert(latestCalls.length === callsAfterDone, 'CASE16c FAIL — the poll must stop once the review arrived');

  // d) 斜杠命令：Host 不做 AUTO 分析，客户端连探询都不该发
  review = null;
  const before = latestCalls.length;
  env.setDraft('/compact');
  env.render();
  env.setDraft('');
  env.render();
  await new Promise((r) => setTimeout(r, 900));
  const slashLabel = labelOf(env.render());
  console.log('CASE16d slash:', JSON.stringify(slashLabel), '| probes:', latestCalls.length - before);
  console.assert(slashLabel !== '提示词优化', 'CASE16d FAIL — a slash command must not enter optimizing');
  console.assert(latestCalls.length === before, 'CASE16d FAIL — a slash command must not even probe the Host');
  globalThis.fetch = prevFetch;
}console.log('\nCLIENT SMOKE DONE (FAIL 字样若出现即为断言失败)');
