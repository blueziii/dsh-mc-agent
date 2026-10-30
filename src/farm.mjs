/**
 * 睡觉 + 耕地播种（用户 2026-10-23：「1档和2档做一下」—— 一档第 4 条）。
 *
 * 抄 mindcraft 的 `goToBed` / `tillAndSow`（`src/agent/library/skills.js:1543` 与 `:1575`）。
 * 在此之前插件**既不会睡觉也不会种地**：`bed` 只当方块看（`place.mjs` / `prep.mjs`），
 * `hoe` 只出现在挖掘速度表和背包判断里。夜里的时间全白等，吃的只能靠打猎。
 *
 * 抄过来之后**补了它没有的三件事**（我们的规矩：动手就要有回读证据）：
 *   1. 睡之前先看"现在是不是夜里"（`bot.time.timeOfDay` 不在 12541~23458、又没有雷雨 ⇒ 床根本没用），
 *      免得白走一趟；睡下去之后按 `bot.isSleeping` 复核，是躺上了还是被服务端拒了。
 *   2. 耕地 / 播种**每一步都回读方块**：锄头挥完看是不是变成 `farmland`，种子撒完看地上有没有长出作物。
 *      mindcraft 那边 `activateBlock` 一发了事，成功了也看不出来。
 *   3. 一次只干预算内的活（11 秒闸门），干不完把"还剩哪几格"报出来 —— 再叫一次接着干，别从头找。
 *
 * 原语（`mineflayer/lib/plugins/bed.js`）：
 *   · `bot.sleep(bedBlock)`（:79）—— 白天直接抛 `it's not night and it's not a thunderstorm`；
 *     床被别人占着抛 `the bed is occupied`；周围有怪抛 `there are monsters nearby`；
 *     给床头还是床脚都行（`parseBedMetadata` 自己算），只有半张床才抛 `there's only half bed`。
 *   · `bot.isSleeping` 由实体状态包驱动（:185 `entitySleep`），躺上了才是 true。
 *   · `bot.wake()`（:66）—— 躺着时发包起床，没躺着抛 `already awake`。
 *
 * 三条约定同其它叶子模块：不 import mineflayer、不反向 import `core.mjs`、插件实例状态走 `ctx`。
 */
import { Vec3 } from 'vec3'
import { callBudget, needLeft, insufficientText } from './budget.mjs'
import { heldSnapshotOf, restoreHeldOf } from './bridge.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const floor3 = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
const isAirName = (n) => n === 'air' || n === 'cave_air' || n === 'void_air'

/** 睡觉要"点得到"床：4.5 格是服务端交互距离，留 1 格余量。 */
/**
 * 🔴 `bot.blockAt()` 只认真 `Vec3`：喂普通 `{x, y, z}` 会在 prismarine-world 里抛
 *    `pos.floored is not a function`（用户 2026-10-26 实测撞到的就是这条）。
 *    本文件所有方块查询**只从这一个口子进**，别再直接 `b.blockAt({...})`。
 */
const at = (b, p) => {
  try { return b.blockAt(new Vec3(p.x, p.y, p.z)) } catch { return null }
}

export const BED_REACH = 3.5

/** 一晚的时间戳窗口（原版 `Level.getTimeOfDay`：12541 入夜 / 23458 天亮）。 */
export const NIGHT_FROM = 12_541
export const NIGHT_TO = 23_458

/** 种子 → 长出来的作物。名字按 1.20+ 的 registry；`carrot`/`potato` 的物品名不带 seeds。 */
export const SEED_TO_CROP = {
  wheat_seeds: 'wheat',
  carrot: 'carrots',
  potato: 'potatoes',
  beetroot_seeds: 'beetroots',
  melon_seeds: 'melon_stem',
  pumpkin_seeds: 'pumpkin_stem',
  torchflower_seeds: 'torchflower_crop',
  pitcher_pod: 'pitcher_crop',
}

/** 反过来：作物 → 种它的东西（用来"收完接着种"）。 */
export const CROP_TO_SEED = Object.fromEntries(
  Object.entries(SEED_TO_CROP).map(([seed, crop]) => [crop, seed]),
)

