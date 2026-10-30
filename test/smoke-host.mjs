// 模拟 Cordis ctx，验证 dsh-prompt-clarifier 的 Host 半：注册、fail-open、注入。
import { apply, inject } from '../index.js';

const events = new Map();
const tools = [];
const disposers = [];
let listenerRuns = 0;

function fakeChunkText(text) {
  return [
    { type: 'text-delta', text },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

const appendedEvents = [];
const session = {
  id: 'session-smoke',
  // 会话日志写入：提示消息必须走这里才会渲染成对话行。
  append(type, data, opts) { appendedEvents.push({ type, data, opts }); return { type, data }; },
  requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 100 } }),
};
const agent = { id: 'a1', session };

const ctx = {
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
  // Cordis 语义：ctx.inject([keys], cb) 在依赖齐备时以带属性的 ctx 调 cb。
  inject(keys, cb) { cb(ctx); return () => {}; },
  get connection() { return { fetch: { register: (route) => { httpRoute = route; return () => {}; } } }; },
  effect(fn, name) {
    const d = typeof fn === 'function' ? fn() : undefined;
    if (typeof d === 'function') disposers.push([name, d]);
    return () => { if (typeof d === 'function') d(); };
  },
  on(name, listener) {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(listener);
    return () => { events.get(name) = events.get(name).filter((l) => l !== listener); };
  },
  get(key) {
    if (key === 'sessions') return { get: (id) => (id === session.id ? session : undefined) };
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    if (key === 'userQuestions') return {
      async ask(request) { asked.push(request); return { answers: request.questions.map((q) => ({ id: q.id, selected: [q.options?.[0]?.label ?? 'A'] })) }; },
      async askTimed(request, callId, ms) { asked.push({ ...request, callId, ms }); return { answers: request.questions.map((q) => ({ id: q.id, selected: ['是'] })) }; },
    };
    if (key === 'connection') return { fetch: { register: (route) => { httpRoute = route; return () => {}; } } };
    return undefined;
  },
  tools: { register(def) { tools.push(def); return () => {}; } },
  agents: { roots: () => [agent], get: (id) => (id === agent.id ? agent : undefined) },
  sessionProjections: {
    registered: null,
    register(def) { this.registered = def; return () => {}; },
    stateOf(s, key) { return this.registered ? { items: [] } : undefined; },
  },
  llm: {
    lastSystem: null,
    lastRoute: null,
    // 宿主真实 API：列出已注册 provider（插件用它校验客户端送来的路由）。
    listProviders() { return [{ id: 'p' }, { id: 'q' }]; },
    async prepareCall(config, signal) {
      const allowed = { p: ['m'], q: ['qmodel'] };
      if (!allowed[config.provider] || !allowed[config.provider].includes(config.model)) {
        throw new Error('bad route ' + JSON.stringify(config));
      }
      ctx.llm.lastRoute = { provider: config.provider, model: config.model };
      return {
        config,
        stream(options) {
          ctx.llm.lastSystem = options.system;
          if (typeof options.sessionId !== 'string') throw new Error('options.sessionId required');
          return (async function* () {
            for (const c of fakeChunkText(JSON.stringify(pendingReview))) yield c;
          })();
        },
      };
    },
  },
};

let asked = [];
let httpRoute = null;
let pendingReview = { optimized: '请改写后的版本', needs_clarification: false, questions: [], notes: '' };

console.log('inject =', inject);
apply(ctx, undefined);

const preStep = events.get('agent/pre-step')[0];
console.log('listeners:', [...events.keys()], 'tools:', tools.map((t) => t.name), 'httpRoute:', httpRoute?.path);

async function runPreStep(messages, step = 1) {
  let called = false;
  const next = async () => { called = true; return { kind: 'enter', messages, startsRequestSeries: true }; };
  const result = await preStep({ agent, messages, step, turn: 7, signal: new AbortController().signal }, next);
  if (!called && result?.kind === 'enter') throw new Error('listener did not await next()');
  return result;
}

const injectedTexts = (res) => res.messages.filter((m) => m.source?.kind === 'prompt-clarifier').map((m) => m.content[0].text);
const injectedJoined = (res) => injectedTexts(res).join('\n\n');
// 主对话可见的提示走 command/run + command/done（工具卡片行，直播/刷新都稳定显示、零 token），
// 与"只进本轮请求"的注入分开断言。一条播报复用同一 commandId（本轮唯一），command/done 是
// update，客户端取最新 text；每次 appendNotice 追加一条 command/done（text 为累积全文）。
const isOurCommand = (e) => (e.type === 'command/run' || e.type === 'command/done')
  && String(e.data?.commandId ?? '').startsWith('prompt-clarifier:');
const appendedTexts = () => appendedEvents
  .filter((e) => e.type === 'command/done' && String(e.data?.commandId ?? '').startsWith('prompt-clarifier:'))
  .map((e) => e.data.text);
const appendedJoined = () => appendedTexts().join('\n\n');
// command 事件非 surface-eligible：绝不能在 append 第三参带 surfaceOp（带了会在 host 抛
// '... is not surface-eligible and cannot carry surfaceOp'），也因此不进模型上下文。
const appendedSurfaceOk = () => appendedEvents
  .filter(isOurCommand)
  .every((e) => e.opts?.surfaceOp === undefined);
// command 播报行必须满足客户端 commandDefinition 的最小形状。
const commandShapeOk = (e) => typeof e.data?.commandId === 'string' && e.data.commandId !== ''
  && (e.type === 'command/run' ? typeof e.data?.name === 'string' && e.data.name !== '' && e.data.name !== 'permission'
    : typeof e.data?.kind === 'string');

function userMsg(text, id, kind = 'user') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind } };
}

