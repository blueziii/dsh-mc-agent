/**
 * 地形分类 + 路径评分（导航 P2，2026-10-15，用户 m02868 的优先级表第 5 行）。
 *
 * 用户的要求：**"能根据台阶、落差和危险地形选策略"** —— 不要再拿一套全局权重走所有地形。
 *
 * 这里只做两件事，两件都不碰寻路算法本身：
 *
 *   1. `classifyTerrain(b, opts)` **看** —— 把脚边一圈的柱子量一遍（高差 / 缺口 / 危险方块 / 两侧墙），
 *      归成 `flat / steps / drops / gap / hazard / narrow` 之一（判不出来就 `unknown`）。
 *   2. `TERRAIN_PROFILES` + `profileFor()` **定价** —— 每一类给一套 `Movements` 权重
 *      （`maxDropDown` / `liquidCost` / `digCost` / `placeCost` / `allowParkour`），
 *      由 `src/plugins.mjs` 的 `movements()` 落到真的 `Movements` 上。
 *
 * ⚠️ 三条纪律：
 *
 *   - **只调权重，不换算法** —— A* 还是 mineflayer-pathfinder 的（用户 2026-10-06：
 *     "应该有写好的防卡住项目…完全是瞎动"，所以不自写寻路）。
 *   - **用户显式配置优先** —— `cfg.walkMaxDropDown` / `walkDigCost` / `walkTowerCost` /
 *     `walkLiquidCost` / `walkAllowParkour` 只要设过，地形档案就盖不过它（`profileFor` 的 `over`）。
 *   - **判不出来就 `unknown`** —— 区块没加载 / `blockAt` 抛错时不硬猜，给回默认权重
 *     （宁可"和平地一样走"，也不要凭半个世界瞎定策略）。
 *
 * 为什么不在 `classifyTerrain` 里做寻路决策：分类是**观察**，权重是**配置**，
 * 两者分开才能离线测（假世界 + 假 bot 就能跑，不用真服务器）。
 */

import { Vec3 } from 'vec3'
import { isPassable, isSolidBlock } from './block-names.mjs'
import { BRIDGE_FATAL, BRIDGE_WET, feetOf } from './bridge.mjs'

/** 采样半径（切比雪夫距离，格）—— 4 格够看清"眼前这一段"，再远不如让寻路器自己看。 */
export const TERRAIN_RADIUS = 4
/** 每根柱子往上/往下看几格（"能站的那一层"在这个窗口里找不到就算缺口或墙）。 */
export const TERRAIN_UP = 2
export const TERRAIN_DOWN = 4
/** 判成某一类的最少证据量（避免一块台阶就把整片平地判成"台阶地形"）。
 *  `TERRAIN_MIN_GAPS = 1`：**脚边一个"整根找不到落脚点"的深坑就够了** ——
 *  那不是"路边的坑"，那是"一步踩空就出不来"（用户点名要治的正是这个）。 */
export const TERRAIN_MIN_STEPS = 3
export const TERRAIN_MIN_DROPS = 3
export const TERRAIN_MIN_GAPS = 1

export const TERRAIN_TEXT = {
  flat: '平地',
  steps: '台阶',
  drops: '落差',
  gap: '沟/缺口',
  hazard: '危险地形',
  narrow: '窄道',
  unknown: '看不出来',
}

/**
 * 每类地形一套 `Movements` 权重。**注释里写的"为什么"就是这张表的全部理由** ——
 * 改动前先想清楚"这条为什么是这个数"，不然就变成拍脑袋调参。
 *
 * 单位：`maxDropDown` 是**格数**，其余是 A* 的**相对代价**（只比大小，没有绝对意义）。
 */
