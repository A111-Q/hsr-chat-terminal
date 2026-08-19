/*
 * reply_linebreak.js
 * 角色回复「换行规范化」模块（可复用，浏览器 / Node 双环境）
 *
 * 职责：把模型或本地生成的原始回复文本，规范化为「仅在允许位置换行」的文本，
 *       作为角色回复生成流程的统一换行入口，确保所有角色输出遵循同一套规范。
 *       气泡级「宽度自适应」改由纯 CSS 负责（base .bubble: width:fit-content; max-width:70%），
 *       短消息收缩为单行小气泡、长消息在列宽内自然折行，本模块只管「哪里能换行」。
 *
 * ── 允许的换行触发规则（4 类）────────────────────────────────────────────
 *   ① 语义分段：原文出现空行（连续 \n\n）视为段落分隔，保留为段落边界。
 *   ② 列表项  ：以无序（- * • · ‣）、有序（1. 2)）、中文序号（一、二．）开头的行，独占一段。
 *   ③ 长文本自然断句：相邻两行均 ≥ LONG_LINE 且前一行不以终结标点结尾，保留换行
 *                     （避免把模型自然断开的长段落强行并回一行）。
 *   ④ 对话轮次切换：由消息模型保证（用户 / 角色分属不同消息），本函数不处理。
 *
 * ── 其余换行一律折叠为空格，合并为同一段落 ──────────────────────────────
 *   · 问候语首句保持单行：首行命中问候正则时，强制与后续短句合并、不在内部换行
 *     （"你好\n我是三月七" → "你好 我是三月七"，不再出现多余的问候内换行）。
 *   · 连续短句合并：普通短行默认合并为同一段落（join 空格），不出多余换行。
 *
 * 设计取舍：长文本「气泡内」的硬切（避免一墙字）由下游 splitReplyIntoParts 的
 *          HARD_MAX 负责，本模块只决定「哪些位置可以有换行」，二者职责正交。
 */
