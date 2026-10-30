# Changelog

本插件的变更记录。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 0.3.4

两件事：撤销 0.3.3 的「回合收尾独立卡片」，并修复「优化中」状态不再出现。

### 撤销：回答结束不再补独立卡片

0.3.3 用 `agent/turn-stopping` 在回答之后补一张卡来绕开「思考过程」折叠。按用户要求取消：
卡片仍随回合落在「思考过程」折叠区里，不再额外播报一张。相应删除 `pendingFinalCards`
待补表、`:final` 命令 id、`agent/turn-stopping` 监听器与 CASE29。

### 修复：「优化中」状态消失

0.3.2 把触发判定改成等宿主 `input.phase` 进入 `submitting`，但宿主的**普通消息提交从不动这个
phase**——`uic-client.js` 的 `beginDetached` 注释写着 “mint an ordinary send that leaves the
phase plain”，只有斜杠命令的 claim 才走 `adjudicating`/`submitting`。于是「优化中」再也没亮过。

- **改由 Host 回答「在不在分析」**：`agent/pre-step` 真正开始分析前登记
  `pendingAnalyses.set(sessionId, { text, startedAt })`，成功/跳过/失败/中止都清除；
  `latestAuto` 回复新增 `pending` 字段（`{ text, startedAt } | null`）。
- **客户端只在 Host 确认为 pending 时点亮按钮**：草稿「有内容 → 清空」只当作一次**可疑发送**，
  越过 300ms 防抖与输入法组合窗口后发起探询；`pending.text` 与本次文本一致才 `setOptimizing(true)`
  并继续轮询结果。误触的代价只是一次本地 GET，不会亮灯。
- **12s 探询窗口**：Host 一直没开始分析就安静放弃，避免消息没发出去时轮询到预算耗尽。
- **测试**：CASE16 重写为 pending 契约（输入阶段不亮灯、真分析才亮、结果到达复位、斜杠命令连探询
  都不发）；CASE12/13 的替身改为按 pending 回复；新增 CASE30（空闲 `pending:null`、分析中
  `pending.text` 正确、分析结束必清空）。

## 0.3.2

修复「消息还没发出去就进入优化中」的误触：旧判定把「草稿由非空变空」当成已发送，
而输入阶段草稿会被宿主瞬时清空/恢复（回车、输入法回显、草稿持久化抖动），
于是用户只是打字就点亮了按钮。

- **改用宿主提交事务信号**：判定改为 `input.phase` 进入 `submitting`
  （`begin-submit` 在"接受这次发送"之后、草稿清空之前置位，只有真正提交才会出现）。
  `submitting` 只认**进入**的那一次跃迁，`submitting → plain` 回落不算新发送，
  所以"发送后草稿清空"不会再触发第二轮轮询。
- **保留老宿主兜底**：宿主没有 `phase` 字段时仍走「草稿持续为空 300ms + 输入法组合窗口」，
  行为与 0.3.1 一致，不影响旧版本宿主。
- **分析文本取真实发送内容**：提交瞬间草稿可能已清空，退回"最近一次有内容的草稿"，
  轮询请求带的 `text` 就是用户真正发出的那段。
- **两条"不会跑分析"的路不再空转**：斜杠命令（Host 在 pre-step 直接放行）不进入优化中；
  发送失败被宿主把草稿退回输入框时（phase 回落 `plain` 且草稿又有内容）立即取消轮询。
- **测试**：新增 CASE16（输入阶段清空草稿 → 不进入优化中、不发轮询；`phase` 进入
  `submitting` → 立即进入优化中；提交后清空 → 不重复轮询；斜杠命令 → 不轮询；
  发送失败退回草稿 → 取消轮询），测试替身的 `useInput` 现在可选地暴露 `phase`。

## 0.3.1

胶囊按钮文案改成「主文案 + 极短后缀」，解决进行中「4 个字撑满 9 个字位」的观感问题，
同时保留按钮的可识别全名。