/** 锄头能用上的地面（`dirt_path` 在 1.17+ 也能锄；`coarse_dirt`/`rooted_dirt` **不能**，不列）。 */
export const TILLABLE = new Set(['grass_block', 'dirt', 'dirt_path'])

/**
 * 现在能不能睡。
 *
 * `timeOfDay` 读不到就别拦（私人服/改过时间的服可能是 `undefined`）——
 * 硬拦会把"其实能睡"的服也挡在门外，睡着了以 `bot.isSleeping` 为准。
 */
export function nightStateOf (b) {
  const raw = b?.time?.timeOfDay
  const t = Number(raw)
  const known = Number.isFinite(t) && (t >= 0 || t < 24_000)
  const thunder = b?.isRaining === true && Number(b?.thunderState ?? 0) > 0
  const night = known ? (t >= NIGHT_FROM && t <= NIGHT_TO) : true
  return { timeOfDay: known ? Math.round(t) : null, night, thunder }
}

/** 附近最近的床（给半径；返回 `{ pos, block, d }` 或 null）。 */
export function bedNear (b, radius = 32) {
  const found = b.findBlocks({
    matching: (blk) => /(^|_)bed$/.test(blk?.name ?? ''),
    maxDistance: radius,
    count: 8,
  }) ?? []
  const me = b.entity?.position
  let best = null
  for (const p of found) {
    const d = me ? me.distanceTo(p) : 0
    if (!best || d < best.d) best = { pos: floor3(p), d: Number(d.toFixed(2)) }
  }
  if (!best) return null
  best.block = at(b, best.pos)
  return best.block ? best : null
}

/** 方块的状态属性（`age` 这类）—— `getProperties()` 是 prismarine-block 的正路，老版本走 `_properties`。 */
export function propsOf (blk) {
  if (!blk) return null
  if (typeof blk.getProperties === 'function') return blk.getProperties() ?? null
  return blk._properties ?? null
}

export function ageOf (blk) {
  const a = propsOf(blk)?.age
  return a == null ? null : Number(a)
}

/** 这种作物的最大 `age`（从 registry 的 `states` 里取 `num_values - 1`；查不到就 null）。 */
export function maxAgeOf (b, name) {
  const def = b?.registry?.blocksByName?.[name]
  const st = Array.isArray(def?.states) ? def.states.find((s) => s?.name === 'age') : null
  const n = Number(st?.num_values)
  return Number.isFinite(n) && n > 1 ? n - 1 : null
}

/** 熟了没：`true`/`false`，读不到就是 `null`（不知道，别当熟）。 */
export function matureOf (b, blk) {
  const crop = blk?.name
  if (!crop || !CROP_TO_SEED[crop]) return null
  const age = ageOf(blk)
  const max = maxAgeOf(b, crop)
  if (age == null || max == null) return null
  return age >= max
}

/** 背包里第一把锄头（耐久最高的那把，免得拿个快坏的）。 */
export function hoeOf (b) {
  const hoes = (b.inventory?.items?.() ?? []).filter((i) => /_hoe$/.test(i.name ?? ''))
  if (!hoes.length) return null
  const rank = { netherite: 5, diamond: 4, iron: 3, stone: 2, golden: 1, wooden: 0 }
  hoes.sort((a, c) => (rank[String(c.name).split('_')[0]] ?? 0) - (rank[String(a.name).split('_')[0]] ?? 0))
  return hoes[0]
}

/** 背包里第一份种子（`args.seed` 指名时只用它）。 */
export function seedOf (b, want = null) {
  const items = b.inventory?.items?.() ?? []
  if (want != null && String(want).trim() !== '') {
    const name = String(want).trim().toLowerCase()
    const hit = items.find((i) => i.name === name) ?? items.find((i) => i.name === `${name}_seeds`)
    return hit ? { item: hit, seed: hit.name } : null
  }
  for (const i of items) {
    if (SEED_TO_CROP[i.name]) return { item: i, seed: i.name }
    /* `wheat` 也是种子（不带 _seeds 的别名）—— 1.20 的 registry 里它叫 wheat_seeds，这里兜旧名 */
    if (i.name === 'seeds') return { item: i, seed: 'wheat_seeds' }
  }
  return null
}

