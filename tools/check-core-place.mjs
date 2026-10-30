#!/usr/bin/env node
/**
 * check-core-place.mjs —— "拿什么方块去搭"的选料检查
 *
 * 背景（用户 2026-10-06 报的 bug）："它搭方块会用非实体方块搭"。两个来源：
 *   ① `McBot.placeBlock()` 没给 name 时直接 `items[0]` —— 背包第一格是火把/树苗/门/木棍也照拿；
 *   ② `scaffoldingItemIds()` 只排掉了矿石，火把、树苗、门、半砖、楼梯全进了 pathfinder 的
 *      `scafoldingBlocks`，垫在脚下一站就掉。
 *
 * 坑在哪：光看 `boundingBox === 'block'` 不够 —— 半砖、楼梯、栅栏、墙、地毯、耕地、土径、
 * 头颅、铁砧的 `boundingBox` **也是** `'block'`、`transparent` **也是** `false`。
 * 这个脚本用**真 registry（1.21.10）**把"什么算整方块"钉死，防止这两个坑回来。
 *
 * 用法：node tools/check-core-place.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 真 registry ───────────────────────────────────────────────────────────────
// 源码树里没有 node_modules，得从包目录（<profile>/node_modules/dsh-mc-agent）借 minecraft-data。
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const loadMcData = () => {
  const bases = [
    process.env.DSH_MC_AGENT_MCDATA_BASE,
    new URL('../index.js', import.meta.url).href,                                  // 包内直接就有
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),                      // 源码树 → 借包里的
    join(PROFILE, 'index.js'),
  ].filter(Boolean)
  for (const base of bases) {
    try {
      const m = createRequire(base)('minecraft-data')
      if (m) return m('1.21.10')
    } catch {}
  }
  return null
}
const mcData = loadMcData()
if (!mcData) {
  console.log('✗ 拿不到 minecraft-data —— 用 DSH_MC_AGENT_MCDATA_BASE 指到有它的 index.js 再跑')
  process.exit(2)
}
const reg = { blocksByName: mcData.blocksByName, itemsByName: mcData.itemsByName }

const { isFullBlockItem, scaffoldingItemIds, pickPlaceItem } = await import(new URL('../src/core.mjs', import.meta.url))
const itemId = (n) => mcData.itemsByName[n]?.id
const bag = (list) => ({ registry: reg, inventory: { items: () => list } })
/** 造背包：名字 → 一摞（默认 1 个） */
const itemsOf = (spec) => {
  const out = []
  let slot = 0
  for (const [n, c] of spec) {
    const id = itemId(n)
    if (id == null) { console.log(`  (跳过：registry 里没有物品 ${n})`); continue }
    out.push({ type: id, name: n, count: c ?? 1, slot: slot++ })
  }
  return out
}
const names = (ids) => ids.map((id) => mcData.items[id]?.name ?? String(id))

/* ─────────────────────── ① 整方块：必须认 ─────────────────────── */
section('① 整方块（能站上去、能往上叠）—— 必须认')
{
  const good = ['stone', 'dirt', 'cobblestone', 'oak_planks', 'oak_log', 'sand', 'gravel',
    'netherrack', 'end_stone', 'obsidian', 'deepslate', 'cobbled_deepslate', 'snow_block']
  for (const n of good) {
    const exists = !!mcData.blocksByName[n]
    ok(exists && isFullBlockItem(bag([]), n), `${n} 算整方块`, exists ? '' : '（registry 里没有）')
  }
}

/* ─────────────────────── ② 非整方块：必须排掉 ─────────────────────── */
section('② 非整方块 —— 必须排掉（用户报的就是这类被拿去搭）')
{
  const cases = [
    // 根本不是方块（木棍、材料）
    ['stick', '不是方块'], ['coal', '不是方块'], ['diamond', '不是方块'],
    ['apple', '不是方块'], ['string', '不是方块'], ['bucket', '不是方块'],
    // boundingBox !== 'block'
    ['torch', 'boundingBox=empty'], ['oak_sapling', 'boundingBox=empty'],
    ['oak_button', 'boundingBox=empty'], ['oak_sign', 'boundingBox=empty'],
    ['rail', 'boundingBox=empty'], ['cobweb', 'boundingBox=empty'],
    ['vine', 'boundingBox=empty'], ['redstone_torch', 'boundingBox=empty'],
    // transparent !== false
    ['oak_door', 'transparent'], ['oak_trapdoor', 'transparent'], ['ladder', 'transparent'],
    ['glass', 'transparent'], ['oak_leaves', 'transparent'], ['scaffolding', 'transparent'],
    ['bamboo', 'transparent'], ['lily_pad', 'transparent'],
    // 名字黑名单（①②都拦不住：bb=block 且 transparent=false）
    ['oak_slab', '半砖'], ['oak_stairs', '楼梯'], ['oak_fence', '栅栏'],
    ['oak_fence_gate', '栅栏门'], ['cobblestone_wall', '墙'], ['white_carpet', '地毯'],
    ['farmland', '耕地'], ['dirt_path', '土径'], ['player_head', '头颅'],
    ['skeleton_skull', '头颅'], ['anvil', '铁砧'], ['chipped_anvil', '铁砧'],
  ]
  for (const [n, why] of cases) {
    const exists = !!(mcData.blocksByName[n] || mcData.itemsByName[n])
    ok(exists && !isFullBlockItem(bag([]), n), `${n} 不算整方块（${why}）`, exists ? '' : '（registry 里没有）')
  }
  // 半砖/栅栏的 boundingBox 确实是 block —— 证明"只看 boundingBox 不够"，注释里那句话不是猜的
  ok(mcData.blocksByName.oak_slab?.boundingBox === 'block' && mcData.blocksByName.oak_slab?.transparent === false,
    'oak_slab 的 boundingBox 是 block 且 transparent 是 false（所以必须靠名字黑名单）',
    JSON.stringify({ bb: mcData.blocksByName.oak_slab?.boundingBox, tr: mcData.blocksByName.oak_slab?.transparent }))
}