- **主文案不缩写，只压后缀**：`提示词优化•AUTO` / `提示词优化•OFF` / `优化中…` →
  `提示词优化·自动` / `提示词优化·关闭` / 进行中只留 `提示词优化` + 3 个呼吸圆点
  （英文 `Prompt refine·On` / `Prompt refine·Off` / `Prompt refine`）。
  AUTO 与 OFF 后缀各 2 字，天然等宽；主文案始终是完整名，读屏（`aria-label`）与悬停
  tooltip（`Prompt refine (on)`）所述状态保持一致。
- **用进度感填补余量**：进行中在文案后追 3 个 3px 呼吸圆点（`@keyframes dsh-pc-dots`，1.25s，
  透明度 .2→1、依次错开 160ms），圆点宽度恒定只变透明度 → 右侧不再空旷，也不再靠省略号凑字。
  `prefers-reduced-motion` 下停动画、保留 75% 静态点。
- **宽度依然不变**：`label-sizer` 隐形占位取 `提示词优化·自动`（后缀最长的一种），固定 14px 图标槽不变，
  状态切换不跳宽、不推挤相邻控件；进行中缺一个后缀的宽度由圆点补位。
- **测试**：CASE0 / CASE9a–d / CASE12a–b / CASE14 的期望值同步；CASE12a 新增「3 个圆点必须渲染」
  与「AUTO/OFF 文案等长」两条断言；按钮查找改用 `data-prompt-clarifier="trigger"` 钩子，
  不再依赖可见文案（文案此后可自由调整）。

## 0.3.0

播报行从「用户气泡」改为工具卡片行——插件在 `agent/pre-step` 写出的可见阶段行
（1/3 读取上下文、2/3 模型分析、3/3 澄清提问、结果、错误）此前用 `user/message` 落日志，
被客户端渲染成"用户说的话"，语义错位。

- **工具卡片播报**：用 `command/run` + `command/done`（与 dsh-qoder-connect 的 token-hint 同款通道）。
  一个回合共用同一 `commandId`（`prompt-clarifier:<消息id>`），`command/done` 是 update、客户端取
  最新 `text`，于是各阶段**累积合并进同一张小卡片**；`command/run` 的 `name:'提示词优化'`（不能是
  `permission`，否则被隐藏）。command 事件**非 surface-eligible**，第三参绝不带 `surfaceOp`
  （带了 host 直接抛错），也因此**不进模型上下文**（零 token、零自我污染）。
- **落位锚点 turn/step（0.3.0 内修，卡片此前完全不显示）**：command 事件**必须**显式带 `turn`
  + `step:1`。插件在 `agent/pre-step` 播报时本轮首个 `step/start` 还没写进日志，客户端
  `payloadCoordinates` 对不带 turn/step 的事件退回去继承 `currentStep`（此刻为 undefined）→
  位置解析成 `{kind:"turn"}` 而非 `{kind:"step"}` → 卡片不进对话流（= 结果完全不显示）。
  内核首步恒为 1，故 command/run 与每条 command/done 都锚定 `{turn, step:1}`；带 turn+step 的
  任意事件会建立 step 草稿，step/start 稍后并入同一草稿，与线上正常显示的 qoder token-hint 同款落点。
- **助手气泡方案（已弃用）**：曾尝试 `assistant/message` + `(turn, step:0)` + `surfaceOp:'append'`，
  但核查内核客户端（chat-client/uic-client）后确认它在**直播时不可见**——step 草稿只由内核
  `step/start` 建立，合成行没有它 → 位置解析成 turn → `buildViewNode` 返回 null，只有刷新页面
  （触发 rebuild）才显示，对"实时进度"不成立，遂改用 command 通道。
- **投影 `stateVersion` 升到 3**：`assistant/message` 且 `source.form` 以 `prompt-clarifier:` 开头的
  排除分支现为**防御性**（当前可见行走 command 事件根本不被采样；若将来换回助手气泡可防回灌）。
- **注入通道不变**：给模型的 refine/clarify 仍走 `decision.messages`（`source.kind:'prompt-clarifier'`，
  内核记进日志但客户端按 contextMessage 隐藏）。
