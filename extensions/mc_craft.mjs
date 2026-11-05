/**
 * mc_craft —— 真·合成能力（dsh-mc-agent 扩展）
 *
 * 需求（用户 2026-10-06 转述 MC 里那个 AI 的原话）：插件 31 个工具里**没有合成/开容器**，
 * 生存模式下做不了"原木 → 木板 → 工作台 → 木镐"这条最基础的链路；它试 `/craft` 又被指令白名单拒了。
 * （`/craft` 本来也不是原版指令，原版只有 `/recipe`——所以不该靠白名单绕，而是把真能力补上。）
 *
 * 做法：mineflayer **自带** craft 插件（`lib/plugins/craft.js`），bot 上有
 *   `bot.craft(recipe, count, craftingTable)` / `bot.recipesFor(...)` / `bot.recipesAll(...)`。
 * 本文件把它们包成工具 `mc_craft`，并补上 mineflayer 没做的事：
 *   ① **递归规划**：原料不够但能再合成（原木→木板→木棍）就自动排好顺序一起做，
 *      不再需要 AI 自己一步步算（它算错过，也会因此反问 用户）。
 *   ② **自动找工作台**：附近有就用；没有就报"缺桌子"并列出周围哪几张能用（**不替你放** —— 用户 2026-10-19）。
 *   ③ **缺料报告**：缺什么、缺几个、现有几个，并给出下一步该调哪个工具。
 *   ④ 名字解析（`planks` → `oak_planks` 这种）、`list` 看配方、`dryRun` 只出计划。
 *
 * 装法：放在 `<profile>/node_modules/dsh-mc-agent/extensions/` 下即自动加载（插件 index.js:4089 的扩展点）。
 *
 * 门禁：**不**加进 mc_observe 的 `DEFAULT_GATED` —— 合成只动背包、不动世界，不需要"先看一眼"。
 * （`mc_furnace` 会动世界里的熔炉，所以它进。）
 *
 * 环境变量：无。参数都在工具调用里。
 */
import {
  clamp, itemNameOf, itemIdOf, blockIdOf, countOf, canPlaceInto, blockAtXYZ, findPlaceSpot,
} from './mc_util.mjs'
import { withTimeout, CALL_MS } from '../src/core.mjs'
import { dropsNear } from '../src/world-observer.mjs'
import { isPassable } from '../src/block-names.mjs'
/* 烧炼反查表在 mc_furnace 里（同一份表，别抄第二遍）。它不 import 本文件，所以不成环。 */
import { smeltInputsFor } from './mc_furnace.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 上面这些原来在本文件里定义，2026-10-06 搬到 `mc_util.mjs`（mc_chest / mc_furnace / mc_observe 也用
 * 同一份；箱子工具不该去 import 合成工具）。这里再导出一次，老的 `from './mc_craft.mjs'` 不用改。 */
export { itemNameOf, itemIdOf, blockIdOf, canPlaceInto, blockAtXYZ, findPlaceSpot }

export const name = 'mc_craft'

/** 工作台方块名（目前只有一种） */
const TABLE_NAMES = ['crafting_table']
/** 一次规划最多做多少次单次合成（防止 AI 写个巨大 count 把服务器点爆） */
const MAX_TIMES = 64
/** 递归规划的最大深度（原木→木板→木棍→木镐 这种 4 层足够） */
const MAX_DEPTH = 4

/* ───────────────────────── 基础查询（都能脱离真实 bot 单测） ───────────────────────── */
/* 名字 ↔ id 互转、`countOf`、`canPlaceInto`、`vec3Of`、`blockAtXYZ` 2026-10-06 搬到
 * `mc_util.mjs`（mc_chest / mc_furnace / mc_observe 也用同一份）—— 文件顶部的 import 与再导出里都有。 */

/** 找工作台：给了 x/y/z 就查那一格；否则在 radius 内找最近的一个 */
export function findTableBlock (bot, { x, y, z, radius = 4 } = {}) {
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number.isFinite(Number(z))) {
    const b = blockAtXYZ(bot, x, y, z)
    return b && /crafting_table/.test(b.name) ? b : null
  }
  // 🔴 必须用**方块 id**（blocksByName），不是物品 id：1.13+ 两套 id 不同
  // （1.21.10：crafting_table 物品 332 / 方块 205；oak_log 物品 134 / 方块 49），
  // 而 mineflayer 的 findBlock 比的是 block.type（方块 id）——传物品 id 永远找不到，
  // 会退化成"明明脚边有工作台却以为没有，又去放一个"（2026-10-06 实机踩到）。
  const ids = TABLE_NAMES.map((n) => blockIdOf(bot, n)).filter((v) => v != null)
  if (!ids.length) return null
  try { return bot.findBlock({ matching: ids, maxDistance: clamp(Number(radius) || 4, 1, 8) }) ?? null } catch { return null }
}

/** 周围所有工作台的坐标（用户 2026-10-19：「用不了附近工作台再加一个周围工作台的位置」）。
 *  只读、不改世界；给 AI 一条"走过去用哪张"的路，或者拿来填 `mc_craft {x,y,z}`。 */
export function listTablesNearby (bot, radius = 32, limit = 5) {
  const ids = TABLE_NAMES.map((n) => blockIdOf(bot, n)).filter((v) => v != null)
  if (!ids.length) return []
  try {
    const from = bot.entity?.position
    const found = bot.findBlocks({ matching: ids, maxDistance: clamp(Number(radius) || 32, 1, 48), count: clamp(Number(limit) || 5, 1, 8) }) ?? []
    return found
      .map((p) => ({ x: p.x, y: p.y, z: p.z, distance: from ? Math.round(from.distanceTo(p) * 10) / 10 : null }))
      .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9))
  } catch { return [] }
}

function recipesAllOf (bot, id, table) {
  try { return bot.recipesAll(id, null, table) ?? [] } catch { return [] }
}

function recipesReady (bot, id, table, minCount) {
  try { return bot.recipesFor(id, null, minCount, table) ?? [] } catch { return [] }
}

/**
 * 某样东西"够不够得着"：3 = 现在就有 / 现在就能做出来，1 = 有一点但不够，0 = 没有也做不出来。
 * 只看背包（或调用方给的虚拟背包）+ 配方，**不改任何状态**，纯探路。
 * 🔴 为什么要它：只按"现在有几个"排，会在"背包里只有原木、还没有木板"时挑错木种 ——
 *   `crafting_table` 有 12 条配方（每个木种一条），这时 12 条的 full/part 全是 0，
 *   只能按"原料 id 最小"兜底 → 挑成 `oak_planks`，而背包里其实是 `jungle_log`，
 *   于是报"缺 oak_log"，明明是同一棵树上的木头（2026-10-06 实机踩到）。
 */
function reachOf (bot, id, need, depth, cnt, memo) {
  const key = `${id}|${need}|${depth}`
  if (memo.has(key)) return memo.get(key)
  memo.set(key, 0)                              // 防配方互相引用时转圈
  const have = Number(cnt(id)) || 0
  let res
  if (have >= need) res = 3
  else if (depth <= 0) res = have > 0 ? 1 : 0
  else {
    let best = have > 0 ? 1 : 0
    for (const r of recipesAllOf(bot, id, true)) {
      const out = r.result?.count || 1
      const times = Math.max(1, Math.ceil((need - have) / out))
      let worst = 3
      for (const ing of ingredientsOf(r)) {
        worst = Math.min(worst, reachOf(bot, ing.id, ing.count * times, depth - 1, cnt, memo))
        if (worst === 0) break
      }
      if (worst >= 2) { best = 3; break }       // 这条配方的原料现在全都够 → 立刻能做
      best = Math.max(best, worst)
    }
    res = best
  }
  memo.set(key, res)
  return res
}

/**
 * 挑一条配方。
 * 🔴 真配方数据里同一样东西**每个木种/石种各有一条**（1.21.10：`crafting_table` 12 条、`wooden_pickaxe` 12 条、
 * `stick` 13 条、`furnace` 3 条），而 `Recipe.find` 的返回顺序是任意的 —— cherry 恰好排在最前，
 * 于是"手里有橡木原木却让你去找樱桃木"。所以**必须看背包**：原料现有量多的优先。
 * 都没有时按"配方越老越常见"（原料 id 越小）兜底 —— oak 的 id 最小，正好是默认木材。
 * @param {Array} list 候选配方
 * @param {(id:number)=>number} [countFn] 某物品现有几个（默认当 0；`planCraft` 传虚拟背包）
 * @param {object} [bot] 给了就多算一层 `reachOf`（原料自己不够时，看能不能用背包里的东西现做出来）
 */
/* 兜底挑料时的"最普通优先"。
 * 同一样东西常有多个变体（熔炉有 8 圆石 / 8 深板岩圆石 / 8 黑石三条配方），
 * 背包里一个都没有时 full/part/reach 全平，只按"原料 id 最小"兜底会挑出生僻的那个 ——
 * 实机（2026-10）踩到 `mc_craft {name:"furnace"}` 报「缺料（cobbled_deepslate）」，
 * 而正常玩家心里的默认材料是 cobblestone。所以给最常见的默认材料一点权重，
 * 位置放在**最后一道**（id 之前），只有前面所有判据都打平时才起作用。 */
const COMMON_INGREDIENTS = new Set([
  'oak_log', 'oak_planks', 'stick', 'cobblestone', 'stone', 'coal', 'charcoal',
  'iron_ingot', 'iron_nugget', 'gold_ingot', 'copper_ingot', 'sand', 'glass',
  'crafting_table', 'furnace', 'chest', 'torch', 'white_wool', 'leather',
  'string', 'feather', 'flint', 'gunpowder', 'paper', 'wheat',
])

function pickRecipe (list, countFn, bot = null) {
  const cnt = typeof countFn === 'function' ? countFn : () => 0
  const memo = new Map()
  const score = (r) => {
    const ings = ingredientsOf(r)
    let full = 0
    let part = 0
    let reach = 3
    let common = 0
    for (const ing of ings) {
      const have = Number(cnt(ing.id)) || 0
      if (have >= ing.count) full++
      else if (have > 0) part++
      if (bot) reach = Math.min(reach, reachOf(bot, ing.id, ing.count, 3, cnt, memo))
      if (bot && COMMON_INGREDIENTS.has(String(itemNameOf(bot, ing.id)))) common++
    }
    const minId = ings.reduce((m, i) => Math.min(m, Number(i.id) || 1e9), 1e9)
    return { full, part, reach, common, table: r?.requiresTable ? 1 : 0, n: ings.length, minId }
  }
  const scored = list.map((r) => ({ r, s: score(r) }))
  scored.sort((a, b) =>
    (b.s.reach - a.s.reach) || (b.s.full - a.s.full) || (b.s.part - a.s.part) ||
    (a.s.table - b.s.table) || (a.s.n - b.s.n) || (b.s.common - a.s.common) ||
    (a.s.minId - b.s.minId))
  return scored[0]?.r
}

/** 一条配方的原料（delta 里负数是消耗，正数是产出） */
export function ingredientsOf (recipe) {
  const out = []
  for (const d of recipe?.delta ?? []) {
    if (!d || typeof d.count !== 'number') continue
    if (d.count >= 0) continue
    out.push({ id: d.id, metadata: d.metadata ?? null, count: -d.count })
  }
  return out
}

/* ───────────────────────── 名字解析 ───────────────────────── */