export const TERRAIN_PROFILES = {
  // 平地：就是 `src/plugins.mjs` 原本那套全局值（别的分类都从它出发）
  flat: { maxDropDown: 3, liquidCost: 4, digCost: 4, placeCost: 12, allowParkour: false },
  // 台阶：挖穿比绕远快（一格台阶绕路要好几步），所以挖便宜一点；但**别开跳远** ——
  // 延迟下 parkour 落地判定很容易摔（`walkAllowParkour` 默认关的原因）
  steps: { maxDropDown: 3, liquidCost: 4, digCost: 3, placeCost: 10, allowParkour: false },
  // 落差：把"允许往下跳"收窄到 2 格；垫方块放宽（垫一格比摔下去便宜），挖更贵（挖了脚下可能塌）
  // 2026-10-30：**开跑酷** —— 柱林/断崖之间"跨 1~2 格"正是跑酷边能生成的走法，
  //   以前全档关掉，A* 在这里必然 NoPath，只能靠兜底一格一格试（用户：「智能规划路线，不要兜底」）。
  //   开是安全的：落点要实心 + 上方两格净空（vendor `getMoveParkourForward` 自己检查），
  //   再加 `parkourPenalty`（默认 4）⇒ 只在"省下的路 > 4 步"时才选。
  drops: { maxDropDown: 2, liquidCost: 6, digCost: 5, placeCost: 8, allowParkour: true },
  // 沟/缺口：更不想下水（掉进去常常出不来，`walkSwim` 只保证"游到附近"）；
  // 垫方块比平地（12）便宜一点，但**不能是全表最便宜的** —— 2026-10-17 实机（要塞里）：
  // 地形判成 gap、`placeCost = 4` 让寻路器一路往脚下垫柱子（`pillared: 11`），其中一次放置
  // 被服务端拒（vendor `index.js:563` 的 `place_error`），**那一刻人已经在半空** ⇒ 从 y=68
  // 掉到 y=47。垫方块的代价里必须算上"垫失败 = 摔下去"，所以抬到 8（= `drops`）：仍比平地
  // 便宜，但比挖一格（5）贵 —— 沟边更倾向绕路 / 挖台阶，真要过去就用 `mc_act {mode:"bridge"}`。
  gap: { maxDropDown: 2, liquidCost: 8, digCost: 5, placeCost: 8, allowParkour: true },
  // 危险地形（岩浆/火/仙人掌/细雪）：一格都别往下跳、水一滴都别碰、挖穿更贵（挖开可能放出岩浆）
  hazard: { maxDropDown: 1, liquidCost: 20, digCost: 8, placeCost: 8, allowParkour: false },
  // 窄道：挖更贵（挖了容易把自己埋了 / 掉下去），垫方块稍微放宽（贴墙走不动时垫一格）
  narrow: { maxDropDown: 2, liquidCost: 4, digCost: 5, placeCost: 10, allowParkour: true },
  // 判不出来（区块没加载 / 没 bot）：退回平地那套
  unknown: { maxDropDown: 3, liquidCost: 4, digCost: 4, placeCost: 12, allowParkour: false },
}

/** 档案字段 → 用户配置键（`profileFor` 用它们判断"用户是不是显式设过"）。 */
export const TERRAIN_CFG_KEYS = {
  maxDropDown: 'walkMaxDropDown',
  liquidCost: 'walkLiquidCost',
  digCost: 'walkDigCost',
  /* 🔴 2026-11-02 审计（#9）：原来映射到 `walkPlaceCost`，可真正读这个值的地方是
   *   `plugins.mjs` 的 `walkTowerCost` ⇒ **两个名字两套默认**，用户配哪个都可能不生效。
   *   现在统一到 `walkTowerCost` 一个名字。 */
  placeCost: 'walkTowerCost',
  allowParkour: 'walkAllowParkour',
}

/**
 * 量**一根柱子**：从 `feetY + up` 往下找"能站的那一层"（下面实心 + 自己两格能穿过）。
 *
 * 返回：
 *   - `y`        能站的那一层（找不到是 `null`）
 *   - `gap`      `y === null` 且**自己那一层不是实心** ⇒ 缺口/深坑
 *   - `wall`     `y === null` 且自己那一层是实心 ⇒ 墙
 *   - `unloaded` 读到 `null`（区块没加载）⇒ 这一根**不计入统计**
 *   - `hazard` / `wet` 这一根里第一个致命 / 水方块的名字
 */