// 1) 非歧义 + 有优化 → 注入一条
let r = await runPreStep([userMsg('帮我改一下登录页的 bug', 'm1')]);
console.log('\nCASE1 injected:', injectedTexts(r).length, '| appended(visible):', appendedTexts().length);
{
  const visible = appendedJoined();
  console.assert(injectedTexts(r).length >= 1, 'CASE1 FAIL — the steering instruction must still reach the model');
  console.assert(appendedTexts().length >= 4, 'CASE1 FAIL — 3 phase notices + 1 result must be appended to the session log');
  console.assert(visible.includes('【提示词优化·1/3 读取上下文】'), 'CASE1 FAIL — phase 1 missing');
  console.assert(visible.includes('【提示词优化·结果】'), 'CASE1 FAIL — result notice missing');
  // 决定性条件：播报走 command/run + command/done（工具卡片行）。command 事件非
  // surface-eligible —— 绝不能带 surfaceOp（带了 host 会抛），故用 appendedSurfaceOk 反向锁定。
  const raw = appendedEvents.filter(isOurCommand);
  const done = raw.filter((e) => e.type === 'command/done');
  const run = raw.filter((e) => e.type === 'command/run');
  console.log('CASE1 command events: run', run.length, '| done', done.length, '| no surfaceOp:', appendedSurfaceOk(), '| shape ok:', raw.every(commandShapeOk));
  console.assert(run.length === 1 && done.length >= 4, 'CASE1 FAIL — exactly one command/run then cumulative command/done for 3 phases + result');
  console.assert(appendedSurfaceOk(), 'CASE1 FAIL — command events must NOT carry surfaceOp (host rejects surface-eligible-only marker)');
  console.assert(raw.every(commandShapeOk), 'CASE1 FAIL — command notices must carry commandId/name/kind and name != permission');
  console.assert(run[0]?.data?.name === '提示词优化', 'CASE1 FAIL — command/run name must be the visible tool label');
  console.assert(done.at(-1)?.data?.kind === 'success', 'CASE1 FAIL — a successful round must end with kind:success');
  // 落位锚点：pre-step 播报时本轮首个 step/start 尚未写入，不带 turn/step 的事件会被
  // 客户端 payloadCoordinates 解析成 {kind:"turn"} 而不进对话流（= 卡片完全不显示）。
  // 必须显式锚定 step 1（内核首步恒为 1）。
  console.assert(run[0]?.data?.turn === 7 && run[0]?.data?.step === 1, 'CASE1 FAIL — command/run must anchor turn+step:1 or the card never lands in the chat flow');
  console.assert(done.every((e) => e.data?.turn === 7 && e.data?.step === 1), 'CASE1 FAIL — command/done must carry the same turn/step anchor');
}

// 2) 同一条消息第二次进入 → 不重复分析
r = await runPreStep([userMsg('帮我改一下登录页的 bug', 'm1')]);
console.log('CASE2 passthrough messages:', r.messages.length);
console.assert(r.messages.length === 1, 'CASE2 FAIL');

// 3) step !== 1 → 直接透传
r = await runPreStep([userMsg('随便说点什么足够长的话', 'm3')], 2);
console.assert(r.messages.length === 1, 'CASE3 FAIL');

// 4) 斜杠命令 → 不分析
r = await runPreStep([userMsg('/plan 做一个很长的计划描述在这里', 'm4')]);
console.assert(r.messages.length === 1, 'CASE4 FAIL');

// 5) 需要澄清 → askTimed 被调用且答案注入
pendingReview = {
  optimized: '优化版：按 A 方案实现重试',
  needs_clarification: true,
  questions: [{ id: 'q1', question: '用哪种重试策略？', options: [{ label: 'A 指数退避' }, { label: 'B 固定间隔' }] }],
  notes: '默认指数退避',
};
asked = [];
r = await runPreStep([userMsg('接口老超时，加个重试机制上去吧', 'm5')]);
console.log('CASE5 asked:', asked.length, '| messages:', r.messages.length);
console.log(r.messages[1]?.content?.[0]?.text);
console.assert(asked.length === 1 && asked[0].callId === 'm5', 'CASE5 askTimed FAIL');
console.assert(injectedTexts(r).length >= 1 && /用户已澄清/.test(injectedJoined(r)), 'CASE5 inject FAIL');

// 5b) 主对话可见的「进度」与「结果」：三条阶段 + 一条结果（走会话日志 append）
{
  const texts = appendedTexts();
  const visible = appendedJoined();
  const has = (s) => visible.includes(s);
  console.log('CASE5b appended notices:', texts.length,
    '| phase1:', has('【提示词优化·1/3 读取上下文】完成'),
    '| phase2:', has('【提示词优化·2/3 模型分析】'),
    '| phase3:', has('【提示词优化·3/3 澄清提问】模型提出 1 个问题，已收到回答'),
    '| result:', has('【提示词优化·结果】状态：已改写'),
    '| optimized:', has('优化版：按 A 方案实现重试'));
  console.assert(texts.length >= 4, 'CASE5b FAIL — 3 phase notices + 1 result must be appended');
  console.assert(has('【提示词优化·1/3 读取上下文】完成') && has('【提示词优化·2/3 模型分析】') && has('【提示词优化·3/3 澄清提问】'), 'CASE5b FAIL — three phase notices required');
  console.assert(has('已收到回答'), 'CASE5b FAIL — the clarify phase must report the outcome');
  console.assert(has('【提示词优化·结果】状态：已改写'), 'CASE5b FAIL — result notice with status missing');
  console.assert(has('优化版：按 A 方案实现重试'), 'CASE5b FAIL — result must carry the optimized prompt');
}

// 6) 模型故障 → fail-open 返回原 decision
const goodPrepare = ctx.llm.prepareCall;
ctx.llm.prepareCall = async () => { throw new Error('provider exploded'); };
const before6 = appendedTexts().length;
r = await runPreStep([userMsg('这段输入足够长可以触发分析流程', 'm6')]);
{
  const texts = appendedTexts().slice(before6);   // 只看本次新增
  console.log('CASE6 fail-open notices:', texts.length, '| error visible:', texts.some((x) => x.includes('【提示词优化·错误】')));
  console.assert(r.kind === 'enter', 'CASE6 FAIL — decision must still enter');
  console.assert(texts.length === 1 && texts[0].includes('【提示词优化·错误】'), 'CASE6 FAIL — a failure must be reported in the conversation');
}
ctx.llm.prepareCall = goodPrepare;

