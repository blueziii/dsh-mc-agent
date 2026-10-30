/* ============================================================================
 * 搭路（水平搭桥）—— `mc_act {mode:"bridge"}` 的正文（P0-2，2026-10-15）
 *
 * 为什么单独一层：**寻路库根本不会水平搭桥**。`mineflayer-pathfinder` 只会
 * `allow1by1towers` 那种"原地垫高"（`src\plugins.mjs` 的 `scafoldingBlocks`），
 * 遇到一条沟、一个缺口、悬空的路，它只会报 `NoPath`。这一层补的就是"一格格铺过去"。
 *
 * 用户 2026-10-15 点名的四条（原话）：
 *   A 检查前方与脚下（方块位置、支撑面、落差、背包材料）
 *   B 稳定站位并选择放置目标（锁定目标坐标，校验相邻支撑方块）
 *   C 放置一个方块（执行放置，**等待服务端确认结果**）
 *   D 验证成功再移动（确认方块存在、角色仍安全，再进入下一轮）
 * 失败处理：放置失败 / 目标坐标变化 / 脚下支撑异常 / 坠落风险 ⇒ **立即停止前进**，重新观察。
 * 🔴 2026-10-22（用户："很多格下面有岩浆 + 悬空搭" ⇒ "改成警告"）：桥下是要命方块
 *    （岩浆/火/岩浆块/营火/仙人掌/细雪）**不再一刀切拒铺** —— 改成照铺 + 结果里点名警告。
 *    还在拦的只剩"真会立刻把人弄死/弄没"的那几条：脚下不是实地、还在下落、血量 < 8、下方看不到底。

 *
 * 🔴 这一层的**全部价值**就是"**不确认就不前进**"（用户给的验收标准）：
 *    每放一块都回读服务端、每走一步都核对坐标与脚下，
 *    任何一处对不上就**停在那儿如实报**，绝不用"我以为放上了"继续往下铺。
 *
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.entity` / `b.health`），
 *       放方块复用 `self.placeBlock()`（够不着会自己走近、放完会复核）。
 * ========================================================================== */

import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg

import { sleep } from './async-util.mjs'
import { isAir, isLiquid, canPlaceInto, isSolidBlock, isTreeBlock, isLeafBlock } from './block-names.mjs'
import { pickPlaceItem } from './place-items.mjs'
import { heldText } from './inventory.mjs'
import { needLeft, insufficientText } from './budget.mjs'

/** 单次最多铺几格（一格的往返 ≈ 1.5 秒，16 格正好塞进一次调用） */
export const BRIDGE_MAX = 16
/** 生命低于它就不开新工程（摔下去会死） */
export const BRIDGE_MIN_HEALTH = 8
/** 桥面下方比这个还深就记一条风险（不拦，但如实说） */
export const BRIDGE_DEEP = 8
/** 往下找地面最多看多少格（超过它就算"深空"：知道很深、不知道多深；2026-10-22 从 24 加到 64） */
export const DROP_SCAN = 64
/** 放置后回读服务端的次数 / 间隔（1.21 在本地服上 200ms 通常就够，留点余量） */
export const BRIDGE_CONFIRM_TRIES = 8
export const BRIDGE_CONFIRM_MS = 150
/** 走一格的预算与到达半径（`arrive < 1.1` ⇒ `GoalNear` 半径 0，正好一格） */
export const BRIDGE_STEP_MS = 3500
export const BRIDGE_STEP_ARRIVE = 0.9
/** 会**要命**的方块：落在上面/旁边都不该继续（这份名单是唯一出处，下面的正则和寻路黑名单都由它生成） */
/* 🔴 2026-10-18 审计：`sweet_berry_bush` 从**致命**名单里拿掉 —— 它只减速、每秒 1 点血，
 *    而且**踩在丛上就能走过去**。留在名单里的后果是 `mc_auto.avoid()` 把它当岩浆：
 *    站上去就按后退、下一拍又走上去 ⇒ 来回震荡、永远过不去，还会一直叫醒 AI。
 *    真正致命的（岩浆/火/营火/仙人掌/细雪/岩浆块）仍然全在。 */