export function columnAt (b, x, z, feetY, { up = TERRAIN_UP, down = TERRAIN_DOWN, anchorFirst = false } = {}) {
  const at = (yy) => { try { return b.blockAt(new Vec3(x, yy, z)) } catch { return null } }
  const nm = (blk) => { try { return blk?.name ?? null } catch { return null } }
  const names = []
  let hazard = null
  let wet = false
  for (let y = feetY + up + 1; y >= feetY - down; y--) {
    const n = nm(at(y))
    if (n === null) return { y: null, gap: false, wall: false, unloaded: true, hazard, wet, names }
    names.push(n)
    if (!hazard && BRIDGE_FATAL.test(n)) hazard = n
    if (!wet && BRIDGE_WET.test(n)) wet = true
  }
  /* 试哪几层：默认自上而下（"往上找优先"）；`anchorFirst` 先试**脚那一层** ——
   * 调用方已经知道人就站在那儿（局部空间地图就是这种情况），能省掉最多 `up` 层 × 3 次读块。 */
  const levels = []
  if (anchorFirst) levels.push(0)
  for (let dy = up; dy >= -down; dy--) if (!(anchorFirst && dy === 0)) levels.push(dy)
  for (const dy of levels) {
    const yy = feetY + dy
    const u = nm(at(yy - 1)); const a = nm(at(yy)); const c = nm(at(yy + 1))
    if (u === null || a === null || c === null) return { y: null, gap: false, wall: false, unloaded: true, hazard, wet, names }
    if (isSolidBlock(u) && isPassable(a) && isPassable(c)) return { y: yy, gap: false, wall: false, unloaded: false, hazard, wet, names }
  }
  /* 没找到能站的那一层，分两种 —— 判据是**自己那一层是不是实心**（不是"整根实心"：
   * 头顶有天空、脚下是实心墙，也是"这格站不了"）。 */
  const blockedAt = isSolidBlock(nm(at(feetY)))
  return { y: null, gap: !blockedAt, wall: blockedAt, unloaded: false, hazard, wet, names }
}

/** 这一根柱子的地形字符（给日志/返回值看，一眼能扫）。 */
export const columnGlyph = (c) => (c.unloaded ? '?' : c.hazard ? '!' : c.wet ? '~' : c.wall ? '#' : c.gap ? '_' : '.')

/**
 * 看脚边一圈（切比雪夫半径 `radius`，不含自己站的那一格）并归类。
 *
 * 优先级（**先报最要命的**，命中即停）：
 *   1. `hazard`  圈里有岩浆/火/仙人掌/细雪
 *   2. `gap`     缺口 ≥ `TERRAIN_MIN_GAPS`（一个"整根没有落脚点"的深坑就够）
 *   3. `drops`   往下 ≥ 3 格的地方 ≥ `TERRAIN_MIN_DROPS`，或最深处 ≤ -3
 *   4. `steps`   往上 ≥ 3 格的地方 ≥ `TERRAIN_MIN_STEPS`，或最高一步 ≥ 2
 *   5. `narrow`  实心墙 ≥ max(3, 45% 的柱子)
 *   6. `flat`    以上都不是
 * 一根都量不出来（全 `unloaded` / 没 bot）⇒ `unknown`。
 */
