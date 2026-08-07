/**
 * 轻量分词（从 recall.ts 抽取，供 recall / inverted-index / scene 共享）
 *
 * 简易分词：中文按单字 + 相邻双字（bigram）索引，英文按单词。
 * 足够用于关键词召回，不需要引入 jieba 等依赖。
 */

export const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/
const WORD_RE = /[A-Za-z0-9_]+/g

/**
 * 高频功能词（停用词）：查询中出现时不参与检索，避免“帮我写排序算法”命中“写代码用TS”类误报。
 * 只影响查询侧；记忆内容侧不受影响（内容里的词仍可被检索）。
 */
const STOP_WORDS = new Set([
  // 中文功能词
  '的', '了', '是', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '在', '有', '和', '与', '及', '或', '也', '都', '很', '就', '还', '又',
  '把', '被', '让', '给', '对', '从', '向', '到', '去', '来', '用', '想',
  '吗', '呢', '吧', '啊', '哦', '呀', '嘛', '什么', '怎么', '怎样', '如何',
  '为什么', '哪', '哪些', '谁', '哪个', '一个', '这个', '那个', '可以',
  '能', '会', '要', '帮', '请', '请问', '一下', '看看', '帮我', '写', '做',
  '说', '知道', '记得', '觉得', '应该', '可能', '大概', '现在', '今天',
  // 中文单字量词/虚词（tokenize 会同时输出单字，需单独过滤）
  '一', '两', '几', '个', '种', '些', '这', '那', '每', '各', '只', '下', '次',
  '上', '里', '中', '外', '前', '后', '边', '处', '时', '候', '起', '请', '帮', '写', '做',
  // 时间/高频名词单字（避免“今天股票行情”靠单字叠加突破门槛）
  '今', '日', '天', '昨', '明', '股', '票', '行', '情', '涨', '跌', '盘',
  // 时间双字词
  '今日', '昨天', '明天', '昨天', '股票', '行情', '股市', '大盘',
  // 闲聊意图词（“今天天气怎么样”不该命中“天气小程序”项目记忆；项目名仍有小程序/程序等词可召回）
  '天气',
  // 英文功能词
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on',
  'for', 'with', 'and', 'or', 'but', 'i', 'you', 'he', 'she', 'it', 'we',
  'they', 'me', 'my', 'your', 'this', 'that', 'what', 'how', 'why', 'when',
  'can', 'could', 'would', 'should', 'do', 'does', 'did', 'have', 'has',
])

/** 是否为噪声 token（查询侧过滤）：只过滤高频功能词；有意义的单字（名/谁/语等）保留，保证宽松召回 */
export function isStopToken(token: string): boolean {
  return STOP_WORDS.has(token)
}

/**
 * 简易分词：中文按单字 + 相邻双字（bigram）索引，英文按单词。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  // 英文/数字单词
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0]?.toLowerCase() ?? ''
    if (w.length >= 2) tokens.push(w)
  }
  // 中文字符 + bigram
  const chars = text.split('').filter((c) => CJK_RE.test(c))
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const next = chars[i + 1]
    if (ch) tokens.push(ch)
    if (ch && next) tokens.push(ch + next)
  }
  return tokens
}

/** 查询词集合（过滤停用词；单个中文字不参与） */
export function queryTerms(query: string): string[] {
  const raw = tokenize(query)
  const filtered = raw.filter((t) => !isStopToken(t))
  return [...new Set(filtered)]
}

/**
 * 轻量同义词/概念扩展：解决“编程语言 → TypeScript”这类转喻问题。
 * 命中概念词时追加扩展词，扩大召回。MVP 用静态表，后续可换 embedding。
 */
const SYNONYM_EXPANSIONS: Record<string, string[]> = {
  '编程': ['typescript', 'rust', 'python', 'golang', 'java', 'javascript', '语言', '代码', '技术栈'],
  '语言': ['typescript', 'rust', 'python', 'golang', 'java', 'javascript', '代码', '技术栈'],
  '技术栈': ['typescript', 'rust', 'python', 'golang', 'java', 'javascript', '编程', '语言'],
  '名字': ['姓名', 'conrad', '叫'],
  '姓名': ['名字', 'conrad', '叫'],
  '项目': ['proma', 'proactive', '开发'],
  '开发': ['proma', 'proactive', '项目'],
}

/** 扩展查询词（保留原词 + 追加同义词） */
export function expandedQueryTerms(query: string): string[] {
  const terms = queryTerms(query)
  const expanded = [...terms]
  for (const term of terms) {
    const syns = SYNONYM_EXPANSIONS[term]
    if (syns) expanded.push(...syns)
  }
  return [...new Set(expanded)]
}
