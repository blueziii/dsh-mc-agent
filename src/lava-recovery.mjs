/**
 * 岩浆脱困：泡在岩浆里、四面八方都是岩浆时的那一套动作。
 *
 * 🔴 2026-10-27 实机（用户："现在掉在岩浆里动不了"）—— 原来的行为是**什么都不做**：
 *   · `walkToOnce` 只有"在水里"的分支（`inWaterNow`），岩浆落到 else 走 A*；
 *   · A* 眼里岩浆格 `safe=false` ⇒ 立刻 NoPath，`moved:0`；
 *   · 就算放开黑名单也上不来：vendor 的自动上浮只认 `entity.isInWater`（岩浆不触发）⇒ 沉底；
 *   · `lavaAheadOf`（前方 3 格是岩浆就拒绝走）在**自己泡在岩浆里**时必然命中 ⇒ 脱困阶梯每轮
 *     `continue` 空耗预算，直到 10 秒用完，hint 还写着"再叫一次会接着走"。
 *   岩浆 4 点/0.5 秒（不吃护甲），20 血约 2.5 秒烧光 —— 重叫 `mc_move` 是必死的。
 *
 * 这一层只做三件事，**不另起一套移动代次**（用户 2026-10-15 的约束：实际移动仍走现有接口）：
 *   ① 按住 `jump` 上浮（岩浆里按 jump = 往上浮，不按就沉底）；
 *   ② BFS 找最近"能站且脚下不是岩浆/火"的格子（允许穿过岩浆/水/空气 —— 岩浆里跑不了 A*）；
 *   ③ 面朝它 `forward` + `jump` 最多几秒；到岸（脚下非岩浆且 `onGround`）就交回去，
 *      逃不出来就**如实报坐标/血/四周方块**并给出"垫方块 or tp"的建议，不再空转。
 *
 * 不 import `movement.mjs`（那边要 import 本模块，双向就会成环）。
 */
import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
import { sleep } from './async-util.mjs'
import { BRIDGE_FATAL } from './bridge.mjs'
import { isAir, isPassable, isLavaLike, isWaterLike, isSolidBlock } from './block-names.mjs'
import { inLavaNow, entityHealth } from './world-observer.mjs'

/** 搜岸的默认范围：岩浆池一般不大，先近处找；找不到再由调用方放大。 */
export const LAVA_RADIUS = 8
export const LAVA_UP = 4
export const LAVA_DOWN = 4
export const LAVA_MAX_NODES = 900
/** 每层看一眼表就够（`Date.now()` 也要钱，不能每格都问）。 */
export const LAVA_MAX_MS = 200
/** 先上浮多久（不按 jump 会一直沉底挨烧）。 */
export const LAVA_FLOAT_MS = 600
/** 朝最近的岸最多游多久 —— 岩浆里速度只有走路的 1/4 左右。 */
export const LAVA_SWIM_MS = 3_000
/** 每一小步按键多久（中途要重新瞄准、重新找岸）。 */
export const LAVA_STEP_MS = 300

const keyOf = (x, y, z) => `${x},${y},${z}`
const NEIGHBORS = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]

