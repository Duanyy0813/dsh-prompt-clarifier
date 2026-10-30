/**
 * dsh-prompt-clarifier — Host half.
 *
 * 在用户输入进入模型之前：按会话上下文优化提示词，并对“缺少就无法开工”的
 * 歧义通过原生提问卡片主动向用户澄清。两条路径共用同一组操作
 * （user-actions.md：one operation, two callers）：
 *  1. 自动模式：`agent/pre-step` 拦截本轮首次进入的人类消息，一次旁路 LLM
 *     调用产出优化稿与澄清问题；必要时 ctx.userQuestions.ask() 等待用户回答，
 *     然后把优化稿 + 澄清答案作为追加的 user/message 注入同一步骤。
 *  2. 手动模式：Composer 按钮 → POST /api/prompt-clarifier → 同一 opAnalyze；
 *     结果写回输入框草稿由 Client 半完成。
 * fail-open：分析超时/出错一律返回 next()，绝不阻断正常对话。
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, statSync, writeFileSync } from 'node:fs';

export const inject = ['llm', 'tools', 'agents', 'sessionProjections', 'sessions'];

const DEFAULTS = {
  enabled: true,
  auto: true,
  askBlocking: true,
  minChars: 10,
  maxInputChars: 8000,
  timeoutMs: 30000,
  // 输出预算：早期版本压到 768 后实测出现过“思考吃满预算、模型一个字都没吐出来”
  // （outChars=0 → 解析失败 → 自动模式既没注入也没问答卡），故恢复 2048。
  // 真正省时靠“首个完整 JSON 就收流”，不靠压预算。
  maxOutputTokens: 2048,
  askTimeoutMs: 180000,
  // 主对话里的进度行（1/3 读取上下文、2/3 模型分析、3/3 澄清提问）。
  // 默认开启；关掉后 AUTO 每轮只留「结果」一行（错误行不受影响），
  // 用来压掉复查时指出的“每轮 4~5 条额外对话行”噪声。
  showProgress: true,
  // 上下文采样：从 8×400 降到 5×280，prompt 更短 → 首 token 更快。
  contextItems: 5,
  contextItemChars: 280,
  // 手动快速模式（默认关闭）：置空时手动点击仍用右侧选择器选中的模型；
  // 两个都填上时，手动点击改用这对更快/更便宜的 provider+model。
  fastProvider: '',
  fastModel: '',
  // AUTO 也用快速路由（默认关闭）：打开且 fastProvider/fastModel 都填时，
  // 自动模式逐条付费的那次旁路调用也改走快速路由——AUTO 的“每轮全价税”
  // 由此可用便宜/快的模型来付（2026-10-30 复查提出的成本点）。
  autoFast: false,
  // 耗时打点落盘路径（空 = 不落盘）。填了就按行追加 JSON，便于外部比对。
  timingLog: '',
};

function clampInt(value, dflt, lo, hi) {
  return typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi ? value : dflt;
}
function bool(value, dflt) {
  return typeof value === 'boolean' ? value : dflt;
}
function resolveConfig(raw) {
  const r = raw ?? {};
  return {
    enabled: bool(r.enabled, DEFAULTS.enabled),
    auto: bool(r.auto, DEFAULTS.auto),
    askBlocking: bool(r.askBlocking, DEFAULTS.askBlocking),
    minChars: clampInt(r.minChars, DEFAULTS.minChars, 1, 200),
    maxInputChars: clampInt(r.maxInputChars, DEFAULTS.maxInputChars, 100, 100000),
    timeoutMs: clampInt(r.timeoutMs, DEFAULTS.timeoutMs, 1000, 120000),
    maxOutputTokens: clampInt(r.maxOutputTokens, DEFAULTS.maxOutputTokens, 64, 8192),
    askTimeoutMs: clampInt(r.askTimeoutMs, DEFAULTS.askTimeoutMs, 5000, 600000),
    showProgress: bool(r.showProgress, DEFAULTS.showProgress),
    contextItems: clampInt(r.contextItems, DEFAULTS.contextItems, 0, 40),
    contextItemChars: clampInt(r.contextItemChars, DEFAULTS.contextItemChars, 50, 4000),
    fastProvider: typeof r.fastProvider === 'string' ? r.fastProvider.trim() : DEFAULTS.fastProvider,
    fastModel: typeof r.fastModel === 'string' ? r.fastModel.trim() : DEFAULTS.fastModel,
    autoFast: bool(r.autoFast, DEFAULTS.autoFast),
    timingLog: typeof r.timingLog === 'string' ? r.timingLog.trim() : DEFAULTS.timingLog,
  };
}

/** 一条消息的纯文本（只拼 text block）。 */
function textOf(message) {
  const parts = [];
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** 本轮新到达的人类输入。内核各来源实测为 user / steer / goal-round（机器驱动，跳过）。 */
function isFreshHumanMessage(message) {
  const kind = message?.source?.kind;
  return kind === 'user' || kind === 'steer';
}

const SYSTEM_PROMPT = [
  '你是提示词优化与澄清助手（prompt clarifier）。用户即将向编程助手发送一条指令；你的任务：',
  '1. optimized：在完全保留用户原意的前提下，把这条指令改写得更清晰、可执行——把上下文中已经明确但输入里缺失的信息（文件、目标、约束）补出来，理清含糊措辞，组织成简短的分点描述。不得新增用户未要求的范围、功能或技术选型。若原输入已经清晰具体，optimized 原样返回。',
  '2. 判断是否存在“缺少就无法开工”的歧义：目标或范围有多种合理理解、缺少关键决策且无法从上下文推断。有则 needs_clarification=true，并在 questions 中给出至多 3 个简短、自包含的问题；每题 2-4 个互斥候选项（options，label 面向用户，不用内部术语），用户也可以自行填写。能从上下文合理推断的不要问。',
  '3. 输入中的 @路径 与 /命令 token 必须原样保留在 optimized 中。',
  '只输出一个 JSON 对象，不要任何其他文本或 Markdown 代码围栏。JSON 形如：',
  '{"optimized": string, "needs_clarification": boolean, "questions": [{"id": string, "question": string, "options": [{"label": string, "description": string}]}], "notes": string}',
  '用用户输入所用的语言输出。',
].join('\n');

/** 旁路分析选最低推理档：只从该模型自己的 efforts 里挑，避免
 *  UNSUPPORTED_REASONING_EFFORT。模型不声明推理档位时返回 undefined（尊重默认）。
 *  2026-10-29 实测：不降级时继承会话的 high 档，一条小 JSON 分析被拖到超时 aborted。 */
const LIGHT_EFFORT_ORDER = ['none', 'off', 'disabled', 'minimal', 'low', 'medium'];
function lightReasoningEffort(modelInfo) {
  const efforts = modelInfo?.reasoning?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return void 0;
  const ids = new Set(efforts.map((effort) => effort.id));
  const defaultEffort = modelInfo?.reasoning?.defaultEffort;
  for (const candidate of LIGHT_EFFORT_ORDER) {
    if (ids.has(candidate)) return candidate;
  }
  // 档位命名不常见（比如自定义 id）：拿列表第一个，它至少是模型支持的。
  if (efforts.length > 1) return efforts[0].id;
  return defaultEffort !== void 0 ? void 0 : efforts[0].id;
}

/** 尽力解析模型返回的 JSON（容忍围栏与前后杂讯）。 */
function parseModelJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 规整问题列表（客户端/模型来源都过这里）。 */
function normalizeQuestions(rawList) {
  const questions = [];
  for (const raw of (Array.isArray(rawList) ? rawList : []).slice(0, 3)) {
    if (typeof raw?.question !== 'string' || raw.question.trim() === '') continue;
    const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 4)
      .filter((o) => typeof o?.label === 'string' && o.label.trim() !== '')
      .map((o) => ({
        label: String(o.label).trim().slice(0, 120),
        ...(typeof o.description === 'string' && o.description.trim() !== ''
          ? { description: o.description.trim().slice(0, 300) }
          : {}),
      }));
    questions.push({
      id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().slice(0, 40) : `q${questions.length + 1}`,
      question: raw.question.trim().slice(0, 400),
      ...(options.length > 0 ? { options } : {}),
    });
  }
  return questions;
}