export const BRIDGE_FATAL_NAMES = ['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'powder_snow']
export const BRIDGE_FATAL = new RegExp(`^(${BRIDGE_FATAL_NAMES.join('|')})$`)
/** 掉进去不致命、但要如实说的 */
export const BRIDGE_WET = /^(water|bubble_column)$/
/** 危险方块的中文说法（报错里直接甩英文方块名，读的人还得多想一步） */
const FATAL_TEXT = {
  lava: '岩浆', fire: '火', soul_fire: '灵魂火', magma_block: '岩浆块', campfire: '营火',
  soul_campfire: '灵魂营火', cactus: '仙人掌', powder_snow: '细雪', sweet_berry_bush: '甜浆果丛',
}
/** `lava` ⇒ `岩浆(lava)`；不认识的方块就原样回 */
export const fatalText = (n) => (FATAL_TEXT[n] ? `${FATAL_TEXT[n]}(${n})` : String(n ?? '未知'))

/**
 * 把上面那份"要命方块"名单换成寻路器的黑名单 —— `Movements.blocksToAvoid` 收的是**方块 type id**
 * （`movements.js:49-53` 上游默认只放了 `fire` / `cobweb` / `web` / `lava`）。
 *
 * 上游拿它算 `b.safe`（`movements.js:233`：`b.safe = … && !this.blocksToAvoid.has(b.type)`），
 * 也就是**"这格能不能站"**。补上仙人掌 / 细雪 / 甜浆果丛 / 岩浆块 / 营火之后，
 * A* 会主动绕开它们，而不是"照走不误、走过去才发现掉血"。
 *
 * 拿不到 registry（假 bot / 没连上）就回空数组 —— 上层 `new Set([])` 也不会有副作用。
 */
export function avoidBlockIds (b) {
  const out = []
  try {
    const reg = b?.registry?.blocksByName
    if (!reg) return out
    for (const name of BRIDGE_FATAL_NAMES) {
      const id = reg[name]?.id
      if (typeof id === 'number') out.push(id)
    }
  } catch { /* registry 形状不对就当没有 */ }
  return out
}

/** 所有"树"类方块的 id（叶子 / 原木 / 去皮木 / 菌柄 / 巨型蘑菇）。
 *
 * 拿去填 `movements.blocksCantBreak` —— 让 A* 不把"挖穿树"当成一条路（见 `TREE_BLOCK_RE`）。
 * 拿不到 registry（假 bot / 没连上）就回空数组。
 */
export function treeBlockIds (b, { leaves = true } = {}) {
  const out = []
  try {
    const arr = b?.registry?.blocksArray
    if (!arr) return out
    for (const blk of arr) {
      if (!blk || typeof blk.id !== 'number') continue
      if (!isTreeBlock(blk.name)) continue
      /* 🔴 2026-10-29：`leaves:false` 时只回原木那类（树叶改成“加价”，见 block-names 的 isLeafBlock）。 */
      if (!leaves && isLeafBlock(blk.name)) continue
      out.push(blk.id)
    }
  } catch { /* registry 形状不对就当没有 */ }
  return out
}
/** 方向名 → 偏移。中英文都认（模型两种都会写）。 */
const DIRS = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  北: [0, -1], 南: [0, 1], 东: [1, 0], 西: [-1, 0],
  '-z': [0, -1], '+z': [0, 1], '+x': [1, 0], '-x': [-1, 0],
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
}

/** `"north"` / `"-z"` / `"北"` ⇒ `{ dx, dz, name }`；认不出来回 `null`。 */
export function dirOf (s) {
  const k = String(s ?? '').trim().toLowerCase()
  const d = DIRS[k]
  if (!d) return null
  return { dx: d[0], dz: d[1], name: dirNameOf(d[0], d[1]) }
}

/** 偏移 ⇒ 中文方向名（`mc_map` 的方位词跟它对齐） */
export function dirNameOf (dx, dz) {
  if (dz < 0 && !dx) return '北(-z)'
  if (dz > 0 && !dx) return '南(+z)'
  if (dx > 0 && !dz) return '东(+x)'
  if (dx < 0 && !dz) return '西(-x)'
  return `(${dx},${dz})`
}

/**
 * 从当前位置往 `dir` 数 `count` 格的**桥面格**（脚下一层）。
 *
 * 桥面铺在 `脚 - 1` 那一层：站在 (x,y,z)、脚下方块是 (x,y-1,z)，
 * 往前一格要铺的是 (x+dx, y-1, z+dz) —— 铺完就能走上去。
 */
export function bridgeCellsOf (feet, dir, count, slope = 0) {
  const out = []
  const s = Math.sign(Number(slope) || 0)
  for (let i = 1; i <= count; i++) out.push({ x: feet.x + dir.dx * i, y: feet.y - 1 + s * i, z: feet.z + dir.dz * i })
  return out
}