/** 报"周围哪几格能种"：地面上有空气、且是土/草/已耕的地。 */
export function farmSpotsNear (b, { radius = 4, count = 6, y = null } = {}) {
  const me = b.entity?.position
  if (!me) return []
  const r = clamp(Math.floor(radius), 1, 8)
  const base = y == null ? Math.floor(me.y) : Math.floor(y)
  const out = []
  for (let dy = -2; dy <= 1; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = { x: Math.floor(me.x) + dx, y: base + dy, z: Math.floor(me.z) + dz }
        const blk = at(b, p)
        if (!blk) continue
        const name = blk.name ?? ''
        const isSoil = TILLABLE.has(name) || name === 'farmland'
        if (!isSoil) continue
        const above = at(b, { x: p.x, y: p.y + 1, z: p.z })
        const aboveName = above?.name ?? 'air'
        if (!isAirName(aboveName) && !CROP_TO_SEED[aboveName]) continue
        out.push({
          pos: p, soil: name,
          above: aboveName,
          d: Number(me.distanceTo(blk.position ?? p)),
          mature: CROP_TO_SEED[aboveName] ? matureOf(b, above) : null,
        })
      }
    }
  }
  out.sort((a, c) => (a.d ?? 0) - (c.d ?? 0))
  return out.slice(0, clamp(Math.floor(count), 1, 16))
}

/* ────────────────────────────── 睡觉 ────────────────────────────── */

/** 把 mineflayer 的英文报错翻成"人话 + 下一步"。 */
export function sleepErrorText (msg) {
  const m = String(msg ?? '')
  if (/not night|thunderstorm/i.test(m)) return '现在不是夜里（也不在下雷雨）—— 床这会儿点不着。等天黑（`mc_status` 能看时间），或者干脆别睡。'
  if (/occupied/i.test(m)) return '那张床已经有人躺着了 —— 换一张（`mc_scan {name:"bed"}` 看附近还有没有）。'
  if (/monsters nearby/i.test(m)) return '周围有怪，躺不下去 —— 先把怪清掉（`mc_attack {who:"zombie"}`），或者插火把把附近点亮。'
  if (/too far/i.test(m)) return '离床太远（服务端点不到）—— 走到床跟前再叫一次。'
  if (/only half bed/i.test(m)) return '那只是半张床（另一半被拆了）—— 补一张床，或者换一张。'
  if (/wrong block/i.test(m)) return '那不是床（放错方块了）。'
  if (/already sleeping/i.test(m)) return '已经躺着了。'
  if (/not sleeping/i.test(m)) return '点了床但服务端没让躺下（3 秒没回执）—— 多半是位置/权限问题，再叫一次或换个位置。'
  return `躺不下去：${m || '没报错但也没躺上'}`
}

/**
 * 睡觉。
 *
 * @param {object} args
 *   · `x/y/z` 指定哪张床（不给就找最近的）
 *   · `radius` 找床范围（默认 32，最大 64）
 *   · `budgetMs` 走过去的时间（默认整轮 10 秒）
 *   · `waitMs` 躺上之后最多等多久醒来（默认 8000：多人服要等别人也睡才跳夜）
 */
