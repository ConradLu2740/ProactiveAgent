/**
 * 时间/周期解析器 v0 — 从中文/英文表达中提取 cron / 截止时间 / 标签
 *
 * 目标（补齐局限 #2）：followup/automation 建议预填真实 cron 或 dueAt，
 * 而不是只能"打开表单"。
 *
 * 范围（保守 v0）：
 * - 中文：每天/每周/每月 + 上午/下午/具体钟点；明天/后天/今晚/下周
 * - 英文：every day/week/month/monday... + at 5pm/5:00pm；tomorrow/tonight/next week
 * - 无法解析 → undefined（调用方保持原行为：只给提示文本）
 *
 * 输出：
 * - cron: 标准 5 段 cron（分 时 日 月 周）
 * - dueAt: 绝对毫秒时间戳（相对今天/明天等）
 * - label: 人类可读的中文标签（预填表单用）
 */
export interface ParsedTimeExpression {
  cron?: string
  dueAt?: number
  label: string
}

// ===== 中文数字 → 数字 =====
const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19,
  二十: 20, 二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24,
}

const CN_WEEKDAY: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
}

/** 中文数字（1-24）→ 数字 */
function cnToNum(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s)
  const hit = CN_NUM[s]
  if (hit !== undefined) return hit
  // 复合如"十五" → 10 + 5
  if (/^十/.test(s) && s.length === 2) {
    return 10 + cnToNum(s[1]!)!
  }
  return undefined
}

/** 把 24h 小时 + "上午/下午/晚上" → 绝对小时 */
function hourWithMeridiem(hour: number, meridiem?: string): number {
  if (!meridiem) return hour
  if (meridiem === '上午' || meridiem === '早上' || meridiem === '凌晨') {
    if (hour === 12) return 0
    return hour
  }
  if (meridiem === '下午' || meridiem === '晚上') {
    if (hour === 12) return 12
    if (hour < 12) return hour + 12
    return hour
  }
  return hour
}

/** 下周几的偏移（今天周几 → 目标周几，若已过则 +7） */
function daysUntilWeekday(target: number, from: Date): number {
  const current = from.getDay()
  let delta = target - current
  if (delta <= 0) delta += 7
  return delta
}

/** 相对日期（今天+n 天），返回当天 00:00 的时间戳 */
function dayAt(from: Date, offsetDays: number): number {
  const d = new Date(from)
  d.setDate(d.getDate() + offsetDays)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 解析中文时间表达。
 * 支持：每天/每周X/每月X日 + 上午/下午/晚上 + N点(N时)；明天/后天/今晚/今晚N点/下周X
 */
export function parseChineseTime(text: string, now: Date = new Date()): ParsedTimeExpression | undefined {
  // ---- 周期（cron）----
  // 每天X点 / 每天下午X点
  let m = text.match(/(每天|每日)(上午|早上|凌晨|下午|晚上)?([0-9一二两三四五六七八九十]+)\s*(?:点|时)/)
  if (m) {
    const hour = cnToNum(m[3]!)
    if (hour !== undefined) {
      const h = hourWithMeridiem(hour, m[2])
      return { cron: `${h} 0 * * *`, label: `每天 ${h}:00` }
    }
  }
  // 每天（无钟点）
  if (/(每天|每日)/.test(text)) {
    return { cron: '9 0 * * *', label: '每天 09:00' }
  }
  // 每周X（X点）
  m = text.match(/每周([一二三四五六日天])(上午|早上|凌晨|下午|晚上)?([0-9一二两三四五六七八九十]+)?\s*(?:点|时)?/)
  if (m) {
    const wd = CN_WEEKDAY[m[1]!]
    if (wd !== undefined) {
      const hour = m[3] ? cnToNum(m[3]) : 9
      if (hour !== undefined) {
        const h = hourWithMeridiem(hour, m[2])
        return { cron: `${h} 0 * * ${wd}`, label: `每周${m[1]} ${h}:00` }
      }
    }
  }
  // 每月X日
  m = text.match(/每月([0-9一二两三四五六七八九十]+)(?:日|号)?(上午|早上|凌晨|下午|晚上)?([0-9一二两三四五六七八九十]+)?\s*(?:点|时)?/)
  if (m) {
    const day = cnToNum(m[1]!)
    if (day !== undefined && day >= 1 && day <= 31) {
      const hour = m[3] ? cnToNum(m[3]) : 9
      if (hour !== undefined) {
        const h = hourWithMeridiem(hour, m[2])
        return { cron: `${h} 0 ${day} * *`, label: `每月${day}日 ${h}:00` }
      }
    }
  }

  // ---- 相对时间（dueAt）----
  // 今晚X点 / 明天X点 / 后天X点
  m = text.match(/(今晚|明天|后天)(上午|早上|凌晨|下午|晚上)?([0-9一二两三四五六七八九十]+)\s*(?:点|时)/)
  if (m) {
    const hour = cnToNum(m[3]!)
    if (hour !== undefined) {
      const offset = m[1] === '今晚' ? 0 : m[1] === '明天' ? 1 : 2
      const h = hourWithMeridiem(hour, m[2])
      const base = dayAt(now, offset)
      return { dueAt: base + h * 3600_000, label: `${m[1]} ${h}:00` }
    }
  }
  // 明天 / 后天 / 今晚（无钟点）
  if (/今晚/.test(text)) {
    return { dueAt: dayAt(now, 0) + 21 * 3600_000, label: '今晚 21:00' }
  }
  if (/后天/.test(text)) {
    return { dueAt: dayAt(now, 2) + 9 * 3600_000, label: '后天 09:00' }
  }
  if (/明天/.test(text)) {
    return { dueAt: dayAt(now, 1) + 9 * 3600_000, label: '明天 09:00' }
  }
  // 下周X
  m = text.match(/下周([一二三四五六日天])/)
  if (m) {
    const wd = CN_WEEKDAY[m[1]!]
    if (wd !== undefined) {
      const delta = daysUntilWeekday(wd, now)
      const base = dayAt(now, delta)
      return { dueAt: base + 9 * 3600_000, label: `下${m[1]} 09:00` }
    }
  }

  return undefined
}

// ===== 英文 =====
const EN_WEEKDAY: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
}