/** 把 AI 写的名字解析成一个物品（planks → oak_planks；log → 背包里那种原木） */
export function resolveItem (bot, query, table, want = 1) {
  const raw = String(query ?? '').trim()
  if (!raw) throw new Error('要合成什么？给个物品名，比如 name:"oak_planks"（也可以先 list:true 看当前能做什么）')
  const q = raw.toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  const byName = bot?.registry?.itemsByName ?? {}
  if (byName[q]) return { item: byName[q], note: null }
  const cands = Object.keys(byName).filter((n) => n === q || n.endsWith('_' + q) || n.includes(q))
  if (!cands.length) {
    throw new Error(`没有叫“${raw}”的物品（要写英文 id，如 oak_planks / stick / wooden_pickaxe / crafting_table；list:true 可以看当前能做什么）`)
  }
  if (cands.length === 1) return { item: byName[cands[0]], note: null }
  const wantN = Math.max(1, Number(want) || 1)
  const scored = cands.map((n) => {
    const it = byName[n]
    const have = countOf(bot, it.id, null)
    let ok = false
    /* 🔴 `ok` 要用**这次要的数量**去试，不能用 1：背包有 5 块木板、但要 12 块、又没原木时，
     * 拿 1 去试会回"能做（已有的够 1 个）"，于是被当成能做 ⇒ 选了个凑不齐的候选。 */
    try { ok = planCraft(bot, it.id, wantN, table).ok } catch { ok = false }
    return { n, it, have, ok }
  })
  /* 🔴 2026-10-19 实机：`{name:"planks", count:12}` 时背包有 birch_log×4（能做 12 块桦木木板）
   * 和 oak_planks×5（但 oak_log 为 0，**做不出来**），它按"背包里有"选了 oak_planks，
   * 接着就卡在"oak_log：需要 2，背包里有 0"。判据从"有就优先"改成"**够用 或 做得出**优先"。 */
  const haveSome = scored.filter((s) => s.have > 0)
  const byHave = (a, b) => b.have - a.have
  const best = haveSome.filter((s) => s.ok || s.have >= wantN).sort(byHave)[0]
    ?? scored.filter((s) => s.ok).sort(byHave)[0]
    ?? haveSome.sort(byHave)[0]
    ?? null
  if (!best) {
    throw new Error(`“${raw}”能对应 ${cands.length} 个物品（${cands.slice(0, 10).join(' / ')}`
      + `${cands.length > 10 ? ' …' : ''}），按现在的背包一个都做不出来 —— 写全名指定要哪个`)
  }
  return {
    item: best.it,
    note: `“${raw}”能对应 ${cands.length} 个物品，按"够用 / 现在能做"自动选了 **${best.n}**（要别的请写全名）`,
  }
}

/* ───────────────────────── 递归规划 ───────────────────────── */

/**
 * 规划"把 want 个 itemId 弄到手"需要哪些合成步骤（按执行顺序）。
 * 用**虚拟背包**记账：排过的步骤算已产出、消耗也算进去，所以不会重复合成同一样中间产物。
 * @returns {{ok:boolean, steps:Array, missing:Array, note:string|null}}
 */
export function planCraft (bot, itemId, want, table, opts = {}) {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  const steps = []
  const missing = []
  const virt = new Map()
  const haveOf = (id) => {
    if (!virt.has(id)) virt.set(id, countOf(bot, id, null))
    return virt.get(id)
  }
  const addOf = (id, n) => virt.set(id, haveOf(id) + n)

  /**
   * 递归栈：每一层是「谁、要几个、现在有几个」。
   * 缺料报告要顺着它说清**卡在哪一步** —— 只报最底下那个叶子会把人带沟里。
   * 实机教训（2026-10-07）：机器人只有 2 块木板、做工作台要 4 块，报告只写
   * 「oak_log：需要 1，背包里有 0」，模型当场理解成"工作台要用原木做"，
   * 还以为是 `mc_craft` 数错了背包，跑去砍树。
   */
  const path = []

  /** 记一笔"缺什么"（同一个物品只记第一次，免得报告刷屏） */
  const lack = (id, need, why) => {
    if (!missing.some((m) => m.id === id)) {
      missing.push({ id, name: itemNameOf(bot, id), need, have: haveOf(id), why, via: path.filter((n) => n.id !== id) })
    }
    return false
  }

  /** 原料表按物品合并（合并步骤后会重复） */
  const aggFrom = (from) => {
    const m = new Map()
    for (const f of from) m.set(f.id, (m.get(f.id) ?? 0) + f.count)
    return [...m].map(([id, count]) => ({ id, name: itemNameOf(bot, id), count }))
  }

  const ensure = (id, need, depth) => {
    const have = haveOf(id)
    if (have >= need) return true
    if (depth <= 0) return lack(id, need, `层次太深（链条超过 ${maxDepth} 层）`)
    path.push({ id, name: itemNameOf(bot, id), need, have })
    try {
      let recipes = recipesAllOf(bot, id, table)
      const full = recipesAllOf(bot, id, true)
      let cantTable = false
      if (!recipes.length) {
        // 现在没工作台，但配方要工作台：**照样把原料走一遍**，好把"还缺什么材料"一次说清
        if (full.length && !table) { recipes = full; cantTable = true } else {
          return lack(id, need, full.length ? '需要工作台' : '没有配方：这个物品不能合成，要去挖/找（或名字写错了）')
        }
      }
      const r = pickRecipe(recipes, haveOf, bot)
      if (!r) return lack(id, need, '没有配方')
      if (r.requiresTable && !table) cantTable = true
      if (cantTable) {
        // 缺的是"能用的工作台"，不是目标物品本身 —— 报告里直接点名工作台，模型才知道该去放/做一个
        const tableId = itemIdOf(bot, 'crafting_table')
        if (tableId != null) {
          lack(tableId, 1, haveOf(tableId) > 0
            ? `需要工作台：背包里有，放到脚边就能用`
            : `需要工作台：合成 ${itemNameOf(bot, id)} 要用它（4 个木板做一个）`)
        } else lack(id, need, '需要工作台')
      }
      const out = r.result?.count || 1
      let times = Math.max(1, Math.ceil((need - have) / out))
      let capped = false
      if (times > MAX_TIMES) { times = MAX_TIMES; capped = true }
      // 先把原料凑齐（原料不够 → 递归去合成它）
      let ingsOk = true
      for (const ing of ingredientsOf(r)) {
        const sub = ensure(ing.id, ing.count * times, depth - 1)
        if (sub) addOf(ing.id, -ing.count * times) // 这一步会把它消耗掉
        else { ingsOk = false; if (!cantTable) return false }
      }
      if (cantTable || !ingsOk) return false
      addOf(id, times * out)
      steps.push({
        id, name: itemNameOf(bot, id), want: need, times, out,
        table: !!r.requiresTable, capped,
        // 🔴 把**选中的那条配方**一起带上：执行期必须照着它做，不能自己再挑一次
        // （再挑一次就可能挑成别的木种，见 runPlan 里的长注释）
        recipe: r,
        from: aggFrom(ingredientsOf(r).map((i) => ({ id: i.id, count: i.count * times }))),
      })
      return true
    } finally {
      path.pop()
    }
  }

  const ok = ensure(itemId, want, maxDepth)

  // 虚拟背包记账会把同一样东西拆成多步（先做 4 木板、再做 4 木板）——相邻的合并成一步
  for (let i = steps.length - 1; i > 0; i--) {
    const a = steps[i - 1]
    const b = steps[i]
    if (a.id === b.id && a.table === b.table) {
      a.times += b.times
      a.capped = a.capped || b.capped
      a.recipe = a.recipe ?? b.recipe
      a.from = aggFrom(a.from.concat(b.from))
      a.want = Math.max(a.want, b.want)
      steps.splice(i, 1)
    }
  }
  const note = ok ? (steps.some((s) => s.capped) ? `一次最多做 ${MAX_TIMES} 次，计划已被截断` : null) : null
  return { ok, steps, missing, note }
}

/** 把计划写成给人/模型看的文字 */
export function describePlan (plan, targetName, want) {
  const lines = []
  lines.push(`🧱 合成计划：**${targetName} ×${want}**（${plan.steps.length} 步）`)
  plan.steps.forEach((s, i) => {
    const from = s.from.length ? ` ← ${s.from.map((f) => `${f.name} ×${f.count}`).join(' + ')}` : ''
    lines.push(`  ${i + 1}. ${s.name} ×${s.times * s.out}（${s.times} 次合成${s.table ? '，用工作台' : ''}）${from}`)
  })
  if (plan.note) lines.push(`  ⚠️ ${plan.note}`)
  return lines.join('\n')
}

/** 缺料报告：缺什么、缺几个、现有几个、**卡在链条的哪一步**、下一步调什么 */
export function describeMissing (plan, bot = null) {
  const lines = ['❌ 原料不够，做不了：']
  const tips = new Map() // 缺料叶子 → 链条上最靠近它的那一层（真正卡住的那一步）
  for (const m of plan.missing) {
    const why = m.why ? `（${m.why}）` : ''
    lines.push(`  · ${m.name}：需要 ${m.need}，背包里有 ${m.have}${why}`)
    // 光报叶子不够：实机里"工作台要 4 块木板、只有 2 块"被报成"oak_log：需要 1，背包里有 0"，
    // 模型于是以为"工作台要用原木做"。把整条链摆出来，它一眼就知道差的是什么、差几个。
    // 链条被 maxDepth 截断时不摆（那时候"链条"本来就不完整，说了反而误导）。
    const chain = /层次太深/.test(m.why ?? '') ? [] : (m.via ?? []).filter((n) => n.id !== m.id)
    const tip = chain.length > 1 ? chain[chain.length - 1] : null
    if (tip) {
      tips.set(m.name, tip)
      const short = Math.max(0, tip.need - tip.have)
      lines.push(`    ↳ 卡在 **${tip.name}**：要 ${tip.need}、现在只有 ${tip.have}${short ? `（差 ${short}）` : ''}`
        + `｜链条：${[...chain.map((n) => n.name), m.name].join(' → ')}`)
    } else if (chain.length === 1) {
      lines.push(`    ↳ 链条：${chain[0].name} → ${m.name}`)
    }
  }
  const hints = new Set()
  for (const m of plan.missing) {
    if (/_log$/.test(m.name)) hints.add(`原木：\`mc_dig {name:"${m.name}",count:3}\`（或者砍你附近那种树，_log 换成对应名字）`)
    else if (/_ore$|raw_/.test(m.name)) hints.add('矿石：`mc_dig {name:"iron_ore",count:3}` 或下矿找')
    else if (m.why?.includes('需要工作台')) {
      const near = bot ? listTablesNearby(bot, 32, 4) : []
      hints.add('工作台：附近有就自动用；没有就报"缺桌子"并列出周围哪几张能用 —— **我不替你放**（要自己 `mc_act {mode:"place",…}` 放）'
        + (near.length
          ? `｜周围 32 格内找到 ${near.length} 张：${near.map((t) => `(${t.x},${t.y},${t.z}) ${t.distance} 格`).join('、')}`
            + ` —— 走过去用，或者直接 \`mc_craft {…,x:${near[0].x},y:${near[0].y},z:${near[0].z}}\``
          : '｜周围 32 格内也没有别的工作台'))
    }
    else if (/cobble|stone/.test(m.name)) hints.add('石头：`mc_dig {name:"stone",count:8}`（要用镐子挖）')
    const tip = tips.get(m.name)
    if (tip && /_planks$/.test(tip.name)) {
      hints.add(`木板：**要同一种木头**（${tip.name} 要 ${tip.need} 块、现在只有 ${tip.have} 块 —— 手里混着别的木种也凑不齐）。`
        + `先 \`mc_dig {name:"${/_log$/.test(m.name) ? m.name : 'oak_log'}",count:1}\` 砍一根原木（1 根 = 4 块木板），再叫一次 mc_craft`)
    }
  }
  for (const h of hints) lines.push(`  → ${h}`)
  return lines.join('\n')
}