// 7) 工具注册与执行
const tool = tools.find((t) => t.name === 'prompt_clarifier_review');
const out = await tool.execute({ text: '再来一条足够长的输入用来测试' }, { agent, signal: new AbortController().signal });
console.log('TOOL status:', out.status, '| optimized:', out.optimized);

// 8) HTTP 路由
const res = await httpRoute.fetch({
  method: 'POST',
  json: async () => ({ action: 'optimize', sessionId: session.id, text: '一条够长的手动测试输入内容' }),
});
console.log('HTTP:', res.status, (await res.json()).status ?? (await res.clone().json()));

// 9) 折叠：projection apply
const fold = ctx.sessionProjections.registered;
let state = fold.init();
const untouched = fold.apply(state, { type: 'turn/start', data: { turn: 1 } });
console.assert(untouched === state, 'fold must return same ref for irrelevant events');
state = fold.apply(state, { type: 'user/message', data: userMsg('你好呀世界', 'u1') });
state = fold.apply(state, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好' }], source: { kind: 'model' } } } });
console.log('FOLD items:', JSON.stringify(state.items));
console.assert(state.items.length === 2, 'FOLD FAIL');

// 10) 手动模式：短输入也要分析（用户主动点击，不该被 minChars 挡掉）
let shortAnalyzed = null;
{
  const goodPrepare10 = ctx.llm.prepareCall;
  ctx.llm.prepareCall = async (config, signal) => ({
    config,
    stream: () => (async function* () {
      for (const c of fakeChunkText(JSON.stringify({ optimized: '把提交按钮的主色改为品牌蓝 #247bbf，并保持对比度达标', needs_clarification: false, questions: [], notes: '' }))) yield c;
    })(),
  });
  const resShort = await httpRoute.fetch({
    method: 'POST',
    json: async () => ({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色' }),
  });
  shortAnalyzed = await resShort.json();
  ctx.llm.prepareCall = goodPrepare10;
}
console.log('CASE10 manual short:', shortAnalyzed.status, '|', shortAnalyzed.optimized ?? shortAnalyzed.reason);
console.assert(shortAnalyzed.status === 'ok', 'CASE10 FAIL — manual mode must analyze short input');

// 11) 自动模式仍然放过短输入（不把"继续"之类拿去分析）
pendingReview = { optimized: 'x', needs_clarification: false, questions: [], notes: '' };
r = await runPreStep([userMsg('好的', 'm11')]);
console.log('CASE11 auto short passthrough messages:', r.messages.length);
console.assert(r.messages.length === 1, 'CASE11 FAIL');

// 12/13) 旁路调用显式选最低推理档，且绝不编造模型不支持的档位
function makeEffortProbe(modelInfo) {
  return async (config, signal, configure) => {
    const proposed = configure
      ? { ...configure(structuredClone({ maxTokens: config.maxTokens }), modelInfo), provider: config.provider, model: config.model }
      : config;
    return {
      config: proposed,
      probe: proposed.reasoningEffort,
      stream: (options) => (async function* () {
        for (const c of fakeChunkText(JSON.stringify({ optimized: 'ok', needs_clarification: false, questions: [], notes: '' }))) yield c;
      })(),
    };
  };
}
const reviewTool = tools.find((t) => t.name === 'prompt_clarifier_review');
{
  const prev = ctx.llm.prepareCall;
  const cases = [
    ['low+high(default high)', { reasoning: { efforts: [{ id: 'low', name: 'L' }, { id: 'high', name: 'H' }], defaultEffort: 'high' } }, 'low'],
    ['only-high', { reasoning: { efforts: [{ id: 'high', name: 'H' }], defaultEffort: 'high' } }, void 0],
    ['custom ids', { reasoning: { efforts: [{ id: 'ultrathink', name: 'U' }, { id: 'turbo', name: 'T' }] } }, 'ultrathink'],
    ['no reasoning meta', { }, void 0],
  ];
  for (const [label, modelInfo, expect] of cases) {
    let captured;
    ctx.llm.prepareCall = async (config, signal, configure) => {
      const p = await makeEffortProbe(modelInfo)(config, signal, configure);
      captured = p.probe;
      return p;
    };
    await reviewTool.execute({ text: '一条足够长的输入用于推理档位测试' }, { agent, signal: new AbortController().signal });
    ctx.llm.prepareCall = prev;
    console.log(`CASE12[${label}] ->`, captured);
    console.assert(captured === expect, `CASE12[${label}] FAIL expect=${expect} got=${captured}`);
  }
}

// ==== 13) 手动按钮走右侧选择器的实时模型；无可用模型 → 提示先选 ====
{
  const ask = async (body) => (await httpRoute.fetch({ method: 'POST', json: async () => body })).json();

  // a) 客户端送来选择器里的 provider/model（q/qmodel）→ 必须用它，而不是会话路由 p/m
  ctx.llm.lastRoute = null;
  let out = await ask({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色', provider: 'q', model: 'qmodel' });
  console.log('CASE13a status:', out.status, '| route used:', JSON.stringify(ctx.llm.lastRoute));
  console.assert(out.status === 'ok', 'CASE13a FAIL — explicit route must succeed');
  console.assert(ctx.llm.lastRoute?.provider === 'q' && ctx.llm.lastRoute?.model === 'qmodel',
    'CASE13a FAIL — must use the model picked in the selector, got ' + JSON.stringify(ctx.llm.lastRoute));

  // b) 未注册的 provider → 不能硬发，回 no-model-route（界面提示先选模型）
  out = await ask({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色', provider: 'nope', model: 'x' });
  console.log('CASE13b status:', out.status, '| reason:', out.reason);
  console.assert(out.status === 'skipped' && out.reason === 'no-model-route', 'CASE13b FAIL — unknown provider must be rejected');

  // c) 客户端明确报告“没有选中可用模型”
  out = await ask({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色', selectionMissing: true });
  console.log('CASE13c status:', out.status, '| reason:', out.reason);
  console.assert(out.status === 'skipped' && out.reason === 'no-model-route', 'CASE13c FAIL — empty selection must not fall back silently');

  // d) Agent 工具路径不送路由 → 回退会话路由（p/m），保持既有行为
  ctx.llm.lastRoute = null;
  out = await reviewTool.execute({ text: '一条足够长的输入用于回退测试' }, { agent, signal: new AbortController().signal });
  console.log('CASE13d tool status:', out.status, '| route used:', JSON.stringify(ctx.llm.lastRoute));
  console.assert(out.status === 'ok' && ctx.llm.lastRoute?.provider === 'p',
    'CASE13d FAIL — tool path must fall back to the session route');
}

// ==== 14) 首个完整 JSON 就收流：不读完模型 JSON 之后的废话 ====
{
  const prev = ctx.llm.prepareCall;
  const PACE = 20;                   // 模拟每片 20ms 的流式节奏
  const json = '{"optimized":"优化稿","needs_clarification":false,"questions":[],"notes":""}';
  const jsonPieces = [json.slice(0, 12), json.slice(12, 40), json.slice(40, 70), json.slice(70)];
  const trailing = ['\n\n补充说明一', '补充说明二', '补充说明三', '补充说明四', '补充说明五', '补充说明六'];
  let served = 0;
  ctx.llm.prepareCall = async (config) => ({
    config,
    stream: () => (async function* () {
      for (const piece of [...jsonPieces, ...trailing]) {
        served += 1;
        await new Promise((r) => setTimeout(r, PACE));
        yield { type: 'text-delta', text: piece };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(),
  });
  const t0 = Date.now();
  const out = await httpRoute.fetch({
    method: 'POST',
    json: async () => ({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色', provider: 'p', model: 'm' }),
  }).then((r) => r.json());
  const elapsed = Date.now() - t0;
  ctx.llm.prepareCall = prev;
  const fullStream = (jsonPieces.length + trailing.length) * PACE;
  console.log(`CASE14 elapsed: ${elapsed}ms | served ${served}/${jsonPieces.length + trailing.length} chunks | would-be-full: ${fullStream}ms | earlyExit: ${out.timing?.earlyExit}`);
  console.assert(out.status === 'ok', 'CASE14 FAIL — must still succeed');
  console.assert(out.optimized === '优化稿', 'CASE14 FAIL — must parse the first complete JSON');
  console.assert(out.timing?.earlyExit === true, 'CASE14 FAIL — must stop at the first complete JSON');
  console.assert(served === jsonPieces.length, `CASE14 FAIL — must not pull trailing chunks (served=${served})`);
  console.assert(elapsed < fullStream * 0.7, `CASE14 FAIL — early exit must cut the tail (${elapsed}ms vs full ${fullStream}ms)`);
}

// ==== 15) 分段计时字段齐全且自洽 ====
{
  const out = await httpRoute.fetch({
    method: 'POST',
    json: async () => ({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色', provider: 'p', model: 'm' }),
  }).then((r) => r.json());
  const t = out.timing ?? {};
  console.log('CASE15 timing:', JSON.stringify({ total: t.total, context: t.context, prepare: t.prepare, firstToken: t.firstToken, stream: t.stream, promptChars: t.promptChars, model: t.model, fast: t.fast }));
  console.assert(out.status === 'ok', 'CASE15 FAIL — analysis failed');
  console.assert(typeof t.total === 'number' && t.total >= 0, 'CASE15 FAIL — total ms missing');
  console.assert(typeof t.context === 'number' && t.context >= 0, 'CASE15 FAIL — context ms missing');
  console.assert(typeof t.prepare === 'number', 'CASE15 FAIL — prepare ms missing');
  console.assert(t.provider === 'p' && t.model === 'm', 'CASE15 FAIL — timing must record the route actually used');
  console.assert(t.promptChars > 0 && t.promptChars < 4000, 'CASE15 FAIL — prompt should be small after the context trim, got ' + t.promptChars);
}

// ==== 16) 上下文瘦身：同夹具下 prompt 明显变短（新 5×280 vs 旧 8×400）====
{
  const foldDef = ctx.sessionProjections.registered;
  let st = foldDef.init();
  for (let i = 0; i < 6; i += 1) {
    st = foldDef.apply(st, { type: 'user/message', data: userMsg('U'.repeat(400) + i, `pu${i}`) });
    st = foldDef.apply(st, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'A'.repeat(400) + i }], source: { kind: 'model' } } },
    });
  }
  const newItems = st.items.length;
  const newChars = st.items.reduce((n, it) => n + it.text.length, 0);
  const oldChars = Math.min(8, 12) * 400;   // 旧默认 8 条 × 400 字
  const prevStateOf = ctx.sessionProjections.stateOf;
  ctx.sessionProjections.stateOf = () => ({ items: st.items });
  const out = await httpRoute.fetch({
    method: 'POST',
    json: async () => ({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色', provider: 'p', model: 'm' }),
  }).then((r) => r.json());
  ctx.sessionProjections.stateOf = prevStateOf;
  console.log(`CASE16 context: new ${newItems} items/${newChars} chars → promptChars ${out.timing?.promptChars} | old would be ${oldChars} chars`);
  console.assert(out.status === 'ok', 'CASE16 FAIL — analysis failed');
  console.assert(newItems <= 5 && newChars <= 5 * 280, 'CASE16 FAIL — context cap not applied');
  console.assert(out.timing.promptChars < oldChars, `CASE16 FAIL — prompt must shrink (${out.timing.promptChars} vs old ${oldChars})`);
  console.log('CASE16 context chars removed:', `${Math.round((1 - newChars / oldChars) * 100)}%`);
}

// ==== 17) 自动模式开关：关掉就不再自动分析，打开即恢复（含 GET 回显）====
{
  const setAuto = async (enabled) => (await httpRoute.fetch({
    method: 'POST',
    json: async () => ({ action: 'setAuto', enabled }),
  })).json();

  // a) 关掉：pre-step 直接放行，不注入
  let out = await setAuto(false);
  console.log('CASE17a setAuto(false) ->', JSON.stringify(out));
  console.assert(out.ok === true && out.auto === false, 'CASE17a FAIL — runtime override should be off');
  let r = await runPreStep([userMsg('把登录页按钮改成品牌蓝并且加个图标', 'm17a')]);
  console.log('CASE17a auto-off messages:', r.messages.length);
  console.assert(r.messages.length === 1, 'CASE17a FAIL — must not inject while auto mode is off');

  // b) 打开：同一入口，自动分析 + 注入
  out = await setAuto(true);
  console.log('CASE17b setAuto(true) ->', JSON.stringify(out));
  console.assert(out.auto === true, 'CASE17b FAIL — runtime override should be on');
  r = await runPreStep([userMsg('把登录页按钮改成品牌蓝并且加个图标', 'm17b')]);
  console.log('CASE17b auto-on messages:', r.messages.length, '| injected:', injectedTexts(r).length);
  console.assert(appendedTexts().length >= 2, 'CASE17b FAIL — auto mode must append progress + result');

  // c) GET 回显当前运行时状态，并区分“配置值”
  const info = await (await httpRoute.fetch({ method: 'GET' })).json();
  console.log('CASE17c GET auto:', info.auto, '| configured:', info.autoConfigured);
  console.assert(info.auto === true, 'CASE17c FAIL — GET must report the effective (runtime) state');
  console.assert(info.autoConfigured === true, 'CASE17c FAIL — GET must still expose the configured value');

  // 复原，避免影响后续用例
  await setAuto(true);
}

// ==== 18) 空输出 → 重试一次（不降档、更大额度）；两次都空 → 明确报 empty-model-output ====
{
  const prev = ctx.llm.prepareCall;
  // a) 第一次空、第二次正常
  let calls = 0;
  ctx.llm.prepareCall = async (config, signal, configure) => {
    calls += 1;
    const first = calls === 1;
    const proposed = configure === void 0 ? config : { ...configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'low', name: 'L' }], defaultEffort: 'low' } }), ...config };
    return {
      config: proposed,
      stream: () => (async function* () {
        if (first) { yield { type: 'finish', reason: { kind: 'stop' } }; return; }
        for (const c of fakeChunkText(JSON.stringify({ optimized: '重试后的优化稿', needs_clarification: true, questions: [{ id: 'q', question: '哪个按钮？', options: [] }], notes: '' }))) yield c;
      })(),
    };
  };
  let out = await (await httpRoute.fetch({
    method: 'POST', json: async () => ({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色', provider: 'p', model: 'm' }),
  })).json();
  console.log('CASE18a status:', out.status, '| calls:', calls, '| attempt:', out.timing?.attempt, '| questions:', out.timing?.questions);
  console.assert(out.status === 'ok', 'CASE18a FAIL — retry should recover from an empty first attempt');
  console.assert(calls === 2, 'CASE18a FAIL — must retry exactly once, got ' + calls);
  console.assert(out.timing?.attempt === 2, 'CASE18a FAIL — timing must record the attempt used');
  console.assert(out.needsClarification === true, 'CASE18a FAIL — clarification flag must survive');

  // b) 两次都空 → failed/empty-model-output（区别于“解析不了”）
  calls = 0;
  ctx.llm.prepareCall = async (config) => {
    calls += 1;
    return { config, stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })() };
  };
  out = await (await httpRoute.fetch({
    method: 'POST', json: async () => ({ action: 'optimize', sessionId: session.id, text: '改个按钮颜色', provider: 'p', model: 'm' }),
  })).json();
  console.log('CASE18b status:', out.status, '| reason:', out.reason, '| calls:', calls);
  console.assert(out.status === 'failed' && out.reason === 'empty-model-output', 'CASE18b FAIL — must report empty output distinctly');
  console.assert(calls === 2, 'CASE18b FAIL — exactly two attempts expected, got ' + calls);
  ctx.llm.prepareCall = prev;
}

// ==== 19) AUTO 结果可取回（客户端据此弹面板）；文本不匹配则不返回 ====
{
  const ask = async (body) => (await httpRoute.fetch({ method: 'POST', json: async () => body })).json();
  const text19 = '把侧边栏的图标换成鲸鱼并且保持点击区域不变';
  const r19 = await runPreStep([userMsg(text19, 'm19')]);
  console.assert(appendedTexts().length >= 2, 'CASE19 setup FAIL — auto analysis must succeed first');

  let got = await ask({ action: 'latestAuto', sessionId: session.id, text: text19 });
  console.log('CASE19a same text -> review:', !!got.review, '| optimized:', JSON.stringify(got.review?.optimized ?? null));
  console.assert(got.review !== null && got.review !== undefined, 'CASE19a FAIL — the auto review must be retrievable');

  got = await ask({ action: 'latestAuto', sessionId: session.id, text: '另一条完全不同的输入' });
  console.log('CASE19b other text -> review:', got.review);
  console.assert(got.review === null, 'CASE19b FAIL — must not hand back a review for a different text');

  got = await ask({ action: 'latestAuto', sessionId: 'no-such-session', text: text19 });
  console.log('CASE19c unknown session -> review:', got.review);
  console.assert(got.review === null, 'CASE19c FAIL — unknown session must return null');
}

// ============================================================
// 2026-10-30 复查修复的回归用例（P0 崩溃链 + P1/P2 行为）
// 做法：用**同一个 ctx** 再 apply 一次并传入新配置，取出新注册的监听器单独驱动。
// 新实例自带独立的 analyzed 去重集 / autoOverrides / autoReviews / projection 注册，
// 因此不会污染上面的用例。
// ============================================================
const listeners = () => events.get('agent/pre-step');
const httpOf = () => httpRoute;

function reapply(config) {
  const before = listeners().length;
  const beforeTools = tools.length;
  apply(ctx, config);
  if (listeners().length <= before) throw new Error('re-apply did not register a pre-step listener (activation swallowed an error?)');
  const listener = listeners()[listeners().length - 1];
  const tool = tools.slice(beforeTools).reverse().find((t) => t.name === 'prompt_clarifier_review');
  return { listener, tool };
}

async function drive(listener, messages, { step = 1, nextImpl } = {}) {
  let called = false;
  const next = nextImpl ?? (async () => { called = true; return { kind: 'enter', messages, startsRequestSeries: true }; });
  const result = await listener({ agent, messages, step, signal: new AbortController().signal }, next);
  if (!called && result?.kind === 'enter') throw new Error('listener did not await next()');
  return result;
}

const post = async (body) => (await httpOf().fetch({ method: 'POST', json: async () => body })).json();
const get = async (url) => (await httpOf().fetch({ method: 'GET', url })).json();

// ==== 20) P0 回归：模型空输出时 AUTO 绝不抛出，且不再自相矛盾地报“无需改写” ====
{
  const prevPrepare = ctx.llm.prepareCall;
  let calls = 0;
  ctx.llm.prepareCall = async (config) => {
    calls += 1;
    return { config, stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })() };
  };
  const { listener } = reapply({ minChars: 10, askBlocking: false });
  const before = appendedTexts().length;
  let threw = null;
  let r = null;
  try {
    r = await drive(listener, [userMsg('这段输入足够长可以触发自动分析', 'm20')]);
  } catch (error) {
    threw = error;
  }
  const texts = appendedTexts().slice(before);
  const joined = texts.join('\n');
  console.log('CASE20 threw:', threw && threw.message, '| kind:', r?.kind, '| messages:', r?.messages?.length,
    '| appended rows:', texts.length, '| error row:', joined.includes('【提示词优化·错误】'),
    '| result row:', joined.includes('【提示词优化·结果】'), '| prepare calls:', calls);
  console.assert(threw === null, 'CASE20 FAIL — a failed analysis must never throw out of pre-step (it kills the user turn)');
  console.assert(r?.kind === 'enter', 'CASE20 FAIL — the turn must still enter with the original input');
  console.assert(r?.messages?.length === 1, 'CASE20 FAIL — nothing may be injected on failure');
  console.assert(calls === 2, 'CASE20 FAIL — expected the empty-output retry to run twice, got ' + calls);
  console.assert(texts.length === 1 && joined.includes('【提示词优化·错误】'), 'CASE20 FAIL — exactly one error row expected');
  console.assert(!joined.includes('【提示词优化·结果】'), 'CASE20 FAIL — must not also claim “无需改写” after an error');
  console.assert(!joined.includes('1/3'), 'CASE20 FAIL — no progress rows after a failure');

  // 失败结果也要能被客户端取回（带 questions:[] 占位），否则按钮会卡在“优化中”到预算耗尽。
  const got = await post({ action: 'latestAuto', sessionId: session.id, text: '这段输入足够长可以触发自动分析' });
  console.log('CASE20 latestAuto ->', JSON.stringify(got.review && { status: got.review.status, reason: got.review.reason, questions: got.review.questions }));
  console.assert(got.review !== null && got.review.reason === 'empty-model-output', 'CASE20 FAIL — failure must be retrievable so the poll stops');
  console.assert(Array.isArray(got.review.questions) && got.review.questions.length === 0, 'CASE20 FAIL — cached failure must carry no questions');
  ctx.llm.prepareCall = prevPrepare;
}

// ==== 21) 短输入：不打扰用户，但要让客户端轮询能收尾 ====
{
  const { listener } = reapply({ minChars: 10, askBlocking: false });
  const before = appendedTexts().length;
  const r = await drive(listener, [userMsg('好的', 'm21')]);
  const texts = appendedTexts().slice(before);
  const got = await post({ action: 'latestAuto', sessionId: session.id, text: '好的' });
  console.log('CASE21 messages:', r.messages.length, '| appended rows:', texts.length, '| latestAuto reason:', got.review?.reason);
  console.assert(r.messages.length === 1 && texts.length === 0, 'CASE21 FAIL — too-short must stay silent');
  console.assert(got.review?.reason === 'too-short', 'CASE21 FAIL — the skip must still be retrievable so 优化中 ends');
  console.assert(Array.isArray(got.review?.questions) && got.review.questions.length === 0, 'CASE21 FAIL — no panel for a skip');
}

// ==== 22) showProgress=false：AUTO 每轮只留一条“结果”行 ====
{
  pendingReview = { optimized: '把登录页的提交按钮改为品牌蓝，并保持对比度达标', needs_clarification: false, questions: [], notes: '' };
  const { listener } = reapply({ minChars: 10, askBlocking: false, showProgress: false });
  const before = appendedTexts().length;
  const r = await drive(listener, [userMsg('改一下登录页按钮的颜色吧谢谢', 'm22')]);
  const texts = appendedTexts().slice(before);
  const joined = texts.join('\n');
  console.log('CASE22 rows:', texts.length, '| result row:', joined.includes('【提示词优化·结果】状态：已改写'),
    '| progress rows:', /1\/3|2\/3|3\/3/.test(joined), '| injected:', injectedTexts(r).length);
  console.assert(texts.length === 1, 'CASE22 FAIL — showProgress=false must leave exactly one visible row, got ' + texts.length);
  console.assert(joined.includes('【提示词优化·结果】状态：已改写'), 'CASE22 FAIL — that row must be the result');
  console.assert(!/1\/3|2\/3|3\/3/.test(joined), 'CASE22 FAIL — no progress rows when showProgress is off');
  console.assert(injectedTexts(r).length === 1, 'CASE22 FAIL — the model instruction must still be injected');
}

// ==== 23) autoFast：AUTO 可走便宜/快的路由，工具路径永远不走 ====
{
  const { listener, tool } = reapply({ minChars: 10, fastProvider: 'q', fastModel: 'qmodel', autoFast: true });
  ctx.llm.lastRoute = null;
  await drive(listener, [userMsg('自动模式这条也够长可以分析它', 'm23a')]);
  console.log('CASE23a AUTO route with autoFast:', JSON.stringify(ctx.llm.lastRoute));
  console.assert(ctx.llm.lastRoute?.provider === 'q' && ctx.llm.lastRoute?.model === 'qmodel',
    'CASE23a FAIL — autoFast must let AUTO use the fast route, got ' + JSON.stringify(ctx.llm.lastRoute));

  const { listener: plain } = reapply({ minChars: 10, fastProvider: 'q', fastModel: 'qmodel', autoFast: false });
  ctx.llm.lastRoute = null;
  await drive(plain, [userMsg('自动模式这条也够长可以分析它', 'm23b')]);
  console.log('CASE23b AUTO route without autoFast:', JSON.stringify(ctx.llm.lastRoute));
  console.assert(ctx.llm.lastRoute?.provider === 'p', 'CASE23b FAIL — autoFast=false keeps AUTO on the session route');

  ctx.llm.lastRoute = null;
  await tool.execute({ text: '工具调用这条输入也足够长了吧' }, { agent, signal: new AbortController().signal });
  console.log('CASE23c tool route with fast configured:', JSON.stringify(ctx.llm.lastRoute));
  // 工具与手动按钮同为 manual:true → 也跟随快速路由（这是 manual 的既有语义；
  // 想要会话模型请用不配 fastProvider/fastModel 的默认配置）。
  console.assert(ctx.llm.lastRoute?.provider === 'q', 'CASE23c FAIL — the tool follows manual semantics (fast route when configured)');
}

// ==== 24) 工具路径绕开 minChars（模型显式发起的分析不该被挡） ====
{
  pendingReview = { optimized: '把首页标题改成鲸鱼图标，保持点击区域不变', needs_clarification: false, questions: [], notes: '' };
  const { tool } = reapply({ minChars: 40 });
  const out = await tool.execute({ text: '改个按钮颜色' }, { agent, signal: new AbortController().signal });
  console.log('CASE24 tool on 6-char text:', out.status, '|', out.optimized ?? out.reason);
  console.assert(out.status === 'ok', 'CASE24 FAIL — the tool must analyze short drafts (minChars is an AUTO guard)');
}

// ==== 25) 自动开关按会话生效：两个标签页不再互相覆盖 ====
{
  const { listener } = reapply({ auto: true, minChars: 10 });
  const offA = await post({ action: 'setAuto', enabled: false, sessionId: 'tab-A' });
  const onB = await post({ action: 'setAuto', enabled: true, sessionId: 'tab-B' });
  console.log('CASE25a per-session echoes:', JSON.stringify({ offA, onB }));
  console.assert(offA.auto === false && onB.auto === true, 'CASE25a FAIL — each session must report its own state');

  // 会话 A 关掉 → 不注入；会话 B 开着 → 注入。用同一个 agent.session 只能验证 A/B 的全局回退，
  // 这里断言“会话内覆盖优先于配置”，并检查未覆盖的会话仍跟随配置。
  const infoA = await get('/api/prompt-clarifier?sessionId=tab-A');
  const infoB = await get('/api/prompt-clarifier?sessionId=tab-B');
  const infoNone = await get('/api/prompt-clarifier');
  console.log('CASE25b GET auto:', infoA.auto, infoB.auto, infoNone.auto, '| budget:', infoNone.analysisBudgetMs, '| timeout:', infoNone.timeoutMs);
  console.assert(infoA.auto === false, 'CASE25b FAIL — GET with sessionId must reflect that session override');
  console.assert(infoB.auto === true, 'CASE25b FAIL — another session keeps its own value');
  console.assert(infoNone.auto === infoB.auto || infoNone.auto === true, 'CASE25b FAIL — GET without sessionId reports the global/config state');
  console.assert(infoNone.analysisBudgetMs === infoNone.timeoutMs * 2, 'CASE25b FAIL — the budget must be timeoutMs × 2 attempts');

  // 不带 sessionId 的老写法仍然是全局覆盖（向后兼容）。
  const legacy = await post({ action: 'setAuto', enabled: false });
  const infoLegacy = await get('/api/prompt-clarifier');
  console.log('CASE25c legacy global setAuto ->', JSON.stringify({ legacy, info: infoLegacy.auto, tabB: (await get('/api/prompt-clarifier?sessionId=tab-B')).auto }));
  console.assert(legacy.auto === false && infoLegacy.auto === false, 'CASE25c FAIL — bare setAuto must still be global');
  console.assert((await get('/api/prompt-clarifier?sessionId=tab-B')).auto === true, 'CASE25c FAIL — a global override must not erase a per-session choice');

  // 会话内关掉之后，pre-step 对这个会话直接放行（并留一条可排查的日志）。
  const { listener: perOff } = reapply({ auto: true, minChars: 10 });
  await post({ action: 'setAuto', enabled: false, sessionId: session.id });
  const before = appendedTexts().length;
  const r = await drive(perOff, [userMsg('关掉自动以后这条不该被分析', 'm25d')]);
  console.log('CASE25d auto-off for this session -> messages:', r.messages.length, '| appended rows:', appendedTexts().length - before);
  console.assert(r.messages.length === 1 && appendedTexts().length === before, 'CASE25d FAIL — per-session OFF must be silent passthrough');
}

// ==== 26) 上下文投影不再吃自己的输出（否则改写会喂给下一轮改写） ====
{
  reapply({ minChars: 10 });
  const fold = ctx.sessionProjections.registered;
  console.log('CASE26 stateVersion:', fold.stateVersion);
  console.assert(fold.stateVersion === 3, 'CASE26 FAIL — sampling changed, stateVersion must be bumped');
  let st = fold.init();
  st = fold.apply(st, { type: 'user/message', data: userMsg('真实用户输入一', 'r1') });
  st = fold.apply(st, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手回复一' }], source: { kind: 'model' } } } });
  const afterReal = st.items.length;
  // (a) 插件注入给模型的 refine/clarify（source.kind = 'prompt-clarifier'）
  st = fold.apply(st, { type: 'user/message', data: { id: 'n1', role: 'user', content: [{ type: 'text', text: '请按以下更明确的目标执行' }], source: { kind: 'prompt-clarifier', form: 'refine' } } });
  // (b) 插件 append 到日志的可见行（kind='user' 但 form='prompt-clarifier:*'）
  st = fold.apply(st, { type: 'user/message', data: { id: 'n2', role: 'user', content: [{ type: 'text', text: '【提示词优化·结果】状态：已改写' }], source: { kind: 'user', form: 'prompt-clarifier:result' } } });
  // (c) 提问卡上的用户作答仍然要收
  st = fold.apply(st, { type: 'user/message', data: { id: 'n3', role: 'user', content: [{ type: 'text', text: '关于“用哪种重试策略”：A 指数退避' }], source: { kind: 'user-question-reply' } } });
  // (d) v3：插件自己的助手播报行（assistant/message + source.kind='model' + form='prompt-clarifier:notice'）不能进上下文
  st = fold.apply(st, { type: 'assistant/message', data: { message: { id: 'p1', role: 'assistant', content: [{ type: 'text', text: '【提示词优化·1/3 读取上下文】完成：5 条 / 663 字（0ms）' }], source: { kind: 'model', provider: 'prompt-clarifier', model: 'notice', form: 'prompt-clarifier:notice' } } } });
  console.log('CASE26 items:', JSON.stringify(st.items.map((i) => i.role + ':' + i.text.slice(0, 8))), '| after real:', afterReal);
  console.assert(st.items.length === afterReal + 1, 'CASE26 FAIL — only the human input and the user answer may enter the context');
  console.assert(st.items.some((i) => i.role === 'user' && i.text.includes('关于')), 'CASE26 FAIL — user-question-reply answers must still be sampled');
  console.assert(!st.items.some((i) => i.text.includes('请按以下更明确的目标') || i.text.includes('【提示词优化')), 'CASE26 FAIL — the plugin must not feed itself its own output');
}

// ==== 27) askBlocking 打开时缓存剥掉 questions（不再出现第二套澄清 UI） ====
{
  pendingReview = {
    optimized: '接口超时按 A 方案加指数退避重试',
    needs_clarification: true,
    questions: [{ id: 'q1', question: '用哪种重试策略？', options: [{ label: 'A 指数退避' }, { label: 'B 固定间隔' }] }],
    notes: '默认指数退避',
  };
  const { listener } = reapply({ minChars: 10, askBlocking: true });
  const before = appendedTexts().length;
  asked = [];
  const r = await drive(listener, [userMsg('接口老是超时你给它加个重试吧', 'm27')]);
  const joined = appendedTexts().slice(before).join('\n');
  const got = await post({ action: 'latestAuto', sessionId: session.id, text: '接口老是超时你给它加个重试吧' });
  console.log('CASE27 asked:', asked.length, '| 3/3 row:', joined.includes('已收到回答'),
    '| cached questions:', got.review?.questions?.length, '| cached optimized kept:', JSON.stringify(got.review?.optimized ?? null));
  console.assert(asked.length === 1, 'CASE27 FAIL — the native card must still be asked in-turn');
  console.assert(r.messages.some((m) => /用户已澄清/.test(m.content?.[0]?.text ?? '')), 'CASE27 FAIL — the answer must reach the model');
  console.assert(got.review && got.review.questions.length === 0, 'CASE27 FAIL — with askBlocking the client must not open a second question UI');
  console.assert(typeof got.review.optimized === 'string' && got.review.optimized !== '', 'CASE27 FAIL — the rewrite itself is still cached');
  console.assert(joined.includes('【提示词优化·结果】状态：已改写'), 'CASE27 FAIL — the rewrite row must stay visible in the chat');
}

// ==== 28) next() 判 reject/中断时不得把消息永久拉黑 ====
{
  pendingReview = { optimized: '把侧边栏图标换成鲸鱼，尺寸与点击区域都不变', needs_clarification: false, questions: [], notes: '' };
  const { listener } = reapply({ minChars: 10, askBlocking: false });
  const msg = [userMsg('把侧边栏的图标换成鲸鱼谢谢啦', 'm28')];
  const rejected = await drive(listener, msg, { nextImpl: async () => ({ kind: 'reject', reason: 'nothing to do' }) });
  console.log('CASE28a reject passthrough kind:', rejected.kind);
  console.assert(rejected.kind === 'reject', 'CASE28a FAIL — a reject must be returned untouched');
  const r2 = await drive(listener, msg);
  console.log('CASE28b same id after reject -> injected:', injectedTexts(r2).length);
  console.assert(injectedTexts(r2).length >= 1, 'CASE28b FAIL — a rejected turn must not blacklist the message forever');
}

// ==== 30) 「优化中」的唯一依据：latestAuto 的 pending 字段 ====
// 普通消息提交时宿主的 input.phase 恒为 plain（见 client.js 注释），草稿清空又会被
// 输入法误触发，所以客户端只能问 Host“你到底在不在分析这段文本”。
{
  const { listener } = reapply({ minChars: 10, askBlocking: false });
  // 空闲：review 与 pending 都必须是 null（客户端据此不点亮按钮）。
  const idle = await post({ action: 'latestAuto', sessionId: session.id, text: '随便一段足够长的输入' });
  console.log('CASE30 idle ->', JSON.stringify(idle));
  console.assert('pending' in idle, 'CASE30 FAIL — the reply must always carry the pending key');
  console.assert(idle.review === null && idle.pending === null, 'CASE30 FAIL — idle must report review:null + pending:null');

  // 分析中：pending.text = 正在分析的文本；分析结束必须清掉，否则按钮永远「优化中」。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const prevPrepare = ctx.llm.prepareCall;
  ctx.llm.prepareCall = async (...args) => { await gate; return prevPrepare(...args); };
  pendingReview = { optimized: '把提交按钮改成品牌蓝', needs_clarification: false, questions: [], notes: '' };
  const running = drive(listener, [userMsg('把提交按钮改成品牌蓝，谢谢', 'm30')]);
  await new Promise((r) => setTimeout(r, 30));
  const during = await post({ action: 'latestAuto', sessionId: session.id, text: '把提交按钮改成品牌蓝，谢谢' });
  console.log('CASE30 during ->', JSON.stringify(during.pending));
  console.assert(during.pending !== null && during.pending.text === '把提交按钮改成品牌蓝，谢谢',
    'CASE30 FAIL — a running analysis must be reported as pending, otherwise the button never enters 优化中');
  release();
  await running;
  const after = await post({ action: 'latestAuto', sessionId: session.id, text: '把提交按钮改成品牌蓝，谢谢' });
  console.log('CASE30 after ->', JSON.stringify({ pending: after.pending, hasReview: after.review !== null }));
  console.assert(after.pending === null, 'CASE30 FAIL — the pending entry must be cleared when the analysis ends');
  console.assert(after.review !== null, 'CASE30 FAIL — the finished review must stay retrievable');
  ctx.llm.prepareCall = prevPrepare;
}

console.log('\nALL CHECKS DONE (assertions above would print FAIL lines on mismatch)');