- **测试**：CASE1 断言 command 形状——1 条 `command/run`（`name:'提示词优化'`）+ ≥4 条累积
  `command/done`（末条 `kind:'success'`），且 command 事件**无** `surfaceOp`；CASE26(d) 折叠合成
  `assistant/message` 播报行必须被投影排除（防御锁定）。
- 时序：`agent/pre-step` 的事件 seq 小于内核 `step/start` → 播报卡片显示在真正回答之上。

## 0.2.0

一次以"审查 → 修复"为主的版本，修掉一个会打死本轮的 P0，以及七处状态/成本/一致性缺陷。

- **P0 修复：分析失败不再杀死用户那一轮**。`agent/pre-step` 的失败分支原先没有 return，
  会继续走到 `review.optimized.trim()` —— 失败/无路由时 `optimized` 根本不存在 →
  TypeError 从监听器抛出，被内核转成整轮 `turnEnds{kind:'error'}`。
  现在失败分支追加错误行后立即返回原 decision。
- **失败也写占位缓存**：客户端的「优化中」因此能及时收尾，不再对着轮询预算空转。
- **不再出现两套澄清界面**：`askBlocking` 为真时本轮已弹过原生提问卡，
  缓存里的 `questions` 会被抹空，客户端轮询不再重复弹面板。
- **轮询预算对齐服务端**：诊断接口新增 `analysisBudgetMs`（= `timeoutMs × 2`），
  客户端据此设定轮询截止（原先硬编码 ~36s，慢模型下面板永远等不到）。
- **投影去自我污染**：`stateVersion` 升到 2，排除插件自己落进会话日志的行，
  打断"上一轮改写稿被当成这一轮用户原话"的复利回路。
- **AUTO 开关按会话隔离**：两个浏览器标签页不再互相覆盖；客户端本地偏好优先，
  无本地偏好时跟随 Host 状态。
- **失败/被拒的消息不再被永久拉黑**：`markAnalyzed` 移到确认本轮 `enter` 之后。
- **新增配置**：`autoFast`（默认 false —— 打开后 AUTO 逐条付费的旁路调用也走
  `fastProvider`/`fastModel`，用它模型的价格付"每轮一次"的成本）、
  `showProgress`（默认 true —— 关掉后自动模式每轮只留一行「结果」，错误行不受影响）。
- **工具路径**：`prompt_clarifier_review` 不再受 `minChars` 拦截（按手动语义处理，
  且与手动按钮一样遵循 `fastProvider`/`fastModel` 的快速路由语义）。
- **测试**：host 套件新增 CASE20–28、客户端套件新增 CASE14–15 回归本次全部修复。
- **文档**：修掉配置表两处漂移（`timeoutMs` 默认值、`maxOutputTokens` 遗留的 768），
  fail-open 一节补充"监听器抛出会杀死本轮"的硬约束；更正 10-29 一条已失效的机制描述。

## 0.1.0

首个可用版本。

- **自动模式**：`agent/pre-step` 拦截本轮人类消息，按会话上下文旁路分析后注入
  【提示词优化·进度】/【提示词优化·结果】；有歧义时用原生提问卡片追问，回答与改写稿一起
  注入同一回合，助手据此继续执行。
- **手动模式**：composer 工具行的「提示词优化」按钮（左键立即分析 / 右键切换 AUTO·OFF，
  OFF 态置灰），面板可编辑改写稿并「替换草稿 / 追加澄清」。
- **模型选择**：使用右侧模型选择器在点击那一刻选中的模型（读 `modelSelection` 投影的
  `next ?? lastUsed`），不改变选择器自身状态；无可用模型时提示先选。
- **耗时**：旁路调用显式选最低推理档、首个完整 JSON 即收流、上下文采样可配；
  空输出自动重试一次。
- **诊断**：`GET /api/prompt-clarifier` 回显生效配置；可选 `timingLog` 落盘分段耗时；
  自动路径失败会写 warn 日志而不是静默放行。