const nameAt = (b, x, y, z) => {
  try {
    const blk = b?.blockAt?.(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    return typeof blk?.name === 'string' ? blk.name : null
  } catch { return null }
}

const posOf = (b) => {
  const p = b?.entity?.position
  if (!p) return null
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

/** 一格能不能"穿过去"（岩浆里游的时候允许岩浆/水/空气/可穿方块）。 */
export function passableInLavaAt (b, x, y, z) {
  const n = nameAt(b, x, y, z)
  if (n == null) return false          // 区块没加载：不当空气
  return isAir(n) || isPassable(n) || isWaterLike(n) || isLavaLike(n)
}

/**
 * 这一格能不能当"岸"站上去：身体两格不是实体、脚下是实心、而且脚下那格不是岩浆/火/仙人掌。
 * 三条缺一不可 —— 只看"脚那格是空气"会把岩浆池上方的悬空洞口也当成岸。
 */
export function shoreAt (b, x, y, z) {
  const feet = nameAt(b, x, y, z)
  const head = nameAt(b, x, y + 1, z)
  if (feet == null || head == null) return false
  const open = (n) => isAir(n) || isPassable(n) || isWaterLike(n)
  if (!open(feet) || !open(head)) return false
  const under = nameAt(b, x, y - 1, z)
  if (under == null || BRIDGE_FATAL.test(under)) return false
  return isSolidBlock(under)
}

/**
 * 从当前位置 BFS 找**最近**能站的岸（6 邻域、分层 BFS ⇒ 第一次撞上的就是最近的）。
 *
 * 和 `waterExitSearch` 的区别：那个只肯从"水里"出发、而且把岩浆判成 `blocked`（墙），
 * 泡在岩浆里会直接返回 `not-in-water`。这里反过来 —— **岩浆格是唯一能走的路**。
 */
export function lavaExitSearch (b, { feet = null, radius = LAVA_RADIUS, up = LAVA_UP, down = LAVA_DOWN, maxNodes = LAVA_MAX_NODES, maxMs = LAVA_MAX_MS } = {}) {
  const f = feet ?? posOf(b)
  const bounds = { radius, up, down }
  const fail = (reason, note) => ({ found: false, target: null, distance: null, scanned: 0, bounds, reason, note })
  if (!f) return fail('unknown-world', '读不到自己在哪 —— 搜不了岸')

  const sx = Math.floor(f.x); const sy = Math.floor(f.y); const sz = Math.floor(f.z)
  const seen = new Set([keyOf(sx, sy, sz)])
  const dist = new Map([[keyOf(sx, sy, sz), 0]])
  const queue = [[sx, sy, sz]]
  let head = 0
  let scanned = 1
  const deadline = Date.now() + Math.max(0, Number(maxMs) || 0)

  while (head < queue.length && scanned < maxNodes) {
    if ((head & 63) === 0 && Date.now() >= deadline) break
    const [x, y, z] = queue[head++]
    const d = dist.get(keyOf(x, y, z))
    if (d > 0 && shoreAt(b, x, y, z)) {
      return {
        found: true, target: { x, y, z }, distance: d, scanned, bounds, reason: 'ok',
        note: `最近的岸在 (${x},${y},${z})，${d} 步远`,
      }
    }
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx; const ny = y + dy; const nz = z + dz
      if (Math.abs(nx - sx) > radius || Math.abs(nz - sz) > radius) continue
      if (ny > sy + up || ny < sy - down) continue
      const k = keyOf(nx, ny, nz)
      if (seen.has(k) || !passableInLavaAt(b, nx, ny, nz)) continue
      seen.add(k)
      dist.set(k, d + 1)
      queue.push([nx, ny, nz])
      scanned++
    }
  }
  return fail('no-shore', `半径 ${radius} 格内没找到能站的岸（搜了 ${scanned} 格）`)
}

/**
 * 泡在岩浆里时自己爬出来。返回结构由 `movement.mjs` 原样塞进 `mc_move` 的结果里。
 *
 * @returns {{ escaped:boolean, reason:string, moved:number, hp:number|null, hpBefore:number|null,
 *             findShore:object|null, floatMs:number, swimMs:number, tries:number, position:object|null, hint:string }}
 */
export async function lavaEscape (self, { floatMs = LAVA_FLOAT_MS, swimMs = LAVA_SWIM_MS } = {}, ctx = {}) {
  const b = self.requireBot()
  const gen = typeof ctx.beginMove === 'function' ? ctx.beginMove('lava') : ++self._moveGen
  const t0 = Date.now()
  const start = b?.entity?.position?.clone?.() ?? b?.entity?.position ?? null
  const hp0 = entityHealth(b, b?.entity)
  const set = (k, v) => { try { b.setControlState(k, v) } catch { /* 假 bot */ } }
  const out = {
    escaped: false, reason: 'unknown', moved: 0, hp: hp0, hpBefore: hp0,
    findShore: null, floatMs: 0, swimMs: 0, tries: 0, position: posOf(b),
  }
  const distFrom = () => {
    const p = b?.entity?.position
    if (!p || !start?.distanceTo) return 0
    return Math.round(start.distanceTo(p) * 100) / 100
  }

  if (!inLavaNow(b)) {
    return { ...out, escaped: true, reason: 'not-in-lava', note: '我不在岩浆里 —— 这条是给"泡在岩浆里"用的' }
  }

  try {
    /* ① 先上浮：岩浆里不按 jump 会一直沉底（越沉视野越差、也越难蹭到岸） */
    const left0 = typeof self.callLeft === 'function' ? self.callLeft() : 4_000
    const f = Math.max(0, Math.min(Number(floatMs) || 0, left0 - 800))
    if (f > 100) {
      set('jump', true)
      await sleep(f)
      set('jump', false)
      out.floatMs = f
    }

    /* ② 上浮之后再找岸（浮起来视野才好） */
    const ex = lavaExitSearch(b)
    out.findShore = { found: ex.found, target: ex.target, distance: ex.distance, scanned: ex.scanned, reason: ex.reason }
    if (!ex.found) {
      return {
        ...out,
        escaped: false, stuck: true, reason: 'no-shore',
        moved: distFrom(), hp: entityHealth(b, b?.entity), position: posOf(b),
        hint: `我泡在岩浆里（${ex.note}），已经按住 jump 上浮了 ${out.floatMs}ms 但还是没岸可上 —— 血在掉，`
          + '**别等我**：① 先 `mc_act {mode:"place"}` 往脚下垫方块站上去，或者 ② 把我 tp 出去。',
      }
    }

    /* ③ 朝最近的岸游：每 `LAVA_STEP_MS` 重新瞄一次（岩浆里会被人/怪撞歪，一次瞄准不够） */
    const tgt = ex.target
    const aim = new Vec3(tgt.x + 0.5, tgt.y + 0.6, tgt.z + 0.5)
    const left1 = typeof self.callLeft === 'function' ? self.callLeft() : 3_000
    const swimBudget = Math.max(0, Math.min(Number(swimMs) || 0, left1 - 500))
    const deadline = Date.now() + swimBudget
    while (Date.now() < deadline) {
      if (self._moveGen !== gen) return { ...out, escaped: false, stuck: false, reason: 'preempted', moved: distFrom(), hint: '被另一次移动接管了，岩浆脱困中断。' }
      /* 已经上岸（脚下不是岩浆，且真站在地上）就收工 */
      if (!inLavaNow(b) && b?.entity?.onGround === true) break
      try { b.lookAt(aim, true) } catch { /* 假 bot */ }
      set('forward', true)
      set('jump', true)
      await sleep(LAVA_STEP_MS)
      out.tries++
    }
    out.swimMs = Date.now() - t0 - out.floatMs
  } finally {
    set('forward', false)
    set('jump', false)
    if (self._moveGen === gen && typeof ctx.releaseControls === 'function') {
      try { ctx.releaseControls() } catch { /* 松不开就算了 */ }
    }
  }

  const hp = entityHealth(b, b?.entity)
  const escaped = !inLavaNow(b)
  const moved = distFrom()
  if (escaped) {
    return {
      ...out, escaped: true, reason: 'lava-escape', moved, hp, position: posOf(b),
      hint: `我掉进岩浆了，**自己爬出来了**（上浮 ${out.floatMs}ms + 朝岸 ${out.tries} 步，挪了 ${moved} 格，血 ${hp ?? '?'}）—— `
        /* 🔴 2026-10-27 实机（session-514c21b6）：「从岩浆里爬出来脚还在岩浆边就停下吃东西，
         *   直接烧死了」。出了岩浆 ≠ 火灭了（引燃还在烧）⇒ 这时必须明说"别停"。 */
        + (b?.entity?.fire === true
          ? '⚠️ 但**身上还着着火**：先走到水里或空地等它灭，**别停下吃东西**（实机就是这么烧死的），再按原目标走。'
          : '接着按原目标走。'),
    }
  }
  return {
    ...out, escaped: false, stuck: true, reason: 'lava-stuck', moved, hp, position: posOf(b),
    hint: `我泡在岩浆里，朝岸按了 ${out.tries} 步还是没上岸（挪了 ${moved} 格，血 ${hp ?? '?'}）—— `
      + '岩浆里游不快，**别继续叫 mc_move 硬试**：先 `mc_act {mode:"place"}` 往脚下垫方块站上去，或把我 tp 出去。',
  }
}