/**
 * 从"脚下"和"目标格"反推方向与格数（`mc_act{mode:"bridge"}` 走这条，省一个 `dir` 参数）。
 *
 * 目标 `(x,y,z)` 是**终点那一格**（铺在脚下一层，所以 `y` 必须等于 `脚.y - 1`）。
 * 只走直线：`x` 和 `z` 不能同时变（斜着铺每一步都够不着依附面）。
 */
export function bridgeDirTo (feet, { x, y, z } = {}) {
  const tx = Math.floor(Number(x)); const ty = Math.floor(Number(y)); const tz = Math.floor(Number(z))
  if (![tx, ty, tz].every(Number.isFinite)) throw new Error('mode:"bridge" 要给 x/y/z（铺到哪一格）')
  const dx = tx - feet.x; const dz = tz - feet.z
  if (dx && dz) throw new Error(`搭路只走直线（现在要从 (${feet.x},${feet.z}) 到 (${tx},${tz})，x 和 z 都在变）——`
    + '拆成两段（先铺 x 再铺 z），或先 mc_move 走到同一行/列')
  if (!dx && !dz) throw new Error('目标就是脚下这一格，不用搭')
  const sx = Math.sign(dx); const sz = Math.sign(dz)
  const count = Math.abs(dx) + Math.abs(dz)
  /* 桥面默认铺在脚下一层（y-1）。目标 y 更高/更低 ⇒ 每格升/降 1 格（阶梯，2026-10-25 用户
   * 「bridge 能不能再加搭阶梯，像挖 stair 那样的」）。只认「每格 ±1」：斜着一次跨两格够不着依附面。 */
  const dy = ty - (feet.y - 1)
  const slope = Math.sign(dy)
  if (dy !== 0 && Math.abs(dy) !== count) {
    throw new Error(`从脚下一层 y=${feet.y - 1} 铺到 y=${ty} 要升降 ${Math.abs(dy)} 格，但这段路只有 ${count} 格——`
      + '搭阶梯只能**每格升降 1 格**（把目标 y 改成 ' + (feet.y - 1 + slope * count) + '，或者把距离改长）')
  }
  return { dir: { dx: sx, dz: sz, name: dirNameOf(sx, sz) }, count, slope }
}

/** 从 `pos` 往下数几个空格才踩到实地（`max` 之内没有就回 `null`） */
export function dropBelow (b, pos, max = 24) {
  const r = dropProbe(b, pos, max)
  return r.drop
}

/**
 * 跟 `dropBelow` 一样往下看，但**把三种"看不见底"分清楚**（2026-10-22 用户：
 * 「改，有会超过24格的情况」）：
 *   · `{ drop: 3 }`                       —— 3 格内踩到实地
 *   · `{ drop: null, unloaded: true }`    —— 读到 null（区块没加载）⇒ 真·不知道，别搭
 *   · `{ drop: null, bottomed: true }`    —— 一路全是空气/液体到 max 还没见到底 ⇒ **深空**，
 *                                            知道它很深但不知道多深 ⇒ 记风险放行（悬空长廊就该长这样）
 *   · `{ drop: null }`                    —— 其它（读方块抛错）
 */
export function dropProbe (b, pos, max = 24) {
  for (let d = 1; d <= max; d++) {
    let blk = null
    try { blk = b.blockAt(new Vec3(pos.x, pos.y - d, pos.z)) } catch { return { drop: null } }
    if (!blk) return { drop: null, unloaded: true }   // 未加载 ⇒ 说"不知道"，别猜
    if (isSolidBlock(blk.name)) return { drop: d - 1 }
  }
  return { drop: null, bottomed: true }
}

/** 从 `pos` 往下（含自己）扫 `depth` 格，第一个要命/要湿的方块 */
export function hazardIn (b, pos, depth = 6) {
  for (let d = 0; d <= depth; d++) {
    let blk = null
    try { blk = b.blockAt(new Vec3(pos.x, pos.y - d, pos.z)) } catch { return null }
    if (!blk) return null
    if (BRIDGE_FATAL.test(blk.name)) return { kind: 'fatal', name: blk.name, dy: -d }
    if (BRIDGE_WET.test(blk.name)) return { kind: 'wet', name: blk.name, dy: -d }
    if (isSolidBlock(blk.name)) return null   // 踩到实地就安全了，不用再往下看
  }
  return null
}

/**
 * **A 检查前方与脚下** —— 开铺之前的静态判据（放一块之前每一步也会再查一遍）。
 *
 * 返回 `{ ok, why, cells, drop, hazard, risk }`。`ok:false` 时 `why` 是要给模型看的人话。
 */