/* ─────────────── 递归物品目标树：「我要 N 个 X，整套活儿怎么排」 ───────────────
 * 灵感来自 mindcraft 的 `ItemNode`（setRecipe / setCollectable / setSmeltable + prereq）：
 * `planCraft` 只管**合成**那一层，碰到底下的"要挖的矿、要烧的锭"只报告、不展开。
 * 这里把三层串成一棵树 —— 合成 → 烧炼 → 挖掘（连"挖它要什么镐"一起），
 * 回答的是"这台活儿到底该怎么排"。
 *
 * 🔴 只出计划、绝不动手：真干活还是 `mc_dig` / `mc_furnace` / `mc_craft` 各干各的
 *    （mindcraft 那套是自己写执行器，我们已经有工具了，不需要）。
 */

/**
 * 方块 → 掉落物品（含"要什么工具才挖得下来"）。同一个 registry 只建一次。
 * 🔴 minecraft-data 里 `block.drops` 装的是**物品 id**、`block.harvestTools` 是"能挖下它的工具物品 id"
 *    （iron_ore = 石/铁/金/钻石/下界合金镐）；铁矿石掉的是 `raw_iron`，名字和方块不一样，
 *    所以必须靠掉落表反查，不能拿物品名去猜方块名。
 */
let _dropCache = null
function dropIndexOf (bot) {
  const reg = bot?.registry
  if (_dropCache && _dropCache.reg === reg) return _dropCache.map
  const map = new Map()
  for (const [bname, blk] of Object.entries(reg?.blocksByName ?? {})) {
    for (const d of Array.isArray(blk.drops) ? blk.drops : []) {
      const id = d && typeof d === 'object' ? (d.drop?.id ?? d.id) : d
      const it = reg.items?.[id]
      if (!it) continue
      const tools = blk.harvestTools ? Object.keys(blk.harvestTools).map((k) => reg.items?.[k]?.name).filter(Boolean) : []
      const list = map.get(it.name) ?? []
      if (!list.some((x) => x.block === bname)) list.push({ block: bname, tools })
      map.set(it.name, list)
    }
  }
  _dropCache = { reg, map }
  return map
}

/** 一个物品的所有"合成配方"（含要用工作台的），整理成树能用的形状 */
function recipeChoicesOf (bot, name) {
  const id = itemIdOf(bot, name)
  if (id == null) return []
  let rs = []
  try { rs = recipesAllOf(bot, id, true) } catch { rs = [] }
  return rs.map((r) => ({
    out: r.result?.count || 1,
    requiresTable: !!r.requiresTable,
    from: ingredientsOf(r).map((i) => ({ name: itemNameOf(bot, i.id), count: i.count })),
  })).filter((c) => c.from.length)
}

/**
 * 一个物品"从哪来"。优先级按"哪条路最省事"排：
 *   ① 有一个**同名方块**掉落它（砍 oak_log 得 oak_log）—— 最直接
 *   ② 有 `X_ore` 方块掉落它（挖 diamond_ore 得 diamond）—— 比烧划算
 *   ③ 能烧出来（raw_iron → iron_ingot）
 *   ④ 有合成配方（oak_planks ← oak_log）
 *   ⑤ 别的方块掉落它
 *   ⑥ 都没有：打怪 / 开箱 / 交易，或名字写错
 */
export function sourceOf (bot, name) {
  const have = countOf(bot, itemIdOf(bot, name))
  const drops = dropIndexOf(bot).get(name) ?? []
  const pickDrop = (pred) => drops.find((d) => pred(d.block)) ?? null
  const mineNode = (d) => {
    const tools = d.tools
    const canMine = tools.length === 0 || tools.some((t) => countOf(bot, itemIdOf(bot, t)) > 0)
    return { kind: 'mine', name, have, block: d.block, blocks: drops.slice(0, 4).map((x) => x.block), tools, canMine }
  }
  const same = pickDrop((b) => b === name)
  if (same) return mineNode(same)
  const ore = pickDrop((b) => /_ore$/.test(b))
  if (ore) return mineNode(ore)
  const smeltIn = smeltInputsFor(bot, name)
  if (smeltIn.length) {
    const owned = smeltIn.filter((n) => countOf(bot, itemIdOf(bot, n)) > 0)
    /* 优先挑 `raw_*`：1.21 挖矿掉的是粗矿，矿石方块一般不在背包里 */
    const prefer = smeltIn.find((n) => /^raw_/.test(n)) ?? smeltIn[0]
    return { kind: 'smelt', name, have, inputs: smeltIn.slice(0, 6), input: owned[0] ?? prefer }
  }
  const choices = recipeChoicesOf(bot, name)
  if (choices.length) {
    /* 挑原料种类最少的那条（木板 = 1 种原木，不会被"9 个粒"那种分支带偏） */
    const best = choices.slice().sort((a, b) => a.from.length - b.from.length
      || a.from.reduce((s, f) => s + f.count, 0) - b.from.reduce((s, f) => s + f.count, 0))[0]
    return { kind: 'craft', name, have, out: best.out, requiresTable: best.requiresTable, from: best.from, choices: choices.length }
  }
  if (drops.length) return mineNode(drops[0])
  return { kind: 'other', name, have }
}

/**
 * 把"拿到 want 个 query"拆成一棵树（挖 → 烧 → 合成，三层串起来）。
 * 🔴 自己递归、不借 `planCraft`：`planCraft` 遇到**第一个**缺料就停（它给的是"下一步该干啥"），
 *    而树要的是"**整套活儿**一共缺什么"，所以得把每条分支都走一遍。
 * @returns {{target, want, have, ok, tree, leaves, blockers, missing, note, maxDepth}}
 */
export function goalTree (bot, query, want, opts = {}) {
  const table = opts.table !== false
  const wantN = clamp(Math.round(Number(want) || 1), 1, 1024)
  const maxDepth = clamp(Math.round(Number(opts.maxDepth) || 5), 1, 8)
  const target = resolveItem(bot, query, table, wantN)
  const targetName = itemNameOf(bot, target.item.id)
  const missing = []
  const expand = (name, need, depth, path) => {
    const have = countOf(bot, itemIdOf(bot, name))
    if (have >= need) return { name, need, have, kind: 'have' }
    const src = sourceOf(bot, name)
    const node = { ...src, need }
    if (path.has(name)) return { ...node, dup: true }
    if (depth <= 0) { missing.push(name); return { ...node, cut: true } }
    const next = new Set(path).add(name)
    if (src.kind === 'craft') {
      const times = Math.max(1, Math.ceil((need - have) / (src.out || 1)))
      node.times = times
      node.children = src.from.map((f) => expand(f.name, f.count * times, depth - 1, next))
    } else if (src.kind === 'smelt' && src.input) {
      node.children = [expand(src.input, need, depth - 1, next)]
    } else if (src.kind === 'mine' && !src.canMine) {
      /* 挖不动 = 缺工具：工具自己也是一棵树（石镐 ← 圆石 + 木棍 ← 原木）。
       * 🔴 挑**最弱的那把**（harvestTools 的 key 是按物品 id 升序的，木→石→铁→钻→合金）：
       *    能挖钻石的镐子有一堆，先做木/石镐最省事。 */
      const tool = src.tools[0] ?? null
      if (tool) node.children = [expand(tool, 1, depth - 1, next)]
    }
    return node
  }
  const tree = expand(targetName, wantN, maxDepth, new Set())
  const collect = (n, out = []) => {
    if (n && ['mine', 'smelt', 'craft', 'other'].includes(n.kind)) {
      out.push({ name: n.name, kind: n.kind, need: n.need, have: n.have })
    }
    for (const c of n?.children ?? []) collect(c, out)
    return out
  }
  const leaves = collect(tree)
  /* "能直接按顺序干" = 全是合成/已有的，没有哪一样还得去挖、去烧、去想办法 */
  const gather = leaves.filter((x) => x.kind === 'mine' || x.kind === 'smelt' || x.kind === 'other')
  return {
    target: targetName, want: wantN, have: countOf(bot, target.item.id, null), ok: gather.length === 0,
    tree, leaves, gather, missing, note: target.note ?? null, maxDepth,
    blockers: [...new Set(leaves.filter((x) => x.kind === 'other').map((x) => x.name))],
  }
}

/** 树的文字版：一层层念下来（挖 → 烧 → 合成），每行都是"要几个 + 从哪来" */
export function describeGoalTree (tree) {
  const L = []
  L.push(`🧠 要拿到 **${tree.target} ×${tree.want}**（现在有 ${tree.have}）：`)
  if (tree.note) L.push(`　${tree.note}`)
  const linesOf = (n, ind) => {
    const pad = '　'.repeat(ind)
    const out = []
    const need = n.need > 1 ? ` ×${n.need}` : ''
    const haveNote = n.have > 0 ? `（身上有 ${n.have}` : ''
    if (n.kind === 'have') {
      out.push(`${pad}· **${n.name}**${need}：背包里有 ${n.have}，够了 ✅`)
    } else if (n.kind === 'mine') {
      const tool = n.canMine ? '' : `｜⚠️ 挖得动得先有 ${(n.tools ?? []).join(' / ')}`
      out.push(`${pad}· **${n.name}**${need}：挖 **${n.block}**${haveNote ? haveNote + '）' : ''}${tool}`)
    } else if (n.kind === 'craft') {
      const from = n.from.map((f) => `${f.name} ×${f.count}`).join(' + ')
      out.push(`${pad}· **${n.name}**${need}：合成 ${n.times} 次 ← ${from}`
        + `${n.requiresTable ? '（要工作台）' : ''}${haveNote ? haveNote + '）' : ''}`
        + `${n.choices > 1 ? `（另有 ${n.choices - 1} 条别的配方）` : ''}`)
    } else if (n.kind === 'smelt') {
      out.push(`${pad}· **${n.name}**${need}：烧 **${n.input}**（要熔炉 → \`mc_furnace {name:"${n.input}",count:${Math.max(1, n.need - n.have)}}\`）${haveNote ? haveNote + '）' : ''}`)
    } else {
      out.push(`${pad}· **${n.name}**${need}：没有配方、也查不到掉落 —— 只能打怪/开箱/交易搞到（或名字写错了）`)
    }
    if (n.cut) out.push(`${pad}　（再往下拆太深了，先弄这一层）`)
    if (n.dup) out.push(`${pad}　（这一样上面已经排过，别重复弄）`)
    for (const c of n.children ?? []) out.push(...linesOf(c, ind + 1))
    return out
  }
  L.push(...linesOf(tree.tree, 1))
  if (tree.ok) {
    L.push(`　→ 材料齐了：\`mc_craft {name:"${tree.target}",count:${tree.want}}\` 就行`)
  } else {
    L.push('　→ 动手顺序：**挖的最先、烧的其次、合成的最后**（下面的没到手，上面的做不了）')
    if (tree.blockers.length) L.push(`　→ 没来源的：${tree.blockers.join(' / ')}（这几样我没有数据，得靠打怪/开箱/交易，或者换个目标）`)
  }
  return L.join('\n')
}

/* ───────────────────────── list：看配方 / 看能做什么 ───────────────────────── */

/** 某个物品的所有配方（原料 + 现有量） */
export function listRecipesFor (bot, itemId, table) {
  const all = recipesAllOf(bot, itemId, table)
  const full = recipesAllOf(bot, itemId, true)
  return {
    name: itemNameOf(bot, itemId),
    recipes: all.map((r) => ({
      out: r.result?.count || 1,
      table: !!r.requiresTable,
      from: ingredientsOf(r).map((i) => ({
        name: itemNameOf(bot, i.id), count: i.count, have: countOf(bot, i.id, null),
      })),
    })),
    needTable: all.length === 0 && full.length > 0,
  }
}

/** 当前背包能立刻合成的东西（不用工作台的那些） */
export function listCraftable (bot, table, limit = 24) {
  const byName = bot?.registry?.itemsByName ?? {}
  const out = []
  for (const n of Object.keys(byName)) {
    const it = byName[n]
    if (!it || !it.id) continue
    if (!recipesReady(bot, it.id, table, 1).length) continue
    out.push({ name: n, have: countOf(bot, it.id, null) })
    if (out.length >= limit) break
  }
  return out
}