export function classifyTerrain (b, { feet = null, radius = TERRAIN_RADIUS, up = TERRAIN_UP, down = TERRAIN_DOWN } = {}) {
  const base = {
    kind: 'unknown', text: TERRAIN_TEXT.unknown, radius,
    columns: 0, unloaded: 0, hazards: 0, wets: 0, gaps: 0, walls: 0,
    ups: 0, downs: 0, worstDrop: 0, maxStep: 0, note: '', glyph: '',
  }
  if (!b || typeof b.blockAt !== 'function') return { ...base, note: '没有可读的世界（没连上？）' }
  let f = feet
  if (!f) { try { f = feetOf(b) } catch { f = null } }
  if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.z)) {
    return { ...base, note: '读不到自己的坐标' }
  }
  const fx = Math.floor(f.x); const fz = Math.floor(f.z); const fy = Math.floor(f.y)

  const cols = []
  let unloaded = 0
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const cheb = Math.max(Math.abs(dx), Math.abs(dz))
      if (cheb === 0 || cheb > radius) continue
      const c = columnAt(b, fx + dx, fz + dz, fy, { up, down })
      if (c.unloaded) { unloaded++; continue }
      cols.push({ dx, dz, ...c })
    }
  }
  if (cols.length === 0) return { ...base, unloaded, note: '这一圈区块都还没加载' }

  const hazards = cols.filter((c) => c.hazard).length
  const wets = cols.filter((c) => c.wet).length
  const gaps = cols.filter((c) => c.gap).length
  const walls = cols.filter((c) => c.wall).length
  const deltas = cols.filter((c) => c.y !== null).map((c) => c.y - fy)
  const ups = deltas.filter((d) => d >= 1).length
  const downs = deltas.filter((d) => d <= -1).length
  const worstDrop = deltas.length ? Math.min(...deltas) : 0
  const maxStep = deltas.length ? Math.max(...deltas) : 0

  let kind = 'flat'
  if (hazards > 0) kind = 'hazard'
  else if (gaps >= TERRAIN_MIN_GAPS) kind = 'gap'
  else if (downs >= TERRAIN_MIN_DROPS || worstDrop <= -3) kind = 'drops'
  else if (ups >= TERRAIN_MIN_STEPS || maxStep >= 2) kind = 'steps'
  else if (walls >= Math.max(3, Math.round(cols.length * 0.45))) kind = 'narrow'

  const bits = [`${cols.length} 根柱子`]
  if (hazards) bits.push(`危险 ${hazards}`)
  if (wets) bits.push(`水 ${wets}`)
  if (gaps) bits.push(`缺口 ${gaps}`)
  if (walls) bits.push(`墙 ${walls}`)
  if (ups) bits.push(`往上 ${ups}`)
  if (downs) bits.push(`往下 ${downs}`)
  if (worstDrop) bits.push(`最深 ${worstDrop} 格`)
  if (unloaded) bits.push(`未加载 ${unloaded}`)

  // 俯视图（行 = dz 从小到大，列 = dx 从小到大）—— 出问题时一眼能看出"看到的是什么"
  const glyphRows = []
  for (let dz = -radius; dz <= radius; dz++) {
    let row = ''
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dz === 0) { row += '@'; continue }
      const c = cols.find((k) => k.dx === dx && k.dz === dz)
      row += c ? columnGlyph(c) : '?'
    }
    glyphRows.push(row)
  }

  return {
    kind, text: TERRAIN_TEXT[kind], radius,
    columns: cols.length, unloaded, hazards, wets, gaps, walls, ups, downs, worstDrop, maxStep,
    note: bits.join('、'),
    glyph: glyphRows.join('\n'),
  }
}

/**
 * 按地形分类取一份权重档案，**用户显式配置优先**。
 *
 * 返回 `{ kind, text, cost, over }`：`cost` 是最终权重，`over` 是被用户配置盖掉的字段
 * （谁盖的、盖成什么，日志里要能看见 —— 不然"我明明设了 8 怎么还是 2"没法排查）。
 */
export function profileFor (kind, cfg = {}) {
  const k = TERRAIN_PROFILES[kind] ? kind : 'unknown'
  const cost = { ...TERRAIN_PROFILES[k] }
  const over = []
  for (const [field, cfgKey] of Object.entries(TERRAIN_CFG_KEYS)) {
    const v = cfg?.[cfgKey]
    if (v == null) continue
    const val = field === 'allowParkour' ? v === true : Number(v)
    if (!Number.isFinite(val) && field !== 'allowParkour') continue
    cost[field] = val
    over.push(`${field}=${val}（来自 ${cfgKey}）`)
  }
  return { kind: k, text: TERRAIN_TEXT[k], cost, over }
}