export function bridgeSafetyOf (b, { feet, dir, count = 1, slope = 0, item = null, need = 1, minHealth = BRIDGE_MIN_HEALTH } = {}) {
  const cells = bridgeCellsOf(feet, dir, count, slope)
  const health = Number(b?.health)
  if (Number.isFinite(health) && health < minHealth) {
    return { ok: false, why: `血量只有 ${health}（低于 ${minHealth}）——搭桥是悬空作业，摔下去就没了，先回血再搭`, cells }
  }
  // 脚下必须站在实地上（悬空/下落中不铺 —— 铺了也是白铺，人还在掉）
  const under = b.blockAt(new Vec3(feet.x, feet.y - 1, feet.z))
  if (!under || !isSolidBlock(under.name)) {
    return { ok: false, why: `脚下 (${feet.x},${feet.y - 1},${feet.z}) 是 ${under?.name ?? '未加载'}，不是实地——先站稳再搭`, cells }
  }
  if (item && need > 1 && item.count < need) {
    return { ok: false, why: `背包里 ${item.name} 只剩 ${item.count} 块，铺不到 ${need} 格——先补料，或把 count 改小`, cells }
  }
  // 逐格看：要命方块 ⇒ 只记警告（不再硬拦，见文件头）；落差 ⇒ 记风险（搭桥本来就是跨深沟）
  let worstDrop = 0
  let bottomless = false
  let risk = null
  const hazards = []
  for (const c of cells) {
    const hz = hazardIn(b, c, 6)
    if (hz?.kind === 'fatal') {
      /* 🔴 2026-11-02 审计（#8）：这里原来直接 `continue` —— 跳过下面 `probe.unloaded` 那道闸门，
       *   "岩浆 + 下方区块没加载"从**有话说**变成一句不提。岩浆格本来只警告（用户 2026-10-22
       *   「改成警告」不改），但**不知道多深**这件事必须说出来 —— 模型据此决定绕不绕。 */
      const probeF = dropProbe(b, c, DROP_SCAN)
      const deep = probeF.unloaded ? '（下方区块没加载，不知道多深）' : (probeF.bottomed ? '（下面一路空到底，很深）' : '')
      hazards.push({ x: c.x, y: c.y, z: c.z, name: hz.name, dy: hz.dy, text: fatalText(hz.name) + deep, deep })
      continue
    }
    if (hz?.kind === 'wet' && !risk) risk = `桥下 ${Math.abs(hz.dy)} 格是${hz.name}（掉下去淹不死但会湿透）`
    const probe = dropProbe(b, c, DROP_SCAN)
    if (probe.unloaded) {
      return { ok: false, why: `前方 (${c.x},${c.y},${c.z}) 下方区块没加载（读到 null）——**不知道深浅就不搭**，先走靠近再看`, cells }
    }
    if (probe.bottomed) {
      // 一路空到扫描深度：明确是"很高的悬空"（用户 2026-10-22：有超过 24 格的情况）⇒ 照搭，记风险
      bottomless = true
      if (worstDrop < DROP_SCAN) worstDrop = DROP_SCAN
      continue
    }
    if (probe.drop > worstDrop) worstDrop = probe.drop
  }
  /* 阶梯（slope ≠ 0）时「桥面下方是空的」是故意的 —— 下面就是下一级台阶，不该当风险报。 */
  if (worstDrop >= BRIDGE_DEEP && !risk && !Math.sign(Number(slope) || 0)) risk = `桥下最深 ${worstDrop} 格是空的（悬空作业，摔下去会掉血）`
  if (bottomless) risk = `桥下 ${DROP_SCAN} 格内都没到底（真·悬空长廊，掉下去基本没救${worstDrop > DROP_SCAN ? '；最深落差已超过扫描深度' : ''}）` + (risk ? `；另外${risk}` : '')
  if (hazards.length > 0) {
    const h0 = hazards[0]
    const head = `桥下有${h0.text}：最近 (${h0.x},${h0.y},${h0.z}) 下方 ${Math.abs(h0.dy)} 格，共 ${hazards.length} 格踩空就掉进去`
    risk = risk ? `${head}；另外${risk}` : head
  }
  return { ok: true, cells, drop: worstDrop, risk, hazardCount: hazards.length, hazards: hazards.slice(0, 6) }
}

/**
 * **C 的确认**：回读服务端，直到那一格真的变成 `name`。返回 `true`/`false`。
 *
 * 为什么不能只信 `placeBlock()` 的复核：它固定 `sleep(200)` 就读一次，
 * 局域网够用，但服务端一忙（或延迟高）就会把"其实放上了"读成"没放上"，
 * 反过来也可能把"服务端稍后才回绝"读成"放上了"。这里多读几次、**只认最终状态**。
 */