/* ───────────────────────── 执行 ───────────────────────── */

/**
 * 这条配方的原料现在够做 times 次吗？够 → null；不够 → 缺哪些、各缺多少。
 * 用来**在动手之前**核对，而不是让 mineflayer 抛一句 `missing ingredient`（它不告诉你缺什么）。
 */
export function shortfallOf (bot, recipe, times = 1) {
  const short = []
  for (const ing of ingredientsOf(recipe)) {
    const need = ing.count * times
    const have = countOf(bot, ing.id, ing.metadata)
    if (have < need) short.push({ id: ing.id, name: itemNameOf(bot, ing.id), need, have })
  }
  return short.length ? short : null
}

/* 调试日志：默认不输出，`DSH_MC_AGENT_CRAFT_DEBUG=1` 时每步打一行（排"合成了但背包没变"这类问题时用） */
let dbgLog = () => {}
const invSnap = (bot) => {
  try {
    const items = bot.inventory.items()
    return items.length ? items.map((i) => `${i.name}x${i.count}`).join(',') : '(空)'
  } catch (e) { return `(读不到：${e.message})` }
}

/* 🔴🔴 mineflayer 的 `bot.craft()` **不可取消**：11 秒预算到点只是"我们不等了"，
 * 它内部的点格子循环还在跑（`clickWindow` 最多再挂 20 秒，`once('windowOpen')` 甚至没有超时）。
 * 这时再开一次 mc_craft，两条合成链会抢同一个窗口 —— 服务端就"格子里剩什么就做什么"。
 * 实机（2026-10-07 用户报"10 根橡木没了、多了个橡木按钮、合成一直超时"）：
 * 连着三次 `oak_planks` 超时（4589/4123/5000ms）后，背包里多出一个 `oak_button`
 * （合成格里只剩 1 块木板时，结果槽就是按钮），原木从 10 变 0（其实卡在合成格/窗口里，
 * `bot.inventory` 看不见）。所以：**同一个 bot 同时只允许一条合成链**。 */
const craftBusy = new WeakMap()      // bot -> Promise（还在跑的 bot.craft，settle 后自动清）
const craftPendingAt = new WeakMap() // bot -> 开始时间（挂太久就当它死了）
const CRAFT_STUCK_MS = 25_000        // mineflayer 自己的 clickWindow 20 秒会抛；超过这个还没动静就是真挂了

const trackCraft = (bot, p) => {
  const t = p.then(() => {}, () => {})
  craftBusy.set(bot, t)
  craftPendingAt.set(bot, Date.now())
  t.then(() => { if (craftBusy.get(bot) === t) { craftBusy.delete(bot); craftPendingAt.delete(bot) } })
  return t
}

/* 上一条合成还在跑吗：null = 空闲 / 'busy' = 还在跑 / 'stuck-cleared' = 挂太久了（只重置计时，**不**删 busy）
 * 🔴 2026-10-08 审计 M2：以前这里 `craftBusy.delete(bot)` 把守卫**删掉**了，但 `craft.js:43` 的
 *    `await once(bot,'windowOpen')` **没有超时** —— 够不着/看不见的工作台会让它永远挂着。
 *    25 秒后守卫一没，下一次 mc_craft 就再发一次 activateBlock，两条链共用 `craft.js` 的模块级
 *    `windowCraftingTable` ⇒ 又回到"材料留在合成格、做出别的东西"。现在只重置计时、busy 一直留着，
 *    真要解锁就 `mc_connect` 重连（新 bot 对象 ⇒ WeakMap 自然失效）。 */
const craftState = (bot) => {
  const p = craftBusy.get(bot)
  if (!p) return null
  if (Date.now() - (craftPendingAt.get(bot) ?? 0) > CRAFT_STUCK_MS) {
    craftPendingAt.set(bot, Date.now())
    return 'stuck-cleared'
  }
  return 'busy'
}

/* 等上一条合成收尾：settle 了返回 true，等超时返回 false */
const craftSettled = (bot, ms) => {
  const p = craftBusy.get(bot)
  if (!p) return Promise.resolve(true)
  return Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))])
}

/* 背包快照（名字 → 总数），用来抓"服务端其实做出了别的东西" */
const invSnapMap = (bot) => {
  const m = new Map()
  try { for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) ?? 0) + it.count) } catch {}
  return m
}
const invDiffText = (bot, before, expectName) => {
  const added = []
  try {
    for (const [n, c] of invSnapMap(bot)) {
      const d = c - (before.get(n) ?? 0)
      if (d > 0 && n !== expectName) added.push(`${n}×${d}`)
    }
  } catch {}
  return added.length
    ? `⚠️ 服务端其实做出了别的东西：${added.join('、')} —— 合成格的模型和服务端对不上（已经把窗口关掉、格子里的东西收回背包）`
    : null
}

/* 这个工作台现在能不能用：够得着（≤4 格）且看得见。
 * 🔴 够不着/看不见 ⇒ 服务端不理这次右键 ⇒ craft.js 里 `once('windowOpen')` 永远不返回
 * （它没有超时）⇒ 整条 craft 挂到我们预算到点（实机日志里那些 4123~5000ms 的超时就是这个）。 */
/* 🔴 2026-10-24 用户实机（问题清单第 5 条）：「工作台正上方被挡着，人就站不到它旁边」
 *    以前只报"够不着或看不见"，一句话把三种原因（太远 / 视线被挡 / 头顶被堵）糊在一起，
 *    AI 只能瞎猜。现在按原因说，能用返回 null。 */
const tableWhyNot = (bot, tbl) => {
  try {
    const p = tbl?.position
    if (!p) return '没有位置信息'
    const center0 = typeof p.offset === 'function'
      ? p.offset(0.5, 0.5, 0.5)
      : { x: (p.x ?? 0) + 0.5, y: (p.y ?? 0) + 0.5, z: (p.z ?? 0) + 0.5 }
    const me0 = bot?.entity?.position
    if (!me0) return '读不到我的位置'
    const d0 = typeof me0.distanceTo === 'function'
      ? me0.distanceTo(center0)
      : Math.hypot((me0.x ?? 0) - center0.x, (me0.y ?? 0) - center0.y, (me0.z ?? 0) - center0.z)
    if (!(d0 <= 4.0)) return `离我 ${d0.toFixed(1)} 格（4 格内才开得起来）`
    if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(tbl)) return '视线被挡（中间隔着方块）'
    /* 工作台正上方那格：被实心方块占着时，人没法贴着它站，右键就永远没回包。 */
    const above = blockAtXYZ(bot, p.x, p.y + 1, p.z)
    if (above && above.name && !isPassable(above.name)) {
      return `正上方被 ${above.name} 挡着（人站不到它旁边）`
    }
    return null
  } catch (err) {
    return '读不出来（' + String(err?.message ?? err).split('\n')[0].slice(0, 40) + '）'
  }
}

const tableUsable = (bot, tbl) => {
  try {
    const p = tbl?.position
    if (!p) return false
    /* 🔴 别假定是 Vec3：假机器人/测试里就是普通 {x,y,z}（真 mineflayer 才是 Vec3） */
    const center = typeof p.offset === 'function'
      ? p.offset(0.5, 0.5, 0.5)
      : { x: (p.x ?? 0) + 0.5, y: (p.y ?? 0) + 0.5, z: (p.z ?? 0) + 0.5 }
    const me = bot?.entity?.position
    if (!me) return false
    const d = typeof me.distanceTo === 'function'
      ? me.distanceTo(center)
      : Math.hypot((me.x ?? 0) - center.x, (me.y ?? 0) - center.y, (me.z ?? 0) - center.z)
    if (!(d <= 4.0)) return false
    if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(tbl)) return false
    return true
  } catch { return false }
}

/**
 * 把玩家**自己**背包里那个 2×2 合成格（window 0 的 slot 1~4）里的东西点回背包。
 *
 * 🔴 为什么必须做（2026-10-08 实机反馈：AI 在公屏说"材料像是被吞了"）：
 *    `closeMaybeWindow()` 只关**容器**窗口（工作台/熔炉）；玩家自己的 2×2 合成格
 *    **没有窗口可关** —— 上一次合成被 11 秒预算掐断后，材料就留在那 4 个格子里：
 *    `bot.inventory` 看不见它们（于是报"缺料"），而下一次 `bot.craft()` 又带着
 *    "客户端以为空格子、服务端里还堆着东西"的错位去点，服务端"格子里剩什么就做什么"
 *    （日志里 `⚠️ 服务端其实做出了别的东西：oak_planks×5` 就是这么来的）。
 *    点回背包用 `bot.moveSlotItem`（= 两次 clickWindow），一次点一格，点不动就停手 ——
 *    别在合成还在跑的时候乱点。真点不动就如实报 + 让模型 `mc_connect` 重连（重连也会退回去）。
 *
 * @returns {Promise<string[]>} 搬回去的东西（`["oak_planksx5"]`），没搬就空数组
 */
/**
 * 跟服务端对一次窗口账。
 *
 * 🔴 为什么必须先做这一步（2026-10-13 用户报"合成方块还是会卡在合成栏里"）：
 *    1.17.1+ 的服务端"只在它认为客户端记录过期时才回包"，**被它忽略的点击永远不回**
 *    ⇒ 客户端这份 `bot.inventory.slots` 会一直停在"合成格是空的"，而服务端里其实还堆着东西。
 *    这时去点那 4 个格子等于睁眼瞎（循环里 `win.slots[slot]` 全是 null），材料就一直卡着。
 *    `bot._syncWindow(窗口)`（`mineflayer\lib\plugins\inventory.js:853-870`）发一个
 *    `stateId:-1` 的空点击，服务端**必回**整窗内容 ⇒ 客户端模型被刷成服务端的真实状态。
 *    老版本 mineflayer 没有 `stateIdUsed` 特性时它是空操作（立刻 return，不会挂）。
 */
const syncNextAt = new WeakMap() // bot -> 下次允许对账的时间（成功 0.8 秒内不重复；**失败后退避 8 秒**，别连着卡）
const resyncInventory = async (bot, msLeft = () => Infinity) => {
  try {
    if (typeof bot?._syncWindow !== 'function' || !bot.inventory) return false
    if (Date.now() < (syncNextAt.get(bot) ?? 0)) return false
    syncNextAt.set(bot, Date.now() + 800)
    const left = msLeft() ?? Infinity
    const ms = Number.isFinite(left) ? Math.max(300, Math.min(1_200, left - 300)) : 1_200
    try {
      await withTimeout(Promise.resolve(bot._syncWindow(bot.inventory)), ms, '同步背包窗口')
    } catch (e) {
      /* 服务端没回包（超时/断线）：退避 8 秒再试 —— 否则每次关窗口都白等一个超时 */
      syncNextAt.set(bot, Date.now() + 8_000)
      throw e
    }
    await new Promise((r) => setTimeout(r, 150))
    return true
  } catch { return false }
}

