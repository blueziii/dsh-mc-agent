/**
 * 控制键审计（**只记录，不改行为**）
 *
 * 2026-11-05 实机：`mc_dig {dir:"x+", mode:"stair"}` 上台阶时
 *   「跳的时候没往前走，第二次跳还往后退了一点」
 * 这条现象至少有三条互斥的解释（起跳朝向 / 前进被 back 抵消 / path[0] 与当前同格导致 yaw 被设成 0），
 * 光看结果分不出是哪条。这里把「谁在什么时候按了哪个控制键」直接记下来：
 *
 *   - 每次 `setControlState(key, on)` 记一条（谁调的、按/松、时间）
 *   - 每 200ms 记一次位置（找得到“先增后减”= 真的往后退）
 *   - 结束时聚合：每个调用者的按键次数/总时长、`forward` 与 `back` 是否同时按着、位移首尾
 *
 * 为什么包 `setControlState` 而不是读 vendor 内部状态：这是所有移动的唯一出口
 * （vendor、我们自己的 stepUp/climbUp/backoff/游泳全走它），包这里等于抓住全部作者。
 */

const MAX_EVENTS = 400
const MAX_TRAIL = 120
const TRAIL_MS = 200

/** 从调用栈里找出“是谁按的键”：优先给 `文件:行`，跳过本文件自己的帧。 */
function callerTagOf () {
  const st = String(new Error().stack ?? '')
  const lines = st.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(/[\\/]([A-Za-z0-9_.-]+\.m?js):(\d+)/)
    if (!m) continue
    if (m[1] === 'ctrl-audit.mjs') continue
    return `${m[1]}:${m[2]}`
  }
  return '?'
}

/**
 * 开始审计。返回 `{ stop, peek }`；`stop()` 幂等，两次调用返回同一结果。
 * bot 上没有 `setControlState` 时返回 `null`（测试假 bot 常见）。
 */
export function startCtrlAudit (bot) {
  if (!bot || typeof bot.setControlState !== 'function') return null
  const orig = bot.setControlState.bind(bot)
  const t0 = Date.now()
  const events = []
  const trail = []
  let lastSample = 0
  let stopped = null

  bot.setControlState = (key, on) => {
    try {
      events.push({ t: Date.now() - t0, by: callerTagOf(), key: String(key), on: Boolean(on) })
      if (events.length > MAX_EVENTS) events.shift()
    } catch { /* 记日志绝不能影响移动 */ }
    return orig(key, on)
  }

  const onTick = () => {
    const now = Date.now()
    if (now - lastSample < TRAIL_MS) return
    lastSample = now
    const p = bot?.entity?.position
    if (!p) return
    trail.push({ t: now - t0, x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) })
    if (trail.length > MAX_TRAIL) trail.shift()
  }
  try { bot.on('physicsTick', onTick) } catch { /* 假 bot 没事件 */ }

  const summarize = () => {
    /* ① 按调用者聚合：谁按了什么、多少次、共多久。 */
    const keys = {}
    const held = {} // 'by|key' -> 按下时刻
    for (const e of events) {
      const k = `${e.by}|${e.key}`
      const rec = keys[k] ?? (keys[k] = { by: e.by, key: e.key, on: 0, off: 0, ms: 0 })
      if (e.on) { rec.on++; held[k] = e.t } else { rec.off++; if (held[k] != null) { rec.ms += e.t - held[k]; delete held[k] } }
    }
    for (const k of Object.keys(held)) keys[k].ms += Date.now() - t0 - held[k]
    const keyList = Object.values(keys)
      .filter((r) => r.key !== 'sprint') // sprint 噪音大，且不影响“为什么不前进”
      .sort((a, b) => b.ms - a.ms || b.on - a.on)
      .slice(0, 8)
      .map((r) => ({ by: r.by, key: r.key, on: r.on, ms: r.ms }))

    /* 按**裸键名**汇总（不分调用者）：回答“这一趟 forward 到底被按了多久”。 */
    const byKey = {}
    for (const r of Object.values(keys)) {
      const rec = byKey[r.key] ?? (byKey[r.key] = { on: 0, ms: 0 })
      rec.on += r.on
      rec.ms += r.ms
    }

    /* ② forward 与 back 同时按着的总时长 —— 这是“人不动 / 往后退”的头号嫌疑。
     *   ⚠️ 判“同时”必须按**键名**算，不能按“调用者+键名”：同一次按下和松开往往来自
     *   不同的代码行（on 在 vendor 的 tick 里，off 在别处），按 caller 分组会导致永远删不掉，
     *   bothMs 恒为 0（第一版就踩了这个坑）。这里用计数：同一个键被两处同时按着也算 1。 */
    let bothMs = 0
    const heldByKey = new Map() // key -> 还按着几处
    let bothSince = null
    const addKey = (k, on) => {
      const n = (heldByKey.get(k) ?? 0) + (on ? 1 : -1)
      if (n <= 0) heldByKey.delete(k)
      else heldByKey.set(k, n)
    }
    const checkBoth = (t) => {
      const both = heldByKey.has('forward') && heldByKey.has('back')
      if (both && bothSince == null) bothSince = t
      else if (!both && bothSince != null) { bothMs += t - bothSince; bothSince = null }
    }
    for (const e of events) {
      addKey(e.key, e.on)
      checkBoth(e.t)
    }
    /* 到结束还同时按着：算到最后一个事件，不凭 Date.now（可能已过很久）。 */
    if (bothSince != null && events.length) bothMs += events[events.length - 1].t - bothSince

    /* ③ 位移首尾 + 是否“先靠近后远离”（用目标不在手边，只看净位移与折返）。 */
    const first = trail[0] ?? null
    const last = trail[trail.length - 1] ?? null
    let backSteps = 0
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]
      const b = trail[i]
      const da = Math.hypot(b.x - a.x, b.z - a.z)
      if (da > 0.25) backSteps++
    }
    return {
      ms: Date.now() - t0,
      keys: keyList,
      bothMs: Math.round(bothMs),
      byKey,
      trailFrom: first,
      trailTo: last,
      moves: backSteps,
      trail: trail.length > 24 ? trail.slice(-24) : trail
    }
  }

  const peek = () => summarize()

  function stop () {
    if (stopped) return stopped
    try { bot.setControlState = orig } catch { /* 已经被别人换过就算了 */ }
    try { bot.removeListener('physicsTick', onTick) } catch { /* 同上 */ }
    stopped = summarize()
    return stopped
  }

  return { stop, peek }
}