export async function confirmBlockAt (b, pos, name, { tries = BRIDGE_CONFIRM_TRIES, ms = BRIDGE_CONFIRM_MS } = {}) {
  for (let i = 0; i < tries; i++) {
    let now = null
    try { now = b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name ?? null } catch { now = null }
    if (now === name) return true
    if (i === tries - 1) return false
    await sleep(ms)
  }
  return false
}

/** 现在站着的格子（地板坐标） */
export function feetOf (b) {
  const p = b.entity.position
  return { x: Math.floor(p.x), y: Math.floor(p.y + 0.001), z: Math.floor(p.z) }
}

/**
 * **搭一条水平的路**：从脚下朝 `dir` 铺 `count` 格，每放一块确认了才走一步。
 *
 * 返回 `{ ok, placed, walked, stopped, why, ... }`。
 * `stopped:true` + `why` 是**正常的收场方式**（用户要的就是"不行就停在这儿说清楚"）。
 */
async function bridgeAcrossInner (self, { dir, count = 1, name = null, minHealth = BRIDGE_MIN_HEALTH, x = null, y = null, z = null, slope = 0 } = {}, ctx = {}) {
  const b = self.requireBot()
  const start = feetOf(b)
  /* 方向/格数：给了 dir 就用它；否则从目标格 (x,y,z) 反推（`mc_act{mode:"bridge"}` 走这条）。 */
  let d = null
  let n = 0
  let sl = Math.sign(Number(slope) || 0)
  if (dir != null) {
    d = typeof dir === 'string' ? dirOf(dir) : dir
    if (!d) throw new Error(`dir 认不出来（给了 ${JSON.stringify(dir)}）——用 north/south/east/west 或 +x/-x/+z/-z`)
    n = Math.max(1, Math.min(Math.floor(Number(count) || 1), BRIDGE_MAX))
  } else {
    const derived = bridgeDirTo(start, { x, y, z })
    d = derived.dir
    sl = derived.slope
    n = Math.max(1, Math.min(derived.count, BRIDGE_MAX))
    if (derived.count > BRIDGE_MAX) {
      throw new Error(`要铺 ${derived.count} 格，超过单次上限 ${BRIDGE_MAX}——分几次铺（第一次铺完再叫一次，铺好的会跳过）`)
    }
  }
  const want = name ? String(name) : null

  const held0 = heldText(b)
  let item = pickPlaceItem(b, want)
  if (!item) {
    throw new Error(want
      ? `背包里没有 ${want}——搭路得先有方块（mc_dig 挖点土/圆石，或 mc_craft 做木板）`
      : '背包里没有能当搭路料的整方块（火把/门/半砖放下去站不住）——先 mc_dig 挖点土或圆石')
  }

  const plan = bridgeCellsOf(start, d, n, sl)
  const safety = bridgeSafetyOf(b, { feet: start, dir: d, count: n, slope: sl, item, need: n, minHealth })
  if (!safety.ok) {
    return {
      ok: false, stopped: true, why: safety.why, dir: d.name, count: n,
      from: start, cells: plan, placed: 0, walked: 0, held: heldText(b),
      hint: '先解决上面那条，再叫一次 mc_act{mode:"bridge"}（已经铺好的格子会跳过，不用重铺）。',
    }
  }

  const placed = []
  const skipped = []
  /* 🔴 2026-10-19 实机：在**本来就是实地**的地方搭路（超平坦最常见），要铺的那层是实心 ⇒ 走 `skipped`
   *    分支；而"该站的那一格"(deck.y+1) 又被别的方块占着 ⇒ walkTo 只能把人放到 deck.y+2。
   *    人明明已经在同一列上，高度差是地形造成的 —— 以前这里判死"没走到"，整趟报 failed。
   *    这些格单独记下来，结果里如实说"站到了它上面一层"，不算没走。 */
  const stoodAbove = []
  /** 逐格复查时攒下的警告（要命方块）——只说不拦 */
  const warned = []
  let walked = 0
  const deadline = Date.now() + self.callLeft()
  /** 收场：任何一处对不上都从这里出去，**绝不继续往下铺** */
  const stop = (why, extra = {}) => ({
    ok: false, stopped: true, why, dir: d.name, count: n, from: start,
    placed: placed.length, walked, placedAt: placed, ...(skipped.length ? { skipped: skipped.length } : {}),
    ...(warned.length ? { warnings: warned.slice(0, 8), warningCount: warned.length } : {}),
    held: heldText(b), ...extra,
    hint: '**别在当前这一格继续硬铺**：先 mc_scan / mc_map 看看前面到底什么样（多半是服务端拒了放置、或脚下已经不是实地）。'
      + '已经铺好的格子会跳过，处理完再叫一次同一个方向就行。',
  })

  for (let i = 0; i < n; i++) {
    const deck = plan[i]
    const at = `${deck.x},${deck.y},${deck.z}`
    const before = feetOf(b)

    // ── 每一轮都重新查一遍（走了一格之后"脚下"就变了，静态判据不能复用） ──
    if (deadline - Date.now() < 500) {
      return {
        ok: placed.length > 0, stopped: true, why: `这一轮的 ${Math.round(self.callLeft() / 1000)} 秒用完了`,
        dir: d.name, count: n, from: start, placed: placed.length, walked, placedAt: placed, held: heldText(b),
        remaining: n - i,
        hint: `已经铺了 ${placed.length} 格、往前走了 ${walked} 格。再叫一次 mc_act{mode:"bridge"}（同一个 dir / count）接着铺，**铺好的会跳过**。`,
      }
    }
    // 下落中 / 没站在实地上 ⇒ 停（这是"坠落风险"那条）
    if (b.entity.onGround === false) {
      await sleep(300)
      if (b.entity.onGround === false) return stop(`脚下没踩实（还在下落）——**先落地再搭**，悬空铺方块只会越铺越糟`)
    }
    const underNow = b.blockAt(new Vec3(before.x, before.y - 1, before.z))
    if (!underNow || !isSolidBlock(underNow.name)) {
      return stop(`脚下 (${before.x},${before.y - 1},${before.z}) 变成了 ${underNow?.name ?? '未加载'}——**支撑面没了，立刻停**（再往前就是往下掉）`)
    }
    const hz = hazardIn(b, deck, 6)
    if (hz?.kind === 'fatal') {
      // 用户 2026-10-22：「改成警告」—— 不拦，记一条接着铺（掉下去是玩家自己的选择）
      const line = `(${at}) 下方 ${Math.abs(hz.dy)} 格是 ${fatalText(hz.name)}`
      if (!warned.includes(line)) warned.push(line)
    }
    const health = Number(b.health)
    if (Number.isFinite(health) && health < minHealth) {
      return stop(`血量掉到 ${health}（低于 ${minHealth}）——**先回血**，悬空作业不值得拿命换`)
    }

    // ── B/C：这一格已经有实心方块就不用放（断点续铺 / 本来就有路） ──
    const cur = b.blockAt(new Vec3(deck.x, deck.y, deck.z))
    if (cur && isSolidBlock(cur.name)) {
      skipped.push(`${at}:${cur.name}`)
    } else {
      if (!cur) return stop(`(${at}) 未加载（区块还没到）——先 mc_map 看看，或换个方向`)
      if (!canPlaceInto(cur)) {
        return stop(`(${at}) 被 ${cur.name} 占住，放不进去——换个方向，或先 mc_act{mode:"break"} 清掉它`)
      }
      // 材料（每放一块都重挑：背包里可能换过手 / 用光了）
      item = pickPlaceItem(b, want)
      if (!item) return stop(`背包里已经没有能搭的整方块了（手里是 ${heldText(b)}）——先补料`)
      const r = await self.placeBlock({ x: deck.x, y: deck.y, z: deck.z, name: want })
      if (!r?.placed) {
        return stop(`(${at}) **没放上去**（现在那里是 ${r?.now ?? '未加载'}）——服务端可能拒了这次放置（领地保护 / 权限 / 太远 / 失步）`, { placedResult: r })
      }
      // 🔴 C 的确认：只认回读到的最终状态，不认"我以为放上了"
      if (!await confirmBlockAt(b, deck, r.placed)) {
        const now = b.blockAt(new Vec3(deck.x, deck.y, deck.z))?.name ?? '未加载'
        return stop(`(${at}) 放完回读是 ${now}，**不是** ${r.placed}——服务端没认这次放置，**不前进**`)
      }
      placed.push(`${at}:${r.placed}`)
    }

    // ── D：验证方块在了，才走一格 ──
    const stepTo = { x: deck.x, y: deck.y + 1, z: deck.z }
    let moveErr = null
    try {
      /* 🔴 2026-10-29：这一格走不过去就别硬挤（不再 `max(800, …)` 硬压） */
      const nbStep = needLeft(self, 800, Math.min(BRIDGE_STEP_MS, Math.max(0, deadline - Date.now() - 300)))
      if (!nbStep.ok) {
        return stop(`铺好了 (${at})，但这一轮不够走过去（${insufficientText(nbStep, '走到下一块')}）——停在原地`, { stepTarget: stepTo })
      }
      const mv = await self.walkTo(stepTo, { arrive: BRIDGE_STEP_ARRIVE, budget: nbStep.budgetMs })
      if (mv && mv.arrived === false) moveErr = mv.reason || '没走到'
    } catch (e) { moveErr = e?.message ?? '走路报错' }
    if (moveErr) {
      return stop(`铺好了 (${at})，但**没走过去**（${moveErr}）——停在原地，不硬挤`, { stepTarget: stepTo })
    }
    const after = feetOf(b)
    /* 「该站的那格被占着 ⇒ 人站到了它上面一层」——同一列、高一格、且那格真是实心，才认 */
    const upper = after.x === stepTo.x && after.z === stepTo.z && after.y === stepTo.y + 1
      ? b.blockAt(new Vec3(stepTo.x, stepTo.y, stepTo.z))
      : null
    const onTop = Boolean(upper?.name && isSolidBlock(upper.name))
    if ((after.x !== stepTo.x || after.z !== stepTo.z || after.y !== stepTo.y) && !onTop) {
      return stop(`铺好了 (${at})，但人站在 (${after.x},${after.y},${after.z})、没到 (${stepTo.x},${stepTo.y},${stepTo.z})——**不按"走过去了"算**`, { stepTarget: stepTo, nowAt: after })
    }
    if (onTop) stoodAbove.push(`${stepTo.x},${stepTo.y},${stepTo.z}:${upper.name}`)
    const floorNow = b.blockAt(new Vec3(after.x, after.y - 1, after.z))
    if (!floorNow || !isSolidBlock(floorNow.name)) {
      return stop(`走到 (${after.x},${after.y},${after.z}) 之后脚下是 ${floorNow?.name ?? '未加载'}——**支撑没了**，别再往前`)
    }
    walked++
  }

  const end = feetOf(b)
  const held = heldText(b)
  return {
    ok: true, dir: d.name, count: n, ...(sl ? { slope: sl } : {}), from: start, to: end,
    placed: placed.length, walked,
    ...(placed.length ? { placedAt: placed.slice(0, 8) } : {}),
    ...(skipped.length ? { skipped: skipped.length, skippedWhy: `这 ${skipped.length} 格本来就有方块（不是空档），没重铺：${skipped.slice(0, 3).join('、')}` } : {}),
    ...(stoodAbove.length ? { stoodAbove: stoodAbove.length, stoodAboveWhy: `有 ${stoodAbove.length} 格「该站的位置」被方块占着，人站到了它上面一层（${stoodAbove.slice(0, 3).join('、')}）—— 同一列，算走到了` } : {}),
    ...(safety.risk ? { risk: safety.risk } : {}),
    ...(warned.length ? { warnings: warned.slice(0, 8), warningCount: warned.length } : {}),
    ...(held !== held0 ? { held, heldBefore: held0 } : { held }),
    ...(placed.length === n ? { hint: '整条铺完了，人也走过来了。' } : {}),
  }
}