export async function sleepInBed (self, args = {}, ctx = {}) {
  const b = self.requireBot()
  const t = ctx.t ?? ((p) => p)
  if (typeof b.sleep !== 'function') throw new Error('这个 mineflayer 没有 sleep（bed 插件没装上）—— 睡不了')

  if (b.isSleeping === true) {
    return { ok: true, slept: true, already: true, text: '🛏 已经躺在床上了（`mc_act {mode:"wake"}` 能起来）。' }
  }

  const now = nightStateOf(b)
  if (!now.night && !now.thunder) {
    return {
      ok: false, slept: false, reason: 'daytime', ...now,
      text: `☀️ 现在是白天（timeOfDay=${now.timeOfDay}）—— 床这会儿**点了也没用**，晚上再来（${NIGHT_FROM} 之后）。`
        + ' 白天该干的活：挖矿、盖房、种地、跑图。',
    }
  }

  // ① 找床（或者用给的坐标）
  let bedPos = null
  let bed = null
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && Number.isFinite(Number(args.z))) {
    bedPos = { x: Math.floor(args.x), y: Math.floor(args.y), z: Math.floor(args.z) }
    bed = at(b, bedPos)
    if (!/(^|_)bed$/.test(bed?.name ?? '')) {
      return { ok: false, slept: false, reason: 'not-a-bed', at: bedPos, block: bed?.name ?? '空气', text: `那个坐标（${bedPos.x},${bedPos.y},${bedPos.z}）是 ${bed?.name ?? '空气'}，不是床。` }
    }
  } else {
    const radius = clamp(Number(args.radius) || 32, 4, 64)
    const hit = bedNear(b, radius)
    if (!hit) {
      return {
        ok: false, slept: false, reason: 'no-bed', radius,
        text: `🛏 附近 ${radius} 格没找到床。手里有羊毛和木板就 \`mc_craft {name:"white_bed"}\`，`
          + ' 再 `mc_act {mode:"place", x, y, z, name:"white_bed"}` 放下；不想盖床就去挖矿（`mc_move {x, z}` 到矿洞，夜里也能挖）。',
      }
    }
    bedPos = hit.pos
    bed = hit.block
  }

  // ② 走过去（够不着就睡不了）
  let walked = null
  const dist = b.entity?.position ? b.entity.position.distanceTo(bed.position ?? bedPos) : 0
  if (dist > BED_REACH) {
    walked = await self.walkTo(bedPos, {
      arrive: 2, intent: 'interact', allowDig: false, noTower: true, budget: callBudget(args.budgetMs),
    })
    if (!walked?.arrived) {
      return {
        ok: false, slept: false, reason: 'too-far', bed: bedPos, walked,
        text: `🛏 还没走到床跟前（还差 ${walked?.remaining ?? '?'} 格）—— 它可能被墙挡着/在屋里。`
          + ' 再叫一次会接着走；实在进不去就把床挪出来。',
      }
    }
    await sleep(150)
  }

  // ③ 躺下（先复核一次方块名 —— 走过去这十来秒里床可能被拆了）
  const bedNow = at(b, bedPos)
  if (!/(^|_)bed$/.test(bedNow?.name ?? '')) {
    return { ok: false, slept: false, reason: 'bed-gone', bed: bedPos, text: `床没了（那一格现在是 ${bedNow?.name ?? '空气'}）。` }
  }
  try {
    await t(b.sleep(bedNow), 'act', '躺下睡觉')
  } catch (e) {
    return { ok: false, slept: false, reason: 'sleep-failed', bed: bedPos, walked, error: String(e?.message ?? e), text: `🛏 ${sleepErrorText(e?.message ?? e)}` }
  }

  // ④ 复核：真躺上了吗（`bot.isSleeping` 由状态包驱动）
  await sleep(300)
  if (b.isSleeping !== true) {
    return {
      ok: false, slept: false, reason: 'not-sleeping', bed: bedPos, walked,
      text: '🛏 点了床，但**服务端没让我躺下**（`isSleeping` 还是 false）—— 再叫一次；还是没有就换一张床，或者这个服禁了睡觉。',
    }
  }

  // ⑤ 等醒（多人服要等所有人才跳夜；单人服几秒就亮）
  const waitMs = clamp(Number(args.waitMs) || 8_000, 0, 20_000)
  const t0 = Date.now()
  let woken = b.isSleeping !== true
  while (!woken && Date.now() - t0 < Math.min(waitMs, Math.max(0, self.msLeft() - 300))) {
    await sleep(250)
    woken = b.isSleeping !== true
  }
  return {
    ok: true, slept: true, woken, bed: bedPos, bedName: bedNow.name ?? 'bed',
    waitedMs: Date.now() - t0,
    ...(walked ? { walked } : {}),
    text: woken
      ? `🛏 睡了（${bedPos.x},${bedPos.y},${bedPos.z}）又醒了 —— 天亮了${
        now.timeOfDay == null ? '' : `（睡前 timeOfDay=${now.timeOfDay}）`
      }。`
      : `🛏 **躺上了**（${bedPos.x},${bedPos.y},${bedPos.z}），还没醒 —— 这个服要所有玩家都睡才跳夜；`
        + '这段时间别叫我干活，醒了再叫我（或者 `mc_act {mode:"wake"}` 自己起来）。',
  }
}