/* ─────────────────────── ③ scaffoldingItemIds：垫脚料选谁 ─────────────────────── */
section('③ scaffoldingItemIds —— 垫脚料只认整方块')
{
  const b = bag(itemsOf([['torch', 8], ['oak_sapling', 3], ['stick', 5], ['oak_door', 1],
    ['oak_slab', 12], ['stone', 4], ['cobblestone', 64], ['diamond_block', 1], ['chest', 1], ['coal_ore', 2]]))
  const got = names(scaffoldingItemIds(b))
  ok(JSON.stringify([...got].sort()) === JSON.stringify(['cobblestone', 'stone'].sort()),
    '混装背包只返回 stone + cobblestone', JSON.stringify(got))
  ok(!got.includes('torch') && !got.includes('oak_sapling') && !got.includes('stick'),
    '火把/树苗/木棍 不进垫脚名单')
  ok(!got.includes('oak_door') && !got.includes('oak_slab'),
    '门/半砖 不进垫脚名单')
  ok(!got.includes('diamond_block') && !got.includes('chest') && !got.includes('coal_ore'),
    '钻石块/箱子/煤矿石（家当）不拿去垫')
  ok(got[0] === 'cobblestone', '手里多的排前面（64 个圆石 > 4 个石头）', JSON.stringify(got))

  // 空背包 / 只有垃圾 → 空数组，不抛
  ok(JSON.stringify(scaffoldingItemIds(bag([]))) === '[]', '空背包 → 空数组')
  ok(JSON.stringify(scaffoldingItemIds(bag(itemsOf([['torch', 1], ['stick', 1]])))) === '[]',
    '背包里只有火把和木棍 → 空数组（不硬塞）')
  // 没有 registry 也不炸
  ok(JSON.stringify(scaffoldingItemIds({ inventory: { items: () => itemsOf([['stone', 1]]) } })) === '[]',
    '没有 registry 时不崩，返回空数组')
  // 同一种方块叠在两个格子 → 只留一个 id
  const dup = itemsOf([['dirt', 3], ['dirt', 9]])
  ok(scaffoldingItemIds(bag(dup)).length === 1, '同一种方块占两格 → 只留一个 id',
    JSON.stringify(names(scaffoldingItemIds(bag(dup)))))
}

/* ─────────────────────── ④ pickPlaceItem：没给 name 时挑谁 ─────────────────────── */
section('④ pickPlaceItem —— 没指定方块时不能挑到火把/半砖')
{
  const pick = (spec, want = null) => pickPlaceItem(bag(itemsOf(spec)), want)

  ok(pick([['stick', 1], ['torch', 1], ['oak_sapling', 1], ['oak_slab', 1], ['oak_planks', 4]])?.name === 'oak_planks',
    '背包前几格是木棍/火把/树苗/半砖 → 挑到 oak_planks',
    pick([['stick', 1], ['torch', 1], ['oak_sapling', 1], ['oak_slab', 1], ['oak_planks', 4]])?.name)
  ok(pick([['stick', 1], ['torch', 1]]) === null,
    '背包里只有木棍和火把 → null（旧版会拿火把去搭）')
  ok(pick([['chest', 1], ['diamond_block', 1]]) === null,
    '背包里只有箱子和钻石块 → null（家当不当填充块）')
  ok(pick([['oak_slab', 2]], 'oak_slab')?.name === 'oak_slab',
    '显式给 name:"oak_slab" 就给半砖（AI 点名要的，不拦）')
  ok(pick([['torch', 1]], 'torch')?.name === 'torch',
    '显式给 name:"torch" 就给火把')
  ok(pick([['stone', 1]], 'diamond_block') === null,
    '显式点名但背包里没有 → null')
  ok(pick([]) === null, '空背包 → null')
}

/* ─────────────────────── ⑤ 全量扫描：整方块名单里不能混进形状方块 ─────────────────────── */
section('⑤ 全量扫描 1.21.10 —— 认下来的"整方块"里不能混进半砖/楼梯/栅栏/门…')
{
  // 独立词表（故意和 src/place-items.mjs 里的 NON_FULL_BLOCK 写得不一样，才算交叉验证）
  const SHAPE = /(slab|stairs|_wall$|_fence|_fence_gate$|_carpet$|_pane$|_door$|_trapdoor$|_button$|_pressure_plate$|_sign$|_banner$|_bed$|_rail$|_torch$|_candle$|_bars$|_head$|_skull$|_anvil$|_pot$|_sapling$|^farmland$|^dirt_path$)/
  const accepted = []
  for (const it of Object.values(mcData.items)) {
    const n = it?.name
    if (!n || !mcData.blocksByName[n]) continue
    if (isFullBlockItem(bag([]), n)) accepted.push(n)
  }
  const leaked = accepted.filter((n) => SHAPE.test(n))
  ok(accepted.length > 400, `认下来的整方块有 ${accepted.length} 种（够多，不是空扫）`)
  ok(leaked.length === 0, '没有形状方块混进整方块名单', leaked.slice(0, 8).join('、') || '干净')
  // 反方向：常见建材不能被误杀
  for (const n of ['stone', 'cobblestone', 'oak_planks', 'oak_log', 'dirt', 'sand', 'netherrack']) {
    ok(accepted.includes(n), `${n} 没被误杀`)
  }
}