/* ═══════════════ 收工把手换回来（用户 2026-10-19） ═══════════════ */

/** 动手前手里的东西 —— 只在"有东西可还"时给（空手就是 null，不用还） */
export function heldSnapshotOf (b) {
  const it = b?.heldItem ?? null
  const slot0 = Number(b?.quickBarSlot)
  const slotOk = Number.isInteger(slot0) && slot0 >= 0 && slot0 < 9
  /* 🔴 2026-10-21（用户："搭路自动切回去…不生效"）：**空手也要记快照**。
   *    原来空手返回 null ⇒ `bridgeAcross` 的 `if (keep)` 直接跳过还原，
   *    搭完桥手里还攥着那摞方块 —— 用户看到的就是"没切回去"。
   *    现在记 `{ empty: true }`，收工时切回一个空热键格（`restoreHeldOf`）。 */
  if (!it?.name) return { empty: true, name: null, ...(slotOk ? { slot: slot0 } : {}) }
  /* 🔴 2026-10-20 审计：快照里补上**选中槽位**。`shoot` 取消拉弓是靠
   *    `setQuickBarSlot((slot+1)%9)` 做的（切槽 = 取消拉弓且不发射），只记名字的话
   *    还原时 `equip(item,'hand')` 会塞进**当前**选中槽 ⇒ 选中槽偏移一格、两格物品互换。 */
  return { empty: false, name: it.name, ...(slotOk ? { slot: slot0 } : {}) }
}

