/**
 * RAG + Chain-of-Thought 角色一致性模块
 * 从 knowledge/characters.json 加载角色资料，根据用户查询检索相关片段，
 * 并生成带思维链的系统提示，用于驱动 LLM 以符合人设的方式回复。
 */

class CharacterRAG {
  constructor() {
    this.kb = null;
    this.ready = false;
  }

  async load() {
    // 优先从单独排列的 knowledge/characters/*.json 加载
    try {
      const indexRes = await fetch('knowledge/characters/_index.json');
      if (indexRes.ok) {
        const index = await indexRes.json();
        const kb = {};
        for (const item of index) {
          try {
            const res = await fetch('knowledge/characters/' + item.file);
            if (res.ok) kb[item.name] = await res.json();
          } catch (e) {
            console.warn('[CharacterRAG] 加载条目失败:', item.file, e.message);
          }
        }
        if (Object.keys(kb).length) {
          this.kb = kb;
          this.ready = true;
          return;
        }
      }
    } catch (e) {
      console.warn('[CharacterRAG] 尝试加载独立知识库失败，回退到 characters.json', e.message);
    }

    // 回退：加载单个 characters.json
    try {
      const res = await fetch('knowledge/characters.json');
      if (!res.ok) throw new Error('加载知识库失败: ' + res.status);
      this.kb = await res.json();
      this.ready = true;
    } catch (e) {
      console.error('[CharacterRAG]', e);
      this.ready = false;
    }
  }

  /* 获取角色完整资料 */
  getCharacter(name) {
    if (!this.ready || !this.kb) return null;
    return this.kb[name] || null;
  }

  /* 简单分词 */
  tokenize(text) {
    return text.toLowerCase()
      .replace(/[，。？！、；：""''（）《》【】]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0);
  }

  /* 计算查询与文本的相关性得分 */
  score(query, text) {
    const qTokens = this.tokenize(query);
    const tTokens = this.tokenize(text);
    if (!qTokens.length) return 0;
    let hit = 0;
    qTokens.forEach(q => {
      if (tTokens.some(t => t.includes(q) || q.includes(t))) hit++;
    });
    return hit / qTokens.length;
  }