async function clearCraftGrid (bot, msLeft = () => Infinity) {
  const win = bot?.inventory
  if (!win?.slots) return []
  /* 🔴 先跟服务端对账再动手。只在"4 个合成格看起来全是空的"时候对 ——
   *    这正是客户端模型过期（服务端里还压着东西）的样子；格子里看得见东西就不用白跑一趟。 */
  if ([1, 2, 3, 4].every((s) => !win.slots[s])) await resyncInventory(bot, msLeft)
  const moved = []
  for (let slot = 1; slot <= 4; slot++) {         // 0 = 合成结果槽，1~4 = 2×2 合成格
    const it = win.slots[slot]
    if (!it) continue
    if ((msLeft() ?? Infinity) < 400) break
    let dest = null
    try {
      dest = typeof win.firstEmptyInventorySlot === 'function' ? win.firstEmptyInventorySlot() : null
    } catch { dest = null }
    if (dest == null) break
    try {
      await withTimeout(Promise.resolve(bot.moveSlotItem(slot, dest)), 1_200, '把合成格里的东西收回背包')
      moved.push(`${it.name}x${it.count}`)
    } catch { break }
  }
  /* 🔴 万一两次点击中间被打断（东西还捏在光标上），关窗口会把它**掉在地上** —— 先放回背包。
   *    `bot.moveSlotItem` 是"拿起来 + 放下"两次点击，第二次超时就是这个状态。 */
  try {
    if (win.selectedItem) {
      const held = `${win.selectedItem.name}x${win.selectedItem.count}`
      const dest2 = typeof win.firstEmptyInventorySlot === 'function' ? win.firstEmptyInventorySlot() : null
      if (dest2 != null) {
        await withTimeout(Promise.resolve(bot.clickWindow(dest2, 0, 0)), 1_200, '把手上的东西放回背包')
        moved.push(`${held}（光标上那件）`)
      }
    }
  } catch {}
  return moved
}

async function runPlan (bot, plan, table, timeoutMs, notes = [], msLeftFn = null) {
  const done = []
  /* 🔴 bot 是裸 mineflayer bot，`msLeft()` 在 McBot 上 —— 由调用方把函数递进来 */
  const msLeft = () => msLeftFn?.() ?? Infinity
  /* 关掉残留的**容器**窗口（不动合成格）。`bot.craft()` 的 2×2 那条路是拿 `bot.inventory`
   * 的格子号去点 `bot.currentWindow`（craft.js 里 `clickWindow` 不传窗口）—— 工作台窗口还开着
   * 的时候，格子号就串到工作台窗口上：服务端把材料放进工作台、结果槽变成"格子里剩什么就做什么"，
   * 而这些东西全在窗口里、`bot.inventory` 看不见（"背包里 0 根原木"就是这么来的）。
   * 关窗口 = 服务端把合成格里的东西退回背包。 */
  const closeContainer = async () => {
    try {
      if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
        await withTimeout(Promise.resolve(bot.closeWindow(bot.currentWindow)), 1_500, '关掉残留的合成窗口')
      }
    } catch {}
  }
  const closeMaybeWindow = async () => {
    await closeContainer()
    /* 🔴 容器窗口关掉还不够：**自己背包的 2×2 合成格没有窗口可关** ——
     *    掐断合成后留在格子里的材料必须点回背包，否则下一次合成会拿错位的格子号去点
     *    （实机日志：`⚠️ 服务端其实做出了别的东西：oak_planks×5`、"背包里 0 根原木"）。
     *    🔴 审计 M1：**只在"上一条合成确实收尾了"之后才点**（点走正在跑的那条链刚放进去的原料，
     *    它下一轮 `findInventoryItem` 就会抛 missing ingredient，或者把料放回去再点结果槽）。 */
    const grid = await clearCraftGrid(bot, msLeft)
    if (grid.length) notes.push(`（合成格里还剩 ${grid.join('、')}：已经点回背包了）`)
  }
  /* 开头先清干净。🔴 但**上一条合成还在跑时只关窗口、不点合成格**（审计 M1）：
   * 点走它刚放进去的原料，它下一轮 `findInventoryItem` 就会抛 missing ingredient，
   * 或者把料放回去再点结果槽 ⇒ 服务端"格子里剩什么就做什么"。
   * 等它收尾之后再清，交给下面的重试循环处理。 */
  if (craftBusy.get(bot)) await closeContainer()
  else await closeMaybeWindow()
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i]
    // 🔴 单次调用 ≤11 秒：做到一半就停，剩下的步骤让 AI 再叫一次接着做
    if (msLeft() < 400) {
      notes.push(`这一轮的 11 秒用完了：第 ${i + 1}~${plan.steps.length} 步还没做 —— 再叫一次 mc_craft 接着做`)
      break
    }
    /* 🔴 有工作台就**一律用工作台**，哪怕这条配方 2×2 背包也能做。
     * 实机（2026-10）踩到：mineflayer 的 2×2 背包合成走 `bot.inventory`，
     * 而 `craft.js` 的 `grabResult()` 里 `bot.putAway(0)` 用的是 `bot.currentWindow`，
     * 窗口状态一错就卡 20 秒报 `Event updateSlot:0 did not fire within timeout of 20000ms`，
     * 合成格里的材料还可能丢掉。工作台那条路稳定得多。 */
    const tbl = table ?? null
    if (s.table && !tbl) throw new Error(`合成 ${s.name} 需要工作台，但附近没有`)
    const id = itemIdOf(bot, s.name)
    const all = recipesAllOf(bot, id, tbl)
    /* 🔴 ① 优先沿用**计划里那条配方**（`s.recipe`）。
     * 真配方数据里同一样东西每个木种各一条，`Recipe.find` 的顺序里 cherry/birch 排在 oak 前面。
     * 计划是拿虚拟背包一路选下来的（同一个木种走到底），执行期要是再用 `recipesReady(...)[0]` 重挑一次，
     * 就会挑成"背包里恰好也够"的**另一个木种**：计划"橡木木板→橡木木棍→橡木镐"，
     * 第一步做了橡木木板，第二步却挑走背包里剩的桦木木板，第三步既没有 3 个橡木木板、也没有 2 根桦木木棍，
     * `recipesReady` 空 → 兜底 `recipesAllOf(...)[0]` 变成 cherry → mineflayer 抛 `missing ingredient`。
     * （2026-10-06 实机踩到：第一次调用失败、重试就成功，AI 自己都学会"重试一次"了。根因就在这。）
     */
    let rec = null
    if (s.recipe && !shortfallOf(bot, s.recipe, s.times)) rec = s.recipe
    /* ② 计划那条用不了了（背包在这中间变了）→ 重新按**真实背包**挑：
     * `pickRecipe` 会挑原料最多的那条；都没有时按"最普通的材料"（oak 系、cobblestone…）
     * 再按原料 id 最小兜底，不会挑 cherry / cobbled_deepslate。 */
    if (!rec) {
      const ready = recipesReady(bot, id, tbl, s.times * s.out)
      rec = pickRecipe(ready.length ? ready : all, (x) => countOf(bot, x, null), bot)
    }
    if (!rec) throw new Error(`合成 ${s.name} 时找不到配方（背包里的原料可能对不上）`)
    /* ③ 动手前核对原料真的在背包里；不够就换成能凑出来的那条（换个木种也算成功），
     * 实在不行就**说清楚缺什么**，别让 mineflayer 那句 missing ingredient 白跑一趟。 */
    let short = shortfallOf(bot, rec, s.times)
    if (short) {
      const alt = pickRecipe(all, (x) => countOf(bot, x, null), bot)
      if (alt && !shortfallOf(bot, alt, s.times)) {
        rec = alt
        short = null
        notes.push(`第 ${i + 1} 步「${s.name}」换了材料：改用 ${ingredientsOf(alt).map((x) => itemNameOf(bot, x.id)).join(' + ')}`)
      }
    }
    if (short) {
      throw new Error(`第 ${i + 1} 步「${s.name}」原料对不上：`
        + short.map((x) => `${x.name} 要 ${x.need} 个、背包里只有 ${x.have} 个`).join('；')
        + '（同一种木材要凑齐 —— 手里混了别的木种时先把要用的那种凑够）')
    }
    const outId = rec.result?.id ?? id
    const before = countOf(bot, outId, null)
    dbgLog(`第 ${i + 1} 步「${s.name}」×${s.times}｜配方 ${itemNameOf(bot, outId)} ← ${ingredientsOf(rec).map((x) => `${itemNameOf(bot, x.id)}×${x.count}`).join(' + ')}${tbl ? '（工作台）' : '（背包 2×2）'}｜craft 前背包 ${invSnap(bot)}`)
    /* ④ 失败重试：mineflayer 开工作台/点格子时偶尔会误报 `missing ingredient`、
     * 或者卡在窗口上（`Event updateSlot:0 did not fire ...`）；craft 正常返回但背包没变
     * （点格子没生效）也算失败。一律"关掉窗口 → 隔一下 → 再来一次"，别让 AI 自己重试。 */
    let lastErr = null
    let threw = false
    let got = 0
    const tStep = Date.now()
    /* 整步开工前的背包总数（判断"料到底有没有被扣走"，用来区分"没做成"和"做成了但掉地上"）。 */
    const invAllBefore = invSnapMap(bot)
    for (let attempt = 0; attempt < 3; attempt++) {
      threw = false
      // 🔴 每次重试都按"本轮还剩多少时间"给超时，别 3 次各 30 秒把调用拖到 90 秒
      const leftMs = msLeft() === Infinity ? (Number(timeoutMs) || 30_000) : msLeft()
      if (leftMs < 400) { lastErr = lastErr ?? new Error('这一轮的 11 秒用完了'); break }
      const stepMs = Math.max(300, Math.min(Number(timeoutMs) || 30_000, leftMs))
      /* 🔴 上一条合成还在跑就**绝不并行**，也**不先去点合成格**（审计 M1：点走正在跑的那条链
       * 刚放进去的原料，它下一轮就会抛 missing ingredient / 做出别的东西）。
       * 顺序是：等它收尾 → 收尾了才关窗口 + 清合成格 → 还挂着就如实拒绝，宁可这一轮什么都不做。 */
      const st = craftState(bot)
      if (st) {
        const why = st === 'stuck-cleared'
          ? '上一次合成挂了太久（服务端一直没回应）'
          : '上一次合成还在跑（可能卡住了：窗口一直没回应）'
        if (st === 'stuck-cleared') notes.push(`${why} —— 我这次会先等它收尾，不会开第二条链`)
        const waitMs = Math.max(300, Math.min(1_500, msLeft() - 400))
        if (!(await craftSettled(bot, waitMs))) {
          /* 等不到收尾：关**容器窗口**（服务端会把里面的东西退回背包）。
           * 🔴 另外，链已经挂了不止 3 秒 ⇒ 它不会再动了，**顺手把自己背包 2×2 合成格里压着的东西
           *    点回背包**（`clearCraftGrid` 里会先 `resyncInventory` 跟服务端对账，否则那 4 格
           *    在客户端模型里是空的、点不动 —— 这正是"材料卡在合成格里、背包里看不见"的主因）。
           *    3 秒是留给"正常但慢的合成"的余地，免得把还在干活的链刚放进去的原料抢走（审计 M1）。 */
          await closeContainer()
          /* 🔴 报告 H5（2026-10-13）：以前这里算 `age = Date.now() - craftPendingAt.get(bot)` 再判
           *    `age > 3_000`，但 `craftState()`（`:449-451`）在**真挂死**那条路上刚刚把时间戳
           *    重置成 `Date.now()` ⇒ 这里的 `age ≈ 0` ⇒ `clearCraftGrid` 永远不跑 ——
           *    而它正是"材料卡在合成格里、背包里看不见"的修法（那次修复实际是死代码）。
           *    判据直接用 `craftState` 已经算好的结论：`st === 'stuck-cleared'` 才是真挂死
           *    （`busy` 说明还没到 25 秒，别去抢它刚放进去的原料）。 */
          const grid = st === 'stuck-cleared' ? await clearCraftGrid(bot, msLeft) : []
          throw new Error(`${why} —— 我**没有**开第二条链`
            + (grid.length
              ? `；顺手把合成格里压着的 ${grid.join('、')} 点回背包了`
              : '（只把合成窗口关掉了，格子里的东西服务端会退回背包）')
            + '。过一会儿再叫一次 mc_craft 重试；'
            + '要是还卡，就先 mc_scan 复核一眼现场（每次动手前我都会先把合成格里的材料点回背包）。')
        }
        await closeMaybeWindow()
      }
      const invBefore = invSnapMap(bot)
      try {
        /* 🔴 一次只做**一批**（count=1）：`bot.craft(rec, N)` 不保证做够 N 批 ——
         * 2026-10-08 实机：要 8 块木板只出了 4 块，下一步就撞 `原料对不上`；
         * 更糟的是"点格子点了一半被 11 秒预算掐断"会把材料留在合成格里（窗口失步）。
         * 一批一批来，每批都对账，剩下的交给下面那个补做循环。 */
        const p = bot.craft(rec, 1, tbl)
        trackCraft(bot, p)
        await withTimeout(p, stepMs, `合成 ${s.name}`)
      } catch (e) {
        threw = true
        lastErr = e
        /* 🔴 2026-10-08 审计（会话 step 642：`❌ 合成中断：合成 oak_planks 超时（5000ms）`）：
         *    mineflayer 的 `waitForWindowUpdate()` 用 `once(window, 'updateSlot:N')` 等**服务端回包**
         *    （`mineflayer\lib\plugins\inventory.js:476-488`），而 1.17.1+ 的服务端"只有它认为
         *    客户端记录过期时才回"—— 它忽略的点击**永远不回**，于是干等到 20 秒
         *    （就是 `Event updateSlot:0 did not fire within timeout of 20000ms`）。
         *    mineflayer 自己留了后门：`bot._syncWindow(窗口)`（`inventory.js:853-870`）发一个
         *    `stateId:-1` 的**空点击**，服务端必回整窗内容 ⇒ 那些挂着的 `updateSlot` 事件一起到。
         *    所以"超时"先 sync 一把再量背包，别直接判失败。 */
        const stall = /updateSlot|did not fire|超时|timeout/i.test(String(e?.message ?? ''))
        if (stall) {
          const win = bot.currentWindow && bot.currentWindow !== bot.inventory ? bot.currentWindow : bot.inventory
          try {
            if (typeof bot._syncWindow === 'function' && win) {
              await withTimeout(Promise.resolve(bot._syncWindow(win)), 1_200, '同步合成窗口')
              await new Promise((r) => setTimeout(r, 150))
            }
          } catch { /* 老版本 mineflayer / 假 bot 没有 _syncWindow 就算了 */ }
        }
        /* 🔴 报错 ≠ 没做成：`updateSlot ... did not fire` 常常是"东西已经到手、只是窗口事件丢了"
         * （mineflayer 点完格子就等事件，事件没来照样抛）。先量一下背包：真涨了就当成功 ——
         * 不然会拿着刚做好的东西再要一次材料，最后报一个假的 `missing ingredient`。
         * （2026-10-06 生产日志里 `mc_craft：torch ×4 失败：Event updateSlot:0 did not fire…` 就是这一类。） */
        got = countOf(bot, outId, null) - before
        /* 🔴 报错 ≠ 没做成，也可能"做出了**别的东西**"：窗口/格子模型串了的时候，
         * 服务端按它自己那份格子做，结果槽里是另一条配方（1 块木板 → 按钮）。
         * 拿背包前后快照一比就能看见，别让它悄悄躺在背包里让 AI 困惑。 */
        const extra = invDiffText(bot, invBefore, itemNameOf(bot, outId))
        if (extra) notes.push(`第 ${i + 1} 步「${s.name}」：${extra}`)
        if (got > 0) {
          lastErr = null
          notes.push(`第 ${i + 1} 步「${s.name}」：窗口事件丢了，但东西已经到手（${itemNameOf(bot, outId)}×${got}）`)
          await closeMaybeWindow()
          break
        }
        const msg = String(e?.message ?? '')
        // 只重试"窗口/格子没跟上"这类；真缺料、配方不对这种重试也没用
        if (!/missing ingredient|updateSlot|did not fire|timeout/i.test(msg)) { await closeMaybeWindow(); break }
        await closeMaybeWindow()
        await new Promise((r) => setTimeout(r, 400))
        continue
      }
      got = countOf(bot, outId, null) - before
      if (got > 0) {
        lastErr = null
        /* 🔴 成功也要清合成格：mineflayer 一次可能只点了一部分结果槽，剩下的原料还留在 2×2
         *    合成格里，而 `bot.inventory` **看不见格子里的东西** —— 2026-10-19 实机表现成
         *    "18 根原木凭空没了、只做出 8 块木板"，直到下一次合成开头才被点回背包。
         *    点回背包之后才对得上账。 */
        await closeMaybeWindow()
        break
      }
      lastErr = new Error('craft 正常返回但背包没变')
      await closeMaybeWindow()
      await new Promise((r) => setTimeout(r, 400))
    }
    dbgLog(`第 ${i + 1} 步「${s.name}」craft 返回（${Date.now() - tStep}ms）｜得到 ${itemNameOf(bot, outId)}×${got}｜craft 后背包 ${invSnap(bot)}`)
    /* 只做出来一部分（材料刚好不够 / 中途被打断）也如实说：别让 AI 以为数量够了 */
    const wantOut = (Number(s.out) || 1) * s.times
    /* 🔴 一次 `bot.craft(rec, N)` 有时只做出**一批**（背包 2×2 上实测过：要 8 块木板只出了 4 块），
     * 后面那一步就会拿着"只有 2 块木板"去撞 `原料对不上`。材料还够就自己把剩下的补上，
     * 一次只做一批（count=1），做不动就如实说，绝不假装数量够了。
     * 轮数上限跟要做的批数挂钩（`s.times` 批 + 1 轮容错），别写死。 */
    let made = got
    for (let round = 0; made > 0 && made < wantOut && round < Math.max(2, (Number(s.times) || 1) + 1); round++) {
      if (shortfallOf(bot, rec, 1)) break          // 材料真不够了，认
      const leftMs2 = msLeft() === Infinity ? (Number(timeoutMs) || 30_000) : msLeft()
      if (leftMs2 < 400) {
        notes.push(`这一轮的 11 秒用完了：「${s.name}」还差 ${wantOut - made} 个 —— 再叫一次 mc_craft 接着做`)
        break
      }
      const snap2 = invSnapMap(bot)
      const before2 = countOf(bot, outId, null)
      try {
        const p2 = bot.craft(rec, 1, tbl)
        trackCraft(bot, p2)
        await withTimeout(p2, Math.max(300, Math.min(Number(timeoutMs) || 30_000, leftMs2)), `补做 ${s.name}`)
      } catch (e) {
        const extra2 = invDiffText(bot, snap2, itemNameOf(bot, outId))
        if (extra2) notes.push(`补做「${s.name}」时：${extra2}`)
        dbgLog(`补做「${s.name}」第 ${round + 1} 轮抛错：${e?.message ?? e}`)
        await closeMaybeWindow()
        /* 🔴 抛错 ≠ 没做出来（跟上面主循环那条同一个道理）：`updateSlot did not fire` 这类
         *    是"东西已经到手、只是窗口事件丢了"。**先对账再决定**：真涨了就接着补，
         *    别把整步停在第一批进度上（2026-10-19 实机：要 24 块木板，只做了 4 块就不动了）。 */
        const now2 = countOf(bot, outId, null)
        if (now2 > before2) { made = now2 - before; continue }
        if (!/missing ingredient|updateSlot|did not fire|timeout/i.test(String(e?.message ?? ''))) break
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      /* 🔴 2026-10-19 实机：补做那一批**服务端已经做出来了**，但窗口还开着 ⇒ 客户端 slots 没同步，
       *    读回来还是上一批的数 ⇒ 要 8 块木板时报"只做出来 4 个（材料不够了？）"，
       *    模型于是又调一次 mc_craft —— 第二次才发现背包里其实是 8 个（白跑一趟，还差点重复合成）。
       *    关窗（服务端必回整窗内容）对账后再量。 */
      await closeMaybeWindow()
      await new Promise((r) => setTimeout(r, 120))
      const now = countOf(bot, outId, null)
      if (now <= before2) break
      made = now - before
    }
    got = made
    if (got > 0 && got < wantOut) {
      notes.push(`第 ${i + 1} 步「${s.name}」只做出来 ${got} 个（本来要 ${wantOut} 个）—— 材料不够了？再叫一次 mc_craft 试试`)
    }
    if (got <= 0) {
      /* 报错前先把窗口关干净：合成格里可能还留着材料，关窗口 = 服务端把它们退回背包，
       * 不然下一轮 mc_craft 看到的还是"背包里 0 根原木"。 */
      await closeMaybeWindow()
      /* 🔴 2026-10-17（实机 AI 复盘原话：「合成的时候背包满了，造出来的东西会掉地上，机器人不知道」）：
       *    背包满时服务端把产物 `spawn_entity` **掉在脚边**，背包一个都不涨 —— 这不是"点格子没生效"。
       *    判据两条同时成立才算：① 料真被扣走了（背包总数变少）② 脚边真有掉落物。 */
      let drops = []
      try { drops = dropsNear(bot, 6) } catch { drops = [] }
      const totalOf = (m) => { let n = 0; for (const c of m.values()) n += c; return n }
      const shrank = totalOf(invSnapMap(bot)) < totalOf(invAllBefore)
      /* 料被扣走了、背包里却没多出来 ⇒ 不是"点格子没生效"，而是"做出来了但没进背包"。
       * 到底掉地上还是卡在合成格里，看脚边有没有掉落物。 */
      if (shrank) {
        const err = new Error(`第 ${i + 1} 步「${s.name}」的产物没进背包（料被扣走了）`)
        err.mcDropped = { step: s.name, drops: drops.length, at: drops[0]?.e?.position ?? null, distance: drops[0]?.d ?? null }
        throw err
      }
      throw new Error(threw
        ? `第 ${i + 1} 步「${s.name}」失败：${lastErr?.message ?? '未知错误'}`
        : `第 ${i + 1} 步「${s.name}」合成没有产出（连试 3 次背包都没变 —— mineflayer 点格子没生效，材料可能留在合成格里）`)
    }
    done.push({ name: s.name, times: s.times, got })
  }
  return done
}