/** 起床（躺着时才有用）。 */
export async function wakeUp (self) {
  const b = self.requireBot()
  if (typeof b.wake !== 'function') throw new Error('这个 mineflayer 没有 wake —— 起不来（会被动等天亮）')
  if (b.isSleeping !== true) return { ok: true, wasSleeping: false, text: '🛏 本来就没在睡。' }
  try {
    await b.wake()
  } catch (e) {
    return { ok: false, wasSleeping: true, error: String(e?.message ?? e), text: `起不来：${e?.message ?? e}` }
  }
  await sleep(200)
  const still = b.isSleeping === true
  return {
    ok: !still, wasSleeping: true, stillSleeping: still,
    text: still ? '🛏 发了起床包，但还躺着 —— 再叫一次。' : '🛏 起来了。',
  }
}

/* ────────────────────────────── 耕地播种 ────────────────────────────── */

/**
 * 耕地 + 播种（可以顺手先收成熟的）。
 *
 * @param {object} args
 *   · `x/y/z` 只处理那一格（给的是**土/草/已耕地那一格**，作物长在它上面）
 *   · `radius`/`count` 不给坐标时：在周围 ≤8 格里找 ≤16 格土
 *   · `seed` 种什么（默认用背包里第一种种子）
 *   · `harvest` 成熟了先收（默认 true）
 *   · `clear` 上面有杂物先挖掉（默认 false —— 默认只跳过并报出来）
 *   · `budgetMs` 预算（默认整轮 10 秒）
 */
