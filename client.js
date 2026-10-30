window.__ModuleLoader__.load({
  id: 'dsh-prompt-clarifier',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useCallback, useMemo, useRef, useEffect } = React;

    const NS = 'prompt-clarifier';

    // ---- 词典（自包含）：不触碰宿主 locale 服务与插槽 locale 选项。
    //      2026-10-29 web-boot 崩溃（entry failed）锁定在上次引入的这两处
    //      未经验证的宿主交互；回退到官方 decoration 模板验证过的注册形状，
    //      语言用 document/navigator 检测。 ----
    const DICT = {
      zh: {
        button: '提示词优化',
        modeAuto: 'AUTO',
        modeOff: 'OFF',
        // 悬停提示：只显示“名称 + 状态”，保持简短（用户明确要求不要长篇说明）。
        titleTemplate: '{name}（{state}）',
        stateOn: '开启',
        stateOff: '关闭',
        // ---- 胶囊按钮文案：主文案 + 极短后缀 ----
        // 主文案保留完整名「提示词优化」（用户要求），后缀只放 2 字状态词：
        // 「自动 / 关闭」等长，进行中则只留主文案 + 3 个呼吸圆点补位，于是三态宽度基本一致，
        // 既不会「4 个字撑满 9 个字位」，也不会因为压得太短而认不出这是什么按钮。
        pill: '提示词优化',
        pillAuto: '自动',
        pillOff: '关闭',
        busy: '提示词优化',
        retry: '重试',
        close: '关闭',
        replace: '替换草稿',
        append: '把澄清写进草稿',
        optimized: '建议的优化版本',
        noChange: '当前输入已足够清晰，无需优化。',
        questions: '需要你确认的歧义点',
        custom: '自定义回答…',
        skippedAnswer: '（未作答）',
        notes: '说明',
        errorEmpty: '先在输入框写点什么，再点“提示词优化”。',
        errorPickModel: '请先在右侧模型选择器里选一个模型，再点“提示词优化”。',
        errorFail: '分析失败：',
        errorNoSession: '会话未就绪，稍后再试。',
        errorSetDraft: '写回输入框失败（草稿未被更新）。已把优化结果放到剪贴板，可直接粘贴；若剪贴板不可用，请展开“查看要粘贴的文本”手动复制。',
        verifying: '写回中，正在校验…',
        applied: '已写回输入框 ✓',
        clipboardOk: '已复制到剪贴板 ✓',
        clipboardFail: '剪贴板不可用：请展开“查看要粘贴的文本”手动复制。',
        showText: '查看要粘贴的文本',
        hideText: '收起文本',
        copy: '复制',
        copied: '已复制 ✓',
        answerPrefix: '补充澄清',
        skipTooShort: '输入太短，不足以分析——写得更具体一点再试。',
        skipTooLong: '输入过长（可能粘贴了大量内容），已跳过分析以免误判。',
        skipNoRoute: '请先在右侧模型选择器里选一个可用模型，再点“提示词优化”。',
        skipUnparseable: '模型返回的结果无法解析，请点重试。',
        skipEmptyOutput: '模型这次没有返回内容（输出预算可能被思考占满）。请重试，或换一个模型。',
      },
      en: {
        button: 'Prompt refine',
        modeAuto: 'AUTO',
        modeOff: 'OFF',
        titleTemplate: '{name} ({state})',
        stateOn: 'on',
        stateOff: 'off',
        // On/Off 同为 2 字符 → 两态与 busy 共用同一宽度（见 zh 侧说明）。
        pill: 'Prompt refine',
        pillAuto: 'On',
        pillOff: 'Off',
        busy: 'Prompt refine',
        retry: 'Retry',
        close: 'Close',
        replace: 'Replace draft',
        append: 'Append answers to draft',
        optimized: 'Suggested refinement',
        noChange: 'Your prompt is already clear — no refinement needed.',
        questions: 'Needs your call',
        custom: 'Custom answer…',
        skippedAnswer: '(skipped)',
        notes: 'Note',
        errorEmpty: 'Type something in the composer first.',
        errorPickModel: 'Pick a model in the selector on the right first, then click Prompt refine.',
        errorFail: 'Analysis failed: ',
        errorNoSession: 'Session not ready yet.',
        errorSetDraft: 'Could not write back to the composer (the draft stayed unchanged). The refined text is on your clipboard — paste it in, or expand "Show text to paste" and copy it manually.',
        verifying: 'Writing back, verifying…',
        applied: 'Applied to the composer ✓',
        clipboardOk: 'Copied to clipboard ✓',
        clipboardFail: 'Clipboard unavailable — expand "Show text to paste" and copy it manually.',
        showText: 'Show text to paste',
        hideText: 'Hide text',
        copy: 'Copy',
        copied: 'Copied ✓',
        answerPrefix: 'Clarifications',
        skipTooShort: 'Input is too short to analyze — add a bit more detail and try again.',
        skipTooLong: 'Input is too long (a paste, maybe?) — skipped to avoid a bad rewrite.',
        skipNoRoute: 'Pick a usable model in the selector on the right first, then click Prompt refine.',
        skipUnparseable: 'The model response could not be parsed — hit Retry.',
        skipEmptyOutput: 'The model returned no content (its thinking may have used the whole output budget). Retry, or switch models.',
      },
    };
    const SKIP_KEYS = {
      'too-short': 'skipTooShort',
      'too-long': 'skipTooLong',
      'no-model-route': 'skipNoRoute',
      'unparseable-model-output': 'skipUnparseable',
      'empty-model-output': 'skipEmptyOutput',
    };
    function fallbackLocale() {
      const doc = (typeof document !== 'undefined' && document.documentElement?.lang) || '';
      const nav = (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || '';
      return `${doc} ${nav}`.toLowerCase().includes('zh') ? DICT.zh : DICT.en;
    }

    // ---- 主题令牌 ----
    // 只用主题包里确实存在的 token（已逐个核对 dsh-client-ui-theme 的浅/深两套值）。
    // 之前的 `--dsw-alias-bg-elevated / -fg-primary / -border` 等名字是我编的，
    // 主题里没有 → var() 静默退到 fallback（半透明灰），这就是“弹窗穿透 + 分离感弱”
    // 的真正原因。真实的不透明面 token 是 bg-layer-1/2（浅 #fff、深 bluish-875/850）。
    const S = {
      card: {
        display: 'flex', flexDirection: 'column', gap: 8, width: 'min(560px, 100%)',
        margin: '4px 0', padding: '10px 12px', borderRadius: 'var(--dsw-radius-md, 12px)', textAlign: 'left',
        background: 'var(--dsw-alias-bg-layer-1, var(--dsw-specific-input-major, #fff))',
        border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.28))',
        color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 13, lineHeight: 1.5, boxSizing: 'border-box',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      label: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary, inherit)', letterSpacing: 0.2 },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
      },
      primary: {
        background: 'var(--dsw-alias-state-business-primary, #2c84ff)', borderColor: 'transparent',
        color: 'var(--dsw-alias-label-primary-inverted, #fff)',
      },
      box: {
        width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 60, padding: '8px 10px',
        borderRadius: 'var(--dsw-radius-sm, 8px)', fontSize: 13, lineHeight: 1.5, fontFamily: 'inherit',
        // overlay 是不透明的输入底（浅 #e9ecf2 / 深 bluish-700），比面板底深一档。
        background: 'var(--dsw-alias-bg-overlay, rgba(128,128,128,.12))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      q: {
        padding: '8px 10px', borderRadius: 'var(--dsw-radius-sm, 8px)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
        display: 'flex', flexDirection: 'column', gap: 6,
      },
      opt: { display: 'flex', gap: 6, alignItems: 'baseline', cursor: 'pointer', fontSize: 12.5 },
      muted: { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: 12 },
      err: { color: 'var(--dsw-alias-state-error-primary, #d92d20)', fontSize: 12 },
      okText: { color: 'var(--dsw-alias-state-success-primary, #12984c)', fontSize: 12 },
      // 按钮文案的等宽占位：三种文案叠在同一网格单元里，宽度取最大值。
      labelSlot: { display: 'inline-grid', alignItems: 'center', justifyItems: 'start', whiteSpace: 'nowrap' },
      labelItem: { gridArea: '1 / 1', whiteSpace: 'nowrap' },
      // 图标固定槽：鲸鱼(14) 与 旋转图元(13) 宽度不同，套同一尺寸后按钮宽度才稳定。
      iconSlot: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, flex: '0 0 auto' },
      // ---- 按钮上方弹窗 ----
      // 弹窗不能写进 <button> 里（textarea/按钮嵌套是非法 HTML，浏览器会把节点挪出，
      // 行为不可控），所以外层套一个只做定位参照的 wrapper；
      // inline-flex + 只包住按钮，不给工具行增加任何高度。
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', minWidth: 0 },
      // ---- 弹窗材质：对齐宿主「模型选择器」弹层 ----
      // 权威配方取自宿主 CSS（`._9r0rkG_menu` 与共享面板 `.A6Bq1a_panel` 一致）：
      //   background: var(--dsw-specific-menu)      ← 故意是半透明表面（浅 #f8f9fa94 /
      //                                                 深 #43454a73；macOS 走 #f8f9faf0）
      //   backdrop-filter: var(--dsw-menu-backdrop-filter)  ← blur(40px) saturate(150%)
      //   box-shadow: var(--dsw-elevation-prominent) + 描边色 border-l1（border:0）
      //   border-radius: var(--dsw-radius-lg)  z-index:1100  padding:4px
      //   color: var(--dsw-alias-label-primary)
      // 之前“穿透 + 重叠”的真凶不是半透明本身，而是我用了不存在的 token 名，
      // 底退成 8% 灰且**没有 blur、没有描边阴影**，于是下层文字直接透过来。
      // 用宿主同一套材质，既保证可读（磨砂隔离），又与其它弹层视觉一致。
      popup: {
        position: 'absolute', right: 0, bottom: 'calc(100% + 8px)', zIndex: 1100,
        display: 'flex', flexDirection: 'column', gap: 4, margin: 0,
        width: 'min(420px, calc(100vw - 32px))',
        maxHeight: 'min(360px, calc(100vh - 96px))', overflowY: 'auto', boxSizing: 'border-box',
        padding: 4, borderRadius: 'var(--dsw-radius-lg, 16px)',
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1, #fff))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))',
        WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))',
        border: 0,
        color: 'var(--dsw-alias-label-primary, inherit)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 3px 8px rgba(0,0,0,.06))',
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1, rgba(0,0,0,.1))',
      },
      // 弹层内的区块：宿主的菜单行本身是透明的（`.option{background:0 0}`，
      // 选中态才上 `--dsw-alias-interactive-bg-hover`），所以这里也只负责排版，
      // 不再叠第二层底——避免“面板里套面板”的双层观感和磨砂被二次遮挡。
      // 内联 margin 必须归零（内联优先级高于样式表）。
      floatCard: {
        display: 'flex', flexDirection: 'column', gap: 8, width: '100%',
        margin: 0, padding: '8px', borderRadius: 'var(--dsw-radius-md, 12px)', textAlign: 'left',
        background: 'transparent', border: 0,
        color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 13, lineHeight: 1.5, boxSizing: 'border-box',
      },
    };

    // ---- 触发按钮的炫彩渐变 ----
    // 布局留在内联，配色整体交给样式表：内联样式优先级高于任何 class/属性选择器，
    // 若这里继续写 background/color，渐变会被简写属性直接冲掉（表现就是“没变化”）。
    const { background: _bg, color: _fg, border: _bd, ...TRIGGER_LAYOUT } = S.pill;

    const TRIGGER_CSS = [
      // 缓慢流动：一条渐变在两个方向上往复扫过，14s 一个来回。
      '@keyframes dsh-pc-flow{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}',
      '[data-prompt-clarifier="trigger"]{',
      // background-image 而非 background 简写：简写会把下面的 background-size 重置掉。
      // 配色以蓝色为主（蓝/天蓝/青/靛），其间夹入少量紫罗兰过渡做“炫彩”，
      // 首尾同为深蓝保证循环无缝；纯装饰色值，宿主没有对应的语义 token 可用，
      // 其余（文字色、描边、焦点环、阴影）仍走主题变量。
      'background-image:linear-gradient(135deg,#1d4ed8 0%,#2563eb 16%,#0ea5e9 32%,#22d3ee 46%,#6366f1 62%,#8b5cf6 76%,#3b82f6 88%,#1d4ed8 100%);',
      'background-size:220% 220%;animation:dsh-pc-flow 14s ease-in-out infinite;',
      'border:1px solid transparent;color:#fff;font-weight:600;',
      'text-shadow:0 1px 2px rgba(0,0,0,.38);',
      'box-shadow:0 1px 3px rgba(0,0,0,.18)}',
      '[data-prompt-clarifier="trigger"]:hover{background-position:50% 100%;box-shadow:0 2px 8px rgba(37,99,235,.42)}',
      '[data-prompt-clarifier="trigger"]:active{background-position:100% 0;box-shadow:0 1px 2px rgba(0,0,0,.24);transform:translateY(1px)}',
      // 忙时透明度由内联控制，这里只负责禁用态观感与可读性。
      '[data-prompt-clarifier="trigger"]:disabled{animation-play-state:paused;cursor:default}',
      '[data-prompt-clarifier="trigger"]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2563eb);outline-offset:2px}',
      // ---- OFF 态：整体置灰（降低存在感），AUTO 态保持原样 ----
      // 用 data-auto-mode（已由组件按模式写入）作为钩子，不改任何交互逻辑。
      // 灰阶仍保留轻微渐变层次，避免看起来像"被禁用"；同时停掉流动动画。
      '[data-prompt-clarifier="trigger"][data-auto-mode="off"]{',
      'background-image:linear-gradient(135deg,#9e9e9e 0%,#828282 40%,#b0b0b0 70%,#9e9e9e 100%);',
      'animation:none;color:#f8fafc;text-shadow:none;',
      'box-shadow:0 1px 2px rgba(0,0,0,.10)}',
      '[data-prompt-clarifier="trigger"][data-auto-mode="off"]:hover{background-position:0% 50%;box-shadow:0 2px 6px rgba(0,0,0,.14)}',
      '[data-prompt-clarifier="trigger"][data-auto-mode="off"]:active{background-position:0% 50%;box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      '[data-prompt-clarifier="trigger"][data-auto-mode="off"]:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary,#7b8494);outline-offset:2px}',
      // 尊重系统的减弱动效偏好：保留渐变，只停掉流动动画。
      '@media (prefers-reduced-motion:reduce){[data-prompt-clarifier="trigger"]{animation:none}}',
      // ---- 进行中的三个呼吸圆点 ----
      // 目的：进行中只显示主文案「提示词优化」（没有「·自动/·关闭」后缀），而胶囊仍与
      // 「提示词优化·自动」等宽，右侧会剩一点空隙。
      // 用 3 个点占住这点空隙：宽度恒定（不进不出），只做透明度呼吸，于是空白感变成
      // "正在推进" 的指示，也避免再靠加省略号去凑字数。
      '@keyframes dsh-pc-dots{0%,80%,100%{opacity:.2}40%{opacity:1}}',
      '[data-prompt-clarifier="dots"]{display:inline-flex;align-items:center;gap:2px;margin-left:4px;vertical-align:middle}',
      '[data-prompt-clarifier="dots"]>i{display:block;width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.2;animation:dsh-pc-dots 1.25s ease-in-out infinite}',
      '@media (prefers-reduced-motion:reduce){[data-prompt-clarifier="dots"]>i{animation:none;opacity:.75}}',
    ].join('');

    let cssInjected = false;
    function ensureTriggerCss() {
      // 幂等注入：已插入过就绝不重复；head 未就绪时不置位，留给渲染后重试
      // （否则按钮会永远停在无渐变的中性样式，用户只看到“改了没反应”）。
      if (cssInjected) return;
      try {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.getElementById(`${NS}-trigger-css`)) { cssInjected = true; return; }
        const style = document.createElement('style');
        style.id = `${NS}-trigger-css`;
        style.textContent = TRIGGER_CSS;
        document.head.appendChild(style);
        cssInjected = true;
      } catch { /* 注入失败只退回中性样式，不影响功能 */ }
    }

    // ---- DeepSeek 鲸鱼标志 ----
    // 照抄宿主 primitives 的 FishLogo 实现（practices.md 明确禁止插件
    // require('@deepseek-ai/dsh-client-ui-primitives')，要求把 markup/CSS 抄进来）。
    // 数据逐字节取自 primitives bundle：viewBox 23.16×17.04、path fill=currentColor，
    // 所以它会跟随按钮的 `color:#fff` 变成白色鲸鱼，与宿主侧栏/hero 的标志完全一致。
    const FISH_LOGO_VIEWBOX = { width: 23.16, height: 17.04 };
    const FISH_LOGO_PATH = "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z";

    function Fish({ size }) {
      return h('svg', {
        width: size,
        height: size * FISH_LOGO_VIEWBOX.height / FISH_LOGO_VIEWBOX.width,
        viewBox: `0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`,
        fill: 'none', 'aria-hidden': true,
        style: { flex: '0 0 auto' },
      }, h('path', { d: FISH_LOGO_PATH, fill: 'currentColor' }));
    }

    function Spark({ spinning }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true,
        style: { flex: '0 0 auto', animation: spinning ? 'dsh-pc-spin 1s linear infinite' : void 0 },
      }, h('path', {
        d: 'M8 1.2l1.6 4.2 4.2 1.6-4.2 1.6L8 12.8 6.4 8.6 2.2 7l4.2-1.6L8 1.2zM12.8 10.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z',
        fill: 'currentColor',
      }), h('style', null, '@keyframes dsh-pc-spin{to{transform:rotate(360deg)}}'));
    }

    // 草稿比对归一化：内核 setDraft 会把换行拆段、清洗引用占位符，
    // 逐字符比对会把成功误判成失败。
    function norm(value) {
      return String(value ?? '').replace(/\s+/g, ' ').trim();
    }

    // DOM 兜底读回：真实宿主里 composer 是 Lexical contenteditable，
    // 极端情况下 useInput 的 draft 订阅会滞后于编辑器实际内容——
    // 若 prop 读回说“没变”而编辑器明明已是目标文本，不能误报失败。
    function composerShowsTarget(text) {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false;
        const target = norm(text);
        if (target === '') return false;
        for (const node of document.querySelectorAll('[contenteditable="true"]')) {
          if (norm(node.textContent) === target) return true;
        }
      } catch { /* ignore */ }
      return false;
    }

    // 自动模式偏好的本地持久化：存在浏览器而非插件配置里，
