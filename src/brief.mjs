/**
 * brief.mjs —— 模型可见结果的**渲染层**（2026-10-29，用户给的输出规范）。
 *
 * 背景：执行结果与验证逻辑照旧（挖到没挖到、服务端认没认、进度都在对象里），
 *   这里只决定**模型看到什么**：
 *
 *   ① 逐块流水（`mc_dig` 那种多行文本）超过 8 行 ⇒ 保留首行 + 所有"坏消息"行
 *      （失败 / 够不着 / 时间用完 / 还剩 …），其余折叠成一句"另 N 条明细省略"。
 *      **绝不把失败原因和真实进度省掉** —— 那正是模型下一步要用的。
 *   ② 对象结果：**成功**时把"现场快照"（`around` / `entities` / `nearby`）和
 *      诊断中间量（`blockedAhead` / `planTried` / `resetReasons` …）去掉 ——
 *      走到了就是走到了，重复报一遍周围有什么只会挤占上下文。
 *   ③ **失败 / 部分完成时一律保留诊断**：`blockedAhead`、`hint`、`remaining`、
 *      `reason` 是"为什么没到"的唯一线索，删了模型只能瞎猜。
 */

export const BRIEF_MAX_LINES = 8

/** 这些行是"坏消息 / 进度"，折叠明细时必须留下。 */
const KEEP_LINE = /(⛔|⚠️|🔴|❌|失败|没挖|没到|没走动|够不着|卡住|时间用完|分到|还剩|剩下|剩余|拒绝|报错|错误|Error|未能|不确认|没收到|已停在|脱离|不足|没有)/
/** 现场快照：成功时删，失败时留（失败时才需要"周围有什么"来解释原因）。 */
const SENSE_KEYS = ['around', 'entities', 'nearby', 'foes', 'foesNear', 'dropsWhere', 'heldText']
/** 诊断中间量：只有没到达/没成功时才有解释价值。 */
const DIAG_KEYS = [
  'blockedAhead', 'planStep', 'planTried', 'resetReasons', 'pathResets', 'dugBlocks',
  'pillaredWith', 'digStalled', 'thrash', 'escapes', 'swimShift', 'stuckAt', 'blockedBy',
  'stepUp', 'carveTries', 'doorTries', 'pathLenPlanned',
]

/** 多行文本折叠：首行 + 坏消息行，最多 `maxLines` 行。 */
export function briefText (str, { maxLines = BRIEF_MAX_LINES } = {}) {
  const s = String(str ?? '')
  const lines = s.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length <= maxLines) return s
  const keep = []
  let dropped = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (i === 0 || i === lines.length - 1 || KEEP_LINE.test(l)) keep.push(l)
    else dropped++
  }
  if (!dropped) return s
  /* 连"坏消息行"都塞不下时，宁可多留坏消息（首行 + 最后一行可以先让位）。 */
  const body = keep.length > maxLines
    ? keep.filter((l, i) => i !== 0 || keep.length <= maxLines).slice(0, maxLines - 1)
    : keep
  const tail = `　（另 ${dropped} 条明细省略：要逐条看用 mc_scan / mc_observe）`
  return [...body, tail].join('\n')
}

/** 对象结果：成功删现场与诊断，失败全留。 */
export function briefValue (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  const ok = v.arrived === true || v.ok === true || v.confirmed === true
    || v.outcome === 'ok' || v.outcome === 'done' || v.done === true
  if (!ok) return v
  const out = { ...v }
  for (const k of SENSE_KEYS) if (k in out) delete out[k]
  for (const k of DIAG_KEYS) if (k in out) delete out[k]
  return out
}

/**
 * 渲染入口。`json` 由调用方传（index.js 的 compactJson），避免这里再写一份。
 * @returns {string} 模型可见文本
 */
export function briefOf (value, { json = (x) => JSON.stringify(x), maxLines = BRIEF_MAX_LINES } = {}) {
  if (value == null) return ''
  if (typeof value === 'string') return briefText(value, { maxLines })
  if (typeof value?.text === 'string') return briefText(value.text, { maxLines })
  return json(briefValue(value))
}

/**
 * 把结果里的**非有限数**（`NaN` / `Infinity`）换成 `null`（2026-10-30 实机：
 * `mc_move` 连着两次返回 `invalid output: value is not lossless JSON` —— DSH 的结果要过
 * 「无损 JSON」校验，NaN 过不去 ⇒ **整次调用的正常提示全丢**，模型只收到一句 Error，
 * 于是只能换目标再瞎试一次）。数字算不出来就写 null，渲染层显示 `?`，
 * 比让整条结果作废好。
 */
export function finiteOnly (v, depth = 0) {
  if (depth > 8) return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (Array.isArray(v)) return v.map((x) => finiteOnly(x, depth + 1))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = finiteOnly(x, depth + 1)
    return out
  }
  return v
}