/* ─────────────────────── ⑥ 接线：这些判据现在住在 src/place-items.mjs ─────────────────────── */
section('⑥ 接线（路线图第 ④ 条第六刀）')
{
  const coreSrc = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const placeSrc = readFileSync(new URL('../src/place-items.mjs', import.meta.url), 'utf8')
  ok(/from '\.\/place-items\.mjs'/.test(coreSrc), 'core.mjs 确实从 place-items.mjs 导入（别只搬不接）')
  ok(/export \{ isFullBlockItem, scaffoldingItemIds, pickPlaceItem \} from '\.\/place-items\.mjs'/.test(coreSrc),
    'core.mjs 保留三个公开件的同名导出（外部 import 一行都不用改）')
  ok(/export const NON_FULL_BLOCK = /.test(placeSrc) && /export const NO_SCAFFOLD = /.test(placeSrc),
    '两份名单在新模块里')
  ok(!/^const NON_FULL_BLOCK = /m.test(coreSrc) && !/^export function pickPlaceItem \(/m.test(coreSrc),
    'core.mjs 里没有残留定义（搬干净了）')
}

/* ─────────────────────── ⑦ 原地搭高：必须先跳起来再放 ─────────────────────── */
/* 用户 2026-10-17 报的「一直尝试放方块」：
 *   `place.mjs` 的"悬空就先垫一块"那一支，落点 = `underFeet.position + (0,1,0)`
 *   = **机器人自己站着的那一格**。站着放，服务端必拒（不把方块放进玩家身体里），
 *   而且那次调用**不在** try/catch 里 ⇒ 英文原文直接冒泡给模型 ⇒ 模型一遍遍重试同一点位。
 * 这一节把"必须先离地"钉死，免得以后又被改回站着放。 */
section('⑦ 原地搭高（垫脚）—— 必须先离地再放')
{
  const placeSrc = readFileSync(new URL('../src/place.mjs', import.meta.url), 'utf8')
  const { placeWhileJumping } = await import('../src/place.mjs')

  // 假 bot：站着时 `position.y` 是整数；按下 jump 之后下一拍才离地（小数部分 ≠ 0）。
  // `placeBlock` 只在离地时成功 —— 照抄服务端的真实行为。
  const makeBot = ({ alwaysRefuse = false } = {}) => {
    const calls = []
    /* 🔴 2026-10-29：`placeWhileJumping()` 现在会**回头看世界**确认方块真出现
     *   （用户：「竖井放置必须确认方块真的出现」），所以假 bot 也得有 `blockAt` 和
     *   "放完那格真的变了"的行为 —— 否则永远判 pending。 */
    const placedCells = new Set()
    const bot = {
      _air: false,
      _jump: false,
      entity: { position: { x: 0.5, y: 20, z: 0.5 } },
      blockAt (p) {
        const k = `${Math.floor(Number(p?.x))},${Math.floor(Number(p?.y))},${Math.floor(Number(p?.z))}`
        return { name: placedCells.has(k) ? 'cobblestone' : 'air', boundingBox: placedCells.has(k) ? 'block' : 'empty' }
      },
      setControlState (k, v) {
        if (k !== 'jump') return
        calls.push(`jump:${v}`)
        this._jump = v
        if (v) setTimeout(() => { if (this._jump) { this._air = true; this.entity.position.y = 20.3 } }, 30)
        else { this._air = false; this.entity.position.y = 20 }
      },
      async placeBlock (r, face) {
        calls.push(this._air ? 'place:air' : 'place:ground')
        if (alwaysRefuse || !this._air) {
          throw new Error('Server refused to place cobblestone at (0,20,0): the block is still air')
        }
        const base = r?.position ?? r
        const k = `${Math.floor(Number(base.x) + Number(face.x))},${Math.floor(Number(base.y) + Number(face.y))},${Math.floor(Number(base.z) + Number(face.z))}`
        placedCells.add(k)   // 服务端放上了 ⇒ 世界真的变
      },
      lookAt: async () => {},
    }
    const ref = { name: 'cobblestone', boundingBox: 'block', position: { x: 0, y: 19, z: 0 } }
    return { bot, calls, ref }
  }

  // ① 站着会拒、跳起来能成：一次调用就够
  {
    const { bot, calls, ref } = makeBot()
    let err = null
    try { await placeWhileJumping(bot, ref, { x: 0, y: 1, z: 0 }) } catch (e) { err = e }
    ok(err == null, '跳起来之后放成功了（不再报"the block is still air"）', err ? String(err.message).slice(0, 60) : '')
    ok(calls[0] === 'jump:true', '第一件事是把 jump 按下去（不是先放）', `calls=${calls.join(',')}`)
    ok(calls.includes('place:air'), '🔴 真正发包那一刻是**离地**的', `calls=${calls.join(',')}`)
    ok(calls[calls.length - 1] === 'jump:false', '放完把 jump 松开（别一直蹦）', `calls=${calls.join(',')}`)
  }
  // ② 服务端一直拒 ⇒ 抛错，但 jump 必须已经松开（finally）
  {
    const { bot, calls, ref } = makeBot({ alwaysRefuse: true })
    let err = null
    try { await placeWhileJumping(bot, ref, { x: 0, y: 1, z: 0 }, { tries: 2 }) } catch (e) { err = e }
    ok(err != null && /refused/i.test(String(err?.message ?? '')), '一直拒 ⇒ 抛出来（不假装成功）')
    ok(calls[calls.length - 1] === 'jump:false', '🔴 抛错也必须松开 jump（finally —— 别把控制位留在按下状态）', `calls=${calls.join(',')}`)
    ok(calls.filter((c) => c === 'place:air').length >= 2, '会重试（不是试一次就放弃）', `calls=${calls.join(',')}`)
  }
  // ③ 静态：垫脚那一支必须走 placeWhileJumping，且失败要被抓住
  ok(/placeWhileJumping\(b, underFeet, \{ x: 0, y: 1, z: 0 \}\)/.test(placeSrc),
    '垫脚那一放走的是 placeWhileJumping（先跳再放）')
  ok(!/await ctx\.t\(b\.placeBlock\(underFeet/.test(placeSrc),
    '🔴 不再站着往自己脚下放（那正是用户报的"一直尝试放方块"）')
  ok(/catch \(e\) \{ padError = e \}/.test(placeSrc),
    '垫脚失败被抓住（原来是裸 await，英文原文直接冒泡给模型）')
  ok(/别再对着同一个点位试了/.test(placeSrc),
    '失败提示明说"别再对着同一个点位试"（防模型原地重试）')
  ok(/Server refused to place/.test(placeSrc) && /服务端拒了在/.test(placeSrc),
    '英文 "Server refused to place" 仍然翻译成人话（且带上坐标）')
  ok(/export async function placeWhileJumping/.test(placeSrc), 'placeWhileJumping 是导出的（可单测）')
ok(/const waitMs = inWater \? 2500 : 700/.test(placeSrc), '水里等脚离格放宽到 2.5 秒（上浮比陆上跳慢）')
}

/* ─────────────────────── ⑧ 目标格 = 自己站的那一格 ⇒ 跳起来放 ─────────────────────── */
/* 用户 2026-10-17 实机（游戏里 AI 的原话）：
 *   「mc_act {mode:"place"} 放不了自己脚下，经典 pillar-jump 做不成，
 *     这是我在竖井里爬不上去、反复淹死的直接原因」
 *   「既然寻路器能往自己脚下放，说明服务端是收的 —— 被挡的是 mc_act place 自己那层预检」
 * ⇒ 目标格正是自己身体占着的那一格（脚下 / 齐腰）时必须**跳起来再放**。
 *   水/岩浆能过 `canPlaceInto` 那一关，所以以前是"预检放行、服务端拒"，报的还是英文原文。 */
section('⑧ 目标格 = 自己站的那一格 —— 必须跳起来放（pillar-jump）')
{
  const { placeBlock } = await import('../src/place.mjs')
  const V = (x, y, z) => ({
    x, y, z,
    offset (dx, dy, dz) { return V(x + dx, y + dy, z + dz) },
    floored () { return V(Math.floor(x), Math.floor(y), Math.floor(z)) },
    plus (o) { return V(x + o.x, y + o.y, z + o.z) },
    distanceTo (o) { return Math.hypot(x - o.x, y - o.y, z - o.z) },
  })
  /* 假 bot：站着时 `position.y` 是整数；按下 jump 之后才离地（照抄服务端"不放方块进玩家身体"的行为）。 */
  const makeSelf = ({ world = {}, refuseAlways = false } = {}) => {
    const calls = []
    const W = new Map(Object.entries(world))
    const at = (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const blk = W.get(k) ?? { name: 'air', boundingBox: 'empty' }
      return { position: V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), ...blk }
    }
    const bot = {
      _air: false, _jump: false,
      game: { gameMode: 'survival' },
      entity: { position: { x: 0.5, y: 20, z: 0.5, floored () { return V(0, Math.floor(this.y), 0) } }, eyeHeight: 1.62 },
      inventory: { items: () => [{ name: 'cobblestone', type: 1, count: 64 }] },
      blockAt: (p) => at(p),
      setControlState (k, v) {
        if (k !== 'jump') return
        calls.push(`jump:${v}`)
        this._jump = v
        if (v) setTimeout(() => { if (this._jump) { this._air = true; this.entity.position.y = 20.3 } }, 25)
        else { this._air = false; this.entity.position.y = 20 }
      },
      async equip () { calls.push('equip') },
      async lookAt () {},
      async placeBlock (ref, face) {
        // 落点 = ref.position + face（照 mineflayer 的算法）
        const dest = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
        // 服务端只在"落点是自己身体占着的那一格"时才拒（别的格子站着放照样能成）
        const ownCell = dest.x === 0 && dest.z === 0 && (dest.y === 20 || dest.y === 21)
        calls.push(this._air ? 'place:air' : 'place:ground')
        if (refuseAlways || (ownCell && !this._air)) {
          throw new Error('Server refused to place cobblestone at (0,20,0): the block is still air')
        }
        W.set(`${dest.x},${dest.y},${dest.z}`, { name: 'cobblestone', boundingBox: 'block' })
      },
    }
    const self = { requireBot: () => bot, walkTo: async () => { calls.push('walkTo') }, flyTo: async () => {}, giveItem: async () => {} }
    return { self, bot, calls }
  }
  const ctx = { t: (p) => p }

  // ① 目标 = 自己脚下那一格 ⇒ 走"跳起来放"
  {
    const { self, calls } = makeSelf({ world: { '0,19,0': { name: 'stone', boundingBox: 'block' }, '0,20,0': { name: 'water', boundingBox: 'empty' } } })
    const r = await placeBlock(self, { x: 0, y: 20, z: 0, name: 'cobblestone' }, ctx)
    ok(r.placed === 'cobblestone', '放到自己脚下那一格（水格）成功了', JSON.stringify({ placed: r.placed, now: r.now }))
    ok(calls.includes('jump:true'), '🔴 先跳起来（不是站着就往自己身体里放）', `calls=${calls.join(',')}`)
    ok(calls.includes('place:air'), '🔴 真正发包那一刻是**离地**的', `calls=${calls.join(',')}`)
    ok(!calls.includes('place:ground'), '没有一次"站着放"（那必被服务端拒）', `calls=${calls.join(',')}`)
    ok(r.pillar === true, '结果里报 pillar:true（模型才知道自己刚垫高了一格）', JSON.stringify({ pillar: r.pillar }))
    ok(/被垫高了 1 格/.test(r.pillarNote ?? ''), '并且明说"被垫高了 1 格、现在 y 多少"（2026-10-24 用户实机）', String(r.pillarNote ?? '').slice(0, 120))
  }
  // ② 目标 = 齐腰那一格（身体也占着）⇒ 同样要跳
  {
    const { self, calls } = makeSelf({ world: { '0,20,0': { name: 'stone', boundingBox: 'block' }, '0,21,0': { name: 'water', boundingBox: 'empty' } } })
    const r = await placeBlock(self, { x: 0, y: 21, z: 0, name: 'cobblestone' }, ctx)
    ok(r.placed === 'cobblestone' && calls.includes('place:air'), '齐腰那一格也走"跳起来放"', `calls=${calls.join(',')} placed=${r.placed}`)
  }
  // ③ 目标**不是**自己占着的格子 ⇒ 照旧站着放（别把普通放置也搞成蹦蹦跳跳）
  {
    const { self, calls } = makeSelf({ world: { '0,19,0': { name: 'stone', boundingBox: 'block' }, '1,19,0': { name: 'stone', boundingBox: 'block' }, '1,20,0': { name: 'air', boundingBox: 'empty' } } })
    const r = await placeBlock(self, { x: 1, y: 20, z: 0, name: 'cobblestone' }, ctx)
    ok(r.placed === 'cobblestone', '旁边那一格照常放成功', JSON.stringify({ placed: r.placed }))
    ok(!calls.includes('jump:true') && !calls.includes('place:air'), '🔴 普通放置**不跳**（只在自己身上才跳）', `calls=${calls.join(',')}`)
    ok(r.pillar === undefined, '普通放置不带 pillar 标记', JSON.stringify({ pillar: r.pillar }))
  }
  // ④ 跳了还是被拒 ⇒ 提示必须点明"那一格是我自己占着的"
  {
    const { self } = makeSelf({
      refuseAlways: true,
      world: { '0,19,0': { name: 'stone', boundingBox: 'block' }, '0,20,0': { name: 'water', boundingBox: 'empty' } },
    })
    let err = null
    try { await placeBlock(self, { x: 0, y: 20, z: 0, name: 'cobblestone' }, ctx) } catch (e) { err = e }
    ok(err != null && /我自己身体占着/.test(String(err?.message ?? '')), '被拒时说清"那一格是我自己身体占着的"', String(err?.message ?? '').slice(0, 90))
    ok(/跳起来放/.test(String(err?.message ?? '')), '并说明"已经试过跳起来放"（别让模型以为是没跳）', String(err?.message ?? '').slice(0, 120))
  }
  // ⑤ 静态：判据 + 分支都在
  const placeSrc2 = readFileSync(new URL('../src/place.mjs', import.meta.url), 'utf8')
  ok(/const isOwnCell = Boolean\(feetNow\)/.test(placeSrc2), 'place.mjs 里有 isOwnCell 判据')
  ok(/pos\.y === feetNow\.y \|\| pos\.y === feetNow\.y \+ 1/.test(placeSrc2), '脚下与齐腰两格都算"自己占着"')
  ok(/if \(isOwnCell\) await ctx\.t\(placeWhileJumping/.test(placeSrc2), '自己占着的那一格走 placeWhileJumping')
}


  /* ⑥ 船 / 矿车 / 刷怪蛋 / 盔甲架 = **实体**，不是方块（2026-10-20 用户报的「船放不出来」）
   *   mineflayer 的 `place_entity.js`：先 `_genericPlace()` 告诉服务端"对着哪一格用"，
   *   **再补发一个 `use_item` 包**，最后等 `entitySpawn`。少发那个包 ⇒ 服务端当"空手右键"。 */
  section('⑥ 实体物品（船/矿车/刷怪蛋）走 placeEntityItem，不再当方块放')
  {
    const { isEntityItem } = await import('../src/block-names.mjs')
    ok(isEntityItem('oak_boat'), 'oak_boat 是实体物品')
    ok(isEntityItem('birch_chest_boat'), '带箱子的船是实体物品')
    ok(isEntityItem('minecart'), '矿车是实体物品')
    ok(isEntityItem('zombie_spawn_egg'), '刷怪蛋是实体物品')
    ok(!isEntityItem('cobblestone'), '圆石不是实体物品')
    ok(!isEntityItem('oak_door'), '门不是实体物品（它是方块）')
    const { placeEntityItem } = await import('../src/place.mjs')
    const calls = []
    const writes = []
    const mkEnt = (id, x) => ({ id, name: 'oak_boat', position: { x, y: -60, z: 0.5, distanceTo: (p) => Math.hypot(x - p.x, -60 - p.y, 0.5 - p.z) } })
    const mkBot = (spawn) => {
      const b = {
        entity: { position: { x: 0.5, y: -60, z: 0.5, distanceTo: () => 3 }, eyeHeight: 1.62 },
        game: { gameMode: 'survival' },
        heldItem: { name: 'oak_boat', count: 1 },
        inventory: { items: () => [{ name: 'oak_boat', count: 1, slot: 36 }] },
        entities: {},
        blockAt: () => ({ name: 'water', boundingBox: 'empty' }),
        equip: async () => { calls.push('equip') },
        _genericPlace: async () => { calls.push('genericPlace'); if (spawn) b.entities[9] = mkEnt(9, 3.5) },
        _client: { write: (n, p) => writes.push([n, p]) },
        supportFeature: () => true,
        lookAt: async () => {},
      }
      return b
    }
    const self = (b) => ({ requireBot: () => b, giveItem: async () => {} })
    const ctx2 = { t: (p) => p }
    const r1 = await placeEntityItem(self(mkBot(true)), { x: 3, y: -60, z: 0 }, ctx2)
    ok(calls.includes('genericPlace'), '先「对着这一格用」（服务端靠它算落点）')
    ok(!writes.some(([n]) => n === 'use_item'), '**不**补发 use_item（现代协议缺 sequence/rotation，写残了会被踢）')
    ok(r1.placed === true && r1.entity === 'oak_boat', '放了之后复核到船实体（placed:true）', JSON.stringify(r1.at ?? {}))
    ok(/mode:"use"/.test(String(r1.hint ?? '')), '提示怎么上船')
    writes.length = 0
    const r2 = await placeEntityItem(self(mkBot(false)), { x: 3, y: -60, z: 0 }, ctx2)
    ok(r2.placed === false, '实体没出现 ⇒ placed:false（不许报假成功）')
    ok(/没看到新实体/.test(String(r2.hint ?? '')), '并说清"没看到新实体"的常见原因')
    const placeSrc3 = readFileSync(new URL('../src/place.mjs', import.meta.url), 'utf8')
    ok(/if \(want && isEntityItem\(want\)\)/.test(placeSrc3), 'placeBlock 先把实体物品分流出去')
    ok(!/^\s*b\._client\.write\('use_item'/m.test(placeSrc3), 'place.mjs 里没有 use_item 那半包（踩坑 #216）')
    const useSrc = readFileSync(new URL('../src/world-use.mjs', import.meta.url), 'utf8')
    ok(/isEntityItem\(item\.name\)/.test(useSrc), 'useitem 对船/蛋会提示改用 place（别让人以为再按一次就好）')
  }

/* ── ⑨ 跳起放置不许挂死（2026-10-23 实机：一条 mc_move 挂了 208 秒，同一个毛病） ── */
section('⑨ 跳起放置有上限（placeBlock 不回包也要按时放弃）')
{
  const placeSrc9 = readFileSync(new URL('../src/place.mjs', import.meta.url), 'utf8')
  const { placeWhileJumping } = await import('../src/place.mjs')
  const { PLACE_TIMEOUT_MS } = await import('../src/place.mjs')
  ok(/export const PLACE_TIMEOUT_MS = \d/.test(placeSrc9), '有明确的上限常量 PLACE_TIMEOUT_MS')
  ok(/Promise\.race\(\s*\[\s*\s*Promise\.resolve\(b\.placeBlock/.test(placeSrc9),
    '跳起放置走 Promise.race（placeBlock 要等服务端回包，不回就永不 settle）')
  ok(PLACE_TIMEOUT_MS > 0 && PLACE_TIMEOUT_MS <= 5000, '上限是个合理的短数字（不是几十秒）', String(PLACE_TIMEOUT_MS))
  /* 行为：placeBlock 永不 settle 时，placeWhileJumping 必须按时抛出而不是挂着 */
  {
    const hangBot = {
      entity: { position: { x: 0.5, y: 20.3, z: 0.5 } },   // 已经在空中 ⇒ 不等"离地"
      setControlState: () => {},
      placeBlock: () => new Promise(() => {}),
      lookAt: async () => {},
    }
    const ref = { name: 'cobblestone', boundingBox: 'block', position: { x: 0, y: 19, z: 0 } }
    const t0 = Date.now()
    let threw = null
    try { await placeWhileJumping(hangBot, ref, { x: 0, y: 1, z: 0 }, { tries: 1 }) } catch (e) { threw = e }
    const ms = Date.now() - t0
    ok(ms < PLACE_TIMEOUT_MS + 2000, '🔴 不回包也有上限（按时放弃，不是挂死）', String(ms) + 'ms')
    ok(threw != null && /没回包/.test(String(threw?.message ?? '')), '抛的是人话（说清是服务端没回包）', String(threw?.message).slice(0, 40))
  }
}
section('⑨ 传送门旁边不放方块（用户 2026-10-25 实机：会在框架上垫石头搭到门上方再挖掉）')
{
  const { placeBlock } = await import('../src/place.mjs')
  const V = (x, y, z) => ({
    x, y, z,
    offset (dx, dy, dz) { return V(x + dx, y + dy, z + dz) },
    floored () { return V(Math.floor(x), Math.floor(y), Math.floor(z)) },
    plus (o) { return V(x + o.x, y + o.y, z + o.z) },
    distanceTo (o) { return Math.hypot(x - o.x, y - o.y, z - o.z) },
  })
  /* 假 bot：世界表里 `end_portal` 就是门；`placeBlock` 记一次调用（拦不拦就看它有没有被调到）。 */
  const makeSelf = (world) => {
    const calls = []
    const W = new Map(Object.entries(world))
    const at = (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const blk = W.get(k) ?? { name: 'air', boundingBox: 'empty' }
      return { position: V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), ...blk }
    }
    const bot = {
      game: { gameMode: 'survival' },
      entity: { position: { x: 0.5, y: 20, z: 0.5, floored () { return V(0, 20, 0) } }, eyeHeight: 1.62 },
      inventory: { items: () => [{ name: 'cobblestone', type: 1, count: 64 }] },
      blockAt: (p) => at(p),
      setControlState () {},
      async equip () { calls.push('equip') },
      async lookAt () {},
      async placeBlock (ref, face) {
        calls.push('place')
        const dest = { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }
        W.set(`${dest.x},${dest.y},${dest.z}`, { name: 'cobblestone', boundingBox: 'block' })
      },
    }
    const self = { requireBot: () => bot, walkTo: async () => {}, flyTo: async () => {}, giveItem: async () => {} }
    return { self, calls }
  }
  const ctx = { t: (p) => p }
  const GROUND = { '0,19,0': { name: 'stone', boundingBox: 'block' } }
  // ① 目标紧邻末地门 ⇒ 直接拒，且**一次都没真去放**
  {
    const { self, calls } = makeSelf({ ...GROUND, '1,20,0': { name: 'end_portal', boundingBox: 'empty' }, '1,19,0': { name: 'stone', boundingBox: 'block' } })
    const r = await placeBlock(self, { x: 0, y: 20, z: 0, name: 'cobblestone' }, ctx)
    ok(r.placed === false && r.blockedBy === 'portal', '紧邻末地门：不放，blockedBy=portal', JSON.stringify({ placed: r.placed, blockedBy: r.blockedBy }))
    ok(!calls.includes('place'), '🔴 一次 placeBlock 都没发（不是放失败才回滚）', `calls=${calls.join(',')}`)
    ok(/不放方块/.test(String(r.hint ?? '')) && /mc_move/.test(String(r.hint ?? '')), '提示说清：不放方块、要进就 mc_move 走到门那格', String(r.hint ?? '').slice(0, 100))
  }
  // ② 下界门同理
  {
    const { self, calls } = makeSelf({ ...GROUND, '0,20,1': { name: 'nether_portal', boundingBox: 'empty' } })
    const r = await placeBlock(self, { x: 0, y: 20, z: 0, name: 'cobblestone' }, ctx)
    ok(r.placed === false && r.blockedBy === 'portal' && !calls.includes('place'), '紧邻下界门：同样拦', JSON.stringify({ placed: r.placed, blockedBy: r.blockedBy }))
  }
  // ③ 门在 2 格外 ⇒ 照常放（别把门旁正常建造也误伤）
  {
    const { self, calls } = makeSelf({ ...GROUND, '0,19,2': { name: 'stone', boundingBox: 'block' }, '0,20,2': { name: 'end_portal', boundingBox: 'empty' } })
    const r = await placeBlock(self, { x: 1, y: 20, z: 0, name: 'cobblestone' }, ctx)
    ok(r.placed === 'cobblestone' && calls.includes('place'), '门在 2 格外：照常放（不误伤）', JSON.stringify({ placed: r.placed }))
  }
  // ④ 框架方块本身**不是**门 ⇒ 不拦（`end_portal_frame` 是框，站上去放垫脚石是正常操作）
  {
    const { self, calls } = makeSelf({ ...GROUND, '1,20,0': { name: 'end_portal_frame', boundingBox: 'block' }, '1,19,0': { name: 'stone', boundingBox: 'block' } })
    const r = await placeBlock(self, { x: 0, y: 20, z: 0, name: 'cobblestone' }, ctx)
    ok(r.placed === 'cobblestone' && calls.includes('place'), '只认传送门方块名，框架不算门', JSON.stringify({ placed: r.placed }))
  }
}

/* ── ⑤ 放置后必须回头确认方块真的出现（用户 2026-10-29）── */
/* 「要区分三种情况：服务器尚未确认、放置请求被拒绝、方块实际已经出现但客户端没及时收到结果」。 */
{
  const { confirmPlaced, isPlaceRefused, placeConfirmText } = await import('../src/place.mjs')
  const mk = (names) => {
    let i = 0
    return {
      blockAt: () => ({ name: names[Math.min(i++, names.length - 1)] }),
    }
  }

  /* ① 世界已经出现 ⇒ appeared（哪怕回包丢了也算成功） */
  {
    const c = await confirmPlaced(mk(['cobblestone']), { x: 0, y: 20, z: 0 }, { name: 'cobblestone', waitMs: 200 })
    ok(c.state === 'appeared' && c.got === 'cobblestone', '方块真出现了 ⇒ appeared（回包慢也算成功）', JSON.stringify(c))
  }
  /* ② 一直空 ⇒ pending（说清等了多久、那格现在是什么） */
  {
    const c = await confirmPlaced(mk(['air']), { x: 0, y: 20, z: 0 }, { name: 'cobblestone', waitMs: 200, stepMs: 50 })
    ok(c.state === 'pending' && c.got === 'air', '一直没出现 ⇒ pending（不是"失败"，是"没确认"）', JSON.stringify(c))
    ok(/还没确认/.test(placeConfirmText(c)), 'pending 的文案说清"服务端还没确认、方块也没出现"', placeConfirmText(c))
  }
  /* ③ 那格原本就是 water ⇒ 不许当成"放上了" */
  {
    const c = await confirmPlaced(mk(['water']), { x: 0, y: 20, z: 0 }, { before: 'water', waitMs: 150, stepMs: 50 })
    ok(c.state === 'pending', '🔴 原本就是水/草的可替换格：没变过就不算放上（以前会误报成功）', JSON.stringify(c))
    const c2 = await confirmPlaced(mk(['stone']), { x: 0, y: 20, z: 0 }, { before: 'water', waitMs: 150 })
    ok(c2.state === 'appeared', '真变了（水 → 石头）⇒ appeared', JSON.stringify(c2))
  }
  /* ④ 期望名字对不上 ⇒ 不算 */
  {
    const c = await confirmPlaced(mk(['dirt']), { x: 0, y: 20, z: 0 }, { name: 'cobblestone', waitMs: 150, stepMs: 50 })
    ok(c.state === 'pending', '放的是圆石、那格是泥土 ⇒ 不算放上', JSON.stringify(c))
  }
  /* ⑤ 拒绝的识别 + 文案三态 */
  ok(isPlaceRefused(new Error('Server refused to place cobblestone at (0,20,0): the block is still air')), '识别 "Server refused to place"')
  ok(!isPlaceRefused(new Error('放方块 2500ms 没回包（服务端没理）')), '没回包 ≠ 拒绝（要分开判）')
  ok(/服务端明确拒绝/.test(placeConfirmText({ state: 'refused', waitedMs: 10, got: 'air' })), 'refused 的文案说"明确拒绝"')
  ok(/已确认出现/.test(placeConfirmText({ state: 'appeared', waitedMs: 10, got: 'cobblestone' })), 'appeared 的文案说"已确认出现"')

  /* ⑥ 源码：跳放那条路回包成功也要复核；拒绝要继续重试而不是一次就罢手 */
  const ps = await (await import('node:fs/promises')).readFile(new URL('../src/place.mjs', import.meta.url), 'utf8')
  ok(/await confirmPlaced\(b, target, \{ name: want, before, waitMs: 600 \}\)/.test(ps), '跳放：回包成功之后还复核一次世界（幽灵方块）')
  ok(/await confirmPlaced\(b, target, \{ name: want, before, waitMs: 900 \}\)/.test(ps), '跳放：没回包时先看世界再判失败')
  ok(/if \(isPlaceRefused\(e\)\)/.test(ps), '明确拒绝单独记账（state:"refused"）')
  ok(!/throw new Error\(`服务端明确拒绝放置/.test(ps), '明确拒绝也继续重试剩下的次数（不是一次就放弃）')
}

/* ─────────── 批 C（2026-11-02 审计）：变体归一 / before 别丢 / 抬不到就别放 ─────────── */
section('🧱 放置确认的三条硬要求（变体、放置前状态、跳跃窗口）')
{
  const ps = readFileSync(new URL('../src/place.mjs', import.meta.url), 'utf8')
  ok(/const chip = \(s2\)/.test(ps) && /const okName = want \? chip\(got\) === want/.test(ps),
    'confirmPlaced 比的是"同一种方块"：两边都去掉 wall_（火把贴墙变 wall_torch 也算成功）')
  ok(/before: beforeAt/.test(ps) && /beforeAt = tgt \? \(b\.blockAt\(tgt, false\)\?\.name \?\? null\) : null/.test(ps),
    '普通放置复核时带上"放置前那格是什么"（否则手里空时判据退化成"非空即成功"）')
  ok(/const roseAtAll = Number\.isFinite\(bestRise\) && bestRise > 0\.05/.test(ps)
    && /if \(!reached && roseAtAll && bestRise < needRise - 0\.15\)/.test(ps),
    '跳不到放置窗口就不发那一次包（差得多先重跳，别白放 + 白等两次复核）')
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