// 避免插件去改用户的 cordis.patch.yml（桌面端自动恢复会重写它）。
    const AUTO_KEY = 'prompt-clarifier:auto';
    function readAutoPref() {
      try {
        if (typeof localStorage === 'undefined') return null;
        const value = localStorage.getItem(AUTO_KEY);
        return value === 'on' ? true : value === 'off' ? false : null;
      } catch { return null; }
    }
    function writeAutoPref(on) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(AUTO_KEY, on ? 'on' : 'off');
      } catch { /* 隐私模式等场景下不持久化，仅本次生效 */ }
    }

    async function post(body) {
      const res = await fetch('/api/prompt-clarifier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }

    function Panel({ draft, review, tr, onUse, onClose, cardStyle }) {
      const [answers, setAnswers] = useState({});
      const [optimized, setOptimized] = useState(review.optimized || '');
      const hasQuestions = Array.isArray(review.questions) && review.questions.length > 0;
      const changed = optimized.trim() !== '' && optimized.trim() !== (draft || '').trim();
      const answerLines = useMemo(() => {
        const lines = [];
        for (const q of review.questions || []) {
          const a = answers[q.id];
          const given = typeof a?.custom === 'string' && a.custom.trim() !== '' ? a.custom.trim() : (a?.selected ?? '');
          lines.push(`- ${q.question}：${given || tr('skippedAnswer')}`);
        }
        return lines;
      }, [answers, review.questions, tr]);

      return h('div', { style: cardStyle ?? S.card, role: 'region', 'aria-label': tr('button') },
        h('div', { style: S.row },
          h('span', { style: S.label }, tr('optimized')),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.pill, onClick: onClose, 'aria-label': tr('close') }, tr('close'))),
        changed
          ? h('textarea', {
            style: S.box, rows: Math.min(8, Math.max(3, optimized.split('\n').length)),
            value: optimized,
            onChange: (e) => setOptimized(e.target.value),
          })
          : h('div', { style: S.muted }, tr('noChange')),
        hasQuestions ? h('div', { style: S.label }, tr('questions')) : null,
        ...(hasQuestions ? review.questions.map((q) => h('div', { key: q.id, style: S.q },
          h('div', null, q.question),
          ...(q.options || []).map((o) => h('label', { key: o.label, style: S.opt },
            h('input', {
              type: 'radio', name: q.id, checked: answers[q.id]?.selected === o.label && !answers[q.id]?.custom,
              onChange: () => setAnswers((prev) => ({ ...prev, [q.id]: { selected: o.label, custom: '' } })),
            }),
            h('span', null, o.label),
            o.description ? h('span', { style: S.muted }, o.description) : null)),
          h('input', {
            style: { ...S.box, minHeight: 0, padding: '4px 8px' }, placeholder: tr('custom'),
            value: answers[q.id]?.custom ?? '',
            onChange: (e) => setAnswers((prev) => ({ ...prev, [q.id]: { selected: '', custom: e.target.value } })),
          }))) : []),
        review.notes ? h('div', { style: S.muted }, `${tr('notes')}: ${review.notes}`) : null,
        changed || (hasQuestions && answerLines.length > 0)
          ? h('div', { style: S.row },
            changed ? h('button', {
              style: { ...S.pill, ...S.primary },
              onClick: () => onUse(optimized, answerLines.length > 0 ? `${tr('answerPrefix')}：\n${answerLines.join('\n')}` : ''),
            }, tr('replace')) : null,
            hasQuestions && answerLines.length > 0 ? h('button', {
              style: S.pill,
              onClick: () => onUse(changed ? optimized : '', `${tr('answerPrefix')}：\n${answerLines.join('\n')}`),
            }, tr('append')) : null)
          : null);
    }

    function makeTr(props) {
      const t = props.t;
      return (key) => {
        // locale.translate 未命中时返回 key 本身（词典未注册就会把 "button"
        // 这样的原始 key 显示出来）；识别出来并落到本地兜底词典。
        if (typeof t === 'function') {
          const value = t(key);
          if (typeof value === 'string' && value !== '' && value !== key) return value;
        }
        const fb = fallbackLocale();
        return fb[key] ?? key;
      };
    }

    const INITIAL_STATE = {
      review: null, error: null, busy: false, applied: false,
      manual: null, pending: null, clipboardOk: null, showText: false, copied: false,
    };

    /**
     * 单一挂载点：按钮在 composer 工具行（input.right，模型选择器左侧），
     * 结果以**弹窗**形式出现在按钮正上方。
     * 弹窗与按钮必须同处一个 position:relative 容器才能定位，所以不再拆成两处；
     * 也就不用跨挂载点同步状态（弹窗版之前的 composer.dock 会占真实布局高度、
     * 把整页顶开，是这次改动要解决的）。
     */
    function Clarifier(props) {
      const tr = makeTr(props);
      const inputActions = props.inputActions ?? props.actions;
      // useInput 是 React hook，只能在渲染期调用：草稿在这里读，click 处理器用
      // 闭包里的 draft。放进事件回调会在真实 React 里抛 Invalid hook call，
      // 且位于 try 之外会直接逃到事件派发层——表现就是“按钮能点但毫无反应”。
      const useInput = props.useInput ?? (() => undefined);
      const input = useInput((s) => s);
      const draft = typeof input?.draft === 'string' ? input.draft : '';
      // 宿主输入机的阶段（plain / adjudicating / submitting / claimed）：
      // `submitting` 只在提交事务真正开始时出现（begin-submit），是“消息确实发出去了”
      // 唯一可靠的客户端信号；在输入框里打字、回车换行、草稿被宿主瞬时清空都不会置位。
      // 右侧模型选择器的**实时**选中值：会话投影 `modelSelection` 的 wire view 是
      // `{ lastUsed, next: pending ?? lastUsed }`，`next` 就是“下次请求会用到的模型”，
      // 用户刚在选择器里改动但还没发消息时也能反映出来。
      // 同样只能在渲染期调用；点击时读闭包里的 picked，即“点击那一刻”的值。
      // 只读、不调用 selectModel，所以不会改动选择器自身的显示与选中状态。
      const useProjection = props.useProjection;
      const modelSelection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;
      const selectionKnown = modelSelection !== undefined && modelSelection !== null;
      const picked = modelSelection?.next ?? modelSelection?.lastUsed ?? null;

      const [state, setState] = useState(INITIAL_STATE);
      // patch 语义：保持所有 set({...}) 调用点不变。
      const set = useCallback((patch) => setState((prev) => ({ ...prev, ...patch })), []);
      // 自动模式开关：本地偏好优先，首次挂载时同步给 Host（Host 只改内存，不写配置）。
      const [auto, setAuto] = useState(() => readAutoPref() ?? true);
      // 自动模式下的“优化中”状态：发送后置 true，拿到结果/超时/失败后恢复。
      const [optimizing, setOptimizing] = useState(false);
      const pushAuto = useCallback((on) => {
        // 带上 sessionId：Host 侧改成按会话存开关，两个标签页各切各的，
        // 不再“最后推送者赢得”（2026-10-30 复查 P2）。
        const sessionId = props.sessionId;
        post({ action: 'setAuto', enabled: on, ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}) })
          .catch(() => { /* 离线时仅本地生效 */ });
      }, [props.sessionId]);
      // 服务端最坏耗时（两次尝试各占 timeoutMs）。客户端 AUTO 轮询预算按它对齐：
      // 原来固定 24×1500ms≈36s，比服务端 45s×2 短，慢模型必然“面板永不出现”。
      const budgetRef = useRef(90000);
      useEffect(() => {
        const stored = readAutoPref();
        let alive = true;
        const sessionId = props.sessionId;
        const query = typeof sessionId === 'string' && sessionId !== '' ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
        fetch(`/api/prompt-clarifier${query}`).then((r) => (r.ok ? r.json() : null)).then((value) => {
          if (!alive || value === null) return;
          if (typeof value.analysisBudgetMs === 'number' && value.analysisBudgetMs > 0) budgetRef.current = value.analysisBudgetMs;
          // 本地有偏好就以本地为准（刚推给 Host 的就是它）：此时 GET 的 auto 可能
          // 是推送被处理之前的旧值，拿它回写界面会出现“按钮显示 AUTO、实际 OFF”。
          if (stored === null && typeof value?.auto === 'boolean') setAuto(value.auto);
        }).catch(() => { /* ignore */ });
        if (stored !== null) pushAuto(stored);   // 有本地偏好仍然推给 Host
        return () => { alive = false; };
      }, [pushAuto, props.sessionId]);
      const toggleAuto = useCallback(() => {
        const next = auto !== true;
        writeAutoPref(next);
        setAuto(next);
        pushAuto(next);
      }, [auto, pushAuto]);
      const { review, error, busy, applied, manual, pending, clipboardOk, showText, copied } = state;

      const wrapRef = useRef(null);
      // 点击瞬间的草稿快照：写回后只要它与快照不同，就说明编辑器真的改了。
      const beforeRef = useRef(null);

      // ---- AUTO 模式：发送后也弹出优化面板 ----
      // AUTO 的分析在 Host 的 pre-step 里跑（不是我们发起的），客户端拿不到返回值。
      // 做法：判定“消息真的发出去”了 → 轮询 Host 取回最近一次 AUTO 结果并弹面板。
      // 只用已验证的 HTTP 路由，不引入新的宿主接缝。
      //
      // 判定“真的发出去了”（2026-10-30 二次修复）：
      //   宿主的**普通消息提交不会移动 `input.phase`**（uic-client.js 的 beginDetached：
      //   “mint an ordinary send that leaves the phase plain”），只有斜杠命令的 claim 才走
      //   adjudicating/submitting。所以 0.3.2 里等 'submitting' 的结果是按钮永远不进
      //   「优化中」。草稿“有内容 → 清空”又会被输入法确认/回车换行瞬时触发（m02465）。
      //   最终判定：清空只当作**一次可疑发送**，发起后向 Host 探询；Host 回 pending
      //   （它确实在分析这段文本）才点亮按钮并继续轮询结果 —— 误触的代价只是一次本地 GET。
      const aliveRef = useRef(true);
      useEffect(() => () => { aliveRef.current = false; }, []);
      const lastDraftRef = useRef(draft);
      const draftRef = useRef(draft);
      const autoQueryRef = useRef(0);
      // 最近一次“有内容”的草稿：宿主提交时草稿可能已被清空，用它兜住要分析的文本。
      const lastTypedRef = useRef('');
      // 输入法组合输入窗口：compositionstart..compositionend（+ 极短缓冲）。
      // 组合期间按 Enter 是“确认候选词”，不是发送；兜底路径靠它防误触。
      const composingRef = useRef(false);
      const composingUntilRef = useRef(0);
      const isComposingNow = () => composingRef.current || Date.now() < composingUntilRef.current;
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        const onStart = () => { composingRef.current = true; };
        const onEnd = () => { composingRef.current = false; composingUntilRef.current = Date.now() + 120; };
        document.addEventListener('compositionstart', onStart, true);
        document.addEventListener('compositionend', onEnd, true);
        return () => {
          document.removeEventListener('compositionstart', onStart, true);
          document.removeEventListener('compositionend', onEnd, true);
        };
      }, []);
      // 发起一次 AUTO 结果轮询：这是“优化中”状态的**唯一**入口，
      // 只由下面 effect 里两条已验证的发送信号调用。
      const startAutoPoll = useCallback((sessionId, submitted) => {
        const ticket = ++autoQueryRef.current;
        const since = Date.now();
        // 轮询预算跟随服务端最坏耗时（Host GET 的 analysisBudgetMs，默认 90s），
        // 再留一点收尾余量；原来写死 36s 会在慢模型上先放弃（2026-10-30 复查 P1-2）。
        const deadline = since + budgetRef.current + 10000;
        // 探询窗口：Host 迟迟没开始分析就不再等（消息可能根本没发出去），
        // 这时**不能**点亮按钮，否则又变成“输入时就在优化”。
        const quietUntil = since + 12000;
        let shown = false;
        const poll = async () => {
          try {
            for (let i = 0; Date.now() < deadline && aliveRef.current && autoQueryRef.current === ticket; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, i === 0 ? 400 : 1200));
              if (!aliveRef.current || autoQueryRef.current !== ticket) return;
              try {
                const found = await post({ action: 'latestAuto', sessionId, text: submitted });
                const got = found?.review;
                if (got !== undefined && got !== null && typeof found.at === 'number' && found.at >= since - 2000) {
                  // 只在“确实要追问”时才弹面板。无需追问时，pre-step 已经把
                  // 【提示词优化】注入到本回合（那就是唯一的展示），再弹一个同样的框
                  // 就是重复；按用户要求这种场景完全不显示额外框。
                  const questions = Array.isArray(got.questions) ? got.questions : [];
                  if (questions.length > 0) {
                    set({ review: got, error: null, manual: null, clipboardOk: null, applied: false, pending: null });
                  }
                  return;   // 无论是否弹窗，都结束这次轮询
                }
                // Host 正在分析这段文本 → 这是「优化中」的**唯一**依据。
                if (!shown && found?.pending !== undefined && found?.pending !== null && found.pending.text === submitted) {
                  shown = true;
                  setOptimizing(true);
                }
              } catch { /* 单次失败继续等下一次 */ }
              if (!shown && Date.now() > quietUntil) return;
            }
          } finally {
            // 拿到结果、超时放弃、或被新一次发送取代时，都要把按钮恢复回去。
            if (aliveRef.current && autoQueryRef.current === ticket) setOptimizing(false);
          }
        };
        poll();
      }, [set]);

      useEffect(() => {
        const next = typeof draft === 'string' ? draft : '';
        const prev = lastDraftRef.current ?? '';
        lastDraftRef.current = next;
        draftRef.current = next;
        if (next.trim() !== '') lastTypedRef.current = next.trim();
        if (auto !== true) return;
        const sessionId = props.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '') return;
        // 只认“有内容 → 清空”这一种候选信号：清空本身不等于发送（宿主会在输入法
        // 确认、回车换行时瞬时清空草稿），所以这里只**发起探询**，不点亮「优化中」。
        const submitted = prev.trim();
        if (submitted === '' || next.trim() !== '') return;
        if (submitted.startsWith('/')) return;   // 斜杠命令不做 AUTO 分析
        if (isComposingNow()) return;
        const ticket = ++autoQueryRef.current;
        const confirm = setTimeout(() => {
          if (!aliveRef.current || autoQueryRef.current !== ticket) return;
          if (isComposingNow()) return;
          if ((draftRef.current ?? '').trim() !== '') return;   // 草稿又回来了 → 不是发送
          startAutoPoll(sessionId, submitted);
        }, 300);
        return () => clearTimeout(confirm);
      }, [draft, auto, props.sessionId, set, startAutoPoll]);

      // apply 时 head 可能还没就绪；挂载后重试注入（幂等）。
      useEffect(() => { ensureTriggerCss(); }, []);

      const run = useCallback(async () => {
        const sessionId = props.sessionId;
        const text = draft.trim();
        if (!sessionId) { set({ error: tr('errorNoSession'), busy: false }); return; }
        if (text === '') { set({ error: tr('errorEmpty'), busy: false }); return; }
        // 用右侧选择器此刻选中的模型；没有可用模型就提示先选（不发请求）。
        if (selectionKnown && picked === null) { set({ error: tr('errorPickModel'), busy: false }); return; }
        set({ error: null, busy: true, manual: null, clipboardOk: null, applied: false });
        const clickedAt = Date.now();
        try {
          const payload = { action: 'optimize', sessionId, text };
          if (picked !== null && typeof picked?.provider === 'string' && typeof picked?.model === 'string') {
            payload.provider = picked.provider;
            payload.model = picked.model;
          }
          const result = await post(payload);
          // 端到端打点（只写控制台，不改 UI）：clientRoundTrip = 请求往返，
          // server = Host 侧分段耗时（见 index.js 的 timing）。
          try {
            if (result?.timing) console.debug('[prompt-clarifier] timing', { clientRoundTrip: Date.now() - clickedAt, server: result.timing });
          } catch { /* ignore */ }
          if (result.status === 'ok') { set({ review: result, busy: false }); return; }
          if (result.status === 'skipped' || result.status === 'failed') {
            const key = SKIP_KEYS[result.reason];
            const reason = typeof result.reason === 'string' ? result.reason : 'unknown';
            // 模型报错/超时展示原因但截断长度，避免整条信息糊在弹窗里。
            set({ error: key ? tr(key) : tr('errorFail') + reason.slice(0, 160), busy: false });
            return;
          }
          set({
            error: tr('errorFail')
              + (result.error ? String(result.error).slice(0, 160) : String(result.status ?? 'unknown')),
            busy: false,
          });
        } catch (e) {
          set({ error: tr('errorFail') + (e?.message ?? e), busy: false });
        }
      }, [props.sessionId, draft, tr, set, selectionKnown, picked]);

      const toClipboard = useCallback((text) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            return navigator.clipboard.writeText(text).then(() => true, () => false);
          }
        } catch { /* fall through */ }
        return Promise.resolve(false);
      }, []);

      // 写回的三种结局都要有可见反馈（2026-10-29：上一版静默关面板，
      // 用户看到的就是“点了替换没反应”）：
      //   成功 = 读回 draft 与目标一致；
      //   失败 = 降级剪贴板 + 可手动复制的文本，弹窗不吞掉结果。
      const manualFallback = useCallback((text, reason) => {
        console.warn('prompt-clarifier: setDraft did not apply:', reason);
        set({ review: null, manual: { text } });
        toClipboard(text).then((ok) => set({ clipboardOk: ok, showText: !ok }));
      }, [set, toClipboard]);

      const use = useCallback((optimized, answerText) => {
        const parts = [];
        if (typeof optimized === 'string' && optimized.trim() !== '') parts.push(optimized.trim());
        if (typeof answerText === 'string' && answerText.trim() !== '') parts.push(answerText.trim());
        const text = parts.join('\n\n');
        set({ error: null, applied: false, manual: null, clipboardOk: null, copied: false });
        if (text === '') { set({ review: null }); return; }
        let failure = null;
        beforeRef.current = norm(draft);
        try {
          if (typeof inputActions?.setDraft === 'function') inputActions.setDraft(text);
          else failure = 'inputActions.setDraft unavailable: ' + JSON.stringify(Object.keys(inputActions ?? {}));
        } catch (e) { failure = String(e?.message ?? e); }
        if (failure !== null) { manualFallback(text, failure); return; }
        set({ pending: text });
      }, [inputActions, manualFallback, draft, set]);

      // 读回校验：draft 来自 useInput 发布（点击后 React 批处理，异步到达）。
      // 成功 = 草稿等于目标，或至少确实变了（内核会把换行拆段、清洗占位符，
      // 逐字符比对会误报）；800ms 内没变 = 写回被吞，走降级。
      useEffect(() => {
        if (pending === null) return;
        const now = norm(draft);
        if (now === norm(pending)) {
          set({ pending: null, review: null, applied: true });
        } else if (beforeRef.current !== null && now !== beforeRef.current) {
          console.warn('prompt-clarifier: draft changed but not byte-equal to target:',
            { before: beforeRef.current, now, target: norm(pending) });
          set({ pending: null, review: null, applied: true });
        }
      }, [draft, pending, set]);
      useEffect(() => {
        if (pending === null) return;
        const timer = setTimeout(() => {
          // prop 读回滞后兜底：编辑器内容已是目标 → 按成功处理，不误报。
          if (composerShowsTarget(pending)) {
            set({ pending: null, review: null, applied: true });
            return;
          }
          set({ pending: null });
          manualFallback(pending, 'draft unchanged after setDraft');
        }, 800);
        return () => clearTimeout(timer);
      }, [pending, manualFallback, set]);
      useEffect(() => {
        if (!applied) return;
        const timer = setTimeout(() => set({ applied: false }), 2500);
        return () => clearTimeout(timer);
      }, [applied, set]);

      const copyManual = useCallback(() => {
        if (manual === null) return;
        toClipboard(manual.text).then((ok) => {
          set({ copied: ok });
          if (ok) setTimeout(() => set({ copied: false }), 2000);
        });
      }, [manual, toClipboard, set]);

      const closeAll = useCallback(() => set({ review: null, error: null, manual: null, pending: null }), [set]);

      // 供下面的原生监听器读最新状态（声明在使用前，避免闭包过期）。
      const stateRef = useRef(state);
      stateRef.current = state;

      // 弹窗交互：Esc 关闭、点击弹窗外关闭。监听器只在组件挂载期存在，
      // 且用 capture 阶段避免被宿主的 stopPropagation 吃掉。
      useEffect(() => {
        if (typeof document === 'undefined' || !document.addEventListener) return;
        const hasContent = () => {
          const s = stateRef.current;
          return s.review !== null || s.error !== null || s.manual !== null || s.pending !== null;
        };
        const onKey = (e) => { if (e.key === 'Escape' && hasContent()) closeAll(); };
        const onDown = (e) => {
          const el = wrapRef.current;
          const target = e && e.target;
          if (!el || !hasContent()) return;
          if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && el.contains(target)) return;
          closeAll();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onDown, true);
        };
      }, [closeAll]);

      // 进行中 = 手动分析中 或 自动优化中（按钮外观与禁用状态都用它）。
      const working = busy === true || optimizing === true;

      const open = review !== null || error !== null || manual !== null || pending !== null || applied;

      // 只渲染**一个**弹层表面（对齐宿主：一个 MenuSurface 里装若干行）。
      // 之前每种状态各挂一个同样锚点的 S.popup，pending 与 review 会同时存在，
      // 两块磨砂面板叠在同一坐标 → 视觉上就是“半透明 + 与下方内容重叠”。
      const sections = [];
      if (applied) {
        sections.push(h('div', { key: 'applied', style: S.floatCard, role: 'status' },
          h('span', { style: S.okText }, tr('applied'))));
      }
      if (pending !== null) {
        sections.push(h('div', { key: 'pending', style: S.floatCard, role: 'status' },
          h('span', { style: S.muted }, tr('verifying'))));
      }
      if (error) {
        sections.push(h('div', { key: 'error', style: S.floatCard, role: 'alert' },
          h('span', { style: S.err }, error),
          h('div', { style: S.row },
            h('button', { style: S.pill, onClick: run, disabled: busy }, tr('retry')),
            h('button', { style: S.pill, onClick: () => set({ error: null }) }, tr('close')))));
      }
      if (manual) {
        sections.push(h('div', { key: 'manual', style: S.floatCard, role: 'alert' },
          h('span', { style: S.err }, tr('errorSetDraft')),
          clipboardOk === true ? h('span', { style: S.okText }, tr('clipboardOk')) : null,
          clipboardOk === false ? h('span', { style: S.muted }, tr('clipboardFail')) : null,
          h('div', { style: S.row },
            h('button', {
              style: S.pill, 'aria-expanded': showText,
              onClick: () => set({ showText: !showText }),
            }, showText ? tr('hideText') : tr('showText')),
            h('button', { style: S.pill, onClick: copyManual }, copied ? tr('copied') : tr('copy')),
            h('button', { style: S.pill, onClick: () => set({ manual: null, showText: false }) }, tr('close'))),
          showText ? h('textarea', {
            style: { ...S.box, minHeight: 120 }, readOnly: true, value: manual.text,
            onFocus: (e) => e.target.select(),
          }) : null));
      }
      if (review) {
        sections.push(h(Panel, {
          key: 'review', draft, review, tr, cardStyle: S.floatCard, onUse: use, onClose: closeAll,
        }));
      }

      return h('div', { style: S.wrap, ref: wrapRef },
        // 自动模式不再有独立开关：状态直接显示在按钮上（提示词优化·自动 / 提示词优化·关闭），
        // 右键切换 AUTO/OFF；左键始终是“立即分析一次”。
        h('button', {
          // 手动分析（busy）与自动优化（optimizing）共用同一套“进行中”外观：
          // 加载动画 + 文案换成「提示词优化」+ 呼吸圆点，结束后自动恢复成 `提示词优化·自动/·关闭`。
          // 主文案保留完整名，只把后缀压到极短；完整名仍在 title / aria-label / 面板标题里。
          style: { ...TRIGGER_LAYOUT, opacity: working ? 0.7 : 1 },
          disabled: working || !inputActions,
          // 左键 = 立即分析（与手动调用一致）；右键 = 切换 AUTO/OFF，
          // 并吃掉浏览器右键菜单，避免它盖住我们的弹窗。
          onClick: () => { run(); },
          onContextMenu: (event) => {
            if (event !== undefined && event !== null && typeof event.preventDefault === 'function') event.preventDefault();
            toggleAuto();
          },
          // 悬停只显示「名称 + 状态（开启/关闭）」，不再堆长说明。
          title: tr('titleTemplate')
            .replace('{name}', tr('button'))
            .replace('{state}', tr(auto === true ? 'stateOn' : 'stateOff')),
          // 可见文案被压短了，无障碍名仍用完整名称 + 状态，读屏不会退化。
          'aria-label': `${tr('button')}（${tr(auto === true ? 'stateOn' : 'stateOff')}）`,
          'aria-pressed': auto === true ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'data-prompt-clarifier': 'trigger',
          'data-auto-mode': auto === true ? 'on' : 'off',
        },
        // 标志换成 DeepSeek 鲸鱼（与宿主侧栏/hero 同一份 primitives 图形）。
        // 进行中（手动分析或自动优化）用旋转图元作加载动画。
        // 图标宽度不同（鲸鱼 14 vs 旋转 13）会让按钮宽度跳 1px，所以套一个固定尺寸的槽。
        h('span', { style: S.iconSlot, 'aria-hidden': true },
          working ? h(Spark, { spinning: true }) : h(Fish, { size: 14 })),
        // 三态 = 主文案「提示词优化」+ 极短后缀（·自动 / ·关闭 / 进行中只留主文案 + 3 个呼吸圆点）。
        // 全部放进同一个网格单元，并常驻一份「提示词优化·自动」的不可见副本占位 → 切换时按钮宽度不变，
        // 不需要写死像素，跟随字体与语言。
        h('span', { style: S.labelSlot },
          h('span', { style: S.labelItem },
            working ? tr('busy') : `${tr('pill')}·${tr(auto === true ? 'pillAuto' : 'pillOff')}`,
            // 进行中：3 个呼吸圆点占住右侧余量（宽度恒定，仅透明度变化）。
            working
              ? h('span', { 'data-prompt-clarifier': 'dots', 'aria-hidden': true },
                h('i', { key: 'd0' }),
                h('i', { key: 'd1', style: { animationDelay: '160ms' } }),
                h('i', { key: 'd2', style: { animationDelay: '320ms' } }))
              : null),
          h('span', {
            style: { ...S.labelItem, visibility: 'hidden' },
            'aria-hidden': true,
            'data-prompt-clarifier': 'label-sizer',
            // 占位取「提示词优化·自动」：与「·关闭」等长（后缀各 2 字），
            // 进行中的「提示词优化 + 3 点」也落在同一量级，因此三态宽度基本一致。
          }, `${tr('pill')}·${tr('pillAuto')}`))),
        sections.length === 0 ? null : h('div', {
          style: S.popup, 'data-prompt-clarifier': 'panel',
          role: 'dialog', 'aria-label': tr('optimized'),
          onKeyDown: (e) => { if (e.key === 'Escape') closeAll(); },
        }, ...sections));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 注册形状 = 官方 decoration 模板 + ui-chat 统计药丸的已验证写法
        // （只有 name/id/order/label；不声明 locale 选项、不访问 ctx.locale）。
        // 激活期绝不抛出：任何内部失败只让插件静默缺席，
        // 不能让“条目未激活”升级成桌面端启动崩溃（2026-10-29 实证）。
        try {
          ensureTriggerCss();
          // 单一挂载点：宿主在同一容器里先渲染 input.right、再渲染
          // conversation.input.model（模型选择器），所以这里就是它的左侧。
          // 工具行的祖先链已核实没有 overflow 裁剪、卡片自身是
          // position:relative，因此弹窗可以从按钮向上生长。
          ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
            name: 'conversation.input.right',
            id: 'prompt-clarifier',
            order: 10,
            label: () => fallbackLocale().button,
          }, Clarifier));
        } catch (error) {
          try { console.error('prompt-clarifier: client apply failed:', error); } catch { /* ignore */ }
        }
      },
    };
  },
});