/** 校验并规整分析结果；不合法返回 null。 */
function normalizeReview(parsed, config) {
  if (parsed === null) return null;
  const optimized = typeof parsed.optimized === 'string' ? parsed.optimized.trim() : '';
  if (optimized === '') return null;
  const questions = normalizeQuestions(parsed.questions);
  return {
    optimized: optimized.slice(0, config.maxInputChars + 2000),
    needsClarification: parsed.needs_clarification === true && questions.length > 0,
    questions,
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim().slice(0, 500) : '',
  };
}

/** 一次有截止期的执行：超时与外层取消都让 fn 收到 aborted signal。 */
async function withDeadline(fn, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('prompt-clarifier: analysis timeout')), timeoutMs);
  const onOuterAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener?.('abort', onOuterAbort);
  }
}

/** 手写 state schema：registry 只在 checkpoint 恢复时调用 .parse。 */
const transcriptStateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.items)) {
      throw new Error('prompt-clarifier: invalid projection checkpoint shape');
    }
    for (const item of value.items) {
      if (item === null || typeof item !== 'object'
        || typeof item.role !== 'string' || typeof item.text !== 'string') {
        throw new Error('prompt-clarifier: invalid projection checkpoint item');
      }
    }
    return value;
  },
};

export function apply(ctx, rawConfig) {
  // 激活期绝不抛出：2026-10-29 实证，桌面端把“1 entry did not activate”当致命错误
  // 直接崩掉启动，并触发自动恢复（重置 profile 配置、剔除 bundle）。
  // 插件内部任何失败都只降级为“功能缺席”，日志留痕。
  try {
    applyInner(ctx, rawConfig);
  } catch (error) {
    try { ctx.logger?.error?.(`prompt-clarifier: activation failed, staying inactive: ${error?.stack ?? error}`); } catch { /* ignore */ }
  }
}