/* ─────────────── 导航缓存（导航 P2 的"减少重复计算"那一半）───────────────
 *
 * **为什么要有**：一次分类要读 80 根柱子 × 5 格 = 400 次 `blockAt`，而走路前**每次**都重扫。
 * "人没挪窝、世界也没变"的时候，答案**一模一样** —— 这份工作纯属白做。
 *
 * **失效条件（任一满足就重扫）**：
 *   1. 世界真的变了 —— 挂 `blockUpdate` / `chunkDidLoad` / `chunkDidUnload`，收到就 `version++`；
 *   2. 人挪到别的格子了（缓存键里带脚下那一格）；
 *   3. 超过 `TERRAIN_CACHE_MS` —— 兜底，漏掉的更新最多让档案旧这么久。
 *
 * ⚠️ **不缓存"未知"**：区块还在加载时 `unknown` 会一闪而过，缓存住就等于"一直看不出来"。
 */

/** 缓存最多活多久（毫秒）。3 秒够短：漏掉的方块更新最多让档案旧 3 秒，而走路一轮本来就几秒。 */
export const TERRAIN_CACHE_MS = 3000

const _terrainCache = new WeakMap()

function cacheOf (b) {
  // `WeakMap` 的键必须是对象 —— 没 bot（断线/假 bot）时给一份一次性的，别炸
  if (!b || (typeof b !== 'object' && typeof b !== 'function')) {
    return { version: 0, hits: 0, misses: 0, scans: 0, last: null, lastKey: '', lastVersion: -1, lastAt: 0, hooked: true }
  }
  let e = _terrainCache.get(b)
  if (!e) {
    e = { version: 0, hits: 0, misses: 0, scans: 0, last: null, lastKey: '', lastVersion: -1, lastAt: 0, hooked: false }
    _terrainCache.set(b, e)
  }
  if (!e.hooked) {
    e.hooked = true
    try {
      const bump = () => { e.version++ }
      b?.on?.('blockUpdate', bump)
      b?.on?.('chunkDidLoad', bump)
      b?.on?.('chunkDidUnload', bump)
    } catch { /* 假 bot 没有 on：不影响，只是缓存靠 TTL 失效 */ }
  }
  return e
}

/** 缓存的账（`hits` / `misses` / `scans` / 世界变更次数）—— 给 `mc_diag` 和测试看。 */
export function terrainCacheStats (b) {
  const e = cacheOf(b)
  return { hits: e.hits, misses: e.misses, scans: e.scans, version: e.version }
}

/**
 * `classifyTerrain` 的**带缓存版** —— 走路前用这个（同样的答案不重算）。
 *
 * 返回值比 `classifyTerrain` 多一个 `cached` 字段（这次是命中缓存还是真扫的）。
 */
export function classifyTerrainCached (b, { feet = null, radius = TERRAIN_RADIUS, up = TERRAIN_UP, down = TERRAIN_DOWN, ttl = TERRAIN_CACHE_MS, now = Date.now } = {}) {
  const e = cacheOf(b)
  let f = feet
  if (!f) { try { f = feetOf(b) } catch { f = null } }
  const key = f && Number.isFinite(f.x) ? `${Math.floor(f.x)},${Math.floor(f.y)},${Math.floor(f.z)}|${radius}|${up}|${down}` : ''
  const t = now()
  if (key && e.last && e.lastKey === key && e.lastVersion === e.version && t - e.lastAt < ttl) {
    e.hits++
    return { ...e.last, cached: true }
  }
  e.misses++
  const res = classifyTerrain(b, { feet: f, radius, up, down })
  e.scans++
  // 不缓存 unknown（见上面那条 ⚠️）
  if (res.kind !== 'unknown') {
    e.last = res
    e.lastKey = key
    e.lastVersion = e.version
    e.lastAt = t
  }
  return { ...res, cached: false }
}

/** 把档案写到真的 `Movements` 上。返回**真正改动了**的字段（没变的不算）。 */
export function applyProfile (mv, profile) {
  const changed = []
  if (!mv || !profile?.cost) return changed
  for (const [field, val] of Object.entries(profile.cost)) {
    try {
      if (mv[field] === val) continue
      mv[field] = val
      changed.push(`${field}=${val}`)
    } catch { /* 只读属性 / 假对象：跳过，不影响其它字段 */ }
  }
  return changed
}