export async function farmArea (self, args = {}, ctx = {}) {
  const b = self.requireBot()
  const t = ctx.t ?? ((p) => p)
  const harvest = args.harvest !== false
  const clear = args.clear === true
  const seedPick = seedOf(b, args.seed)
  if (args.seed != null && String(args.seed).trim() !== '' && !seedPick) {
    return {
      ok: false, reason: 'no-seed',
      text: `背包里没有 "${args.seed}" 这种种子（` + '`mc_inventory` 看有什么；`wheat_seeds`/`carrot`/`potato`/`beetroot_seeds` 都能种）。',
    }
  }

  // ① 锁定要处理的那几格
  let spots = []
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && Number.isFinite(Number(args.z))) {
    const p = { x: Math.floor(args.x), y: Math.floor(args.y), z: Math.floor(args.z) }
    const blk = at(b, p)
    const above = at(b, { x: p.x, y: p.y + 1, z: p.z })
    if (!blk) return { ok: false, reason: 'unloaded', at: p, text: `那一格（${p.x},${p.y},${p.z}）没加载 —— 先走近再看。` }
    spots = [{ pos: p, soil: blk.name, above: above?.name ?? 'air', mature: CROP_TO_SEED[above?.name] ? matureOf(b, above) : null }]
  } else {
    spots = farmSpotsNear(b, { radius: args.radius ?? 4, count: args.count ?? 6 })
  }
  if (!spots.length) {
    return {
      ok: false, reason: 'no-spot',
      text: '附近没有能种的格子（要**土/草方块/已耕地**，上面还得是空的）。'
        + ' 给个坐标也行：`mc_act {mode:"farm", x, y, z}`（y 是土那一格）。',
    }
  }

  // ② 一把就能干完的活：先看锄头和种子够不够，别干到一半才发现没有
  const willTill = spots.filter((s) => TILLABLE.has(s.soil))
  const hoe = willTill.length ? hoeOf(b) : null
  /* 🔴 2026-10-28 实机（用户：「mc_act { mode:"farm" } 这样也不需要锄头吗」）：这里原来没锄头就
   *   整批 `return`，把下面逐格兜底（"没有锄头就跳过这一格"）整个废掉了。自动找地一定会捞到
   *   生土（`farmSpotsNear` 把 dirt / grass_block / dirt_path 都算候选），于是"没锄头"连已经
   *   耕好的地撒种、熟了的作物收割都不干了。缺工具是**这一格干不了**，不是**整批不许干**。 */
  const noHoe = willTill.length > 0 && !hoe

  const keep = heldSnapshotOf(b)
  const done = []
  const skipped = []
  const failed = []
  let tilled = 0
  let planted = 0
  let harvested = 0

  try {
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]
      if (self.msLeft() < 1_500) {
        skipped.push({ pos: s.pos, why: 'budget', note: '这次没轮到（时间到了）' })
        continue
      }
      // 走够近（4 格内才能点）
      const d = b.entity?.position ? b.entity.position.distanceTo(at(b, s.pos)?.position ?? s.pos) : 0
      if (d > 4) {
        /* 🔴 2026-10-29：剩余不够就跳过这一格（不再 `max(1000, 剩余-2000)` 硬压） */
        const nb = needLeft(self, 1_000, 4_000)
        if (!nb.ok) { skipped.push({ pos: s.pos, why: 'budget', note: insufficientText(nb, '走到这一格旁边') }); continue }
        const w = await self.walkTo(s.pos, { arrive: 2, intent: 'stand', allowDig: false, noTower: true, budget: nb.budgetMs })
        if (!w?.arrived) { skipped.push({ pos: s.pos, why: 'unreachable', note: '走不过去' }); continue }
        await sleep(120)
      }

      const soilBlk = at(b, s.pos)
      const abovePos = { x: s.pos.x, y: s.pos.y + 1, z: s.pos.z }
      let above = at(b, abovePos)
      let aboveName = above?.name ?? 'air'

      // ① 上面有作物：熟了先收，没熟就跳过
      if (CROP_TO_SEED[aboveName]) {
        const mature = matureOf(b, above)
        if (mature === true && harvest) {
          const keepCrop = CROP_TO_SEED[aboveName]
          const r = await self.breakBlock({ ...abovePos })
          await sleep(200)
          const gone = !CROP_TO_SEED[at(b, abovePos)?.name ?? '']
          if (!gone) { failed.push({ pos: s.pos, why: 'harvest-failed', note: `收了但那一格还是 ${at(b, abovePos)?.name}` }); continue }
          harvested++
          above = at(b, abovePos)
          aboveName = above?.name ?? 'air'
          s.reseed = keepCrop
        } else if (mature === true && !harvest) {
          skipped.push({ pos: s.pos, why: 'mature', note: '熟了没让收（harvest:false）' }); continue
        } else {
          skipped.push({ pos: s.pos, why: 'growing', note: `上面还长着 ${aboveName}（${mature === null ? '看不出熟没熟' : '没熟'}）` }); continue
        }
      } else if (!isAirName(aboveName)) {
        // ② 上面是别的方块：默认跳过，clear:true 才挖
        if (!clear) { skipped.push({ pos: s.pos, why: 'blocked', note: `上面是 ${aboveName}（要清掉加 clear:true）` }); continue }
        await self.breakBlock({ ...abovePos })
        await sleep(200)
        aboveName = at(b, abovePos)?.name ?? 'air'
        if (!isAirName(aboveName)) { failed.push({ pos: s.pos, why: 'clear-failed', note: `清不掉 ${aboveName}` }); continue }
      }

      // ③ 不是 farmland 就锄
      let soilName = soilBlk?.name ?? ''
      if (!TILLABLE.has(soilName) && soilName !== 'farmland') {
        failed.push({ pos: s.pos, why: 'not-soil', note: `那是 ${soilName || '空气'}，锄不了` }); continue
      }
      if (soilName !== 'farmland') {
        if (!hoe) { skipped.push({ pos: s.pos, why: 'no-hoe', note: '这格是土，没有锄头锄不了' }); continue }
        const eq = await self.equip({ name: hoe.name })
        if (eq?.equipped === false) { failed.push({ pos: s.pos, why: 'equip-failed', note: `拿不起 ${hoe.name}` }); continue }
        try {
          await t(b.activateBlock(soilBlk), 'act', '锄地')
        } catch (e) {
          failed.push({ pos: s.pos, why: 'till-failed', note: String(e?.message ?? e) }); continue
        }
        await sleep(250)
        soilName = at(b, s.pos)?.name ?? ''
        if (soilName !== 'farmland') {
          failed.push({ pos: s.pos, why: 'till-unconfirmed', note: `锄完还是 ${soilName}（可能被别的东西占了/离太远）` }); continue
        }
        tilled++
      }

      // ④ 播种
      const wantSeed = s.reseed ?? seedPick?.seed ?? null
      if (!wantSeed) { skipped.push({ pos: s.pos, why: 'no-seed', note: '地耕好了但没有种子' }); continue }
      const crop = SEED_TO_CROP[wantSeed]
      if (!crop) { skipped.push({ pos: s.pos, why: 'unknown-seed', note: `不知道 ${wantSeed} 能种出什么` }); continue }
      const have = seedOf(b, wantSeed)
      if (!have) { skipped.push({ pos: s.pos, why: 'seed-out', note: `种子用完了（${wantSeed}）` }); continue }
      const farmBlk = at(b, s.pos)
      const eqs = await self.equip({ name: have.seed })
      if (eqs?.equipped === false) { failed.push({ pos: s.pos, why: 'equip-failed', note: `拿不起 ${have.seed}` }); continue }
      try {
        await t(b.activateBlock(farmBlk), 'act', `播种 ${have.seed}`)
      } catch (e) {
        failed.push({ pos: s.pos, why: 'sow-failed', note: String(e?.message ?? e) }); continue
      }
      await sleep(250)
      const after = at(b, abovePos)
      const afterName = after?.name ?? 'air'
      if (afterName === crop || (CROP_TO_SEED[afterName] === have.seed)) {
        planted++
        done.push({ pos: s.pos, tilled: soilName === 'farmland', crop: afterName })
      } else {
        failed.push({ pos: s.pos, why: 'sow-unconfirmed', note: `撒了种子但那格是 ${afterName}（不是 ${crop}）` })
      }
    }
  } finally {
    try { await restoreHeldOf(b, keep) } catch { /* 换不回来是小事 */ }
  }

  const bits = []
  if (harvested) bits.push(`收 ${harvested} 格`)
  if (tilled) bits.push(`锄 ${tilled} 格`)
  if (planted) bits.push(`种 ${planted} 格`)
  const text = (bits.length ? `🌾 ${bits.join('、')}` : '🌾 这一轮一格都没种上')
    + (skipped.length ? `；跳过 ${skipped.length} 格` : '')
    + (noHoe ? '；没有锄头，土那几格没锄（`mc_craft {name:"wooden_hoe"}`：2 木板 + 2 木棍）' : '')
    + (failed.length ? `；失败 ${failed.length} 格（${failed.slice(0, 3).map((f) => `${f.pos.x},${f.pos.z}:${f.why}`).join(' / ')}）` : '')
    + (skipped.some((s) => s.why === 'budget') ? '；时间到了，剩下的再叫一次就好' : '')
    + (planted ? `\n🌱 长熟要一会儿：` + [...new Set(done.map((d) => CROP_TO_SEED[d.crop] ?? d.crop))].join('、') + ' —— 别原地等，去干别的，回头用 `mc_scan` 看 `age`。' : '')
  return {
    ok: planted > 0 || tilled > 0 || harvested > 0,
    planted, tilled, harvested,
    done, skipped, failed,
    ...(skipped.some((s) => s.why === 'budget') ? { remaining: skipped.filter((s) => s.why === 'budget').map((s) => s.pos) } : {}),
    ...(seedPick ? { seed: seedPick.seed } : {}),
    ...(hoe ? { hoe: hoe.name } : {}),
    spots: spots.length,
    text,
  }
}