/** 这批产物**放得下吗**（背包满 = 产物掉地上、料白扣，2026-10-27 用户「造东西背包满了就会，一直造」）。
 *
 *  ① 同名物品还能叠多少（`stackSize - 已有数量`）—— 产物往往能和手里那叠合并，不该拦；
 *  ② 空位 × stackSize；
 *  ③ 合成过程会把某些料**吃光**，那几叠消失就是腾出槽位 —— 按计划里各配方的 `delta` 估。
 *     ⚠️ 估不准就按 0 算：宁可少报"能腾"，也不放行之后又掉一地。
 *  读不到背包（假 bot / 旧版本没有 `emptySlotCount`）就**放行** —— 不能因为读不到就把活儿全拒了。
 */
function craftRoomFor (bot, id, need, plan = null) {
  try {
    const inv = bot.inventory.items()
    const stack = Number(bot.registry?.items?.[id]?.stackSize) || 64
    let room = 0
    for (const it of inv) if (it.type === id) room += Math.max(0, stack - it.count)
    const free = Number(bot.inventory.emptySlotCount()) || 0
    let freed = 0
    try {
      const used = new Map()
      for (const s of plan?.steps ?? []) {
        const d = s?.recipe?.delta
        if (!Array.isArray(d)) continue
        const times = Number(s.times) || 1
        for (const x of d) {
          if (x && Number(x.count) < 0) used.set(x.id, (used.get(x.id) ?? 0) - Number(x.count) * times)
        }
      }
      for (const [mid, cnt] of used) {
        const piles = inv.filter((i) => i.type === mid)
        const have = piles.reduce((a, i) => a + i.count, 0)
        if (have > 0 && cnt >= have) freed += piles.length
      }
    } catch { freed = 0 }
    const ok = room + (free + freed) * stack >= need
    return { ok, free, room, freed, stack }
  } catch { return { ok: true, free: null, room: null, freed: 0, stack: null } }
}