(function (global) {
  'use strict';

  const LONG_LINE = 28;   // 长文本阈值（字符数）：达到即允许自然断句

  // 问候语前缀：命中即进入「问候区」，强制单行合并直到遇到终结标点
  const GREETING_RE = /^(你好|您好|您哈|嗨|哈喽|hello|hi|hey|早上好|中午好|下午好|晚上好|夜深了|在吗|在不在|久仰|幸会|初次见面|好久不见)/i;

  // 行是否为列表项（无序 / 有序 / 中文序号）
  function isListItem(line) {
    return /^([-*•·‣◦▪]|\d+[.)、]|[一二三四五六七八九十百千]+[、.．])\s*\S/.test(line);
  }

  // 行是否以终结标点结尾
  function endsWithTerminal(line) {
    return /[。！？.!?…]+$/.test(line);
  }

  // 单句是否「寒暄 / 问候 / 自我介绍」性质（用于判定问候区边界）
  function isCasualSentence(s) {
    const t = s.trim();
    if (!t) return false;
    if (GREETING_RE.test(t)) return true;                                   // 含问候词（你好/嗨/哈喽…）
    if (/我是[\u4e00-\u9fa5A-Za-z·•\-]{1,12}/.test(t)) return true;          // 自我介绍（"我是三月七"）
    // 不再把"≤12 字的非提问短句"泛判为寒暄——避免把"今天天气真好！"这类普通陈述句
    // 并入问候区，让问候区只裹住真正的问候/寒暄/自我介绍，正文严格走「一句一气泡」。
    return false;
  }

  /**
   * 把开头连续的「问候 / 寒暄 / 自我介绍」句整段挑出，作为单一气泡（不切句）。
   * @param {string} text 待切分回复
   * @returns {[string|null, string]} [问候段, 剩余正文]；若开头非问候开场返回 [null, text]
   * @example
   *   splitOffGreeting("你好！我是三月七！今天想去仙舟看看，你要一起吗？")
   *   → ["你好！我是三月七！", "今天想去仙舟看看，你要一起吗？"]
   */
  function splitOffGreeting(text) {
    const trimmed = String(text || '').trim();
    if (!GREETING_RE.test(trimmed)) return [null, text];
    // 逐句切分（终结标点，保留组合标点如"？！"）；记录每句在原文中的起始位置。
    // 不能按「拼接串长度」slice 原文：拼接已把 \n 吃掉，长度与原文错位，
    // 会把问候段末尾的标点/短句残留成孤立气泡（如"你好！\n我是三月七！"多出"！"）。
    const re = /[^。！？.!?]+[。！？.!?]*|[^。！？.!?]+$/g;
    const segs = [];
    let mm;
    while ((mm = re.exec(trimmed)) !== null) {
      const p = mm[0].trim();
      if (p) segs.push({ text: p, start: mm.index });
    }
    if (segs.length <= 1) return [null, text];   // 仅一句寒暄，无需整段包裹
    let end = 0;
    for (let i = 0; i < segs.length; i++) {
      if (isCasualSentence(segs[i].text)) end = i + 1;
      else break;
    }
    if (end <= 1) return [null, text];            // 没有连续寒暄句，走常规切句
    const greetingSpan = segs.slice(0, end).map(s => s.text).join('');
    if (end >= segs.length) return [greetingSpan, ''];   // 整条都是寒暄，无正文
    const rest = trimmed.slice(segs[end].start).replace(/^\s+/, '');
    return [greetingSpan, rest];
  }

  /**
   * 规范化角色回复换行。
   * @param {string} text 原始回复文本（可能含 \n）
   * @returns {string} 仅保留允许位置换行的文本（段落间以 \n\n 连接）
   */
  function normalizeReplyLineBreaks(text) {
    if (!text) return '';

    // 1) 按原始换行切分，逐行 trim，空行记为段落分隔标记
    const tokens = [];
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (line === '') {
        if (tokens.length && tokens[tokens.length - 1].type !== 'blank') {
          tokens.push({ type: 'blank' });
        }
      } else {
        tokens.push({ type: 'line', text: line, list: isListItem(line) });
      }
    }

    // 2) 合并：list / blank 触发新段落；问候区强制合并；长文本按规则保留断句
    const paragraphs = [];
    let cur = [];          // 当前段落已合并的行
    let lastLine = '';     // 最近加入的「原始 prose 行」（用于长文本判断）
    let greetingZone = false;

    const flush = () => { if (cur.length) { paragraphs.push(cur.join(' ')); cur = []; } lastLine = ''; };

    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];

      if (tk.type === 'blank') { flush(); greetingZone = false; continue; }

      if (tk.list) {                 // ② 列表项：独占一段
        flush();
        paragraphs.push(tk.text);
        greetingZone = false;
        continue;
      }

      // 进入问候区：首段首行命中问候正则
      if (cur.length === 0 && !greetingZone && GREETING_RE.test(tk.text)) {
        greetingZone = true;
      }

      if (greetingZone) {            // 问候语保持单行：强制合并，不触发长文本断句
        cur.push(tk.text);
        lastLine = tk.text;
        if (endsWithTerminal(tk.text)) greetingZone = false;
        continue;
      }

      if (cur.length) {
        // ③ 长文本自然断句：前后均长且前一行未终结 → 保留为独立段落
        const prevLong = lastLine.length >= LONG_LINE;
        const curLong = tk.text.length >= LONG_LINE;
        const prevTerminal = endsWithTerminal(lastLine);
        if (prevLong && curLong && !prevTerminal) {
          paragraphs.push(cur.join(' '));
          cur = [tk.text];
          lastLine = tk.text;
          continue;
        }
        cur.push(tk.text);
      } else {
        cur.push(tk.text);
      }
      lastLine = tk.text;
    }
    flush();

    // 3) 段落以空行连接（下游 cleanReplyText 至多吃掉一个 \n，仍保留段落边界）
    return paragraphs.join('\n\n').trim();
  }

  /**
   * 按字符数对「单条气泡文本」做弹性断行（QQ 式长消息排版）：
   *   - 每行最多 maxPerLine 字，超过才允许折行（短文本 ≤ maxPerLine 保持单行）；
   *   - 行数 = 总字数 / maxPerLine 向上取整，再均分到各行，保证**最后一行 ≥ minTail 字**，
   *     杜绝「第一行 9 字、第二行只剩 1-2 字」的孤儿短行（20 字 → 10+10 而非 15+5）；
   *   - 已有的换行（段落/列表边界）作为不可分割的段落边界保留，段内才做平衡断行。
   * 与 splitReplyIntoParts（按句切分为多个气泡）配合：每句气泡内的文本再按本函数断行，
   * 气泡宽度 = 最宽一行宽度（fit-content 自适应），无需 CSS balance / 百分比列宽。
   * @param {string} text 单条气泡文本（可含已有 \n）
   * @param {number} maxPerLine 每行最多字符数（默认 18，对应一行约 15~20 个汉字）
   * @param {number} minTail 最后一行最少字符数（默认 4）
   * @returns {string} 断行后的文本（\n 分隔）
   */
  function balanceLineBreaks(text, maxPerLine = 18, minTail = 4) {
    if (!text) return '';
    return String(text).split(/\n/).map(seg => balanceSegment(seg, maxPerLine, minTail)).join('\n');
  }

  // 对单个无换行段做平衡断行
  function balanceSegment(seg, maxPerLine, minTail) {
    const chars = Array.from(seg.trim());
    const len = chars.length;
    if (len <= maxPerLine) return chars.join('');
    let lines = Math.ceil(len / maxPerLine);
    let per = Math.ceil(len / lines);
    let tail = len - per * (lines - 1);
    while (tail < minTail && lines > 2) {   // 末行不足 minTail：减少行数，让每行变长
      lines--;
      per = Math.ceil(len / lines);
      tail = len - per * (lines - 1);
    }
    const rows = [];
    for (let i = 0; i < lines; i++) {
      const start = i * per;
      rows.push(chars.slice(start, start + per).join(''));
    }
    return rows.join('\n');
  }

  // 导出：浏览器挂全局，Node 走 module.exports
  global.normalizeReplyLineBreaks = normalizeReplyLineBreaks;
  global.splitOffGreeting = splitOffGreeting;
  global.balanceLineBreaks = balanceLineBreaks;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizeReplyLineBreaks, splitOffGreeting, balanceLineBreaks, isCasualSentence,
      LONG_LINE, GREETING_RE, isListItem, endsWithTerminal
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