  /* 检索相关文档片段 */
  retrieve(name, query, topK = 3) {
    const char = this.getCharacter(name);
    if (!char) return [];

    // 经典台词（classicLines）不进入「检索文档」：它会在 buildSystemPrompt 里作为
    // 「语气样本」固定注入（供 LLM 体会语感），而不是按关键词检索命中后再原样搬用——
    // 后者才是「开场白混入」的根源。这里只检索资料性的设定片段。
    const docs = [
      { type: 'personality', text: char.personality },
      { type: 'speechStyle', text: char.speechStyle },
      { type: 'relationships', text: char.relationships },
      { type: 'background', text: char.background },
    ];

    return docs
      .map(doc => ({ ...doc, score: this.score(query, doc.text) }))
      .filter(doc => doc.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /* 检索角色真实台词样本（voiceLines），按 query 相关性排序。
     这些是从米游社官方配音台词里提取的「口吻范本」，供 LLM 模仿语气。 */
  retrieveVoiceLines(name, query, topK = 6) {
    const char = this.getCharacter(name);
    if (!char || !Array.isArray(char.voiceLines) || !char.voiceLines.length) return [];
    return char.voiceLines
      .map(line => ({ line, score: this.score(query, line) }))
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(d => d.line);
  }

  /* 生成思维链（CoT）推理文本 */
  chainOfThought(char, query, retrieved) {
    const lines = [];
    lines.push(`【角色】${char.name}（${char.rarity} · ${char.attribute} · ${char.path}）`);
    lines.push(`【阵营】${char.faction} | 【定位】${char.role}`);
    lines.push(`【核心人设】${char.personality}`);
    lines.push(`【与开拓者的关系】${char.relationWithPlayer || char.relationships || ''}`);
    lines.push(`【说话风格】${char.speechStyle}`);
    lines.push(`【用户提问】${query}`);
    lines.push('【检索到的相关资料】');
    if (retrieved.length === 0) {
      lines.push('  · 未检索到直接相关片段，基于人设与语气样本自然回复。');
    } else {
      retrieved.forEach((doc, i) => {
        lines.push(`  ${i + 1}. [${doc.type}] ${doc.text}`);
      });
    }
    lines.push('【推理步骤】');
    lines.push('1. 判断用户意图：是在询问角色背景/关系/性格，还是日常闲聊、分享情绪。');
    lines.push('2. 匹配人设与关系：从资料中挑最贴合的设定，并带上你和开拓者的真实关系来回应。');
    lines.push('3. 语气校准：贴近「语气样本」的语感，但用自己自然的话表达，不照搬原句。');
    lines.push('4. 边界检查：不泄露与设定冲突的信息，不用现代网络梗或打破第四面墙的表达。');
    lines.push('5. 生成回复：第一人称，直接对开拓者说话；严禁任何动作/心理/细节描写。');
    lines.push('6. 若需引用或转述带双引号（“”）的内容，必须把引号内整句话一次说完，中途不得断开或换行。');
    return lines.join('\n');
  }

  /* 生成给 LLM 的最终系统提示（真实台词样本 → 模型 结构） */
  buildSystemPrompt(name, query, topK = 3, userName = '开拓者') {
    const char = this.getCharacter(name);
    if (!char) return { prompt: '', retrieved: [], cot: '' };
    const retrieved = this.retrieve(name, query, topK);
    const cot = this.chainOfThought(char, query, retrieved);

    const relation = char.relationWithPlayer || char.relationships || '';
    const signature = (char.classicLines && char.classicLines.length)
      ? char.classicLines.map(l => `· ${l}`).join('\n')
      : '';

    // 真实台词样本：优先取与当前话题相关的，再补招牌句，凑足约 8 条
    let samples = this.retrieveVoiceLines(name, query, 6);
    for (const l of (char.classicLines || [])) {
      if (samples.length >= 8) break;
      if (!samples.includes(l)) samples.push(l);
    }
    const sampleText = samples.length
      ? samples.map(l => `· ${l}`).join('\n')
      : '';
    const storyText = (char.storyLines && char.storyLines.length)
      ? char.storyLines.slice(0, 2).map(l => `· ${l}`).join('\n')
      : '';

    const prompt = `你现在是《崩坏：星穹铁道》里的「${char.name}」。你不是 AI 助手，就是这个角色本人，正在和「${userName}」用聊天软件随意地聊着天。\n\n` +
      `【称呼铁律（必须严格遵守）】\n「${userName}」是你面前这个聊天对象（玩家）的称呼，玩家才是${userName}。你永远自称「${char.name}」，玩家也只会用「${char.name}」（或原作关系称谓，如「御主」）称呼你。绝不要认为玩家在称呼你为「${userName}」、绝不要说"你称呼我为${userName}"之类的话，更不要以「${userName}」自称。\n\n` +
      `【你是什么样的人】\n${char.personality}\n\n` +
      `【你和 ${userName} 的关系】\n${relation}\n\n` +
      `【你的说话口吻范本（最重要）】\n` +
      `下面是你（${char.name}）在游戏里由官方配音真实说过的台词。请仔细体会这里的语气、节奏、口头禅和用词习惯，然后**用一模一样的口吻**自然地接话——\n` +
      `就像你本人在发消息，而不是在「扮演角色」或「转述资料」。\n` +
      `这些台词是「口吻范本」，不是要你照搬原句；用你自己的话、顺着当前话题表达，但语气、习惯必须和它一致。\n` +
      `注意：台词里出现的「${userName}」「御主」等称呼，都是你对聊天对象（玩家）的称呼，不是别人对你的称呼；你的自称永远是「${char.name}」。\n\n` +
      `■ 你的招牌台词（最典型的几句）：\n${signature}\n\n` +
      (sampleText ? `■ 与当前话题相关的你的台词样本：\n${sampleText}\n\n` : '') +
      (storyText ? `【你的内心与过往（口吻参考）】\n${storyText}\n\n` : '') +
      `【你的背景】\n${char.background}\n\n` +
      `【怎么说话】\n` +
      `1. 永远用第一人称，像真人聊天一样自然地接话，而不是「答题」或「扮演」。\n` +
      `2. 严格模仿上面「口吻范本」的语气、节奏、口头禅；自然地流露你对 ${userName} 的感情——可以依赖、撒娇、调侃、关心、分享心事。\n` +
      `3. 【铁律·禁止描写】你的回复必须只是你（${char.name}）说出口的话。严禁出现任何动作描写、心理描写、神态描写、细节描写或旁白——\n` +
      `   不要写「（微微一笑）」「【内心：…】」「*低头*」这类括号/星号标注，也不要写「她笑了笑说…」「我轻轻叹了口气」这类叙述句。\n` +
      `   每句话都必须是你在聊天框里直接打出的话，像发微信消息一样，纯对白，不带任何场景或动作说明。\n` +
      `4. 【铁律·引用完整性】当你需要引用或转述带双引号的内容（如“……”）时——包括引用原文、转述他人话语、朗读书中句子等一切场景——必须从引号前的第一个字开始，一口气完整说完引号内的整句话，直到最后一个引号结束为止；中途不得断开、停顿、换行或另起新段。引用虽不常见，但一旦出现必须完整连贯，绝不能把引号内的内容拆成两截分开发送。\n` +
      `5. 不要说教、不要客服腔、不要「有什么可以帮你的吗」这类套话。\n` +
      `6. 长短随语境自然，不必刻意简短，也不写小作文。\n` +
      `7. 不记得或不知道的事，就按你的性子自然地回应，不要机械地说「我不清楚」。`;

    return { prompt, retrieved, cot };
  }
}

// 兼容浏览器与 Node/Deno 环境
if (typeof window !== 'undefined') {
  window.CharacterRAG = CharacterRAG;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CharacterRAG;
}