export async function apply (api) {
  const { ctx, asTool, getSession, logLine } = api
  dbgLog = (m) => { if (process.env.DSH_MC_AGENT_CRAFT_DEBUG === '1') logLine(`mc_craft[调试] ${m}`) }

  ctx.tools.register(asTool({
    name: 'mc_craft',
    description: '🧱 **合成物品**（真合成，走服务端的合成台，不是作弊给物）。生存模式下"原木→木板→工作台→木镐"就靠它。\n'
      + '· 会**自动补齐中间产物**：给它 `name:"wooden_pickaxe"`，它自己排"木板→木棍→木镐"的顺序一起做，不用你一步步算。\n'
      + '· 需要工作台：附近有就用；没有就报"缺桌子"并列出周围哪几张能用 —— **不替你放**（用户 2026-10-19 定）。\n'
      + '· 原料不够会告诉你**缺什么、缺几个、现在有几个**，并给出下一步该调哪个工具（比如先 `mc_dig` 砍原木）。\n'
      + '· `name` 可以写简称：`planks` 会自动选背包里那种原木对应的木板（选了哪个会写在结果里）。\n'
      + '· `list:true` 看配方/看当前能做什么；`dryRun:true` 只出计划不动手（拿不准就先 dryRun）。\n'
      + '· `count` 是"背包里**一共**要到几个"（默认 1）：已经够了就**一个都不做**，结果会如实说"一个都没做"。要"再做 4 个"就写 `{count:4, more:true}`。\n'
      + '· 🔴 连着两三次都"超时"就先 `mc_scan` 复核现场（我每次动手前都会先把合成格里的材料点回背包）。\n'
      + '· 🔴 **背包放不下就直接拒绝、一粒料都不扣**（背包满时产物会掉地上、料白扣）。同一样东西连掉两次地就先腾空位，别硬试。\n'
      + '· `tree:true` 出**整套活儿**的依赖树（合成 + 要烧的 + 要挖的，连"挖它要什么镐"一起）——'
      + '比如 `{tree:true,name:"iron_pickaxe"}` ⇒ 铁镐 ← 铁锭 ← 烧 raw_iron ← 挖 iron_ore ← 石镐 ← 圆石… 全排出来。'
      + '**只出计划、不动手**；不知道该从哪一步开始时先看它。\n'
      + '🔴 合成只动背包、不动世界，所以**不受 mc_observe 门禁限制**。',
    parameters: {
      name: { type: 'string', description: '要合成的物品（英文 id 或简称，如 planks / stick / wooden_pickaxe）' },
      count: { type: 'number', description: '合成后背包里**一共**要有几个（默认 1）。要"再做 N 个"就加 more:true' },
      more: { type: 'boolean', description: 'count 当"再做几个"（在现有基础上加，默认 false = count 是"一共要到几个"）' },
      table: { type: 'boolean', description: '允许用工作台（默认 true）' },
      x: { type: 'number', description: '指定工作台坐标 x（可选，和 y/z 一起给）' },
      y: { type: 'number', description: '指定工作台坐标 y（可选）' },
      z: { type: 'number', description: '指定工作台坐标 z（可选）' },
      radius: { type: 'number', description: '附近找工作台的半径（默认 4，最大 8）' },
      list: { type: 'boolean', description: '只看配方，不合成' },
      dryRun: { type: 'boolean', description: '只出合成计划，不动手（默认 false）' },
      tree: { type: 'boolean', description: '只出「整套活儿」的依赖树：合成 + 要烧的 + 要挖的（连"挖它要什么镐"一起），不动手。拿不准"这东西到底怎么搞到"就先 tree:true' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }],
    },
    timeoutMs: CALL_MS + 1_000,
    async execute (args, exec) {
      const sess = getSession(exec)
      const mc = sess.bot
      const bot = mc.requireBot() // 不在线会抛带原因的错
      // 🔴 等区块也算进"这一轮 11 秒"
      await withTimeout(mc.waitForChunks(), CALL_MS, '等待区块加载')

      const allowTable = args.table !== false
      const radius = clamp(Number(args.radius) || 4, 1, 8)
      const wantPos = { x: args.x, y: args.y, z: args.z, radius }

      /* ① list：只看配方 */
      if (args.list === true) {
        if (args.name == null || args.name === '') {
          const table0 = allowTable ? findTableBlock(bot, wantPos) : null
          const can = listCraftable(bot, table0)
          const lines = [`🧾 现在背包里**立刻能合成**的（${can.length} 个${table0 ? '，含用旁边工作台的' : '，不含需要工作台的'}）：`]
          if (!can.length) lines.push('  （一个都做不了——先 `mc_dig` 挖点原料，或 `mc_craft {name:"crafting_table"}` 再放下）')
          else lines.push('  ' + can.map((c) => c.name).join(' / '))
          lines.push('　看某个物品的配方：`mc_craft {list:true,name:"wooden_pickaxe"}`')
          return { text: lines.join('\n') }
        }
        const t = resolveItem(bot, args.name, allowTable ? findTableBlock(bot, wantPos) : null)
        const info = listRecipesFor(bot, t.item.id, allowTable ? findTableBlock(bot, wantPos) : null)
        const lines = [`🧾 **${info.name}** 的配方（共 ${info.recipes.length} 条）：`]
        if (!info.recipes.length) {
          lines.push(info.needTable ? '  （有配方，但需要工作台——先合成+放下工作台）' : '  （没有配方：这个物品不能合成，或名字不对）')
        }
        for (const r of info.recipes) {
          const from = r.from.map((f) => `${f.name} ×${f.count}（有 ${f.have}）`).join(' + ')
          const enough = r.from.every((f) => f.have >= f.count)
          lines.push(`  · 产出 ×${r.out}${r.table ? '（需要工作台）' : ''} ← ${from} ${enough ? '✅ 够' : '⚠️ 缺'}`)
        }
        if (t.note) lines.push(`　${t.note}`)
        return { text: lines.join('\n') }
      }

      /* ①b tree：整套活儿的依赖树（合成 + 烧 + 挖），只出计划不动手 */
      if (args.tree === true) {
        if (args.name == null || args.name === '') return { text: '❌ 要 `tree:true` 得给 `name`（比如 `{tree:true,name:"iron_pickaxe",count:3}`）' }
        try {
          const t = goalTree(bot, args.name, args.count, { table: allowTable })
          return { text: describeGoalTree(t), ...t }
        } catch (e) {
          return { text: `❌ ${e.message}` }
        }
      }

      /* ② 解析目标 + 找/放工作台 */
      let table = allowTable ? findTableBlock(bot, wantPos) : null
      let placedNote = null
      let target
      try {
        target = resolveItem(bot, args.name, table, args.count)
      } catch (e) {
        return { text: `❌ ${e.message}` }
      }
      /* 🔴 `count` 的口径（2026-10-08 实机反馈：AI 说"材料像是被吞了"）：
       *    默认是"**背包里一共要到 N 个**"（`planCraft` 的 want 就是这个意思），
       *    所以背包里已经有 13 块木板时 `{name:"oak_planks",count:4}` **一个都不做**、
       *    却回一句"✅ 合成完成" —— 模型以为做过了，再叫一次还是这句，看起来就像材料被吞。
       *    现在：① 什么都没做时如实说"一个都没做 + 你现在有几个 + 想再做几个该怎么写"；
       *          ② `more:true` = count 当"再做几个"（在现有基础上加），一句话就能表达"再做 4 个"。 */
      const wantN = clamp(Math.round(Number(args.count) || 1), 1, 1024)
      const haveNow = countOf(bot, target.item.id, null)
      const want = args.more === true ? clamp(haveNow + wantN, 1, 4096) : wantN

      /* ③ 规划：先按"手边没工作台"规划一次，只有真缺工作台才去放（免得做不需要桌子东西时也乱放） */
      let plan = planCraft(bot, target.item.id, want, table)
      /* 🔴 够不着/看不见的工作台不能用：服务端不理这次右键 ⇒ craft.js 的 `once('windowOpen')`
       * 没有超时 ⇒ 整条 craft 挂到预算到点（实机日志里那些 4123~5000ms 的超时就是这么来的）。
       * 判据用"计划里有没有哪一步要用工作台"（`s.table`），**不能**用 `plan.missing` ——
       * 有工作台的时候 missing 里当然没有 crafting_table，那条件永远不成立（第一版就是这么错的）。
       * 2×2 就能做的东西不为此多放一张桌子。 */
      if (table && plan.steps.some((s) => s.table)) {
        const whyTable = tableWhyNot(bot, table)
        if (whyTable) {
          placedNote = `（附近那个工作台用不了：${whyTable} —— 先不用它，能用手上 2×2 做的就先做）`
          table = null
          plan = planCraft(bot, target.item.id, want, null)
        }
      }
      const head = []
      if (placedNote) head.push(placedNote)
      if (target.note) head.push(`　${target.note}`)
      if (table) head.push(`　🔨 工作台：(${table.position.x},${table.position.y},${table.position.z})`)

      /* 🔴 2026-11-05 issue #6 ③：需要工作台的合成都报“缺料” —— 绝大多数不是缺料，
       *    而是工作台在 5~32 格外：`findTableBlock` 只看身边 4 格，plan 于是判“缺桌子”，
       *    而它长得跟“缺料”一模一样，模型只能一遍遍重试同一个调用。
       *    这里替模型走过去（`mc_chest` / `mc_furnace` 一直是这个口径），走过去重新规划；
       *    走不到才如实报。**仍然不替你放桌子**（用户 2026-10-19 定）。 */
      if (!table && allowTable && args.x == null && plan.steps.some((st) => st.table)) {
        const probeR = clamp(Math.round(Number(args.radius) || 16), 4, 32)
        const cand = (() => { try { return listTablesNearby(bot, Math.max(8, probeR), 1)[0] ?? null } catch { return null } })()
        if (cand) {
          const at = { x: cand.x, y: cand.y, z: cand.z }
          try {
            const leftWalk = Number(mc.msLeft?.() ?? 15_000)
            const mv2 = await mc.walkTo(at, { arrive: 2.2, budget: Math.min(15_000, Math.max(2_000, leftWalk)) })
            const t2 = (() => { try { return findTableBlock(bot, { ...at, radius: 3 }) } catch { return null } })()
            if (t2) {
              table = t2
              plan = planCraft(bot, target.item.id, want, table)
              head.push(`　🔨 工作台在 ${cand.distance} 格外（${at.x},${at.y},${at.z}）—— 我已经走过去用它的 3×3`)
            } else {
              head.push(`　🔨 走到 (${at.x},${at.y},${at.z}) 附近了，但没读到那张工作台（${mv2?.reason ?? '走不到'}）`)
            }
          } catch (e) {
            head.push(`　🔨 想走过去用工作台 (${at.x},${at.y},${at.z}) 但没走成：${String(e?.message ?? e).slice(0, 80)}`)
          }
        } else if (probeR < 32) {
          head.push(`　🔨 身边 ${probeR} 格里没有工作台（要更远的话加 \`radius:32\`）`)
        }
      }

      if (!plan.ok) {
        const text = [...head, describeMissing(plan, bot)].filter(Boolean).join('\n')
        logLine(`mc_craft：${target.item.name} ×${want} 缺料（${plan.missing.map((m) => m.name).join(',')}）`)
        return { text }
      }
      if (args.dryRun === true) {
        return { text: [...head, describePlan(plan, target.item.name, want)].filter(Boolean).join('\n') }
      }

      /* ④ 执行 */
      const t0 = Date.now()
      const notes = []
      /* 🔴 2026-10-17（实机 AI 复盘原话：「合成的时候背包满了，造出来的东西会掉地上，机器人不知道」）：
       *    背包满时服务端会把合成产物**掉在脚边**（`spawn_entity`），而 `bot.craft()` 照常 resolve
       *    ⇒ 背包里的数对不上，AI 却看到「✅ 合成完成」。做法：记下开工前的数与空位，
       *    收工后拿"计划声称做出来的个数"与"背包实际增量"对账，对不上就扫脚边的掉落物点名报出来。 */
      /* 🔴 2026-10-27（用户：「造东西背包满了就会，一直造」）：
       *    背包满时服务端把产物丢在地上、**料照扣** —— 每叫一次净亏一组料，而模型看到"还差几个"
       *    就再叫一次，于是变成"一直造"（实机日志：`diamond_chestplate ×1 产物没进背包（脚边 3 个掉落物）`）。
       *    两道闸门：① 开工前算"这些产物放得下吗"，放不下就**一粒料都不扣**地拒绝；
       *    ② 同一物品刚掉过地 ⇒ 只要现在还没有空位就直接拒绝，别再亏第二次（腾出空位后自动放行）。 */
      /* `want` 是"背包里一共要几个"，闸门要算的是"还要**新做**几个"（已有的那叠能继续叠）。 */
      const haveTarget = countOf(bot, target.item.id, null)
      const needOut = Math.max(0, want - haveTarget)
      const room0 = craftRoomFor(bot, target.item.id, needOut, plan)
      const prevDrop = (() => {
        try { return bot._craftDrop?.key === target.item.id ? Number(bot._craftDrop.n) || 0 : 0 } catch { return 0 }
      })()
      if (!room0.ok) {
        const out = [...head, ...notes,
          `⛔ **背包放不下，没开工**（一粒料都没扣）：「${target.item.name}」还要再做 ${needOut} 个`
          + `（一共要到 ${want} 个，现在有 ${haveTarget} 个），可背包只剩 ${room0.free} 个空位、`
          + `同名物品还能叠 ${room0.room} 个${room0.freed ? `、合成过程大概能腾出 ${room0.freed} 个位` : ''}。`,
          ...(prevDrop
            ? [`　而且刚才已经掉过 **${prevDrop} 次**地：料被扣走、产物留在脚边（服务端只能丢地上）。`
              + '**别再叫同样的 mc_craft** —— 结果一样，只会再亏一组料。']
            : []),
          '　→ 先腾空位（任选一种）：`mc_chest` 把不值钱的存进箱子 / `mc_act {mode:"toss", name:"…"}` 丢掉一些 / '
          + '走到脚边把掉落物捡回来（掉落物几分钟就消失）。腾出空位后再叫我，我不会白扣料。',
        ].filter(Boolean)
        logLine(`mc_craft：${target.item.name} ×${want} 拒绝开工（背包放不下：空位 ${room0.free}、可叠 ${room0.room}、估腾 ${room0.freed}${prevDrop ? `、刚掉地 ${prevDrop} 次` : ''}）`)
        return {
          text: out.join('\n'), refused: true, why: 'inventory-full',
          freeSlots: room0.free, roomFor: room0.room, droppedBefore: prevDrop,
        }
      }
      try { bot._craftDrop = null } catch { /* 假 bot */ }

      const before0 = haveTarget
      const free0 = (() => { try { return bot.inventory.emptySlotCount() } catch { return null } })()
      let done
      try {
        done = await runPlan(bot, plan, table, 30_000, notes, () => mc.msLeft?.() ?? Infinity)
      } catch (e) {
        /* 🔴 2026-10-17（用户实机：「合成的时候背包满了，造出来的东西会掉地上，机器人不知道」）：
         *    这不是"合成中断"，是"做出来了、只是没进背包" —— 必须分开说，并且点名可执行动作。
         *    报成"❌ 中断"会让模型以为白做了，然后拿同样的料再做一遍。 */
        if (e?.mcDropped) {
          const d = e.mcDropped
          const freeNow = (() => { try { return bot.inventory.emptySlotCount() } catch { return null } })()
          /* 🔴 2026-10-27：记一笔账 —— 同一物品掉过地，下一次只要还没有空位就直接拒绝（见 room0 那段）。
           *    不然模型会"还差 1 个 → 再叫一次 → 再掉一次"，把料一路造光。 */
          const dropTimes = (() => {
            try {
              const n = (bot._craftDrop?.key === target.item.id ? Number(bot._craftDrop.n) || 0 : 0) + 1
              bot._craftDrop = { key: target.item.id, n }
              return n
            } catch { return null }
          })()
          const out = [...head, ...notes,
            `⚠️ **产物没进背包** —— 「${d.step}」的料被扣走了，背包里却没多出来。`,
            ...(freeNow === 0 ? ['　根因：**背包一个空位都没有**（服务端只能把产物丢在地上）。'] : []),
            ...(d.drops > 0
              ? [`　脚边就有 **${d.drops} 个掉落物**（最近的离我 ${Number(d.distance).toFixed(1)} 格`
                + `${d.at ? ` @ (${Math.floor(d.at.x)},${Math.floor(d.at.y)},${Math.floor(d.at.z)})` : ''}）`
                + '　→ `mc_move` 走过去就自动捡（掉落物几分钟就消失）']
              : ['　（脚边没扫到 —— 可能卡在合成格里，关一次窗口再看背包）']),
            '　→ **下次合成前先腾空位**：`mc_chest` 存一趟、或者丢掉点不值钱的。',
            ...(dropTimes
              ? [`　🔴 这已经是「${target.item.name}」第 ${dropTimes} 次掉地：**空位没腾出来之前别再叫 mc_craft**，`
                + '我会直接拒绝（一粒料都不扣），别拿料去试。']
              : []),
          ].filter(Boolean)
          logLine(`mc_craft：${target.item.name} ×${want} 产物没进背包（${d.step}，脚边 ${d.drops} 个掉落物${dropTimes ? `，累计掉地 ${dropTimes} 次` : ''}）`)
          return { text: out.join('\n'), dropped: true, step: d.step, onGround: d.drops, droppedTimes: dropTimes }
        }
        const text = [...head, ...notes, `❌ 合成中断：${e.message}`, describePlan(plan, target.item.name, want)].filter(Boolean).join('\n')
        logLine(`mc_craft：${target.item.name} ×${want} 失败：${e.message}`)
        return { text }
      }
      const ms = Date.now() - t0
      const got = countOf(bot, target.item.id, null)
      const lines = [...head, ...notes]
      /* 🔴 "一个都没做"不能报"✅ 合成完成"：`count` 是"背包里一共要到几个"，
       *    背包里已经够了的时候计划是 0 步，回"完成"会让模型以为做过了（实机原话"材料像是被吞了"）。 */
      if (!done.length) {
        lines.push(`ℹ️ 一个都没做：背包里已经有 **${target.item.name} ×${got}**`
          + `（\`count\` 是"背包里一共要到几个"，你要的 ${want} 个已经够了）`)
        lines.push(`　→ 要**再做** ${wantN} 个：\`mc_craft {name:"${target.item.name}", count:${wantN}, more:true}\``
          + `（或者 count 直接写 ${got + wantN}）`)
      } else {
        lines.push(`✅ 合成完成（${(ms / 1000).toFixed(1)}s）：${done.map((d) => `${d.name} ×${d.got}`).join('、')}`)
        /* 🔴 2026-11-05 issue #6 ④（“`count` 没生效，一次只做 1 个”）：做完就报“完成”，
         *    数量不够时模型不知道是“料只够这么多”还是“我没做够”。这里把差额摊开说清楚：
         *    还差几个、差的是哪样料、现有几个 —— 它照着补料或直接再叫一次。 */
        if (got < want) {
          const left = want - got
          lines.push(`　⚠️ 还差 ${left} 个（要到 ${want} 个，现在 ${got} 个）—— 下面这句是“为什么没做够”：`)
          let hint = null
          try {
            const p2 = planCraft(bot, target.item.id, want, table)
            hint = p2.ok ? '料是够的：再叫一次 mc_craft 接着做（一次调用做不完就多叫一次，别改 count）' : describeMissing(p2, bot)
          } catch (e) { hint = `重新规划时出错：${String(e?.message ?? e).slice(0, 80)}` }
          lines.push('　' + String(hint).split('\n').join('\n　'))
        }
      }
      lines.push(`　背包里现在有 **${target.item.name} ×${got}**`)
      /* 🔴 对账：计划说做了几个 vs 背包真的多了几个。对不上就是"掉地上了"（或卡在合成格里）。 */
      const madeExpected = done.length ? Number(done[done.length - 1].got ?? 0) : 0
      const madeActual = got - before0
      const lost = Math.max(0, madeExpected - madeActual)
      let mine = []
      if (lost > 0) {
        /* 🔴 掉落物实体的 `name` 恒为 `'item'`、`displayName` 恒为 `'Item'` —— mineflayer **不解析**
         *    那个 metadata 槽，所以从实体对象上读不出"这是哪种物品"。⇒ 只能按"脚边有几个掉落物"
         *    来点名，别假装认得出是哪一种（认错了比不说更坏）。 */
        try { mine = dropsNear(bot, 8) } catch { mine = [] }
        lines.push(`⚠️ **做出来了 ${madeExpected} 个，背包里只多了 ${madeActual} 个** —— 差的 ${lost} 个`
          + `${free0 === 0 ? '是因为**背包一个空位都没有**，' : '很可能'}掉在脚边了。`)
        if (mine.length) {
          const at = mine[0].e.position
          lines.push(`　脚边就有 **${mine.length} 个掉落物**（最近的一个离我 ${mine[0].d.toFixed(1)} 格 @ `
            + `(${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)})）`
            + '　→ `mc_move` 走过去就自动捡（掉落物几分钟就消失）')
        } else {
          lines.push('　（脚边暂时没扫到，可能已经被别人/别的东西捡走，或者卡在合成格里 —— '
            + '关一次窗口再看看背包）')
        }
        lines.push('　→ **下次合成前先腾空位**：`mc_chest` 存一趟、或者丢掉点不值钱的。')
        /* 🔴 2026-10-27：对账对不上（掉地/卡格）也记账，下一轮直接拒绝，不让它拿料反复试。 */
        try {
          bot._craftDrop = {
            key: target.item.id,
            n: (bot._craftDrop?.key === target.item.id ? Number(bot._craftDrop.n) || 0 : 0) + 1,
          }
        } catch { /* 假 bot */ }
        lines.push('　🔴 空位没腾出来之前别再叫同样的 mc_craft —— 我会直接拒绝（一粒料都不扣）。')
      } else {
        try { bot._craftDrop = null } catch { /* 假 bot */ }
        if (free0 !== null && free0 <= 1 && madeExpected > 0) {
          lines.push(`⚠️ 背包只剩 ${free0} 个空位了 —— 再合成/再挖，产物和掉落物就会掉地上（几分钟就消失）。`
            + '先去 `mc_chest` 存一趟。')
        }
      }
      // 🔴 `mc.inventory()` 回的是 `{ text, held, items }`，**不是数组** —— 这里以前写
      // `Array.isArray(inv) ? … : []`，条件永远为假，这行"背包：…"从来没打印过。
      const inv = mc.inventory()
      const bag = Array.isArray(inv?.items) ? inv.items.slice(0, 12) : []
      if (bag.length) lines.push('　背包：' + bag.map((i) => `${i.name}×${i.count}`).join('、'))
      logLine(`mc_craft：${target.item.name} ×${want} ${done.length ? '完成' : '没做新的（背包里已经够了）'}`
        + `（${done.length} 步 / ${ms}ms）`)
      return {
        text: lines.join('\n'), steps: done, target: target.item.name, count: got,
        /* 机器可读的"少了几个"（0 或缺失 = 都对上了）。 */
        ...(lost > 0 ? { lost, madeExpected, madeActual, onGround: mine.length } : {}),
      }
    },
  }))

  logLine('mc_craft 已加载：工具 mc_craft（递归合成 / 自动用或放工作台 / 缺料报告；不受看图门禁限制）')
}