/**
 * 把手换回 `snap` 那件（搭完桥切回之前的武器 / 镐子）。
 *
 * 只在"确实换了手、且那件还在背包里"时动手；**失败不抛错** —— 桥已经搭完了，
 * 换不回来是件小事，如实说一句就行，不该把整次搭路判成失败。
 * @returns {{ restored:boolean, now:string|null, why?:string }}
 */
export async function restoreHeldOf (b, snap) {
  /* 先还原**选中槽位**（`shoot` 取消拉弓时切过一格）—— 必须在下面那些 early return 之前，
   * 否则"手里已经是那件了"会提前返回，槽位永远偏移着。 */
  if (Number.isInteger(snap?.slot) && b?.quickBarSlot !== snap.slot && typeof b.setQuickBarSlot === 'function') {
    try { b.setQuickBarSlot(snap.slot) } catch { /* 假 bot / 不支持：跳过 */ }
  }
  const now0 = b?.heldItem ?? null
  /* 空手起步：收工时把方块"放下"（切到一个空的热键格；不行再试 `equipEmpty()`）。
   * 用户原话只要求"切回去"，空手也是"回去"的一种。 */
  if (!snap?.name) {
    if (!now0?.name) return { restored: false, now: null }
    let emptied = false
    try {
      const slots = b?.inventory?.slots ?? []
      let free = null
      for (let i = 0; i < 9; i++) if (!slots[36 + i]) { free = i; break }
      if (free != null && typeof b.setQuickBarSlot === 'function') { b.setQuickBarSlot(free); emptied = !b?.heldItem?.name }
      if (!emptied && typeof b.equipEmpty === 'function') { await b.equipEmpty(); emptied = !b?.heldItem?.name }
    } catch { /* 清不掉就算了，如实说 */ }
    const nowE = b?.heldItem?.name ?? null
    return emptied && !nowE
      ? { restored: true, now: null }
      : { restored: false, now: nowE, why: `原来就是空手，想把手里的 ${nowE ?? '东西'} 放下，没放掉` }
  }
  const now = now0
  if (now?.name === snap.name) return { restored: false, now: now.name }
  let item = null
  try { item = (b.inventory?.items?.() ?? []).find((i) => i?.name === snap.name) ?? null } catch { item = null }
  if (!item) return { restored: false, now: now?.name ?? null, why: `背包里已经没有 ${snap.name} 了` }
  try { await b.equip(item, 'hand') } catch (e) {
    return { restored: false, now: b?.heldItem?.name ?? null, why: `换回 ${snap.name} 失败：${String(e?.message ?? e).slice(0, 60)}` }
  }
  const after = b?.heldItem?.name ?? null
  return after === snap.name
    ? { restored: true, now: after }
    : { restored: false, now: after, why: `换回 ${snap.name} 之后手里是 ${after ?? '空'}` }
}