function applyInner(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  // 自动模式的运行时开关：null = 跟随配置；true/false = 用户在界面上显式开关过。
  // 放在内存里（不写配置文件），避免插件去改用户配置；页面每次挂载会重新同步一次。
  // 按会话各存一份（autoOverrides）：两个浏览器标签页各自切换 AUTO 时
  // 不再互相覆盖（2026-10-30 复查提出的“单值开关被最后推送者赢得”问题）。
  // 空字符串键 = 全局默认覆盖（不带 sessionId 的 setAuto，保持向后兼容）。
  let autoOverride = null;
  const autoOverrides = new Map();
  const autoEnabled = (sessionId) => {
    const per = sessionId === undefined ? undefined : autoOverrides.get(sessionId);
    if (per !== undefined) return per;
    return autoOverride === null ? config.auto : autoOverride;
  };
  // 最近一次「自动模式」分析结果（按会话），供客户端在发送后取回并弹出面板。
  // 只在内存里、按会话覆盖、最多 64 个会话、5 分钟过期。
  const autoReviews = new Map();
  function rememberAutoReview(sessionId, text, review) {
    try {
      autoReviews.set(sessionId, { text, review, at: Date.now() });
      if (autoReviews.size > 64) {
        const oldest = autoReviews.keys().next().value;
        if (oldest !== undefined) autoReviews.delete(oldest);
      }
    } catch { /* 记不上不影响分析 */ }
  }
  function latestAutoReview(sessionId, text) {
    const entry = autoReviews.get(sessionId);
    if (entry === undefined) return null;
    if (Date.now() - entry.at > 5 * 60 * 1000) { autoReviews.delete(sessionId); return null; }
    if (typeof text === 'string' && text !== '' && entry.text !== text) return null;
    return entry;
  }
  if (!config.enabled) return;

  // 正在分析的会话（sessionId → { text, startedAt }）：客户端据此决定按钮要不要进
  // 「优化中」。**必须由 Host 说**：普通消息提交时宿主的 input.phase 一直是 plain
  // （uic-client.js 的 beginDetached 注释：mint an ordinary send that leaves the phase
  // plain），只有斜杠命令的 claim 才会走到 adjudicating/submitting，所以客户端拿
  // phase 判断不了"这条普通消息发出去了没有"。草稿清空又会被输入法/回车误触发。
  const pendingAnalyses = new Map();

  // ---- 会话上下文投影（practices.md：派生状态进 projection，不 rescan 日志） ----
  ctx.effect(() => ctx.sessionProjections.register({
    key: 'promptClarifierTranscript',
    // 采样范围改了（不再收自己注入的 prompt-clarifier 提示）→ 按 practices.md:27 bump
    // stateVersion，让旧的 checkpoint 作废重放。v3 还额外排除 source.form 以 'prompt-clarifier:'
    // 开头的 assistant/message 行——这是防御性的：当前可见播报走 command 事件（根本不被本投影
    // 采样），但若将来换回助手气泡通道，这条排除能防止播报文本回灌进下一轮分析上下文。
    stateVersion: 3,
    stateSchema: transcriptStateSchema,
    init: () => ({ items: [] }),
    apply(state, event) {
      let items = null;
      if (event.type === 'user/message') {
        const kind = event.data.source?.kind;
        const form = event.data.source?.form;
        // 只收真正的人类输入（user / steer）和用户在提问卡上的作答
        // （user-question-reply）。**不含 kind === 'prompt-clarifier'**：
        // 那是本插件自己注入给模型的 refine/clarify/assume 提示，内核会把
        // decision.messages 落进会话日志（agent-loop.js:1067 起），收进来就等于
        // “拿自己上一轮的改写当上下文”，越改越偏（2026-10-30 复查 P1-4）。
        // 同理排除自己 append 到日志的可见行（kind='user' 但 form='prompt-clarifier:*'）。
        const mine = typeof form === 'string' && form.startsWith('prompt-clarifier:');
        if (!mine && (kind === 'user' || kind === 'steer' || kind === 'user-question-reply')) {
          const text = textOf(event.data);
          if (text.trim() !== '') {
            items = [...state.items, { role: 'user', text: text.slice(0, config.contextItemChars) }];
          }
        }
      } else if (event.type === 'assistant/message') {
        // 同样排除本插件自己 append 的可见播报行（assistant/message，source.form 以
        // 'prompt-clarifier:' 开头）：它进得了会话日志就会被 deriveMessages 喂给模型，
        // 也会被这里当上下文采样 → 拿自己上一轮的播报当输入，越改越偏（P1-4）。
        const aform = event.data?.message?.source?.form;
        const mineAssistant = typeof aform === 'string' && aform.startsWith('prompt-clarifier:');
        if (!mineAssistant) {
          const text = textOf(event.data?.message);
          if (text.trim() !== '') {
            items = [...state.items, { role: 'assistant', text: text.slice(0, config.contextItemChars) }];
          }
        }
      }
      if (items === null) return state;
      const cap = Math.max(2, config.contextItems);
      if (items.length > cap) items = items.slice(items.length - cap);
      return { items };
    },
  }), 'prompt-clarifier:projection');

  function contextText(session) {
    const items = ctx.sessionProjections.stateOf(session, 'promptClarifierTranscript')?.items ?? [];
    if (items.length === 0) return '(no earlier context — this may be a new session)';
    return items.map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`).join('\n');
  }

  /** 路由：本会话最近一次 request/header，其次全局默认模型。 */
  function routeFor(session) {
    const header = session.requestHeader?.();
    if (typeof header?.config?.provider === 'string' && typeof header?.config?.model === 'string') {
      return { provider: header.config.provider, model: header.config.model };
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
      return { provider: selection.provider, model: selection.model };
    }
    return null;
  }

  /**
   * 解析本次请求实际使用的模型路由。
   * - `{ provider, model }`：以它为准——客户端在点击瞬间读取右侧模型选择器的
   *   实时选中值（`modelSelection` 投影的 `next`）后随请求一起送来。
   *   仍要校验 provider 已注册，避免把无效路由交给 prepareCall。
   * - `null`：客户端明确报告“没有选中可用模型”→ 返回 null，上层回
   *   `no-model-route`，由界面提示先选模型。
   * - `undefined`：请求方没提供（Agent 工具路径）→ 回退到会话路由。
   */
  function routeForRequest(session, requested) {
    if (requested === null) return null;
    if (requested !== undefined) {
      const { provider, model } = requested;
      if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null;
      let registered = null;
      try {
        const providers = ctx.llm.listProviders();
        if (Array.isArray(providers) && providers.length > 0) {
          registered = providers.map((entry) => entry?.id).filter((id) => typeof id === 'string');
        }
      } catch { registered = null; }
      if (registered !== null && !registered.includes(provider)) return null;
      return { provider, model };
    }
    return routeFor(session);
  }

  /**
   * 聚合旁路流文本（text-delta；无 delta 回退 block-end）。
   * `onDelta` 每收到一段就回调累计文本，用于"首个完整 JSON 就收流"。
   */
  async function streamText(stream, onDelta) {
    const deltas = [];
    const blocks = [];
    let finish = null;
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        deltas.push(chunk.text ?? '');
        if (onDelta !== undefined && onDelta(deltas.join('')) === true) return deltas.join('');
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.push(chunk.block.text ?? '');
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      throw new Error(`prompt-clarifier: auxiliary stream ended (${finish.kind}: ${finish.failure?.message ?? ''})`);
    }
    return deltas.join('') || blocks.join('');
  }

  /** 从累计文本里找出**第一个完整**的 JSON 对象；找到就返回它，否则 undefined。 */
  function firstCompleteJsonObject(text) {
    const start = text.indexOf('{');
    if (start < 0) return void 0;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch { return void 0; }
        }
      }
    }
    return void 0;
  }

  /** 追加一行耗时记录（默认关闭；配置了 timingLog 才写，失败绝不影响主流程）。 */
  function recordTiming(entry) {
    if (typeof config.timingLog !== 'string' || config.timingLog === '') return;
    try {
      try {
        if (statSync(config.timingLog).size > 512 * 1024) writeFileSync(config.timingLog, '');
      } catch { /* 文件还不存在，首次写入即可 */ }
      appendFileSync(config.timingLog, `${JSON.stringify(entry)}\n`);
    } catch { /* 打点失败不影响分析 */ }
  }

  /** 共享操作 1：按会话上下文分析并改写一条提示词。 */
  async function opAnalyze(session, text, outerSignal, opts = {}) {
    if (typeof text !== 'string' || text.trim() === '') return { status: 'skipped', reason: 'empty' };
    // 手动模式是用户主动点的，短输入也要分析；自动模式仍跳过短到没有信息量的输入。
    if (opts.manual !== true && text.length < config.minChars) {
      return { status: 'skipped', reason: 'too-short', limit: config.minChars };
    }
    if (text.length > config.maxInputChars) {
      return { status: 'skipped', reason: 'too-long', limit: config.maxInputChars };
    }
    // 快速路由（可选，默认关闭）：配置了 fastProvider/fastModel 时，
    // 手动点击改走这条更快/更便宜的路由；autoFast=true 时自动模式
    // （每条人类消息都要付的那次旁路调用）也走它。工具路径不受影响，
    // 仍用会话路由——它是模型显式调用的，跟着会话模型走更符合预期。
    const fastOk = config.fastProvider !== '' && config.fastModel !== '';
    const fastRoute = (fastOk && (opts.manual === true || (opts.auto === true && config.autoFast === true)))
      ? { provider: config.fastProvider, model: config.fastModel }
      : null;
    // 手动按钮路径由客户端送来右侧选择器的实时选中值；自动与工具路径不送，回退会话路由。
    const route = fastRoute ?? routeForRequest(session, opts.route);
    if (route === null) return { status: 'skipped', reason: 'no-model-route' };

    const startedAt = Date.now();
    let contextReadyAt = startedAt;
    const context = contextText(session);
    contextReadyAt = Date.now();

    let preparedAt = 0;
    let firstTokenAt = 0;
    let earlyExit = false;
    const userText = `会话近期上下文：\n${context}\n\n待优化的用户输入：\n${text}`;
    // 两次尝试：第一次用配置额度 + 最低推理档（快）；如果模型一个字都没吐出来
    // （2026-10-29 实测：输出预算被思考吃满会导致 outChars=0，于是既没注入也没问答卡），
    // 就再用**更大额度、不强制降档**重试一次。只在“完全没输出”时重试，
    // 有内容但解析不了不重试，避免重复烧时间。
    const attempts = [
      { maxTokens: config.maxOutputTokens, light: true },
      { maxTokens: Math.max(config.maxOutputTokens, 2048), light: false },
    ];
    let output = '';
    let attemptUsed = 0;
    for (let i = 0; i < attempts.length; i += 1) {
      const plan = attempts[i];
      attemptUsed = i + 1;
      preparedAt = 0;
      firstTokenAt = 0;
      earlyExit = false;
      output = await withDeadline(async (signal) => {
        // configure 回调：显式给旁路分析选最低推理档。不选的话，
        // prepareCall 会按路由 defaultEffort 补上会话同款的高档（2026-10-29 实测
        // “分析很慢最后 aborted”的根因：小 JSON 任务被拉去深度思考）。
        // 与 dsh-session-title-llm 的 selectReasoningEffort 同一正规做法；
        // 重试那次不再降档，避免“降档后模型直接不输出”这种极端情况。
        const configure = plan.light
          ? (controls, modelInfo) => {
            const effort = lightReasoningEffort(modelInfo);
            return { ...controls, ...(effort === void 0 ? {} : { reasoningEffort: effort }) };
          }
          : void 0;
        const call = await ctx.llm.prepareCall({ ...route, maxTokens: plan.maxTokens }, signal, configure);
        preparedAt = Date.now();
        const messages = [{
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: userText }],
          source: { kind: 'prompt-clarifier' },
        }];
        const options = {
          ...call.config,
          messages,
          system: SYSTEM_PROMPT,
          sessionId: session.id,
          purpose: 'prompt-clarifier',
          signal,
        };
        // 首个完整 JSON 一到就停止读流：模型常在 JSON 之后继续补解释，
        // 那些 token 我们本来就不用，等它只会白等。
        return streamText(call.stream(options), (accumulated) => {
          if (firstTokenAt === 0) firstTokenAt = Date.now();
          if (firstCompleteJsonObject(accumulated) === void 0) return false;
          earlyExit = true;
          return true;
        });
      }, config.timeoutMs, outerSignal);
      if (output.trim() !== '') break;
    }
    const finishedAt = Date.now();
    const timing = {
      total: finishedAt - startedAt,
      context: contextReadyAt - startedAt,
      prepare: preparedAt === 0 ? -1 : preparedAt - contextReadyAt,
      firstToken: firstTokenAt === 0 ? -1 : firstTokenAt - (preparedAt === 0 ? contextReadyAt : preparedAt),
      stream: firstTokenAt === 0 ? -1 : finishedAt - firstTokenAt,
      earlyExit,
      attempt: attemptUsed,
      provider: route.provider,
      model: route.model,
      fast: fastRoute !== null,
      promptChars: userText.length,
      outChars: output.length,
    };
    const review = normalizeReview(parseModelJson(output), config);
    if (review === null) {
      // 空输出与“有内容但解析不了”分开报，便于定位（前者多半是预算/思考问题）。
      const reason = output.trim() === '' ? 'empty-model-output' : 'unparseable-model-output';
      recordTiming({ at: new Date().toISOString(), kind: 'analyze', status: 'failed', reason, ...timing });
      return { status: 'failed', reason, timing };
    }
    const okTiming = {
      ...timing,
      needsClarification: review.needsClarification === true,
      questions: Array.isArray(review.questions) ? review.questions.length : 0,
    };
    recordTiming({ at: new Date().toISOString(), kind: 'analyze', status: 'ok', ...okTiming });
    return { status: 'ok', ...review, timing: okTiming };
  }

  /** 共享操作 2：用原生提问卡片向用户澄清，返回整理好的答案文本（无答案 null）。 */
  async function opAsk(questions, agent, signal, timeoutMs, callId) {
    const userQuestions = ctx.get('userQuestions');
    if (questions.length === 0) return null;
    if (userQuestions === undefined) {
      // 这条以前是静默返回 null（问答卡片不出现却查不到原因）。
      ctx.logger?.warn?.('prompt-clarifier: userQuestions service unavailable on this Host — question card skipped');
      return null;
    }
    let answered;
    try {
      const request = {
        questions: questions.map((q) => ({
          id: q.id,
          question: q.question,
          ...(q.options === undefined ? {} : { options: q.options }),
        })),
        signal,
        ...(agent === undefined ? {} : { agent }),
      };
      // 自动模式走限时提问：无人作答时模型照常放行，绝不把回合卡死。
      answered = timeoutMs === undefined
        ? await userQuestions.ask(request)
        : await userQuestions.askTimed(request, String(callId ?? `prompt-clarifier:${Date.now()}`), timeoutMs);
      if (answered?.pending === true) return null;
    } catch (error) {
      ctx.logger?.info?.(`prompt-clarifier: ask released: ${error?.message ?? error}`);
      return null;
    }
    const byId = new Map(questions.map((q) => [q.id, q]));
    const lines = [];
    for (const item of answered?.answers ?? []) {
      const q = byId.get(item?.id);
      if (q === undefined) continue;
      const given = typeof item.custom === 'string' && item.custom.trim() !== ''
        ? item.custom.trim()
        : (item.selected ?? []).join('、');
      if (given === '') continue;
      lines.push(`关于“${q.question}”：${given}`);
    }
    return lines.length === 0 ? null : lines.join('\n');
  }

  // ---- 去重：消息 id 全局唯一（小集合上限） ----
  const analyzed = new Set();
  function markAnalyzed(id) {
    analyzed.add(id);
    if (analyzed.size > 512) {
      for (const old of analyzed.keys()) {
        analyzed.delete(old);
        if (analyzed.size <= 256) break;
      }
    }
  }

  // ---- 自动模式：agent/pre-step 闸门（fail-open） ----
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, messages, step, turn, signal }, next) => {
    if (step !== 1) return next();
    if (!autoEnabled(agent?.session?.id)) {
      // 明确记录“因为自动模式是关的所以没分析”，便于排查“没反应”。
      if (messages.some(isFreshHumanMessage)) {
        ctx.logger?.info?.('prompt-clarifier: auto mode is OFF — skipping analysis for this message');
      }
      return next();
    }
    const candidate = messages.find(isFreshHumanMessage);
    if (candidate === undefined || typeof candidate.id !== 'string') return next();
    if (analyzed.has(candidate.id)) return next();
    const text = textOf(candidate);
    if (text.trim().startsWith('/')) {
      markAnalyzed(candidate.id);
      return next();
    }
    // 只服务顶层 agent：子代理的提示是机器生成的，且 ask() 会拒绝被持有的 agent。
    if (!ctx.agents.roots().some((root) => root === agent)) return next();
    const decision = await next();
    if (decision.kind !== 'enter' || signal?.aborted === true) return decision;
    // 到这里本轮**确实要进入执行**了才登记去重。以前在 next() 之前就登记，
    // reject / 已中断 / 非顶层这些路径会把这条消息永久拉黑，之后同一 turn 被
    // 重新 claim（比如中断后重发）时再也不会分析（2026-10-30 复查 P1-5）。
    markAnalyzed(candidate.id);

    /** 一条提示消息。`source.kind` 决定它走哪条通道（见下）。 */
    const notice = (form, body, kind = 'prompt-clarifier') => ({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: {
        kind,
        form: kind === 'user' ? `prompt-clarifier:${form}` : form,
        sourceMessageId: candidate.id,
      },
    });
    // 关键：想让人在主对话看见，必须自己往会话日志 append 一条会渲染成对话行的事件。
    // 走过的弯路（都验证过）：
    //  · user/message + kind='user'：渲染成**用户气泡**，语义不对（这是助手侧播报）。
    //  · assistant/message + surfaceOp:'append' + (turn, step:0)：是真助手气泡，但经只读
    //    核查（chat-client/uic-client）在**直播时不可见** —— assistantDefinition 只有当
    //    位置解析成 step 草稿才出行，而 step 草稿只由内核 step/start 建立；直播时
    //    (T,0) 落到 turn 位置 → buildViewNode 返回 null → 只有刷新该会话页面（rebuild）才出现。
    //    对"实时进度"这条硬需求，方案不成立，遂弃用。
    // 现方案：command/run + command/done（与 dsh-qoder-connect 的 token-hint 同款形状，
    //  线上+刷新都稳定显示）。要点：
    //  · 一条播报 = 一个 commandId（本轮唯一，复用同一 id 累积），command/done 是 update，
    //    客户端取最新 text → 阶段合并进同一个小卡片行；
    //  · command 事件**不带 surfaceOp**（非 surface-eligible，带了会在 host 抛
    //    `'... is not surface-eligible and cannot carry surfaceOp'`），也因此**不进模型上下文**（零 token）；
    //  · 直播行锚定 turn/step:1（不带 step 会解析成 turn 位置、直播时不落进对话流）；
    //  · name 不能是 'permission'（会被隐藏）。
    const commandId = `prompt-clarifier:${candidate.id}`;
    // 落位锚点：锚 {turn, step:1}。pre-step 时本轮首个 step/start 还没写、currentStep 为
    // undefined，不显式给 step 会被 payloadCoordinates 解析成 {kind:"turn"} 而不落进对话流；
    // 给了 (turn,1) 就命中 (turn,1) 的 step 草稿（草稿由带 turn+step 的任意事件建立，
    // step/start 稍后到来并入同一草稿）。
    // 回合结束后这些行会随「思考过程」折叠（客户端 foldCompletedTurns；用户明确要求保留在
    // 思考过程区，不再额外补一张独立卡片）。
    const anchorTurn = typeof turn === 'number' ? turn : 0;
    const noticeLines = [];
    let commandStarted = false;
    const appendNotice = (form, body) => {
      noticeLines.push(body);
      const text = noticeLines.join('\n\n');
      try {
        if (!commandStarted) {
          agent.session.append('command/run', {
            commandId,
            name: '提示词优化',
            turn: anchorTurn,
            step: 1,
            source: { kind: 'user' },
          });
          commandStarted = true;
        }
        agent.session.append('command/done', {
          commandId,
          turn: anchorTurn,
          step: 1,
          kind: form === 'error' ? 'error' : 'success',
          text,
        });
      } catch (error) {
        // 追加失败只降级为「不可见」，绝不影响本轮对话（qoder 同款防护）。
        ctx.logger?.warn?.(`prompt-clarifier: could not append notice (${error?.message ?? error})`);
      }
      return { synthetic: true, form, text: body };
    };

    const withNotices = (notices) => (notices.length === 0
      ? decision
      : { ...decision, messages: [...decision.messages, ...notices] });
    // 失败也要在主对话里说清楚（用户要求：显示错误并恢复按钮）。
    const failureText = (reason) => {
      switch (reason) {
        case 'no-model-route': return '没有可用的模型路由（请先在右侧模型选择器里选一个模型）。';
        case 'empty-model-output': return '模型这次没有返回内容（输出预算可能被思考占满）。';
        case 'unparseable-model-output': return '模型返回的内容无法解析。';
        case 'too-short': return '输入太短，未做分析。';
        case 'too-long': return '输入过长，已跳过分析。';
        default: return `分析失败（${String(reason ?? '未知原因')}）。`;
      }
    };

    // 告诉客户端「这段文本正在分析」：这是按钮进入「优化中」的唯一依据（见 pendingAnalyses
    // 的注释）。放在分析之前登记，分析结束（成功/跳过/失败）都在返回前清掉。
    const pendingKey = typeof agent.session.id === 'string' ? agent.session.id : '';
    const clearPending = () => { try { pendingAnalyses.delete(pendingKey); } catch { /* 清不掉不影响本轮 */ } };
    pendingAnalyses.set(pendingKey, { text: text.trim(), startedAt: Date.now() });
    let review;
    try {
      review = await opAnalyze(agent.session, text, signal, { auto: true });
    } catch (error) {
      clearPending();
      if (signal?.aborted === true) return decision;
      ctx.logger?.warn?.(`prompt-clarifier: analysis failed (fail-open): ${error?.message ?? error}`);
      // 失败提示走会话日志（这样主对话里看得见）；本轮请求不受影响。
      appendNotice('error', `【提示词优化·错误】${failureText(error?.message ?? error)}\n本轮按原始输入继续。`);
      return decision;
    }
    if (review.status !== 'ok') {
      // 以前这里静默放行，导致“自动模式没反应”无从排查；至少留一条可检索的日志。
      ctx.logger?.warn?.(`prompt-clarifier: auto analysis not applied (${review.status}/${review.reason ?? '-'}, outChars=${review.timing?.outChars ?? '-'}, attempt=${review.timing?.attempt ?? '-'})`);
      // 按设计就该跳过的（太短/太长/空）不打扰用户；只有真失败才在主对话里报错。
      const silent = review.reason === 'too-short' || review.reason === 'too-long' || review.reason === 'empty';
      if (!silent) appendNotice('error', `【提示词优化·错误】${failureText(review.reason)}\n本轮按原始输入继续。`);
      // 给客户端一个**没有 questions 的占位结果**：它靠 latestAuto 判断“这轮还要不要等”。
      // 不缓存的话，短输入的发送会让按钮一直「优化中…」到轮询预算耗尽（现在预算跟随
      // 服务端最坏耗时 = timeoutMs×2，比原先的 36s 更长）。
      rememberAutoReview(agent.session.id, text.trim(), { status: review.status, reason: review.reason, questions: [] });
      clearPending();
      // **必须在这里返回。** skipped/failed 的返回值没有 optimized 字段（opAnalyze 只在
      // status==='ok' 时铺开 review），继续往下走会在 review.optimized.trim() 上抛
      // TypeError；pre-step 监听器抛出没有 per-listener 兜底（cordis waterfall），
      // 会被 agent-loop turn() 转成 turnEnds{kind:'error'} —— 用户那一轮整个被打死，
      // 而提示行还写着“本轮按原始输入继续”，自相矛盾（2026-10-30 复查确认的 P0）。
      return decision;
    }
    // 记下这次结果，客户端在发送后会取回并弹出优化面板（AUTO 也可见改写稿）。
    // askBlocking 打开时提问卡片已经在这一轮里弹过并等过答复，客户端再开面板
    // 就是第二套澄清 UI —— 缓存里剥掉 questions，面板只在 askBlocking 关闭时出现。
    rememberAutoReview(agent.session.id, text.trim(),
      config.askBlocking === true ? { ...review, questions: [] } : review);
    // 结果已可被客户端取回 → 从现在起按钮该由「轮询拿到结果」收尾，而不是 pending。
    clearPending();
    const notices = [];
    const trimmed = text.trim();
    const t = review.timing ?? {};
    // ---- 进度（主对话可见）：三条独立消息，依次 append 到会话日志 ----
    // showProgress=false 时整段跳过：AUTO 每轮只剩「结果」一行，压掉复查指出的
    // “每轮 4~5 条额外对话行”噪声。错误行不受这个开关影响。
    const showProgress = config.showProgress === true;
    if (showProgress) {
      const contextItems = ctx.sessionProjections.stateOf(agent.session, 'promptClarifierTranscript')?.items ?? [];
      appendNotice('progress', `【提示词优化·1/3 读取上下文】完成：${contextItems.length} 条 / ${contextItems.reduce((n, it) => n + it.text.length, 0)} 字（${t.context ?? 0}ms）`);
      appendNotice('progress', `【提示词优化·2/3 模型分析】${t.provider ?? '?'}/${t.model ?? '?'}：首 token ${t.firstToken ?? -1}ms，总 ${t.total ?? 0}ms${t.attempt > 1 ? `（第 ${t.attempt} 次尝试）` : ''}`);
    }
    const optimizedText = review.optimized.trim();

    // ---- 给模型的指令（只进本轮请求，不显示为对话行）----
    if (optimizedText !== '' && optimizedText !== trimmed) {
      notices.push(notice('refine', `请按以下更明确的目标执行（原始输入已在上方保留）：
${optimizedText}`));
    }
    if (review.needsClarification) {
      if (config.askBlocking) {
        let answerText = null;
        try {
          // 限时等待：默认 3 分钟内无人作答就放行，把回合卡死比漏问更糟。
          answerText = await opAsk(review.questions, agent, signal, config.askTimeoutMs, candidate.id);
        } catch (error) {
          if (signal?.aborted === true) return decision;
          ctx.logger?.warn?.(`prompt-clarifier: ask failed (continue without): ${error?.message ?? error}`);
        }
        if (answerText !== null) {
          notices.push(notice('clarify', `【用户已澄清】以下回答来自用户在提问卡片上的确认，视为本轮指令的正式组成部分：
${answerText}`));
        } else if (review.notes !== '') {
          notices.push(notice('assume', `【待确认假设】输入存在歧义而用户未作答，助手先按以下假设继续，若有误请在结果中说明：${review.notes}`));
        }
      } else if (review.notes !== '') {
        notices.push(notice('assume', `【待确认假设】输入存在歧义，助手按以下假设继续，若有误请在结果中说明：${review.notes}`));
      }
    }
    // 澄清结论要等提问结束才准确 → 现在才 append 第三条（含结论），再 append 结果。
    // 顺序：1/3 → 2/3 → 3/3（含结论）→ 结果，与用户看到的时间线一致。
    const answered = notices.some((n) => n.source.form === 'clarify');
    if (showProgress) {
      const clarifyOutcome = review.needsClarification
        ? `模型提出 ${Array.isArray(review.questions) ? review.questions.length : 0} 个问题${answered ? '，已收到回答' : '，未作答（按假设继续）'}`
        : '无需提问';
      appendNotice('progress', `【提示词优化·3/3 澄清提问】${clarifyOutcome}`);
    }
    if (optimizedText !== '' && optimizedText !== trimmed) {
      appendNotice('result', `【提示词优化·结果】状态：已改写（${trimmed.length} 字 → ${optimizedText.length} 字）\n优化后的提示词：\n${optimizedText}`);
    } else if (review.needsClarification) {
      // 没改写但问了问题：结果行要说明这轮做了什么，否则 showProgress 关掉时
      // 主对话里一句提示都没有，看上去像“没反应”。
      appendNotice('result', `【提示词优化·结果】状态：无需改写，已${answered ? '收到澄清回答' : '发起澄清提问'}（${Array.isArray(review.questions) ? review.questions.length : 0} 个问题）`);
    } else {
      appendNotice('result', '【提示词优化·结果】状态：无需改写（当前输入已足够清晰）');
    }
    return withNotices(notices);
  }), 'prompt-clarifier:auto');

  // ---- Agent 工具：与 UI 动作同一操作（“one operation, two callers”） ----
  ctx.effect(() => ctx.tools.register({
    name: 'prompt_clarifier_review',
    description: '按当前会话上下文优化一条提示词草稿，并找出需要向用户澄清的歧义点（旁路分析，不发送消息）。Review and clarify a prompt draft against session context.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要优化的提示词文本' },
        askUser: { type: 'boolean', description: '发现阻塞性歧义时，用提问卡片向用户澄清并等待回答' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { status: { type: 'string' }, optimized: { type: 'string' } } },
      render: (_args, value) => [{
        type: 'text',
        text: value.status !== 'ok'
          ? `未分析（${value.reason ?? 'unknown'}）`
          : `优化后：\n${value.optimized}`
            + (value.needsClarification
              ? `\n\n需要澄清：\n${value.questions.map((q) => `- ${q.question}`).join('\n')}`
              : '')
            + (value.answerText ? `\n\n用户澄清：\n${value.answerText}` : ''),
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) return { status: 'failed', reason: 'requires an Agent-backed session' };
      // manual:true —— 工具调用是模型显式发起的，短草稿也要分析；不加就会被
      // minChars 门挡回来一个 too-short（2026-10-30 复查 P2）。
      // 路由沿用「手动」语义：配了 fastProvider/fastModel 就走快速路由（与手动按钮一致），
      // 不传 auto:true，所以不受 autoFast 开关影响。
      const review = await opAnalyze(agent.session, String(args.text ?? ''), exec.signal, { manual: true });
      if (review.status !== 'ok') return review;
      if (args.askUser !== true || review.needsClarification !== true) return review;
      const answerText = await opAsk(review.questions, agent, exec.signal);
      return answerText === null ? review : { ...review, answerText };
    },
  }), 'prompt-clarifier:tool');

  // ---- HTTP 路由：Client 半按钮走这条（同域，浏览器 Cookie 已鉴权） ----
  // connection 必须经 ctx.inject 声明：它在我的 bundle 行之后才挂载，
  // apply 里同步 ctx.get('connection') 拿到 undefined，会静默降级成
  // “手动按钮 404、自动模式正常”（2026-10-29 用户实测就是这个现象）。
  ctx.inject(['connection'], (cctx) => {
    const connection = cctx.connection;
    if (connection?.fetch?.register === undefined) {
      cctx.logger?.warn?.('prompt-clarifier: connection.fetch unavailable — manual UI disabled.');
      return;
    }
    cctx.effect(() => connection.fetch.register({
      path: '/api/prompt-clarifier',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') {
          // 诊断端点：不花 LLM 调用就能确认插件活着、用什么路由、预算多少。
          // ?sessionId=... 时返回**那个会话**的有效自动开关（多标签页各切各的）。
          // request.url 在测试替身里可能缺席，所以不依赖 URL 解析。
          const raw = typeof request.url === 'string' ? request.url : '';
          const qIndex = raw.indexOf('?');
          const sidParam = qIndex === -1 ? ''
            : new URLSearchParams(raw.slice(qIndex + 1)).get('sessionId') ?? '';
          const sid = sidParam !== '' ? sidParam : undefined;
          const defaultSelection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null;
          return Response.json({
            ok: true,
            auto: autoEnabled(sid),
            autoConfigured: config.auto,
            askBlocking: config.askBlocking,
            showProgress: config.showProgress,
            timeoutMs: config.timeoutMs,
            maxOutputTokens: config.maxOutputTokens,
            // 服务端最坏耗时：两次尝试各占一个 timeoutMs。客户端轮询预算按这个数对齐，
            // 否则慢模型（实测首 token 4~21s）必然在面板预算内取不到结果。
            analysisBudgetMs: config.timeoutMs * 2,
            fastRoute: config.fastProvider !== '' && config.fastModel !== ''
              ? { provider: config.fastProvider, model: config.fastModel, auto: config.autoFast }
              : null,
            defaultModel: defaultSelection
              ? { provider: defaultSelection.provider, model: defaultSelection.model }
              : null,
          });
        }
        const body = await request.json().catch(() => null);
        // 自动模式开关：界面上的「自动」按钮调用它。只改内存，不动配置文件。
        // 带 sessionId 时只改这个会话（两个标签页各切各的，不再互相覆盖）；
        // 不带则改全局运行时覆盖（老行为，向后兼容）。
        if (body?.action === 'setAuto') {
          const on = body.enabled === true;
          const scope = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : '';
          if (scope === '') autoOverride = on;
          else autoOverrides.set(scope, on);
          ctx.logger?.info?.(`prompt-clarifier: auto mode ${on ? 'ON' : 'OFF'} (runtime${scope === '' ? ', global' : `, session ${scope}`})`);
          return Response.json({ ok: true, auto: autoEnabled(scope === '' ? undefined : scope) });
        }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        // 取回最近一次 AUTO 分析结果（客户端在消息发出后用它弹面板）。
        if (body?.action === 'latestAuto') {
          const entry = latestAutoReview(sessionId, typeof body.text === 'string' ? body.text : '');
          // pending：Host 正在分析这段文本（客户端据此把按钮切到「优化中」）。
          // 普通消息的 input.phase 恒为 plain，草稿清空又会被输入法误触发，所以
          // 「有没有真的在优化」只能由 Host 回答。
          const pending = pendingAnalyses.get(sessionId) ?? null;
          return Response.json({
            review: entry === null ? null : entry.review,
            at: entry === null ? null : entry.at,
            pending: pending === null ? null : { text: pending.text, startedAt: pending.startedAt },
          });
        }
        const agent = sessionId === '' ? undefined : ctx.agents.get(sessionId);
        // 空闲会话没有 live agent 也可以分析：直接取内存里的 Session。
        const session = agent?.session ?? ctx.get('sessions')?.get?.(sessionId);
        if (session === undefined) {
          return Response.json({ error: 'session is not loaded on this Host' }, { status: 400 });
        }
        const action = body?.action;
        if (action === 'optimize') {
          // 模型来自右侧选择器的实时选中值（客户端随请求送来），不再用插件自带路由。
          // selectionMissing=true 表示客户端读到“当前没有选中可用模型”。
          const requested = (typeof body?.provider === 'string' && typeof body?.model === 'string')
            ? { provider: body.provider, model: body.model }
            : (body?.selectionMissing === true ? null : undefined);
          try {
            const review = await opAnalyze(session, typeof body.text === 'string' ? body.text : '', undefined, { manual: true, route: requested });
            return Response.json(review);
          } catch (error) {
            // 抛出会变成 /api 桥的 400；这里一律转成结构化失败，客户端能显示原因。
            return Response.json({ status: 'failed', reason: `analysis-error: ${error?.message ?? error}` });
          }
        }
        if (action === 'ask') {
          if (agent === undefined) {
            return Response.json({ answered: false, reason: 'asking the user needs a live agent in this session' });
          }
          const questions = normalizeQuestions(body.questions);
          try {
            const answerText = await opAsk(questions, agent, undefined, config.askTimeoutMs, `ui:${Date.now()}`);
            return Response.json(answerText === null ? { answered: false } : { answered: true, answerText });
          } catch (error) {
            return Response.json({ answered: false, reason: `ask-error: ${error?.message ?? error}` });
          }
        }
        return Response.json({ error: `unknown action: ${String(action)}` }, { status: 400 });
      },
    }), 'prompt-clarifier:http');
  });
}
