/*
 * 移动那一层：现在只有两个"原地按/松控制位"的小原语 —— `jump` 与 `swimUp`。
 *
 * 大件按路线图第 ④ 条逐步搬进来：第三十五刀两个纯控制位（`jump` / `swimUp`）、
 * 第三十六刀移动主体（`walkSwim` / `walkTo` / `flyTo`）、第三十七刀 `walkPathfinder`（移动最后一块）。
 *
 * 两条都是"按住某个控制位一小会儿"：
 *   · `jump(self, ctx)` —— 原地蹦一下（爬台阶 / 从卡住里出来）。领移动号、只在还是自己时才松 jump，
 *     落地缓冲不超过本轮剩余时间；已 abort 或本轮时间用完就如实拒绝（不再固定占 520ms）。
 *   · `swimUp(self, opts, ctx)` —— 在水里按住 jump **上浮换气**（不是"跳"：水里按 jump 是浮在水面游）。
 *     判据用 `inWaterNow(b)` 而不是 `entity.isInWater`（泡在水柱里没贴水面时后者读出来是 undefined）。
 *
 * 形状：读写全是实例状态（`requireBot` / `callLeft` / `msLeft` / `abortSignal` / `position` / `_moveGen`）
 * ⇒ 第一参数收 `self`；`#beginMove` 是私有方法、模块够不着 ⇒ 由 core 的薄包装塞进 `ctx.bumpGen`
 *（迁移规矩第 28 条；`_moveGen` 本身是下划线公开字段，模块里照旧读它判"还是不是我"）。
 */
import { sleep, raceAbort, abortError, withTimeout, DESYNC_HINT } from './async-util.mjs'
import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
import { callBudget, callSecText, budgetSecText, CALL_BUDGET_MS, CALL_MS } from './budget.mjs'
import { inWaterNow, inLavaNow } from './world-observer.mjs'
import { connectionStale } from './connection.mjs'
import { heldText, invSnap, invUsed, canBreakNow, breakMsNow, toolKinds } from './inventory.mjs'
import { bestToolFor } from './dig-speed.mjs'
import { isAir, isLiquid, isPassable, isSolidBlock, isTreeBlock, isTreeLog, isLeafBlock, isWaterLike, isLavaLike } from './block-names.mjs'
import { BRIDGE_FATAL, heldSnapshotOf, restoreHeldOf } from './bridge.mjs'
import { classifyTerrainCached } from './terrain.mjs'
import { recoverFromWater } from './water-recovery.mjs'
import { lavaEscape } from './lava-recovery.mjs'
/* 🔴 2026-10-16 审计（P1，四类耗时）：`goto` 这一段的墙钟**几乎全是"等寻路"** ——
 *    把它上报给性能监测，`mc_move` 才不会在 `perf` 里显示成"慢得可疑、要不要搬 Worker"。
 *    没人包 `perfWrap` 时它是空操作（零成本）。 */
import { perfWait } from './perf-monitor.mjs'
import { startCtrlAudit } from './ctrl-audit.mjs'

/** 把控制键审计压成短摘要（完整轨迹太长，只留最后 6 个采样点）。 */
function ctrlAuditOf (audit) {
  if (!audit || typeof audit.stop !== 'function') return null
  let c = null
  try { c = audit.stop() } catch { return null }
  if (!c) return null
  return {
    ms: c.ms,
    keys: c.keys,
    bothMs: c.bothMs,
    from: c.trailFrom,
    to: c.trailTo,
    moves: c.moves,
    trail: Array.isArray(c.trail) ? c.trail.slice(-6) : []
  }
}
import { isHostileEntity, shouldDodgeEntity, entityTextOf, MOVE_ENTITY_DODGE_MAX } from './entity-avoid.mjs'

/**
 * 给水下恢复控制器用的执行器 —— **就是这一层已有的 `walkTo` / `swimUp`**，不另起一套按键。
 * 用户 2026-10-15 的约束原话："实际移动仍通过现有接口执行，避免另起一套按键控制、移动代次或资源锁"。
 * `noWaterRecover` 防递归：恢复过程中再走一次路时不许再次触发恢复。
 */
function recoverCtxOf (self, ctx) {
  return {
    /* 🔴 2026-10-24 通审：原来只透传 arrive/budget —— 脱困过程中再走路时，调用方给的
     *    intent / allowDig / noTower / xz 全被丢掉（stand 变 near、不许挖变成可以挖）。原样转发。 */
    walkTo: (s, p, o = {}) => walkTo(s, p, { ...o }, { ...ctx, noWaterRecover: true }),
    swimUp: (s, o) => swimUp(s, o, ctx),
  }
}

/**
 * 把走路目标的 y 收到底面：那个 y **站不住**时，往下找最近能站的一层。
 *
 * 🔴 为什么必须有（用户 2026-10-13 实机报的"搭路一直搭到空气上"）：
 *    AI 给的走路目标 y 常常是**半空**——`mc_map`/`mc_scan` 报的"地表高度"在树林里是树冠顶、
 *    在山上是最高的石头，从实体/玩家那抄来的 y 也可能是对方站在高处时的值。
 *    `goals.GoalNear` 是按**三维距离**算的，于是 pathfinder 为了"离那个 y 近一点"，
 *    会一路**垫方块把自己顶上去**（返回值里的 `pillared`）——玩家看到的就是"往空气上搭"。
 *    实机证据：`mc_move {x:10,y:68,z:-100}` 只挪了 1 格却 `pillared: 9`（目标比脚下高 9 格）。
 *
 * 判据：脚下那格是**实心**（不是空气/液体）且这一格与头上一格都能穿过（`isPassable`）。
 * 找不到就**原样返回**（跨沟搭桥那种目标本来就该让 pathfinder 自己想办法）。
 *
 * @param {object} b 机器人
 * @param {number} x 目标 x
 * @param {number} y 目标 y（可能偏高）
 * @param {number} z 目标 z
 * @returns {number} 修正后的 y
 */
export function standableY (b, x, y, z) {
  const gx = Math.floor(x); const gy = Math.floor(y); const gz = Math.floor(z)
  const at = (xx, yy, zz) => {
    try { return b.blockAt(new Vec3(xx, yy, zz)) } catch { return null }
  }
  const canStand = (yy) => {
    const u = at(gx, yy - 1, gz); const a = at(gx, yy, gz); const c = at(gx, yy + 1, gz)
    if (!u || !a || !c) return false
    if (isAir(u.name) || isLiquid(u.name)) return false
    return isPassable(a.name) && isPassable(c.name)
  }
  if (canStand(gy)) return gy
  for (let d = 1; d <= 4; d++) if (canStand(gy - d)) return gy - d
  for (let d = 1; d <= 2; d++) if (canStand(gy + d)) return gy + d
  return gy
}
/** 那一格「人能不能站」：脚下有实地 + 本格与头顶都能通行。
 *  （`standableY` 的老判据，抽出来给 `standPointFor` 复用 —— 2026-10-22 用户第三条寻路反馈） */
export function canStandAtWorld (b, gx, gy, gz) {
  const at = (xx, yy, zz) => {
    try { return b.blockAt(new Vec3(xx, yy, zz)) } catch { return null }
  }
  const u = at(gx, gy - 1, gz); const a = at(gx, gy, gz); const c = at(gx, gy + 1, gz)
  if (!u || !a || !c) return false
  if (isAir(u.name) || isLiquid(u.name)) return false
  return isPassable(a.name) && isPassable(c.name)
}

/**
 * 🔴 2026-10-22 用户第三条反馈（原文）：「goal 点选在了不可站立的格子 …… A* 永远算不出
 *    "站上去"的终点 —— 要么绕死，要么原地不动」。
 *    实测场景：把目标设成 (-10,79,41)/(-10,79,42) 这种**门框内侧**格（被门碰撞箱占着、
 *    或头顶只有 1 格净空），`standableY` 只会在**同一根柱子**上上下找 4/2 格，找不到就
 *    原样把不可站的 y 丢给 A* ⇒ 终点永远不成立。
 *
 *    这里补**水平邻域**：本格站不住就往外找一圈（同层 8 邻 → y±1 的 8 邻），
 *    挑最近的可站格当落点，并如实把"改了去哪"报回去（`adjustedFrom`）。
 *    只挪 1 格，不会把目标搬到别的地方；邻域里一个能站的都没有才退回原值。
 */
export function standPointFor (b, x, y, z) {
  const gx = Math.floor(Number(x)); const gy = Math.floor(Number(y)); const gz = Math.floor(Number(z))
  if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)) {
    return { x: gx, y: gy, z: gz, adjusted: false }
  }
  /* ① 原格能站：一格都不挪（绝大多数情况走这条） */
  if (canStandAtWorld(b, gx, gy, gz)) return { x: gx, y: gy, z: gz, adjusted: false }
  /* ② 本柱上下各一格（台阶/半砖那种差一层的目标） */
  for (const dy of [-1, 1]) {
    if (canStandAtWorld(b, gx, gy + dy, gz)) {
      return { x: gx, y: gy + dy, z: gz, adjusted: true, from: { x: gx, y: gy, z: gz } }
    }
  }
  /* ③ 水平邻域：先同层，再上下各一层（门框内侧、只有 1 格净空的格子走这条） */
  for (const dy of [0, -1, 1]) {
    for (const [dx, dz] of NEIGHBOR8) {
      if (canStandAtWorld(b, gx + dx, gy + dy, gz + dz)) {
        return { x: gx + dx, y: gy + dy, z: gz + dz, adjusted: true, from: { x: gx, y: gy, z: gz } }
      }
    }
  }
  /* ④ 实在没有：退回老规矩（本柱往下 4 格 / 往上 2 格，给"目标 y 在半空"兜底） */
  const sy = standableY(b, gx, gy, gz)
  /* 🔴 2026-10-30 用户：「刚刚的坐标我看了一下，是半空中。怎么没有直接搭到坐标」——
   *    整列都站不住时 `standableY` 会把原 y 原样退回，以前就当成“目标可站”交给 A*：
   *    A* 眼里那一格是空气、站不上去 ⇒ 永远 NoPath ⇒ 六次重算后谎报“路线被作废”。
   *    这里如实标 `noStand`，由上层决定“垫上去”还是“说清楚”。 */
  /* 只对“**世界读得到**、且确实站不住”的目标下这个结论 —— 读不到方块（区块没加载 /
   * 假 bot）时不能断言“它不可站”，否则会拿“没看见”当“没路”。 */
  if (sy === gy && !canStandAtWorld(b, gx, gy, gz) && blockKnownAt(b, gx, gy - 1, gz)) {
    return { x: gx, y: gy, z: gz, adjusted: false, noStand: true, from: { x: gx, y: gy, z: gz } }
  }
  return { x: gx, y: sy, z: gz, adjusted: sy !== gy, from: sy !== gy ? { x: gx, y: gy, z: gz } : undefined }
}

/** 8 邻（先正交后对角，走得短） */
const NEIGHBOR8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]

/**
 * 🔴 2026-10-22 用户第二条反馈：「起点落在"半格"里，A* 认为我卡在方块内部 —— 站在耕地、
 *    箱子顶、门格上时，坐标是 y=78 而脚下那格其实是 farmland（0.9375 格高），起点被判定
 *    成"嵌在方块里"，寻路第一步就无解 ⇒ 直接 `moved: 0` + `arrived: true` 的假成功」。
 *
 *    `bot.entity.position` 是**脚底浮点**（站 farmland 上 y=78.9375），`Math.floor` 会把它
 *    算成 78 —— 而 78 那格正是 farmland 自己。这里把那一位补回来：脚所在的格子如果被
 *    实心方块占着（站不进去），就取它上面那一格。
 */
export function standFeetY (b, pos) {
  const gx = Math.floor(Number(pos?.x ?? 0)); const gz = Math.floor(Number(pos?.z ?? 0))
  const gy = Math.floor(Number(pos?.y ?? 0))
  const at = (xx, yy, zz) => {
    try { return b.blockAt(new Vec3(xx, yy, zz)) } catch { return null }
  }
  const here = at(gx, gy, gz)
  if (!here) return gy
  /* 本格被实心且不能穿过的方块占着 = 人实际站在它上面 */
  if (isSolidBlock(here.name) && !isPassable(here.name)) {
    const above = at(gx, gy + 1, gz)
    if (!above || isPassable(above.name)) return gy + 1
  }
  return gy
}

/** 原地跳一下（爬台阶用） */
export async function jump (self, ctx = {}) {
  const bumpGen = ctx.bumpGen ?? (() => ++self._moveGen)
  const b = self.requireBot()
  endHoverFlight(b)   // 悬停着就别想蹦/走：先恢复重力（否则走路全废，见 endHoverFlight）
  /* 🔴 2026-10-08 审计⑥：以前固定占 520ms —— 不看预算、不认中断。
   *    探针：已 abort + `setCallDeadline(0)` 时仍按 jump 526ms 才返回（同条件 `flyTo` 1ms 就抛
   *    `mcAborted`）。用户已经点了停止，还会多做一个真实的跳跃动作。 */
  if (self.abortSignal?.aborted) throw abortError('跳跃', self.abortSignal)
  const left = self.msLeft()
  if (left <= 120) {
    throw new Error(`这一轮的 ${callSecText()}用完了（单次调用最多 ${budgetSecText()}）—— 过一会儿再叫一次 mc_move{mode:"jump"}`)
  }
  /* 🔴 审计（第四份报告②）：jump 以前**不领 `_moveGen` 号**，finally 里无条件松 jump
   *    ⇒ 会把"接管者"（另一次移动/反射层）正按着的 jump 松掉。现在领号，只在还是自己时才松。 */
  const gen = bumpGen('jump')
  const hold = Math.max(60, Math.min(320, left - 120))
  /* 🔴 2026-10-23 审计（移动层报告 A[8]）：以前按满 320ms 就报成功 —— 头顶只有 1 格净空、
   *    站在半砖上、或者服务端没认这一下时，人**一格都没起来**，AI 却以为爬台阶爬上了。
   *    现在在按住结束那一刻（约 320ms，正常已经在上升段）量一下高度，据实回报。 */
  const y0 = Number.isFinite(b?.entity?.position?.y) ? b.entity.position.y : null
  b.setControlState('jump', true)
  let rose = null
  try {
    await raceAbort(sleep(hold), self.abortSignal, '跳跃')
    if (y0 != null && Number.isFinite(b?.entity?.position?.y)) rose = Number((b.entity.position.y - y0).toFixed(3))
  } finally {
    if (self._moveGen === gen) { try { b.setControlState('jump', false) } catch { /* 忽略 */ } }
  }
  // 落地缓冲（别超过本轮剩余时间）
  const rest = Math.max(0, Math.min(200, self.msLeft() - 60))
  if (rest > 0) await raceAbort(sleep(rest), self.abortSignal, '跳跃')
  const jumped = rose == null ? null : rose > 0.05
  /* 用户 2026-10-23：「跳不起来」时 AI 只能瞎猜 —— 直接抬头量一下，把堵在头顶的那格名字给出去。 */
  const above = aboveOf(b)
  return {
    position: self.position,
    ...(rose == null ? {} : { rose }),
    ...(jumped === false ? {
      jumped: false,
      note: above && !above.canJump
        ? "按了跳但**没离地**（rose≈0）—— " + above.note
        : '按了跳但**没离地**（rose≈0）—— 卡在半砖上 / 服务端没认。别当「跳上去了」用',
    } : { jumped }),
    ...(above ? { above } : {}),
  }
}

/**
 * 上浮换气（在水里按住 jump 游泳）。**淹死的机制**是氧气（`air`）掉到 0 之后开始掉血，
 * 所以正确动作是"先浮上来换气"，而不是挖水（水/岩浆是流体，挖不掉）。
 * 一次最多 3 秒（和别的动作一样，宁可少量多次），返回 rose（涨了几格）与 air。
 */
export async function swimUp (self, { hold = 3_000 } = {}, ctx = {}) {
  const bumpGen = ctx.bumpGen ?? (() => ++self._moveGen)
  const b = self.requireBot()
  const e = b.entity
  const airOf = () => (Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null)
  const y0 = e?.position?.y ?? null
  const air0 = airOf()
  /* 🔴 2026-10-08 实机：这里以前只看 `entity.isInWater` —— 而它在**泡在水柱里但没贴水面**
   *    时读出来是 undefined（prismarine-physics 的入水 AABB 从底部缩了 0.401）。
   *    实测机器人沉在 (-31,59,261)、脚/头两格都是 water、`onGround:false`，
   *    `swimUp` 却回"我本来就没在水里" ⇒ 淹死也救不了自己。改用和挖矿守卫同一个判据。 */
  /* 🔴 2026-10-27 实机（"现在掉在岩浆里动不了"）：这里以前只认水 —— 泡在岩浆里叫
   *    `mc_move {mode:"swim"}` 会被回一句"我本来就没在水里"，于是一个能救命的动作（按 jump
   *    上浮）被语义挡在门外。岩浆里按 jump 同样是往上浮，判据一起收。 */
  const inLava = inLavaNow(b)
  if (!inWaterNow(b) && !inLava) {
    return { inWater: false, inLava: false, air: air0, note: '我本来就没在水里 —— 这条是给"在水里憋气"用的' }
  }
  const want0 = Number.isFinite(Number(hold)) ? Number(hold) : 9_000
  /* 🔴 2026-10-08 第四份审计报告 ①④⑧：swimUp 以前三个病一起犯 ——
   *   ① 完全不认中断（abort 后仍空转满 3 秒，`heldMs` 还是**假数据**）；
   *   ④ 预算归零时 `Math.max(200, …)` 白送 200ms（探针：`setCallDeadline(0)` ⇒ 真按了 215ms）；
   *   ⑧ `Number(hold) || 3_000` 把 `hold: 0` 当成 3000。
   *   现在：先看预算、领 `_moveGen` 号、每轮查 abort 与号、`heldMs` 报实际按住时长。 */
  const left = self.callLeft()
  if (left <= 300) {
    return {
      inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, reason: 'call-over', remaining: 1,
      hint: `这一轮的 ${callSecText()}用完了，我没按 —— 过一会儿再叫一次 mc_move 往岸上走（路上会自己上浮）`,
    }
  }
  /* 🔴 2026-10-19 实机（用户："swim 现在不行，得改"）：以前上限写死 3 秒 —— 水深 15+ 格时
   *    一次只升 1~3 格，松手又沉下去，看着就是原地晃。给到 10 秒（工具 12 秒超时留余量），
   *    一次调用就能真浮上来。 */
  const want = Math.max(0, Math.min(want0, 10_000, left - 300))
  if (want <= 0) {
    return { inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, note: 'hold 是 0（没让我按）—— 要上浮就朝岸边叫一次 mc_move（水里会自己按住 jump）' }
  }
  /* 🔴 2026-10-25 实机（用户：「我看它基本没浮起来，自救没用了？」）：
   *   以前只看"有没有上升"，**不先看头顶** —— 头顶被封死时照样按满 hold（1.2~10 秒）的 jump，
   *   `rose` 一直是 0，最后只回一句"没上去"，不说为什么。AI 只能自己猜"头顶哪格挡着"。
   *   现在：先读脚上方两格，第一格实心就立刻返回（省掉那一整段白按），并说清该挖哪一格。
   *   判据用 `isWaterLike`（含 seagrass/kelp/bubble_column）+ `isPassable`，别把水草当成天花板。 */
  const ceilingOf = () => {
    try {
      const p = b.entity?.position
      if (!p) return null
      const bx = Math.floor(p.x)
      const by = Math.floor(p.y)
      const bz = Math.floor(p.z)
      for (let dy = 1; dy <= 2; dy++) {
        const blk = b.blockAt(new Vec3(bx, by + dy, bz))
        if (!blk) continue
        const nm = String(blk.name ?? '')
        if (!nm || isAir(nm) || isWaterLike(nm) || isLavaLike(nm) || isPassable(nm)) continue
        return { name: nm, dy, x: bx, y: by + dy, z: bz }
      }
      return null
    } catch { return null }
  }
  const ceil = ceilingOf()
  if (ceil) {
    return {
      inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, reason: 'ceiling',
      ceiling: { name: ceil.name, x: ceil.x, y: ceil.y, z: ceil.z },
      hint: `头顶${ceil.dy === 1 ? '' : '第二格'}就是 **${ceil.name}**（${ceil.x}, ${ceil.y}, ${ceil.z}）`
        + ' —— **上浮没路**，再按 jump 也升不上去，别重复叫 swim。\n'
        + `挖开它：\`mc_act {"mode":"break","x":${ceil.x},"y":${ceil.y},"z":${ceil.z}}\``
        + '（挖开若上面还是水，水会灌下来）；\n'
        + '或者往**侧面实心方块**里挖一格做空气袋（水灌不进去），钻进去换气再上来。',
    }
  }
  const gen = bumpGen('swimup')
  const t0 = Date.now()
  let held = 0
  let preempted = false
  try {
    b.setControlState('jump', true)
    while (Date.now() - t0 < want) {
      if (self.abortSignal?.aborted) throw abortError('上浮', self.abortSignal)
      await raceAbort(sleep(100), self.abortSignal, '上浮')
      held = Date.now() - t0
      if (self._moveGen !== gen) { preempted = true; break }              // 被别人接管了
      if (!inWaterNow(b)) break                                     // 已经出水
      const a = airOf()
      const rose = y0 != null && b.entity?.position ? b.entity.position.y - y0 : 0
      if (held > 500 && rose >= 0.4 && a != null && a >= 20) break        // 头露出水面、气在恢复
    }
  } finally {
    /* 🔴 报告②：只在**还是自己**的时候松 jump —— 否则会把接管者正按着的 jump 松掉。 */
    if (self._moveGen === gen) { try { b.setControlState('jump', false) } catch { /* 忽略 */ } }
  }
  const y = b.entity?.position?.y ?? null
  const air = airOf()
  const still = inWaterNow(b)
  if (preempted) {
    return {
      inWater: still, airBefore: air0, air, rose: y0 != null && y != null ? Math.round((y - y0) * 100) / 100 : null,
      heldMs: held, reason: 'preempted', remaining: 1,
      hint: '另一次移动把我接管了（我没再按着 jump）—— 再叫一次 mc_move 往岸上走（路上会自己上浮）',
    }
  }
  return {
    inWater: still,
    airBefore: air0, air,
    rose: y0 != null && y != null ? Math.round((y - y0) * 100) / 100 : null,
    heldMs: held,
    ...(still
      ? {
          remaining: 1,
          hint: air != null && air >= 18
            ? '已经浮到水面、气在恢复 —— 接着用 mc_move 往岸上走（不知道岸在哪就先 mc_scan 找干燥方块）'
            : '还在水里 —— 朝岸边再叫一次 mc_move（路上会自己上浮）；水挖不掉，别去 mc_dig 水',
        }
      : { note: '已经出水了' }),
  }
}

/* ─────────── 第三十六刀：移动主体（walkTo / walkSwim / flyTo）───────────
 * 三件都在这一层：`walkTo` 是公开入口，水里先走 `walkSwim`（A* 不把水当节点），
 * 上岸再交回 `#walkPathfinder`（那个留在 core，用 `ctx.walkPathfinder` 递进来 —— 它跟
 * 移动编号 / 控制位租约 / 事件监听缠得最紧，按路线图放最后）。
 * `#beginMove` / `#releaseControls` 也是私有件，同样走 `ctx`。
 */
/**
 * 在水里"直接游"到目标附近（**绕开 pathfinder**）。
 *
 * 🔴 为什么水里不能用 pathfinder：vendor 里那份 mineflayer-pathfinder 的 A* 明确
 *    拒绝把水当节点 —— `lib/movements.js:503` `if (blockC.liquid) return // dont go underwater`、
 *    `:523` 同一句、`:571` `if (self.getBlock(node,0,0,0).liquid) return // cant jump from water`；
 *    控制器在水里只会按住 jump（`index.js:611-613`）。所以"泡在水里、目标在岸上"时
 *    它要么只给一条只有一个节点的路、要么直接 NoPath，实机表现就是**"4 秒只挪 1 格"**。
 *    直接控制 `forward + jump` 实测 **2.05~2.27 格/秒**（正好等于 prismarine-physics 的
 *    水里水平极限 `liquidAcceleration/(1-waterInertia)` = 0.02/0.2 = 0.1 格/tick），快近 10 倍。
 *    水里按 jump 不是为了"跳"，是**浮在水面**游（贴底会卡、也慢）。
 *
 * 上岸就交还给 pathfinder（返回 `outOfWater: true`），别自己在地面上走 —— 地面上它比手写按键靠谱。
 */
/* ─────────── 游泳的"按什么决定方向"（2026-10-17，用户方案：分水域控制 + 有效进度检测）───────────
 * 用户实机点出的两件事：
 *   ① 水面游和水下游用的是**同一套**控制（一直按住 jump）⇒ 目标在水下时它永远下不去，
 *      在低矮水道里会被顶在天花板上；
 *   ② 循环里没有"这一段时间到底有没有**靠近**目标"的判据 —— `moved` 报的是**总位移**，
 *      被水推着横着漂很远也算"游了很多"，可离目标一步没近。
 * 这里补两件轻量的东西：**按目标高度决定要不要上浮** + **按窗口看"有没有靠近"**。
 * ⚠️ 不新建第二套控制器：移动仍然是 `forward` + `jump` 两个控制位，代次/中断/释放一律走原有机制。
 *
 * 关于水流：`prismarine-physics` 的 `simulatePlayer` 里 `isInWaterApplyCurrent()` 会把
 * `getFlow()` 的方向**每 tick 加 0.014 到速度上**（`index.js:687-702`）⇒ 机器人**真的会被水推**。
 * 🔴 2026-10-17 复审更正：这里原先写"0.014/tick ≈ 0.28 格/秒，只有游泳速度的 1/7" —— **算错了**。
 *    0.014 是**每 tick 的速度增量**（加速度），而水里每 tick 还有横向阻尼（速度乘 0.8），
 *    稳态速度是 `a / (1 - 0.8) = 5a` ≈ 0.07 格/tick ≈ **1.4 格/秒**，和游泳速度（≈2 格/秒）**同一量级**。
 *    ⇒ 结论要分两种水：**静水**（水源方块 `level=0`，`getFlow()` 为 0）根本不受力；
 *      **流动水**（河/瀑布/排水道）里逆着强流是**游不动**的。
 *    但仍然**不做**"往上游瞄准"补偿：流向得自己从方块 `level` 推，算错方向比不算更糟，
 *    而窗口进度 + 纠偏已经能把"游不动"如实报出来。真要做，先实机量出静水/顺流/逆流的实际速度差。
 *    真正的"游不动"多数是**撞墙 / 顶到天花板 / 目标在脚下**。
 */
export const SWIM_WINDOW_MS = 600          // 观测窗口（用户建议 500–750ms）
export const SWIM_STALL_WINDOWS = 2        // 连续两个窗口没靠近才算"卡住"（别过度调整）
export const SWIM_PROGRESS_EPS = 0.2       // 一个窗口至少靠近这么多格才算有进展
/** 水流横向漂移的判定阈值（格/窗口）：超过它就反压一档方向键 */
export const SWIM_DRIFT_EPS = 0.35
export const SWIM_FIXUPS = 2               // 纠偏最多试两次，再不行就交给水下脱困
/* ── 跨调用记账：游泳"看着在游、其实没挪"（2026-10-22 实机：卡在水面）────────────
 * 只游不救的死循环：每个 600ms 窗口都"靠近了 >=0.2 格"（沿池壁斜漂、水流推着走）⇒
 * `stallWins` 每次被清零 ⇒ 不 break ⇒ 预算吃满 ⇒ 回来时 msLeft 约等于 0 ⇒
 * `walkToOnce` 里 `msLeft() > 1_500` 那道门永远不开 ⇒ 脱困一次都不跑。
 * ⇒ 记在 `self._waterStall` 上，**下一次**调用一进水里就先脱困（恢复要 4.4 秒起，一轮凑不出来）。 */
export const WATER_STALL_LIMIT = 2          // 连续几次"几乎没挪"就认卡
export const WATER_STALL_MOVE_EPS = 1.2     // 一轮连这么多格都没挪出去 = 没进展（同 WATER_PROGRESS_EPS）
export const WATER_STALL_TTL_MS = 60_000    // 记账过期时间（离开水很久了就别再算数）

/** 记一轮游泳的结果，返回累计的"没进展"次数。到达 / 出水 / 真挪出去了都清零。 */
export function noteWaterSwim (self, { arrived = false, moved = 0, outOfWater = false } = {}) {
  if (!self) return 0
  const prev = Number(self._waterStall?.n) || 0
  const gained = Number(moved) || 0
  const n = (arrived || outOfWater || gained >= WATER_STALL_MOVE_EPS) ? 0 : prev + 1
  self._waterStall = { n, at: Date.now() }
  return n
}

/** 上一轮（含）是不是已经连着 `WATER_STALL_LIMIT` 次几乎没游动。 */
export function waterStallReached (self) {
  const st = self?._waterStall
  if (!st) return false
  if (Date.now() - (Number(st.at) || 0) > WATER_STALL_TTL_MS) return false
  return (Number(st.n) || 0) >= WATER_STALL_LIMIT
}

/** 清账（真要再攒够两次才又认卡 —— 别变成"每次调用都先脱困"的新循环）。 */
export function resetWaterStall (self) {
  if (self) self._waterStall = { n: 0, at: Date.now() }
}
/* 🔴 2026-10-27（用户：「水里的自救…一直会沉下去」）：6 提到 12（满 20 的 60%）。
 *    6 是 30%，浮到水面往往已经开始掉血；"先换口气再下去"只多花几秒，比淹死便宜。 */
export const SWIM_MIN_AIR = 12             // 气低于这个数，不管目标在哪都先上浮
export const SWIM_VERT_EPS = 0.6           // 目标比脚高/低这么多，才算"要去上一层/下一层"

/**
 * 这一轮该不该按住 jump（= 上浮）。
 *
 * 水里按 jump **不是跳**，是往上浮（`prismarine-physics` 里 `isInWater` 时 `vel.y += 0.04`）。
 * 所以它该由"目标在哪个高度"决定，而不是一直按着：
 *   · 快没气了 ⇒ 先上去（命比目标重要）；
 *   · 目标在**下面**（比脚低 `SWIM_VERT_EPS` 以上）⇒ **松开**，让它自己沉下去；
 *   · 目标在**同一层或上面** ⇒ 按着 —— 水里不按 jump 会以 ≈2 格/秒往下沉
 *     （`waterGravity 0.02` / `1-waterInertia 0.2`），横渡时非沉不可。
 * @returns {boolean}
 */
/* 目标那一格是不是水（读不到 ⇒ 当成不是，保守上浮）。 */
function isWaterAt (b, p) {
  try {
    const Vec = b?.entity?.position?.constructor
    const q = Vec ? new Vec(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      : { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    const blk = b?.blockAt?.(q)
    return Boolean(blk?.name && /water|bubble_column/.test(blk.name))
  } catch { return false }
}

/**
 * 这一轮该不该按住 jump（= 上浮）。
 *
 * 🔴 2026-10-30 用户：「在水下不应该恒上浮，y 大于当前位置才上浮」。
 *    2026-10-27 曾改成**恒上浮** —— 当时的病根是"目标的 y 常是 AI 猜的 / 岸上那一格"，
 *    "要上岸"被当成"要沉底"，人一路沉。但恒上浮又走向另一个极端：**给水下坐标也上浮**，
 *    于是"潜到水下打怪/采珊瑚"永远做不到，最后退回兜底。
 *
 *    现在的判据是两段：
 *      1. 快没气 ⇒ 一律上浮（命比目标重要）；
 *      2. 目标**比我高** ⇒ 上浮；**同一层** ⇒ 也上浮（水里不按 jump 会以 ≈2 格/秒下沉，
 *         横渡非按不可）；**比我低** ⇒ 只有"目标那格确实是水"才松手沉下去 ——
 *         目标在岸上/水面以下但那是空气时（AI 猜的 y），照旧上浮，不会一路沉。
 * @returns {boolean} true = 按 jump 上浮
 */
export function swimJumpWanted (b, goal, me, air) {
  const a = Number.isFinite(air) ? air : (Number.isFinite(b?.oxygenLevel) ? b.oxygenLevel : null)
  if (a != null && a < SWIM_MIN_AIR) return true
  const gy = Number(goal?.y)
  const my = Number(me?.y)
  if (!Number.isFinite(gy) || !Number.isFinite(my)) return true
  const dy = gy - my
  if (dy > -SWIM_VERT_EPS) return true          // 目标在上面 / 同一层 ⇒ 上浮
  return !isWaterAt(b, goal)                    // 目标更**低**：那格是水才沉，否则仍上浮
}

export async function walkSwim (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, intent = 'near' } = {}, ctx = {}) {
  const pre = intentOf(intent)
  if (arrive === 1.6) arrive = pre.arrive
  const b = self.bot
  endHoverFlight(b)   // 悬停着就别想蹦/走：先恢复重力（否则走路全废，见 endHoverFlight）
  const goal = new Vec3(Number(target.x), Number(target.y), Number(target.z))
  const at = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  const r2 = (n) => Math.round(n * 100) / 100
  if (!inWaterNow(b)) {
    // 本来就在岸上（`mc_move {"mode":"swim"}` 给了坐标时可能这样）：按普通走路走
    /* 🔴 2026-10-08 第四份审计报告 ⑨：这里以前把**没按 `msLeft()` 钳过**的 `budget` 直接往下传 ——
     *    平时走不到（`walkTo` 判 `isInWater` 与这里判 `#inWaterNow` 之间没有 await，读的是同一个值），
     *    但哪天 `cfg.moveBudgetMs` 变成历史遗留的大值，`withTimeout(work, budget)` 就会是几十秒。
     *    埋着的雷，照样钳一遍（`budgetAsked` 仍留原值，供 cutByCall 判"是被本轮截断还是真走不通"）。 */
    const leftMs = self.msLeft()
    const r = await ctx.walkPathfinder(goal, {
      arrive,
      intent,
      budget: Math.max(0, Math.min(callBudget(budget), leftMs)),
      budgetAsked: callBudget(budget),
    })
    return { ...r, swam: false, outOfWater: true, note: '我没在水里，这条就按普通走路走' }
  }
  const t0 = Date.now()
  const start = b.entity.position.clone()
  /* 🔴 2026-10-08 审计①：这条游泳循环以前**不认中断、也不领移动号** ——
   *    已 abort 的信号 + budget 1200ms 实测照样跑满 1313ms、forward/jump 各按 5 次
   *    （同条件 `flyTo` 1ms 就抛 mcAborted）；用户点停止后机器人还在水里游，而且它的 finally
   *    会把别人正在走的那份控制位一起松掉。现在：领号 + 每轮查 abort/号，收尾也看号。 */
  const gen = ctx.beginMove('swim')
  const left0 = self.msLeft()
  const bd = left0 <= 100 ? 0 : Math.max(0, Math.min(callBudget(budget), left0))
  let moved = 0
  /* 窗口进度（用户方案第 4 条）：每个 `SWIM_WINDOW_MS` 看一次"离目标近了没有"。
   * ⚠️ 判据必须是**离目标变近**，不是"总位移" —— 被水推着横着漂很远也是位移。 */
  let winLeft = start.distanceTo(goal)
  let winAt = t0
  let stallWins = 0
  let fixups = 0
  let jumpOverride = null       // 纠偏时强行指定一轮"按/不按 jump"
  /* 2026-10-18 审计 P2-7：水流会把"直着游"推成斜的 —— 每个窗口量一次横向漂移，
   * 反压一档方向键；漂了很久还没靠近，就如实说"水在推你"，别让 AI 以为是自己不努力。 */
  let winFrom = start.clone?.() ?? start
  let lastStrafe = null
  let drift = null
  let driftFixes = 0
  /* 🔴 只在"该不该按"**变了**的时候才写控制位：机器人默认就是没按 jump，
   *    每一轮都写一遍 `jump: false` 除了白发包，还会让"被抢占时不松别人的控制位"这条判据失灵
   *    （收尾那一轮写的 false 会被当成"抢了新移动者的控制位"）。 */
  let lastJump = false
  let stuckWhy = null
  const airOf = () => (Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null)
  /* 🔴 2026-10-30 用户：「要到水下如果没关 auto 的自动上浮，要提醒」——
   *    `extensions/mc_auto.mjs` 的 autoFloat 每 500ms 会把人顶回水面，跟下面"目标更低就松手
   *    沉下去"直接打架（这边刚沉，那边又浮）。所以目标是水下时**只提醒、不替用户关**：
   *    关不关是用户的决定（他可能正想浮着）。 */
  const diveGoal = isWaterAt(b, goal) && Number(goal.y) < (Number(b?.entity?.position?.y) - SWIM_VERT_EPS)
  let floatWarned = false
  const preemptResult = (end) => ({
    arrived: false, position: at(end), ms: Date.now() - t0,
    remaining: r2(end.distanceTo(goal)), moved: r2(start.distanceTo(end)),
    via: 'swim', stuck: true, reason: 'preempted', outOfWater: !inWaterNow(b),
    hint: '这次游泳被**另一次移动**接管了：等它结束，再叫一次 mc_move 往同一个目标游就行，**不是游不动**。',
  })
  try {
    while (Date.now() - t0 < bd) {
      if (self.abortSignal?.aborted) throw abortError('游泳', self.abortSignal)
      if (self._moveGen !== gen) return preemptResult(b.entity?.position ?? start)
      const me = b.entity.position
      const left = me.distanceTo(goal)
      moved = r2(start.distanceTo(me))
      /* 🔴 2026-10-22 实机（另一个会话卡在水里动不了 @ (8,18,2)）：
       *    泳路径按 **3D 距离** 判到达，而"往上爬一格"的 3D 距离只有 1.41 < arrive 1.6 ——
       *    于是第一次就 arrived:true / moved 0.48，之后每次都 ms:0 moved:0 arrived:true，
       *    AI 反复叫同一个目标永远不动（实测连叫 3 次全 moved:0）。
       *    现在：只有**已经出水**、或**目标格本身就是水**（游到水里某个点）才算到达；
       *    否则继续游（上浮/前进交给下面的 jump 逻辑），绝不"人还在水里却说我到了"。 */
      /* 2026-10-23 审计：上面那条「人在水里就不算到」判太狠 —— 目标跟我在**同一高度**时
       * （平游到水里的另一个点、或测试里原地齐平的目标），永远到不了，只能耗满预算。
       * 那条规则本来要防的是「目标在上方、我沉在水里够不着却报到了」，所以补一条竖向判据：
       * 高度差 ≤ 0.6 格就算真到了。 */
      if (left <= arrive) {
        let goalIsWater = false
        /* 🔴 2026-10-24：目标格是海草/海带也算"游到水里"（原来只认 isLiquid ⇒ 目标在水草里永远到不了）。 */
        try { goalIsWater = isWaterLike(b.blockAt(new Vec3(goal.x, goal.y, goal.z))?.name) || isLiquid(b.blockAt(new Vec3(goal.x, goal.y, goal.z))?.name) } catch { /* 读不到就按干地算 */ }
        const dyGoal = Math.abs(Number(me.y) - Number(goal.y))
        if (!inWaterNow(b) || goalIsWater || dyGoal <= 0.6) {
          return { arrived: true, position: at(me), ms: Date.now() - t0, moved, via: 'swim', remaining: r2(left) }
        }
      }
      // 每 250ms 重新对准：水流、撞岸、浮起来都会把朝向推偏（只对准一次会游歪）
      /* 🔴 2026-10-28 实机（用户：「水下还是没有上浮，而且没有寻路」）：以前对准的是
       *    `goal.offset(0, 1.0, 0)` —— 目标在**下方**时视线朝下，`forward` 就带上一个向下的分量，
       *    而这一段又恒按 `jump`（向上）⇒ 一上一下正好抵消。实测 10 秒只挪了 0.68 格水平、
       *    7.19 格垂直（人在水下 62~69 之间上下抖，A* 永远接不上手）。
       *    **朝向只定水平方向**：视线压到眼睛高度，高度差一律交给 jump。 */
      const eyeY = Number(b?.entity?.position?.y ?? me.y) + 1.6
      try { await b.lookAt(new Vec3(goal.x, eyeY, goal.z), true) } catch { /* 假 bot 没有 lookAt */ }
      b.setControlState('forward', true)
      /* 2026-10-29（用户：「自动上浮失效了」）：给反射层留个“游泳段正在控 jump”的时间戳。
       * 反射层以前靠“工具刚调完 1.2 秒就让开”避让 —— 等于只要 AI 在连着调工具（挖矿/打怪/观察），
       * autoFloat 就永远让开 ⇒ 人一路沉底。现在它只看这个时间戳。 */
      try { b.__swimCtlAt = Date.now() } catch { /* 假 bot 没这个字段 */ }
      /* 2026-10-30 用户：「y 大于当前位置才上浮」—— 判据在 `swimJumpWanted` 里：
       *    目标更高/同层 ⇒ 浮着；目标更低且那格真是水 ⇒ 松手沉下去；快没气一律上浮。
       *    `jumpOverride` 只在纠偏那一轮反向生效。 */
      if (diveGoal && b.__mcAutoFloat === true && !floatWarned) {
        floatWarned = true
        self.log('⚠️ 目标是水下，但 mc_auto 的自动上浮（autoFloat）还开着 —— 它会把你顶回水面；要真潜下去先 mc_auto {set:{"autoFloat":false}}')
      }
      const wantJump = jumpOverride === null ? swimJumpWanted(b, goal, me, airOf()) : jumpOverride
      /* 🔴 2026-10-27（同上）：以前只在**变化时**才写这个控制位（省一个包）。可控制位会被
       *   别的层清掉 —— 寻路器的 MonitorMovement、反射层、玩家按键 —— 一旦有人把 `jump`
       *   抹成 false，`lastJump` 还记着 true 就**再也不会写**了 ⇒ 人一路沉到水底，
       *   而代码以为"我一直按着 jump"。改成每轮无条件写（250ms 一个包，远小于淹死的代价）。 */
      b.setControlState('jump', wantJump)
      lastJump = wantJump
      await raceAbort(sleep(250), self.abortSignal, '游泳')   // 可中断（用户点停止要立刻出来）
      /* 🔴 2026-10-23 审计（A[2]）：等完**立刻**验代次 —— 这 250ms 里可能被另一次移动、
       *    反射层或玩家指令接管，再往下就会替别人按方向键、拿别人的位置判卡、改别人的控制位。 */
      if (self._moveGen !== gen) return preemptResult(b.entity?.position ?? start)
      jumpOverride = null
      /* 🔴 窗口进度必须用**等完之后**的位置采样（2026-10-17 复审）。
       *    原来这里直接拿循环开头那个 `me` 去算 —— `me` 只是 `b.entity.position` 的**引用**，
       *    靠"物理 tick 原地改这个 Vec3"才碰巧是对的；一旦哪次传送把 `position` 换成新对象，
       *    读到的就是 250ms 之前的旧坐标，`gained` 恒 0 ⇒ 明明在靠近也会被判"没进展"。
       *    快照下来，判据就不再依赖"别人会不会原地改它"。 */
      const sample = b.entity?.position?.clone?.() ?? b.entity?.position ?? me
      const nowLeft = sample.distanceTo(goal)
      /* ── 窗口进度：连续 `SWIM_STALL_WINDOWS` 个窗口都没靠近 ⇒ 先纠偏，纠不动就如实收手 ──
       * 用户原话："连续两个窗口没有有效进展时，才启动纠偏；一直有进展就保持原有控制"；
       * "确认通道被堵住后，再调用现有水下恢复控制器" —— 这里 `break` 出去，
       * `walkTo` 看到 `stuck:true` 就会把这一趟交给 `recoverFromWater`（找出口那套）。 */
      if (Date.now() - winAt >= SWIM_WINDOW_MS) {
        /* 上一轮的反压方向键只在那一轮有效 */
        if (lastStrafe) { try { b.setControlState(lastStrafe, false) } catch {} ; lastStrafe = null }
        /* 这一窗口实际挪了多少、横向偏了多少（垂直的不算：上浮下沉本来就该有） */
        let mvx = 0, mvz = 0
        try { mvx = sample.x - winFrom.x; mvz = sample.z - winFrom.z } catch {}
        winFrom = sample.clone?.() ?? sample
        const gx = goal.x - sample.x, gz = goal.z - sample.z
        const gl = Math.hypot(gx, gz) || 1
        const perp = (mvx * (-gz / gl) + mvz * (gx / gl))
        if (Math.abs(perp) >= SWIM_DRIFT_EPS) {
          drift = { x: r2(perp), z: r2(gl - Math.hypot(gx, gz)) }
          driftFixes++
          // 漂向哪边，就往反方向压一档（下一轮开头会松开）
          lastStrafe = perp > 0 ? 'right' : 'left'
          try { b.setControlState(lastStrafe, true) } catch {}
        }
        const gained = winLeft - nowLeft
        winLeft = nowLeft
        winAt = Date.now()
        if (gained < SWIM_PROGRESS_EPS) {
          stallWins++
          if (stallWins >= SWIM_STALL_WINDOWS) {
            if (fixups < SWIM_FIXUPS) {
              /* 纠偏：把上浮/下沉**反过来**试一轮 —— "以为该浮着"却纹丝不动时，
               * 十有八九是顶在天花板上，或者目标其实在脚下。 */
              fixups++
              stallWins = 0
              jumpOverride = !wantJump
            } else {
              stuckWhy = 'swim-stuck'
              break
            }
          }
        } else {
          stallWins = 0
        }
      }
      // 已经上岸：剩下的路交给 pathfinder（地面上它更靠谱）
      if (!inWaterNow(b) && b.entity?.onGround) break
    }
  } finally {
    /* 🔴 2026-10-23 审计（A[2]）：反压键也只在**还是我的代次**时才松 —— 被接管后新任务可能
     *    正按着同一个方向键，旧任务松手会把新任务带歪（这类"松开别人的键"最难查）。 */
    if (lastStrafe && self._moveGen === gen) { try { b.setControlState(lastStrafe, false) } catch {} }
    lastStrafe = null
    // 只有"我还是最新那次移动"才允许松控制位（被抢占时松了会把正在走的那份一起停掉）
    if (self._moveGen === gen) ctx.releaseControls()
  }
  const end = b.entity?.position ?? start
  /* 2026-10-18 审计 Bug 2（泳：同一份三维分量，别让 water 路径只剩 `moved`）。 */
  const swimDx = r2(end.x - start.x), swimDy = r2(end.y - start.y), swimDz = r2(end.z - start.z)
  moved = r2(start.distanceTo(end))
  const left = r2(end.distanceTo(goal))
  const outOfWater = !inWaterNow(b)
  const reason = outOfWater ? 'swim-shore' : (stuckWhy ?? 'swim-budget')
  return {
    arrived: false,
    position: at(end),
    ms: Date.now() - t0,
    remaining: left,
    moved,
    movedHorizontal: r2(Math.hypot(swimDx, swimDz)),
    movedVertical: swimDy,
    moved3d: r2(Math.hypot(swimDx, swimDy, swimDz)),
    /* 水里的"实际漂移"：对抗水流 / 判断有没有被冲走就靠它（报告 P2 第 7 条） */
    delta: { x: swimDx, y: swimDy, z: swimDz },
    via: 'swim',
    /* 🔴 2026-10-18 审计：以前 `stuck: stuckWhy != null || !outOfWater` ——
     *    只要这一趟结束时人还在水里就报 stuck，哪怕它是**笔直往前游、一直在靠近目标**。
     *    上层（`walkTo`）看到 stuck 就把整趟交给 `recoverFromWater`（找出口那套），
     *    于是"正常游过去"被当成"游不动"、白烧一轮脱困预算。
     *    现在只有**真的没进展**（`swim-stuck`）才算 stuck；上岸了报 `swim-shore`，
     *    时间用完报 `swim-budget`，都如实写在 `reason` 里。 */
    stuck: stuckWhy != null,
    reason,
    outOfWater,
    ...(fixups ? { fixups } : {}),
    /* 用户 2026-10-30：「要到水下如果没关 auto 的自动上浮，要提醒」—— 只报事实，不替他关。 */
    ...(floatWarned
      ? { autoFloatBlocking: true, floatHint: '⚠️ 目标是水下，但 `mc_auto` 的自动上浮（autoFloat）还开着 —— 它每 500ms 会把你顶回水面；要真潜下去先 `mc_auto {set:{"autoFloat":false}}`。' }
      : {}),
    ...(driftFixes ? { drift, driftFixes } : {}),
    hint: outOfWater
      ? `已经上岸了（游了 ${moved} 格，离目标 ${left} 格）—— 再叫一次 mc_move 到同一个目标，它会自己走完。`
      : reason === 'swim-stuck'
        ? `还在水里，**这一段确实游不过去了**：连续 ${SWIM_STALL_WINDOWS} 个窗口离目标都没靠近，把上浮/下沉反过来试了 ${fixups} 次也没用（多半是撞墙、顶在天花板上，或者那边根本不通）。**别再往这个方向硬游** —— 换个方向/换个出口，或者先上岸绕过去。`
          + (driftFixes >= 2 ? `（水流一直在横向推你：已经反压了 ${driftFixes} 次方向键 —— 能找到岸边就从岸上绕。）` : '')
        : `还在水里：游了 ${moved} 格（离目标 ${left} 格）—— 再叫一次 mc_move 往同一个目标游，会接着游。`,
  }
}

/**
 * 通过 mineflayer-pathfinder 走到目标。
 * 这是唯一的移动实现：不再保留手写的按键、盲跳、挖方块或垫脚兜底。
 * ⚠️ 唯一的例外：**在水里**先交给 `#walkSwim`（A* 不把水当节点，见它的注释）。
 */
/* ── 长路线续行（2026-10-18 审计 P1） ────────────────────────────────────────
 * 一次 `mc_move` 只有 10 秒，长路必然要"再叫一次接着走"。但同一目标反反复复走、
 * 每次只报"这一趟挪了几格"时，AI 看不出"我已经在这个目标上耗了三分钟" ——
 * 于是原样重试第四次。
 * 这里在 bot 上记一条**只读的路线账**：同一个目标（水平 3 格内、垂直 3 格内、90 秒内）
 * 连着走就累计次数/累计位移/累计耗时；连着 3 趟、平均每趟不到半格，就在 `hint` 里
 * 明说"别再原样重试"。**只记账，不改路线、不改目标** —— 怎么绕仍由 AI 决定。 */
const ROUTE_TTL_MS = 90_000
const ROUTE_SAME_R = 3

export function routeTrack (self, target, info) {
  const t = Date.now()
  const prev = self._navRoute ?? null
  const tx = Number(target?.x), tyTarget = Number(target?.y), tz = Number(target?.z)
  const same = Boolean(prev) && t - prev.at < ROUTE_TTL_MS &&
    Math.hypot(prev.target.x - tx, prev.target.z - tz) <= ROUTE_SAME_R &&
    Math.abs(prev.target.y - tyTarget) <= ROUTE_SAME_R
  const attempts = same ? prev.attempts + 1 : 1
  const rd2 = (n) => Math.round(n * 100) / 100
  const movedTotal = rd2((same ? prev.movedTotal : 0) + (Number(info?.moved) || 0))
  const elapsedMs = (same ? prev.elapsedMs : 0) + (Number(info?.ms) || 0)
  self._navRoute = { target: { x: tx, y: tyTarget, z: tz }, at: t, attempts, movedTotal, elapsedMs }
  const route = { attempts, movedTotal, elapsedMs, sameTarget: same }
  const stalled = attempts >= 3 && movedTotal < attempts * 0.5 && info?.arrived !== true
  if (!stalled) return route
  return {
    ...route,
    stalled: true,
    hint: `**已经第 ${attempts} 次走同一个目标了**，累计只挪了 ${movedTotal} 格（${Math.round(elapsedMs / 1000)} 秒）—— 别再原样重试。`
      + '先换做法：走不动就看 `blockedAhead` / `shaft`（头顶封着什么、四面哪边通），'
      + '挖掉挡路那一格、换个 `intent`（`stand`/`interact`/`same-level`）、绕到另一侧，或者用 `mc_act {mode:"bridge"}` 搭过去。',
  }
}

/* ===== 收工把手换回来（用户 2026-10-22：「搭路自动切回…不生效」） =====
 * 走路时垫方块**不是本文件干的**：是 pathfinder 自己做的
 * （vendor/mc-deps/node_modules/mineflayer-pathfinder/index.js:548，放之前 bot.equip(block,'hand')）。
 * 放完**上游不会换回来**，所以走完一段垫过方块的路，手里就一直攥着圆石/泥土 ——
 * 下一场架拿着方块挥、下一次挖拿着方块刨。以前这里只在结果里报 held/heldBefore
 * （那只是**记账**，看着像处理过，其实手没换回去）。
 * bridge / shoot 早就有这一层了；这里照 bridgeAcross 的写法，在**所有返回路径**
 * （成功 / 超时 / 半路停 / 抛错）上统一还原，而不是每个 return 前各写一遍。
 * 注意：只在手真的变了时才动手（restoreHeldOf 自己会先比名字），没垫方块的路不付代价。
 */
/* 🔴 2026-10-27（用户：「auto-eat 抢占去掉」）：**走路期间关掉自动吃**。
 *   `mineflayer-auto-eat` 饿了会自己 `equip(食物)` + `consume()` —— consume 那几秒不能移动，
 *   而且它把手上东西换成食物（正走到一半被抢，等于白走一趟）。只在这一次走路里关，
 *   走完（含异常/超时/被抢占）立刻还原；`mc_auto` 下一拍也会按配置重开。
 *   战斗那段另有自己的一份开关（attack.mjs 的 eatOff），这里不重复管。 */
export async function walkTo (self, target, opts = {}, ctx = {}) {
  let ae = null
  try { ae = self?.requireBot?.()?.autoEat ?? null } catch { ae = null }
  const silenced = Boolean(ae) && typeof ae.disableAuto === 'function' && ae.enabled !== false
  if (silenced) { try { ae.disableAuto() } catch { /* 关不掉也照走 */ } }
  try {
    return await walkToInner(self, target, opts, ctx)
  } finally {
    if (silenced && typeof ae.enableAuto === 'function') {
      try { ae.enableAuto() } catch { /* 还不了也无害：自主层下一拍重新开 */ }
    }
  }
}

async function walkToInner (self, target, opts = {}, ctx = {}) {
  const b = self.requireBot()
  /* 🔴 2026-10-23 实机（"也是完全卡住，我tp也不行，最后重开才好"）：连接假死时**立刻认输**。
   *    静默 40 秒没有包比任何预算都硬 —— 硬要走到 11 秒上限只会让 AI 以为"路难走"，
   *    然后一遍遍重试（每次都在等一个永远不会回来的回包）。 */
  const stale = connectionStale(b)
  if (stale) {
    const p = b?.entity?.position
    const hx = Number(p?.x ?? 0), hz = Number(p?.z ?? 0)
    return {
      arrived: false,
      position: { x: Math.floor(hx), y: Math.floor(Number(p?.y ?? 0)), z: Math.floor(hz) },
      ms: 0,
      remaining: Number(Math.hypot(Number(target?.x ?? hx) - hx, Number(target?.z ?? hz) - hz).toFixed(2)),
      stuck: true,
      via: 'pathfinder',
      ...stale,
    }
  }
  const keep = heldSnapshotOf(b)
  let out = null
  const t0 = Date.now()
  /* 硬上限：预算 + `MOVE_HARD_SLACK_MS`（留给脱困阶梯/挖一格这些"预算外"动作）。
   * `ctx.walkGuardMs` 是给离线套件注入的（不然一条断言要真等 3 秒）。 */
  const budgetMs = Number(opts?.budget ?? self?.cfg?.moveBudgetMs) || 0
  /* 🔴 2026-10-28 参数审计：`budgetMs + MOVE_HARD_SLACK_MS` 会到 13 秒，而单次调用的硬上限
   *    `CALL_MS` 只有 11 秒 ⇒ 这个内部看门狗永远轮不到（外层先掐），里面就来不及
   *    `stopPathing` / 松控制位 / 带着进度返回，模型只看到一次莫名其妙的截断。
   *    再压一道：留 200ms 给外层收敛。 */
  const guardMs = Number(ctx?.walkGuardMs) > 0
    ? Math.max(30, Number(ctx.walkGuardMs))
    : Math.max(1_500, Math.min(budgetMs + MOVE_HARD_SLACK_MS, CALL_MS - 200))
  const HUNG = Symbol('walk-hung')
  let guardTimer = null
  try {
    const walk = walkToUnguarded(self, target, opts, ctx)
    /* 硬上限先到时它还在后台跑 —— 挂个空 catch，别让它变成"未处理的拒绝"（会炸宿主）。 */
    walk.catch(() => {})
    out = await Promise.race([
      walk,
      new Promise((resolve) => { guardTimer = setTimeout(() => resolve(HUNG), guardMs) }),
    ])
    if (out === HUNG) {
      /* 走到这里 = 里面有 await 永不 settle。先"作废"这次移动（号往前推，免得它稍后收尾时
       * 把下一次走路停掉），再松开控制位、把正在挖的那一格停掉，最后如实告诉模型。 */
      out = null
      try { ctx.beginMove?.() } catch {}
      try { ctx.stopPathing?.(b) } catch {}
      try { ctx.releaseControls?.() } catch {}
      try { b.stopDigging?.() } catch {}
      let at = null
      try {
        const p = b.entity.position
        at = { x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) }
      } catch { /* 断线时读不到位置 */ }
      let a = null
      try { a = aboveOf(b) } catch { /* 同上 */ }
      out = {
        arrived: false,
        position: at,
        ms: Date.now() - t0,
        /* 🔴 2026-11-03 用户：「服务端不回包」这句把人带偏了 —— 实际是这一趟 10 秒全花在挖，
         *   时间到而已。`stuck` 必须是 false，否则收尾文案按"卡住"走；挖了多少见下面的 dug/carved。 */
        /* 🔴 2026-11-05 用户实机：「报了这个错，但是我看着它还在正常挖」——
         *   这趟明明在往上挖（carved/climbedUp 都涨），却因为 stuck 写死 true 而按“卡住”收尾。
         *   现在：**有进展就不算卡住** —— 它是“时间到”，不是“走不动”。 */
        stuck: !(Number(b?.__mcCarved ?? 0) > 0 || Number(b?.__mcClimbed ?? 0) > 0),
        reason: 'walk-hung',
        ...(Number(b?.__mcCarved ?? 0) > 0 ? { carved: Number(b.__mcCarved) } : {}),
        ...(Number(b?.__mcClimbed ?? 0) > 0 ? { climbedUp: Number(b.__mcClimbed) } : {}),
        hardLimitMs: guardMs,
        via: 'pathfinder',
        ...(a ? { above: a } : {}),
        hint: (Number(b?.__mcCarved ?? 0) > 0
          ? '这趟时间用完了（' + (guardMs / 1000).toFixed(1) + ' 秒）：挖了 ' + Number(b.__mcCarved) + ' 格'
            + (Number(b?.__mcClimbed ?? 0) > 0 ? '、往上爬了 ' + Number(b.__mcClimbed) + ' 格' : '、但一格没上去')
            + '。挖一格石头就要一秒多，往上三十格不是一趟能做完的 —— **再叫一次同一个目标**，我接着往上挖。'
          : '这趟走路卡住了：超过硬上限 ' + (guardMs / 1000).toFixed(1) + ' 秒还没回来，我已经强行掐断。'
            + '最常见的原因是"挖那一格 / 换工具 / 开门"在等服务端回包而服务端没回（客户端看着就是不动）。'
            + '别原样重叫同一个点：先看一眼坐标有没有变，明确关掉挖（allowDig:false，本来就是默认）、'
            + '换个近一点的目标，或者用 mc_act 的 bridge 模式绕过去。'),
      }
    }
  } finally {
    /* 2026-10-23 审计（移动层报告第 4 条）：原来是 `keep && out` —— 抛错时 `out` 是 null，
     * 于是**失败那次不还原**，手里一直攥着垫脚用的圆石/泥土（vendor 垫方块时会 equip 且不换回）。
     * 与 bridge.mjs 的写法对齐：只要当初有快照就还原。 */
    if (keep) {
      let r = { restored: false, now: b?.heldItem?.name ?? null }
      /* 换不回来是件小事（路已经走完了），别把整次走路判成失败 */
      try { r = await restoreHeldOf(b, keep) } catch { /* 保持原样 */ }
      /* 🔴 2026-10-23 实机：以前只在 `restored === true` 时改 `out.held`，而
       *    `restoreHeldOf` 在"手本来就是那件"时回 `restored:false`（无需还原）—— 于是报告里
       *    留着我垫方块时的旧值，看着像没换回来。现在一律按**现在手上真实的**回报。 */
      if (out) {
        const nowName = b?.heldItem?.name ?? null
        const wantName = keep.name ?? null
        out.held = nowName ? (nowName + 'x' + (b?.heldItem?.count ?? 1)) : '空手'
        if (nowName === wantName) {
          out.heldRestored = wantName ?? '空手'
        } else {
          out.heldRestoreWhy = r?.why ?? `想换回 ${wantName ?? '空手'} 没成功（现在是 ${nowName ?? '空手'}）`
        }
      }
    }
  }
  /* 岩浆脱困的账（`walkToOnce` 开头记的）：不管后面走到哪一步，都要把"我爬出岩浆了"报给模型 ——
   * 否则它只看到"走了 2 格"却不知道自己是刚被烧过、从岩浆里爬出来的。 */
  const lavaEsc = b?.__lavaEscape ?? null
  if (lavaEsc) {
    try { delete b.__lavaEscape } catch { /* 冻结的 bot 就算了 */ }
    if (out) {
      out.lavaEscape = lavaEsc
      out.hint = [lavaEsc.hint, out.hint].filter(Boolean).join(' ')
    }
  }
  if (guardTimer) clearTimeout(guardTimer)
  return out
}

async function walkToUnguarded (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, noTower = true, noBridge = true, intent = 'near', waterRecover, allowDig = false, xz = false } = {}, ctx = {}) {
  let info = await walkToOnce(self, target, { arrive, budget, noTower, noBridge, intent, waterRecover, allowDig, xz }, ctx)
  /* 🔴 2026-10-20（实机连撞两次）：vendor 的 `goal_reached` 是**全局**事件（`lib/goto.js:60` 不看 goal），
   *    别的寻路（自主层逃跑/跟随、或者上一次走路的残留 promise）到点时会顺手把**我这次** goto 一起
   *    resolve ⇒ 本次调用 45~85ms 就返回 goal-reached-elsewhere，人一步没动。以前只能让 AI 再手动叫
   *    一次；这里自己重试一次（**还剩 1.2 秒以上预算**才重试，不抢下一轮的时间）。只重试这一个 reason ——
   *    NoPath / stuck / call-over 重试是同参数撞墙，没意义。 */
  if (!info.arrived && info.reason === 'goal-reached-elsewhere' && self.msLeft() > 1_200) {
    try { ctx.stopPathing?.(self.requireBot()) } catch {}
    const retried = await walkToOnce(self, target, { arrive, budget, noTower, noBridge, intent, waterRecover, allowDig, xz }, ctx)
    info = { ...retried, retriedElsewhere: true }
  }
  /* 🔴 2026-10-23（P0-b，用户 m00634）：以前 `arrived:false` 只说"还差 N 格"（直线）——
   *    AI 看不出"这条路还有 180 格、要叫四次"，于是每次都当最后一趟在等，走两趟没到就换目标。
   *    够长（≥2 次调用）才补这一句，免得一两格的路多一句废话。 */
  const estCalls = Number(info?.estCalls) || 0
  if (!info.arrived && estCalls >= 2) {
    const blocks = Math.max(0, Math.round(Number(info?.pathLen) || Number(info?.remaining) || 0))
    info = {
      ...info,
      /* 2026-10-24：只补进度事实，不再塞“别换目标点”——那句会和真正该做的建议（搭桥/挖开/换目标）打架。 */
      hint: `${info.hint ? info.hint + ' ' : ''}（这条路还剩约 ${blocks} 格，按一次 ${budgetSecText()}（约 ${estPerCallOf(budget)} 格）算**大约还要 ${estCalls} 次调用**。）`,
    }
  }
  /* ================= 2026-10-24 用户点单：① 失败去重 + ③ 中途返回极简 =================
   *
   * 用户实机（m06771）：「我卡在丘陵。继续走。」—— 1800 格的目标，一次 10 秒约 24 格，
   * 要走 40 多次。每次调用都往上下文里灌一整条结果（hint / planTried / around / above /
   * shaft / blockedAhead…），走一趟就吃掉 8~10K token，而且绝大多数是"还没到、接着走"的废话；
   * 卡住时更糟：同一个原因重复三次，就把同一段话抄三遍。
   *
   * ① 失败去重：同目标 + 同原因（含眼前挡路那块）连续出现 ⇒ 第二次起只回一行，
   *    并把 repeat 次数报出来。换目标 / 换原因 / 到达 ⇒ 计数清零。
   * ③ 中途极简：**有进展、没卡住**（还在路上）时只回一句"走了 X 格、还剩 Y 格、约 N 次"，
   *    不报 around/above/shaft/planTried —— 那些在"还在路上"阶段没有决策价值。
   *    卡住 / 到达 / 被打断时**不瘦身**，因为那时候每一句都有用。
   */
  const slimInfo = (o) => {
    const keep = ['arrived', 'remaining', 'moved', 'reason', 'ms', 'pathLen', 'estCalls',
      'held', 'heldRestored', 'heldRestoreWhy', 'via', 'preempted', 'repeat', 'stuck']
    const r = {}
    for (const k of keep) if (o[k] !== undefined) r[k] = o[k]
    return r
  }
  /* 🔴 2026-10-24 用户：「像move一样简化输出，只保留重要信息」——
   *    删掉纯诊断字段（route / pathResets / pathResetReasons / pathLenPlanned /
   *    moved3d / delta / xz）—— 这些 `mc_diag` 都能查，平时只会占地方。
   *    到达时 `above` / `blockedAhead` / `terrain` 也删（人都到了，看头顶干什么）。
   *    `heldRestored` 只在"真的换回来了"时才值得说。 */
  const pruneMove = (o) => {
    const r = { ...o }
    for (const k of ['route', 'pathResets', 'pathLenPlanned', 'moved3d', 'delta', 'xz']) delete r[k]
    /* 🔴 2026-10-27（用户：「移动老是卡在半空，我不知道是什么原因」）——
     *   `pathResetReasons` 正是"为什么走不动"的唯一线索（place_error / dig_error / stuck /
     *   no-scaffolding …），2026-10-24 那次"简化输出"把它连 `pathResets` 一起删了，
     *   于是模型只会看到"卡住"、不知道为什么。只留最多的 4 项控制长度。 */
    if (r.pathResetReasons) {
      const top = Object.entries(r.pathResetReasons).sort((a, b) => b[1] - a[1]).slice(0, 4)
      r.pathResetReasons = Object.fromEntries(top)
    }
    /* 到了当然不用看头顶/前方；**只是时间到/被抢占**也一并删 —— 那几项与这次没走到无关。 */
    const timeIsBlame = (r.reason === 'timeout' || r.reason === 'budget') && Number(r.moved) >= 0.6
    if (r.arrived || timeIsBlame) { delete r.above; delete r.blockedAhead }
    if (r.arrived) delete r.terrain
    if (r.heldRestored === r.held) { delete r.heldRestored; delete r.heldRestoreWhy }
    return r
  }
  const whyShort = (o) => {
    if (o?.tooHard) return `眼前 ${o.tooHard.name} 挖不动（要 ${o.tooHard.need || '对的工具'}）`
    /* 时间到/预算完 ⇒ 别把"前方有方块"当成原因（那是静态探测，跟这次为什么停无关）。 */
    if ((o?.reason === 'timeout' || o?.reason === 'budget') && Number(o?.moved) >= 0.6) return '这一轮时间用完了（不是走不动）'
    if (o?.blockedAhead) return `眼前 ${o.blockedAhead.name} 挡着（${o.blockedAhead.x},${o.blockedAhead.y},${o.blockedAhead.z}）`
    if (o?.reason === 'NoPath') return '这条路走不通（NoPath）'
    if (o?.reason === 'stuck') return '还是卡在原地'
    return '还是没走到'
  }
  let outInfo = info
  const bMv = (() => { try { return self.requireBot() } catch { return null } })()
  if (bMv) {
    if (!info.arrived && !info.preempted) {
      const key = [Math.round(Number(target?.x) || 0), Math.round(Number(target?.y) || 0),
        Math.round(Number(target?.z) || 0), String(info.reason ?? ''),
        String(info.tooHard?.name ?? info.blockedAhead?.name ?? '')].join('|')
      const prev = bMv.__moveFail
      const n = prev && prev.key === key ? Number(prev.n || 0) + 1 : 1
      try { bMv.__moveFail = { key, n } } catch { /* 假 bot */ }
      if (n >= 2) {
        outInfo = {
          ...slimInfo(info),
          repeat: n,
          hint: `⛔ 还是老样子（第 ${n} 次）：${whyShort(info)} —— 别重复发同一个点，换目标或换做法（绕 / 挖 / 搭桥）。`,
        }
      }
    } else {
      try { bMv.__moveFail = null } catch { /* 假 bot */ }
    }
  }
  /* ③ 中途极简：有进展、没卡住、也不是被打断 —— 只留一句进度。 */
  /* 只瘦身**走路**这条腿：游泳有自己的收尾口径（`swim-budget` / `swim-shore` 和那句
   * "再叫一次接着游"是测试与 AI 都依赖的），别拿通用进度句把它盖掉。 */
  const enRoute = !outInfo.arrived && !outInfo.preempted && !outInfo.repeat && outInfo.via !== 'swim'
    && Number(outInfo.moved) >= 1 && !outInfo.stuck && !outInfo.blockedAhead && !outInfo.tooHard
  if (enRoute) {
    const left = Math.max(0, Math.round(Number(outInfo.remaining) || 0))
    const calls = Number(outInfo.estCalls) || 0
    outInfo = {
      ...slimInfo(outInfo),
      hint: `🚶 走了 ${Math.round(Number(outInfo.moved) || 0)} 格，还剩约 ${left} 格`
        + (calls >= 2 ? `（大约还要 ${calls} 次调用，同参数接着叫就行）` : '（再叫一次就到）')
        + '。',
    }
  }
  const route = routeTrack(self, target, outInfo)
  if (route?.stalled) outInfo = { ...outInfo, hint: (outInfo.hint ? outInfo.hint + "\n" : "") + route.hint }
  return pruneMove(outInfo)
}

async function walkToOnce (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, noTower = true, noBridge = true, intent = 'near', waterRecover, allowDig = false, xz = false } = {}, ctx = {}) {
  const b = self.requireBot()
  endHoverFlight(b)   // 悬停着就别想蹦/走：先恢复重力（否则走路全废，见 endHoverFlight）
  /* 🔴 2026-10-19 用户：「水下自救要让 ai 能开关」+「要默认开」——
   *    默认走脱困，调用方显式 `waterRecover: false` 才关。 */
  /* 🔴 2026-10-22（卡水那次连带的第二个坑）：intent:'stand' 要求**真的站到那一格上**，
   *    可 arrive 默认 1.6 是 3D 距离 —— 相邻一格(1.41)、上一格(1.41) 全在半径内，
   *    于是"叫它爬一格上岸"直接报到了、一步没走。stand 收到 0.6。 */
  if (intent === 'stand' && arrive > 0.6) arrive = 0.6
  if (waterRecover !== undefined) ctx = { ...ctx, waterRecover: waterRecover !== false }
  // 🔴 在水里：A* 不把水当节点（见 #walkSwim 的注释），实机表现是"4 秒挪 1 格"。
  //    先直接游；上了岸、还有时间，再把剩下的路交给 pathfinder 走完。
  //    ⚠️ 判据用 `#inWaterNow`：`entity.isInWater` 在泡水柱里会读出 undefined（实机踩过）。
  /* 🔴 2026-10-22 第二次实机（另一个会话 @ (8,18,2)：**站在实心地面上、泡在 1 格深的水里**）：
   *    mc_diag 明确报 `onGround:true, inWater:true`，可泳路径连跑 4.6s 是 `moved:0 / movedVertical:0`、
   *    换方向、强制上浮（fixups:2）全无效 —— 因为人本来就是站着的，游泳控制器按"浮着"那套推，
   *    一点位移都出不来。站在实心地上时**交给 pathfinder 走**（浅水它本来就会蹚过去）。
   *    只有真的悬在水里（onGround 不是 true）才走游泳。 */
  /* 🔴 2026-10-27 实机（用户：「现在掉在岩浆里动不了」）—— **岩浆脱困排在"水"和"A*"之前**：
   *   岩浆 4 点/0.5 秒（不吃护甲，20 血约 2.5 秒烧光），比水急得多；而岩浆里 A* 只会 NoPath
   *   （岩浆格 `safe:false`），游泳分支又进不去（`inWaterNow` 不认岩浆）—— 于是原来它**什么都不做**，
   *   只是每轮白烧 10 秒预算，hint 还写着"再叫一次会接着走"。
   *   规则：先自己爬出来；爬出来就**接着按原目标走**（不把活退回给模型再叫一次）；
   *   爬不出来就如实报（血 / 坐标 / 最近的岸）并建议垫方块或 tp，别再空转。 */
  if (inLavaNow(b) && ctx.noLavaEscape !== true) {
    const esc = await lavaEscape(self, {}, ctx)
    if (!esc.escaped) {
      const p0 = esc.position ?? b.entity?.position ?? null
      return {
        arrived: false,
        position: p0 ? { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) } : null,
        moved: Number(esc.moved) || 0,
        via: 'lava-escape',
        stuck: true,
        reason: 'lava-escape',
        lavaEscape: esc,
        hint: esc.hint,
      }
    }
    try { b.__lavaEscape = esc } catch { /* 只读 bot 也能跑 */ }
  }
  if (inWaterNow(b) && b.entity?.onGround !== true) {
    /* 2026-10-22（用户：卡在水面）：已经连续两轮几乎没挪动 ⇒ **这一轮先脱困再游**。
     * 正常游泳一秒不少：真游出距离 / 出水 / 到达都会把账清零（见 noteWaterSwim）。
     * noWaterRecover 防递归、waterRecover:false 由调用方显式关（开关权在 AI 手里）。 */
    const startPos = b.entity.position.clone?.() ?? b.entity.position
    /* 🔴 2026-10-23 审计（移动层报告 A[6]）：以前只看"这一轮挪没挪动"，**氧气完全不参与** ——
     *    沉在底下沿水底一点点挪也是"有进展"，等氧气见底才开始掉血，AI 到死都收不到"该上去换气"。
     *    现在：氧气掉到 120（上限 300，约 40%）以下就先浮上去换一口，再接着走。
     *    `waterRecover:false`（AI 明确关掉脱困）时不做。 */
    let airFirst = null
    const airNow = Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null
    /* 🔴 2026-10-24 全量体检：**这里的阈值单位写错了** —— `bot.oxygenLevel` 是
     *    `Math.round(air_supply / 15)`，满值 **20**（300 是原始 `air_supply`，不是这个字段）。
     *    写 `<= 120` 对 0–20 恒真 ⇒ 只要脚泡在水里、脚不着地，**每次 walkTo 都先白上浮 1.2 秒**，
     *    还顺带 bumpGen 把代次往前推（把自己上一次的上浮掐掉）。
     *    改成"低于 8（约 40%）才先换气"。 */
    if (airNow != null && airNow <= 8 && ctx.waterRecover !== false) {
      try { airFirst = await swimUp(self, { hold: 1_200 }, ctx) } catch { airFirst = null }
    }
    let preRecover = null
    if (waterStallReached(self) && ctx.noWaterRecover !== true && ctx.waterRecover !== false && self.msLeft() > 4_500) {
      preRecover = await recoverFromWater(self, { budgetMs: Math.min(8_000, Math.max(0, self.msLeft() - 1_000)) }, recoverCtxOf(self, ctx))
      /* 试过一次就别再赖着这条判据：脱困没成功也要回去正常游，否则会变成"每次都先脱困"的新循环 */
      resetWaterStall(self)
      if (!inWaterNow(b)) {
        const me = b.entity.position
        return {
          arrived: false,
          position: { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) },
          remaining: Number(Math.hypot(me.x - target.x, me.z - target.z).toFixed(2)),
          moved: Number(startPos.distanceTo(me).toFixed(2)),
          via: 'water-recover',
          stuck: false,
          outOfWater: true,
          waterRecover: preRecover,
          hint: `前面连续 ${WATER_STALL_LIMIT} 次几乎没游动，所以这一轮我**先自己上岸了**（${preRecover?.note ?? ''}）—— 原来的目标还要不要接着走，你看一眼再定。`,
        }
      }
    }
    const swim = await walkSwim(self, target, { arrive, budget, intent }, ctx)
    if (airFirst) swim.airFirst = Number(airFirst.rose ?? 0)
    /* 记一笔"这一轮到底有没有挪动"（跨调用记账，见文件头的 WATER_STALL_*） */
    noteWaterSwim(self, { arrived: swim.arrived === true, moved: Number(swim.moved) || 0, outOfWater: !inWaterNow(b) })
    const canWalk = self.pfReady && typeof b.pathfinder?.goto === 'function'
    /* 🔴 用户点名的"水下寻路"就接在这里（2026-10-15）：**游不动了**（还泡在水里、没到目标）
     * 就交给恢复控制器 —— 它负责**找出口、选路线、复核进度**；
     * 真正移动仍然走这一层已有的 `walkTo` / `swimUp`，**不另起一套游泳按键控制**
     * （用户："建议新增模块只管理水域导航策略。实际移动仍通过现有接口执行"）。
     * `noWaterRecover` 防递归：恢复过程中再走一次路时，不许再次触发恢复。
     * 🔴 时间不够就**别开这一趟**（用户："继续用现有预算与取消机制，避免一次出口搜索
     *    耗尽整个工具调用预算"）—— 剩不到 1.5 秒时老实把"还在水里"报回去。 */
    /* 🔴 2026-10-19 用户：先要"不要自动到干燥方块"，紧接着改成「要默认开」—— 所以这一趟
     *    **默认就走**，只有调用方显式 `waterRecover: false`（`mc_move {waterRecover:false}`
     *    或 `mc_auto set {"waterRecover":false}`）才关掉。开关权在 AI 手里。 */
    /* 🔴 2026-10-20 审计（真 bug）：上面注释写的 `noWaterRecover` 防递归**从来没被读过** ——
     *    条件里只有 `ctx.waterRecover !== false`。于是"恢复→walkTo→还在水里→再恢复"可以
     *    一层层套下去，每层吃掉 900ms+，一次 10 秒的 `mc_move` 被吃光，最后返回的是最内层的 hint。
     *    现在真读它：恢复过程中（`recoverCtxOf` 传了 `noWaterRecover:true`）不再触发第二次恢复。 */
    /* 2026-10-23 审计（移动层报告第 3 条）：`preempted` 是「被另一次移动接管」，不是「游不动」——
     * 以前会在被接管后还白烧最多 12 秒水下脱困。与下面 pathfinder 分支对齐。 */
    if (swim.stuck && swim.reason !== 'preempted' && ctx.noWaterRecover !== true && ctx.waterRecover !== false && self.msLeft() > 1_500) {
      const rec = await recoverFromWater(self, { budgetMs: Math.min(12_000, Math.max(0, self.msLeft() - 900)) }, recoverCtxOf(self, ctx))
      const out = !inWaterNow(b)
      return {
        ...swim,
        stuck: !out,
        outOfWater: out,
        waterRecover: rec,
        hint: rec?.escaped === true
          ? `我**自己从水里出来了一趟**（${rec.note}）—— 原来的目标还要不要接着走，你看一眼再定。`
          : `还在水里${rec?.ok ? '（能喘口气了，但没出去）' : ''}，没找到出口（${rec?.reason ?? 'unknown'}）：${rec?.note ?? ''}`,
      }
    }
    if (swim.arrived || !swim.outOfWater || !canWalk) return swim
    const left = self.msLeft()
    if (left < 500) return swim
    const rest = await ctx.walkPathfinder(target, { arrive, noTower, intent, allowDig, xz, budget: Math.max(0, Math.min(callBudget(budget), left)), budgetAsked: callBudget(budget) })
    return { ...rest, swam: true, swimMoved: swim.moved, swimMs: swim.ms }
  }
  if (!self.pfReady || typeof b.pathfinder?.goto !== 'function') {
    return {
      arrived: false,
      position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
      remaining: Number(Math.hypot(b.entity.position.x - target.x, b.entity.position.z - target.z).toFixed(2)),
      moved: 0,
      via: 'pathfinder-unavailable',
      stuck: true,
      reason: 'PathfinderUnavailable',
      hint: 'mineflayer-pathfinder 没有加载，已停止移动，避免盲跳。请重启 DSH 并检查 dsh-mc-agent.log。',
    }
  }
  /* 🔴 2026-10-08 审计⑦：以前是 `Math.max(150, Math.min(callBudget(budget), self.msLeft()))`
   *    —— `msLeft()` 已经是 0 时，`Math.min` 给出 0，外层 `Math.max` 又把它抬回 150 ⇒ 照样再跑 150ms。
   *    本轮时间真的用完了就**别开始**，如实告诉模型"再叫一次接着走"。 */
  const leftMs = self.msLeft()
  if (leftMs <= 100) {
    return {
      arrived: false,
      position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
      remaining: Number(Math.hypot(b.entity.position.x - target.x, b.entity.position.z - target.z).toFixed(2)),
      moved: 0,
      via: 'pathfinder',
      stuck: true,
      reason: 'call-over',
      hint: `这一轮的走路时间已经用完了（单次调用最多 ${budgetSecText()}）—— 直接再叫一次 mc_move 往同一个目标走，会接着走。`,
    }
  }
  const pfOut = await ctx.walkPathfinder(target, {
    arrive,
    noTower,
    noBridge,
    allowDig,
    intent,
    xz,
    // 🔴 单次调用 ≤11 秒：预算收进 CALL_BUDGET_MS，且不超过本轮剩余时间。
    //    走不到不是失败，是"这一轮用完了"—— 再叫一次接着走。
    //    `msLeft()` 没设截止时刻时返回 CALL_MS（11000），用完时返回 0（别再 `||` 补 10 秒）。
    budget: Math.max(0, Math.min(callBudget(budget), leftMs)),
    budgetAsked: callBudget(budget),
  })
  /* 🔴 2026-10-22 用户「还是能卡住」——**站在实心地面上泡在 1 格深的水里**那条分支
   *   （上一版为了修「游泳控制器推不动」改成交给 pathfinder）没有脱困兜底：
   *   pathfinder 也动不了时就直接报失败，`recoverFromWater` 一次都不会跑。这里补上。 */
  if (inWaterNow(b) && pfOut && pfOut.stuck === true && pfOut.reason !== 'preempted'
      && Number(pfOut.moved ?? 0) < 0.6
      && ctx.noWaterRecover !== true && ctx.waterRecover !== false && self.msLeft() > 2_000) {
    const rec = await recoverFromWater(self, { budgetMs: Math.min(9_000, Math.max(0, self.msLeft() - 800)) }, recoverCtxOf(self, ctx))
    const out = !inWaterNow(b)
    if (out) {
      return {
        ...pfOut,
        stuck: false,
        outOfWater: true,
        waterRecover: rec,
        hint: `寻路在水里也走不动，所以我自己找路上了岸（${rec?.note ?? ''}）—— 原来的目标还要不要接着走，你看一眼再定。`,
      }
    }
    return {
      ...pfOut,
      waterRecover: rec,
      hint: `还在水里${rec?.ok ? '（能喘口气了，但没出去）' : ''}，没找到出口（${rec?.reason ?? 'unknown'}）：${rec?.note ?? ''}`,
    }
  }
  return pfOut
}

/**
 * 飞到某个坐标（仅创造模式）。
 *
 * 🔴 **刻意不使用 mineflayer 的 `bot.creative.flyTo`** —— 它有两处硬伤，
 *    2026-09-15 真机（mc）踩得很惨，三个症状全部源于它：
 *
 *   ① 结尾是 `await once(bot, 'move', 0)` —— **timeout 传 0 = 永不超时**。
 *      服务端不回 move 回执就永久挂住。真机日志里 `飞行 超时（30000ms）` /
 *      `接近放置点 超时（30000ms）` 反复出现，就是这个。
 *      **表现特别坑**：客户端位移其实已经改了 → **动作生效了，但工具迟迟不返回、
 *      最后报超时**（用户原话："移动有时候已经生效了，但等很久工具才返回，返回的是超时"）。
 *
 *   ② 它调 `startFlying()` 把 `physics.gravity` 置 0，却**从不 `stopFlying()`**。
 *      一次失败就把机器人永久留在**零重力** → 之后 `walkTo` 完全失效
 *      （真机症状：fly 超时之后 walk 30s 原地不动）。
 *
 * 所以这里自己实现：小步推进 + **进度检测**（推不动就早停，不耗满预算）+ 预算上限，
 * 并且**无论如何在 finally 里恢复重力**。到位就返回，**不等服务端回执**。
 *
 * 🔴 2026-10-19（用户：「创造模式 fly 现在用不了」）—— 两个真根因，都在这一版修掉了：
 *
 *   A. **没告诉服务端"我在飞"**。`b.creative.startFlying()`（含上游 `flyTo`）只把本地
 *      `physics.gravity` 置 0，**一个包都不发**；而服务端判位移是否合法看的是
 *      **abilities 里 flying 那一位**（原版客户端起飞时发 `serverbound abilities`）。
 *      于是服务端按"空中站着乱漂"把我拉回去 → 客户端位移改了又被打回，工具报
 *      「没到目标」/`preempted`。现在起飞前/落地后都发一次：
 *      `b._client.write('abilities', { flags })`（1.21.4 该包只有 flags 一个字段）。
 *
 *   B. **位移速度超了服务端上限**。旧实现每 60ms 硬写 `b.entity.position` 挪 2 格
 *      = **约 33 m/s**（原版创造飞行上限约 10.9 m/s），就算权限对也一定被判"移动太快"
 *      而拉回。现在改成**按 tick 给速度**：每 50ms 把 `b.entity.velocity` 设成朝目标的
 *      `FLY_SPEED_PER_TICK = 0.45 格/tick ≈ 9 m/s`，由 mineflayer 的物理循环积分成位移
 *      —— 速度真实、服务端肯认，撞墙也会被物理层挡住（不再穿墙）。
 */
export const FLY_TICK_MS = 50
export const FLY_SPEED_PER_TICK = 0.45
export const ABILITY_INVULNERABLE = 0x01
export const ABILITY_FLYING = 0x02
export const ABILITY_ALLOW_FLYING = 0x04
export const ABILITY_CREATIVE = 0x08

/** 告诉服务端"我在飞 / 我落地了"（原版客户端起飞时就是这么发的）。没有连接时静默返回 false。 */
export function setFlyingAbilities (b, flying) {
  const w = b?._client?.write
  if (typeof w !== 'function') return false       // 没连接/假 bot：别炸，但别谎报成功
  const flags = ABILITY_INVULNERABLE | ABILITY_ALLOW_FLYING | ABILITY_CREATIVE | (flying ? ABILITY_FLYING : 0)
  try {
    w.call(b._client, 'abilities', { flags })
    return true
  } catch {
    return false
  }
}

/** 脚下 `depth` 格内有实心方块吗？（读不到方块 = 没加载 ⇒ 当"悬空"，宁可悬着也别掉下去） */
export function solidUnder (b, pos, depth = 3) {
  const x = Math.floor(pos.x)
  const y = Math.floor(pos.y)
  const z = Math.floor(pos.z)
  for (let d = 1; d <= depth; d++) {
    let blk = null
    try { blk = b?.blockAt?.(new Vec3(x, y - d, z)) ?? null } catch { blk = null }
    if (blk === null) return false
    if (isSolidBlock(blk.name ?? blk)) return true
  }
  return false
}

/**
 * 结束"悬停飞行"：速度归零 + 发 abilities(不 flying) + 恢复重力。
 *
 * 🔴 2026-10-19（用户选「要悬停，走路时自动落地」）：`flyTo` 飞到**空中**的目标后会保持飞行状态
 *    （原版玩家松手就是悬停），此时 `physics.gravity` 是 0 —— **任何地面移动开跑前必须先调它**，
 *    否则走路全废（这正是上游 `creative.flyTo` 从不 `stopFlying` 留下的坑）。
 */
export function endHoverFlight (b) {
  if (!b?._hoverFlying) return false
  try { b.entity.velocity = new Vec3(0, 0, 0) } catch { /* 忽略 */ }
  setFlyingAbilities(b, false)
  try { b.creative?.stopFlying?.() } catch { /* 忽略 */ }
  b._hoverFlying = false
  return true
}

export async function flyTo (self, x, y, z, { budget = CALL_BUDGET_MS } = {}, ctx = {}) {
  const b = self.requireBot()
  if (b.game?.gameMode !== 'creative') throw new Error('飞行只在创造模式可用（当前 ' + b.game?.gameMode + '）')
  const target = new Vec3(Number(x), Number(y), Number(z))
  const t0 = Date.now()
  /* 🔴 单次调用 ≤11 秒（创造模式飞远路要分几次）；`msLeft()` 用完时是 0，别 `||` 补 10 秒。
   * 🔴 2026-10-08 审计⑤⑦：默认值以前是 20_000（比单次上限还大），而且调用方**不传 budgetMs** ⇒
   *    AI 写 `budgetMs:2000` 想"飞一小段"照样跑满 10 秒；`msLeft()` 用完时又被外层 max 抬回 150ms。 */
  const leftMs = self.msLeft()
  if (leftMs <= 100) throw new Error(`这一轮的 ${callSecText()}用完了（单次调用最多 ${budgetSecText()}）—— 过一会儿再叫一次 mc_move{mode:"fly"}`)
  const bd = Math.max(0, Math.min(callBudget(budget), leftMs))
  /* 🔴 2026-10-08 第四份审计报告 ⑥⑦：flyTo 以前**不领 `_moveGen` 号**（体系外的一块）——
   *    它靠直接写 `b.entity.position` 移动，不看控制位也不看 pathfinder，
   *    所以别的移动/反射层"抢占"它时它照飞；循环里的 `sleep(60)` 也没 `raceAbort`（中断最多晚 60ms）。
   *    现在领号 + 每轮查号 + 可中断 sleep + finally 只在还是自己时 `stopFlying()`。 */
  const gen = ctx.beginMove('fly')
  let preempted = false
  let flying = false                       // 这次调用有没有真的 startFlying（收尾要认它，不认号）
  let hovering = false                     // 收尾后是不是留在空中悬停（见 finally）
  let last = b.entity.position.clone()
  let lastProgress = Date.now()
  self._selfMovingAt = Date.now()          // 别把自己飞当成"被传送"
  try {
    setFlyingAbilities(b, true)            // 🔴 先告诉服务端我在飞，否则位移会被打回（见上面 A）
    b.creative.startFlying()
    flying = true
    while (Date.now() - t0 < bd) {
      if (self.abortSignal?.aborted) throw abortError('飞行', self.abortSignal)
      if (self._moveGen !== gen) { preempted = true; break }
      const pos = b.entity.position
      const v = target.minus(pos)
      const mag = Math.hypot(v.x, v.y, v.z)
      if (mag <= 1.5) break
      const step = Math.min(mag, FLY_SPEED_PER_TICK)   // 约 9 m/s，别超原版创造飞行上限
      b.physics.gravity = 0
      b.entity.velocity = new Vec3((v.x / mag) * step, (v.y / mag) * step, (v.z / mag) * step)
      await raceAbort(sleep(FLY_TICK_MS), self.abortSignal, '飞行')
      if (b.entity.position.distanceTo(last) > 0.3) {
        last = b.entity.position.clone()
        lastProgress = Date.now()
      } else if (Date.now() - lastProgress > 2500) {
        break                               // 推不动了（被地形挡住 / 服务端不接受），别耗满预算
      }
    }
  } finally {
    // 🔴 必须恢复重力：否则之后走路全废（见上面 ②）
    /* 🔴 报告⑥：被接管了就别动接管者的状态。
     * 🔴 报告 H7（2026-10-13）：但 `startFlying()` 是**这次调用**做的，重力必须由这次调用恢复 ——
     *    以前这里也带 `_moveGen === gen` 守卫，被抢占那条路（号变了）会跳过它，而全仓没有第二处
     *    `stopFlying` ⇒ `physics.gravity` 永久为 0（之后走路/跳跃全废，只能重连）。
     *    判据改成"我起过飞就我收"，跟号无关：别人接管的是"继续移动"，不是"替我恢复重力"。 */
    try { b.entity.velocity = new Vec3(0, 0, 0) } catch { /* 忽略 */ }
    /* 🔴 2026-10-19（用户选「要悬停，走路时自动落地」）：飞完人还在空中就**保持飞行状态悬停**
     *    （原版玩家飞到半空松手就是这样），不再往下掉。
     *    两条硬约束：① 被抢占时交给接管者，**不许**留着零重力；② 之后的 walk/jump 必须先调
     *    `endHoverFlight() &&` 恢复重力，否则走路全废（踩坑档案 209 的 ②）。 */
    hovering = flying && !preempted && !solidUnder(b, b.entity.position, 3)
    if (hovering) {
      b.physics.gravity = 0
      b._hoverFlying = true
    } else {
      setFlyingAbilities(b, false)         // 落地了要告诉服务端，不然它一直当我在飞
      if (flying) { try { b.creative.stopFlying() } catch { /* 忽略 */ } }
      b._hoverFlying = false
    }
    self._selfMovingAt = Date.now()
  }
  const p = b.entity.position
  const distance = Number(p.distanceTo(target).toFixed(2))
  /* 2026-10-23 审计（移动层报告第 2 条）：循环是 `mag <= 1.5` 收工，到达却按 2.5 判 ——
   * 撞地形提前 break 时停在 2.0~2.5 格也报 arrived:true。统一成 1.5。 */
  const arrived = distance <= 1.5
  return {
    position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    distance, arrived, ms: Date.now() - t0,
    ...(hovering ? { hovering: true, hint: '脚下没实物，我**悬在空中**没落地（原版飞行手感）—— 想落地或走路就 mc_move{mode:"walk"}（会自动关飞行），继续飞就再叫一次 fly。' } : {}),
    ...(preempted ? { reason: 'preempted', hint: '另一次移动把我接管了（我停了飞行）—— 再叫一次 mc_move{mode:"fly"} 往同一个点飞' } : {}),
    ...(arrived ? {} : {
      note: `没到目标（还差 ${distance} 格）。`
        + (Date.now() - t0 >= bd - 120
          ? `这一轮的 ${callSecText()}用完了（飞了 ${Math.round((Date.now() - t0) / 1000)} 秒）—— 直接再叫一次 mc_move{mode:"fly"} 往同一个点飞，会接着飞。`
          : '飞不动了：多半是**撞到地形**（物理层挡住了，往上抬一点再飞），或者服务端不认飞行权限（先确认自己是创造模式）—— 也可以改用 mc_move{mode:"walk"}。'),
    }),
  }
}

/* ══ P0-1 移动进度监控 + 自动脱困阶梯（用户 2026-10-15 方案）══════════════════
 *
 * 为什么要有这一层：vendor 的 pathfinder 只在"**3.5 秒没走到下一个路径节点**"时
 * 自己 `resetPath('stuck')`（`mineflayer-pathfinder/index.js:632`）——那只是**重算**，
 * 既不换策略，也不如实告诉模型"我卡住了"。实机表现就是用户报的：能走到附近，
 * 但绕路、卡方块边缘、反复跳跃，最后要么谎报到达、要么无限重试。
 *
 * 判据（**用户特别点名的坑**："不要只根据速度为零判断卡住"）：
 *   · 只认"**既没挪动、也没靠近**"——`剩余距离`连续 `MOVE_STUCK_MS` 没有改善才算卡住；
 *   · 跳跃、落地、等方块更新时位置本来就不前进 ⇒ "正在挖 / 正在放 / 悬空"算**正常等待**，
 *     把进度时钟往后推（最多推 `MOVE_BUSY_MAX_MS`，免得一直挖个不停就永远不判卡）。
 *
 * 脱困阶梯三级（见 `MOVE_ESCAPES`）：重算路径 → 跳跃脱困 → 后退再寻路；三级用完还是
 * 没进展就明确报 `unreachable`，**不再无限重试**。
 */
/* ── 2026-10-18 审计 P1-2：**导航意图** ────────────────────────────────
 * "到"的标准本来就不止一种：站到那一格上 / 走到旁边够得着 / 跟目标同一层再说话。
 * 以前只有一个 `arrive`，调用方只能瞎猜；猜小了走不到、猜大了报"到了"却用不了。
 * 这里把四种意图的（到点多远、能接受多大高差）固定下来，`intent` 一路传到到达复核。
 *   near       走到附近就算到（默认，兼容老行为）
 *   stand      要站到那一格上（误差 0.8 格、高差 0.6）
 *   interact   到"够得着"的位置（2.2 格内，允许高差 2.5 —— 开箱子/按按钮/砍树）
 *   same-level 必须有同一层可站的地方（高差 ≤0.9，防止站在坑底/树顶说到了） */
export const INTENTS = {
  near: { arrive: 1.6, vertTol: 1.5 },
  stand: { arrive: 0.8, vertTol: 0.6 },
  interact: { arrive: 2.2, vertTol: 2.5 },
  'same-level': { arrive: 1.6, vertTol: 0.9 },
}
/** 未知意图按 `near` 处理（不报错：模型写错一个词不该让整次移动失败）。 */
export function intentOf (intent) { return INTENTS[intent] ?? INTENTS.near }

export const MOVE_SAMPLE_MS = 600       // 采样间隔（用户建议 500–1000ms）
export const MOVE_STUCK_MS = 2400       // 连续这么久"既没挪动也没靠近" ⇒ 卡住（用户建议 2–3 秒）
/* 🔴 2026-10-24 用户：「每级时间缩短，按你之前的建议」—— 脱困阶梯每一级**按动作快慢分档**，
 *    不再一律等满 `MOVE_STUCK_MS`（2.4 秒）。
 *
 * 🔴 2026-10-31 用户：「兜底是串行阶梯，每级先 stopPathing 再等"卡" MOVE_STUCK_MS 2400 /
 *    vendor 3500，7~10 级 —— 这个怎么解决」。
 *    查下来有三处硬伤：
 *    ① `descend` / `clearHead` / `climbUp` **根本没进这张表** ⇒ 各自落回 `MOVE_STUCK_MS`(2.4 秒)。
 *       于是注释原先写的"不挖那套 6.3 秒"是**错**的：实机 0.9+1.0+2.4+2.4+1.1+1.5 = **9.3 秒**；
 *       允许挖那套再各加 2.4×2 = **14.1 秒** —— 10 秒预算里根本走不完一轮，"一次只挪一格"。
 *    ② 这些动作是**自证的**：挖一格 200~400ms 就从包里回来了，人有没有往上/往下挪，
 *       采样一次就知道 —— 不需要等满 2.4 秒的"没靠近"判据。
 *    ③ 固定顺序：柱顶真正管用的 `descend` 排第 3，前两级（repath/jump）纯烧预算。
 *
 *    ⇒ 这张表改成**探针值**：一次动作发出后给这么长时间看有没有位移，有就立刻结束这一级
 *      （`moveProgressWatcher` 一有进展就 resolve），没有就马上换下一招。
 *      不挖那套合计 4.7 秒、允许挖那套 6.3 秒 —— 一轮能试完，还能再试第二遍。 */
export const MOVE_STEP_WAIT_MS = {
  door: 900,
  repath: 600,      // 重算本身 50~200ms，600 够它启动
  jump: 700,        // 跳一次 0.32 秒 + 落地
  descend: 800,     // 挖一格掉下去：挖完就有回包
  clearHead: 700,   // 只清头顶那一格
  climbUp: 900,     // 挖两格 + 跳，比 descend 多一格
  breakAhead: 1400, // 挖一格挡路的（硬方块要更久，但挖不动也早该知道）
  backoff: 800,
  detour: 1100,
  tower: 1200,
}
/* 🔴 2026-10-28 参数审计：原来按"疾跑 4.3 格/秒 × 10 秒 = 43 格"估一次调用能走多远 ——
 *    那是**无障碍直线**的理论值。实机会话（726 次 mc_move、1927 格 / 839 秒）算下来只有
 *    **2.3 格/秒**（开门、爬台阶、等方块更新、被怪挡都在里面），估算少报近一半 ⇒
 *    模型以为"再走一次就到"，实际每次都在半路超时。改成"每秒格数 × 这一轮的实际预算"。 */
export const MOVE_GRID_PER_SEC = 2.4
/** 一趟大约能走多少格（跟着这一轮的预算走，偏保守）。`budgetMs` 传这一轮分到的预算。 */
export function estPerCallOf (budgetMs) {
  /* 预算本身也可能被传成 20 秒（套件/内部调用），按上限截一道，别又估成乐观值 */
  const secs = Math.max(1.5, Math.min(Number(budgetMs) || CALL_BUDGET_MS, CALL_BUDGET_MS) / 1000)
  return Math.max(4, Math.round(MOVE_GRID_PER_SEC * secs))
}
export const MOVE_PROGRESS_EPS = 0.35   // 靠近这么多格才算"有进展"
/* 🔴 2026-10-29（用户：「卡住门槛 2.4 秒就判卡，但挖一格石头要 7.5 秒 —— 没镐挖硬方块永远判不出来」）：
 *   挖/放是**合法工作**，不能按"卡住"算。这档宽限必须大于**任何一次单次调用**（`CALL_MS`），
 *   于是它实际等价于"工作期间**暂停**卡住判定"；真正挖不动的死循环由"工作累计上限"兜底，
 *   而不是靠一个比 7.5 秒还小的固定值去截断。 */
export const MOVE_BUSY_MAX_MS = 12_000
/* 🔴 2026-10-28（用户：「卡在半空有没有可能是内部参数的问题」→ 实机确认就是）：
 *   以前"离地"和"在挖"共用这 6 秒宽限。可**一次跳跃只有 ~0.6 秒**，6 秒等于把
 *   "真挂住了"整个当成正常：人挂在自己垫的柱子顶上（`pillared:2` + 头顶被堵）、
 *   速度 0、一动不动，却 6 秒不判卡；而 `mc_move` 一次预算常只有 4~8 秒 ⇒ 宽限期
 *   吃光整轮，脱困阶梯永远轮不上，返回只剩 `reason:"timeout"`、`stuck:false`。
 *   现在空中单独一档，且**必须真在动**（垂直/水平速度明显不为 0）才算"在落地"。 */
export const MOVE_BUSY_AIR_MS = 900      // 空中宽限：一次跳跃 ~600ms，再给 300ms 余量
export const MOVE_BUSY_VY_EPS = 0.08     // 垂直速度阈值（跳跃上升 ~0.42，自由落体下坠更快）
export const MOVE_BUSY_VH_EPS = 0.10     // 水平速度阈值（被水推、被活塞推都算"在动"）
export const MOVE_JUMP_MS = 320         // 跳跃脱困按住 jump 多久
/* 🔴 2026-10-23 实机（用户：「刚刚一直卡在这里」，日志里这条动作 208747ms 才被抢占）：
 *    `withTimeout` 只罩住 `pathfinder.goto`，走路这条路上还有**裸 await** 能无限挂住 ——
 *    典型是"挖开挡路那一格"：vendor 的 `diggingTask` 只在收到 air 方块更新时才 settle，
 *    服务端不回包就永远挂着（同一个病见 `src/dig-guard.mjs` 的注释）；`b.equip` 同理。
 *    所以两层兜底：
 *      · `MOVE_HARD_SLACK_MS` —— 整次 `walkTo` 的硬上限（预算 + 这点余量），到点就掐断并如实返回；
 *      · `MOVE_CARVE_DIG_MS` —— 单格挖掘/换工具的上限，到点松手，别把整趟走路一起拖死。
 *    ⚠️ 硬上限只是**兜底**：正常路径永远先在预算内自己结束，不许拿它当主超时。 */
export const MOVE_HARD_SLACK_MS = 3_000
export const MOVE_CARVE_DIG_MS = 3_000   // 单格挖掘守卫的**下限**；实际取 max(它, 实测挖掘时间+1.2s)（空手挖石头 7.5 秒）
export const MOVE_BACK_MS = 420         // 后退脱困按住 back 多久
/* P1：一次 `goto` 里路径被**失效**这么多次 ⇒ 别再等"没进展"了，直接进脱困阶梯。
 * 依据：vendor 自己会在 3.5s 无节点进展时 `resetPath('stuck')`，但它只会**重算同一条**；
 * 一个 goto 里失效这么多次，说明"光重算没用"（世界在变 / 一直被人挡），换策略才有意义。 */
export const MOVE_RESET_LIMIT = 4
/** vendor（mineflayer-pathfinder）自己判一次 "stuck" 的周期，实测约 3.5 秒。
 *  2026-10-23 晚（用户实机）：一次调用 10 秒，只够判 **2 次** —— 而脱困阶梯原先要等
 *  "重算 4 次"才启动，于是**永远轮不上**（结果里连 planTried 都没有，10 秒全耗在
 *  "stuck → 重算 → stuck → 超时"）。下面按预算自适应算门槛。 */
export const MOVE_VENDOR_STUCK_MS = 3_500
/** 脱困阶梯（第 1 级 = `MOVE_ESCAPES[0]`）。走完还没进展 ⇒ 报 `unreachable`。 */
/* 2026-10-23：`detour`（侧向绕行）插在 `breakAhead`（挖）之前 —— 能绕就别拆人家的房子。
 * 前三级顺序是用户 2026-10-15 定的，没动。见 `MOVE_ESCAPES_DIG`（唯一那份执行顺序）。
 *
 * 🔴 2026-10-24（用户：「和 move 默认不挖有关系吗」→「修一下」）：阶梯**按 allowDig 分两套**。
 *    ① **不挖时**（`allowDig:false`，即 `mc_move` 与内部 `walkTo` 的共同默认）阶梯里**没有 breakAhead** ——
 *       以前它还在，但 `escapeMove` 见 `allowDig !== true` 就 `return { dug: 0 }`，纯空转一轮
 *       `MOVE_STUCK_MS`(2.4 秒)，还会把 breakAhead 写进 `planTried`，让模型以为"挖也试过了没用"。
 *    ② **允许挖时**（`allowDig:true`）把 breakAhead **提到 jump 之后**（第 3 级）：
 *       能挖的时候卡住，多半就是"1 格台阶 A* 挖不动"，直接挖比先退再绕快得多。
 *       侧向绕行(detour)仍在它后面 —— "能绕就别拆"只管**不挖**的那套顺序。 */
/* 🔴 2026-10-28（用户批准）：不挖那趟补一级 `clearHead` —— 只清**自己头顶那一格**。
 *   悬空挂在柱子顶上（`pillared:N`）时，重算/跳/后退/绕行/垫柱全无效：头顶那格实心，
 *   跳起来撞头、A* 也规划不出"上得去"的路，整轮只能超时。
 *   位置在 jump 之后、backoff 之前：先确认"跳也白跳"再动镐，代价是一格方块。 */
export const MOVE_ESCAPES_NODIG = ['repath', 'jump', 'descend', 'clearHead', 'backoff', 'detour']
/* 2026-10-29（用户：目标在头顶 10 格，工具却只报“前方 stone 挡着、挖开它”）：
 *   往上走（`climbUp`）以前**只挂在“A* 空路径”那条分支**上。真正的常见情形是 A* 给了
 *   一条到附近的路、走到墙前卡住 —— 那条路走的是这套阶梯，而阶梯里根本没有“往上挖”。
 *   于是要爬高时永远只跳一下、再挖眼前一格，10 格的目标一层都上不去。
 *   加在 `jump` 之后（先确认“跳也白跳”再动镐）、`breakAhead` 之前（挖眼前那格不如往上挖）。 */
/* 2026-10-29（用户：「move 还是不会自己上下」）：阶梯里以前只有“往上挖”（climbUp），**没有“往下走”** ——
 *   目标在脚下 10 格时它去试上台阶，回来只报“前方脚下是 stone（没有两格高）”，方向都错了。
 *   `descend` 放在 jump 之后、climbUp 之前：两者按目标方向互斥，谁匹配谁动。 */
export const MOVE_ESCAPES_DIG = ['repath', 'jump', 'descend', 'climbUp', 'breakAhead', 'backoff', 'detour']
/** 默认阶梯 = 允许挖那套（保留旧名，调用方与测试仍在用）。 */
/* 🔴 2026-11-02 审计（#26）：这里原来有个 `MOVE_ESCAPES = MOVE_ESCAPES_DIG` 的旧别名，
 *   还被 `orderEscapesFor` / `escapeStepOf` 当默认参数用 —— 于是**忘了传阶梯**的地方
 *   悄悄拿到"允许挖"那一套（多做一件不可逆的事）。别名已删；默认值改成不挖那套，
 *   和 `escapeStepsFor()` 不给参数时的方向一致。 */
/** 这一趟该用哪套阶梯（`allowDig !== true` 时不含 breakAhead）。 */
export function escapeStepsFor (allowDig) {
  return allowDig === true ? MOVE_ESCAPES_DIG : MOVE_ESCAPES_NODIG
}
/* 🔴 2026-10-31 用户：「我想要智能规划路线，不想要兜底」（→ 兜底串行阶梯怎么解决）。
 *    阶梯的**集合**不换，只按眼前的诊断换**顺序** —— 柱顶上先试 descend 而不是先白算两遍路径：
 *      · 目标更低（`goalLower`）⇒ `descend` 先；头顶还堵着就紧跟 `clearHead`
 *      · 目标更高（`goalHigher`）⇒ 头顶堵着先 `clearHead`，否则 `climbUp`
 *      · 眼前有实心挡路（`wallAhead`）⇒ `breakAhead` 先
 *    诊断提上来的招之后**紧跟 repath**（600 毫秒，专救"路被作废"那种），其余保持原顺序。
 *    没有诊断（平地卡住）⇒ 原顺序原样返回 —— 行为和以前一模一样。
 *    纯函数，方便断言：只看 info，不碰 bot。 */
export function orderEscapesFor (info = {}, steps = MOVE_ESCAPES_NODIG) {
  const i = info ?? {}
  const first = []
  /* 🔴 2026-10-30 实机（用户：「它刚刚的操作是下去，然后上来」「move往上走的时候会先挖几格再垫」）：
   *    以前这里只把"该先试的那一级"往前提，**从没把反方向的那一级往后挪** ——
   *    人在 y=39、目标 y=64（头顶 25 格）时照样先试 `descend`（下去再上来），
   *    `climbUp` 又被提到 A* 前面（一卡住就挖斜上两格，而不是先让**有垫柱能力**的 A* 重规划）。
   *    这里补一份 `last`：目标在上 ⇒ descend 押后；目标在下 ⇒ climbUp 押后。
   *    `repath` 一律排在"动手挖/跳"之前。 */
  const last = []
  if (i.goalLower === true) {
    first.push('descend')
    if (i.headBlocked === true) first.push('clearHead')
    last.push('climbUp')                    // 目标在下方：别先往上爬（爬上去还得再下来）
  } else if (i.goalHigher === true) {
    /* ⚠️ 允许挖那套（`MOVE_ESCAPES_DIG`）里**没有** clearHead —— 它的 `climbUp` 本来就先挖开
     *    头顶那两格再跳，所以头顶堵着也直接上 climbUp；不挖那套才有 clearHead。 */
    if (i.headBlocked === true && steps.includes('clearHead')) first.push('clearHead')
    last.push('descend')                    // 目标在上方：别先往下走
  }
  if (i.wallAhead === true) first.push('breakAhead')
  const out = []
  for (const s of first) if (steps.includes(s) && !out.includes(s)) out.push(s)
  if (steps.includes('repath') && !out.includes('repath')) out.push('repath')
  for (const s of steps) if (!out.includes(s) && !last.includes(s)) out.push(s)
  for (const s of last) if (steps.includes(s) && !out.includes(s)) out.push(s)
  return out
}

/** 眼前这一圈能看出什么（给 `orderEscapesFor` 用）。读不到就当没有诊断 ⇒ 原顺序。 */
export function escapeDiagOf (b, target) {
  const out = {}
  try {
    const me = b?.entity?.position
    const ty = Number(target?.y)
    if (me && Number.isFinite(ty)) {
      if (ty < Number(me.y) - 0.5) out.goalLower = true
      else if (ty > Number(me.y) + 1.5) out.goalHigher = true
    }
    if (towerHeadBlocked(b)) out.headBlocked = true
    if (obstacleAheadOf(b, target)) out.wallAhead = true
  } catch { /* 假 bot / 区块没加载：当没有诊断 */ }
  return out
}

/* 🔴 2026-10-18（实机，AI 原话：「窄隧道和 1 格台阶上它基本走不动，10 秒原地蹭 0.8 格」）：
 *    在 1×2 高的**窄隧道**里遇到 1 格台阶时，A* 上不去 —— 站上台阶要 3 格净高，而这里只有 2 格；
 *    vendor 的 `JumpUp` 只查"头顶有没有空"，**不会计划去挖那个天花板**。于是 `goto` 找不出路：
 *    表现就是 `stuck` + `moved:0` + `remaining:0.8`（人就在目标旁边，却一步不动），
 *    模型只能手工 `break 脚 + break 头 + move` 一段段爬（实机 15:09–15:12 就是这么干的）。
 *    这里把那套手工动作**收进走路层**：卡住且离目标 ≤ `MOVE_CARVE_RADIUS` 时，朝目标方向
 *    挖开"挡在脚上/头顶"的那一格（只挖实心、非危险、底下有支撑的），然后重试同一个 `goto`。
 *    不改脱困阶梯的顺序（那是用户 2026-10-15 定的），只在阶梯**之前**补这一次。 */
export const MOVE_CARVE_RADIUS = 4.5    // 离目标这么近还卡住，才值得动镐子（远处改看"眼前有没有挡路的"）
/* ── 2026-10-18 实机：**门** ────────────────────────────────────────────────
 * 用户原话："现在 move 遇到门不会开，会直接从墙挖进去"。
 * 根因：vendor 的 `Movements.canOpenDoors` 默认 **false**（`movements.js:101`，
 * 注释写着"Causes issues"），门在 A* 眼里就是实心方块；而 `canDig` 是 true ——
 * 于是"挖墙过去"永远比"绕路"便宜，模型看到的就是"从墙里挖进去"。
 * 分层修：
 *   ① `canOpenDoors = true`（`src/plugins.mjs`）—— 让 A* **规划**穿门；
 *   ② 执行层自己开门：走到门边上 `activateBlock` 一下（这份 vendor 的 `useOne`
 *      只有规划、没有执行，指望不上）；
 *   ③ 门的方块进 `CARVE_PROTECTED` —— 卡住时的那种"挖开挡路的"绝不砸门。 */
export const DOOR_RE = /(_door|_trapdoor|_fence_gate)$/
export const DOOR_OPEN_R = 2.6

/**
 * 一扇门的"门轴坐标"：门有两格（下/上），按任意一格都能开关；**按两格 = 开了又关**。
 * 这里把上半格折算到下半格，同一次扫描里只按一格。
 */
export function doorBaseKey (blk) {
  const p = blk?.position
  if (!p) return null
  let y = Number(p.y)
  try {
    if (blk.getProperties?.().half === 'upper') y -= 1
  } catch {}
  return `${Math.floor(p.x)},${Math.floor(y)},${Math.floor(p.z)}`
}

/** 铁门/铁活板门：只有红石能开，手动按不开 —— 别反复空点。 */
export const DOOR_IRON_RE = /^iron_(?:door|trapdoor)$/

/** 同一扇门两次按之间的冷却：门开了之后 **再按一下就关回去了**（实机"卡在门外一直开门"）。 */
export const DOOR_PRESS_COOL_MS = 1_500

/** 按完之后等服务端把 `open` 同步回来：6 × 50ms = 最多 300ms。 */
export const DOOR_CONFIRM_TRIES = 6
export const DOOR_CONFIRM_MS = 50

/**
 * 读到方块时统一折算成"逻辑门"（下半块）。
 *
 * 🔴 2026-10-18 用户指出：真实游戏数据里**上半块的 `open` 可能根本不存在**，
 *    只读上半块会得到 `undefined` —— 被当成"还关着"，于是再按一次，把刚开的门关回去。
 *    所以判断和交互都必须落在下半块上。
 */
export function doorFaceOf (b, blk) {
  try {
    if (blk?.getProperties?.().half === 'upper' && typeof b?.blockAt === 'function') {
      const p = blk.position
      const lower = b.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)))
      if (lower?.name && DOOR_RE.test(lower.name)) return lower
    }
  } catch {}
  return blk
}

/**
 * 门的开合状态：`'open' | 'closed' | 'unknown'`。
 * **不知道 ≠ 关着**：状态读不到时绝不能再点（再点可能就是关）。
 */
export function doorOpenStateOf (blk) {
  let props = null
  try { props = blk?.getProperties?.() } catch { return 'unknown' }
  if (!props || typeof props !== 'object') return 'unknown'
  if (props.open === true) return 'open'
  if (props.open === false) return 'closed'
  return 'unknown'
}

/** 按完之后回读，等它真的变成 `open`（最多 `DOOR_CONFIRM_TRIES` 次）。 */
async function confirmDoorOpen (b, target) {
  const read = () => doorOpenStateOf(typeof b?.blockAt === 'function' ? b.blockAt(target.position) : target)
  let st = read()
  for (let i = 0; i < DOOR_CONFIRM_TRIES && st !== 'open'; i++) {
    await new Promise((r) => setTimeout(r, DOOR_CONFIRM_MS))
    st = read()
  }
  return st
}

/**
 * **前方那扇门现在是不是开着**（2026-10-18 用户指出：卡住恢复里只看"这一轮新开了几扇"）。
 *
 * 🔴 缺口：`openNearbyDoor()` 返回的是**本次新打开的数量**。门上一轮已经开了、
 *    或者被 AI 自己开过、或者定时器 400ms 开过 —— 这时它返回 0，恢复分支就误以为
 *    "门口没门"，转头去**挖旁边的墙**。判定要问的是"挡路的门现在通不通"，不是"我刚开了几扇"。
 *
 * 只认**朝向目标那半边的门**（点积为正），避免屋里别处的门开着就把挖台阶补救整个挡掉。
 * 读不到状态（`unknown`）不算开 —— 不知道 ≠ 通。
 *
 * @returns {boolean}
 */
export function doorAheadOpen (b, target) {
  try {
    const p = b?.entity?.position
    if (!p || typeof b.blockAt !== 'function') return false
    const gx = Number(target?.x)
    const gz = Number(target?.z)
    if (!Number.isFinite(gx) || !Number.isFinite(gz)) return false
    const dx = gx - p.x
    const dz = gz - p.z
    const len = Math.hypot(dx, dz)
    if (len < 0.01) return false
    const ux = dx / len
    const uz = dz / len
    const me = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const done = new Set()
    for (let ox = -2; ox <= 2; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -2; oz <= 2; oz++) {
          const pos = new Vec3(me.x + ox, me.y + oy, me.z + oz)
          if (!DOOR_RE.test(String(b.blockAt(pos)?.name ?? ''))) continue
          const target2 = doorFaceOf(b, b.blockAt(pos))
          const key = doorBaseKey(target2) ?? `${pos.x},${pos.y},${pos.z}`
          if (done.has(key)) continue
          done.add(key)
          if (DOOR_IRON_RE.test(target2?.name ?? '')) continue
          if (doorOpenStateOf(target2) !== 'open') continue
          const ddx = pos.x + 0.5 - p.x
          const ddz = pos.z + 0.5 - p.z
          const dl = Math.hypot(ddx, ddz)
          if (dl > 2.6 || dl < 0.01) continue
          /* 朝向目标：点积 > 0.2·dl ⇒ 这扇门在前进方向上（不是背后的门） */
          if ((ddx * ux + ddz * uz) / dl < 0.2) continue
          return true
        }
      }
    }
  } catch {}
  return false
}

/**
 * **前进方向的走廊里有没有门**（2026-10-18 用户指出）：`carveStepAhead` 只查"要挖的那格"
 * 是不是受保护方块 —— 门前一格的普通石头不在名单里，照样会被挖穿，等于把门/门框拆了。
 *
 * 判据按**当前移动方向 + 门洞位置**，而不是"门周围两格一律保护"：
 * 沿主轴/副轴往前 `cells + 1` 格、脚/头两层找普通门（铁门按不开，不算）。
 * 找到了就返回那扇门，调用方据此**不做自动补挖**（开门/重算路径/交给 AI 决定）。
 *
 * @returns {object|null} 门方块
 */
export function doorOnRoute (b, target, { cells = MOVE_CARVE_CELLS } = {}) {
  try {
    const me = b?.entity?.position
    if (!me || !target || typeof b.blockAt !== 'function') return null
    const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
    const dx = Number(target.x) - me.x
    const dz = Number(target.z) - me.z
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
    const sx = Math.sign(dx), sz = Math.sign(dz)
    const dirs = []
    if (Math.abs(dx) >= Math.abs(dz)) { if (sx) dirs.push([sx, 0]); if (sz) dirs.push([0, sz]) }
    else { if (sz) dirs.push([0, sz]); if (sx) dirs.push([sx, 0]) }
    const check = (x, z) => {
      for (let dy = 0; dy <= 1; dy++) {
        let blk = null
        try { blk = b.blockAt(new Vec3(x, fy + dy, z)) } catch { continue }
        const n = blk?.name
        if (typeof n === 'string' && DOOR_RE.test(n) && !DOOR_IRON_RE.test(n)) return blk
      }
      return null
    }
    for (const [ddx, ddz] of dirs) {
      for (let d = 1; d <= cells + 1; d++) {
        const x = fx + ddx * d, z = fz + ddz * d
        if (x === fx && z === fz) continue
        const hit = check(x, z)
        if (hit) return hit
      }
    }
    return null
  } catch { return null }
}

/**
 * **从门里走过去**（2026-10-18 实机验证：门开着时 A* 规划"穿过门那格"偶尔原地磨到超时）。
 *
 * 门在规划层是"能穿的一格"，但出门这一两步没必要交给 A*：找到前进方向上的门 →
 * 确保它开着 → 看着门中心按住 forward，直到门落到身后再松手。**不改 goal**。
 *
 * @returns {Promise<{passed:boolean, door?:string, why?:string, moved?:number}>}
 */
export async function walkThroughDoor (b, target, { budgetMs = 1_600, radius = 3.2, signal = null, moveGenOf = null } = {}) {
  try {
    const p = b?.entity?.position
    if (!p || typeof b?.blockAt !== 'function') return { passed: false, why: 'no-bot' }
    const dir = doorOnRoute(b, target, { cells: 2 })
    if (!dir) return { passed: false, why: 'no-door' }
    const face = doorFaceOf(b, dir) ?? dir
    if (DOOR_IRON_RE.test(String(face?.name ?? ''))) {
      return { passed: false, why: 'iron', door: face?.name, hint: `${face?.name ?? '铁门'}是铁门 —— 我按不开（要红石/拉杆/按钮）。绕过去，或让玩家开。` }
    }
    if (doorOpenStateOf(face) !== 'open') {
      await openNearbyDoor(b, radius).catch(() => 0)
      await sleep(160)
    }
    /* 🔴 2026-10-22 用户第一条反馈（「门被当成实心方块 / 硬挤过去」）：以前这里是
     *    `!== 'open'` 就判死 —— 可 `doorOpenStateOf` 读不出状态时返回的是 **undefined**
     *    （方块属性还没同步、或者门本来就被人开着），于是"未知"被当成"关着"，
     *    走门流程直接放弃、退回去让 A* 硬挤。现在只认**明确 closed**，未知就照常往前走，
     *    过没过由物理位移判定。 */
    if (doorOpenStateOf(doorFaceOf(b, dir) ?? dir) === 'closed') {
      return { passed: false, why: 'closed', door: face?.name, hint: `${face?.name ?? '门'}按了还是关着（服务端没同步，或这扇门要红石）—— 别挖门框，绕路或再叫一次。` }
    }
    /* 🔴 `doorBaseKey()` 返回的是 **字符串** `"x,y,z"`（给去重用的），不是对象 ——
     * 第一版拿它当 `{x,y,z}` 用 ⇒ 中心点变 NaN ⇒ `lookAt(NaN)` ⇒ 物理把位置算成 NaN
     * （实机表现为 bot 位置直接变 NaN、寻路全废）。这里直接取下半块的 `position`。 */
    const base = (doorFaceOf(b, dir) ?? dir)?.position
    if (!base || !Number.isFinite(base.x) || !Number.isFinite(base.z)) return { passed: false, why: 'bad-pos' }
    const center = new Vec3(base.x + 0.5, base.y, base.z + 0.5)
    const start = b.entity.position.clone()
    const before = Math.hypot(target.x - start.x, target.z - start.z)
    try { await b.lookAt(center, true) } catch {}
    /* 🔴 2026-10-23 审计（A[5]）：按 forward 不看 `_moveGen`，被接管后仍会无条件松手。
     * 🔴 2026-10-24 通审：`b._moveGen` 根本不存在（那是 core 实例的字段）⇒ 上面的"代次保护"
     *    一直是假的。改由调用方把 `self._moveGen` 的读法传进来。 */
    const gen0 = moveGenOf ? moveGenOf() : null
    b.setControlState('forward', true)
    const t0 = Date.now()
    try {
      while (Date.now() - t0 < budgetMs) {
        /* 🔴 2026-10-23 审计（A[5]）：以前写的是 `b.abortSignal` —— mineflayer 的 bot 上**没有**
         *    这个属性（那是我们 core 实例的），传进去是 undefined ⇒ 这 80ms 根本不可中断。
         *    现在由调用方把 `self.abortSignal` 传进来。 */
        await raceAbort(sleep(80), signal, '穿门')
        if (moveGenOf && moveGenOf() !== gen0) break   // 被接管：别再按 forward，也别等到预算耗尽
        const now = b.entity.position
        const toTargetX = Number(target.x) - now.x
        const toTargetZ = Number(target.z) - now.z
        const toDoorX = center.x - now.x
        const toDoorZ = center.z - now.z
        if (toDoorX * toTargetX + toDoorZ * toTargetZ < 0) break   // 门已经在身后
        if (Math.hypot(toTargetX, toTargetZ) < 1.2) break           // 已经到目标附近
      }
    } finally {
      if (!moveGenOf || moveGenOf() === gen0) { try { b.setControlState('forward', false) } catch {} }
    }
    const end = b.entity.position.clone()
    const after = Math.hypot(target.x - end.x, target.z - end.z)
    const moved = Math.round(Math.hypot(end.x - start.x, end.z - start.z) * 100) / 100
    return { passed: after < before - 0.15, door: face?.name, moved, before: Math.round(before * 100) / 100, after: Math.round(after * 100) / 100 }
  } catch (e) {
    return { passed: false, why: String(e?.message ?? e).slice(0, 120) }
  }
}

/**
 * 把身边关着的门/栅栏门/活板门打开（只开、不管关；够不着就什么都不做）。
 *
 * 顺序很要紧（2026-10-18 用户指出，实机"卡在门外一直开门"）：
 * ① 先折算成下半块 → ② 按门轴 key **先去重** → ③ 再看它是不是已经开着
 * → ④ 冷却/在途锁 → ⑤ **先上锁再 await** → ⑥ 回读确认才报"开了"。
 *
 * @returns {Promise<number>} 这一轮**确认**真的开了几扇（`b.__doorLast` 里有明细）
 */
export async function openNearbyDoor (b, radius = DOOR_OPEN_R) {
  try {
    const p = b?.entity?.position
    if (!p || typeof b.activateBlock !== 'function' || typeof b.blockAt !== 'function') return 0
    let opened = 0
    const closed = []
    const unknown = []
    const iron = []
    const r = Math.ceil(radius)
    const me = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const pressAt = b.__doorPressAt instanceof Map ? b.__doorPressAt : (b.__doorPressAt = new Map())
    const inFlight = b.__doorInFlight instanceof Set ? b.__doorInFlight : (b.__doorInFlight = new Set())
    /* 🔴 2026-10-24 全量体检：这两个容器挂在 bot 上、**只增不减** —— 一天几百次开门、
     * 每次都往 Map/Set 里塞一条，长跑几周就是几万条（内存慢慢涨，且没人回收）。
     * 过期的冷却记录本来也不再起作用，顺手清掉；在途锁只清那些明显残留的（> 30 秒）。 */
    if (pressAt.size > 256) {
      const cutoff = Date.now() - DOOR_PRESS_COOL_MS * 4
      for (const [k, v] of pressAt) if (Number(v ?? 0) < cutoff) pressAt.delete(k)
    }
    if (inFlight.size > 64) {
      const t0 = Date.now()
      for (const k of inFlight) { if (t0 - Number(pressAt.get(k) ?? 0) > 30_000) inFlight.delete(k) }
    }
    const now = Date.now()
    const done = new Set()   // 这一轮碰过的门轴（上下半格只算一次）
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const pos = new Vec3(me.x + dx, me.y + dy, me.z + dz)
          if (pos.distanceTo(me) > radius) continue
          let blk = null
          try { blk = b.blockAt(pos) } catch { continue }
          if (!blk?.name || !DOOR_RE.test(blk.name)) continue
          const target = doorFaceOf(b, blk)
          const key = doorBaseKey(target) ?? `${pos.x},${pos.y},${pos.z}`
          /* ① 先整扇门去重：哪怕它已经开着，这一轮也不再碰它 ——
           *    绝不能让"上半格没有 open 属性"把一扇开着的门判成关着。 */
          if (done.has(key)) continue
          done.add(key)
          if (DOOR_IRON_RE.test(target?.name ?? '')) { iron.push(key); continue }
          const state = doorOpenStateOf(target)
          /* ② 开着 ⇒ 不按；**读不到 ⇒ 也不按**（不知道 ≠ 关着，按错了就是把门关上）。 */
          if (state !== 'closed') { if (state === 'unknown') unknown.push(key); continue }
          if (inFlight.has(key)) continue
          /* ③ 冷却：按过之后客户端那一格还没刷新时**不能再按**。 */
          if (now - Number(pressAt.get(key) ?? 0) < DOOR_PRESS_COOL_MS) continue
          /* ④ 先上锁再 await：400ms 定时器可能重入，两次调用都过了检查就会各按一次。 */
          inFlight.add(key)
          pressAt.set(key, Date.now())
          try {
            /* 🔴 2026-10-24 全量体检：`activateBlock` 要等服务端回包才 resolve，回包丢了就永久挂住
             * —— 而这里挂住的是**整次 `mc_move`**（外层预算只能 race 掉 Promise，底层调用还在跑）。
             * 和 vendor 那条 `use_block_error` 同一个道理：给它一个上限。 */
            await withTimeout(b.activateBlock(target), 1500, '开门')
            const after = await confirmDoorOpen(b, target)
            if (after === 'open') {
              opened++
              /* 记一笔"这扇是我们按开的"：vendor 规划里的 `useOne` 走到门口还会再按一次，
               * 那一下会把门关回去（实机"开了但不走门"）。`guardDoorActivate` 据此忽略重复按。 */
              if (b.__autoOpenedDoors instanceof Map) b.__autoOpenedDoors.set(key, Date.now())
              for (const s of [target, blk]) {
                const q = s?.position
                if (q && b.__autoOpenedDoors instanceof Map) b.__autoOpenedDoors.set(`${q.x},${q.y},${q.z}`, Date.now())
              }
            } else if (after === 'closed') {
              closed.push(key)
            } else {
              unknown.push(key)
            }
          } catch (e) {
            unknown.push(key)
          } finally {
            inFlight.delete(key)
          }
        }
      }
    }
    b.__doorLast = { opened, closed, unknown, iron }
    return opened
  } catch { return 0 }
}

/* 🔴 2026-10-18 审计（报告 Bug 3）：自动补救挖的是**世界**，不能只凭"它挡路"就挖。
 *    箱子 / 各种矿石 / 工作台熔炉附魔台 / 刷怪笼 / 重生锚 …… 一律不碰：那些是 AI 的资源、
 *    容器或装置，挖掉是不可逆的损失。要让某类方块可挖，得由 AI 自己调 `mc_act{break}`，
 *    别把它做成"走路失败就顺手挖了"。 */
export const CARVE_PROTECTED = new RegExp('(' + [
  '_ore$', '^ancient_debris$', '^raw_[a-z_]+$',
  '^chest$', '^trapped_chest$', '^barrel$', '^shulker_box$', '_shulker_box$',
  '^crafting_table$', '^furnace$', '^blast_furnace$', '^smoker$', '^enchanting_table$',
  '^anvil$', '^chipped_anvil$', '^damaged_anvil$', '_bed$', '^spawner$', '^trial_spawner$',
  '^vault$', '^beacon$', '^lectern$', '^brewing_stand$', '^cauldron$', '^hopper$',
  '^dispenser$', '^dropper$', '^respawn_anchor$', '^nether_portal$', '^end_portal',
  '_door$', '_trapdoor$', '_fence_gate$',
  /* 2026-10-23 用户实机（收小麦/挖矿乱挖）：麦田被"挖掉"的正是这条路（挖开挡路的台阶/天花板）。
   *   耕地和土径一旦被挖，整块田就废了，补不回原来那层。宁可卡住报 blockedAhead，也不替用户做这个决定。 */
  '^(farmland|dirt_path)$',
].join('|') + ')')
/**
 * 2026-10-18 审计 P1-1：走不到的时候，把"竖井里到底有什么"一次给全。
 *
 * 以前 `unreachable` 只有一句"没路"，AI 得自己一步步 `mc_observe` / `mc_map` 去摸：
 * 头顶是不是封死的、能不能跳、四面哪边通、背包里有没有能垫/能填的方块。
 * 一次摸一格，一轮叫醒就烧掉好几个工具调用 —— 而这些都是走路层**本来就能读到**的。
 *
 * 只读、不动手：给事实 + 一句建议，挖不挖、垫不垫仍由 AI 决定。
 * @returns {{headroom:number, ceiling:string|null, canJump:boolean,
 *            sides:{n:string|null,e:string|null,s:string|null,w:string|null},
 *            pillar:number, floor:string|null, hint:string}|null}
 */
export function shaftInfoOf (b, target) {
  try {
    const p = b?.entity?.position
    if (!p) return null
    const nameAt = (x, y, z) => {
      try { return b.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))?.name ?? null } catch { return null }
    }
    const solidAt = (x, y, z) => { const n = nameAt(x, y, z); return Boolean(n) && isSolidBlock(n) && !BRIDGE_FATAL.test(n) }
    const feetY = Math.floor(p.y)
    // 头顶净空：从脑袋上一格往上数，数到第一块实心为止（最多 6 格，够看出"能跳/堵死"）
    let headroom = 0
    let ceiling = null
    for (let y = feetY + 2; y <= feetY + 8; y++) {
      const n = nameAt(Math.floor(p.x), y, Math.floor(p.z))
      if (n != null && isSolidBlock(n)) { ceiling = n; break }
      headroom++
    }
    const dirs = [[0, -1, 'n'], [1, 0, 'e'], [0, 1, 's'], [-1, 0, 'w']]
    const sides = {}
    /* 🔴 2026-10-29 实机：`sides` 里“通”存的是**落脚地板名**、“堵”存的是**挡路块名**，
     *   两者都是字母串 ⇒ 下面用 `!/:/` 判“哪面通”永远为真（hint 一直说“四面都有路”，
     *   用户实机看到的“四面 n/e/s/w 全通”就是这么来的）。现在另存一个干净的 `openSides` 数组，
     *   `sides` 的值保持原样（它带着“哪面能站在什么上面”的信息）。 */
    const openKeys = []
    for (const [dx, dz, key] of dirs) {
      const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz
      const feet = nameAt(x, feetY, z), head = nameAt(x, feetY + 1, z), floor = nameAt(x, feetY - 1, z)
      const open = (!feet || isPassable(feet) || isLiquid(feet)) && (!head || isPassable(head) || isLiquid(head))
      /* 🔴 2026-10-29：以前“通”存的是地板名、“堵”存的是方块名，两者都是字母名 ⇒ 下面用 `!/:/`
       *   判“通”永远为真（hint 一直说“四面都有路”、cause 也拿不到地板名）。现在“通”就是 'open'。 */
      sides[key] = open ? (floor ?? 'air') : `${feet ?? '?'}`
      if (open) openKeys.push(key)
    }
    // 背包里"可以拿来垫/填"的便宜方块（只在提示里用；真垫不垫由 AI 决定）
    let pillar = 0
    try {
      for (const it of (b.inventory?.items?.() ?? [])) {
        if (/(dirt|cobblestone|cobbled_deepslate|netherrack|sand|gravel|stone|planks)/.test(it?.name ?? '')) pillar += Number(it?.count) || 0
      }
    } catch { /* 没有背包就是 0 */ }
    const floor = nameAt(Math.floor(p.x), feetY - 1, Math.floor(p.z))
    const openSides = openKeys.slice()
    const hint = headroom === 0
      ? `头上就是 **${ceiling ?? '实心'}**（y=${feetY + 2}）—— **跳不起来**，原地垫脚也不行。要么往 ${openSides.join('/') || '四面'} 挖出去，要么先挖开头顶那格。`
      : `头顶有 ${headroom} 格净空${ceiling ? `（再往上是 **${ceiling}**）` : '（上面没扫到实心）'} —— ${headroom >= 1 ? '能跳' : '只能贴地爬'}；四面 ${openSides.length ? openSides.join('/') + ' 有路' : '全堵着'}${pillar ? `；背包里有 ${pillar} 个能垫的方块` : '；背包里没有能垫的方块'}。`
    return { headroom, ceiling, canJump: headroom >= 1, sides, openSides, pillar, floor, hint }
  } catch { return null }
}

/**
 * 头顶上方是什么（用户 2026-10-23 实机：「move 后输出再加上方的方块……现在 ai 不知道移动后是什么状态。跳不起来。」）
 *
 * 为什么单独一个探针：`arrived`/`remaining` 只说"走到没走到"，不说"现在能不能往上"。
 * 跳上一格看的是**脚底上方第 2 格**（`feetY+2`）：头上只有 1 格净空时，人跳起来顶住天花板，
 * 一格都上不去 —— 可 AI 看到"到了"就以为能上，于是反复 `mc_move {mode:"jump"}`（用户实机就是这么卡的）。
 *
 * 返回字段尽量短（每次移动都跟着结果走）：
 *   `above`    脚底上方第 2 格（跳起来要占的那格）的方块名
 *   `headroom` 从第 2 格往上连续空的格数（最多数 6 格）
 *   `ceiling`  头顶第一块实心（有才给）
 *   `canJump`  能不能跳上一格（第 2 格空 **且** 头那格没被堵）
 *   `headBlocked` 头那格被什么堵着（有才给）
 *   `note`     不能跳时的一句话（能跳就不给，省 token）
 * 读不到世界就返回 `null`（不编）。
 */
export function aboveOf (b) {
  try {
    const p = b?.entity?.position
    if (!p) return null
    const fx = Math.floor(p.x)
    const fy = Math.floor(p.y)
    const fz = Math.floor(p.z)
    const nameAt = (y) => {
      try { return b.blockAt(new Vec3(fx, y, fz))?.name ?? null } catch { return null }
    }
    const head = nameAt(fy + 1)
    const above = nameAt(fy + 2)
    let headroom = 0
    let ceiling = null
    for (let y = fy + 2; y <= fy + 7; y++) {
      const n = nameAt(y)
      if (n != null && isSolidBlock(n)) { ceiling = n; break }
      headroom++
    }
    const headBlocked = head != null && isSolidBlock(head) && !isPassable(head) ? head : null
    const canJump = headroom >= 1 && !headBlocked
    return {
      above: above ?? '未加载',
      headroom,
      ...(ceiling ? { ceiling } : {}),
      canJump,
      ...(headBlocked ? { headBlocked } : {}),
      ...(canJump
        ? {}
        : {
            note: headBlocked
              ? "头那格（y=" + (fy + 1) + "）被 **" + headBlocked + "** 堵着 —— 现在**跳不起来**（连站直都费劲）：先挖开或者挪开一格。"
              : "脚底上方第 2 格（y=" + (fy + 2) + "）是 **" + (above ?? ceiling ?? "实心") + "** —— 现在**跳不起来**（只能原地蹦、上不了一格）；要往上就先挖开那一格。",
          }),
    }
  } catch { return null }
}

export const MOVE_CARVE_CELLS = 2       // 一次最多往前看几格
export const MOVE_CARVE_TRIES = 2       // 一次 walkPathfinder 里最多补挖几次
export const MOVE_CARVE_RESETS = 4      // 挖开挡路方块之后"阶梯清零重走"最多几次（防挖了又挖不认输）
/* 🔴 2026-10-31 用户：「move 应该能直接移动到任意地方」——
 *   原来写死 6 格：从 y=40 挖阶梯上到地表（差 30 层、要挖 60 格）永远到不了，
 *   每次调用挖够 6 格就弃。真正的限制本来就是**时间**（10 秒能挖多少算多少），
 *   这个数只当“方向明显搞错”的安全沐。 */
/* 垫柱连着失败几次就认账（place_error / place_jump_timeout / place_no_rise 都算）。
 *   2026-11-05 用户：「一直搭方块，一直没搭上，一直在跳」—— 以前没有上限，一跳就是整趟。 */
export const MOVE_PLACE_FAIL_MAX = 3   // mixed（挖头顶+垫）一趟最多清几格头顶 = 3 层
export const MOVE_CARVE_TOTAL = 24      // 一次 mc_move 里总共最多补挖几格（时间才是真限制）
/* ══ 执行顺序（2026-10-23 用户：「动不了，太容易卡了，你要加对应的执行顺序」）════════
 * 卡住之后**先试便宜的、能绕就不拆**，一级一级往下走；每级都写进日志和结果
 * （`planStep` / `planTried`），AI 和人都看得出"现在试到第几步、下一步该换什么"：
 *
 *   door        开门 / 穿门        几毫秒 —— 门是最高频的"假卡住"（关着的门在 A* 眼里是墙）
 *   repath      重算路径          零成本 —— 每轮本来就要重新 `goto`
 *   jump        跳跃脱困          320ms —— 头顶没净空就跳过（白蹦一次还会把自己顶住）
 *   backoff     后退半步再算       420ms —— 贴墙 / 贴角时换个起点
 *   breakAhead  挖开挡路那一格     每格 ≤3 秒（整趟最多 6 格）—— **允许挖时排第 3**：
 *                                 卡住多半就是 1 格台阶 A* 挖不动，直接挖比先退再绕快
 *   detour      侧向绕行 3 格再规划 1.6 秒 —— **不挖时排第 3**（能绕就别拆）：A* 是确定性的，
 *                                 同起点同终点同一套 Movements 只会给同一条路，原地重算等于没算
 *
 * 🔴 2026-10-23：`detour` 原本插在 `breakAhead` **之前**（用户抱怨"它往 z5 挖而不是 x 方向"
 *    —— 那正是"能绕却先拆"的后果；前三级沿用 2026-10-15 用户定的顺序，一个字没动）。
 * 🔴 2026-10-24（用户「和 move 默认不挖有关系吗」→「修一下」）：**拆成两套** —— 不挖时阶梯里
 *    没有 breakAhead（挖不了，试它纯空转 2.4 秒），所以"能绕就别拆"只对这套成立；
 *    允许挖时 breakAhead 提到 jump 之后（第 3 级），detour 退到它后面。两套见下方常量。
 * ⚠️ 跨调用也要接着升：同一个目标 90 秒内再叫，从上次卡住的那一级继续（`b._movePlan`），
 *    否则每次 `mc_move` 都从第 1 级重来 —— AI 连叫五次就白试五遍同一套。
 */
/* 🔴 2026-10-30 move 全量审计：「执行顺序」在这里曾经有**第二份表**（`MOVE_PLAN` /
 *    `MOVE_PLAN_NODIG`，10 项，多出 `door`/`tower`）。它只被 `walkPathfinder` 的日志拿去算
 *    `indexOf(step)`，而 `step` 来自**真正在跑的那套**（`MOVE_ESCAPES_*`，7 项）⇒
 *    `clearHead` 报成"第 7/10 步"、`breakAhead` 报成"第 6/10"，跟 AI 看到的实际进度对不上。
 *
 *    现在**只有一份**：`escapeStepsFor(allowDig)` 给集合、`orderEscapesFor()` 按诊断换顺序，
 *    日志一律用同一个 `steps` 数组算级号。要加一级就加到 `MOVE_ESCAPES_*` 里（并补
 *    `MOVE_STEP_WAIT_MS` 与 `MOVE_PLAN_TEXT`），别再另开一张表。 */
/* 🔴 2026-11-02 审计（#27）：这里原来还有 `door`（开门/穿门）和 `tower`（垫一格往上）两项，
 *   可执行阶梯（`MOVE_ESCAPES_DIG` / `MOVE_ESCAPES_NODIG`）里**没有**这两招 ——
 *   门归 `patchDoorMoves` 管、垫柱只认显式 `allowTower:true`。留着它们只会让
 *   `planStepTextOf` 看起来支持这两级，测试也跟着钉了个永远跑不到的字符串。已删。 */
export const MOVE_PLAN_TEXT = {
  repath: '重算路径',
  jump: '跳跃脱困',
  clearHead: '清掉自己头顶那格',
  backoff: '后退再寻路',
  detour: '侧向绕行',
  descend: '往下挖一层（或往下跳）',
  climbUp: '往上挖一层再跳',
  breakAhead: '挖开挡路那格再走',
}
/** 执行顺序里某一级的中文名（日志 / 返回值文案用）。 */
export function planStepTextOf (name) { return MOVE_PLAN_TEXT[name] ?? String(name ?? '') }

export const MOVE_DETOUR_R = 3          // 侧向绕行偏离直线几格
export const MOVE_DETOUR_MS = 1_600     // 单次绕行最多走多久
/* 脱困阶梯的预算余量：剩这么点时间就别再升一级了（一级最坏要 3.5 秒 vendor stuck + 动作）。 */
export const MOVE_ESCALATE_MIN_MS = 600
/* ── 2026-10-30 用户：「move 中加实体避让」 ──────────────────────────────────────
 *    vendor 只在**规划那一刻**看实体（`mv.entityCost = 8` 已设，A* 会主动绕开），
 *    路径定下来之后实体再走过来，执行层原本完全不管 —— 人就顶着怪/顶着牛走，
 *    直到采样器判卡（2.4 秒）再进脱困阶梯。这四个数是执行期避让的尺度：
 *    · 看多远（cells 沿主轴几格 / radius 侧向几格）
 *    · 等多久（被动的等它自己走开；超了就如实报，不无限磨）
 *    · 多久扫一次（走的过程中） */
export const MOVE_ENTITY_CELLS = 2
export const MOVE_ENTITY_RADIUS = 1.2
export const MOVE_ENTITY_WAIT_MS = 900
export const MOVE_ENTITY_PROBE_MS = 350
/* 🔴 2026-10-31：“目标被重设”这类良性打断最多原地续跑这么多次（不占 autoRepath 额度）。 */
export const MOVE_KICK_MAX = 40
/* 🔴 2026-10-27（用户：「移动老是卡在半空，脚踩实地又杵着不动」）：
 *   vendor 的 `goto` 会在**任何**一次 `resetPath` 上 reject —— `resetPath()` 里
 *   `if (stopPathing) return stop()`，而 goto 期间 `stopPathing` 恒为 true，`stop()` 又先把
 *   `stateGoal` 清成 null、再 emit `path_stop` ⇒ goto 以 `PathStopped` 拒绝，人立刻站住。
 *   而 `resetPath` 在长路上**每跨一个区块**（`chunk_loaded`）、脚下方块一变（`block_updated`）
 *   都会发生 —— 于是"路好端端的、已经走了 30 格"也被判成"寻路被打断"直接收工。
 *   现在：这类可恢复的中断自动重发同一个 goal 接着走，上限见下（预算仍是硬边界）。
 *   同时 vendor 侧打了补丁：`chunk_loaded` / `block_updated` / `movements_updated` 三类
 *   在 goto 期间只清路径、**不再**把整次 goto 掐死（见 vendor 的 `RESUMABLE_RESETS`）。 */
export const MOVE_AUTOREPATH_MAX = 12
/** 连续这么多次自动重发都没靠近就认账，交回脱困阶梯（别把预算耗在同一处空转）。 */
export const MOVE_AUTOREPATH_STALL = 3
export const MOVE_PLAN_TTL_MS = 90_000  // "同一目标上次卡在第几步"记多久
export const MOVE_PLAN_SAME_R = 3       // 目标挪动小于这个距离才算"同一个目标"

/** 第 `n` 级脱困动作（0 起）；超出阶梯返回 `null`（= 该认输了）。 */
/**
 * 用户 2026-10-29（原话：「把 mc_move 的输出单独做一次精简……默认只返回移动结果、当前位置、
 * 目标距离和下一步建议；只有移动失败或卡住时，才输出诊断信息」）：
 * `mc_move` 只给模型**三种固定形态** —— `progress` / `arrived` / `blocked`。
 * 原来一次返回十几到几十个字段（`roadInfo` / `moveInfo` / `fellInfo` / `dugBlocks` / `shaft` /
 * `briefBlocks` …）外加一段反复劝的长 `hint`：模型每走一步都要读一遍寻路过程，代价大、还互相矛盾。
 * **字段一个都不删，全部进本地日志**（调用点 `ctx.logger.info`），排查时照样能看。
 */
/** 「时间用完」类原因：**不是走不通**，再叫一次就接着走（`briefMoveOf` 判 `stuck` 用）。 */
export const MOVE_TIME_REASONS = new Set(['timeout', 'budget', 'swim-budget', 'preempted', 'call-over'])

/** 从 `walkTo` 的 `hint` 里取出"该做什么"那半句。
 *  🔴 2026-11-02 审计：`adviceFor()`（本文件 `:5318`）是**唯一**在讲"下一步该做什么"的判据
 *  （"别挖树" / "别原地重试了" / "挖穿挡路方块过来的" / "换个方向绕" 都在那里），但它只拼进了
 *  `hint`，而 `mc_move` 的出口 `briefMoveOf` 走的是另一份白名单 + `moveNextTextOf` 自己再推一遍
 *  ⇒ 那些修复一句都没到过模型。现在 `next` 优先用这里的结论，`moveNextTextOf` 退成兜底。 */
export function adviceTextOf (o) {
  const s = String((o && o.hint) || '')
  /* adviceFor 的每一句都以 `—— ` 开头，紧跟在 "（从 X 格变成 Y 格…）" 之后；
   * 前面还可能挂着 `escNote`（里面也有 `—— `），所以必须先定位那个括号。 */
  const p = s.indexOf('（从 ')
  let i = p >= 0 ? s.indexOf('—— ', p) : -1
  if (i < 0) i = s.indexOf('—— ')
  if (i < 0) return ''
  const t = s.slice(i + 3).trim()
  return t.length > 400 ? t.slice(0, 399) + '…' : t
}

export function briefMoveOf (out, pos = null) {
  const o = (out && typeof out === 'object' && !Array.isArray(out)) ? out : {}
  const p = pos ?? o.position ?? null
  const at = p && Number.isFinite(Number(p.x))
    ? { x: Math.floor(Number(p.x)), y: Math.floor(Number(p.y)), z: Math.floor(Number(p.z)) }
    : null
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  const moved = num(o.moved)
  const remaining = num(o.remaining)
  const extra = {}
  if (o.goalAdjusted) extra.goalAdjusted = o.goalAdjusted
  if (num(o.dug) > 0) extra.dug = num(o.dug)
  /* 2026-11-02 用户：「只用 allowDig 上地表，它会乱挖」—— 挖了几格 / 往上爬了几格必须报出来，
   *  否则"乱挖"和"正常向上挖"在结果里长得一模一样。 */
  if (num(o.carved) > 0) extra.carved = num(o.carved)
  if (num(o.climbedUp) > 0) extra.climbedUp = num(o.climbedUp)
  if (num(o.pillared) > 0) extra.pillared = num(o.pillared)
  if (o.tooHard) extra.tooHard = o.tooHard
  /* 2026-11-03：被打断时点名「是谁领走了号」（walk:* / dig / collect / swim / fly / lava）。 */
  if (o.takenBy) extra.takenBy = String(o.takenBy)
  /* 2026-11-02：`escNote` 那句"还剩哪几级没试"原来只在 hint 里（到不了模型）⇒ 结构化给出。 */
  if (Array.isArray(o.escapesLeft) && o.escapesLeft.length) extra.escapesLeft = o.escapesLeft
  if (o.arrived === true) {
    return { status: 'arrived', ...(at ? { position: at } : {}), remaining: 0, ...extra }
  }
  const reason = String(o.reason ?? '')
  /* 🔴 2026-11-02 审计：这里以前**自己又推了一遍** `stuck`（"reason 不是 timeout/swim-budget 就算卡住"），
   *   把 `walkPathfinder` 费力分好的"时间到 / 真卡住"推翻 —— `budget` 不在豁免名单里，
   *   于是同一条结果 `status:'blocked'` 配文案"时间到了，直接再叫一次接着走"，自相矛盾。
   *   现在：结果里带 `stuck` 就**只认它**（`walkPathfinder` 已经算好并透传）；
   *   没有 `stuck` 字段的（flyTo / `withOutcome` 包装的那种）才退回按 reason 粗判，且豁免"时间类"。 */
  const stuck = typeof o.stuck === 'boolean'
    ? o.stuck
    : (reason !== '' && !MOVE_TIME_REASONS.has(reason))
  return {
    status: stuck ? 'blocked' : 'progress',
    ...(at ? { position: at } : {}),
    moved: moved === null ? 0 : Math.round(moved * 10) / 10,
    remaining: remaining === null ? null : Math.round(remaining * 10) / 10,
    ...(stuck ? { reason, cause: moveCauseTextOf(o) } : {}),
    next: adviceTextOf(o) || moveNextTextOf(o, stuck),
    ...extra,
  }
}

/** 一句话说清「卡在哪」——只按 `briefMoveOf` 拿到的真字段讲，不猜。 */
export function moveCauseTextOf (o) {
  const at = (c) => (c && Number.isFinite(Number(c.x)) ? `${Math.floor(c.x)},${Math.floor(c.y)},${Math.floor(c.z)}` : '')
  if (o.fell) return `从 y=${Math.round(Number(o.fell.from?.y ?? 0))} 掉到 y=${Math.round(Number(o.fell.to?.y ?? 0))}`
  if (o.dead) return '死了（血是 0），正在重生'
  const a = o.airborne
  if (a && a.still === true) return `挂在半空不动（离地 ${Math.abs(Number(a.dy ?? 0))} 格）`
  if (o.blockedAhead) {
    const cell = o.blockedAhead.cell === 'head' ? '头顶' : '脚下'
    /* 🔴 2026-11-03：`head` + `headroom:0` 的语义是"头顶那格堵着、挖开就能踩上去"，
     *   与脚层那格的"没有两格高"不是一回事 —— 一句话两种意思，模型会照着挖错格子。 */
    const tailNote = o.blockedAhead.headroom === 0
      ? (o.blockedAhead.cell === 'head' ? '（挖开它，踩上下面的台阶就能上去）' : '（没有两格高）')
      : ''
    return `前方 ${at(o.blockedAhead)} 的${cell}是 ${String(o.blockedAhead.name ?? '方块')}${tailNote}`
  }
  if (o.stepUp?.why) return `一格台阶上不去（${String(o.stepUp.why)}）`
  /* 🔴 2026-10-29 实机：这句打印出来是「困在竖井里（井口 ）」—— `shaftInfoOf` 回的是
   *   `{headroom, ceiling, sides, pillar, floor, hint}`，**根本没有 x/y/z**，`at()` 读不到坐标就是空字符串。
   *   现在按真字段说清楚：头上是什么、哪面通、背包里有没有能垫的。 */
  if (o.shaft) {
    const sh = o.shaft
    const openS = Array.isArray(sh.openSides) ? sh.openSides : []
    const head = sh.headroom === 0
      ? `头上就是 ${sh.ceiling ?? '实心'}（跳不起来）`
      : `头顶 ${sh.headroom} 格开阔`
    /* 🔴 2026-10-29 实机（用户：「是在树冠上，没有被包围」）：
     *   旧文案写“困在竖井里（头顶 7 格净空；只有 n/e/s/w 那面通）”——
     *   头顶开阔、只有一面通，根本不是竖井；而且“n/e/s/w”把“到底哪面、挡着的是什么”全省了，
     *   模型只能去猜。现在只报事实：四周是什么方块、哪面通、头上多高。 */
    const blocked = Object.keys(sh.sides ?? {}).filter((k) => !openS.includes(k))
    const wallNames = [...new Set(blocked.map((k) => String(sh.sides?.[k] ?? '')).filter((n) => n && n !== '?'))]
    const leafWall = wallNames.some((n) => isLeafBlock(n))
    /* 🔴 2026-10-30 实机（目标 (16,63,88)）：四面 n/e/s/w 全是空气，还报“四周全是实心方块”并附上“四面都通”——
     *   自相矛盾。`wallNames` 只统计被挡的那几面，全通时它就是空的，不能当“全实心”用。 */
    const what = wallNames.length
      ? `四周是 ${wallNames.join('/')}`
      : (openS.length ? '四周没有挡路的方块' : '四周全是实心方块（读不到方块名）')
    return `${what}（${head}；${openS.length ? `${openS.join('/')} 那面通` : '四面都不通'}）`
      + `${leafWall ? '——树叶 0.2 秒就能挖掉，挖开就能过去' : ''}`
      + `${Number(sh.pillar) > 0 ? `；背包里有 ${sh.pillar} 个能垫的方块` : ''}`
  }
  const r = String(o.reason ?? '')
  if (r === 'NoPath') return '没有能走通的路'
  if (r === 'goal-not-standable') return '目标那格站不住人'
  if (r === 'goal-reached-elsewhere' || r === 'goal_reached-but-far') return '走到了目标旁边但不够近'
  if (r === 'lava') return '前面是岩浆，过不去'
  if (r === 'waiting_chunks') return '前面的区块还没加载'
  if (r === 'walk-hung') {
    /* 🔴 2026-11-05 用户实机：「报了这个错，但是我看着它还在正常挖」—— 挖了 12 格、升了 5 格，
     *   却被一句“走不动：时间用在挖方块上了”打发。有进展就明说“还在挖、接着叫”。 */
    const cv = Number(o?.carved ?? 0)
    const cl = Number(o?.climbedUp ?? 0)
    if (cv > 0 || cl > 0) {
      return '这趟时间到了，但一直在往上挖（挖了 ' + cv + ' 格' + (cl > 0 ? '、升了 ' + cl + ' 格' : '') + '）'
    }
    return '这趟的时间用在挖方块上了（挖开挡路的很花时间；也可能服务端没回包）'
  }
  if (r === 'timeout') return '这一轮的走路时间用完了'
  if (r === 'stuck') return '原地走不动'
  /* 🔴 2026-10-31 用户实机：只回一句「走不动：preempted」—— 把内部事件名当成了给模型看的原因。
   *     `preempted` = 另一次移动（自动上浮 / 另一个工具 / 上一趟残留）抢走了控制位，**不是路不通**。 */
  if (r === 'preempted') return '被别的动作打断了（不是走不通）'
  /* 🔴 2026-10-31 用户实机：「现在一直 mc_say · path-reset」—— 又一个内部码裸奔到模型面前，
   *    模型只好一遍遍把它念出去。`path-reset`/`PathStopped` = 路线中途作废（方块变了/目标被改），
   *    不是路不通。 */
  if (r === 'path-reset' || r === 'PathStopped') {
    /* 🔴 2026-10-31 用户：「这个为什么去不了」—— 只说“路线作废”等于没说。
     *   把 `pathResetReasons`（每次作废是**谁**触发的）翻成人话报前两位：
     *   垫方块被拒 / 挖的时候出错 / 手上没方块 / 原地卡住 …… 模型才知道该换目标还是先补材料。 */
    const NAMED = {
      place_error: '垫方块被服务端拒了', place_jump_timeout: '垫方块卡在半空',
      equip_error: '换工具失败', dig_error: '挖的时候出错', dig_equip_error: '挖之前换工具失败',
      dig_timeout: '挖那块超时', use_block_error: '开门/按钮出错',
      no_scaffolding_blocks: '手上没有能垫的方块', stuck: '原地卡住',
      goal_moved: '目标动了', block_updated: '路过的方块变了', chunk_loaded: '区块刚加载',
      goal_updated: '目标被重设了（有别的动作在抢寻路）', movements_updated: '寻路参数被改了一次',
    }
    const rs = o?.pathResetReasons && typeof o.pathResetReasons === 'object' ? o.pathResetReasons : null
    const top = rs ? Object.entries(rs).sort((a, b) => b[1] - a[1]).slice(0, 2) : []
    const whyText = top.length
      ? '：' + top.map(([k, n]) => `${NAMED[k] ?? k} ${n} 次`).join('、')
      : (o?.lastReset ? `：${NAMED[o.lastReset] ?? o.lastReset}` : '')
    return `路线中途作废了${whyText}，重算过几次还是没走到`
  }
  if (r === 'block-changed') return '路被方块变动打断了（不是走不通）'
  if (r === 'budget' || r === 'swim-budget') return '这一轮的时间用完了'
  if (r === 'unreachable') return '那片地方进不去'
  if (r === 'progress') return '还在路上'
  /* 兜底：**不许把内部码直接给模型看**（原始值留在结果的 `reason` 里给排查用）。 */
  return '这一步没走到'
}

/** 一句话说下一步该怎么办。 */
export function moveNextTextOf (o, stuck) {
  if (!stuck) return '继续往同一目标走（再叫一次 mc_move 就行）'
  const r = String(o.reason ?? '')
  /* 被抢占不是走不通：人还在半路，直接再叫一次就接着走（旧文案说“换个目标点”，方向全错）。 */
  if (r === 'preempted') return '直接再叫一次 mc_move 接着走（被抢占不算走不通）；若反复被抢，先看是不是 mc_auto 的自动动作在抢'
  if (o.fell) return `先爬回 y=${Math.round(Number(o.fell.from?.y ?? 0))} 那一层，别在边缘垫方块`
  if (o.dead) return '等复活站回地面再叫 mc_move——这趟不算“走不通”'
  if (o.airborne && o.airborne.still === true) return '先落到实地再走，别原地跳'
  if (o.blockedAhead) {
    /* 🔴 2026-10-31：前方是沟/缺口时，“挖开挡路那格”是错的建议（沟挖不出路）。 */
    if (o.terrain === 'gap') return '前方是沟/缺口（挖不出路来）—— 要横着垫过去就带 allowBridge:true 再叫一次，或者换个能绕过去的目标点'
    return '挖开挡路那格，或换个目标点'
  }
  /* 🔴 2026-10-30 实机（柱顶：周围 6 格半径 143 格全是“会掉下去”）：
   *   四面都没挡路的方块，但也没有能落脚的路 —— 这种地形只有“横着垫”才有路。
   *   旧分支会说“往 n/e/s/w 那面挖过去”（那几面根本没挡路的东西），方向全错。 */
  if (o.terrain === 'gap') return '脚下和四周是深坑/断口（不是挡路的方块）—— 要过去就带 allowBridge:true 横着垫过去，或换个脚下有地面的目标'
  /* 竖井：不能只说“换个目标点”—— `shaftInfoOf` 已经量出了哪面通、头上是什么，
   *   按它说就行（用户 2026-10-29 实机：只报“困在竖井里”没给路，AI 只能瞎试）。 */
  if (o.shaft) {
    const sh = o.shaft
    const openS = Array.isArray(sh.openSides) ? sh.openSides : []
    if (sh.headroom === 0) return `先挖开头顶那格（${sh.ceiling ?? '实心'}）—— 头顶不通跳不起来。用 \`mc_dig\` 指定脚上第二格，或先 mc_observe 看一眼`
    /* 🔴 2026-10-30 实机：四面 n/e/s/w 全通，旧文案却说“往 n/e/s/w 那面挖过去（只有那面通）—— allowDig:true 再试”
     *   —— 四面都通还说“只有”，那几面也没挡路的方块（挖什么？），而且那话本来就是 allowDig:false。 */
    if (openS.length >= 4) {
      return '四面都没有挡路的方块，但也没有能落脚的路（前面是深坑或断口）'
        + ' —— 要过去就带 allowBridge:true 横着垫过去，或把目标换成脚下有地面的格子'
        + `${Number(sh.pillar) > 0 ? `（背包里 ${sh.pillar} 个方块能垫）` : ''}`
    }
    if (openS.length) return `往 ${openS.join('/')} 那面挖过去（其余几面堵着）—— allowDig:true 再试,或先 mc_dig 开一道口`
    return Number(sh.pillar) > 0
      ? '四面全堵着：拿背包里的方块往上垫（pillar），或挖开一面'
      : '四面全堵着且背包里没能垫的方块：只能挖开一面出去'
  }
  if (o.stepUp?.why === 'no-headroom') return '先挖开头顶那格再走'
  if (r === 'NoPath') return '允许挖过去（allowDig:true）或改走别处'
  if (r === 'waiting_chunks') return '等区块加载后再叫一次'
  if (r === 'lava') return '绕开岩浆'
  if (r === 'goal-not-standable') return '换一个能站的落点'
  if (r === 'path-reset' || r === 'PathStopped' || r === 'block-changed') {
    return '直接再叫一次 mc_move 接着走（路线被作废不算走不通）；反复作废就换个明显好走的目标点'
  }
  if (r === 'budget' || r === 'swim-budget') return '时间到了，直接再叫一次接着走'
  if (r === 'unreachable') return '那片区域进不去，换个目标点'
  /* 空手挖石头 7.5 秒：不是走不通，是这轮时间不够挖完一块。 */
  if (Array.isArray(o.planTried) && o.planTried.includes('tooSlow')) {
    return '挖一块要好几秒（空手挖石头 7.5 秒）—— 这轮时间被它吃掉了，直接再叫一次 mc_move 接着挖，别换目标'
  }
  if (Array.isArray(o.planTried) && o.planTried.includes('breakAhead')) return '挖也没用，换路线或换落点'
  return '直接再叫一次 mc_move 接着走；还不行就换个明显好走的目标点'
}

/** `mc_move` 给模型看的那一行（与 `briefMoveOf` 配套，永远一句话）。 */
export function briefMoveTextOf (b0) {
  const b = b0 ?? {}
  const w = b.position ? `${b.position.x},${b.position.y},${b.position.z}` : '原地'
  if (b.status === 'arrived') return `✅ 到了 ${w}`
  if (b.status === 'progress') return `🚶 走到 ${w}：这次挪了 ${b.moved ?? 0} 格，还差 ${b.remaining ?? '?'} 格。${b.next ?? ''}`
  return `⛔ 走不动：${b.cause ?? '卡住'}。${b.next ?? ''}`
}

export function escapeStepOf (n, steps = MOVE_ESCAPES_NODIG) { return steps[n] ?? null }

/** 脱困动作的中文名（日志 / 返回值文案用）。 */
export function escapeTextOf (step) {
  return step === 'repath' ? '重算路径'
    : step === 'jump' ? '跳跃脱困'
      : step === 'backoff' ? '后退再寻路'
        : step === 'detour' ? '侧向绕行再算'
          : step === 'descend' ? '往下挖一层（或往下跳）'
          : step === 'climbUp' ? '往上挖一层再跳'
          : step === 'breakAhead' ? '挖开挡路那格再走'
          : '放弃'
}

/**
 * 眼前有没有"挡路的、能挖的、挖了不会掉下去"的那一格。（Bug 4：卡住该不该试挖，
 * 看的是**眼前障碍**，不是"离终点还有几格"。）
 *
 * 判据与 `carveStepAhead` 完全一致（同方向、同保护名单、同"底下要有支撑"），
 * 所以它说"有"就一定能挖；返回 `null` 表示"没有可下手的障碍"。
 * @returns {null | {x:number,y:number,z:number,name:string,cell:'feet'|'head',headroom:number}}
 */
export function obstacleAheadOf (b, target, { cells = MOVE_CARVE_CELLS } = {}) {
  const me = b?.entity?.position
  if (!me || !target) return null
  const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
  const dx = Number(target.x) - me.x, dz = Number(target.z) - me.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const nameOf = (blk) => { try { return blk?.name ?? null } catch { return null } }
  const solid = (n) => Boolean(n) && isSolidBlock(n)
  /* 🔴 2026-11-02 审计（#22）：这是 `carveStepAhead` 里那份 `diggable` 的**过期副本** ——
   *   那边早加了两条（`diggableBlock()` 统一判据 + 树不挖），这里还停在手抄的黑名单上，于是：
   *   ① 树叶/原木照样算"可挖障碍" ⇒ 卡在树下时会去挖树（用户明令不砍树）；
   *   ② 更要命的是"一棵树把整趟挖穿封顶" —— 一旦返回的是树，`carveStepAhead` 挖不动就
   *      `carveTries = MOVE_CARVE_TRIES` 直接封顶，**后面真有石头也不挖了**，整趟白跑。
   *   跳过一个不挖的格子、继续往后看才是对的（下面的循环天然会 `d++` 继续）。 */
  const diggable = (blk) => {
    const n = nameOf(blk)
    if (diggableBlock(blk) === false) return false
    if (isTreeLog(n) || isTreeBlock(n)) return false
    if (!solid(n) || BRIDGE_FATAL.test(n) || isLiquid(n) || CARVE_PROTECTED.test(n)) return false
    return !/^(bedrock|barrier|command_block|chain_command_block|repeating_command_block|obsidian|end_portal_frame)$/.test(n)
  }
  const sx = Math.sign(dx), sz = Math.sign(dz)
  /* 🔴 2026-10-23 实机（用户："它往 z5 挖而不是 x方向"）：方向**只认主轴**（离得远的那个轴），
   *    不再看"另一条轴"。副轴正侧方永远不是通往目标的方向 —— 那是隧道的侧墙，挖它只会
   *    把 1 格宽的洞越挖越宽、越挖越乱（实机连挖几十格还是没过去，人却还在原地）。
   *    斜拐时真挡路的在**对角**（2026-10-19 实机），对角保留，但只在"主轴前方 cells 格全通
   *    （前方没堵，只是斜着拐）"时才看它 —— 主轴自己堵着就别绕到斜的上去。 */
  const main = Math.abs(dx) >= Math.abs(dz) ? [sx, 0] : [0, sz]
  const dirs = []
  if (main[0] || main[1]) dirs.push(main)
  let mainClear = true
  if (main[0] || main[1]) {
    for (let d = 1; d <= cells; d++) {
      const mx = fx + main[0] * d, mz = fz + main[1] * d
      const fn = nameOf(at(mx, fy, mz)), hn = nameOf(at(mx, fy + 1, mz))
      if (!fn || !hn || isSolidBlock(fn) || isSolidBlock(hn)) { mainClear = false; break }
    }
  }
  /* 2026-10-19 实机（"1 格宽巷道会卡，break 前面那格就过去"）：斜着拐弯时挡路的
   * 既不在正前也不在正侧，而在对角那一格 —— 两条轴都走不通时再看一眼对角线。 */
  if (sx && sz && mainClear) dirs.push([sx, sz])
  for (const [ddx, ddz] of dirs) {
    for (let d = 1; d <= cells; d++) {
      const x = fx + ddx * d, z = fz + ddz * d
      if (x === fx && z === fz) continue
      const feetN = nameOf(at(x, fy, z))
      const headN = nameOf(at(x, fy + 1, z))
      const floorN = nameOf(at(x, fy - 1, z))
      if (!floorN || !solid(floorN) || BRIDGE_FATAL.test(floorN) || isLiquid(floorN)) continue
      const headroom = solid(headN) ? 0 : 1
      /* 🔴 2026-11-03（同上）：头层实心、再上面一格是空 ⇒ 这是"一格台阶 + 站上去顶头"，
       *   该挖的是**头层那格**；先报脚下那格会把台阶本身挖掉（楼梯削平、人还是进不去）。 */
      if (solid(headN) && diggable(at(x, fy + 1, z)) && !solid(nameOf(at(x, fy + 2, z)))) {
        return { x, y: fy + 1, z, name: headN, cell: 'head', headroom }
      }
      if (solid(feetN) && diggable(at(x, fy, z))) return { x, y: fy, z, name: feetN, cell: 'feet', headroom }
      if (solid(headN) && diggable(at(x, fy + 1, z))) return { x, y: fy + 1, z, name: headN, cell: 'head', headroom }
    }
  }
  return null
}

/**
 * 窄隧道/台阶的"手工补救"：朝目标方向挖掉挡在**脚上**或**头顶**的那一格实心方块。
 *
 * 背景见 `MOVE_CARVE_RADIUS` 的注释（实机：1×2 窄道里的 1 格台阶，A* 上不去）。
 * 只做**最保守**的那一件：
 *   - 只朝目标方向（主轴优先，再看另一条轴）看 `MOVE_CARVE_CELLS` 格；
 *   - 只挖"脚下这一层或头顶那一层"的实心块，且要求**底下（y-1）有支撑**（不然挖完是往坑里走）；
 *   - 岩浆/火/水/细雪/仙人掌/黑曜石/基岩/命令方块**一概不碰**；
 *   - 永不挖自己站的那一格。
 *
 * 返回挖了几格（0 = 没得挖 / 不该挖）。**只挖不改走路** —— 挖完由调用方重跑同一个 `goto`。
 */
/**
 * 挖一格：先换对的工具，再挖；两个动作都设上限（`digMs`），到点 `stopDigging()` 松手。
 * `carveStepAhead` 与脱困阶梯的 `clearHead` 共用（2026-10-28 抽出来）。
 * @returns {Promise<boolean>} 真挖开了吗
 */
export async function digOneGuarded (b, blk, { digMs = MOVE_CARVE_DIG_MS } = {}) {
  /* 🔴 2026-10-30（B）：我们绕过 pathfinder 自己挖的，先登记给 vendor —— 否则那一格的变化
   *    会触发 blockUpdate ⇒ resetPath('block_updated') ⇒ 整条路白走。 */
  try { b?.pathfinder?.markExpected?.(blk?.position) } catch { /* vendor 没这接口就跳过 */ }
  /* 🔴 2026-10-31 用户实机：`{budgetMs:8000, digThrough:true, noDig:false, x:-29,y:50,z:75}`（旧字段名，现 `allowDig:true`）
   *    回“前方 -31,50,90 的脚下是 stone（没有两格高）”—— 说好的允许挖，结果一格没挖。
   *    真因：单格挖掘守卫写死 3000ms，而**空手挖石头要 7.5 秒** ⇒ 每一下都在 3 秒被掀断、
   *    进度归零，永远挖不开。现在按**实测挖掘时间 + 1.2 秒余量**给上限。 */
  /* 测不出掘时间（旧数据 / 假 bot / 无硬度）就不放大 —— 保持传入的下限。 */
  const ms0 = Number(breakMsNow(b, blk))
  const needMs = Number.isFinite(ms0) && ms0 > 0 ? ms0 + 1_200 : 0
  const guardMs = Math.max(Number(digMs) || 0, needMs)
  const guarded = async (p) => {
    const TO = Symbol('timeout')
    const r = await Promise.race([
      Promise.resolve(p).then(() => true, () => false),
      sleep(guardMs).then(() => TO),
    ])
    if (r !== TO) return r
    try { b.stopDigging?.() } catch {}
    try { b.__carveDigStalled = (Number(b.__carveDigStalled) || 0) + 1 } catch {}
    /* 被守卫掀断而且确实是“这块要很久”：记下来，文案里能说出具体秒数 */
    try { b.__carveTooSlow = { name: String(blk?.name ?? '?'), needMs: Math.round(needMs) } } catch {}
    return false
  }
  try {
    const tool = typeof b.pathfinder?.bestHarvestTool === 'function' ? b.pathfinder.bestHarvestTool(blk) : null
    if (tool && typeof b.equip === 'function') await guarded(b.equip(tool, 'hand'))
    return await guarded(b.dig(blk, true)) === true
  } catch { return false }
}

/**
 * 清掉**自己头顶上方**的方块（脱困阶梯 `clearHead` 用；不挖那趟的唯一例外）。
 * 只碰正上方、必须是实心可挖、不在 `CARVE_PROTECTED`、不是树。
 *
 * 🔴 2026-10-28（用户：「move 在上面的时候自动挖不行吗」）：以前只清 `y+1`。
 *    实测（session-514c21b6 02:57:34）：`allowTower:true` 垫了 6 根柱子上去，落点
 *    `shaft:{headroom:1, ceiling:'stone', sides:{n/s/e/w:'stone'}}` —— 四面石头、
 *    **y+1 是空气、y+2 才是石头**，于是 `y+1` 挖了白挖，人还是上不去。
 *    现在按层数清：`y+1`…`y+levels`。
 * @returns {Promise<number>} 挖掉几格
 */
export async function clearHeadCell (b, { digMs = MOVE_CARVE_DIG_MS, levels = 2 } = {}) {
  try {
    const p = b?.entity?.position
    if (!p) return 0
    const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z)
    let dug = 0
    for (let i = 1; i <= Math.max(1, levels); i++) {
      const blk = (() => { try { return b.blockAt(new Vec3(px, py + i, pz)) } catch { return null } })()
      /* 注意：`nameOf` 是 `carveStepAhead` 等函数内部的局部 helper，模块级取不到
       *    （用它会 ReferenceError，被 catch 吞掉 ⇒ 静默返回 0，2026-10-28 踩过）。 */
      const n = (() => { try { return blk?.name ?? null } catch { return null } })()
      if (!n || !isSolidBlock(n)) continue
      if (!diggableBlock(blk) || isTreeLog(n) || CARVE_PROTECTED.test(n)) continue
      if (await digOneGuarded(b, blk, { digMs })) dug++
    }
    return dug
  } catch { return 0 }
}

/* 🌉 自动搭路（2026-10-29 用户：「allowBridge 是新功能，允许自动搭路。和之前的没关系」）
 *
 * A* 只会走"现成的地面"：遇到悬崖、沟、断桥，它直接报 NoPath。挖也挖不过去（对面没东西
 * 可挖）时，唯一的出路就是**自己铺一条路**。`mc_act{mode:"bridge"}` 早就有这套（`src/bridge.mjs`
 * 负责安全判定：悬空/区块没加载/血量<8 停、岩浆深空只警告），这里只是把它接进走路。
 *
 * 只走直线（`bridge.mjs` 的规矩：斜着铺每一步都够不着依附面）；铺完之后桥面就成了真地形，
 * 下一轮 A* 立刻能用。 */
export const MOVE_BRIDGE_TRIES = 3
export const MOVE_BRIDGE_STEPS = 4
export const MOVE_BRIDGE_MIN_HEALTH = 8

export async function bridgeToward (self, b, target, { maxSteps = MOVE_BRIDGE_STEPS } = {}) {
  if (typeof b?.bridge !== 'function') return { ok: false, why: 'unavailable' }
  const p = b?.entity?.position
  if (!p) return { ok: false, why: 'no-entity' }
  const fx = Math.floor(p.x); const fz = Math.floor(p.z)
  const tx = Math.floor(Number(target?.x)); const tz = Math.floor(Number(target?.z))
  if (!Number.isFinite(tx) || !Number.isFinite(tz)) return { ok: false, why: 'bad-target' }
  const dx = tx - fx; const dz = tz - fz
  /* 斜的目标：先走下去，走到同一行/列再来搭 —— 硬铺会每格都够不着依附面。 */
  if (dx && dz) return { ok: false, why: 'not-straight' }
  const span = Math.abs(dx) + Math.abs(dz)
  if (span < 1) return { ok: false, why: 'too-close' }
  const n = Math.min(Math.max(1, Math.floor(maxSteps) || 1), span)
  const dir = { dx: Math.sign(dx), dz: Math.sign(dz) }
  const dirName = dx ? (dx > 0 ? '东(+x)' : '西(-x)') : (dz > 0 ? '南(+z)' : '北(-z)')
  let r = null
  try {
    r = await b.bridge({ dir, count: n, minHealth: MOVE_BRIDGE_MIN_HEALTH })
  } catch (e) {
    return { ok: false, why: 'error', note: String(e?.message ?? e), dirName }
  }
  const placed = Number(r?.placed ?? r?.count ?? 0)
  return {
    ok: r?.ok !== false && placed > 0,
    placed,
    n,
    dirName,
    why: r?.ok === false ? (r?.stopped ?? r?.why ?? 'failed') : null,
    note: r?.note ?? r?.hint ?? null,
    raw: r,
  }
}

export async function carveStepAhead (b, target, { cells = MOVE_CARVE_CELLS, radius = MOVE_CARVE_RADIUS, ignoreRange = false, digMs = MOVE_CARVE_DIG_MS, only = null, upLevels = 3 } = {}) {
  const me = b?.entity?.position
  if (!me || !target) return 0
  const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
  const dx = Number(target.x) - me.x, dz = Number(target.z) - me.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return 0
  /* 🔴 2026-10-28（用户：「move 在上面的时候自动挖不行吗」/「为什么 move 用不了」）：
   *    目标在**头顶上方 2 格以上**时，只清脚位+头位仍然上不去 —— 人往上跳，身体要先经过
   *    `y+2` 那格，它实心就把人顶回来（实机 `above:{headroom:1, ceiling:'stone'}` 一直走不动）。
   *    ⇒ 这种目标把 `y+2` 也算进“该挖的”。差 1 格以内的目标不碰 `y+2`：那多半是正常天花板，
   *    无脑挖开会在屋里、洞里到处开天窗。 */
  const ty = Number.isFinite(Number(target?.y)) ? Math.floor(Number(target.y)) : null
  const needAbove = ty != null && ty >= fy + 2
  /** 往上开路时要清的层：`y+2` 起，最多 `upLevels` 层 */
  const aboveYs = (() => {
    if (!needAbove) return []
    const top = Math.min(ty, fy + upLevels - 1)
    const ys = []
    for (let y = fy + 2; y <= top; y++) ys.push(y)
    return ys
  })()
  /* Bug 4：卡住的起因常常是**眼前这一格**，不是"离终点还远"。到底该不该挖由调用方判
   * （`obstacleAheadOf`），这里只保留"直接调用时的保守默认"。 */
  if (!ignoreRange && Math.hypot(dx, dz) > radius) return 0
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const nameOf = (blk) => { try { return blk?.name ?? null } catch { return null } }
  const solid = (blk) => { const n = nameOf(blk); return Boolean(n) && isSolidBlock(n) }
  /* 🔴 2026-10-24 用户实机：「现在寻路老是会跑到树上」。A* 那边已经把树列进 `blocksCantBreak`，
   *    但**我们自己的补挖**（卡住时挖开眼前那格）不归 A* 管 —— 它照样会把树叶挖穿，
   *    于是又爬上去了。这里补上同一条线：树不挖（要砍树请 AI 自己 `mc_dig` 指名砍）。 */
  const diggable = (blk) => diggableBlock(blk) && !isTreeLog(nameOf(blk))
  /* 方向：先主轴（离得远的那个轴），再另一条轴 —— 斜着走楼梯时两条都要看。 */
  const sx = Math.sign(dx), sz = Math.sign(dz)
  /* 🔴 2026-10-23 实机（用户："它往 z5 挖而不是 x方向"）：方向**只认主轴**（离得远的那个轴），
   *    不再看"另一条轴"。副轴正侧方永远不是通往目标的方向 —— 那是隧道的侧墙，挖它只会
   *    把 1 格宽的洞越挖越宽、越挖越乱（实机连挖几十格还是没过去，人却还在原地）。
   *    斜拐时真挡路的在**对角**（2026-10-19 实机），对角保留，但只在"主轴前方 cells 格全通
   *    （前方没堵，只是斜着拐）"时才看它 —— 主轴自己堵着就别绕到斜的上去。 */
  const main = Math.abs(dx) >= Math.abs(dz) ? [sx, 0] : [0, sz]
  const dirs = []
  if (main[0] || main[1]) dirs.push(main)
  let mainClear = true
  if (main[0] || main[1]) {
    for (let d = 1; d <= cells; d++) {
      const mx = fx + main[0] * d, mz = fz + main[1] * d
      const fn = nameOf(at(mx, fy, mz)), hn = nameOf(at(mx, fy + 1, mz))
      if (!fn || !hn || isSolidBlock(fn) || isSolidBlock(hn)) { mainClear = false; break }
    }
  }
  /* 2026-10-19 实机（"1 格宽巷道会卡，break 前面那格就过去"）：斜着拐弯时挡路的
   * 既不在正前也不在正侧，而在对角那一格 —— 两条轴都走不通时再看一眼对角线。 */
  if (sx && sz && mainClear) dirs.push([sx, sz])
  /* 2026-10-23 实机（208 秒挂死）：这里原来是两处**裸 await**（`b.equip()` 与 `b.dig()`），
   *   服务端不回包就永远挂着 ⇒ 整次 `mc_move` 卡死（预算只包着 `pathfinder.goto`）。
   *   那份"每个动作都有上限、到点 `stopDigging()` 松手"的实现现在在模块级
   *   `digOneGuarded` 里 —— `carveStepAhead` 与脱困阶梯的 `clearHead` 共用同一份。 */
  /* 🔴 2026-10-31 实机（用户：“我放了一层泥土，下面是玻璃包围的钻石矿。它站在泥土上，它只挖玻璃，不挖泥土”）：
   *   清障这条路**从来不换工具** —— 刚挖完玻璃，手上还是玻璃/空手，
   *   于是石头全被判“挖不动”（空手挖石头 7.5 秒 > 阀值），一格都挖不下去。
   *   换不上就算了，后面照旧判。 */
  try {
    let pb = only ? at(Math.floor(Number(only.x)), Math.floor(Number(only.y)), Math.floor(Number(only.z))) : null
    if (!pb || pb.boundingBox !== 'block') {
      const o = obstacleAheadOf(b, target)
      pb = o ? at(o.x, o.y, o.z) : null
    }
    if (pb && pb.boundingBox === 'block' && !canBreakNow(b, pb)) {
      const best = bestToolFor(b, pb)
      if (best?.item && b.heldItem?.type !== best.item.type) await b.equip(best.item, 'hand')
    }
  } catch { /* 换不上就照旧 */ }
  const digOne = (blk) => digOneGuarded(b, blk, { digMs })
  /* 🔴 2026-10-24 审计（用户第二份）：调用方已经用 `obstacleAheadOf` 指出了**具体那一格**，
   *    就别再自己扫一遍 —— 重扫出来的可能不是那一块，日志里说"眼前 X 挡路"、实际挖的却是
   *    另一格，模型看到的失败记录和真实动作对不上。这里只做安全检查再挖那一块。 */
  if (only) {
    const ox = Math.floor(Number(only.x)), oy = Math.floor(Number(only.y)), oz = Math.floor(Number(only.z))
    if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) return 0
    const blk = at(ox, oy, oz)
    const nm = nameOf(blk)
    if (!nm || !solid(blk) || !diggable(blk) || BRIDGE_FATAL.test(nm) || isLiquid(nm)) return 0
    /* 🔴 2026-10-24 用户实机（挖雪三坑）：头顶是雪块、手上是镐 ⇒ 以前照样硬挖，
     *    一直超时；正确做法是**承认挖不动**并把"要什么工具"交给上层去说。 */
    if (!canBreakNow(b, blk)) {
      try { b.__carveTooHard = { name: nm, need: toolKinds(b, blk), ms: breakMsNow(b, blk) } } catch {}
      return 0
    }
    const isFeetLevel = oy === fy
    const isHeadLevel = oy === fy + 1
    /* 🔴 2026-10-27（用户：「move 要挖方块的话，不会挖头上方块导致卡住」）：
     *    这条"底下得有支撑"的检查**只对脚层成立**（挖开脚位之后别对着坑/悬空走）。
     *    以前它不区分层，`obstacleAheadOf` 报"脚能走、头被挡"时指的是头位格，
     *    这里拿头位格的 y-1（= 脚位，正好是空气）去要求"实心" ⇒ 直接 return 0，
     *    于是**头顶那块永远挖不掉**，1 格高的洞人进不去，一直卡在门口。 */
    if (isFeetLevel) {
      const fl = nameOf(at(ox, oy - 1, oz))
      if (!fl || !isSolidBlock(fl) || BRIDGE_FATAL.test(fl) || isLiquid(fl)) return 0
    }
    try { b.__carveHalfOpen = null } catch {}
    let dugOnly = (await digOne(blk)) ? 1 : 0
    /* 🔴 2026-10-27：玩家过得去要 **2 格高**（脚位 + 头位）。只挖一格等于挖了个
     *    "看着通、其实进不去"的洞 —— 下一轮 `goto` 还是撞在头顶、还是卡住。
     *    ⇒ 同一根柱子的另一半（脚↔头）只要也是可挖的实心块，一起挖掉。
     *    另一半挖不动（水/岩浆/黑曜石/手上工具不对）就如实记账，让上层告诉 AI
     *    "通道只有 1 格高，差的是哪一块"，而不是让它一遍遍重挖同一格。 */
    const partnerY = isFeetLevel ? oy + 1 : (isHeadLevel ? oy - 1 : null)
    if (dugOnly > 0 && partnerY != null) {
      const pblk = at(ox, partnerY, oz)
      const pnm = nameOf(pblk)
      if (pnm && solid(pblk)) {
        if (diggable(pblk) && !BRIDGE_FATAL.test(pnm) && !isLiquid(pnm) && canBreakNow(b, pblk)) {
          dugOnly += (await digOne(pblk)) ? 1 : 0
        } else {
          try { b.__carveHalfOpen = { x: ox, y: partnerY, z: oz, name: pnm } } catch {}
        }
      }
    }
    /* 目标在头顶上方：正上方那几格也得清，不然垫柱子/起跳都顶头 */
    for (const ay of aboveYs) {
      const ablk = at(ox, ay, oz)
      const anm = nameOf(ablk)
      if (!anm || !solid(ablk)) continue
      if (!diggable(ablk) || BRIDGE_FATAL.test(anm) || isLiquid(anm) || !canBreakNow(b, ablk)) break
      if (await digOne(ablk)) dugOnly++
    }
    return dugOnly
  }
  /* 🔴 2026-10-28（用户：「为什么 move 用不了」实机 02:57:54）目标就在**正上方**、
   *    水平零位移时，`dirs` 是空的 —— 一个方向都没有，补挖等于没写。
   *    这种“就在头顶上”的目标，该清的是**自己头顶**（和脱困阶梯的 `clearHead` 同一件事）。 */
  if (dirs.length === 0 && needAbove) return await clearHeadCell(b, { digMs, levels: 2 })
  let dug = 0
  for (const [ddx, ddz] of dirs) {
    for (let d = 1; d <= cells; d++) {
      const x = fx + ddx * d, z = fz + ddz * d
      if (x === fx && z === fz) continue
      const feet = at(x, fy, z)
      const head = at(x, fy + 1, z)
      const floor = at(x, fy - 1, z)
      const feetHard = solid(feet), headHard = solid(head)
      /* 目标在上方时，`y+2` 往上那几格也是“挡路的一格”（人能走、但跳/垫都上不去） */
      const aboveBlks = aboveYs.map((ay) => at(x, ay, z)).filter((blk) => blk && solid(blk))
      if (!feetHard && !headHard && aboveBlks.length === 0) continue   // 这一格本来就过得去
      /* 🔴 底下没有支撑就别挖：那说明前面是坑/悬空，挖开只会多一个掉下去的口子。 */
      const floorName = nameOf(floor)
      if (!floorName || !isSolidBlock(floorName) || BRIDGE_FATAL.test(floorName) || isLiquid(floorName)) continue
      const picks = []
      if (feetHard && diggable(feet) && canBreakNow(b, feet)) picks.push(feet)
      if (headHard && diggable(head) && canBreakNow(b, head)) picks.push(head)
      for (const blk of aboveBlks) { if (diggable(blk) && canBreakNow(b, blk)) picks.push(blk) }
      if (!picks.length) {
        /* 有挡路的、但手上这套挖不动（雪块要锹、石头要镐…）⇒ 记下来，别静悄悄跳过。 */
        const hard = [feetHard ? feet : null, headHard ? head : null].filter(Boolean)
        const h = hard.find((x) => diggable(x))
        if (h) {
          const hn = nameOf(h)
          try { b.__carveTooHard = { name: hn, need: toolKinds(b, h), ms: breakMsNow(b, h) } } catch {}
        }
        continue
      }
      for (const blk of picks) { if (await digOne(blk)) dug++ }
      /* 🔴 2026-10-27（用户：「move 要挖方块的话，不会挖头上方块导致卡住」）：
       *    挖完**复核这根柱子现在是不是 2 格都通了**（脚位 + 头位）。只通一格就是
       *    "看着开了个口、其实人进不去"，下一轮 goto 还是撞在头顶、还是卡住；
       *    而"只挖通一格"的常见原因是另一格挖不动（水/岩浆/黑曜石/手上工具不对）。
       *    ⇒ 如实记账，交给上层当面告诉 AI「差的是哪一块」，别让它一遍遍重挖。 */
      if (dug > 0) {
        const feetStill = solid(feet), headStill = solid(head)
        try {
          b.__carveHalfOpen = (feetStill || headStill)
            ? {
                x,
                y: feetStill ? fy : fy + 1,
                z,
                name: nameOf(feetStill ? feet : head)
              }
            : null
        } catch {}
        return dug                    // 先挖第一处，挖完让 goto 重算（别一口气把路改了）
      }
    }
  }
  return dug
}

/**
 * "现在算不算正常等待，算哪一种" —— `'dig'`（挖着/放着）/ `'air'`（真在空中）/ `false`。
 *
 * 🔴 2026-10-28（用户问「卡在半空有没有可能是内部参数的问题」，实机确认就是）：
 *   以前只判 `onGround === false` 就算"忙着"，宽限 `MOVE_BUSY_MAX_MS`(6 秒) —— 而一次
 *   跳跃只有 ~0.6 秒。人真挂在自己垫的柱子顶上时速度是 0、一动不动，却被当成
 *   "正常等待"整整 6 秒，`mc_move` 的预算常常就这么多 ⇒ 整轮只剩 `timeout`、
 *   `stuck` 永远是 false，脱困阶梯一次都没轮到。
 *   现在离地还要**真在动**（垂直或水平速度明显不为 0）才算 `'air'`，且它有自己的短宽限
 *   （见 `MOVE_BUSY_AIR_MS`）。
 * 防假 bot：字段缺了当 false（不是"忙"，照常判卡）。
 */
export function moveBusyKind (b) {
  try {
    const pf = b?.pathfinder
    if (pf?.isBuilding?.() === true) return 'place'
    if (pf?.isMining?.() === true) return 'dig'
    const e = b?.entity
    if (!e || e.onGround !== false) return false
    const v = e.velocity ?? {}
    const vy = Math.abs(Number(v.y) || 0)
    const vh = Math.hypot(Number(v.x) || 0, Number(v.z) || 0)
    return (vy > MOVE_BUSY_VY_EPS || vh > MOVE_BUSY_VH_EPS) ? 'air' : false
  } catch { return false }
}

/**
 * 当前正在挖的**那一块**还要多久（ms）；拿不到就 `null`。
 * 🔴 2026-10-29：宽限必须按"这块"算 —— 手挖一格石头 7.5 秒、黑曜石更久，
 *    用一个固定值去截断就必然把"正在挖"误判成"卡住"。
 */
export function digLeftMsOf (b) {
  try {
    const blk = b?.targetDigBlock
    if (!blk) return null
    const ms = Number(breakMsNow(b, blk))
    return Number.isFinite(ms) && ms > 0 ? ms : null
  } catch { return null }
}

/** 兼容旧签名：`true` = 这会儿算正常等待（挖着 / 放着 / 真在空中）。 */
export function moveBusyNow (b) { return moveBusyKind(b) !== false }

/**
 * 移动进度采样器（P0-1）。每 `sampleMs` 看一眼"离目标还有多远"，判卡住时 **reject**
 * 一个带 `mcStuck: true` 的错误；其余情况永远 pending，由 `stop()` 收尾。
 *
 * ⚠️ 不自己按控制位：`pathfinder` 每个 physicsTick 都会把 `forward/jump/sprint`
 *    按回去（vendor `monitorMovement`），采样器里按什么都会被立刻覆盖 —— 脱困动作
 *    必须由调用方在"pathfinder 已经停掉"的窗口里做（见 `escapeMove`）。
 *
 * 注入 `now` / `setTimer` / `clearTimer` 是为了离线测试能拿假时钟驱动它。
 *
 * @returns {{ promise: Promise<void>, stop: () => void, info: () => object }}
 */
export function moveProgressWatcher (b, target, {
  arrive = 1.6, ty = null, xz = false,
  sampleMs = MOVE_SAMPLE_MS, stuckMs = MOVE_STUCK_MS,
  busyMaxMs = MOVE_BUSY_MAX_MS, busyAirMaxMs = MOVE_BUSY_AIR_MS, progressEps = MOVE_PROGRESS_EPS,
  resetsOf = null, resetLimit = MOVE_RESET_LIMIT,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h),
} = {}) {
  const goalVec = new Vec3(target.x, ty ?? target.y, target.z)
  /* 🔴 2026-10-23（P0-a 配套）：`xz` 目标（`GoalXZ`）**只有水平两维** —— 那个 y 是猜的。
   *    拿三维距离判"有没有靠近"时，人沿着同一条水平线在上下层乱爬也照样"在靠近"，
   *    进度时钟一直被重置 ⇒ 长路上永远不判卡。xz 一律只量水平。 */
  const distOf = xz
    ? () => {
        try {
          const p = b.entity.position
          return Math.hypot(p.x - target.x, p.z - target.z)
        } catch { return Infinity }
      }
    : () => {
        try { return b.entity.position.distanceTo(goalVec) } catch { return Infinity }
      }
  let stopped = false
  let reject = null
  let best = distOf()
  let lastProgressAt = now()
  let busySince = null
  let stuckInfo = null
  const promise = new Promise((_, rej) => { reject = rej })
  // ⚠️ 竞速可能先结束、采样器随后才 reject ⇒ 自己吞掉，否则是"未处理拒绝"（会炸宿主）。
  promise.catch(() => {})
  /** 路径被失效了几次（`resetsOf` 抛错就当 0 —— 判卡不该因为数数失败而失效）。 */
  const resetsNow = () => { try { return resetsOf ? Number(resetsOf()) || 0 : 0 } catch { return 0 } }
  /**
   * 认输：收掉定时器 + reject 一个带 `mcStuck` 的错误。
   * `thrash` = 成因是"路径一直被失效"（而不是"2.4 秒没进展"）—— 两者给模型的下一步不一样。
   */
  const giveUp = (d, { ms = 0, thrash = false, work = null } = {}) => {
    stopped = true
    try { clearTimer(timer) } catch {}
    stuckInfo = {
      ms, remaining: Number(d.toFixed(2)),
      ...(thrash ? { thrash: true, resets: resetsNow() } : {}),
      ...(work ? { working: work } : {}),
    }
    /* 挖/放超时与"干卡着"是两件事：前者多半是方块太硬/工具不对，后者才是路不通。 */
    const err = new Error(thrash
      ? `路径被反复失效（这一次 goto 里被重算了 ${resetsNow()} 次）—— 光重算没用（离目标还有 ${d.toFixed(1)} 格）`
      : work
        ? `一直在${work === 'place' ? '放方块' : '挖'}，连续 ${(ms / 1000).toFixed(1)} 秒没有进展（离目标还有 ${d.toFixed(1)} 格）—— 多半是方块太硬 / 工具不对`
        : `移动卡住：${(stuckMs / 1000).toFixed(1)} 秒里既没挪动、也没靠近（离目标还有 ${d.toFixed(1)} 格）`)
    err.mcStuck = true
    if (work) err.mcWorkStall = work
    err.remaining = Number(d.toFixed(2))
    if (thrash) err.mcPathThrash = true
    reject(err)
  }
  const timer = setTimer(() => {
    if (stopped) return
    const t = now()
    const d = distOf()
    /* 🔴 2026-10-23 审计（A[1]）：以前 `d <= arrive + 0.6` **也算"有进展"并直接 return**。
     *    于是人已经在目标 1.2 格内被门框/台阶/碰撞箱挡住、**一格没动**时，这个条件永远成立：
     *    进度时钟被反复刷新、路径失效次数检查被跳过 ⇒ 脱困阶梯永远不启动，干等预算耗尽。
     *    现在只有"距离真的变小了"才算进展；"在到达圈里但没更近"照常往下走卡住判定。
     *    （不会误伤"真到了"：真到了 vendor 的 goto 就 resolve，采样器根本轮不到判卡。） */
    if (d < best - progressEps) {
      // 真的靠近了 —— 进度时钟归零（**在进展面前，失效次数不算数**：一直被打断但还在往前挪，那就让它挪）
      best = d
      lastProgressAt = t
      busySince = null
      return
    }
    /* 🔴 2026-10-28：宽限分两档 —— 挖/放用 `busyMaxMs`（默认 6 秒），空中只用
     *   `busyAirMaxMs`（0.9 秒）。见 `moveBusyKind` 的注释：一次跳跃 ~0.6 秒。 */
    const busyKind = moveBusyKind(b)
    /* 🔴 2026-10-29（用户四条）：挖/放 ≠ 卡住。
     *   ① 挖着/放着 ⇒ **暂停**卡住判定（推 `lastProgressAt`），宽限按"这块还要挖多久"算，
     *      不再被一个比 7.5 秒还小的固定值截断；
     *   ② 仍保留兜底：工作累计超过 `busyMaxMs`（默认 12 秒 > 单次调用上限）照样收手，
     *      但报的是 `working:` 而不是单纯的"卡住"；
     *   ③ 空中仍是短宽限（一次跳跃 ~0.6 秒）；
     *   ④ 没有合法动作 ⇒ 照旧按 `stuckMs` 判卡。 */
    if (busyKind === 'dig' || busyKind === 'place') {
      if (busySince == null) busySince = t
      const need = busyKind === 'dig' ? digLeftMsOf(b) : null
      const cap = need != null ? Math.min(busyMaxMs, Math.max(1_000, need + 1_500)) : busyMaxMs
      if (t - busySince < cap) { lastProgressAt = t; return }
      giveUp(d, { ms: t - lastProgressAt, work: busyKind })
      return
    }
    if (busyKind === 'air') {
      if (busySince == null) busySince = t
      if (t - busySince < busyAirMaxMs) { lastProgressAt = t; return }
    } else busySince = null
    /* P1：**路径失效重算** —— vendor 自己会 `resetPath('stuck')` 重算，但它只重算**同一条**。
     * 一个 `goto` 里"没进展 + 又失效了太多次" ⇒ 世界在变 / 一直被挡，"光重算没用"，
     * 直接进脱困阶梯换策略，不用再等满 `stuckMs`。 */
    if (resetsOf && resetLimit > 0 && resetsNow() >= resetLimit) { giveUp(d, { ms: t - lastProgressAt, thrash: true }); return }
    if (t - lastProgressAt >= stuckMs) giveUp(d, { ms: t - lastProgressAt })
  }, sampleMs)
  return {
    promise,
    stop () { if (stopped) return; stopped = true; try { clearTimer(timer) } catch {} },
    info: () => ({ best: Number(best.toFixed(2)), stuck: stuckInfo }),
  }
}

/**
 * 走一级脱困动作（P0-1）。**必须在"pathfinder 已经停掉"的窗口里跑**：
 * 先 `ctx.stopPathing(b)`（`setGoal(null)` ⇒ `resetPath` + `clearControlStates`），
 * 否则 vendor 每个 physicsTick 都会把 `forward/jump` 按回去，我们按什么都被立刻覆盖；
 * 顺带让上一轮的 `goto` 以 `GoalChanged` 收场（调用方已经 `.catch(()=>{})`）。
 *
 * ⚠️ 三级动作**都不换 goal 对象** —— vendor 的 `goto` 监听 `goal_updated`，换了对象
 *    就直接以 `GoalChanged` 拒绝（`lib/goto.js:35`），等于把这次走路判死。
 */
/**
 * 侧向绕行（执行顺序第 5 级，2026-10-23）：往目标方向的**左边或右边**走开几格，
 * 换个起点再规划。
 *
 * 为什么这一级必须存在：A* 是确定性的 —— 同一个起点、同一个终点、同一套 `Movements`
 * 只会给出**同一条路**。路被一个人 / 一格台阶 / 一道关着的门堵死时，"原地重算"答案永远是
 * 那条死路（实机表现：连续几轮 `remaining` 一点不变，日志里全是"重算路径"）。
 * 走开三格 = 换一个起点，规划结果就真的会变。
 *
 * 只试**两个**候选（左、右；先试离目标更近的那个），必须站得住（`standPointFor` 的三级兜底），
 * 且不能把自己绕得更远。走不动就如实返回 `moved:0`，交给下一级（挖）。**这一级不挖、不放方块。**
 */
export async function detourStep (b, target, { goals = null, ctx = {}, budgetMs = MOVE_DETOUR_MS, r = MOVE_DETOUR_R } = {}) {
  const p = b?.entity?.position
  const G = goals ?? null
  if (!p || target == null || !G?.GoalNear) return { moved: 0, why: 'no-goal-api' }
  const dx = Number(target.x) - p.x
  const dz = Number(target.z) - p.z
  const L = Math.hypot(dx, dz)
  if (!(L > 0.5)) return { moved: 0, why: 'too-close' }     // 已经在这一格上了，绕什么绕
  const ux = dx / L, uz = dz / L
  const cands = []
  for (const s of [{ x: -uz, z: ux }, { x: uz, z: -ux }]) {
    for (const stepR of [r, Math.max(2, r - 1)]) {
      const cx = Math.floor(p.x + s.x * stepR)
      const cz = Math.floor(p.z + s.z * stepR)
      const sp = standPointFor(b, cx, Math.floor(p.y), cz)
      if (!sp) continue
      const dTo = Math.hypot(sp.x - Number(target.x), sp.z - Number(target.z))
      if (dTo > L + 0.5) continue                             // 别绕到反方向去
      cands.push({ x: sp.x, y: sp.y, z: sp.z, dTo })
    }
  }
  if (cands.length === 0) return { moved: 0, why: 'no-side-spot' }
  /* 2026-10-24 通审：左右两侧 × 两个半径可能算出**同一格**，去重后再按远近排（否则两次预算花在同一点上）。 */
  const uniq = new Map()
  for (const c of cands) uniq.set(`${c.x},${c.y},${c.z}`, c)
  const candsU = [...uniq.values()]
  candsU.sort((a, c) => a.dTo - c.dTo)
  /* 🔴 2026-10-23 审计（A[4]）：上面注释写着"只试**两个**候选（左、右）"，代码却只试 `cands[0]` ——
   *    最近那个侧向点被墙 / 门框 / 一格台阶挡住时，明明另一侧是通的，这一级也会报失败、
   *    直接掉进下一级（挖）。现在真的按评分依次试最多两个，每个分到一半预算。 */
  const tries = candsU.slice(0, 2)
  const per = Math.max(300, Math.round((Number(budgetMs) || MOVE_DETOUR_MS) / Math.max(1, tries.length)))
  const bx = p.x, bz = p.z
  let reached = false
  let used = null
  for (const pick of tries) {
    /* ⚠️ 必须在"pathfinder 已经停掉"的窗口里跑：vendor 每个 physicsTick 都会把控制位按回去，
     *    所以先 `stopPathing`（同时让上一轮的 `goto` 以 GoalChanged 收场，上面已经 catch 过）。 */
    try { ctx.stopPathing?.(b) } catch { /* 假 bot */ }
    await sleep(60)
    try {
      const work = b.pathfinder.goto(new G.GoalNear(pick.x, pick.y, pick.z, 0))
      work.catch?.(() => {})                                 // race 先结束时不留下未处理拒绝
      reached = await Promise.race([
        withTimeout(work, per, '绕行').then(() => true).catch(() => false),
        sleep(per).then(() => false),
      ])
    } catch { /* 这个候选走不动，换下一个 */ }
    try { ctx.stopPathing?.(b) } catch { /* 同上 */ }
    const at = b?.entity?.position ?? { x: bx, z: bz }
    const got = Math.hypot(Number(at.x) - bx, Number(at.z) - bz)
    /* 走到了、或者确实挪开了一段（换起点这个目的已经达到）就收手，不必再试另一侧 */
    if (reached || got >= 0.5) { used = pick; break }
  }
  const now = b?.entity?.position ?? { x: bx, z: bz }
  const moved = Math.hypot(Number(now.x) - bx, Number(now.z) - bz)
  return {
    moved: Math.round(moved * 100) / 100,
    ...(used ? { to: { x: used.x, y: used.y, z: used.z } } : {}),
    reached,
    tried: tries.length,
  }
}

/** 一次"上台阶"按住 forward+jump 的时长（2026-10-24 用户要求的局部运动层）。 */
export const STEP_UP_MS = 260
/** 松手后等落地/站稳的时间。 */
/* 🔴 2026-10-29（用户：「上楼梯很慢，应该是你之前改的跳跃延迟」）：
 *   这四段等待是**每格台阶**都付一次的固定成本，加起来近 900ms/格 ——
 *   爬 20 格就 18 秒，一次调用（10 秒）只能上去 11 格。真实玩家上台阶约 0.3~0.4 秒/格。
 *   改法：① `lookAt` 是本地即时生效并直接发包的，等服务端回话没必要 ⇒ 转向 150→60ms；
 *        ② 起跳只需要 1 个 physicsTick ⇒ 80→50ms；
 *        ③ 落地时间**轮询**（站稳就立刻走），不再死睡满。 */
export const STEP_UP_SETTLE_MS = 200
/* 🔴 2026-10-25 实机（上刚挖好的阶梯卡住，用户确认「头上方是空的」）：跳了却没上去（`up=0` → `no-lift`）。
 *   两条叠加：① `lookAt` 之后只等 60ms，转身包还没生效，1 格宽竖井里朝向差 90° 就撞侧墙；
 *   ② `forward` 与 `jump` 同时按下，起跳上升阶段身体正面撞台阶侧面，窄井没有侧向余量可滑 ⇒ 弹回原地。
 *   现在：看向后等 `STEP_UP_TURN_MS` 让朝向生效，先单独按 `jump` 起跳 `STEP_UP_JUMP_MS`，再叠 `forward`。 */
export const STEP_UP_TURN_MS = 60
export const STEP_UP_JUMP_MS = 50
/* 起跳前先助跑多久。见 stepUp 里的说明：从静止起跳跨不过一格台阶。 */
export const STEP_UP_RUNUP_MS = 90
/** 一次 `mc_move` 里最多试几次台阶动作（跳上去 / 定向清天花板）。 */
/**
 * 前方通道里是不是**实体**挡着（怪 / 动物 / 别人）—— 与"方块挡路"分开报。
 *
 * 🔴 2026-10-24 用户（导航世界模型建议）：**实体挡路不等于方块挡路** ——
 *    · vendor 的实体成本（`movements.js:298` 等 9 处 `getNumEntitiesAt(...) * entityCost`）
 *      只在**生成路径那一刻**按当时位置算一次；路径出来之后怪再走进通道，A* 并不知道；
 *    · 表现就是"明明没墙、也没台阶，就是走不动"，然后掉进"挖开挡路那格"的兜底 ——
 *      拿镐子对着怪站的位置挖，越挖越乱。
 * 这里只**提供证据**，不替 AI 决定等/打/绕（那是移动总控与战斗策略的事）。
 */
export function entityObstacleAhead (b, target, { cells = 2, radius = 1.5 } = {}) {
  const me = b?.entity?.position
  if (!me || !target) return null
  const ents = Array.isArray(b?.entities) ? b.entities : Object.values(b?.entities ?? {})
  if (!Array.isArray(ents) || ents.length === 0) return null
  const dx = Number(target.x) - me.x, dz = Number(target.z) - me.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
  /* 方向只认主轴（与 `obstacleAheadOf` / `stepGeometryOf` 同一口径） */
  const main = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
  if (!main[0] && !main[1]) return null
  /* 掉落物/弹射物不算"挡路"（vendor 的 `passableEntities` 也不含成本） */
  const IGNORE = /^(item|arrow|snowball|egg|potion|experience_orb|fishing_bobber|trident|eye_of_ender|firework_rocket|shulker_bullet|llama_spit|small_fireball|dragon_fireball|fireball|wither_skull|spectral_arrow|ender_pearl|area_effect_cloud|leash_knot|painting|item_frame)$/
  let best = null
  for (const e of ents) {
    if (!e || e === b.entity || !e.position) continue
    /* 🔴 2026-10-24 实机（用户：在船上 / 刚下船后基本走不了）：**自己骑的那条船**也在 `bot.entities` 里，
     *    以前没排除 ⇒ 它被报成"实体挡路"，一路触发脱困阶梯（绕行 / 挖开挡路那格），越走越乱。
     *    vendor 的 `updateCollisionIndex` 同样只跳过 `bot.entity`，补丁在 `tools/patch-mc-deps.mjs`。 */
    if (b?.vehicle && e === b.vehicle) continue
    const nm = String(e.name ?? e.username ?? e.type ?? '')
    if (!nm || IGNORE.test(nm)) continue
    const pos = e.position
    const along = (pos.x - me.x) * main[0] + (pos.z - me.z) * main[1]
    const side = Math.abs((pos.x - me.x) * main[1] - (pos.z - me.z) * main[0])
    const dy = pos.y - me.y
    if (along < 0.2 || along > cells + 0.6) continue   // 不在前方这一小段
    if (side > radius) continue                        // 偏到侧边去了，不挡路
    if (dy < -1.6 || dy > 2.2) continue                // 头顶/脚下，不在同一条通道
    const d = Math.hypot(along, side)
    if (!best || d < best.dist) {
      best = {
        name: nm,
        dist: Number(d.toFixed(2)),
        x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z),
        ...(e.username ? { player: String(e.username) } : {}),
      }
    }
  }
  return best
}

/**
 * 这一格世界**读得到**吗？
 *
 * 🔴 2026-10-24 用户（导航世界模型建议）：**未加载 ≠ 空气，更 ≠ 没路**。
 *    mineflayer 的 `blockAt` 在区块没加载时返回 `null`（或读到 `undefined`），
 *    旧代码把它和"前方是墙"混在一起 ⇒ 报 `NoPath` + "被墙/水/悬崖挡住"，
 *    于是 AI 对着还没加载的地方挖一轮，白花 10 秒。
 */
export function blockKnownAt (b, x, y, z) {
  try {
    const blk = b.blockAt(new Vec3(x, y, z))
    return Boolean(blk) && typeof blk.name === 'string' && blk.name !== ''
  } catch { return false }
}

/**
 * 前方是不是**岩浆**（危险地形）—— 与"墙"分开：墙可以挖，岩浆挖不了、也别跳。
 *
 * 水有专门的游泳控制器（`walkSwim`），岩浆没有、也不该有：
 * 掉进去就是死，只能绕路或搭桥（`mc_act{mode:"bridge"}`）。
 */
export function lavaAheadOf (b, target, { cells = 3 } = {}) {
  const me = b?.entity?.position
  if (!me || !target) return null
  const dx = Number(target.x) - me.x, dz = Number(target.z) - me.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
  const main = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
  if (!main[0] && !main[1]) return null
  const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
  for (let d = 1; d <= cells; d++) {
    for (const dy of [0, -1]) {
      let blk = null
      try { blk = b.blockAt(new Vec3(fx + main[0] * d, fy + dy, fz + main[1] * d)) } catch { blk = null }
      const nm = String(blk?.name ?? '')
      if (/lava/.test(nm)) {
        return { name: nm, dist: d, x: fx + main[0] * d, y: fy + dy, z: fz + main[1] * d }
      }
    }
  }
  return null
}

/* 🔴 2026-10-24 用户：「这个改成试一次」—— 局部台阶处理一次移动里**只试一次**。
 *    原来允许 2 次，本意是"第一次跳失败、清开后再来一次"，但实机上第二次往往是在同一个
 *    几何里重复同一种失败（跳不上去还是跳不上去），白吃掉一两秒预算，还把脱困阶梯往后拖。
 *    试一次不行就把控制权交给阶梯（换招比重复同一个动作有用）。 */
export const STEP_UP_TRIES = 1
/* 往下走的预算（用户 2026-10-29：「按时间」）。
 * 不再钉“一趟最多 3 次”—— 目标低 13 格时只能下 3 层，得叫四五次工具。
 * 现在按**剩余时间**算：每下一层约 1～2 秒（B 挖一格 + 落下 / A 挖两格 + 走），
 * 剩不到 `MOVE_DOWN_MIN_MS` 就不开工（开了也不会有结果）。
 * `MOVE_DOWN_TRIES` 只当防死循环的硬上限（正常情况下先碰到的是时间门槛）。
 * 2026-10-31 用户实机目标在脚下 22 格 ⇒ 8 次连一列竖井都挖不到底，放宽到 24
 * （真到不了会先被 `downBudgetOk` / 预算拦下，硬上限只是防死循环）。 */
export const MOVE_DOWN_TRIES = 24
export const MOVE_DOWN_MIN_MS = 1_500

/** 剩余时间还够不够往下挖一层（拿不到时间就当“够”，别因为查不到就不干活）。 */
export function downBudgetOk (self, minMs = MOVE_DOWN_MIN_MS) {
  try {
    const l = Number(self?.msLeft?.())
    return Number.isFinite(l) ? l > minMs : true
  } catch { return true }
}

/** 方块顶面高度（0~1，相对格子）。半砖 0.5、楼梯 0.5/1、雪层 0.125、整块 1。
 *  读不到 `shapes` 就返回 null（**不猜**：猜成整块会把半砖当台阶去跳）。 */
function topOfBlock (blk) {
  try {
    const sh = blk?.shapes
    if (!Array.isArray(sh) || !sh.length) return null
    let top = 0
    for (const box of sh) {
      const v = Number(box?.[4])
      if (Number.isFinite(v) && v > top) top = v
    }
    return top
  } catch { return null }
}

/**
 * 能不能挖这一块（**唯一判据**：`carveStepAhead` 与 `stepUp` 都用它）。
 *
 * 不能挖的：非实心 / 液体 / `BRIDGE_FATAL`（岩浆火细雪仙人掌…）/ `CARVE_PROTECTED`
 * （容器、矿石、装置 —— 不可逆的决定不替 AI 做）/ 基岩类。
 */
export function diggableBlock (blk) {
  const nm = (() => { try { return blk?.name ?? null } catch { return null } })()
  if (!nm || !isSolidBlock(nm)) return false
  if (BRIDGE_FATAL.test(nm) || isLiquid(nm)) return false
  if (CARVE_PROTECTED.test(nm)) return false
  return !/^(bedrock|barrier|command_block|chain_command_block|repeating_command_block|obsidian|end_portal_frame)$/.test(nm)
}

/**
 * 🔴 2026-10-24 用户：「在 A* 的格子路线与真实物理控制之间加一个**局部运动执行层**，
 *    让寻路器知道什么时候必须跳、什么时候根本跳不起来、什么时候需要先挖开头顶。」
 *
 * **它要回答的问题**：眼前这一格到底是
 *   - `step` 一格台阶（该踩上去 —— **不是**该挖掉的挡路方块），
 *   - `wall` 两格以上的墙（台阶这条不适用，交回原有逻辑），
 *   - `null` 前方本来就能走（不归这一步管）。
 *
 * 为什么必须和 `carveStepAhead` 分开：那个函数把"前方脚部高度的实心方块"一律当障碍挖掉。
 * 可对一格台阶来说，**那块方块正是该踩上去的支撑面** —— 挖掉它等于把楼梯削平
 * （窄矿道里还把地形改坏了）。所以台阶先走 `stepUp`，跳不上去再只清**天花板**。
 *
 * 半砖 / 楼梯 / 雪层（顶面 < 0.99）不算"要跳的台阶"：直接 `forward` 就走得上去，
 * 标成 `partial:true` 让调用方别浪费一次跳跃。
 *
 * @returns {null | {kind:'step'|'wall', dir:[number,number], x:number, y:number, z:number,
 *   name:string, top:number|null, partial:boolean, standY:number, canStandOnTop:boolean,
 *   ceiling?:{x:number,y:number,z:number,name:string}}}
 */
export function stepGeometryOf (b, target, { cells = 1 } = {}) {
  const me = b?.entity?.position
  if (!me || !target) return null
  const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
  const dx = Number(target.x) - me.x, dz = Number(target.z) - me.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const nameOf = (blk) => { try { return blk?.name ?? null } catch { return null } }
  const hardName = (nm) => Boolean(nm) && isSolidBlock(nm) && !isLiquid(nm)
  /* 方向只认主轴（与 `obstacleAheadOf` 同一口径：副轴正侧方是隧道侧墙，不是前进方向） */
  const main = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
  if (!main[0] && !main[1]) return null
  for (let d = 1; d <= cells; d++) {
    const x = fx + main[0] * d, z = fz + main[1] * d
    const feet = at(x, fy, z), head = at(x, fy + 1, z), above = at(x, fy + 2, z)
    const feetName = nameOf(feet), headName = nameOf(head)
    /* 脚层是空的 ⇒ 前方本来就能走（或是个坑），不归台阶管 */
    if (!hardName(feetName)) continue
    /* 🔴 2026-10-29 实机（session-d68855bb）：AI 顺着树冠一级级往上爬 —— 同一目标连叫两次
     *   `mc_move`，y 分别 +7 和 +1，最后卡在树冠里四面都是树叶（树叶禁挖）⇒ A* 无路，
     *   脱困阶梯只会原地跳 5 次。根因：`isSolidBlock()` 认为树叶是实心 ⇒ 树叶在
     *   `stepGeometryOf` 眼里就是"该踩上去的一格台阶"。
     *   现在：树类方块一律当**墙**（不主动踩），**除非目标点本身就落在这一格顶上**
     *   （砍树 / 上树屋 / 你明确让它去树冠时才放行）。
     *   注意顺序：树必须在"头层实心"之前判 —— 否则树干/树冠会被判成"台阶+顶头"而去挖树叶。 */
    if (isTreeBlock(feetName)) {
      const tx = Math.floor(Number(target?.x)), ty = Math.floor(Number(target?.y)), tz = Math.floor(Number(target?.z))
      const onTop = Number.isFinite(ty) && ty === fy + 1 && tx === x && tz === z
      if (!onTop) return { kind: 'wall', dir: main, x, y: fy, z, name: feetName, head: headName, tree: true }
    }
    /* 🔴 2026-11-03 用户实机：「move 里 allowDig 的挖台阶不会挖头顶方块，而且没有跳上挖上去的台阶」。
     *   原判据：**头层实心就一律当"两格以上的墙"** ⇒ `stepUp` 拿到 wall 就一格不挖、也不跳，
     *   只报「一格台阶上不去（wall）」；而同一次卡住的提示又说「前方 X 的**脚下**是 stone
     *   （没有两格高）」⇒ 真按提示去挖就挖掉了**台阶本身**（楼梯削平），人还是进不去、也没得跳。
     *   其实读三格就能分清（`feet`/`head`/`above` 这里全都读好了）：
     *     ① 头层空                ⇒ 普通一格台阶（跳上去）；
     *     ② 头层实心、再上面空    ⇒ **台阶 + 站上去顶头**：该挖的是头层那格，挖完就是①，接着跳；
     *     ③ 头层与再上面都实心    ⇒ 真·两格厚的墙（不是台阶），交回墙那一套逻辑。 */
    if (hardName(headName)) {
      if (!hardName(nameOf(above))) {
        const topH = topOfBlock(feet)
        return {
          kind: 'step',
          dir: main, x, y: fy, z,
          name: feetName,
          top: topH,
          partial: topH != null && topH < 0.99,
          standY: fy + 1,
          canStandOnTop: false,
          ceiling: { x, y: fy + 1, z, name: headName },
        }
      }
      return {
        kind: 'wall', dir: main, x, y: fy, z, name: feetName, head: headName,
        above: { x, y: fy + 2, z, name: nameOf(above) },
      }
    }
    const top = topOfBlock(feet)
    const standY = fy + 1
    const ceilingName = nameOf(above)
    return {
      kind: 'step',
      dir: main, x, y: fy, z,
      name: feetName,
      top,
      partial: top != null && top < 0.99,
      standY,
      canStandOnTop: canStandAtWorld(b, x, standY, z),
      ...(hardName(ceilingName) ? { ceiling: { x, y: fy + 2, z, name: ceilingName } } : {}),
    }
  }
  return null
}

/**
 * 执行一次受约束的"上台阶"（局部运动执行层）。
 *
 * 顺序（用户 2026-10-24 定的）：
 *   ① 半砖/楼梯 → 不跳，直接 forward 走上去；
 *   ② 头顶净空够（站上去能站住）→ **forward + jump**，然后**量真实位移与高度**，
 *      `up >= 0.75 && 水平 >= 0.25` 才算成功 —— **按过跳键 ≠ 上去了**；
 *   ③ 头顶不够 → 跳不起来。允许挖时**只清挡在落脚位置上方的那一格**（绝不挖台阶本身），
 *      清完再跳；不允许挖（`allowDig:false`）就如实报 `no-headroom`，让 AI 决定绕行或换目标。
 *
 * 控制位一律按代次（`_moveGen`）收放：被接管就不动别人的键。
 */
export async function stepUp (b, target, { allowDig = true, ctx = null, cells = 1, ms = STEP_UP_MS, digMs = MOVE_CARVE_DIG_MS } = {}) {
  let geo0 = stepGeometryOf(b, target, { cells })
  if (!geo0) {
    /* 🔴 2026-11-05 实机（用户：「stair 为什么会被卡住」）：`dig stair` 的第一步就是**把前方那格挖空**
     *   （挖 `(fx,fy)` 与 `(fx,fy+1)`），而 `stepGeometryOf` 判台阶的依据正是“前方同层那格是不是实心”
     *   ⇒ 挖空之后按定义返回 `null` ⇒ 这里报 `no-step` 一格都不跳。
     *   实机日志：`卡在 82,24,-195：要去的 83,25,-195 脚位是 air、头顶是 air、脚下是 stone …
     *   跳上去三次都没成（no-step）` —— 台阶面（83,24 那块 stone）明明在，只是不在判据看的那一格上。
     *   **挖得越对，越不肯跳**，于是整条 stair 链条断在第一步。
     *
     *   补一条：目标格本身已经能站（脚位空、头顶空、脚下实心不是液体）+ 与人水平相邻 ⇒
     *   这就是“要跳上去的那格”，合成一个 step 几何走后面的起跳流程（转向 → 助跑 → 起跳 → 量位移）。 */
    const me2 = b?.entity?.position
    const tx2 = Math.floor(Number(target?.x))
    const ty2 = Math.floor(Number(target?.y))
    const tz2 = Math.floor(Number(target?.z))
    if (me2 && Number.isFinite(tx2) && Number.isFinite(ty2) && Number.isFinite(tz2)) {
      const hopDx = tx2 - Math.floor(me2.x)
      const hopDz = tz2 - Math.floor(me2.z)
      const near = Math.abs(hopDx) <= 1 && Math.abs(hopDz) <= 1 && (hopDx !== 0 || hopDz !== 0)
      let floorName2 = null
      let spaceOk = false
      try {
        const fb = b.blockAt(new Vec3(tx2, ty2 - 1, tz2))
        floorName2 = fb?.name ?? null
        const a = b.blockAt(new Vec3(tx2, ty2, tz2))
        const c = b.blockAt(new Vec3(tx2, ty2 + 1, tz2))
        spaceOk = a?.boundingBox !== 'block' && c?.boundingBox !== 'block'
      } catch { spaceOk = false }
      if (near && spaceOk) {
        /* 蹲一步就上去（半砖/楼梯顶面 < 1 格）还是真要跳，看脚下那块的顶面高度 */
        let topH = null
        try { topH = topOfBlock(b.blockAt(new Vec3(tx2, ty2 - 1, tz2))) } catch { topH = null }
        geo0 = {
          kind: 'step',
          dir: Math.abs(hopDx) >= Math.abs(hopDz) ? [Math.sign(hopDx), 0] : [0, Math.sign(hopDz)],
          x: tx2, y: ty2 - 1, z: tz2,
          name: floorName2,
          top: topH,
          partial: topH != null && topH < 0.99,
          standY: ty2,
          canStandOnTop: true,
        }
      }
    }
  }
  if (!geo0) return { tried: false, why: 'no-step' }
  /* 🔴 2026-11-03 用户实机：`⛔ 走不动：前方 54,104,31 的脚下是 stone（没有两格高）`，
   *   `allowDig:true` 也一样过不去，10 秒只挪了 2.7 格（三条日志同一条路）。
   *   原因是脚下/头层/再上面**三格全实心**时这里直接 `return { why: 'wall' }` —— 一格都不挖，
   *   把"两张方块厚的台阶"当成真墙，A* 只能绕远路。
   *   这其实是台阶：挖掉头层(fy+1) 和再上面那格(fy+2)，人就能站上去。
   *   `allowDig:false` 时仍如实报 wall（不挖就一格不动）。 */
  let geo = geo0
  if (geo.kind === 'wall') {
    if (!allowDig) return { tried: true, ok: false, why: 'wall', blockedBy: geo.head }
    geo = {
      ...geo,
      kind: 'step',
      standY: geo.y + 1,
      canStandOnTop: false,
      ceiling: { x: geo.x, y: geo.y + 1, z: geo.z, name: geo.head },
      above: geo.above ?? null,
    }
  }
  const start = b?.entity?.position
  if (!start) return { tried: false, why: 'no-bot' }
  const x0 = Number(start.x), y0 = Number(start.y), z0 = Number(start.z)
  let dug = 0
  /* 挖一格：换最合适的工具 → 挖 → 超时就停手。原来这段是内联在"清头顶"里的，
   * 「两张方块厚的台阶」也要用同一套（换工具/超时/沙砾没挖穿都算失败），抽出来。
   * 挖之前先停 pathfinder：vendor 每个 physicsTick 都会把控制位按回去。 */
  const digAt = async (cx, cy, cz) => {
    const blk = (() => { try { return b.blockAt(new Vec3(cx, cy, cz)) } catch { return null } })()
    if (!blk || !diggableBlock(blk)) return false
    try { ctx?.stopPathing?.(b) } catch {}
    await sleep(60)
    const TO = Symbol('timeout')
    try {
      const tool = typeof b.pathfinder?.bestHarvestTool === 'function' ? b.pathfinder.bestHarvestTool(blk) : null
      if (tool && typeof b.equip === 'function') {
        await Promise.race([Promise.resolve(b.equip(tool, 'hand')).catch(() => {}), sleep(digMs)])
      }
      const r = await Promise.race([
        Promise.resolve(b.dig(blk, true)).then(() => true, () => false),
        sleep(digMs).then(() => TO),
      ])
      if (r === TO) { try { b.stopDigging?.() } catch {} ; return false }
      return r === true
    } catch { return false }
  }
  let ceiling = geo.ceiling
  if (!geo.canStandOnTop) {
    /* 净空不足：跳起来会顶住天花板 ⇒ 先判"能不能清" */
    if (!allowDig) {
      return {
        tried: true, ok: false, why: 'no-headroom', blockedBy: ceiling?.name ?? null,
        hint: `前面是一格台阶，但站上去头顶被 **${ceiling?.name ?? '方块'}** 堵着 —— **跳不上去**；这次又是不挖的模式，所以我没动它。要么 \`allowDig:true\` 让我清开头顶那一格，要么换个目标绕过去。`,
      }
    }
    if (!ceiling) return { tried: true, ok: false, why: 'no-headroom' }
    const blk0 = (() => { try { return b.blockAt(new Vec3(ceiling.x, ceiling.y, ceiling.z)) } catch { return null } })()
    if (!blk0 || !diggableBlock(blk0)) {
      return { tried: true, ok: false, why: 'ceiling-protected', blockedBy: ceiling.name }
    }
    if (!(await digAt(ceiling.x, ceiling.y, ceiling.z))) {
      return { tried: true, ok: false, why: 'dig-failed', blockedBy: ceiling.name }
    }
    dug = 1
    /* 两张方块厚的台阶：头层挖掉了，再上面那格还堵着 ⇒ 人还是站不进去，接着挖它 */
    if (!canStandAtWorld(b, geo.x, geo.standY, geo.z) && geo.above) {
      if (!(await digAt(geo.above.x, geo.above.y, geo.above.z))) {
        return { tried: true, ok: false, why: 'still-blocked', dug, blockedBy: geo.above.name }
      }
      dug += 1
    }
    /* 清完再看能不能站住（读不到世界就当还不能，别硬跳） */
    if (!canStandAtWorld(b, geo.x, geo.standY, geo.z)) {
      return { tried: true, ok: false, why: 'still-blocked', dug, blockedBy: ceiling.name }
    }
    ceiling = null
  }
  /* 起跳：朝台阶中心看，forward + jump 同时按，按住 `ms` 再松手 */
  /* 🔴 2026-10-24 通审：`b._moveGen` 不存在（字段在 core 实例上）⇒ 这里读到的恒是 undefined，
   *    `mine()` 恒真，代次保护等于没写。改走 ctx.moveGenOf。 */
  const gen0 = ctx?.moveGenOf ? ctx.moveGenOf() : null
  const mine = () => (ctx?.moveGenOf ? ctx.moveGenOf() === gen0 : true)
  try { ctx?.stopPathing?.(b) } catch {}
  await sleep(60)
  try { await b.lookAt(new Vec3(geo.x + 0.5, y0 + 0.2, geo.z + 0.5), true) } catch {}
  /* 等朝向真正生效再动（原来只等 60ms，转身包还没到服务端就按 forward ⇒ 朝旧方向撞墙） */
  await sleep(STEP_UP_TURN_MS)
  /* 🔴 2026-11-05 用户反复说「stair 还是上不去 / 每次挖完换个地方挖」。
   *   原来的顺序是「先 jump、再 forward」，等于**从静止起跳**：行走速度约 0.22 格/tick，
   *   而跳跃从离地到升满 1 格只要 2 tick ⇒ 水平只能挪 0.4 格，跨不过 1 格台阶，
   *   正面撞在台阶侧面被弹回（跳了、但没上去，还常被弹开一格 ⇒ 下一轮"换一个地方挖"）。
   *   人类玩家的做法是“走着跳”：先有初速，接触台阶的同时起跳。这里照做，
   *   并短暂开 sprint（5.6 格/秒 ≈ 0.28 格/tick，一次跳跃能跨 3 格，一格绰绰有余）。
   *   助跑段故意短（150ms ≈ 0.3 格）：人本来就在台阶前一格，跑太长会先撞上侧面。 */
  /* 🔴 2026-11-05 实机（用户：「现在又跳不上去了」）：上一版这里开了 sprint。
   *   助跑段只有 150ms，而 sprint 是 5.6 格/秒 ⇒ 3 tick 就冲出去 0.84 格，
   *   人本来就在台阶前一格 ⇒ 先撞在台阶侧面，再起跳时已经被弹开。窄井里更糟。
   *   现在不 sprint，只靠普通行走的初速（0.22 格/tick，助跑 90ms ≈ 0.2 格）：
   *   起跳瞬间已经有速度，接触台阶的同时离地，正好跨上去。 */
  try { b.setControlState('forward', true) } catch {}
  await sleep(STEP_UP_RUNUP_MS)
  try { b.setControlState('jump', true) } catch {}
  await sleep(STEP_UP_JUMP_MS)
  await sleep(geo.partial ? Math.min(ms, 180) : ms)
  try { b.setControlState('jump', false) } catch {}
  /* 落地就立刻继续：固定睡满的话，人早站稳了还在原地干等（每格白付 0.2 秒）。 */
  {
    const tSettle0 = Date.now()
    while (Date.now() - tSettle0 < STEP_UP_SETTLE_MS) {
      if (!mine()) break
      const e = b?.entity
      if (e?.onGround === true && Number(e?.position?.y ?? y0) > y0 + 0.75) break
      await sleep(20)
    }
  }
  if (mine()) {
    try { b.setControlState('forward', false) } catch {}
    try { b.setControlState('sprint', false) } catch {}
  }
  const end = b?.entity?.position ?? start
  const up = Number(end.y) - y0
  const moved = Math.hypot(Number(end.x) - x0, Number(end.z) - z0)
  /* 只认“真的抬高了将近一格”。以前还要求 moved >= 0.25，可是窄井里横向几厘米
   *   就撞墙，位移根本到不了 0.25 —— 明明上去了却报失败（用户 2026-11-05「又跳不上去」）。 */
  const ok = up >= 0.75
  return {
    tried: true, ok,
    up: Math.round(up * 100) / 100,
    moved: Math.round(moved * 100) / 100,
    ...(dug ? { dug } : {}),
    ...(geo.partial ? { partial: true } : {}),
    ...(ok ? {} : { why: 'no-lift' }),
  }
}
/** 往上走要填空的头位数（2 格：脚位 + 头位）；跳起来还要顶上一格净空。 */
/* 2026-10-29：一次步只升 1 层，8 次上限连 8 格都上不去 ⇒ 提到 12。 */
export const MOVE_UP_TRIES = 12
/** 一次 mc_move 里最多补挖几次“头顶挡着垫不了柱”（挖开头顶再让 A* 垫）。 */
export const MOVE_HEAD_TOWER_TRIES = 3

/** A* 下一步要**垫方块往上**、而头顶那两格又堵着？堵着就返回那块的名字。
 *  🔴 2026-10-31 用户：「垫柱子这个为什么现在不能自己挖 2 格然后垫」。
 *  上游 `getMoveUp` 只会“头顶本来就空”时才生成垫柱动作，**它自己不挖**；
 *  而它一旦生成了这个动作，A* 就以为“有路” ⇒ 既不进 NoPath 分支、也进不了脱困阶梯。 */
export function towerHeadBlocked (b) {
  try {
    const path = b?.pathfinder?.path
    if (!Array.isArray(path) || path.length < 2) return null
    const n = path[1]
    if (!n || !Array.isArray(n.toPlace) || n.toPlace.length === 0) return null
    const e = b?.entity?.position
    if (!e) return null
    const fx = Math.floor(e.x), fy = Math.floor(e.y), fz = Math.floor(e.z)
    for (const dy of [1, 2]) {
      const blk = b.blockAt(new Vec3(fx, fy + dy, fz))
      if (blk && blk.boundingBox === 'block') return String(blk.name ?? '方块')
    }
    return null
  } catch { return null }
}

/** 把头顶两格挖开，好让 A* 垫柱子上去。返回挖掉几格。 */
export async function clearHeadForTower (b, { ctx = null, digMs = MOVE_CARVE_DIG_MS } = {}) {
  const e = b?.entity?.position
  if (!e) return 0
  const fx = Math.floor(e.x), fy = Math.floor(e.y), fz = Math.floor(e.z)
  let dug = 0
  for (const dy of [1, 2]) {
    let blk = null
    try { blk = b.blockAt(new Vec3(fx, fy + dy, fz)) } catch { blk = null }
    if (!blk || blk.boundingBox !== 'block') continue
    const nm = String(blk.name ?? '')
    if (!nm || isLiquid(nm) || BRIDGE_FATAL.test(nm)) continue
    if (blk.hardness === -1 || blk.hardness === Infinity) continue
    if (!canBreakNow(b, blk)) {
      try {
        const best = bestToolFor(b, blk)
        if (best?.item && b.heldItem?.type !== best.item.type) await b.equip(best.item, 'hand')
      } catch { /* 换不上就照旧判 */ }
      if (!canBreakNow(b, blk)) continue
    }
    try { if (await digOneGuarded(b, blk, { digMs })) dug++ } catch { /* 忽略 */ }
  }
  return dug
}
/** 一次调用里连续往上挖几层（每层都要挖 2 格 + 跳，太多会吃光预算）。 */
export const MOVE_CLIMB_LEVELS = 12      // 一次连续往上挖几层（受预算限制；旧值 4 太短，30 层的洞要叫十几次）
const CLIMB_UP_MS = 700
const CLIMB_LIFT_MS = 900

/**
 * 往上走：挖开“斜上方”那两格（脚位 + 头位），跳上去一层 —— 与 `stepDown` 对称。
 * 为什么需要：A* 只为水平移动生成动作，`stepUp` 只吃已经存在的 1 格台阶；
 * 目标在头顶好几格、周围又没现成台阶时，它一律给 NoPath。
 * 安全边界与 stepDown 一致：流体不挖、受保护方块不挖、落脚面必须实心，
 * 挖完真上去了才算成功（不看回包、看坐标）。
 */
export async function climbUp (b, target, { allowDig = true, ctx = null, ms = CLIMB_UP_MS, digMs = MOVE_CARVE_DIG_MS, maxLevels = 1 } = {}) {
  /* 2026-10-29（用户：目标在头顶 10 格、y=42 → 52）：本函数只升**一层**，
   *   而 `MOVE_UP_TRIES` 只给 8 次 ⇒ 10 格永远到不了。现在按 `maxLevels` 连续升：
   *   每一层都重算方向（位置变了），一层跳不上去就停。 */
  const start0 = b?.entity?.position
  if (!start0) return { tried: false, why: 'no-bot' }
  const at = (x, y, z) => (() => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } })()
  const y0 = Number(start0.y)
  let dugAll = 0
  let tried = false
  let refused = null
  const rounds = Math.max(1, Number(maxLevels) || 1)
  for (let lv = 0; lv < rounds; lv++) {
    const pos = b?.entity?.position
    if (!pos) break
    const x0 = Number(pos.x), yNow = Number(pos.y), z0 = Number(pos.z)
    const fx = Math.floor(x0), fy = Math.floor(yNow + 0.1), fz = Math.floor(z0)
    /* 🔴 2026-11-05 用户：「单 allowdig 挖一段台阶后，会在最后格挖左后、上方一格的格子，上不去」。
     *   根因：老代码把**四个方向**全塞进候选，于是"主轴那个方向没地板"时它会试**正后方**那侧 ——
     *   那跟自己爬的方向相反，挖开也上不去，只是白挖 3 格。
     *   规矩（与 stair 一致）：**方向锁死，永不考虑正后方**。
     *   - 目标有明确水平朝向 ⇒ 主轴 + 次轴 + 两个侧向，排除正后方；
     *   - 目标正在头顶（水平重合）⇒ 沿用上一层成功的方向（b.__mcClimbDir），
     *     没记忆就用当前朝向；候选只取"前 + 左右"，同样排除正后方。 */
    const tx = Number(target?.x), tz = Number(target?.z)
    const cand = []
    const dx = Number.isFinite(tx) ? Math.sign(Math.round(tx - x0)) : 0
    const dz = Number.isFinite(tz) ? Math.sign(Math.round(tz - z0)) : 0
    if (dx || dz) {
      if (dx) cand.push([dx, 0])
      if (dz) cand.push([0, dz])
      const back0 = [-dx, -dz]
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (d[0] === back0[0] && d[1] === back0[1]) continue
        if (cand.some((c) => c[0] === d[0] && c[1] === d[1])) continue
        cand.push(d)
      }
    } else {
      let front = [0, 0]
      try {
        const memo0 = b?.__mcClimbDir
        if (Array.isArray(memo0) && (memo0[0] || memo0[1])) front = [memo0[0] || 0, memo0[1] || 0]
        else {
          const yaw0 = Number(b?.entity?.yaw ?? NaN)
          if (Number.isFinite(yaw0)) {
            const fxx = -Math.sin(yaw0), fzz = -Math.cos(yaw0)
            front = Math.abs(fxx) >= Math.abs(fzz)
              ? [Math.sign(fxx) || 1, 0]
              : [0, Math.sign(fzz) || 1]
          } else front = [1, 0]
        }
      } catch { front = [1, 0] }
      if (front[0] || front[1]) cand.push(front)
      for (const d of [[front[1] || 0, front[0] || 0], [-(front[1] || 0), -(front[0] || 0)]]) {
        if ((d[0] || d[1]) && !cand.some((c2) => c2[0] === d[0] && c2[1] === d[1])) cand.push(d)
      }
      const back0 = [-front[0], -front[1]]
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (d[0] === back0[0] && d[1] === back0[1]) continue
        if (cand.some((c2) => c2[0] === d[0] && c2[1] === d[1])) continue
        cand.push(d)
      }
    }
    /* 🔴 2026-11-03 用户：「只会挖，不往上走」—— 站在一格高的洞里（头顶是石头）时，
     *   把斜上方挖穿了也**跳不起来**：起跳那一刻人还在本列，脑袋顶到 (fx, fy+2, fz)。
     *    于是每趟都在"挖两格 → 撞头 → 再挖两格"，10 秒过去一格没上。
     *    先把自己头顶那一格清掉（fy+1 本来就是身体占的，能跳过去的是 fy+2）。 */
    const overhead = at(fx, fy + 2, fz)
    if (overhead && overhead.boundingBox === "block" && !/water|lava/.test(String(overhead.name))
      && diggableBlock(overhead) && allowDig) {
      if (await digOneSafe(b, overhead, ctx, digMs)) dugAll += 1
      tried = true
    }
    /* 🔴 2026-11-05 用户：「只用 allowdig 也像 stair 那样会乱挖 —— 挖几下后换个方向挖台阶」。
     *   根因：这个 `for (const [sx, sz] of cand)` 是按“挖得动就试”的顺序换方向的，
     *   而**跳不上去不代表方向错**（是起跳时机/朝向/落点的问题）⇒ 每换一个方向就白挖 3 格，
     *   看起来就是螺旋着乱挖。规矩（与 stair 一致）：**方向一旦定了就锁死**。
     *   - 上一层成功的方向记在 `b.__mcClimbDir`，这一层优先用它；
     *   - 只有“这个方向根本挖不了”（没地面/液体/受保护/挖失败）才换下一个；
     *   - **跳不上去不换方向**（换方向不是解药），直接把 no-lift 报上去。 */
    try {
      const memo = b?.__mcClimbDir
      if (Array.isArray(memo) && (memo[0] || memo[1])) {
        const i = cand.findIndex((c) => c[0] === memo[0] && c[1] === memo[1])
        if (i > 0) cand.unshift(cand.splice(i, 1)[0])
      }
    } catch { /* 假 bot */ }
    let lifted = false
    for (const [sx, sz] of cand) {
      const ax = fx + sx, az = fz + sz
      const floor = at(ax, fy, az), feet = at(ax, fy + 1, az), head = at(ax, fy + 2, az)
      if (!floor || !feet || !head) { refused = refused ?? { why: 'no-world' }; continue }
      if (!solidFloorAt(b, ax, fy, az)) { refused = refused ?? { why: 'no-floor', blockedBy: floor?.name ?? '?' }; continue }
      const need = [feet, head].filter((x) => x.boundingBox === 'block')
      const liquid = need.find((x) => /water|lava/.test(String(x.name)))
      if (liquid) { refused = refused ?? { why: 'liquid', blockedBy: String(liquid.name) }; continue }
      const prot = need.find((x) => !diggableBlock(x))
      if (prot) { refused = refused ?? { why: 'protected', blockedBy: String(prot.name) }; continue }
      if (need.length && !allowDig) { refused = refused ?? { why: 'no-dig' }; continue }
      let dug = 0
      let failed = false
      for (const blk of need) {
        if (await digOneSafe(b, blk, ctx, digMs)) dug += 1
        else { failed = true; break }
      }
      dugAll += dug
      tried = true
      if (failed) { refused = refused ?? { why: 'dig-failed' }; continue }
      /* 🔴 2026-11-03 用户：「挖开的那格有时候会跳不上去」—— 偶发。同一个方向再跳一次
       *   几乎总能上去（第一次多半是起跳时机/还没站稳），所以每方向给两次机会。 */
      let upOk = false
      for (let tryI = 0; tryI < 2 && !upOk; tryI++) {
        /* 🔴 2026-11-05 用户：「每次挖 3 个方块，然后又挖其他地方三个，有时候会走上去」。
         *   每层挖的正是 3 格（自己头顶 1 + 斜上两格），所以现象对上了 —— 是这里。
         *   而 `forward` 是**相对当前朝向**的：本函数从头到尾没转过向，人还朝着 A* 上一条路的方向，
         *   按下去就朝斜后方走，撞墙 ⇒ 跳不上去 ⇒ 外层 continue 重算 ⇒ A* 因世界变了挑另一个方向再挖 3 格。
         *   `stepUp` 早就吃过这个亏（那边有 lookAt + STEP_UP_TURN_MS），这里漏了。 */
        try { await b.lookAt(new Vec3(ax + 0.5, yNow + 0.2, az + 0.5), true) } catch {}
        await sleep(STEP_UP_TURN_MS)
        const gen0 = ctx?.moveGenOf ? ctx.moveGenOf() : null
        const mine = () => (ctx?.moveGenOf ? ctx.moveGenOf() === gen0 : true)
        try { b.setControlState('jump', true) } catch {}
        await sleep(90)
        try { b.setControlState('forward', true) } catch {}
        const t0 = Date.now()
        while (Date.now() - t0 < CLIMB_LIFT_MS) {
          if (!mine()) break
          if (Number(b?.entity?.position?.y ?? yNow) >= fy + 0.75) break
          await sleep(20)
        }
        try { b.setControlState('jump', false) } catch {}
        /* 原来这里固定 `sleep(ms)`（700ms）等落地 —— 一层白等 0.7 秒。
         * 实测落地后 y 会立刻稳定，改成"y 连续两次采样不再变"就往下走，最多仍等 ms。
         * （不要省掉这段等待：人还在空中就开始挖下一层，会挖到自己脚下。） */
        {
          const t1 = Date.now()
          let lastY = Number(b?.entity?.position?.y ?? 0)
          let stable = 0
          while (Date.now() - t1 < ms) {
            await sleep(30)
            const y2 = Number(b?.entity?.position?.y ?? lastY)
            if (Math.abs(y2 - lastY) < 0.02) { stable += 1; if (stable >= 2) break } else stable = 0
            lastY = y2
          }
        }
        try { b.setControlState('forward', false) } catch {}
        if (Number(b?.entity?.position?.y ?? yNow) >= fy + 0.75) upOk = true
        else await sleep(60)
      }
      if (upOk) {
        lifted = true
        try { b.__mcClimbDir = [sx, sz] } catch { /* 假 bot */ }
        break
      }
      refused = { why: 'no-lift', dir: [sx, sz], ...(need.length ? { blockedBy: String(need[0].name) } : { blockedBy: 'air' }) }
      /* 跳不上去 = 时机/朝向问题，换个方向只会白挖 3 格（用户 2026-11-05：「挖几下后换个方向挖台阶」）。 */
      break
    }
    if (!lifted) break
  }
  const endY = Number(b?.entity?.position?.y ?? y0)
  const up = Math.round((endY - y0) * 100) / 100
  if (!tried) return { tried: false, ...(refused ?? { why: 'no-dir' }) }
  if (up >= 0.75) return { tried: true, ok: true, dug: dugAll, up }
  return { tried: true, ok: false, ...(refused ?? { why: 'no-lift' }), dug: dugAll, up }
}

/* ---------------------------------------------------------------------------
 * 往下走：两种下降动作（2026-10-29）
 *
 * 用户原话：「不叫自救，这是正常应该有的功能」—— 同意。**往下走**和往前走、往上走一样，
 * 是 `mc_move` 本来就该有的能力；它只是一直缺着，所以目标在下方时的失败全被显示成“没路/挡住”。
 *
 * 缺它的原因：A*（mineflayer-pathfinder）只为**水平**移动生成“挖穿”动作，`safeOrBreak` 只被
 * 四个水平/跃层生成器调用，**脚下那一格永远不会动** ⇒ 目标在自己下方时，无论 `canDig` 是不是
 * true，A* 都算不出路（直接 NoPath）。往上一直有 `stepUp`（挖一格台阶跳上去），往下没有对应物。
 *   · dropThrough（B）：挖掉脚下一格直接落下去 —— 快，但只允许小落差、且落点必须能站。
 *   · stepDown   （A）：挖开“前方下一层”那两格，人走下去 —— 慢，但不会摔，落点始终是实心。
 * 两者都走同一套安全边界：石头不动、流体不动、受保护方块不动、没有合法落点就不动。
 * ------------------------------------------------------------------------- */
/** B 的落差上限（格）—— 超过 3 格摔下去会掉血，不如慢点走 A。 */
export const MOVE_DROP_MAX = 4
/** 血少的时候只敢掉 3 格（用户定的线：血 <10 就退回 3）。 */
export const MOVE_DROP_MAX_LOW_HP = 3
/** 往下跳的**硬上限**（不管血多满）：再高就不是“跳下去”，是“摔下去”了。 */
export const MOVE_DROP_HARD_MAX = 12
export const MOVE_DROP_MIN_HP = 10

/** 这一次最多敢掉几格：血 <10 ⇒ 3，否则 4。血量读不到就当满血。 */
export function dropMaxOf (b) {
  const hp = Number(b?.health ?? 20)
  /* 🔴 2026-10-30 用户：「它自己搭到半空中后，卡住下不来（柱顶 (20,70,91)，目标 y=63）」——
   *    原来固定“≤4 格才敢跳”，7 格一律拒绝 ⇒ 站在自己垒的柱子上就下不来，只能干等。
   *    MC 摔落伤害 = 落差 − 3（格），按“最多掉当前血量的 40%”反推允许落差：
   *    满血 20 ⇒ 伤害 ≤ 8 ⇒ 落差 ≤ 11；半血 10 ⇒ 落差 ≤ 7；血 6 ⇒ 落差 ≤ 5。
   *    `MOVE_DROP_MAX`（4）当下限，`MOVE_DROP_HARD_MAX` 当硬上限。 */
  const safe = Number.isFinite(hp) ? hp : 20
  const budget = Math.max(0, Math.floor(safe * 0.4))
  const want = budget + 3
  if (!Number.isFinite(want)) return MOVE_DROP_MAX
  if (safe < MOVE_DROP_MIN_HP) return MOVE_DROP_MAX_LOW_HP
  return Math.max(MOVE_DROP_MAX, Math.min(MOVE_DROP_HARD_MAX, want))
}
const DROP_SETTLE_MS = 1_400
const STEP_DOWN_MS = 700
const STEP_DOWN_SETTLE_MS = 1_000

/** 那一格能不能当“磐石”：实心（boundingBox=block）、不是流体、不是床/门这类形状块。 */
function solidFloorAt (b, x, y, z) {
  const blk = (() => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } })()
  if (!blk) return null
  if (blk.boundingBox !== 'block') return null
  if (/water|lava/.test(String(blk.name))) return null
  return blk
}

/* 自己刚放的方块（垫柱/搭桥）三十秒内一律不挖 —— 见 place.mjs 的 noteOwnPlaced。
 *  挖它的后果不是“少一块垫料”，是**人掉回原处**：垫上去 → dropThrough 挖脚下 → 掉下来 → 再垫。 */
export const OWN_PLACED_MS = 30_000
/* 🔴 2026-11-05 用户：「只用 allowdig 会乱挖」「单独 allowdig 是正常的，两者一起才乱挖」——
 *   目标就在正上方时，横向把墙挖穿对“升上去”毫无帮助，只会把路过的地方挖烂。
 *   ⚠ 只在 allowTower 也开着时才拦：用户实测“单独 allowdig 正常”，那套一个字都不动。
 *   放模块级是因为两处调用点（补挖 ×2）分别位于不同的 if 块里。 */
export function goalStraightUpOf (b, target, allowTower) {
  if (allowTower !== true) return false
  try {
    const pS = b?.entity?.position
    const dyS = Number(target?.y) - Number(pS.y)
    const hzS = Math.hypot(Number(target?.x) - Number(pS.x), Number(target?.z) - Number(pS.z))
    return Number.isFinite(dyS) && Number.isFinite(hzS) && dyS >= 3 && hzS <= 3
  } catch { return false }
}

export function isOwnPlaced (b, pos, withinMs = OWN_PLACED_MS) {
  try {
    const m = b?.__mcPlaced
    if (!m || !pos) return false
    const t = m.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)
    return typeof t === 'number' && Date.now() - t <= withinMs
  } catch { return false }
}

/** 挖一格（和 stepUp 里那段同一套超时/装备处理）。 */
async function digOneSafe (b, blk, ctx, digMs) {
  if (isOwnPlaced(b, blk?.position)) return false
  try { ctx?.stopPathing?.(b) } catch {}
  await sleep(60)
  const TO = Symbol('timeout')
  try {
    const tool = typeof b.pathfinder?.bestHarvestTool === 'function' ? b.pathfinder.bestHarvestTool(blk) : null
    if (tool && typeof b.equip === 'function') {
      await Promise.race([Promise.resolve(b.equip(tool, 'hand')).catch(() => {}), sleep(digMs)])
    }
    const r = await Promise.race([
      Promise.resolve(b.dig(blk, true)).then(() => true, () => false),
      sleep(digMs).then(() => TO),
    ])
    if (r === TO) { try { b.stopDigging?.() } catch {} ; return false }
    return r === true
  } catch { return false }
}

/** B：挖掉自己脚下那一格，直接掉到下一个能站的层。 */
export async function dropThrough (b, target, { allowDig = true, ctx = null, digMs = MOVE_CARVE_DIG_MS } = {}) {
  const e0 = b?.entity?.position
  if (!e0) return { tried: false, why: 'no-bot' }
  const fx = Math.floor(Number(e0.x)), fy = Math.floor(Number(e0.y) + 0.1), fz = Math.floor(Number(e0.z))
  const blk = (() => { try { return b.blockAt(new Vec3(fx, fy - 1, fz)) } catch { return null } })()
  if (!blk) return { tried: false, why: 'no-world' }
  if (blk.boundingBox !== 'block' || /water|lava/.test(String(blk.name))) {
    return { tried: false, why: 'not-solid', at: blk.name }
  }
  /* 脚下这格是我自己刚垫的 ⇒ 挖它等于把刚垫的一格还回去：人掉下去、白花一趟。
   * 落点再好也不挖 —— 要往下走就让 A* 换条路（或等三十秒登记过期）。 */
  if (isOwnPlaced(b, blk.position)) {
    return { tried: true, ok: false, why: 'own-block', blockedBy: blk.name,
      hint: `脚下这块 ${blk.name} 是我自己刚垫上去的，挖掉就等于白垫一趟 —— 不挖。` }
  }
  if (!allowDig || !diggableBlock(blk)) {
    return { tried: true, ok: false, why: 'protected', blockedBy: blk.name }
  }
  /* 落点：往下找第一个“能站”的层（含头位净空）。找不到/太深 ⇒ 不挖。 */
  const maxDrop = dropMaxOf(b)
  let ly = null
  for (let y = fy - 2; y >= fy - maxDrop - 2; y--) {
    const f = solidFloorAt(b, fx, y, fz)
    if (!f) {
      /* 中途碰到水/岩浆（solidFloorAt 对流体返 null）要单独认出来——那不是落点，是坑 */
      const mid = (() => { try { return b.blockAt(new Vec3(fx, y, fz)) } catch { return null } })()
      if (mid && /water|lava/.test(String(mid.name))) {
        return { tried: true, ok: false, why: 'liquid-below', blockedBy: mid.name,
          hint: `脚下挖开会掉进 ${mid.name} —— 不挖。` }
      }
      continue
    }
    ly = y + 1
    break
  }
  if (ly == null) {
    /* 🔴 2026-10-30 用户：「它自己搭到半空中后，卡住下不来」「但是脚下都是实心柱」——
     *    柱子内部每一格的上方都是实心 ⇒ 那个“能站的层”一个都不存在，老逻辑直接 no-landing 放弃。
     *    可是挖掉脚下这一格后人只掉 1 格，站在原来第 2 格上（那格本身就是新的地面）。
     *    判据只看“第 2 格是不是实心可挖”，成立就允许这一挖（一次下 1 格，多叫几次就能下去）。 */
    const b2 = (() => { try { return b.blockAt(new Vec3(fx, fy - 2, fz)) } catch { return null } })()
    if (b2 && b2.boundingBox === 'block' && !/water|lava/.test(String(b2.name)) && diggableBlock(b2)) {
      ly = fy - 1
    } else {
      return {
        tried: true, ok: false, why: 'no-landing', blockedBy: blk.name,
        maxDrop,
        hint: `脚下是 ${blk.name}，可挖开后 ${maxDrop} 格内**没有能站的落点**（再往下是空的/水/岩浆）—— 不挖，得换条路。`,
      }
    }
  }
  if (!await digOneSafe(b, blk, ctx, digMs)) {
    return { tried: true, ok: false, why: 'dig-failed', blockedBy: blk.name }
  }
  const gen0 = ctx?.moveGenOf ? ctx.moveGenOf() : null
  const mine = () => (ctx?.moveGenOf ? ctx.moveGenOf() === gen0 : true)
  const t0 = Date.now()
  while (Date.now() - t0 < DROP_SETTLE_MS) {
    if (!mine()) break
    const e = b?.entity
    if (e?.onGround === true && Number(e?.position?.y ?? fy) < fy - 0.5) break
    await sleep(20)
  }
  const end = b?.entity?.position ?? e0
  const down = Math.round((fy - Number(end.y)) * 100) / 100
  const ok = down >= 0.75
  return { tried: true, ok, dug: 1, down, ...(ok ? {} : { why: 'no-fall' }) }
}

/** A：挖开“前方下一层”的两格（脚位 + 头位），人走下去。落点必须是实心。 */
export async function stepDown (b, target, { allowDig = true, ctx = null, ms = STEP_DOWN_MS, digMs = MOVE_CARVE_DIG_MS } = {}) {
  const start = b?.entity?.position
  if (!start) return { tried: false, why: 'no-bot' }
  const x0 = Number(start.x), y0 = Number(start.y), z0 = Number(start.z)
  const fx = Math.floor(x0), fy = Math.floor(y0 + 0.1), fz = Math.floor(z0)
  const tx = Number(target?.x), tz = Number(target?.z)
  const want = Math.abs(tx - fx) >= Math.abs(tz - fz)
    ? [Math.sign(Math.round(tx - fx)) || 1, 0]
    : [0, Math.sign(Math.round(tz - fz)) || 1]
  const dirs = [[want[0], want[1]], [want[1], want[0]], [-want[0], -want[1]], [-want[1], -want[0]]]
  let pick = null
  for (const [dx, dz] of dirs) {
    if (!dx && !dz) continue
    const nx = fx + dx, nz = fz + dz
    /* “下一层” = 走进去后站在 (nx, fy-1, nz)，地面是 (nx, fy-2, nz)。
     * 地面不实心 ⇒ 这不是台阶是个坑（那是 B 的事），换方向。 */
    if (!solidFloorAt(b, nx, fy - 2, nz)) continue
    const feet = (() => { try { return b.blockAt(new Vec3(nx, fy - 1, nz)) } catch { return null } })()
    const head = (() => { try { return b.blockAt(new Vec3(nx, fy, nz)) } catch { return null } })()
    if (!feet || !head) continue
    const need = [feet, head].filter((x) => x.boundingBox === 'block')
    if (need.some((x) => !diggableBlock(x))) continue
    pick = { nx, nz, need }
    break
  }
  if (!pick) return { tried: false, why: 'no-step' }
  if (!allowDig && pick.need.length) {
    return { tried: true, ok: false, why: 'no-dig', hint: '旁边就是下一层的台阶，但得挖开才能下去；这次是不挖的模式，所以没动。' }
  }
  let dug = 0
  for (const blk of pick.need) {
    if (await digOneSafe(b, blk, ctx, digMs)) dug++
  }
  if (pick.need.length && !dug) return { tried: true, ok: false, why: 'dig-failed' }
  const gen0 = ctx?.moveGenOf ? ctx.moveGenOf() : null
  const mine = () => (ctx?.moveGenOf ? ctx.moveGenOf() === gen0 : true)
  try { ctx?.stopPathing?.(b) } catch {}
  await sleep(60)
  try { await b.lookAt(new Vec3(pick.nx + 0.5, fy - 1.5, pick.nz + 0.5), true) } catch {}
  await sleep(STEP_UP_TURN_MS)
  try { b.setControlState('forward', true) } catch {}
  const t0 = Date.now()
  while (Date.now() - t0 < STEP_DOWN_SETTLE_MS) {
    if (!mine()) break
    const e = b?.entity
    if (e?.onGround !== false && Number(e?.position?.y ?? y0) < y0 - 0.75) break
    await sleep(20)
  }
  if (mine()) { try { b.setControlState('forward', false) } catch {} }
  const end = b?.entity?.position ?? start
  const down = Math.round((y0 - Number(end.y)) * 100) / 100
  const moved = Math.round(Math.hypot(Number(end.x) - x0, Number(end.z) - z0) * 100) / 100
  const ok = down >= 0.75 && moved >= 0.25
  return { tried: true, ok, down, moved, ...(dug ? { dug } : {}), ...(ok ? {} : { why: 'no-step-down' }) }
}

export async function escapeMove (b, goal, step, ctx = {}, extra = {}) {
  try { ctx.stopPathing?.(b) } catch {}
  await sleep(60)                       // 让 pathfinder 的 physicsTick 把控制位松开
  /* 🔴 2026-10-23 审计（移动层报告 A[5]）：这里按 jump/back 时**不看 `_moveGen`** ——
   *    按住的那 320/420ms 里如果被接管（反射层、另一次 move、玩家指令），醒来无条件松手
   *    会把接管者正按着的键松掉。现在记下进来时的号，只在号还是自己的时候才松。 */
  /* 🔴 2026-10-24 通审：`b._moveGen` 不存在（字段在 core 实例上）⇒ 这里读到的恒是 undefined，
   *    `mine()` 恒真，代次保护等于没写。改走 ctx.moveGenOf。 */
  const gen0 = ctx?.moveGenOf ? ctx.moveGenOf() : null
  const mine = () => (ctx?.moveGenOf ? ctx.moveGenOf() === gen0 : true)
  if (step === 'jump') {
    try { b.setControlState('jump', true) } catch {}
    await sleep(MOVE_JUMP_MS)
    if (mine()) { try { b.setControlState('jump', false) } catch {} }
  } else if (step === 'backoff') {
    // 贴墙/贴角时原地重算还是同一条死路 —— 先退开半步再重算
    try { b.setControlState('back', true) } catch {}
    await sleep(MOVE_BACK_MS)
    if (mine()) { try { b.setControlState('back', false) } catch {} }
  }
  else if (step === 'detour') {
    /* 执行顺序（见 `MOVE_ESCAPES_NODIG`）：走开三格换个起点再规划 —— 能绕就别挖。 */
    const d = await detourStep(b, extra.target, { goals: extra.goals ?? null, ctx, budgetMs: extra.detourMs })
    return { detour: d, moved: d?.moved ?? 0, dug: 0 }
  }
  else if (step === 'clearHead') {
    /* 🔴 2026-10-28（用户批准）：不挖那趟**唯一**的脱困动作 —— 清自己头顶。
     *   代价是一格方块，所以只在"跳也跳不动"之后才轮到这里（见 `MOVE_ESCAPES_NODIG`）。
     *   配置把走路挖块彻底关掉（`cfg.walkCanDig === false`）时仍然不动手。
     *
     *   🔴 2026-10-28（用户：「move 在上面的时候自动挖不行吗」）：目标在**上面**时清 2 层
     *   —— 人站在 1 格高的小空间里，`y+1` 常常本来就是空气，真正堵的是 `y+2`；
     *   只清 `y+1` 等于白挖（实机 02:57:34 就是这样，一直不动）。
     *   目标不在上面时仍然只清 1 层：那多半是房顶/洞顶，不该无脑开天窗。 */
    if (ctx?.cfg?.walkCanDig === false) return { dug: 0 }
    const myY = (() => { try { return Math.floor(b.entity.position.y) } catch { return null } })()
    const wantY = Number.isFinite(Number(extra?.target?.y)) ? Math.floor(Number(extra.target.y)) : null
    const levels = (myY != null && wantY != null && wantY > myY) ? 2 : 1
    const dug = await clearHeadCell(b, { digMs: extra.digMs, levels })
    return { dug, clearHead: true, ...(dug ? { clearHeadLevels: levels } : {}) }
  }
  else if (step === 'descend') {
    /* 2026-10-29（用户：「move 还不会自己上下」）：阶梯里的“往下走”，与 climbUp 对称。
     *   目标比自己低 ≥1.5 格才试；先挖脚下直接落（快），再试挖斜下台阶（稳）。
     *   `allowDig` 跟着 allowDig / walkCanDig 走 —— 不挖那趟也能往下跳（dropThrough 会先找现成坑）。 */
    if (extra.target == null) return { dug: 0 }
    const myY = (() => { try { return Number(b.entity.position.y) } catch { return null } })()
    const wantY = Number(extra.target?.y)
    if (!Number.isFinite(myY) || !Number.isFinite(wantY) || myY - wantY < 1.5) return { dug: 0 }
    const digOk = extra.allowDig === true && ctx?.cfg?.walkCanDig !== false && ctx?.cfg?.walkCarveStep !== false
    try {
      const dr = await dropThrough(b, extra.target, { allowDig: digOk, ctx })
      if (dr?.ok) return { dug: Number(dr.dug) || 0, descended: Number(dr.down) || 0, tried: true, how: 'drop' }
      const sd = await stepDown(b, extra.target, { allowDig: digOk, ctx })
      if (sd?.ok) return { dug: Number(sd.dug) || 0, descended: Number(sd.down) || 0, tried: true, how: 'step' }
      return { dug: 0, tried: Boolean(dr?.tried || sd?.tried), why: dr?.why ?? sd?.why ?? null }
    } catch { return { dug: 0 } }
  }
  else if (step === 'climbUp') {
    /* 2026-10-29（用户：目标在头顶 10 格，只报“前方 stone 挡着”）：
     *   卡住时的第三级。目标在头顶 ≥1.5 格才试（否则交给 jump / breakAhead）。
     *   一次连续挖上几层（`MOVE_CLIMB_LEVELS`），不一层一层重算。 */
    const carveOff = extra.allowDig !== true
      || ctx?.cfg?.walkCanDig === false
      || ctx?.cfg?.walkCarveStep === false
    if (carveOff || extra.target == null) return { dug: 0 }
    const myY = (() => { try { return Number(b.entity.position.y) } catch { return null } })()
    const wantY = Number(extra.target?.y)
    if (!Number.isFinite(myY) || !Number.isFinite(wantY) || wantY - myY < 1.5) return { dug: 0 }
    try {
      const cu = await climbUp(b, extra.target, { allowDig: true, ctx, maxLevels: MOVE_CLIMB_LEVELS })
      return { dug: Number(cu.dug) || 0, climbed: Number(cu.up) || 0, tried: cu.tried === true }
    } catch { return { dug: 0 } }
  }
  else if (step === 'breakAhead') {
    /* 2026-10-22 用户「还是能卡住」：前三级（重算 / 跳 / 后退）都不改地形 ——
     *   被 1 格台阶或头顶那格实心**围死**时，三级走完就只剩「认输」。
     *   这一级真动手：朝目标方向挖开挡在脚上/头顶的那一格（同样只挖实心、底下要有支撑、
     *   不碰门/水/岩浆/黑曜石），挖开了由调用方把阶梯清零重走。 */
    /* 🔴 2026-10-22（check-move-progress ⑧″ 抓到）：这里以前只挡 `extra.noDig`（当时字段名），
     *    **不认 `walkCanDig` / `walkCarveStep`** —— 配置把寻路挖块关掉之后，
     *    脱困阶梯第 4 级照样挖，挖到了就把阶梯清零重走 ⇒ 挖穿一路、永不认输（死循环）。
     *    判据必须和 `carveStepAhead` 那段（walkPathfinder 里）**完全一致**：一个口诀没有两处。 */
    const carveOff = extra.allowDig !== true
      || ctx?.cfg?.walkCanDig === false
      || ctx?.cfg?.walkCarveStep === false
    if (carveOff || extra.target == null) return { dug: 0 }
    try {
      const n = await carveStepAhead(b, extra.target, { ignoreRange: true })
      /* 🔴 2026-10-27：只挖通一格（另一格挖不动）时把"还差哪一块"带回去，日志里说清楚。 */
      const half = n > 0 ? (b?.__carveHalfOpen ?? null) : null
      return { dug: Number(n) || 0, halfOpen: half }
    } catch { return { dug: 0 } }
  }
  // 'repath' 不做额外动作：重新 `goto` 本身就是一次重算
}

/**
 * 用 pathfinder 走到目标（**现成的防卡住寻路**：自己绕路、挖穿挡路的方块、垫 1×1 塔、过门）。
 *
 * 返回值保持 `arrived / moved / remaining / stuck / hint` 结构；
 * 上层 `mc_move` 和自主层直接使用；额外带 `via:"pathfinder"` 便于排查。
 */
/* ───────────── 传送门（末地 / 下界 / 末地门） ───────────── */

/**
 * 三种"站进去就会被服务端送走"的方块。
 * 🔴 2026-10-19 用户：「还有把末影传送门视为危险方块」—— 走要塞那一趟就栽在这儿：
 *    传送门格子在 y=-40 与地板同层，寻路器**不肯走进去**（默认 `GoalNear` 半径 1，
 *    它停在外圈 1 格就报"到了"），我最后靠"在门上方垫方块再挖掉让自己掉进去"硬闯过去。
 *    传送门不是危险地形，**是目的地**：这里是唯一出处，走路层据此把目标半径收到 0 并补最后一步。
 */
export const PORTAL_RE = /^(end_portal|end_gateway|nether_portal)$/

/**
 * 目标附近（含脚/头两格、半径 `r`）有没有传送门方块；有就返回**最近那一格**的坐标。
 * @returns {{name:string, x:number, y:number, z:number}|null}
 */
export function portalAt (b, x, y, z, r = 1) {
  const cx = Math.floor(Number(x))
  const cy = Math.floor(Number(y))
  const cz = Math.floor(Number(z))
  if (![cx, cy, cz].every(Number.isFinite)) return null
  const nameAt = (px, py, pz) => { try { return b.blockAt(new Vec3(px, py, pz))?.name ?? null } catch { return null } }
  let best = null
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (const dy of [0, 1, -1]) {
        const n = nameAt(cx + dx, cy + dy, cz + dz)
        if (!n || !PORTAL_RE.test(n)) continue
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2      // 同层优先
        if (!best || d < best.d) best = { name: n, x: cx + dx, y: cy + dy, z: cz + dz, d }
      }
    }
  }
  return best ? { name: best.name, x: best.x, y: best.y, z: best.z } : null
}

/**
 * 目标附近有**末地传送门框架**、目标格却不是传送门方块 ⇒ 门没激活、或被方块填住了
 * （实机常见：以前自动垫柱子把 cobblestone 放进 3×3 内部，人怎么走都进不去）。
 * 返回一句能直接照做的话；门是通的 / 附近压根没框架 ⇒ null。
 */
export function portalBlockedHint (b, x, y, z, r = 2) {
  const cx = Math.floor(Number(x))
  const cy = Math.floor(Number(y))
  const cz = Math.floor(Number(z))
  if (![cx, cy, cz].every(Number.isFinite)) return null
  const at = (px, py, pz) => { try { return b.blockAt(new Vec3(px, py, pz))?.name ?? null } catch { return null } }
  const here = at(cx, cy, cz)
  if (here && PORTAL_RE.test(here)) return null
  let frames = 0
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (const dy of [0, 1, -1]) {
        const n = at(cx + dx, cy + dy, cz + dz)
        if (n === 'end_portal_frame') frames++
        else if (n && PORTAL_RE.test(n)) return null      // 门是通的，不关我事
      }
    }
  }
  if (frames < 3) return null
  const junk = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const dy of [0, 1]) {
        const n = at(cx + dx, cy + dy, cz + dz)
        if (!n || n === 'air' || n === 'cave_air' || n === 'end_portal_frame' || PORTAL_RE.test(n)) continue
        junk.push(`${n}(${cx + dx},${cy + dy},${cz + dz})`)
      }
    }
  }
  return `🔴 附近有**末地传送门框架**，但目标那一格不是传送门方块 —— 门没激活，或被方块填住了${junk.length ? `：${junk.slice(0, 6).join('、')}` : ''}。`
    + '先用 `mc_dig` 把门里（3×3 内部）那几格挖空、框架别动，再 `mc_move` 到门方块那一格。'
}

/** 人现在是不是已经站在传送门里（脚内/头内那格是传送门）。 */
export function inPortalNow (b) {
  const p = b?.entity?.position
  if (!p) return null
  const feet = Math.floor(p.y)
  const head = Math.floor(p.y + (b.entity.eyeHeight ?? 1.62))
  for (const py of [feet, head]) {
    try {
      const n = b.blockAt(new Vec3(Math.floor(p.x), py, Math.floor(p.z)))?.name
      if (n && PORTAL_RE.test(n)) return n
    } catch { /* 读不到就当不在 */ }
  }
  return null
}

/**
 * 最后一步：寻路器只肯走到门旁边，**迈进去**得自己来（朝那格中心转过去，按住前进 + 起跳）。
 * 传送是服务端做的：站在门方块里之后由服务端发 `respawn`/位置包把人送走，
 * 所以这里判"进没进"看的是**维度变了**或**位置瞬移了**，不是看按键。
 */
export async function stepIntoPortal (b, cell, { ms = 700, signal = null, moveGenOf = null } = {}) {
  const dim0 = b?.game?.dimension
  const p0 = b?.entity?.position?.clone?.() ?? null
  const teleported = () => {
    const p1 = b?.entity?.position
    if (!p1 || !p0) return false
    if (b.game?.dimension !== dim0) return true
    return p0.distanceTo(p1) > 8
  }
  if (inPortalNow(b) || teleported()) return { entered: true, already: true }
  const gen0 = moveGenOf ? moveGenOf() : null   // 同上：bot 上没有 _moveGen
  /* 🔴 2026-10-20 审计：这里原来没带 `force=true` —— mineflayer 的 `lookAt` 不带 force 会
   *   `await lookingTask.promise`，那个 promise 只在物理循环发出 look 包时 finish；站着不动时
   *   物理循环 early return（physics.js:158-158）⇒ **永远挂着**。 */
  /* 🔴 2026-10-25 实机（「还是走不进末地传送门」）：实测人常常站在**框架顶上**（比门高一格），
   *   这时水平瞄过去只会贴着框架边沿原地蹭。往下瞄到门格中心才走得下去。 */
  const eyeY = (b?.entity?.position?.y ?? 0) + (b?.entity?.eyeHeight ?? 1.62)
  const aimY = Math.min(Number(cell.y) + 0.5, eyeY - 0.2)
  try { await b.lookAt(new Vec3(cell.x + 0.5, aimY, cell.z + 0.5), true) } catch { /* 转不过去也照样顶 */ }
  const release = () => {
    if (moveGenOf && moveGenOf() !== gen0) return   // 被接管了：别踩掉接管者的控制位
    try { b.setControlState('forward', false) } catch { /* 忽略 */ }
    try { b.setControlState('sprint', false) } catch { /* 忽略 */ }
    try { b.setControlState('jump', false) } catch { /* 忽略 */ }
  }
  /* 两段：先正常走进去；没进就跳一下再走（框架挡脚 / 门在上一层时只靠 forward 进不去）。 */
  const attempts = [{ ms: Math.min(ms, 700), jump: false }, { ms: 450, jump: true }]
  for (const a of attempts) {
    if (teleported()) break
    try {
      b.setControlState('forward', true)
      b.setControlState('sprint', true)
      if (a.jump) b.setControlState('jump', true)
      /* 🔴 2026-10-25：预算见底时 `signal` 已经 abort，`raceAbort` 会立刻抛 ⇒ 700ms 变成 0，
       *   人一动不动就报"没进去"，模型只好再叫一次（实机就是这样反复）。最后一哆嗦不吃打断，
       *   至少给 300ms。 */
      if (signal?.aborted === true) await sleep(Math.min(a.ms, 300))
      else await raceAbort(sleep(a.ms), signal, '走进传送门')
    } catch { /* 被打断也继续走下一段 */ }
    try { b.setControlState('jump', false) } catch { /* 忽略 */ }
  }
  release()
  return { entered: teleported() || Boolean(inPortalNow(b)) }
}

/**
 * 目标点 + `GoalNear` 半径（纯函数，方便单测）。
 * 传送门是**目的地**：半径必须收到 0（人得站在门方块那一格上才会被送走），
 * 否则寻路器在门外 1 格就满足、报"到了"却什么都没发生。
 */
export function goalPointFor ({ target, ty, arriveUsed, portal = null } = {}) {
  if (portal) return { x: portal.x, y: portal.y, z: portal.z, radius: 0, portal: true }
  return {
    x: Math.floor(Number(target?.x)),
    y: ty,
    z: Math.floor(Number(target?.z)),
    radius: Math.max(0, Math.round(Number(arriveUsed ?? 1.6) - 0.6)),
    portal: false,
  }
}

export async function walkPathfinder (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, budgetAsked = null, noTower = true, noBridge = true, intent = 'near', allowDig = false, xz = false } = {}, ctx = {}) {
  const b = self.bot
  endHoverFlight(b)   // 悬停着就别想蹦/走：先恢复重力（否则走路全废，见 endHoverFlight）
  /* 2026-10-18 审计 P1-2：意图决定"到"的标准（arrive / 允许高差） */
  const pre = intentOf(intent)
  const arriveUsed = arrive === 1.6 ? pre.arrive : arrive
  const vertTol = pre.vertTol
  /* 2026-10-18 审计 P1-3：规划耗时 / 实际移动耗时分开记（以前只有一个 ms，看不出"是在算路还是在挪腿"） */
  let plannedAt = null

  /* 🔴 2026-10-29（用户：「move 到一半死了」）：死了就别再走、也别报“卡住”。
   *   死后到重生的那一两秒，entity 还在死的地方悬着、速度为 0，
   *   原来会一路滑到“挂在半空不动”那条文案上。 */
  if (Number(b?.health) <= 0) {
    return {
      arrived: false, reason: 'dead', stuck: false, ms: 0, dead: true,
      hint: '我刚死了（血是 0），还在重生 —— 等活过来站回地面再叫 mc_move；这趟不算“走不通”。',
    }
  }
  const { goals, Movements } = self._pf
  const t0 = Date.now()
  const start = b.entity.position.clone()
  const at = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  /* 🔴 2026-10-22 用户第二条反馈：站在 farmland / 箱子顶 / 门格这类"非满格"方块上时，
   *    `bot.entity.position.y` 是 78.9375，`Math.floor` 会把起点算成 78 —— 而 78 那格
   *    正是 farmland 自己，A* 判定成"人嵌在方块里"，第一步就无解。这里补回实际站的那一格。 */
  const startY = standFeetY(b, start)
  const startRemaining = Math.hypot(start.x - target.x, start.z - target.z)
  /* P0-A（2026-10-17 实机）：`moved` 只有**水平**位移（`Math.hypot(dx, dz)`）—— 那天在要塞里垫
   * 柱子时放方块被拒（vendor `mineflayer-pathfinder/index.js:563` 的 `place_error`：先
   * `setControlState('jump', true)` 再往脚下 `placeBlock`，方块没放成人已经在半空），人从 y=68
   * 掉到 y=47，工具却报 `moved: 4.24` + `hint: 不是走不通，再叫一次` ⇒ 模型又爬又掉第二次
   * （y=33、血 1.9）。**垂直位移必须自己报出来**，否则"掉下去了"和"没走到"在模型眼里一模一样。 */
  const fellOf = (p) => {
    const d = Number(start.y) - Number(p?.y ?? start.y)
    return Number.isFinite(d) && d >= 3 ? Number(d.toFixed(1)) : null
  }
  /* 🔴 2026-10-27 复盘实机会话（726 次 mc_move、97 次「你掉下去了」）：
   *   97 次里只有 13 次真垫过柱子（带 `pillared`），其余全是**正常往下走**（目标本来就在地下/低处，
   *   A* 选了连续下坡）。可 hint 一律写"多半是垫柱子时放方块被拒了" ⇒ 模型把它当事故，
   *   于是原地重爬、绕路，越修越乱。现在把"摔"和"往下走"分开：
   *   · `fell`      = 目标在平/高处，或者这一轮垫过方块却还是掉了 ⇒ 真摔（照旧提示垫柱子）；
   *   · `descended` = 目标本来就在下面（低 2 格以上）且没垫方块 ⇒ 正常下坡，只报数字、不编原因。 */
  const descendsOnPurpose = Number.isFinite(Number(target?.y)) && Number(target.y) <= Number(start.y) - 2
  const fellIsReal = (f) => f != null && !(descendsOnPurpose && !placed)
  const fellInfo = (p) => {
    const f = fellOf(p)
    if (f == null) return {}
    if (!fellIsReal(f)) {
      return { descended: f, descendedFrom: Math.floor(start.y), descendedTo: Math.floor(p.y) }
    }
    return { fell: f, fellFrom: Math.floor(start.y), fellTo: Math.floor(p.y) }
  }
  const fellNote = (p) => {
    const f = fellOf(p)
    if (f == null || !fellIsReal(f)) return ''
    return `🔴 **你掉下去了 ${f} 格**（从 y=${Math.floor(start.y)} 掉到 y=${Math.floor(p.y)}）—— `
      + '多半是垫柱子/搭路时**放方块被服务端拒了**（那一刻人已经在半空）。先看清脚下站稳没有，'
      + '**别对着同一个高度反复爬**。'
  }
  /* 🔴 2026-10-18 审计（用户转来的报告 Bug 2）：`moved` 只有水平位移（`hypot(dx, dz)`）。
   *    掉下去 21 格时它报 4.24（靠 `fell` 补），上一格台阶时它报 0（`fell` 又不触发）——
   *    模型没法从 `moved` 本身看出"我到底是平移了、爬上去了，还是掉下去了"。
   *    现在一次给全：`moved`（水平）/ `movedVertical`（dy，正=上升）/ `moved3d`（三维直线距离）/
   *    `delta: {x,y,z}`。判"有没有进展"要看水平，判"上没上去"看垂直。
   *    2026-10-24 用户「为什么move现在有这么多输出」：删掉与 `moved` 完全重复的 `movedHorizontal`。 */
  const deltaOf = (p) => {
    const dx = Number((Number(p?.x ?? start.x) - start.x).toFixed(2))
    const dy = Number((Number(p?.y ?? start.y) - start.y).toFixed(2))
    const dz = Number((Number(p?.z ?? start.z) - start.z).toFixed(2))
    const horizontal = Number(Math.hypot(dx, dz).toFixed(2))
    return {
      moved: horizontal,
      movedVertical: dy,
      moved3d: Number(Math.hypot(dx, dy, dz).toFixed(2)),
      delta: { x: dx, y: dy, z: dz },
    }
  }
  /** 垂直位移的一句人话（≥1 格才说，平地不算）。 */
  const vertNote = (p) => {
    const d = deltaOf(p)
    if (Math.abs(d.movedVertical) < 1) return ''
    return d.movedVertical > 0
      ? `，垂直上升了 ${Math.abs(d.movedVertical)} 格`
      : `，垂直下降了 ${Math.abs(d.movedVertical)} 格`
  }
  /* 🔴 目标 y 可能是半空（地图/扫描给的是"地表高度"、树冠、别人站的 y）—— 直接朝那个 y 走，
   *    pathfinder 会一路垫方块往上爬（"搭路一直搭到空气上"）。收到底面再走。 */
  /* 🔴 2026-10-22 用户第三条反馈：目标格站不住（门框内侧、只有 1 格净空）时，
   *    `standableY` 只在本柱上下找，找不到就把不可站的 y 原样丢给 A* ⇒ 终点永不成立。
   *    `standPointFor` 会往水平邻域找最近的可站格，并把"改去哪"如实报回去。 */
  /* 🔴 2026-10-23（P0-a，用户 m00634「现有 mc_move 没有把 Pathfinder 的长程能力完整暴露给 AI」）：
   *    `xz` = 只知道"去西边 200 格的那个村子"、**不知道高度**的长程目标。
   *    这种目标不许过 `standPointFor`：它是按"这一格站不住"往水平邻域找邻居的 ——
   *    长程目标的 y 本来就是猜的，让它挪一格等于**替 AI 改了目的地**（而且它只兜 ±1 格，
   *    救不了 y 猜错 10 格的情况）。整列原样交给 A*（`GoalXZ`），到了哪一层由 pathfinder 自己定。 */
  let sp = xz
    ? {
        x: Math.floor(Number(target.x)),
        y: Math.floor(Number(target.y)),
        z: Math.floor(Number(target.z)),
        adjusted: false,
        xz: true,
      }
    : standPointFor(b, target.x, target.y, target.z)
  /* 🔴 2026-10-30（B，用户：「那 allowtower 不是控制纵向吗」「都做」）：
   *    目标是**半空中的一格**（脚下没依附面）时，A* 眼里“通向它的最后一步”不存在 ⇒ 永远 NoPath。
   *    纵向垫柱（allowTower ⇒ getMoveUp）本来就能一路往上垒，前提是**先站到它正下方的可站格**。
   *    ⇒ 分两段走：这一轮先到正下方的底座，到位后换真目标重跑（那一轮 A* 会自己垫上去）。 */
  let padGoalObj = null
  let padBase = null
  let padDone = false
  if (!xz && sp?.noStand === true && ctx?._padDone !== true) {
    const gx0 = Math.floor(Number(sp.x)); const gy0 = Math.floor(Number(sp.y)); const gz0 = Math.floor(Number(sp.z))
    const baseY = standableY(b, gx0, gy0, gz0)
    if (noTower) {
      /* 没开 allowTower：垫不上去。保持老行为（交给 A*），但日志里说清是“半空、不是没路”。 */
      self.log(`⚠️ 目标 (${gx0},${gy0},${gz0}) 是半空、脚下没依附面 —— 没开 allowTower，垫不上去`)
    } else if (Number.isFinite(baseY) && baseY < gy0 && canStandAtWorld(b, gx0, baseY, gz0)) {
      padBase = { x: gx0, y: baseY, z: gz0 }
      padGoalObj = { x: gx0, y: gy0, z: gz0 }
      sp = { ...sp, x: gx0, y: baseY, z: gz0, adjusted: true, noStand: false, padUp: true }
      self.log(`🧱 目标是半空 (${gx0},${gy0},${gz0}) —— 先到正下方底座 (${gx0},${baseY},${gz0})，到位后再垫 ${gy0 - baseY} 格`)
    } else {
      self.log(`⚠️ 目标 (${gx0},${gy0},${gz0}) 是半空，那一列下面也没找到落脚点 —— 垫不过去`)
    }
  }
  const ty = sp.y
  const tyNum = Number.isFinite(Number(ty)) ? Number(ty) : Number(sp.y ?? 0)   // 「靠近」判据要连着垂直一起比
  /* 🔴 2026-10-19 用户：「还有把末影传送门视为危险方块」—— 真正的原因是**目标半径**：
   *    `GoalNear(…, max(0, round(arrive-0.6)))` 默认半径 1，人在门外 1 格就满足 ⇒
   *    "到了但没进去"。目标（或它旁边）是传送门时把半径收到 **0**（必须站在那一格上），
   *    并在到了之后补一步"迈进去"（`stepIntoPortal`）。 */
  /* 🔴 2026-10-25 实机（用户：「还是走不进末地传送门」）：原来这里只要目标是 xz 就直接把 portal 置空，
   *    **只给 x/z 就完全不判传送门**（原写法把 portal 直接置 null）—— `GoalXZ` 到那一列就报"到了"，那最后一步永远不迈，
   *    人站在门外发呆，看着像"门进不去"。门就是"站到某一格上"，xz 也给个 y 探针：
   *    拿自己脚下的 y（xz 分支的 `ty` 是 undefined），半径放到 2 覆盖上下一层。 */
  const portalProbeY = Number.isFinite(Number(ty)) ? Number(ty) : (b?.entity?.position?.y ?? 0)
  const portal = portalAt(b, Math.floor(target.x), portalProbeY, Math.floor(target.z), xz ? 2 : 1)
  const portalBlocked = portal ? null : portalBlockedHint(b, Math.floor(target.x), portalProbeY, Math.floor(target.z))
  let gp = goalPointFor({ target: { x: sp.x, z: sp.z }, ty, arriveUsed, portal })
  /* 🔴 2026-10-22 用户第二条的另一半：`GoalNear` 半径默认 1 格是**三维球**，
   *    人站在半格里（起点被算作 y 下层）时起点本身就在球内 ⇒ A* 一步不走就报"到了"
   *    （`moved: 0` + `arrived: true` 的假成功）。离得还远就把半径收到 0，逼它真走。 */
  if (!xz && !gp.portal && gp.radius > 0) {
    const horiz0 = Math.hypot(start.x - gp.x, start.z - gp.z)
    if (horiz0 > arriveUsed + 0.5) {
      try {
        const probe = new goals.GoalNear(gp.x, gp.y, gp.z, 0)
        if (probe.isEnd(new Vec3(Math.floor(start.x), startY, Math.floor(start.z)))) {
          gp = { ...gp, radius: 0, tightened: true }
        }
      } catch { /* 假 bot 没有真 goals：忽略 */ }
    }
  }
  /* 🔴 2026-10-23（P0-a）：`xz` 用 **`goals.GoalXZ`（只锁水平两维）**替代 `GoalNear`。
   *    原来全仓只有 `GoalNear` 一种 goal ⇒ AI 想"去那一带"必须编一个 y，
   *    编高了 A* 就老老实实垫方块往上爬（"搭路搭到空气里"），编低了就 `NoPath`。
   *    `GoalXZ` 让"到那一列"本身就是目标，y 由 pathfinder 自己决定怎么下去/怎么上去。 */
  /* 命中传送门时不能再用 GoalXZ（它只锁水平两维）—— 得升级成三维精确格，人才能站进去。 */
  const GoalXZ = (xz && !gp.portal) ? goals?.GoalXZ : null
  let goal = GoalXZ
    ? new GoalXZ(gp.x, gp.z)
    : new goals.GoalNear(gp.x, gp.y, gp.z, xz ? 0 : gp.radius)
  // 地形分类（导航 P2，用户 m02868 的"地形分类 + 路径评分"）：
  // **只换权重，不换算法** —— 台阶上把挖穿调便宜一点、沟边把垫方块调便宜一点、
  // 岩浆边一格都不许往下跳。看错了顶多走回原来的路，不会让机器人做危险动作。
  /* 2026-10-18 审计 P1「地形局部重估」：这份只是**出发时**的看法；脱困/挖开台阶之后
   * 世界已经变了，循环里会用 `classifyTerrainCached`（缓存键含脚下坐标，`blockUpdate` 会顶版本号）
   * 再判一次，变了就按新地形重调权重。 */
  let terrain = classifyTerrainCached(b)
  let terrainReeval = 0
  /* 🔴 2026-10-27 用户：「noDig:false 还是优先走现有路线，false 应该直接按最短路线挖」（旧字段名，现 `allowDig:true`）——
   *   以前 `allowDig:true` 只松开 `canDig`，A* 里挖一格的代价仍是 3~8（`src\terrain.mjs` 的
   *   digCost 表），"绕两格"永远比"挖一格"便宜 ⇒ 明明允许挖，它还是绕着走。
   *   ⚠️ 2026-10-31 用户实机撤掉了这条（`mc_move {x:9,y:40,z:82}`，目标在脚下 22 格，`allowDig:true`）：
   *   "挖一格才 0.4 步"会让 A* 眼里"往下掏穿地板"永远最短，于是它先算出一条
   *   **又挖不动脚下、又到不了**的路（报"前方 8,62,82 的脚下是 dirt"），
   *   和另一套"绕不过去"报错来回横跳。用户定的规矩：**一律先绕，绕不过才挖**。
   *   ⇒ `digFirst` 默认关，挖价用地形档案的 3~8（绕一格永远比挖一格便宜）；
   *   要"挖路优先"得显式 `cfg.walkDigFirst:true`，不再由 `allowDig` 顺带打开。 */
  const digFirst = ctx.cfg?.walkDigFirst === true
  const mv = ctx.movements(terrain, { digFirst, allowDig })
  if (!mv) throw new Error('pathfinder 的 Movements 造不出来（插件没挂上？）')
  /* 🔴 2026-10-20 用户：「move 加一个不破坏方块的模式」——
   *    `movements.canDig` 是 A* 唯一的一条"挖穿挡路方块"的路（`movements.js` 的
   *    `getBreakCost`/`safeOrBreak`）。把这一份的 `canDig` 关掉，它就只能绕路 / 跳 / 下蹲过缝 /
   *    搭路，**一格都不挖**。这是 `allowDig !== true` 的第一处（另外两处在脱困重建 Movements 时）。 */
  if (allowDig !== true) mv.canDig = false
  /* 🔴 2026-10-17（用户实机：逃跑时寻路器把方块垫在自己脚下往上爬，一路升到 y=57，越跑越远）：
   *    vendor 的 `allow1by1towers` 默认是 **true**，而**全仓没有任何一处设置过它**
   *    （只出现在两处注释里）⇒ 一直吃的是默认值。赶路时偶尔垫一块无伤大雅，
   *    **逃跑时它是纯亏**：垫脚要停下来、要耗方块、还让你离地面更远。
   *    `noTower: true` 把这条腿关掉 —— 挖穿 / 绕路 / 跳 1 格 / 下蹲过缝**全都还在**，
   *    只是不再"原地把自己顶高"。（⚠️ 别改成清空 `scafoldingBlocks`：那会把 1×1 柱子的
   *    整条 move 也剪掉，掉坑里就真出不来了 —— 见 `src\plugins.mjs` 的注释。） */
  if (noTower) mv.allow1by1towers = false
  /* 🔴 2026-10-29 用户：「加个 allowbridge」——
   *    0.6.41 把 vendor 那三处垫方块入口都收进了 `allow1by1towers`，但“原地往上垒”和
   *    “在坑上垫一格桥过去（getMoveForward）”其实是两件事：爬高危险、搭桥很安全。
   *    现在拆开：`allow1by1towers` 只管往上（getMoveUp / getMoveJumpUp），
   *    `this.allowBridge` 只管水平搭桥（getMoveForward）。默认两边都关。 */
  mv.allowBridge = !noBridge
  if (terrain.kind !== 'flat' && terrain.kind !== 'unknown') {
    self.log(`🧭 脚边是${terrain.text}（${terrain.note}）—— 按这一类调寻路权重`)
  }
  // 🔴 上一次 `mc_dig` 超时可能留下一个还在后台跑的采集任务（它按着 forward、
  //    占着 pathfinder）—— 不先停掉，这次走路会和它抢控制权：实机表现是
  //    "15 秒只挪 0.03 格、reason:stuck"。见 #cancelCollect 的注释。
  if (ctx.collectBusy(b)) {
    self.log('⚠️ 上次的采集任务还在后台跑（超时没停掉）—— 先停掉它再走路')
    await ctx.cancelCollect(b)
  }
  const gen = ctx.beginMove(`walk:${intent}`)   // 领号：这次走路从此是"最新的一次移动"（带上意图，被打断时能点名）
  /* 控制键审计（2026-11-05）：实机「跳的时候没往前走，第二次跳还往后退了一点」——
   *   “谁在按 forward/back/jump”是唯一能一次定因的证据；只记录，不改行为。 */
  const ctrlAudit = startCtrlAudit(b)
  b.pathfinder.setMovements(mv)
  let why = null
  let dug = 0, placed = 0
  /* 🔴 2026-10-24 通审：`b.__carveDigStalled` 是**挂在 bot 上的累计值**，从没人清零 ——
   *    只要历史上有过一次"挖到一半被守卫掐断"，之后**每一次** mc_move 的结果都带着 digStalled，
   *    模型会以为"这次挖也没挖动"。按调用清零，只报这一次的。 */
  try { b.__carveDigStalled = 0 } catch { /* 假 bot */ }
  try { b.__carveTooHard = null } catch { /* 假 bot */ }
  const held0 = heldText(b)
  const snap0 = invSnap(b)     // 垫路会吃掉背包里的方块 —— 走完要如实报"用掉了什么、手上还剩什么"
  /**
   * 垫路/挖路的如实报告：`pillared` 只说了"垫了几块"，模型据此**不知道垫的是泥土**
   * 也不知道手上现在攥着什么（2026-10-07 实机：垫完爬出矿坑后拿着泥土去刨石头）。
   */
  const roadInfo = () => {
    if (!placed) return {}
    const used = invUsed(b, snap0)
    const held = heldText(b)
    return {
      ...(used.length ? { pillaredWith: used[0].name } : {}),
      ...(held !== held0 ? { held, heldBefore: held0 } : {}),
    }
  }
  let emptyNoPath = false
  let pathLen = null                 // 最后一次规划出的剩余路径长度（节点数）
  let pathLenFirst = null            // 这一次调用里第一次规划出的路径长度（用于判断"这趟本来就走不完"）
  let pathResets = 0                 // 本轮 goto（每一轮都归零）
  let pathResetsTotal = 0            // 整次调用
  let lastReset = null               // 最近一次 reset 原因（含"正常重算"那几类），归因用
  const resetReasons = {}
  const BENIGN_RESET = new Set(['goal_updated', 'movements_updated', 'goal_moved', 'chunk_loaded', 'block_updated'])
  /* 🔴 2026-11-05 用户：「如果是可以直接走上去的路，还是会挖吗」——
   *   会（旧写法进门就清头顶）。现在改成：**先让 A* 试一次，它说没路才清**，
   *   旁边有现成楼梯时一格都不挖。 */
  /* 🔴 2026-11-05：`carveNoPathOk` 必须在 `riseMode` / `applyRiseMode` 之前定稿 ——
   *   它原来声明在下面，`let riseMode = … carveNoPathOk …` 在 TDZ 里读它 ⇒
   *   `Error: Cannot access 'carveNoPathOk' before initialization`（实机必炸）。 */
  const carveNoPathOk = allowDig === true && ctx.cfg?.walkCanDig !== false && ctx.cfg?.walkCarveStep !== false
  const onUpdate = (r) => {
    /* 2026-10-18 审计 P1-3：第一次算出路径的时刻 —— 规划耗时 / 实际移动耗时从这里分开计 */
    if (!plannedAt) plannedAt = Date.now()
    if (r?.status && r.status !== 'success') why = r.status
    /* 🔴 2026-10-08 审计③：A* 一个邻居都生成不出来时 `path = []`，vendor 的 `lib/goto.js:22-30`
     *    对**空路径**的 noPath 分支是"无错 resolve"（只有非空路径才 reject NoPath）⇒ 我们拿到
     *    "成功"却离目标很远。旧代码据此报 `preempted`（"不是走不通"），模型于是一遍遍重发同一个
     *    到不了的点。这里把"空路径的 noPath"单独记下来。 */
    if (r?.status === 'noPath' && Array.isArray(r?.path) && r.path.length === 0) emptyNoPath = true
    /* P0-b：只有非空路径才记 —— 空路径 = "一格邻居都生不出来"，那是没路，不是"还剩 0 格"。 */
    if (Array.isArray(r?.path) && r.path.length > 0) {
      pathLen = r.path.length
      if (pathLenFirst == null) pathLenFirst = r.path.length
    }
  }
  const resetSeen = {}
  /* 垫柱失败单独计数：以前只进 resetSeen，从不触发换招 ⇒ 人原地一直跳。 */
  let placeFails = 0
  const placeFailSeen = {}
  const onReset = (reason) => {
    const k = String(reason ?? 'unknown')
    resetSeen[k] = (resetSeen[k] ?? 0) + 1
    if (k === 'place_error' || k === 'place_jump_timeout' || k === 'place_no_rise') {
      placeFails++
      placeFailSeen[k] = (placeFailSeen[k] ?? 0) + 1
    }
    lastReset = k
    if (BENIGN_RESET.has(k)) return
    why = k
    pathResets++; pathResetsTotal++
    resetReasons[k] = (resetReasons[k] ?? 0) + 1
  }
  /* 🔴 2026-10-27（用户：「nodig false 最短现在会挖家，ai 也没意识到要切换」）——
   *   以前只数"挖了几格"，模型看不到**挖掉的是什么** ⇒ 把自家墙/地板/家具拆了也毫无感觉。
   *   `diggingCompleted` 事件带方块，顺手记名字，出口报 `dugBlocks`（top 4）。 */
  const dugNames = new Map()
  const onDig = (blk) => {
    dug++
    const nm = typeof blk?.name === 'string' ? blk.name : null
    /* 🔴 2026-11-03 用户贴回「这一趟挖掉的是 air×6」—— `diggingCompleted` 带的方块是**挖完那刻**
     *   服务端已同步的方块（1.21 上常常已经是 air）⇒ 记下来全是空气，模型还以为自己什么都没挖到。
     *   空气/洞穴空气/虚空空气不进名单（`dug` 次数照记，那是"我确实挖了几次"）。 */
    if (nm && nm !== 'air' && nm !== 'cave_air' && nm !== 'void_air') dugNames.set(nm, (dugNames.get(nm) ?? 0) + 1)
  }
  const dugTop = (n) => [...dugNames.entries()].sort((x, y) => y[1] - x[1]).slice(0, n)
  const dugBlocksOut = () => (dugNames.size ? { dugBlocks: Object.fromEntries(dugTop(4)) } : {})
  /* 挖过 3 格以上就把"挖了啥"写进 hint —— 换成 allowDig:false 还是直接 mc_dig 是 AI 自己的决定，
   *   但至少它得先知道自己动了别人的建筑。 */
  const dugHint = () => {
    if (dug < 3 || !dugNames.size) return ''
    const top = dugTop(3).map(([n, c]) => `${n}×${c}`).join('、')
    return `；⚠️ 这一趟挖掉的是 ${top}（若是自家建筑，改用 allowDig:false，或直接 mc_dig 点名要挖的方块）`
  }
  const onBlock = (oldB, newB) => { if (oldB && newB && oldB.boundingBox !== 'block' && newB.boundingBox === 'block') placed++ }
  // ⚠️ 事件名要防着"假 bot"（自检里的最小物理 bot 没有 on/removeListener）
  const off = []
  const listen = (ev, fn) => { if (typeof b.on === 'function') { b.on(ev, fn); off.push([ev, fn]) } }
  listen('path_update', onUpdate); listen('path_reset', onReset)
  listen('diggingCompleted', onDig); listen('blockUpdate', onBlock)
  /* P0-1：一次 `goto` 到底不够 —— 卡住时按阶梯换策略再试（见上面的常量注释）。
   * 每一轮都是**全新的 `goto(同一个 goal 对象)`**：重发前先由 `escapeMove` 把上一轮真停掉，
   * 所以不会攒下重复的 `goal_reached` 监听器。 */
  /* 跨调用接着升级（2026-10-23，见 `MOVE_ESCAPES_DIG` 的注释）：同一个目标 90 秒内又叫一次，
   * 就从上次卡住的那一级继续，而不是从第 1 级重来 —— 否则 AI 连叫五次等于白试五遍同一套。
   * 状态挂在 bot 上（`b._movePlan`）：重连换了 bot 实例就自动清零，不用额外清理。 */
  /* 🔴 2026-10-31（见 `orderEscapesFor` 的注释）：阶梯的招**按眼前的诊断排序** ——
   *    柱顶上先试"往下挖/跳"，而不是先白算两遍路径。集合不变，只换顺序。 */
  const steps = orderEscapesFor(escapeDiagOf(b, target), escapeStepsFor(allowDig))
  let planFrom = 0
  try {
    const prevPlan = b?._movePlan
    if (prevPlan && Date.now() - Number(prevPlan.at ?? 0) < MOVE_PLAN_TTL_MS
      && Math.hypot(Number(prevPlan.target?.x) - Number(target.x), Number(prevPlan.target?.z) - Number(target.z)) <= MOVE_PLAN_SAME_R) {
      /*  记的是「下次该从第几级起」（见 `markPlan`）：试过第 2 级就记 3，别重复同一套。
       * 🔴 2026-11-02 审计（#25）：**光记序号不够** —— 阶梯每次都用 `orderEscapesFor` 按眼前
       *   诊断重排（往上走时把 `descend` 押到最后、柱顶上把 `descend` 提到最前），
       *   同一个数字在两次调用里指的动作可能完全不同（"接着往下试"其实跳过了真正该试的那级）。
       *   所以优先按**动作名**定位，名字不在这一份阶梯里才退回序号。 */
      const nm = typeof prevPlan.name === 'string' ? prevPlan.name : ''
      const byName = nm ? steps.indexOf(nm) : -1
      planFrom = byName >= 0 ? byName : Math.max(0, Math.min(steps.length, Number(prevPlan.step) || 0))
    }
  } catch { /* 假 bot 没有这个字段 */ }
  const planTried = []
  const markPlan = (i, name) => {
    planTried.push(name)
    /* `name` 是给下一次调用定位用的（见上面 `planFrom` 那段）：没有它就只能靠序号猜。 */
    try { b._movePlan = { target: { x: Number(target.x), y: Number(target.y), z: Number(target.z) }, at: Date.now(), step: i, name: String(name ?? '') } } catch { /* 同上 */ }
  }
  let repathCount = 0
  /* P1：其中有多少次是**因为路径被反复失效**而进阶梯的（不是"没进展"）—— 分开报，
   * 因为给模型的下一步不同：一个该换目标点，一个该先看看世界在变什么。 */
  let pathThrash = 0
  /* 2026-10-18：窄隧道/台阶的"手工补救"（见 `carveStepAhead` 注释）。 */
  let carveTries = 0
  /* 🌉 自动搭路的账：试了几次、一共铺了几格、最后一次为什么没铺成。 */
  let bridgeTries = 0
  /* 🔴 2026-11-03：挡路的实体 ⇒ 不值得停，只值得换条路。记两笔：绕了几次、最后是不是挤过去。 */
  let entityDodges = 0
  let entityDodgeOff = false
  /* 这一次走路里最后挡住我们的活物（只用来在结果/hint 里如实说"路上有什么"，不再是收工理由）。 */
  let hostileSeen = null
  let bridgePlaced = 0
  let bridgeLast = null
  let carved = 0
  /* 🔴 2026-10-24 用户：「在 A* 的格子路线与真实物理控制之间加一个局部运动执行层」——
   *    一格台阶先试着**踩上去**（净空不够时按 allowDig 决定清天花板），而不是把台阶块挖掉。
   *    一次 mc_move 里最多试 `STEP_UP_TRIES` 次。 */
  let stepUpTries = 0
  let stepUpLast = null
  /* 往下走（dropThrough / stepDown）的账：试了几次、最后一次的结果、试过哪种动作。
   * 和“脱困阶梯”（`planTried`）分开记 —— 往下走是正常移动，不是脱困。 */
  let downTries = 0
  let downLast = null
  /* 🔴 2026-10-31：A* resolve 了、可人只在目标那一列却没到那个高度（"到了但差层"）。
   *   置真后交给往下/往上动作一层层挪，不再直接报"先走到同一层"。每轮 goto 前清掉。 */
  let vertStuck = false
  const descendTried = []
  let upTries = 0
  /* 🔴 2026-11-02：`allowDig` 那趟第一刀先爬一刀楼梯（见下面 `upFirst`），只做一次。 */
  let upFirstDone = false
/* 🔴 2026-11-05 两条上升路（A* 的垫柱边 / 我们自己的 climbUp 挖楼梯）怎么配合。
 *   历史：先是"谁先触发谁动手"⇒ 一趟里来回切，人在原地折腾（用户：「挖了几格又往脚下
 *   搭方块，一会换一种反而上不去」）；改成"开局按价锁定整趟"⇒ 又太死（中途空腔/天花板
 *   变了也不改）。用户最终要的是"**配合着来**"，落地成三条：
 *     1. 每种局面有首选：垫一层 = placeCost（地形档案 8~12），挖一层 = 3 格 × digCost（9~24）
 *        ⇒ 两者都可行时比价，便宜的那个当开局方式；
 *     2. **只有事件能改主意**：垫不上去（A* 判 NoPath）/ 挖了两次没升上去 / 垫料用完
 *        —— 绝不按轮次轮换；
 *     3. 防抖：切换后必须真推进过 1 格才允许再切；一趟最多切 2 次（再切就该报"上不去"）。 */
const towerCostOne = Number(mv?.placeCost ?? 0) || 12
const digCostLayer = (Number(mv?.digCost ?? 0) || 4) * 3
const towerAllowed = noTower === false
/** 'tower' = 交给 A* 垫柱；'dig' = 我们自己 climbUp 挖台阶。 */
/* 🔴 2026-11-05 用户：「我是说挖头上两格，再垫脚下两格的那种」——
 *   这是最省的上升手法（2 块方块换 2 格，只花挖 2 格头顶的时间），所以**优先**：
 *   既能垫（allowTower）又能挖（allowDig）⇒ mixed。
 *   价格比较（垫一层 placeCost vs 挖一层 3×digCost）只在“没有头顶可清”时才用得上。 */
/* 头顶这两格清得值不值：空着、或者硬度 ≤3（泥土 0.5 / 石头 1.5）才值得先挖；
 * 深板岩 3、黑曜石 50 —— 那种情况宁可垫（上方本来就空的时候）或改挖台阶。
 * 这是“按 cost 定”的落点：不是拍个固定顺序，而是按“清这格要多久”判。 */
const headOk = (() => {
  try {
    const p = b.entity.position
    const fx = Math.floor(p.x)
    const fy = Math.floor(p.y)
    const fz = Math.floor(p.z)
    for (const oy of [fy + 2, fy + 1]) {
      const blk = b.blockAt(new Vec3(fx, oy, fz))
      if (!blk || blk.boundingBox !== 'block') continue
      if (Number(blk.hardness ?? 0) > 3) return false
    }
    return true
  } catch { return false }
})()
let riseMode = (towerAllowed && carveNoPathOk && headOk) ? 'mixed'
  : (towerAllowed && (!carveNoPathOk || towerCostOne <= digCostLayer) ? 'tower' : 'dig')
let riseSwitches = 0
/** 本方式下已经推进了几格 —— 没推进过不许换方式（防左右横跳）。 */
let riseMoved = 0
/** A* 在这趟里判过 NoPath（垫不上去）—— 再给一次机会才换。 */
let towerFailed = false
let towerRetries = 0   // 垫柱那档"判没路"了几次（两次就允许强制改挖）
/** climbUp 连续几次没升上去。 */
let digFailed = 0
/** 这趟开始时的 y：垫柱是 A* 干的、不会回来通知我们，只能靠“人比开始时高了多少”判推进。 */
const yStartRise = Number(b?.entity?.position?.y ?? NaN)
/**
 * 换上升方式：只有"事件"能调它，且必须满足"上次切换后真的推进过 + 总共不超过 2 次"。
 * @param {string} why 事件描述（会写进日志，用户能看出为什么换）
 * @returns {boolean} 真的换了才 true
 */
/* 🔴 2026-11-05 用户：「两者一起开，一开始就挖台阶（乱挖）…挖一会回到台阶中间垫一下…最后才用垫柱」——
 *   A* 手里同时有“挖”和“垫”两条边，它按单价自己挑（挖一格 ≈4 分 vs 垫一层 8~12 分 ⇒ 永远先挖），
 *   而我们的 riseMode 只管着自己的 climbUp，**根本没管住 A*** ⇒ 表现就是两套混着用。
 *   现在：一次只给 A* 一种上升手段 —— 垫柱档关掉 A* 的挖边，挖台阶档关掉 A* 的垫边。 */
const applyRiseMode = () => {
  try {
    if (riseMode === 'tower' || riseMode === 'mixed') {
      mv.allow1by1towers = true
      mv.canDig = false
    } else {
      mv.allow1by1towers = false
      mv.canDig = carveNoPathOk
    }
  } catch { /* 假 bot / 没有 Movements：忽略 */ }
}
applyRiseMode()
const switchRiseMode = (why, force = false) => {
  /* 🔴 2026-11-05 用户：「allowdig 和 allowtower 还会乱挖」「单独 allowdig 是正常的」——
   *   两者都开时开局按价通常选“垫”，可垫柱一格都没垫上去过 ⇒ riseMoved 永远是 0 ⇒
   *   旧判据**永远不许切换** ⇒ A* 只能不停找别的路 ⇒ 一路横向补挖 = 乱挖。
   *   force 用于“这档已经试过两次仍然失败”。 */
  if (riseSwitches >= 2) return false
  if (riseMoved < 1 && !force) return false
  /* 三态互切：垫那侧（tower/mixed）⇄ 挖台阶（dig）。
   *   垫那侧失败 ⇒ 挖；挖两次没升上去 ⇒ 回垫那侧（能挖就回 mixed，只能垫才回 tower）。 */
  const next = (riseMode === 'dig')
    ? (towerAllowed ? (carveNoPathOk ? 'mixed' : 'tower') : null)
    : (carveNoPathOk ? 'dig' : null)
  if (!next) return false
  if (next === 'tower' && !towerAllowed) return false
  if (next === 'dig' && !carveNoPathOk) return false
  riseMode = next
  riseSwitches++
  riseMoved = 0
  digFailed = 0
  applyRiseMode()      // 改完立刻落到 A* 身上，下一次 goto 就只走新的一侧
  self.log(`↔ 上升方式换成${next === 'tower' ? '垫方块' : '挖台阶'}（${why}）`)
  return true
}
  /* 这趟靠 `climbUp` 往上挖了多少格（结果里报出来，用户才看得出"到底在不在往上走"）。 */
  let climbedUp = 0
  let upLast = null
  /* “头顶挡着垫不了柱”试了几次。 */
  let headTowerTries = 0
  /* 🔴 2026-10-29: carveNoPathOk must be declared BEFORE first use.
   * 0.6.61 used it in headTower (dig head then tower) while it was const 300 lines below,
   * so every mc_move threw ReferenceError in 9ms. Kept here to avoid TDZ. */
  const ascendTried = []
  /* 因"门"重试的次数（用户 2026-10-18 指出缺口）：门开着重算一次就该走通；
   * 连着两轮还卡，说明不是门的事 ⇒ 交给脱困阶梯，别原地空转。 */
  let doorTries = 0
  let watch = null
  /* 执行层开门：规划已经允许穿门（canOpenDoors），但这份 vendor 的 `useOne` 没有执行者 ——
   * 一边走一边探身边有没有关着的门，够得着就按一下。只在移动期间跑，收尾必清。 */
  const doorTimer = setInterval(() => { openNearbyDoor(b).catch(() => {}) }, 400)
  doorTimer.unref?.()
  const doorsAt0 = Number(b.__doorOpens ?? 0)
  /** 脱困次数（P0-1）与路径失效次数（P1）：>0 才报 —— 模型据此知道"这次走得磕磕绊绊"。
   *  外加地形分类（P2）：只有不是平地时才报（平地是默认，报了纯占地方）。
   *  `opts.arrived` —— **到达时**把出发时那份改名成 `terrainAtStart`。到了新位置还叫 `terrain`
   *  会被读成"我现在脚边是这个"：从沟边跨到平地上，它仍写着 `gap`，属**主动误导**。 */
  /* 穿门结果（在 `try` 之前就要声明：`moveInfo()` 闭包要读它） */
  let doorWalk = null
  /** 目标被就近挪过就说清楚（站不住的目标格 → 旁边能站的格）。 */
  const goalFix = sp.adjusted
    ? {
      goalAdjusted: { x: sp.x, y: sp.y, z: sp.z },
      /* 🔴 2026-10-23 实机：目标格站不住时这里会把它挪到邻居 —— 只报 goalAdjusted/goalAskedAt
       *    太隐晦（模型不知道"为什么改"）。补一条结构化原因，和 arrived:false/goal-not-standable 配对。 */
      goalMoved: {
        from: sp.from ?? { x: Math.floor(Number(target.x)), y: Math.floor(Number(target.y)), z: Math.floor(Number(target.z)) },
        to: { x: sp.x, y: sp.y, z: sp.z },
        why: 'target-not-standable',
      },
      goalAskedAt: sp.from ?? { x: Math.floor(Number(target.x)), y: Math.floor(Number(target.y)), z: Math.floor(Number(target.z)) },
    }
    : {}
  /* 一次 `mc_move` 实际能走多少格：疾跑约 4.3 格/秒 × 10 秒预算 ≈ 43 格（已经把开门、
   * 爬台阶、等方块更新这些停顿算进去了，偏保守）。只用来给 AI 一个**量级**（"这趟走不完、
   * 还要三四次"），不是承诺 —— 所以措辞一律写"大约"。 */
  /* 🔴 2026-10-28 参数审计：原来按"疾跑 4.3 格/秒 × 10 秒 = 43 格"估一次调用能走多远 ——
   *    那是**无障碍直线**的理论值。实机会话（726 次 mc_move、1927 格 / 839 秒）算下来只有
   *    **2.3 格/秒**（开门、爬台阶、等方块更新、被怪挡都在里面），估算少报近一半 ⇒
   *    模型以为"再走一次就到"，实际每次都在半路超时。改成"每秒格数 × 这一轮的实际预算"。 */
  /** 还要几次调用：取"直线距离"和"规划出来的路径长度"里大的那个（长路上直线严重low估）。 */
  const estCallsOf = () => {
    try {
      const p = b.entity.position
      const d = Math.hypot(p.x - sp.x, p.z - sp.z)
      const n = Math.max(d, Number(pathLen) || 0, Number(pathLenFirst) || 0)
      return n >= 3 ? Math.max(1, Math.ceil(n / estPerCallOf(budget))) : 0
    } catch { return 0 }
  }
  const moveInfo = (opts = {}) => ({
    ...(xz ? { xz: true } : {}),
    ...(pathLenFirst ? { pathLenPlanned: pathLenFirst } : {}),
    ...(pathLen ? { pathLen } : {}),
    ...(() => { const n = estCallsOf(); return n ? { estCalls: n } : {} })(),
    ...(doorWalk ? { doorWalk } : {}),
    ...goalFix,
    ...(terrain.kind === 'flat' || terrain.kind === 'unknown' ? {}
      : { [opts.arrived ? 'terrainAtStart' : 'terrain']: terrain.kind }),
    ...(() => {
      const n = Number(b.__doorOpens ?? 0) - doorsAt0
      return n > 0 ? { doorsOpened: n } : {}
    })(),
    ...(repathCount ? { repathCount } : {}),
    ...(terrainReeval ? { terrainReeval } : {}),
    ...(carved ? { carved } : {}),
    ...(climbedUp ? { climbedUp } : {}),
    /* 上升方式：用户要能一眼看出这趟是垫上去的还是挖上去的，以及有没有来回切。 */
    ...(riseSwitches > 0 || riseMode === 'dig' ? { riseMode, riseSwitches } : {}),
    ...(stepUpLast ? { stepUp: stepUpLast } : {}),
    ...(downLast ? { down: downLast } : {}),
    ...(descendTried.length ? { descend: [...descendTried] } : {}),
    ...(upLast ? { ascend: upLast } : {}),
    ...(ascendTried.length ? { ascendTried: [...ascendTried] } : {}),
    ...(pathThrash ? { pathThrash } : {}),
    ...(pathResetsTotal >= 1 ? { pathResets: pathResetsTotal, pathResetReasons: { ...resetReasons } } : {}),
    /* 最近一次作废是谁触发的。`goal_updated` / `movements_updated` 这类是“良性”的（不计数），
     * 但它们同样会把 goto 打断 —— 实机里“走不动：路线中途作废”的来源就是它们。 */
    ...(lastReset ? { lastReset } : {}),
    /* 挖/换工具在等回包时被守卫掐断过（见 `MOVE_CARVE_DIG_MS`）：这条路"挖过去"没挖动。 */
    ...(Number(b.__carveDigStalled) > 0 ? { digStalled: Number(b.__carveDigStalled) } : {}),
    /* 2026-10-24 用户实机（挖雪）：挡路的那块**挖不动**——必须单独报，
     *  否则模型只会看到"卡住"，然后一遍遍重试同一条路。 */
    ...(b.__carveTooHard ? { tooHard: b.__carveTooHard } : {}),
    /* 执行顺序试到哪一步（2026-10-23）：`planStep` = 最后试的那一级，`planTried` = 这一趟试过的全部。
     *  AI 看到 `planTried` 里有 breakAhead 就该明白"挖也没用"，别再叫同一个点。 */
    ...(planTried.length ? { planStep: planTried[planTried.length - 1], planTried: [...planTried] } : {}),
    ...(bridgePlaced > 0 ? { bridgePlaced } : {}),
    /* 用户 2026-10-23：走完一步要能看见"头顶是什么"（不然它以为能往上、结果跳不起来）。
     * 走不到、到了、中途放弃都走这条 moveInfo，所以三处结果口径一致。 */
    ...(() => { const a = aboveOf(b); return a ? { above: a } : {} })(),
    /* 🔴 2026-10-28（用户：「卡在半空有没有可能是内部参数的问题」→ 就是）：
     *   以前离地被当成"正常等待"（6 秒宽限），而结果里**没有任何字段**能看出这次是不是
     *   挂在半空 —— 只能靠 hint 猜。现在离地就报 `airborne`（还动不动、垂直速度多少）。 */
    ...(() => {
      const e = b?.entity
      if (!e || e.onGround !== false) return {}
      /* 🔴 2026-10-29 实机（用户：「move 到一半死了」）：死后重生那一两秒 entity 还
       *   悬在原地、速度 0 ⇒ 原来被判成“挂在半空不动”，还让 AI “先落到实地”——人都死了。
       *   死是死，卡是卡，分开报。 */
      if (Number(b.health) <= 0) return { dead: true }
      const v = e.velocity ?? {}
      const vy = Number(v.y) || 0
      const vh = Math.hypot(Number(v.x) || 0, Number(v.z) || 0)
      /* 离地高度：往下找第一个实心面。旧文案读的是 `a.dy`，那个字段**从来没有** ⇒ 永远报“离地 0 格”。 */
      let dy = 0
      try {
        const c = e.position
        const fx = Math.floor(c.x), fy = Math.floor(c.y + 0.1), fz = Math.floor(c.z)
        for (let k = 1; k <= 8; k++) {
          const blk = b.blockAt(new Vec3(fx, fy - k, fz))
          if (!blk) break
          if (blk.boundingBox === 'block') { dy = k - 1; break }
        }
      } catch {}
      /* 🔴 2026-10-29：实机里 `airborne:{vy:-0.08, vh:0}` 被判成"一动不动"，可人其实还在往下掉
   *   （贴着方块/树叶缓降）—— 于是报"挂在半空"并劝模型去挖头顶那格。明显在下落时不算挂着。 */
  const still = vy > -0.06 && Math.abs(vy) <= MOVE_BUSY_VY_EPS && vh <= MOVE_BUSY_VH_EPS
      return { airborne: { vy: Number(vy.toFixed(2)), vh: Number(vh.toFixed(2)), ...(dy ? { dy } : {}), ...(still ? { still: true, stuckMs: MOVE_BUSY_AIR_MS } : {}) } }
    })(),
  })
  /** 到达时**重算落点地形**：`classifyTerrainCached` 的缓存键含脚下坐标，走到新位置会自动重算，
   *  不用手动清缓存。平地/未知照旧不报（默认值）。 */
  const arrivedTerrain = () => {
    const now = classifyTerrainCached(b)
    if (now.kind === 'flat' || now.kind === 'unknown') return {}
    return { arrivedTerrain: now.kind, ...(now.note ? { arrivedNote: now.note } : {}) }
  }
  try {
    /* `attempt` 手动推进（不在 for 头里自增）："挖开挡路的台阶"是**同一次尝试内的重试**，
     * 不该白吃一级脱困阶梯 —— 2026-10-18 实机加的，见 `carveStepAhead`。 */
    /* 🔴 2026-10-18 实机（用户："你屋里我寻路进不去"的后续验证）：门开着时 A* 规划
     * "穿门那一格"偶尔原地磨到超时（`path_reset: goal_updated` 反复）。
     * 出门这一两步不交给 A*：先看着门中心物理走过去，再让 A* 走剩下的路。 */
    try {
      if (doorOnRoute(b, target, { cells: 2 }) && Date.now() - t0 < budget - 900) {
        const leftMs = Math.max(500, Math.min(1_600, budget - (Date.now() - t0) - 700))
        doorWalk = await walkThroughDoor(b, target, { budgetMs: leftMs, signal: self.abortSignal, moveGenOf: () => self._moveGen })
        if (doorWalk?.passed) self.log(`🚪 从门里走过去（${doorWalk.door ?? '门'}）`)
      }
    } catch {}
    /* 2026-10-19 实机（lessons：`doorWalk:{passed:false, why:"closed"}` 时它直接放弃）：
     * 门没过去 = 再按一次门、再走一次，而不是立刻交给脱困阶梯。 */
    if (doorWalk && doorWalk.passed !== true) {
      try {
        const opened = await openNearbyDoor(b)
        const leftMs2 = Math.max(400, Math.min(1_200, budget - (Date.now() - t0) - 600))
        const again = await walkThroughDoor(b, target, { budgetMs: leftMs2, signal: self.abortSignal, moveGenOf: () => self._moveGen })
        /* `retry` 只在**真按了门**时才标：门本来就开着时 `opened` 是 0，
         * 以前照样标 `retry: true`，读数会让人以为"补按过一次"（2026-10-22 用户看日志提的）。 */
        doorWalk = { ...again, opened: Number(opened) || 0, ...(Number(opened) > 0 ? { retry: true } : { alreadyOpen: true }) }
        if (again?.passed) self.log(`🚪 门没开透，补按 ${opened} 下后走过去了（${again.door ?? '门'}）`)
      } catch {}
    }
    let carveResets = 0   // 挖开挡路方块后"阶梯清零重走"的次数（上限 MOVE_CARVE_RESETS）
    /* 2026-10-27：vendor 中途重置路径后的自动重发计数（见 `MOVE_AUTOREPATH_MAX`）。
     * `autoRepathDLeft` 记上次重发时离目标还有多远 —— 只重发不靠近就是在空转。 */
    let autoRepath = 0
    let autoRepathStall = 0
    let autoRepathDLeft = Infinity
  let kicked = 0
let kickDLeft = null   // 上次续跑时的水平剩余距离（续跑必须换来位移）   // “目标被重设”导致的原地续跑次数（不算失败）
    let attempt = planFrom
    /* 🔴 2026-10-31 实机（柱顶 `mc_move {x:23,y:64,z:93}`，18~66 毫秒就返回、moved:0）：
     *   vendor 的 `goto` 补丁（2026-10-24）把 noPath 从“resolve 空路径”改成了 **reject NoPath**，
     *   而 DSH 侧所有兜底（上台阶 / 往下走 / 往上挖 / 挖开挡路 / 搭桥）全挂在 `emptyNoPath`
     *   （只在 `path_update {status:'noPath'}` 时置真）上 ⇒ **永远等不到** ⇒ 一步都不动。
     *   ⇒ 收到 `NoPath` 也算“没路”，下一轮把兜底阶梯放出来。 */
    let noPathPending = false
    for (;;) {
      /* 🔴 2026-10-24 通审：**脱困阶梯以前不吃预算** —— 每升一级要白等一个 vendor stuck 周期
       *    （3.5 秒）再加动作时间（跳 0.32 / 退 0.42 / 绕 1.6 秒），七级能磨出三十秒，
       *    而 `mc_move` 对外承诺"一次只走 10 秒"。预算见底就如实收工 ——
       *    `planStep` 已经记下升到哪一级，下次同目标调用会从那儿接着升。 */
      if (Date.now() - t0 > budget - MOVE_ESCALATE_MIN_MS) {
        /* 见底就当作"阶梯用完"：走**同一条**收尾路径，这样"眼前挡路的是什么 / 挖掉它"
         * 这些有用的话照样带出去，而不是变成一句笼统的"没走到"。 */
        self.log(`⏱ 预算见底（升到第 ${attempt} 级），先收工 —— 同目标再叫一次会接着升`)
        const err = new Error(`这一轮的 ${Math.round(budget / 1000)} 秒用完了（升到第 ${attempt} 级脱困）`)
        err.mcStuck = true
        err.mcExhausted = true
        err.mcBudgetOut = true
        /* 2026-10-31：明说**还剩哪几级没试**（以前只报"升到第 N 级"，AI 不知道后面还有招）。 */
        err.mcEscapesLeft = steps.slice(Math.max(0, attempt - 1))
        throw err
      }
      if (attempt > 0) {
        const step = escapeStepOf(attempt - 1, steps)
        if (!step) {
          /* 2026-11-02（用户「不要垫，我不是说了只有 allowDig」）：这里原来有一层
           *   "阶梯走完后自动垫一根 1×1 柱"的兜底（2026-10-19 加的，为了治 noTower 默认
           *   之后竖井/楼梯上不去）。它绕过 allowTower 开关、而且默认开 ⇒ 用户不要垫柱
           *   时也会偷偷垫。已删除：垫柱只认显式 `allowTower:true`，往上一格靠 climbUp
           *   挖斜上方那两格；四周全空就如实报"往上挖了 N 次还差几格"。 */
          /* 🔴 2026-10-24 用户：「不要再来一轮，尽快放弃」——
           *    阶梯跑完一轮（每级 0.9~2.4 秒）就如实认输，不把剩下的预算耗在重复同一套招上。 */
          const err = new Error(`脱困阶梯用完了（重算 ${repathCount} 次）还是走不动`)
          err.mcStuck = true
          err.mcExhausted = true
          err.mcEscapesLeft = []          // 2026-10-31：走完了就是走完了，别让 AI 以为还有招
          throw err
        }
        /* 🔴 2026-10-22 用户实机：「跳上方块的时候会悬空，然后再把那个方块挖了」——
         *   这正是"跳跃脱困"（按住 jump `MOVE_JUMP_MS`）在**头顶没有净空**时的样子：人蹦起来顶到
         *   天花板、落回原地（看着就是悬空/原地抖），下一轮还是走不动 ⇒ 掉进"挖开挡路那格"的兜底，
         *   于是旁观到的顺序就成了"跳一下 → 那格方块没了"。
         *   `shaftInfoOf` 本来就是只读探针（净空 / 能不能跳 / 四面通不通）：先量头顶，
         *   跳不起来就别白蹦一次（跳了还会把自己卡住/把地形挖改），直接进下一级脱困。 */
        if (step === 'jump') {
          /* 🔴 2026-10-29 实机：目标在脚下 2 格，人却连跳 5 次（每次 movedVertical 1.25 格）——
           *   目标在下方时"往上跳"只会离目标更远，这一级纯粹烧预算。直接进下一级。 */
          /* 阈值取 0.5（不是 1.5）：实机是 y=67/68 对目标 y=66 —— 只差 1~2 格，
           * 用 1.5 会让"人在 67、目标 66"这种最常见的情形漏过去，照样白跳。 */
          const goalLower = Number.isFinite(Number(target?.y))
            && Number(target.y) < Number(b?.entity?.position?.y ?? 0) - 0.5
          if (goalLower) {
            self.log('⬇️ 目标在下方 —— 跳只会更高，跳过"跳跃脱困"')
            attempt++
            continue
          }
          const sh = shaftInfoOf(b, target)
          if (sh && sh.canJump === false) {
            self.log(`⬆️ 头顶没净空（${sh.ceiling ?? '实心'}）—— 跳也跳不上去，跳过"跳跃脱困"，直接换下一招`)
            attempt++
            continue
          }
        }
        repathCount++
        markPlan(attempt + 1, step)
        self.log(`🔁 走不动了 → 第 ${attempt} 步：${escapeTextOf(step)}（执行顺序 ${steps.indexOf(step) + 1}/${steps.length}，累计重算 ${repathCount} 次）`)
        const em = await escapeMove(b, goal, step, ctx, { target, allowDig, goals })
        /* 2026-10-29：往上挖了一层（纯垂直，水平 0 格）也是进展 ⇒ 清零阶梯、重算再走。 */
        if (step === 'climbUp' && Number(em?.climbed) > 0) {
          carved += Number(em.dug) || 0
          attempt = 0
          self.log(`🧗 往上挖了 ${Number(em.climbed).toFixed(1)} 格（挖开 ${Number(em.dug) || 0} 块）—— 重算再走`)
        }
        /* 2026-10-29：往下走成功（挖开脚下 / 挖斜下台阶）也是进展 ⇒ 清零阶梯、重算再走。 */
        if (step === 'descend' && Number(em?.descended) > 0) {
          carved += Number(em.dug) || 0
          attempt = 0
          self.log(`⬇️ 往下走了 ${Number(em.descended).toFixed(1)} 格（挖开 ${Number(em.dug) || 0} 块）—— 重算再走`)
        }
        if (step === 'breakAhead' && Number(em?.dug) > 0) {
          carved += Number(em.dug)
          carveResets++
          if (carveResets <= MOVE_CARVE_RESETS) attempt = 0
          else self.log(`⛏ 已经"挖开重走" ${carveResets} 次还是走不动 —— 不再清零阶梯，按认输处理`)
          self.log(`⛏ 脱困时挖开了 ${em.dug} 格挡路方块 —— 重算再走`)
          /* 🔴 2026-10-27：挖一格 ≠ 挖通（要 2 格高）。另一半挖不动就把话说全。 */
          if (em?.halfOpen) {
            const hf = em.halfOpen
            self.log(`⛏ 但这根柱子还差一格：${hf.name}（${hf.x},${hf.y},${hf.z}）挖不动 `
              + '—— 通道只有 1 格高，人还是过不去（换个工具或绕路）')
          }
        }
        /* 地形局部重估（2026-10-18 审计 P1）：上一轮可能挖开了台阶/垫了方块/被浆果丛卡过 ——
         * 世界变了，出发时那份地形判断就不再可靠。只重判脚下这一圈（缓存键含坐标），
         * 类别真变了才重建 `Movements`，没有变化就完全不动。 */
        const fresh = classifyTerrainCached(b)
        if (fresh.kind !== terrain.kind && fresh.kind !== 'unknown') {
          terrainReeval++
          self.log(`🧭 脱困后地形变了：${terrain.text} → ${fresh.text}（按新地形重调权重）`)
          terrain = fresh
          const mv2 = ctx.movements(terrain, { digFirst, allowDig })
          if (mv2) {
            if (noTower) mv2.allow1by1towers = false
            mv2.allowBridge = !noBridge
            if (allowDig !== true) mv2.canDig = false
            b.pathfinder.setMovements(mv2)
          }
        }
      }
      /* 🔴 2026-10-31 用户：「move 应该能直接移动到任意地方（填了 allowTower + allowDig:true）」。
       *   背包有整方块时 A* 会规划“垫柱子往上” ⇒ 它认为有路，于是既不走 NoPath
       *   分支、也进不了脱困阶梯；可洞里头顶那两格是实心，`placeBlock` 永远放不上
       *   ⇒ 原地重算到超时。这里先把“要垫但头顶堵着”认下来：**先挖开头顶再让它垫**。 */
      if (!noTower && carveNoPathOk && headTowerTries < MOVE_HEAD_TOWER_TRIES && downBudgetOk(self)) {
        const headBlocked = towerHeadBlocked(b)
        if (headBlocked) {
          headTowerTries++
          try { ctx.stopPathing?.(b) } catch {}
          await sleep(60)
          const dugHead = await clearHeadForTower(b, { ctx })
          if (dugHead > 0) {
            carved += dugHead
            if (!planTried.includes('headTower')) planTried.push('headTower')
            self.log(`🧗 头顶是 ${headBlocked}、垫不了柱 —— 先挖开 ${dugHead} 格，再垫上去`)
            emptyNoPath = false
            attempt++
            continue
          }
        }
      }
      pathResets = 0                               // 本轮重新数（脱困动作自己也会 reset 一次）
      /* 🔴 2026-10-24 通审：`emptyNoPath` 是**上一轮**的结论，跨轮不清零会污染这一轮的
       *    waiting_chunks / NoPath 判定（明明这轮规划出路径了，还按"没路"报）。 */
      emptyNoPath = noPathPending
      noPathPending = false
      const pfT0 = Date.now()
      /* 🔴 2026-10-27 GitHub issue #3：**预算已经用完了就别再发起一次寻路** ——
       *    以前这里无条件 `goto()`，超时守卫拿到的剩余时间是 `Math.max(200, 负数)` = 200ms，
       *    于是每次必然抛「寻路 超时（200ms）」，日志里全是它，也正好是 issue 里那条栈。
       *    发起了也注定走不动（A* 算一次都不止 200ms），只会白烧 200ms + 制造假故障。 */
      const leftMs = budget - (Date.now() - t0)
      if (leftMs < 250) {
        const err = new Error(`这一轮的走路时间（${Math.round(budget / 1000)} 秒）已经用完了`)
        err.mcBudgetOut = true
        throw err
      }
      /* 🔴 2026-10-30 用户：「move 中加实体避让」。走之前先看一眼前方这一小段里挡着谁：
       *    被动的（动物/村民/玩家）停一下等它走开（≤ MOVE_ENTITY_WAIT_MS），
       *    敌对的 / 末影龙那种**不等** —— 站着等只会挨打，如实收工让 AI 决定打还是绕。
       *    注意这与脱困阶梯里的 `entityObstacleAhead` 检查不同：那条是"卡住之后"才说话。 */
      const entScan = () => entityObstacleAhead(b, sp, { cells: MOVE_ENTITY_CELLS, radius: MOVE_ENTITY_RADIUS })
      const entAhead = entScan()
      if (entAhead && shouldDodgeEntity(entAhead)) {
        /* 🔴 2026-11-03 用户（原文）：「不要抛错，直接绕过去。敌对和末影龙都不要」「不要不动和遇到停住」。
         *   以前这里两件事都做反了：敌对的、以及等不到让开的，直接 throw ⇒ 整次 mc_move 收工，
         *   人钉在原地（既不绕也不打，还白挨打）；被动的又白等 900ms。现在一律**不停、不等、不收工**：
         *   停掉当前路径 ⇒ 下一轮按新位置重算（A* 会避开实体所在的格，见 plugins.mjs 的
         *   `exclusionAreasStep` / `entityCost`）；同一条窄道上绕不过去（重算满 `MOVE_ENTITY_DODGE_MAX` 次）⇒ 直接挤过去。 */
        hostileSeen = entAhead
        if (!entityDodgeOff && entityDodges < MOVE_ENTITY_DODGE_MAX) {
          entityDodges++
          self.log(`↩️ ${entityTextOf(entAhead)} —— 换一条路绕开（第 ${entityDodges} 次）`)
          try { ctx.stopPathing?.(b) } catch {}
          await sleep(40)
          continue
        }
        /* 绕不过去：不能因为它就不走了 —— 直接挤/顶着过去，真卡住了交给脱困阶梯。 */
        entityDodgeOff = true
        self.log(`↩️ ${entityTextOf(entAhead)} —— 绕了 ${entityDodges} 次还在挡路，直接过去`)
      }
      let entTimer = null
      /* 🔴 2026-11-05 用户：「一直搭方块，一直没搭上，一直在跳」。垫柱失败以前只记账、
       *   不影响策略：A* 每次重置就再来一次 ⇒ 原地无限跳。连着 MOVE_PLACE_FAIL_MAX 次必须认账：
       *   能换（切去挖）就换，换不了就如实收工（不再一跳一跳地耗完预算）。 */
      if (placeFails >= MOVE_PLACE_FAIL_MAX && riseMode !== 'dig') {
        const seenTxt = Object.entries(placeFailSeen).map(([x, n]) => x + '×' + n).join('、')
        if (switchRiseMode('垫方块连着 ' + placeFails + ' 次没放上（' + seenTxt + '）', true)) {
          placeFails = 0
          for (const x of Object.keys(placeFailSeen)) delete placeFailSeen[x]
        } else {
          self.log('⛔ 垫方块连着 ' + placeFails + ' 次没放上（' + seenTxt + '）—— 换方式也换不了，这趟就到这')
        }
      }
      applyRiseMode()   // 兜一次：确保 A* 拿到的 movements 与当前 riseMode 一致

  const work = b.pathfinder.goto(goal)
      work.catch(() => {})                         // race 可能先结束：别让它变成"未处理拒绝"（会炸宿主）
      // `ctx.watchOpts` 是给离线测试注入假时钟用的（不然一套断言要真等 2.4 秒 × 4 轮）
      /* 2026-10-23 晚（用户实机 mc_sequence 卡死）：脱困阶梯的"重算几次才启动"必须
       * **跟着这次调用的预算走** —— 固定 4 次意味着 10 秒里永远等不到（3.5 秒才判一次）。
       * 够几轮就设几轮，最少 2 轮：10 秒 ⇒ 2 轮，20 秒 ⇒ 4 轮（还是不超过 MOVE_RESET_LIMIT）。 */
      const resetLimitEff = Math.max(2,
        Math.min(MOVE_RESET_LIMIT, Math.floor(budget / MOVE_VENDOR_STUCK_MS)))
      /* 2026-10-24：本轮正在执行第几级脱困，就按那一级的等待时间判卡（便宜招不必等满 2.4 秒）。 */
      const stepNow = attempt > 0 ? escapeStepOf(attempt - 1, steps) : null
      const stuckMsNow = stepNow ? (MOVE_STEP_WAIT_MS[stepNow] ?? MOVE_STUCK_MS) : MOVE_STUCK_MS
      watch = moveProgressWatcher(b, target, {
        stuckMs: stuckMsNow,
        /* 🔴 2026-10-24 通审：这里**漏传 xz** —— 目标只给 x/z（GoalXZ）时，监控器还在用三维距离
         *    判"有没有靠近"，人沿着同一列上下乱爬（垫柱、掉落、挖台阶）也照样算进展 ⇒ 长路永不判卡，
         *    一直磨到预算耗尽。xz 目标一律只量水平（与结果里的 remaining 同口径）。 */
        arrive, ty, xz, resetsOf: () => pathResets, resetLimit: resetLimitEff,
        ...(ctx.watchOpts ?? {}),
      })
      /* 走的过程中也避让：这条路径是"规划那一刻"算的，实体之后才走过来 ⇒ 定期扫一眼，
       * 被非敌对的挡住就主动停（下面 catch 里走"等它走开"那条路，不占脱困阶梯）。 */
      entTimer = setInterval(() => {
        try {
          const e2 = entScan()
          /* 🔴 2026-11-03：不再分敌友、不再等 —— 任何活物挡在前面就换一条路（catch 里重算）。 */
          if (!entityDodgeOff && e2 && shouldDodgeEntity(e2)) { b.__mcEntStop = e2; ctx.stopPathing?.(b) }
        } catch { /* 假 bot / 已断线 */ }
      }, MOVE_ENTITY_PROBE_MS)
      try {
        await Promise.race([
          // 总时间仍以 `budget` 为界（脱困动作也吃时间，所以这里用**剩余**预算）
          raceAbort(withTimeout(work, Math.max(200, leftMs), '寻路'),
            self.abortSignal, '寻路'),
          watch.promise,
        ])
        if (watch) { watch.stop(); watch = null }
        try { clearInterval(entTimer) } catch {}
        /* 🔴 2026-10-30（B）：半空目标的**第一段**（走到正下方底座）跑完了 ⇒ 换成真目标再跑一轮，
         *    这一轮 A* 会从底座用 getMoveUp 一路垫上去，最后站在目标那一格上。 */
        if (padGoalObj && !padDone && padBase) {
          const curP = b.entity.position
          const nearBase = Math.hypot(curP.x - padBase.x, curP.z - padBase.z) <= 1.2
            && Math.abs(curP.y - (padBase.y + 0.5)) <= 1.2
          if (nearBase) {
            padDone = true
            goal = new goals.GoalNear(padGoalObj.x, padGoalObj.y, padGoalObj.z, 0)
            self.log('🧱 到目标正下方了 —— 开始往上垫')
            continue
          }
        }
        /* 🔴 2026-10-24 用户：**A* 直接 NoPath（空路径假成功）时也要有机会做局部几何处理** ——
         *    这种时候 goto 立刻就 resolve 了，根本等不到 2.4 秒的卡住监控器，
         *    于是一格台阶就把整次移动判成"没路可走"。
         *    只在"真没路"时试（`emptyNoPath`），别为别人的到点背锅。 */
        /* 🔴 2026-10-24 用户（导航世界模型）：**未加载 ≠ 空气，更 ≠ 没路** ——
         *    目标那一列读不到方块时，A* 说 NoPath 只是"我看不到"，不是"走不过去"。
         *    以前这里一律报"被墙/水/悬崖挡住"，于是 AI 对着没加载的地方挖一轮，白花 10 秒。 */
        /* 🔴 2026-10-31 用户实机（目标 y=40，人站在 y=62）：A* 说到了、也没报 NoPath，
         *   可人水平就在目标那一列、垂直还差十几层 —— `GoalNear` 是**三维球**，站上层当然不满足，
         *   而 vendor 在"空路径"下一样 resolve。以前这里一路落到下面的 return，把活推回给模型
         *   （模型只会再叫一次同样的目标 ⇒ 两种报错横跳）。
         *   这不是"到了"，是**垂直方向没有路**：记一笔，交给下面的往下/往上动作一层层挪。 */
        if (!emptyNoPath) {
          const pR = b?.entity?.position
          if (pR && Number.isFinite(Number(target?.y))) {
            const dyR = Number(target.y) - pR.y
            const horizR = Math.hypot(pR.x - sp.x, pR.z - sp.z)
            if (Math.abs(dyR) > 1.5 && horizR <= arriveUsed + 1.0) vertStuck = true
          }
        }
        if (emptyNoPath) {
          /* ⚠️ 这里在循环体内，`end` / `left` 是**循环之后**才声明的 const —— 直接引用会
           * 撞 TDZ（ReferenceError），被外层 catch 吞成一句"寻路失败"。自己量一遍。 */
          const endW = b.entity.position
          const leftW = xz
            ? Math.hypot(endW.x - sp.x, endW.z - sp.z)
            : endW.distanceTo(new Vec3(sp.x, ty, sp.z))
          const ctx2 = Math.floor(Number(target.x)), cty2 = Math.floor(Number(target.y)), ctz2 = Math.floor(Number(target.z))
          if (Number.isFinite(ctx2) && Number.isFinite(ctz2) && !blockKnownAt(b, ctx2, Number.isFinite(cty2) ? cty2 : Math.floor(Number(endW?.y ?? 64)), ctz2)) {
            return {
              arrived: false, position: at(endW), ms: Date.now() - t0,
              remaining: Number(leftW.toFixed(2)),
              ...deltaOf(endW),
              via: 'pathfinder', stuck: true, reason: 'waiting_chunks',
              ...roadInfo(), ...moveInfo(), ...fellInfo(endW),
              hint: `${fellNote(endW)}目标那一列**区块还没加载**（我这边读不到方块）—— **不是没路**。`
                + `离目标还有 ${leftW.toFixed(1)} 格：先朝那个方向走几步、或等几秒让区块加载，再叫一次 \`mc_move\`；`
                + '**别在这里挖**（挖开的是空气，白费一次调用）。'
            }
          }
        }
        /* 声明已上移到起步区（避 TDZ）。 */
        if (emptyNoPath && stepUpTries < STEP_UP_TRIES) {
          const carveAllowedNow = carveNoPathOk
          const su = await stepUp(b, target, { allowDig: carveAllowedNow, ctx, cells: MOVE_CARVE_CELLS })
          if (su.tried) {
            stepUpTries++
            stepUpLast = su
            if (su.ok || Number(su.dug) > 0) {
              if (!planTried.includes('stepUp')) planTried.push('stepUp')
              self.log(`🪜 NoPath 但眼前是一格台阶 —— ${su.ok ? '跳上去了' : `清开 ${su.dug} 格`}，重新算路`)
              emptyNoPath = false              // 下一轮重新判，别拿旧结论继续走
              attempt++
              continue
            }
          }
        }
        /* 🔴 2026-10-27（新版实机 session-aa82）：A* 直接说"没路"时，这里以前**只试了"一格台阶"
         *    就收工** —— `blockedAhead` 明明指出了眼前那块石头，却一次都不挖，把活推给模型
         *    手动 `mc_act {mode:"break"}` 再叫一次 mc_move。实机 9 次"没路可走"里 5 次都给了
         *    具体方块坐标，模型只补挖了 2 次，每次多 1~2 次往返、多一轮预算。
         *    ⇒ NoPath 也走一次补挖（和"卡住"那套同一份安全检查：没明确障碍不挖、挖不动就记账、
         *    只认主轴、顺手把头顶那格凑成 2 格高），挖开就重算路。 */
        /* 2026-10-29：A* 没有“往下挖”这种动作 ⇒ 目标在下方时它给不出路。
         *   这不是“卡住后的兜底动作”，是 `mc_move` 本来就该有的**往下走**（与 stepUp 对称）：
         *   没路可走、目标又在脚下 ⇒ 换下降动作（B 快 / A 稳），走下去再重算。
         *   计入单独的一份账（`descendTried`），不混进“脱困阶梯试到第几级”。 */
        if ((emptyNoPath || vertStuck) && carveNoPathOk && downTries < MOVE_DOWN_TRIES && downBudgetOk(self)) {
          const yNow = Number(b?.entity?.position?.y ?? NaN)
          const dyNow = Number(target.y) - yNow
          if (Number.isFinite(dyNow) && dyNow <= -1.5) {
            downTries++
            try { ctx.stopPathing?.(b) } catch {}
            await sleep(60)
            const dr = await dropThrough(b, target, { allowDig: carveNoPathOk, ctx })
            if (dr.ok) {
              if (!descendTried.includes('dropDown')) descendTried.push('dropDown')
              self.log(`🕳 目标在脚下 ${Math.abs(dyNow).toFixed(1)} 格 —— 挖开脚下（落下 ${dr.down} 格），重新算路`)
              downLast = { ok: true, down: dr.down, dug: dr.dug }
              emptyNoPath = false
              vertStuck = false
              attempt++
              continue
            }
            const sd = await stepDown(b, target, { allowDig: carveNoPathOk, ctx })
            if (sd.ok) {
              if (!descendTried.includes('stepDown')) descendTried.push('stepDown')
              self.log(`🪜 目标在脚下 —— 挖斜下台阶下一层（${sd.down} 格），重新算路`)
              downLast = { ok: true, down: sd.down, dug: sd.dug }
              emptyNoPath = false
              vertStuck = false
              attempt++
              continue
            }
            downLast = { ok: false, drop: dr.tried ? (dr.why ?? 'no-fall') : (dr.why ?? 'skip'), step: sd.tried ? (sd.why ?? 'no-step-down') : 'skip' }
          }
        }
        /* 往上走：和往下一样是基础能力。目标在头顶、又没现成台阶 ⇒ A* 一律 NoPath。 */
        const yUp0 = Number(b?.entity?.position?.y ?? NaN)
        const dyUp0 = Number(target.y) - yUp0
        const pUp0 = b?.entity?.position
        const hUp0 = (pUp0 && Number.isFinite(Number(target.x)))
          ? Math.hypot(Number(target.x) - Number(pUp0.x), Number(target.z) - Number(pUp0.z))
          : 99
        /* 🔴 2026-11-02 用户：「只用 allowDig 上地表，它会乱挖」——
         *    目标在头顶、水平就在旁边（≤3 格）时，先让 `climbUp` 切一刀楼梯：
         *    每层只挖斜上两格、规整上升，而不是等 A* 在三维里挑"最便宜的挖法"。
         *    只做一次（`upFirstDone`）：之后照旧交给 A* / 脱困阶梯，
         *    免得跟"旁边就有现成竖井"这种更优解抢路。 */
        /* 🔴 2026-11-05 用户：「allowTower 和 allowDig 同时给会冲突」——
         *    两个开关一起给时，这条"先切一刀楼梯"会抢在 A* 垫柱前面动手：
         *    垫一格只要 1 个方块、不动地形，比挖 2~3 格快得多，却被 climbUp 顶掉，
         *    于是 A* 的垫柱边永远轮不到，两条路互相改对方的世界。
         *    现在分工明确：**能垫柱（noTower === false）就先让 A* 垫**，
         *    不许垫（noTower === true）才由我们先挖。 */
        /* 垫柱成功时是 A* 在悄悄往上走 —— 用“比这趟开始时高了多少”给 riseMoved 补账，
         * 否则防抖规则会认为“垫了这么久一格没动”，永远不许换方式。 */
        if (Number.isFinite(yUp0) && Number.isFinite(yStartRise) && yUp0 >= yStartRise + 1) riseMoved = 1
        /* 🔴 2026-11-05 用户：「只用 allowdig，一开始头顶如果有方块的话会乱挖其他地方的方块，
         *   挖掉头顶方块后就正常了」。
         *   原来 upFirst 只做一次（`!upFirstDone`）：第一刀 climbUp 若因头顶堵着没跳上去，
         *   之后只能等 A* 判 NoPath 才再动手 —— 而 A* 会先给一条**水平绕行**的路，
         *   走到墙边 ⇒ 补挖把水平那面墙挖了 ⇒ 就是“乱挖别处”。
         *   规矩：**只要头顶（fy+2）还被方块堵着**、且目标在头顶（dy ≥ 1.5、水平 ≤3），
         *   每一轮都先走 climbUp（它第一步就是清头顶，再挖斜上），不再只做一次。 */
        const headBlockedNow = (() => {
          try {
            const pp = b?.entity?.position
            if (!pp) return false
            const hb = b.blockAt(new Vec3(Math.floor(pp.x), Math.floor(pp.y) + 2, Math.floor(pp.z)))
            return Boolean(hb && hb.boundingBox === 'block')
          } catch { return false }
        })()
        const upFirst = carveNoPathOk && riseMode === 'dig' && (headBlockedNow || !upFirstDone)
          && Number.isFinite(dyUp0) && dyUp0 >= 1.5 && hUp0 <= 3 && downBudgetOk(self)
        /* 事件 ①：选了垫、A* 却判 NoPath ⇒ 垫不上去，改挖。
         *   2026-11-05 用户：「allowdig + allowtower 还会乱挖」「单独 allowdig 正常」——
         *   垫柱从没成功过时 riseMoved 一直是 0，必须允许“试两次就强制改挖”，
         *   否则一直卡在垫柱档，A* 只能横向找路 = 乱挖。 */
        if ((riseMode === 'tower' || riseMode === 'mixed') && emptyNoPath) {
          towerRetries++
          towerFailed = true
          switchRiseMode('垫不上去（A* 判没路）', towerRetries >= 2)
        }
        /* 事件 ②：连续两次 climbUp 都没升上去 ⇒ 改垫（垫料有、允许垫、预算够）。 */
        if (riseMode === 'dig' && digFailed >= 2) {
          if (!switchRiseMode('挖了两次都没升上去')) digFailed = 0
        }
        if ((emptyNoPath || vertStuck || upFirst) && riseMode === 'dig'
          && upTries < MOVE_UP_TRIES && downBudgetOk(self)) {
          if (upFirst) upFirstDone = true
          const yUp = Number(b?.entity?.position?.y ?? NaN)
          const dyUp = Number(target.y) - yUp
          if (Number.isFinite(dyUp) && dyUp >= 1.5) {
            upTries++
            try { ctx.stopPathing?.(b) } catch {}
            await sleep(60)
            /* 🔴 2026-11-03 用户：「挖开的那格有时候会跳不上去」。曾试过“直井式”（只挖自己头顶
             *   一格就跳，想省两格），**行不通**：挖开头顶那格后，正上方没有任何方块可以落脚，
             *   跳起来只会掉回原格。往上爬必须造出台阶 —— 挖斜上方那一列的脚位+头位，跳过去落在
             *   相邻方块的**顶面**上。所以这里仍然走 `climbUp`（斜梯），不是直井。 */
            const cu = await climbUp(b, target, { allowDig: carveNoPathOk, ctx, maxLevels: MOVE_CLIMB_LEVELS })
            if (cu.ok) {
              if (!ascendTried.includes('climbUp')) ascendTried.push('climbUp')
              self.log(`🧗 目标在头顶 ${dyUp.toFixed(1)} 格 —— 挖开斜上方跳上一层（升了 ${cu.up} 格），重新算路`)
              upLast = { ok: true, up: cu.up, dug: cu.dug }
              climbedUp += Number(cu.up) || 0
              riseMoved += Number(cu.up) || 0
              digFailed = 0
              try { b.__mcClimbed = climbedUp; b.__mcCarved = carved } catch { /* 假 bot */ }
              emptyNoPath = false
              vertStuck = false
              attempt++
              continue
            }
            upLast = { ok: false, up: cu.up ?? 0, why: cu.tried ? (cu.why ?? 'no-lift') : (cu.why ?? 'skip') }
            if (cu.tried) digFailed++
          }
        }
        if (emptyNoPath && carveNoPathOk && carveTries < MOVE_CARVE_TRIES && carved < MOVE_CARVE_TOTAL) {
          const obstacle = obstacleAheadOf(b, target)
          if (obstacle && !goalStraightUpOf(b, target, noTower === false)) {
            carveTries++
            try { ctx.stopPathing?.(b) } catch {}
            await sleep(60)
            const n = await carveStepAhead(b, target, { ignoreRange: true, only: obstacle })
            const half = b.__carveHalfOpen
            if (n > 0) {
              carved += n
              if (!planTried.includes('carveAhead')) planTried.push('carveAhead')
              self.log(half
                ? `⛏ 没路可走，眼前 ${obstacle.name}（${obstacle.x},${obstacle.y},${obstacle.z}）挡着 —— 挖开 ${n} 格，`
                  + `但头顶那块 ${half.name} 挖不动 ⇒ 通道只有 1 格高，还是过不去`
                : `⛏ 没路可走，眼前 ${obstacle.name}（${obstacle.x},${obstacle.y},${obstacle.z}）挡着 —— 挖开 ${n} 格，重新算路`)
              if (half) carveTries = MOVE_CARVE_TRIES   // 另一半挖不动 ⇒ 别在同一根柱子上反复挖
              emptyNoPath = false              // 下一轮重新判，别拿旧结论继续走
              attempt++
              continue
            }
            /* 一格都没挖到：按"卡住"那条的老规矩封顶，别再一次次白等 vendor 的 stuck 周期 */
            carveTries = MOVE_CARVE_TRIES
            if (b.__carveTooHard) {
              if (!planTried.includes('tooHard')) planTried.push('tooHard')
              self.log(`⛏ 没路可走，眼前 ${b.__carveTooHard.name} **挖不动**`
                + `（要 ${b.__carveTooHard.need || '对的工具'}）—— 不硬挖`)
            }
          }
        }
        /* 🌉 自动搭路：挖也过不去、A* 又没路时，开了 allowBridge 就自己铺几格。 */
        if (emptyNoPath && !noBridge && bridgeTries < MOVE_BRIDGE_TRIES && downBudgetOk(self)) {
          const p0 = b?.entity?.position
          const txB = Math.floor(Number(target?.x))
          const tzB = Math.floor(Number(target?.z))
          const straight = Boolean(p0) && Number.isFinite(txB) && Number.isFinite(tzB)
            && (Math.floor(p0.x) === txB || Math.floor(p0.z) === tzB)
          if (straight) {
            bridgeTries++
            try { ctx.stopPathing?.(b) } catch {}
            await sleep(60)
            const br = await bridgeToward(self, b, target, { maxSteps: MOVE_BRIDGE_STEPS })
            bridgeLast = { ok: br.ok === true, placed: br.placed ?? 0, why: br.why ?? null }
            if (br.ok) {
              bridgePlaced += Number(br.placed ?? 0)
              if (!planTried.includes('bridge')) planTried.push('bridge')
              self.log(`🌉 没路可走 —— 朝${br.dirName ?? '目标方向'} 铺了 ${br.placed} 格方块造路，重新算路`)
              emptyNoPath = false
              attempt++
              continue
            }
            if (br.why === 'not-straight') {
              self.log('🌉 想搭路，但方向是斜的（搭路只走直线）—— 先在同一个 x 或 z 上走一段再搭')
              bridgeTries = MOVE_BRIDGE_TRIES
            } else if (br.why === 'too-close') {
              bridgeTries = MOVE_BRIDGE_TRIES
            } else {
              self.log(`🌉 想搭路，没铺成（${br.why ?? '未知'}${br.note ? '：' + br.note : ''}）`)
            }
          }
        }
        break                                      // 正常结束（到了 / 普通失败）⇒ 下面照旧复核距离
      } catch (e) {
        if (watch) { watch.stop(); watch = null }
        try { clearInterval(entTimer) } catch {}
        /* 🔴 2026-10-30（实体避让）：上面那个 350ms 扫描主动停的。
         *   这不是"路不通"，别去占脱困阶梯 —— 被动的等它走开接着走，敌对的直接收工报人。 */
        const entStop = b.__mcEntStop
        if (entStop) {
          b.__mcEntStop = null
          hostileSeen = entStop
          /* 🔴 2026-11-03：被挡住不是“路不通”，也不值得站着等 —— 立刻重算换路。
           *   绕满 `MOVE_ENTITY_DODGE_MAX` 次还挡着 ⇒ 关掉这个扫描，让人直接挤过去（真卡住了自然会进脱困阶梯）。 */
          if (!entityDodgeOff && entityDodges < MOVE_ENTITY_DODGE_MAX) {
            entityDodges++
            self.log(`↩️ ${entityTextOf(entStop)} —— 换一条路绕开（第 ${entityDodges} 次）`)
          } else {
            entityDodgeOff = true
            self.log(`↩️ ${entityTextOf(entStop)} —— 绕不过去，直接挤过去`)
          }
          attempt = Math.max(0, attempt - 1)   // 绕实体不算一级脱困
          continue
        }
        /* 🔴 2026-10-27（用户：「移动老是卡在半空」之二：脚踩实地杵着不动）——
         *   vendor 中途 resetPath 会先 `stateGoal = null` 再 emit `path_stop`，人也跟着
         *   `fullStop()` 站住；以前这里直接 `throw e` ⇒ 整次 mc_move 报"寻路被打断"收工，
         *   明明路还在、目标也没变。这类中断（PathStopped / GoalChanged）现在原地重发
         *   同一个 goal 接着走；连续 `MOVE_AUTOREPATH_STALL` 次都没靠近才交回脱困阶梯。 */
        /* 🔴 2026-10-31 用户实机（`mc_move {allowTower:true,noDig:false,x:9,y:71,z:82}`（旧字段名，现 `allowDig:true`） 上不去）：
         *   三次调用都只跑 99~127ms、`moved:0`，日志全是 `goal_updated`。vendor 的 `setGoal()`
         *   第一件事就是 `resetPath('goal_updated')`，而我们自己的“真停寻路”就是 `setGoal(null)`
         *   —— 并发动作/上一趟收尾各来一下，正在跑的路线就被清空，人还一格没挪。
         *   这类“目标被重设”不是路不通：**只要还是我这一趟（`_moveGen` 没变）就立刻接着跑**，
         *   不占 `MOVE_AUTOREPATH_MAX` 的额度、也不累计 stall（否则 3 次就判“没靠近”，人还没动就被收工）。
         *   有 `MOVE_KICK_MAX` 兜底，真空转也不会无限。 */
        /* 🔴 2026-10-31：`NoPath` 直接进兜底阶梯（见上面 `noPathPending` 的说明）。 */
        if (e?.name === 'NoPath') {
          noPathPending = true
          if (attempt < steps.length) {
            attempt++
            self.log(`🚧 A* 说没路 —— 换下一招（第 ${attempt} 级：${steps[attempt - 1] ?? '?'}）`)
            continue
          }
        }
        if (e?.name === 'PathStopped'
          && (lastReset === 'goal_updated' || lastReset === 'movements_updated')
          && self._moveGen === gen
          && kicked < MOVE_KICK_MAX
          && Date.now() - t0 < budget - MOVE_ESCALATE_MIN_MS) {
          /* 🔴 2026-10-31 实机（“还是不会自己上去”，repathCount:45）：上面那条“立刻接着跑”
           *   会被我们**自己**的脱困阶梯触发（阶梯每一级都先 stopPathing ⇒ setGoal(null) ⇒ goal_updated），
           *   于是续跑 → 又被自己打断 → 再续跑：40 次空转、位置一格没变。
           *   判据补一条：**续跑必须换来位移**，两次 kick 之间没靠近 0.3 格就认定是自激。 */
          const pK = b.entity.position
          /* 🔴 2026-10-30 实机（“第一次为什么垫一个方块就不够了”）：原来只算水平距离，
           *    目标在头顶时垫柱升 2 格、水平纹丝不动 ⇒ 被判成“没动”⇒ 空转/收工。垂直也算。 */
          const dK = Math.hypot(pK.x - sp.x, pK.z - sp.z, pK.y - tyNum)
          if (kickDLeft == null || dK <= kickDLeft - 0.3) {
            kickDLeft = dK
            kicked++
            await sleep(30)
            continue
          }
          self.log("⚠ 续跑也没动位置（剩 " + dK.toFixed(1) + " 格）—— 认定是自己激惹的，不再空转")
        }
        if ((e?.name === 'PathStopped' || e?.name === 'GoalChanged')
          && self._moveGen === gen
          && autoRepath < MOVE_AUTOREPATH_MAX
          && Date.now() - t0 < budget - MOVE_ESCALATE_MIN_MS) {
          const pNow = b.entity.position
          /* 🔴 同一条：目标在头顶时，垫一格升 1 格是真进展，水平距离却不变 ⇒
           *    3 次“没靠近”就交回脱困阶梯（一趟只垫 1~2 格的真因）。垂直也算进展。 */
          const dLeftNow = Math.hypot(pNow.x - sp.x, pNow.z - sp.z, pNow.y - tyNum)
          if (dLeftNow <= autoRepathDLeft - 0.5) {
            autoRepathStall = 0
            autoRepathDLeft = dLeftNow
          } else {
            autoRepathStall++
          }
          if (autoRepathStall <= MOVE_AUTOREPATH_STALL) {
            autoRepath++
            if (autoRepath === 1) {
              self.log(`🔁 vendor 中途把路径重置了（${lastReset ?? why ?? 'path-reset'}）`
                + ' —— 自动重发同一个目标，接着走（不是走不通）')
            }
            await sleep(60)
            continue
          }
          self.log(`🔁 连着重发 ${autoRepathStall} 次都没靠近（还是 ${dLeftNow.toFixed(1)} 格）`
            + ' —— 不再空转，交给脱困阶梯')
        }
        if (e?.mcPathThrash) pathThrash++          // P1：这次是被"路径反复失效"逼进阶梯的
        if (e?.mcStuck) {
          /* 2026-10-18：**阶梯之前**先试一次"挖开挡路的台阶/天花板"（见 `carveStepAhead`）。
           * 2026-10-18 审计后（Bug 3 / Bug 4）：
           *   · 挖**必须服从配置**：`walkCanDig:false`（寻路不许挖）或 `walkCarveStep:false`
           *     （单独关掉这个补救）时，一步都不许挖；
           *   · 该不该动手看**眼前障碍**（`obstacleAheadOf`），不是"离终点还剩几格" ——
           *     目标在 20 格外的台阶，照样卡在眼前这一格上。
           * 挖到了就重跑同一个 `goto`（不算一级脱困）。 */
          /* `allowDig !== true`：`mc_move {allowDig:false}`（默认）是用户点名的"不破坏方块"模式 ——
           * 卡死也不许挖，宁可报 `blockedAhead` 让 AI 自己决定绕路。 */
          const carveAllowed = allowDig === true && ctx.cfg?.walkCanDig !== false && ctx.cfg?.walkCarveStep !== false
          /* 卡住时先按一下门（2026-10-18 实机：门关着，寻路不认 ⇒ 停 8 秒）。
           * 便宜、只读、无副作用：附近没有门就是一个空扫描。 */
          const doorOpened = await openNearbyDoor(b).catch(() => 0)
          /* 🔴 门"通不通" ≠ "这一轮新开了几扇"：门可能早被定时器/AI 开好了，
           *    `openNearbyDoor()` 这时返回 0。只看数量就会误判成"门口没门"，
           *    接着进挖台阶分支 —— 把门旁边的墙挖掉。 */
          const doorAlreadyOpen = doorOpened === 0 && doorAheadOpen(b, target)
          if (doorOpened > 0 || doorAlreadyOpen) {
            if (doorTries < 2) {
              doorTries++
              self.log(doorOpened > 0
                ? `🚪 卡在门口 —— 按开了 ${doorOpened} 扇门，再试一次`
                : '🚪 前方的门本来就开着 —— 重新算路再试一次（不挖墙）')
              attempt = Math.max(0, attempt - 1)   // 不算一级脱困：门开了原地就能继续走
              await sleep(120)                     // 等服务端把"已开门"的碰撞状态同步给客户端
              continue
            }
            /* 门开着重试两轮还是卡：不是门的问题，但**绝不能挖门边的墙**（那多半是把门框拆了）。
             * 直接交给脱困阶梯/失败出口（那里会报 `blockedAhead`/`shaft` 让 AI 决定）。 */
            self.log('🚪 门开着却还是过不去 —— 不挖墙，交给脱困阶梯')
            attempt++
            continue
          }
          /* 🔴 通行方向上还有门（关着/读不到/按不开）⇒ **一律不补挖**：
           *    门前那一格、门框、门槛都不是"挡路的台阶"，挖它们等于拆房子。
           *    交给脱困阶梯/失败出口，让 AI 看见 `blockedAhead`/`shaft` 自己决定。 */
          const doorBlocking = doorOnRoute(b, target)
          if (doorBlocking) {
            self.log(`🚪 前方 ${doorBlocking.name} 在通行路线上 —— 不挖门、门框、门槛，交给脱困阶梯`)
            attempt++
            continue
          }
          /* 🔴 2026-10-24 用户（导航世界模型）：**实体挡路 / 岩浆 不是"方块挡路"** ——
           *    vendor 的实体成本只在生成路径那一刻算一次，怪之后走进通道 A* 并不知道，
           *    表现就是"没墙没台阶却走不动"，然后掉进"挖开挡路那格"的兜底。
           *    这里如实说清是什么挡着，再交给脱困阶梯去绕（它跳/退/侧移都比挖靠谱）。 */
          const entBlocking = entityObstacleAhead(b, target, { cells: 2 })
          if (entBlocking) {
            if (!planTried.includes('entity')) planTried.push('entity')
            self.log(`🧍 前方 ${entBlocking.dist} 格有 ${entBlocking.name} 挡着（不是墙）—— 不挖，试着绕开或等它走`)
            await sleep(260)
            attempt++
            continue
          }
          /* 🔴 2026-10-27：**自己就泡在岩浆里**时前方 3 格必然全是岩浆 ⇒ 这条永远命中 ⇒
           *    脱困阶梯每轮 `continue` 空耗预算，真正该做的（上浮 + 往岸游）一次没做过。
           *    泡着的时候交给 `lavaEscape`（`walkToOnce` 开头），这里不再拦。 */
          const lavaBlocking = inLavaNow(b) ? null : lavaAheadOf(b, target, { cells: 3 })
          if (lavaBlocking) {
            if (!planTried.includes('lava')) planTried.push('lava')
            self.log(`🔥 前方 ${lavaBlocking.dist} 格是 ${lavaBlocking.name} —— 挖不动也跳不过，绕或搭桥`)
            attempt++
            continue
          }
          /* 🔴 2026-10-24 用户：**先认眼前是不是一格台阶** —— 是就试着踩上去，
           *    而不是像 `carveStepAhead` 那样把台阶块本身挖掉（那等于把楼梯削平）。
           *    跳不上去（头顶被堵）时：允许挖就只清挡在落脚位置上方的**那一格**，
           *    不允许挖就如实报 no-headroom，交给后面的阶梯/AI 决定绕行。 */
          if (stepUpTries < STEP_UP_TRIES) {
            const su = await stepUp(b, target, { allowDig: carveAllowed, ctx, cells: MOVE_CARVE_CELLS })
            if (su.tried) {
              stepUpTries++
              stepUpLast = su
              if (su.ok || Number(su.dug) > 0) {
                if (!planTried.includes('stepUp')) planTried.push('stepUp')
                self.log(su.ok
                  ? `🪜 一格台阶 —— 跳上去了（+${su.up} 格，挪了 ${su.moved} 格），重新算路`
                  : `🪜 一格台阶头顶被堵 —— 清开 ${su.dug} 格，重新算路`)
                attempt = Math.max(0, attempt - 1)   // 不算一级脱困：台阶过去了原地就能继续走
                await sleep(120)
                continue
              }
              if (su.why !== 'wall') self.log(`🪜 一格台阶但上不去（${su.blockedBy ?? su.why}）—— 交给后面的脱困阶梯`)
            }
          }
          if (carveAllowed && carveTries < MOVE_CARVE_TRIES && carved < MOVE_CARVE_TOTAL) {
            const end = b.entity.position
            const dNow = Math.hypot(end.x - target.x, end.z - target.z)
            const obstacle = obstacleAheadOf(b, target)
            /* 🔴 2026-10-24 审计（用户第二份）：**没有明确障碍证据就不许挖**。
             *    旧条件 `carveTries === 0` 让"第一次卡住"无条件挖一次 —— 哪怕眼前什么都没有，
             *    也要白等一个 vendor stuck 周期（3.5 秒），10 秒预算里两下就没了。
             *    现在只认 `obstacleAheadOf` 指到的那一格（并把它直接交给 carveStepAhead，
             *    不再重扫），日志与实际挖掉的方块因此一一对应。 */
            if (obstacle && !goalStraightUpOf(b, target, noTower === false)) {
              carveTries++
              try { ctx.stopPathing?.(b) } catch {}
              await sleep(60)
              const n = await carveStepAhead(b, target, { ignoreRange: true, only: obstacle })
              /* 2026-10-23 晚（用户实机）：眼前根本没东西可挖时，别再来第二次 ——
               * 每一次"挖 0 格"都要白等一个 vendor stuck 周期（3.5 秒），
               * 10 秒预算里两下就没了。直接封顶，落到下面的 `attempt++` 换下一招。 */
              if (n <= 0) {
                carveTries = MOVE_CARVE_TRIES
                /* 🔴 2026-10-31：空手挖石头 7.5 秒，一样会让“挖不开”。单独标一级，
                 *    让提示说“这轮时间被挖它吃掉了、直接再叫一次”。 */
                if (b.__carveTooSlow) {
                  if (!planTried.includes('tooSlow')) planTried.push('tooSlow')
                  self.log(`⛏ 挖 ${b.__carveTooSlow.name} 要 ${(Number(b.__carveTooSlow.needMs) / 1000).toFixed(1)} 秒 —— 这一轮的时间被它吃掉了`)
                }
                if (b.__carveTooHard) {
                  if (!planTried.includes('tooHard')) planTried.push('tooHard')
                  self.log(`⛏ 眼前 ${b.__carveTooHard.name} **挖不动**（要 ${b.__carveTooHard.need || '对的工具'}，手上一时半会儿挖不开）—— 不硬挖`)
                } else {
                  self.log('⛏ 这一下没挖到能挖的（前方没挡路的）—— 不重复试，直接换下一招')
                }
              }
              if (n > 0) {
                carved += n
                /* 🔴 2026-10-23 审计（A[3]）：这一下补挖发生在**阶梯之前**，以前完全不记账 ——
                 *    AI 只看到 planTried 里没有 breakAhead，以为"还没挖过"，于是又让模型去挖。
                 *    现在如实记进 planTried（`carveAhead` = 阶梯前那一次），结果里也带 carved 格数。 */
                if (!planTried.includes('carveAhead')) planTried.push('carveAhead')
                /* 🔴 2026-10-27：挖开了脚位、头顶那块却挖不动（水/岩浆/黑曜石/工具不对）——
                 *    通道只有 1 格高，人还是过不去。必须当面说清"差的是哪一块"，
                 *    否则模型会以为"挖了没效果"，再叫一次 mc_move，然后又卡在同一个门口。 */
                const half = b.__carveHalfOpen
                self.log(half
                  ? `⛏ 眼前 ${obstacle.name} 挡路（${obstacle.x},${obstacle.y},${obstacle.z}）—— 挖开了 ${n} 格，`
                    + `但头顶那块 ${half.name}（${half.x},${half.y},${half.z}）挖不动 ⇒ 通道只有 1 格高，还是过不去`
                  : `⛏ 眼前 ${obstacle.name} 挡路（${obstacle.x},${obstacle.y},${obstacle.z}）—— 挖开了 ${n} 格，再试一次`)
                if (half) carveTries = MOVE_CARVE_TRIES   // 另一半挖不动 ⇒ 别在同一根柱子上反复挖
                continue
              }
            }
          }
          if (carveAllowed && carved >= MOVE_CARVE_TOTAL) {
            self.log(`⛏ 已经补挖了 ${carved} 格还是走不动 —— 方向多半不对，停止挖，交给脱困阶梯`)
          }
          attempt++                                // 卡住 ⇒ 下一轮走脱困阶梯
          continue
        }
        throw e
      } finally {
        /* 这一轮 `goto` 的墙钟（含脱困动作之前的等待）—— 见文件头 import 处的说明。
         * `continue` / `throw` 之前都会走到这里。 */
        perfWait('path', Date.now() - pfT0)
      }
    }
    const end = b.entity.position
    // 复核距离要用**收过的 ty**（不然目标 y 在半空时，明明站到它脚下了也会被判成"还差 9 格"）
    const left = xz
      ? Math.hypot(end.x - sp.x, end.z - sp.z)      // xz：那个 y 是猜的，量三维等于量了个寂寞
      : end.distanceTo(new Vec3(sp.x, ty, sp.z))
    /* P1：**到达判定分两轴看** —— 只看三维距离会漏掉一种假成功：水平已经到位、垂直却差着一两格
     * （站在目标正上方/正下方，比如目标格旁边有个坑），三维距离照样小于阈值 ⇒ 被报成"到了"。
     * 水平仍用 `arrive + 1.0`（宽松，允许"到附近"）；垂直卡在 ±1.5 格（一步台阶以内）。 */
    const horiz = Math.hypot(end.x - sp.x, end.z - sp.z)
    const vert = end.y - ty
    /* xz 目标不比高度：GoalXZ 本来就允许"到了那一列、站在哪一层都算"，
     * 拿垂直差判"没到"会把 AI 逼着去猜 y（正好是 P0-a 要治的毛病）。 */
    const vertBad = xz ? false : (vert < -vertTol || vert > vertTol)
    /* 🔴 2026-10-18 审计（用户转来的报告 Bug 1）：判"到没到"**不能先看距离、后看"是不是我的目标"**。
     *    vendor 的 `goal_reached` 是全局事件，别人的移动到点会把我这次 goto 一起 resolve；
     *    只要人恰好落在宽松距离（`arrive + 1.0`）以内，旧代码就直接报 arrived，绕过了 mine 诊断。
     *    现在先算 mine：`mine === false` 一律按"不是我的目标"处理（走下面 goal-reached-elsewhere），
     *    距离只用来区分"插件早报但确实是我的目标"。`mine === null` = 判不了（假 bot 没有真 Vec3）。 */
    const fp = typeof end?.floored === 'function' ? end.floored() : null
    const up1 = fp && typeof fp.offset === 'function' ? fp.offset(0, 1, 0) : null
    /* `GoalXZ` 的 `isEnd` 要求**真的踏进那一列**，比"到这一带"严得多：监工在圈外 1 格就报到达，
     * 这里再拿 `isEnd` 一卡就又变成"插件说到了但还差 2 格"。xz 改用水平距离认账。 */
    const mine = xz
      ? horiz <= arriveUsed + 1.0
      : (!fp || typeof goal?.isEnd !== 'function' ? null : Boolean(goal.isEnd(fp) || (up1 && goal.isEnd(up1))))
    // ⚠️ 现成的插件报"到了"，也**自己核一遍距离**：`goal_reached` 个别情况会早一点
    //    （目标格被占住 / 站在半砖上 / 只到附近），盲信就又变成"谎报 arrived"。
    /* 站在目标点上（≤0.5 格）就不必再问 `isEnd`：GoalNear 的半径本来就允许这一圈。
     * 反过来，只要离得远、又不满足当前 goal，就一律先按"不是我的目标"处理。 */
    /* 🔴 2026-10-23 审计（移动层报告 A[10]）：`sp` 是**方块角坐标**，站在那一格正中间时
     *    水平距离就已经是 0.707 —— 于是 `left <= 0.5` 永远不成立，`onSpot` 是个死条件
     *    （"我确实站在目标格上"这条路根本走不到）。这里单独按**格心**量一次，只给 `onSpot` 用；
     *    `left` / `horiz` 保持原口径不动（那些阈值是照着角坐标调出来的，改了会把之前修好的
     *    "假到达"又放回来）。 */
    const cHoriz = Math.hypot(end.x - (Number(sp.x) + 0.5), end.z - (Number(sp.z) + 0.5))
    const onSpot = cHoriz <= 0.75 && !vertBad
    if (!onSpot && (mine === false || left > arriveUsed + 1.0 || vertBad)) {
      // 🔴 先分清"插件真的早报"还是"别人的 goal_reached 把我这次 goto 一起 resolve 了"。
      //    vendor 的 lib/goto.js:60 监听的是 bot 上的**全局** `goal_reached`，`goalReached()`
      //    连事件带的 goal 参数都不看 ⇒ 自主层的逃跑/跟随同时在走时，**它**到点会顺手把
      //    我这次 goto resolve 掉。实机表现（2026-10-06 打怪实测）：连续 19 次 mc_move
      //    秒返回 `moved=0` + `goal_reached-but-far`，模型被告知"插件说到了但还差 5 格"。
      //    判据：pathfinder 自己用的是 `stateGoal.isEnd(pos.floored())`（index.js:590，
      //    还允许 +1 格），**我自己的 goal 没满足 ⇒ 这次 resolve 必然来自别人的 goal**。
      if (self._moveGen !== gen) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          ...deltaOf(end),
          via: 'pathfinder', stuck: true, reason: 'preempted',
          /* 🔴 2026-11-03 用户：「怎么还是被打断」—— 只说"被另一次移动接管"没法查。把领走最新
           *   号的那个人报出来（`walk:*` = 又一次走路，`dig` = 挖矿，`collect` = 采集，
           *   `swim`/`jump`/`boat` = 当前置自身的移动，`lava` = 岩浆脱困）。 */
          takenBy: String(self._moveGenWho ?? 'unknown'),
          ...roadInfo(), ...moveInfo(), ...fellInfo(end),
          hint: `${fellNote(end)}这次走路被**另一次移动**接管了（旁边有怪时是自保反射先跑，也可能是又发了一次 mc_move）：`
            + `我从 ${startRemaining.toFixed(1)} 格挪到了 ${left.toFixed(1)} 格，但走到目标的是那一份。`
            + (fellOf(end) != null
              ? '**先别急着再叫 mc_move** —— 你刚掉下来，先站稳、看清脚下和四周，再决定往哪走。'
              : '等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。'),
        }
      }
      /* 🔴 2026-10-08 审计③：走到这里 = "goto 无错 resolve 但我没到"，两种成因**必须分开说**：
       *    · `emptyNoPath`：A* 连一个邻居都生成不出来（空路径假成功）⇒ **真没路**，再叫也没用；
       *    · `mine === false`：vendor 的 `goal_reached` 是**全局**事件（`lib/goto.js:60`），
       *      自主层的逃跑/跟随到点时会顺手把我这次 goto resolve 掉 ⇒ 只是被别人的到点顶了。
       *    旧代码两种都报 `preempted` + "不是走不通"，把"死路"说成"再叫一次就行"。 */
      /* P1：**"站错层"要优先于"别人的锅"报出来** —— 水平已经到位（`horiz` 落在"到附近"以内）
       * 却差了 1.5 格以上的高度时，成因是**这一层站错了**，不是"另一次寻路到点把我顶掉"、
       * 也不是"没路"。⚠️ 旧代码在这条路上会一路落进下面 `mine === false` 那条诊断：插件自己的
       * `GoalNear` 是**三维球**（半径 `round(arrive-0.6)`），人站在上层它当然不满足 ⇒ `mine` 为假，
       * 于是把"高度不对"说成"别人的锅"，模型就一直重叫同一个目标。 */
      if (vertBad && horiz <= arriveUsed + 1.0) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          ...deltaOf(end),
          via: 'pathfinder', stuck: true, reason: 'goal_reached-but-far', ...moveInfo(), ...fellInfo(end),
          // P1：把两个轴分开报 —— 否则"水平到了但高了两格"看起来和"还差 5 格"一模一样
          horiz: Number(horiz.toFixed(2)), vert: Number(vert.toFixed(2)),
          hint: `${fellNote(end)}寻路插件说到了，但**高度不对**：水平只差 ${horiz.toFixed(1)} 格，垂直差了 ${Math.abs(vert).toFixed(1)} 格`
            + `（我${vert > 0 ? '站在目标上方' : '站在目标下方'}）—— `
            + (vert < 0
              ? (carveNoPathOk
                ? `已经往下挖了 ${downTries} 次还没到底${downTries >= MOVE_DOWN_TRIES || !downBudgetOk(self) ? '（这趟时间到）' : ''}：`
                  + `\`mc_move\` 再叫一次同一个目标就行，我会接着往下挖 —— 不用手挖、也不用换目标。`
                : '往下走要挖方块，这次 `allowDig` 是关的 —— 想让我自己挖下去就 `mc_move {allowDig:true}`。')
              : (carveNoPathOk
                ? `已经往上挖了 ${upTries} 次还没上去${upTries >= MOVE_UP_TRIES || !downBudgetOk(self) ? '（这趟时间到）' : ''}：`
                  + `\`mc_move\` 再叫一次同一个目标就行，我会接着往上挖。`
                : '往上要挖方块，这次 `allowDig` 是关的 —— 想让我自己垫上去就 `mc_move {allowDig:true}`。')),
        }
      }
      if (emptyNoPath || mine === false) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          ...deltaOf(end),
          via: 'pathfinder', stuck: true,
          reason: emptyNoPath ? 'NoPath' : 'goal-reached-elsewhere',
          ...roadInfo(), ...moveInfo(), ...fellInfo(end),
          hint: emptyNoPath
            ? `${fellNote(end)}寻路**没路可走**（被墙 / 水 / 悬崖挡住，或目标在实心方块里）：离目标还有 ${left.toFixed(1)} 格。${portalBlocked ? ' ' + portalBlocked : ''}`
              + '先 `mc_scan` 看挡路的是什么：是方块就 `mc_act{mode:"break"}` 挖开；'
              + '**是沟/缺口就 `mc_act{mode:"bridge"}`**（寻路插件不会水平搭桥，只会报没路）——'
              + '朝对岸那一格铺过去（x/y/z 给对岸**脚下一层**的坐标）。换个目标点再叫 mc_move 也一样走不通。'
            : `寻路插件报的"到了"**不是我这次的目标**（另一次寻路到点时顺手把我这次 goto 一起 resolve 掉了）`
              + `—— 我还在 ${left.toFixed(1)} 格外：等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。`,
        }
      }
      return {
        arrived: false, position: at(end), ms: Date.now() - t0,
        remaining: Number(left.toFixed(2)),
        ...deltaOf(end),
        via: 'pathfinder', stuck: true, reason: 'goal_reached-but-far', ...moveInfo(), ...fellInfo(end),
        hint: `${fellNote(end)}寻路插件说到了，但离目标还有 ${left.toFixed(1)} 格（可能被占住或只到附近）—— 再走一次，或换个目标点。${portalBlocked ? ' ' + portalBlocked : ''}`,
      }
    }
    /* 🔴 2026-10-19：目标（或旁边）是**传送门**时，"站在那一格上"还不算完 ——
     *    服务端要等人真的进入门方块才发传送包。寻路器只肯走到门边（半径 0 也只是贴到格心），
     *    所以这里补最后一步：朝门那格顶一下，再按"维度变了 / 位置瞬移了"判进没进。 */
    let portalInfo = null
    if (portal) {
      let step = { entered: false }
      try { step = await stepIntoPortal(b, portal, { ms: 700, signal: self.abortSignal, moveGenOf: () => self._moveGen }) } catch { step = { entered: false } }
      portalInfo = { name: portal.name, at: { x: portal.x, y: portal.y, z: portal.z }, entered: step.entered === true }
    }
    /* 🔴 2026-10-23 实机（用户实测 mc_move 到 (-290,64,803)：那一格下面是空气）：
     *    目标格站不住时 standPointFor 会把它挪到旁边能站的格 —— 挪到的正好是我**脚下这一格**
     *    时，A* 一步不走、这里就回 arrived:true + moved:0。模型看到“到了”以为真到了，
     *    实际原地没动（和 2026-10-22 那条“假成功”是同一种坑）。
     *    判据：目标被挪过（sp.adjusted）且这一趟**几乎没位移** ⇒ 目标格站不住 = 不可达，
     *    显式报失败，让模型换个目标点（别拿 arrived:true 骗它）。 */
    const spMoved = deltaOf(end)
    if (sp.adjusted && Number(spMoved.moved3d) < 0.6 && !portal) {
      return {
        arrived: false,
        position: at(end),
        ms: Date.now() - t0,
        remaining: Number(left.toFixed(2)),
        ...spMoved,
        via: 'pathfinder', stuck: true, reason: 'goal-not-standable',
        ...roadInfo(), ...moveInfo(), ...fellInfo(end),
        hint: `目标格站不住（下面没有方块 / 被方块占着）：我把落点就近挪到了 `
          + `(${sp.x}, ${sp.y}, ${sp.z})，而那正好是我脚下这一格 —— 一步没走，所以**不算到达**。`
          + `要真去那儿，先确认那格脚下有方块；想让我铺过去就用 mc_build 或 mc_act{mode:"bridge"}。`,
      }
    }
    /* 🔴 2026-10-23 实机（用户转来的报告：「同一个目标点会反复报到点了但其实没到」）：
     *    起步时人已经落在到达圈里（`remaining <= arrive`）时，寻路一步都不用挪，照样回 `arrived:true`。
     *    模型看到“到了”以为走到位了，下次再叫同一个点还是“到了 + moved 0” —— 于是**反复**。
     *    口径不变（到了就是到了），但必须把“本来就站在圈里”说明白，否则它永远不知道该换 `intent:"stand"`。 */
    try { b._movePlan = null } catch { /* 到了就不用再记"卡在第几步" */ }
    const moved3dTotal = Number(deltaOf(end).moved3d) || 0
    const alreadyThere = moved3dTotal < 0.6 && Number.isFinite(Number(startRemaining))
      && Number(startRemaining) <= arriveUsed + 0.05
    return {
      arrived: true,
      position: at(end),
      ms: Date.now() - t0,
      ...(portalInfo ? { portal: portalInfo } : {}),
      /* 起步就在到达圈里 ⇒ 说明白“一步没挪”，并给出精确到格的办法（否则模型会一直重叫同一个点）。 */
      ...(alreadyThere && !(portalInfo && !portalInfo.entered)
        ? { hint: `我**本来就站在**这个点的到达圈里（起步时差 ${Number(startRemaining).toFixed(1)} 格，`
          + `这一趟一步没挪）—— 所以这不是“走过去”，是“本来就在”。`
          + `要精确站到 (${sp.x}, ${sp.y}, ${sp.z}) 那一格上，用 \`intent:"stand"\`（判定半径 0.6 格）；`
          + '只是想“到附近”就够了的话，这条已经满足，别再重叫同一个点。' }
        : {}),
      ...(alreadyThere ? { alreadyThere: true } : {}),
      ...deltaOf(end),
      /* 到了也报 `remaining`（实机第 6 跑：`walkTo` 明明到了、`remaining` 却是 undefined，
       * 测试脚本只能打 `-`，看着像"谎报到达"）。 */
      remaining: Number(left.toFixed(2)),
      via: 'pathfinder',
      ...(dug ? { dug } : {}), ...dugBlocksOut(), ...(placed ? { pillared: placed } : {}), ...roadInfo(),
      ...moveInfo({ arrived: true }), ...arrivedTerrain(), ...fellInfo(end),
      /* 2026-10-18 审计 P1-3：规划耗时（第一次算出路径）/ 实际移动耗时，分开报 ——
       * "一直没动"到底是 A* 在算、还是腿在挪但被挡住，一眼能看出来。 */
      timing: { planMs: plannedAt ? plannedAt - t0 : null, walkMs: plannedAt ? Date.now() - plannedAt : null, totalMs: Date.now() - t0 },
      ...(portalInfo && !portalInfo.entered
        ? {
            hint: `我站到了**${portalInfo.name}**这一格（${portalInfo.at.x}, ${portalInfo.at.y}, ${portalInfo.at.z}）上，`
              + '但**还没被送走** —— 传送是服务端结算的：再叫一次 `mc_move` 往同一格走，或 `mc_move {mode:"jump"}` 原地跳一下；'
              + '还不行就是服务端/客户端不同步（`mc_connect {force:true}` 重登会把它结算掉）。'
              + '**别自己垫方块/挖方块硬闯**（以前就是这么把简单事做难的）。',
          }
        : {}),
    }
  } catch (e) {
    if (e?.mcAborted) throw e
    const end = b.entity.position
    const d = deltaOf(end)
    const moved = d.moved
    /* 🔴 2026-10-24 通审：这里原来用 target 而不是 sp —— 目标被 standPointFor 挪过时，
     *    同一个函数里成功分支按 sp 量、失败分支按原始 target 量，两个数字对不上。统一用 sp。 */
    const remaining = Number((xz
      ? Math.hypot(end.x - sp.x, end.z - sp.z)
      : end.distanceTo(new Vec3(sp.x, ty, sp.z))).toFixed(2))
    /* P0-1：`mcStuck` = 采样器判卡住（脱困阶梯走完还没进展）—— 这跟"时间用完了"、
     * "被抢占"、"没路可走"都是**不同结局**，必须分开报，否则模型会继续原地重发。 */
    /* 🔴 2026-10-24：预算见底收工也带 mcStuck（走同一条收尾路径），但**它不是"走不通"** ——
     *    必须排除，否则模型看到 unreachable 会以为这条路彻底没戏、换目标。 */
    const exhausted = Boolean(e?.mcStuck) && e?.mcBudgetOut !== true
    /* 🔴 2026-11-02 审计（#23）：采样器早就把"卡住时到底在干什么"塞进了 `err.mcWorkStall`
     *   （'dig' / 'place'），但**全仓没有一处读它** —— 于是"一直在挖却挖不动"（方块太硬 /
     *   工具不对）和"路不通（被墙挡）"报的是同一句话，模型只能瞎猜要不要换镐子。
     *   挖/放卡死跟"路被挡"是两件事：前者换工具/换目标格，后者绕路。 */
    const workStall = String(e?.mcWorkStall ?? '')
    const nm = exhausted
      ? (workStall
        ? `**一直在${workStall === 'place' ? '放方块' : '挖同一格'}，${repathCount} 次重试都没有进展**`
          + `（多半是方块太硬 / 手上的工具不对 / 那一格被保护着挖不动）`
        : pathThrash
          ? `**路一直在被改 / 一直被挡**（脱困 ${repathCount} 次，其中 ${pathThrash} 次是"路径被反复失效"）`
          : `**真的走不动了**（原地试了 ${repathCount} 次脱困：重算路径 / 跳跃 / 后退，位置都没改善）`)
      : e?.mcTimeout ? `走了 ${Math.round((Date.now() - t0) / 1000)} 秒还没到`
      : e?.name === 'NoPath' ? '寻路说**没路可走**（被墙/水/悬崖/沟挡住，或目标在实心方块里）'
        : e?.name === 'Timeout' ? '寻路想路线超时'
          : e?.name === 'PathStopped' || e?.name === 'GoalChanged' ? '寻路被打断'
            : `寻路失败（${e?.name ?? '错误'}：${String(e?.message ?? '').slice(0, 80)}）`
    // 是"这一轮 11 秒用完了"还是"真走不通"—— 给模型的下一步完全不同。
    // 🔴 第三种情况最容易漏：`budget` 本身就被 `CALL_BUDGET_MS`（10 秒）压过 —— 走长路
    //    到点返回是**正常**的，不是死路。以前只看 `msLeft() <= 400`，DSH 把截止时刻设成
    //    一整轮时，预算到点的 `msLeft()` 还剩 ~1 秒 → 判成"真走不通"，
    //    于是模型被告知"换个目标点"，明明再叫一次就能接着走。
    const cutByCall = Boolean(e?.mcCallOver) || self.msLeft() <= 400
    /* 🔴 2026-10-15 审计（报告 C 第 4 条）：这里原来还有第三个析取
     *    `Boolean(e?.mcTimeout) && budget <= Number(budgetAsked ?? budget) + 50` ——
     *    而 `budget = min(callBudget(budgetAsked), leftMs)` **恒 ≤ budgetAsked**；`budgetAsked` 缺省时
     *    退化成 `budget <= budget + 50`，也恒真 ⇒ 整个条件**恒真**（`reason: 'timeout'` 那条分支
     *    因此永远走不到）。副作用更糟：下面 `noProgress && !cutByCall` 那条"真没走通"永远为假，
     *    一格没挪也会被告知"这一轮的走路时间用完了、**不是走不通**" —— 正是 2026-10-08 那次审计
     *    要修的病。改成如实区分两件事：`cutByCall`（这一轮的时间用完了）与 `timeUp`（预算到点）。
     *    注意 `timeUp` **不能**再退回"恒真" —— 它只用于选文案，判据是"内部计时器真的响过"。 */
    const timeUp = cutByCall || Boolean(e?.mcTimeout) || e?.mcBudgetOut === true
    // 被抢占（自保反射先跑 / 又发了一次 mc_move）：编号已经不是我的了。
    // 这跟"走不通"完全是两回事 —— 必须说清楚，否则模型会以为目标不可达。
    const preempted = self._moveGen !== gen
    /* 🔴 2026-10-08 审计（会话 step 789 实机）：
     *    `{"moved":0,"remaining":2.3,...,"reason":"Error","hint":"…挪了 0 格）—— 这一轮的走路时间用完了，
     *      **不是走不通**：直接再叫一次 mc_move 往同一个目标走，会接着走。"}`
     *    —— 4 秒一格没挪，却告诉模型"不是走不通"，于是它一次次重发同一个走不到的点。
     *    判据补一条：**既没挪动、也没靠近** 就不算"时间到了"，得如实说卡住了。 */
    /* 2026-10-29（用户：目标在头顶 10 格，工具却说“走不动”）：`moved` 只算水平位移 ——
     *   往上挖一层、往下掉一层都是纯垂直移动（水平 0 格）⇒ 人明明在职业地上升也被判“没进展”。
     *   净垂直位移 ≥ 0.75 格也算进展（上升/下降都算）。 */
    /* ⚠️ 起点 y 读不到时它是 `undefined` ⇒ 以前写 `?? 0` 会算出“升了 64 格”的假进展（假 bot / 未赋值场景）。
     *   两端都要是有限数，且差值在一次移动能变出来的量级内（≤ 32 格）才算。 */
    const yA = Number(end?.y), yB = Number(start?.y)   /* ⚠️ `sp` 是**目标点**（standPointFor），不是起点 —— 用错会把“离目标差 6 格”当成“已经升了 6 格” */
    const dyV = (Number.isFinite(yA) && Number.isFinite(yB)) ? Math.abs(yA - yB) : 0
    const vRose = (dyV >= 0.75 && dyV <= 32) ? dyV : 0
    const noProgress = vRose < 0.75 && moved < 0.6 && remaining >= startRemaining - 0.3
    /* P1（用户报告“失败结果要可操作”）：卡住时别只说"没路/没进展"，把眼前那格也报出来，
     * 让 AI 自己决定挖、绕、搭桥还是换目标 —— 走路层不替它做这个决定。 */
    let blockedAhead = null
    try { blockedAhead = obstacleAheadOf(b, target) } catch { blockedAhead = null }
    /* 🔴 2026-10-24 用户实机（挖雪三坑之一）：AI 被告诉"挖掉它"，可手上是镐、那块是雪块，
     *    于是硬挖到超时，然后再来一遍。挖不动必须**当面说清**，不能只说"挖掉它"。 */
    let blockedNeed = null
    if (blockedAhead) {
      try {
        const bk = b.blockAt(new Vec3(blockedAhead.x, blockedAhead.y, blockedAhead.z))
        if (bk && !canBreakNow(b, bk)) blockedNeed = toolKinds(b, bk) || '对的工具'
      } catch {}
    }
    /* `reason` 也别把内部字符串原样透出去（旧版漏出过 `Error` / `block_updated`） */
    /* 🔴 2026-10-21 用户：「我看经常 reset」—— 原来这张表只认得 5 个理由，vendor 真正会发的
     *    `chunk_loaded`（走一趟要触发好多次，属于正常重算）、`goal_moved`、`movements_updated`、
     *    `dig_error`、`place_error`、`no_scaffolding_blocks` 全落进兜底的 'path-reset'，
     *    看起来就像「老是路被重置」。现在逐条翻成人话，看到就知道是哪一类。 */
    const REASON_TEXT = {
      stuck: 'stuck（3.5 秒没挪动，vendor 自己判的）',
      block_updated: 'block-changed（路过的方块变了）',
      goal_changed: 'goal-changed（目标被换掉）',
      goal_moved: 'goal-moved（目标点动了）',
      path_stopped: 'stopped（被主动停）',
      chunk_loaded: 'chunk-loaded（区块刚加载，正常重算）',
      movements_updated: 'movements-updated（移动配置变了）',
      dig_error: 'dig-error（该挖的没挖成）',
      place_error: 'place-error（该垫的没垫成）',
      no_scaffolding_blocks: 'no-scaffolding（没方块可垫）',
      /* 🔴 2026-10-27：vendor 里其余几种"真卡住"的理由以前没翻成人话，全落进兜底的
       * `path-reset`（看起来像"路被重置了"，其实是具体某一步失败了）。 */
      place_jump_timeout: 'place-jump-timeout（垫方块时起跳太久没升到摆放高度）',
      equip_error: 'equip-error（要垫的方块没拿到手上）',
      dig_equip_error: 'dig-equip-error（要挖的那格没换到对的工具）',
      dig_timeout: 'dig-timeout（挖那格太久，放弃了）',
      use_block_error: 'use-block-error（门/按钮没按动）',
      path_reset: 'path-reset（其它原因）',
    }
    const PF_ERR = new Set(['NoPath', 'Timeout', 'PathStopped', 'GoalChanged', 'NoPathFound'])
    /* 🔴 2026-10-08 实机（熔炼验证，真服）：`why` 记的是**中途**事件（`path_reset` 在
     *    A* 重算 / 踩到方块更新 / 3.5 秒没推进时都会发），不能拿它盖过"这一轮时间用完了"
     *    这个真正结局 —— 那次跑出 `{"moved":32,"remaining":6.11,"reason":"path-reset"}`，
     *    10 秒明明正常挪了 32 格、只是预算到点，模型看到 "path-reset" 却会以为路被重置了、
     *    以为走不通。时间到点 + 有进展 ⇒ 如实报 budget/timeout。 */
    const takenByOut = preempted ? String(self._moveGenWho ?? 'unknown') : ''
    const reasonOut = preempted ? 'preempted'
      : e?.mcBudgetOut === true ? 'budget'
      : exhausted ? 'unreachable'
      : (e?.mcTimeout && !noProgress ? (cutByCall ? 'budget' : 'timeout')
        : (why ? (REASON_TEXT[why] ?? `path-reset（未识别的重置原因：${why}）`)
          : (PF_ERR.has(String(e?.name)) ? String(e.name) : 'walk-failed')))
    /* 🔴 2026-10-19 用户：「还有把末影传送门视为危险方块」——
     *    寻路说"没路"，可人明明就站在传送门边上（要塞那趟就是这样：门格与地板同层，
     *    A* 生成不出"站进门里"的节点）。这时候**直接迈进去**，不再走
     *    "门上方垫方块 → 挖掉 → 让自己掉下去"那套又慢又容易摔/被踢的老办法。 */
    if (portal && !preempted && remaining <= 4) {
      let step = { entered: false }
      try { step = await stepIntoPortal(b, portal, { ms: 700, signal: self.abortSignal, moveGenOf: () => self._moveGen }) } catch { step = { entered: false } }
      if (step.entered === true) {
        return {
          arrived: true,
          position: at(b.entity.position),
          ms: Date.now() - t0,
          remaining: 0,
          via: 'portal',
          portal: { name: portal.name, at: { x: portal.x, y: portal.y, z: portal.z }, entered: true },
          hint: `寻路说没路，但我已经在 **${portal.name}** 边上，就直接迈进去了 —— **已被传送走**（维度或位置变了）。`,
        }
      }
    }
    /* 🔴 2026-10-24 用户：「为什么move现在有这么多输出」——
     *    原来每条建议都是独立的 if 拼上去，一次能同时出 5 段，而且互相矛盾
     *    （"直接 bridge 搭过去" 与 "换个能走到的目标点" 同时出现，还说"不是走不通"）。
     *    现在**只挑一条**：按"最该先做什么"排序，命中即停。 */
    /* 🔴 2026-10-27 用户实机（"有好几次是这样"）：10 秒预算正常走完时，`obstacleAheadOf`
     *    照样探到前方那格泥土，然后 hint 劝"挖得动就直接 mc_act break 挖掉它"
     *    ⇒ 模型真的跑去挖泥土，其实再叫一次 mc_move 就到了。
     *    只能"时间到"还不算免责：走不动时预算同样会耗尽，那种必须照旧报出挡路的方块。
     *    ⇒ 免责条件 = 时间到/预算完 **且** 这一轮确实在推进（不是 noProgress）。 */
    /* 🔴 2026-10-31：阶梯没走完就收工 ⇒ 明说还剩哪几级，并告诉 AI「再叫一次会接着试」。 */
    const escLeft = Array.isArray(e?.mcEscapesLeft) ? e.mcEscapesLeft : []
    const escNote = escLeft.length
      ? `；⚠️ 脱困阶梯还剩 ${escLeft.map((n) => planStepTextOf(n)).join(' / ')} 没试完 —— 同目标再叫一次会接着往下试，别换目标`
      : ''
    const timeIsBlame = timeUp && !noProgress
    const adviceFor = () => {
      /* 🔴 2026-10-30 实体避让：挡路的是活的 ⇒ 建议"打掉或绕开"，不是"挖墙"。 */
      if (e?.mcEntity) {
        const waited = Math.round(Number(e.mcEntityWaited ?? 0))
        const tail = waited > 0 ? `（我等了 ${waited} 毫秒，它没让开）` : ''
        /* 🔴 2026-11-03 用户：「不要抛错，直接绕过去。敌对和末影龙都不要」—— 以前敌对的建议是
         *   「先 mc_attack」，那是"收工交给人"的口径；现在走路遇活物一律自己绕，文案同一口径。 */
        return `—— ${entityTextOf(e.mcEntity)}${tail}。再叫一次 \`mc_move\` 会绕开它`
          + '（A\\* 给活物占的格加了代价；绕几次还挡就直接挤过去，不停不等）。'
          + '要清掉才 `mc_attack`，别为了走路专门去打。'
      }
      if (hostileSeen && !e?.mcEntity) {
        return `—— 路上有 ${entityTextOf(hostileSeen)}；我${entityDodgeOff ? '绕不过去就直接挤过去了' : '已经换了 ' + entityDodges + ' 次路绕开'}（不停不等；要清掉就 mc_attack）。`
      }
      if (preempted) {
        /* 🔴 2026-11-03 用户贴回来的报错里没有"谁抢的"—— 因为上一版只给 walkPathfinder 内部那个
         *   出口加了 `takenBy`，而**外层循环（本轮开始就验代次那条）**才是真正常走的路。
         *   现在两处都点名（`walk:*` / `dig` / `collect` / `swim` / `jump` / `boat` / `lava` / `emergency:*`）。 */
        /* ⚠️ 2026-11-03：知道是谁的时候也要带上"另一次移动"这个大类 ——
         *   模型（和测试）都靠这句话判断"不是路不通"；只写 `**dig**` 会被读成别的东西。 */
        const by = String(self._moveGenWho ?? 'unknown')
        const who = by === 'unknown' ? '另一次移动' : `**${by}**（另一次移动/自保反射）`
        return fellOf(end) != null
          ? `—— 这次走路被 ${who} 打断了，但更值得注意的是：**你刚掉下来了**。先站稳、看清脚下，再决定往哪走，别对着同一个高度反复爬。`
          : `—— 这次走路被 ${who} 打断了：等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。`
      }
      /* 只有"它可能就是这次没走到"的原因时才报前方那格。
       * 🔴 2026-10-27 用户实机多次：10 秒预算走完（`timeout`）时，前方恰好是泥土这种正常地形，
       *    这里照样劝"挖得动就直接 mc_act break 挖掉它" ⇒ 模型真的跑去挖泥土，其实再叫一次就到了。 */
      if (blockedAhead && !timeIsBlame) {
        const where = `${blockedAhead.cell === 'feet' ? '齐脚那格' : '头顶那格'} ${blockedAhead.x},${blockedAhead.y},${blockedAhead.z}`
        if (isTreeBlock(blockedAhead.name)) {
          return `—— 眼前挡路的是 **${blockedAhead.name}**（${where}）：是**树** —— **别挖树**（挖开树冠只会让我自己爬上去）：绕开走，或者换个目标点。`
        }
        if (DOOR_RE.test(blockedAhead.name)) {
          return `—— 眼前挡路的是 **${blockedAhead.name}**（${where}）：是**门**：\`mc_act {mode:"use", x:${blockedAhead.x}, y:${blockedAhead.y}, z:${blockedAhead.z}}\` 按开它（或走近再叫一次 mc_move，会自动开门），**别挖墙也别挖门**。`
        }
        if (blockedNeed) {
          return `—— 眼前挡路的是 **${blockedAhead.name}**（${where}）：这块**你现在挖不动**（要${blockedNeed}，手上这套挖下去要几十秒，必超时）—— **别硬挖、别重复发同一个目标**：先换个方向绕（或 \`mc_move {allowDig:true}\` 另找一条能挖开的路），实在绕不过去就先弄一把${blockedNeed}。`
        }
        return `—— 眼前挡路的是 **${blockedAhead.name}**（${where}）：挖得动的话直接 \`mc_act {mode:"break", x:${blockedAhead.x}, y:${blockedAhead.y}, z:${blockedAhead.z}}\` 挖掉它，再叫 mc_move。`
      }
      if (!preempted && terrain.kind === 'gap') {
        return `—— 你脚边是**${terrain.text}**（${terrain.note}）：别绕着试了，直接 \`mc_act {mode:"bridge"}\` 朝目标搭过去。`
      }
      if (!preempted && terrain.kind === 'hazard') {
        return `—— 你脚边是**${terrain.text}**（${terrain.note}）：别从这边走，换个方向绕。`
      }
      if (exhausted) {
        const narrow = (remaining <= 2.5 && (carved || carveTries))
          ? `—— 你离目标只剩 ${remaining.toFixed(1)} 格，多半是**窄道/台阶**：先 \`mc_act {mode:"break"}\` 挖掉**脚前那一格**，再挖它**头顶那一格**，然后叫 \`mc_move\` 走一步。`
          : ''
        const thrash = pathThrash
          ? `—— 这一轮**路径被重算了 ${pathResetsTotal} 次**（${Object.entries(resetReasons).map(([k, v]) => `${REASON_TEXT[k] ?? k}×${v}`).join('、')}）：说明**路一直在被世界变化打断**（别人放的方块 / 走过来的实体 / 岩浆流 / 方块更新），不是"找不到路"——光重算没用，所以停了。**换个走法**：`
          : ''
        return narrow + thrash
          + `—— **别原地重试了**（已经替你换过 ${repathCount} 次策略都没用）：把长路**拆成几段**，先走到中间一个能站住的点、再走下一段；或者用 \`mc_scan\` 看挡在中间的是什么（墙 / 水 / 栅栏 / 半砖）。`
      }
      if (noProgress && !timeUp) {
        return '—— **是真没走通**（一格没挪、也没靠近）：先 `mc_act {mode:"jump"}` 蹦一下（可能是卡在方块里 / 台阶上），再 `mc_scan` 看脚下和目标那格是什么；换个近一点的目标点通常更快。'
      }
      if (timeUp) {
        /* 🔴 2026-10-27 复盘实机：这句以前只说"单次调用最多 10 秒"，可 187 次 timeout 里
         *   一大半是 4 秒就结束（一轮动作的总时间被前面的步骤吃掉）—— 模型以为还剩 6 秒，
         *   于是一边等一边重发。现在把**这次真分到的**预算写出来，别让它自己猜。 */
        const gotSec = (Math.max(0, Number(budget) || 0) / 1000).toFixed(1)
        return `—— 这一轮分到的走路时间用完了（这次 ${gotSec} 秒，单次调用最多 ${budgetSecText()}），**不是走不通**：直接再叫一次 mc_move 往同一个目标走，会接着走。`
      }
      if (pathResetsTotal > 0) {
        return `—— 途中路径被重算了 ${pathResetsTotal} 次（${Object.entries(resetReasons).map(([k, v]) => `${REASON_TEXT[k] ?? k}×${v}`).join('、')}）：**不是走不通** —— chunk-loaded 那种是正常重算，stuck 是挪不动被 vendor 判的；直接再叫一次 mc_move 往同一目标走就行。`
      }
      return '—— 换个能走到的目标点，或先解除挡住它的方块。'
    }
    /* 🔴 2026-10-28（用户：「卡在半空」）：悬空时要直说"你现在是挂着的"。
     *   实机里人垫了柱子（`pillared:2`）爬到半空、头顶被堵死，hint 却在说
     *   "眼前挡路的是 basalt，先换个方向绕" —— 等于让它在半空绕路。 */
    const airNote = () => {
      try {
        const e2 = b?.entity
        if (e2?.onGround !== false) return ''
        const v = e2?.velocity ?? {}
        const vy = Number(v.y) || 0
        const vh = Math.hypot(Number(v.x) || 0, Number(v.z) || 0)
        if (Math.abs(vy) > MOVE_BUSY_VY_EPS || vh > MOVE_BUSY_VH_EPS) return ''
        const a = aboveOf(b)
        const head = a && a.canJump === false ? '、头顶还被堵着' : ''
        return ` —— ⚠️ 人现在**挂在半空、一动不动**${head}${placed ? `（这趟自己垫了 ${placed} 格柱子）` : ''}：`
          + '这不是"绕"能解决的 —— 先 `mc_dig` 挖开头顶那格让自己落地，或直接 `mc_move` 到旁边的地面。'
      } catch { return '' }
    }
    return {
      arrived: false,
      position: at(end),
      ms: Date.now() - t0,
      remaining,
      ...d,
      via: 'pathfinder',
      /* 🔴 2026-10-27（用户 m02756「这个会话的 dig 和 move 根本不准确」；实测 session-514c21b6：
       *    324 次 `mc_move` 里有 **199 次**返回都带 `stuck:true` —— 包括"这一轮时间到、但已经
       *    挪了 11 格"和"被别的动作抢占"的那种。这个字段以前是**无条件写死**的，模型一看
       *    `stuck` 就当"卡死了、别再试"，于是明明在推进也放弃/换路。
       *    只在"真的没进展"时才算卡住：时间到（已经挪了距离的不算）、被别的动作抢占（这个仍算没走成）。
       *    注意别顺手把 `preempted` 也踢掉 —— `check-call-budget` 明写「preempted ⇒ stuck:true」，
       *    `src/water-recovery.mjs` 也靠 `stuck && reason !== 'preempted'` 分流。 */
      ...(takenByOut ? { takenBy: takenByOut } : {}),
      stuck: Boolean(preempted || exhausted || (noProgress && !timeUp)),
      reason: reasonOut,
      /* 这一趟谁按了哪些控制键、forward 与 back 有没有同时按着、位置有没有先增后减。
       *  输出里只留摘要 + 最后 6 个位置采样（完整轨迹太长，模型不需要）。 */
      ...(ctrlAudit ? { ctrlAudit: ctrlAuditOf(ctrlAudit) } : {}),
      /* 这一趟每种“路径被重置”的原因各发生了几次（含良性）—— 失败时据此定向。 */
      ...(Object.keys(resetSeen).length ? { pathResetSeen: { ...resetSeen } } : {}),
      /* 2026-10-30 实体避让：说清是"谁"挡着（不是墙）、等了多久。 */
      ...(e?.mcEntity
        ? { blockedByEntity: { ...e.mcEntity, waitedMs: Math.round(Number(e.mcEntityWaited ?? 0)) } }
        : (hostileSeen ? { blockedByEntity: { ...hostileSeen, dodges: entityDodges, wentThrough: entityDodgeOff } } : {})),
      ...(escLeft.length ? { escapesLeft: escLeft.map((n) => planStepTextOf(n)), escapesLeftRaw: [...escLeft] } : {}),
      ...(dug ? { dug } : {}), ...dugBlocksOut(), ...(placed ? { pillared: placed } : {}), ...roadInfo(), ...moveInfo(), ...fellInfo(end),
      /* 同上：时间用完/被抢占时，前方那格与本次失败无关 —— 别让它进返回值（模型会当成线索）。 */
      ...((blockedAhead && !timeIsBlame) ? { blockedAhead } : {}),
      /* 2026-10-18 审计 P1-1：走不到时把"头顶/四面/能垫的方块"一次给全 */
      ...((exhausted || e?.name === 'NoPath') && !preempted ? (() => { const sh = shaftInfoOf(b, target); return sh ? { shaft: sh } : {} })() : {}),
      /* 🔴 2026-10-27（用户 m02756）：`moved` 是**水平**位移（`deltaOf` 里 `hypot(dx,dz)`），
       *    以前这里只写"挪了 N 格" ⇒ 结果里出现 `moved:5.87` 配 `movedVertical:-7` 时，
       *    看着像自相矛盾（"到底走了几格"）。文案写清是水平，垂直由 `vertNote` 单独说。 */
      hint: `${fellNote(end)}${nm}${escNote}（从 ${startRemaining.toFixed(1)} 格变成 ${remaining.toFixed(1)} 格，水平挪了 ${moved} 格${vertNote(end)}）${adviceFor()}${dugHint()}${airNote()}`,
    }
  } finally {
    // P0-1：采样器的定时器必须收掉 —— 留着会把进程钉住（也会在返回之后误判"卡住"）。
    try { clearInterval(doorTimer) } catch {}
    try { watch?.stop() } catch {}
    for (const [ev, fn] of off) { try { b.removeListener?.(ev, fn) } catch {} }
    // 🔴 只有"我还是最新那次移动"才允许收尾（停 pathfinder + 松控制位）。
    //    被抢占时绝不能动：否则会把正在走的那一份一起停掉 —— 实机表现就是
    //    "动了一下不动了"。见 _moveGen 的注释。
    if (self._moveGen === gen) {
      // 🔴 2026-10-08 审计②：`stop()` 只是置标志 —— 必须 `setGoal(null)` 才真停
      //    （详见 #stopPathing 的注释：不然控制位会被插件按回去，甚至返回之后才开始挖方块）。
      try { ctx.stopPathing(b) } catch {}
      ctx.releaseControls()
    }
  }
}