/**
 * 搭路（`mc_act {mode:"bridge"}`）：铺完之后**把手换回来**。
 *
 * 🔴 为什么要有这一层（用户 2026-10-19 实机原话）：「搭路现在搭完后不会自动切回之前的武器」——
 *    搭桥要拿方块、放方块会把方块 `equip` 到手上，铺完手里还攥着一摞圆石；
 *    下一场架就拿着圆石挥，AI 也看不出"手被搭路改过"。
 *    这里在**所有返回路径**上（成功 / 被拒 / 半路停 / 超时 / 抛错）统一还原，
 *    而不是在每个 `return` 前各写一遍（那样迟早漏一个，见踩坑档案「收尾写在两处」那类）。
 */
export async function bridgeAcross (self, opts = {}, ctx = {}) {
  const b = self.requireBot()
  const keep = heldSnapshotOf(b)
  let out = null
  try {
    out = await bridgeAcrossInner(self, opts, ctx)
    return out
  } finally {
    if (keep) {
      const r = await restoreHeldOf(b, keep)
      if (out) {
        if (r.restored) {
          out.held = r.now ? `${r.now}x${b?.heldItem?.count ?? 1}` : '空手'
          out.heldRestored = keep.name ?? '空手'
        } else if (out.held !== (keep.name ? `${keep.name}x${b?.heldItem?.count ?? 1}` : '空手') && r.why) {
          out.heldRestoreWhy = r.why
        }
      }
    }
  }
}