/** 解析 "5pm" / "5:00pm" / "17:00" / "5 o'clock" */
function parseEnHour(s: string): number | undefined {
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return undefined
  let h = Number(m[1])
  if (h > 23) return undefined
  const meridiem = m[3]?.toLowerCase()
  if (meridiem === 'pm' && h < 12) h += 12
  if (meridiem === 'am' && h === 12) h = 0
  return h
}

/** 解析英文时间表达（v0 保守） */
export function parseEnglishTime(text: string, now: Date = new Date()): ParsedTimeExpression | undefined {
  const lower = text.toLowerCase()

  // every day/week/month at X
  let m = lower.match(/every\s+(day|week|month)(?:\s+at\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?))?/)
  if (m) {
    const hour = m[2] ? parseEnHour(m[2]) : 9
    if (hour !== undefined) {
      if (m[1] === 'day') return { cron: `${hour} 0 * * *`, label: `every day ${hour}:00` }
      if (m[1] === 'week') return { cron: `${hour} 0 * * 1`, label: `every week (Mon) ${hour}:00` }
      if (m[1] === 'month') return { cron: `${hour} 0 1 * *`, label: `every month (1st) ${hour}:00` }
    }
  }
  // every monday/tuesday...
  m = lower.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?))?/)
  if (m) {
    const wd = EN_WEEKDAY[m[1]!]
    const hour = m[2] ? parseEnHour(m[2]) : 9
    if (wd !== undefined && hour !== undefined) {
      return { cron: `${hour} 0 * * ${wd}`, label: `every ${m[1]} ${hour}:00` }
    }
  }
  // daily / weekly / monthly
  m = lower.match(/\b(daily|weekly|monthly)\b/)
  if (m) {
    if (m[1] === 'daily') return { cron: '9 0 * * *', label: 'every day 09:00' }
    if (m[1] === 'weekly') return { cron: '9 0 * * 1', label: 'every week (Mon) 09:00' }
    if (m[1] === 'monthly') return { cron: '9 0 1 * *', label: 'every month (1st) 09:00' }
  }

  // tomorrow / tonight / next week at X
  m = lower.match(/(tomorrow|tonight)(?:\s+at\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?))?/)
  if (m) {
    if (m[1] === 'tomorrow') {
      const hour = m[2] ? parseEnHour(m[2]) : 9
      if (hour !== undefined) return { dueAt: dayAt(now, 1) + hour * 3600_000, label: `tomorrow ${hour}:00` }
    }
    if (m[1] === 'tonight') {
      const hour = m[2] ? parseEnHour(m[2]) : 21
      if (hour !== undefined) return { dueAt: dayAt(now, 0) + hour * 3600_000, label: `tonight ${hour}:00` }
    }
  }
  // next monday...
  m = lower.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?))?/)
  if (m) {
    const wd = EN_WEEKDAY[m[1]!]
    const hour = m[2] ? parseEnHour(m[2]) : 9
    if (wd !== undefined && hour !== undefined) {
      const delta = daysUntilWeekday(wd, now)
      return { dueAt: dayAt(now, delta) + hour * 3600_000, label: `next ${m[1]} ${hour}:00` }
    }
  }

  return undefined
}

/** 统一入口：自动探测中英文 */
export function parseTimeExpression(text: string, now: Date = new Date()): ParsedTimeExpression | undefined {
  const t = text.trim()
  if (!t) return undefined
  // 中文优先（含汉字）
  if (/[\u4e00-\u9fff]/.test(t)) return parseChineseTime(t, now)
  return parseEnglishTime(t, now)
}
