#!/usr/bin/env node
/**
 * check-core-equip.mjs —— "动手前换上对的工具 + 动手后如实报手上是什么"的回归检查
 *
 * 背景（用户 2026-10-07 原话）：
 *   「搭路以后ai不知道手里的东西是什么，刚刚它拿镐子搭完以后它不知道，在用泥土挖石头」
 *
 * 实机现场（插件日志 + 会话转写）：机器人从矿底**垫方块爬回地面**，手上还攥着 `dirtx18`，
 * 接着对石头连发 6 次 `mc_act{mode:"break"}` ——
 *   `⚠️ 破坏 stone 这一轮的时间用完了（还剩 5000ms） → 已松控制位，标记为可能失步`
 * 徒手（拿着泥土）挖石头要 **7.5 秒**，比一轮预算还长 ⇒ 每次都超时；而工具只回一句
 * "方块还在（stone）——服务端可能拒了这次破坏"，模型根本看不出问题在哪，
 * 直到玩家在游戏里问「怎么用手挖方块」它才反应过来要换镐子。
 *
 * 这个脚本把四件事钉死：
 *   ① `mc_act{mode:"break"}` 动手前**必须换到对的工具**（背包里有的话），并如实报 `tool`/`held`；
 *   ② 换不上（背包里也没有）就**别硬挖**，直接说清"手上是 X、挖它需要镐子"，不许白花一轮；
 *   ③ 挖不动时别把原因赖给"服务端拒绝"，要按 `digTime` 说"这块按手上的东西要 N 秒"；
 *   ④ `mc_build` / `mc_move`（垫路）要带上 `used` / `pillaredWith` / `held` ——
 *      "搭完手里还剩什么"是模型最容易失步的一条。
 *
 * 用法：node tools/check-core-equip.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
/** 断言"不许出现某种写法"之前必须剥注释 —— 注释里正是拿这些反面写法当例子 */
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// ── 借依赖：源码树里没有 node_modules，从包目录借 vec3 ────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
import { equipFor, toolTierOf } from '../src/inventory.mjs'

const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,                  // 包内直接就有
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),      // 源码树 → 借包里的
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑，')
  console.log('  或确认已安装 mineflayer。')
  process.exit(2)
}
const Vec3 = req('vec3')
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (fake) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-equip-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = fake.bot
  mc.mcPlugins = fake.bot.tool ? { tool: true } : {}
  mc.pfReady = true
  mc._pf = {
    goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    Movements: class { constructor() {} },
  }
  mc.cfg.moveBudgetMs = 2000
  return mc
}

/**
 * 假 bot：石头在 (0,64,0)，手上拿着 `held`，背包 `bag` 里有别的。
 * `tool.equipForBlock` 照真 mineflayer-tool 的语义：按 `block.harvestTools` 在背包里找一把换到手上。
 */
const mkBot = ({ held = { name: 'dirt', type: 3, count: 18 }, bag = [{ name: 'iron_pickaxe', type: 2, count: 1 }],
  digResolves = true, digTime = 300, withToolPlugin = true, withPathfinder = false } = {}) => {
  const calls = { seq: [], equip: 0, equipForBlock: 0, dig: 0, goto: 0, stop: 0 }
  const state = { broken: false }
  const pos = new Vec3(0, 64, 0)
  const harvestTools = { 1: true, 2: true, 3: true }        // 木镐 / 铁镐 / 石镐
  const block = { name: 'stone', type: 1, boundingBox: 'block', position: pos.clone(), harvestTools }
  const air = { name: 'air', type: 0, boundingBox: 'empty', position: pos.clone() }
  let bagItems = bag.map((i) => ({ ...i }))
  const handlers = {}

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    game: { gameMode: 'survival' },
    registry: {
      items: { 1: { name: 'wooden_pickaxe' }, 2: { name: 'iron_pickaxe' }, 3: { name: 'stone_pickaxe' } },
      itemsByName: {}, blocksByName: {},
    },
    heldItem: held,
    // 真 mineflayer 的语义：`inventory.items()` 里**手上那一格也在内**
    inventory: { items: () => [...(bot.heldItem ? [bot.heldItem] : []), ...bagItems] },
    blockAt: (p) => (p && p.x === 0 && p.y === 64 && p.z === 0 ? (state.broken ? air : block) : null),
    digTime: () => digTime,
    dig: () => {
      calls.dig++; calls.seq.push('dig')
      if (!digResolves) return new Promise(() => {})        // 永远不 resolve：模拟"挖不动"
      state.broken = true
      return Promise.resolve()
    },
    equip: async (it) => { calls.equip++; calls.seq.push(`equip:${it.name}`); bot.heldItem = it },
    setControlState: () => {},
    on: (ev, fn) => { handlers[ev] = fn; return bot },
    removeListener: () => {},
  }
  if (withToolPlugin) {
    bot.tool = {
      equipForBlock: async (blk) => {
        calls.equipForBlock++; calls.seq.push('equipForBlock')
        const best = bagItems.find((i) => blk?.harvestTools?.[i.type])
        if (!best) return                                              // 换不上：真插件这时会 throw，这里留着不动
        bagItems = bagItems.filter((i) => i !== best)
        bot.heldItem = best
      },
    }
  }
  if (withPathfinder) {
    bot.pathfinder = {
      setMovements: () => {},
      stop: () => { calls.stop++ },
      goto: async () => {
        calls.goto++
        // 垫 3 块：块更新事件 + 背包少 3 块 + 手上从 10 变 7
        for (let i = 0; i < 3; i++) handlers.blockUpdate?.({ boundingBox: 'empty' }, { boundingBox: 'block' })
        bagItems[0].count -= 3
        bot.heldItem = { ...bagItems[0] }
        bot.entity.position = new Vec3(0, 64, 4)               // 走到目标点
      },
    }
  }
  return { bot, calls, state, block, handlers }
}

/* ─────────── ① 手上攥着泥土挖石头：先换镐子，再动手 ─────────── */
section('① 手上是泥土、背包里有铁镐 ⇒ 自动换上再挖，并如实报换了什么')
{
  const fake = mkBot({ held: { name: 'dirt', type: 4, count: 18 } })
  const mc = mkMc(fake)
  const r = await mc.breakBlock({ x: 0, y: 64, z: 0 })
  ok(fake.calls.equipForBlock === 1, '动手前问了 mineflayer-tool 一次（equipForBlock）', `calls=${fake.calls.equipForBlock}`)
  ok(fake.calls.seq.indexOf('equipForBlock') < fake.calls.seq.indexOf('dig'),
    '换工具发生在 dig **之前**', `seq=${fake.calls.seq.join(' → ')}`)
  ok(r?.broken === 'stone', '挖掉了', JSON.stringify(r))
  ok(r?.held === 'iron_pickaxex1', '结果里带 held（现在手上是什么）', String(r?.held))
  ok(/dirtx18/.test(r?.tool ?? '') && /iron_pickaxex1/.test(r?.tool ?? ''),
    'tool 里写清 dirtx18 → iron_pickaxex1', String(r?.tool))
  ok(r?.digMs === 300, '带 digMs（按手上的东西算要挖多久）', String(r?.digMs))
}

/* ─────────── ② 背包里也没有能挖的：拒绝，别白花一轮 ─────────── */
section('② 手上是泥土、背包里也没有镐子 ⇒ 拒绝动手，说清"需要镐子"')
{
  const fake = mkBot({ held: { name: 'dirt', type: 4, count: 18 }, bag: [{ name: 'oak_log', type: 5, count: 3 }] })
  const mc = mkMc(fake)
  let err = null
  try { await mc.breakBlock({ x: 0, y: 64, z: 0 }) } catch (e) { err = e }
  const msg = String(err?.message ?? '')
  ok(Boolean(err), '抛错（如实拒绝）', msg.slice(0, 90))
  ok(fake.calls.dig === 0, '**没有**去挖（不白花一轮）', `dig=${fake.calls.dig}`)
  ok(/dirtx18/.test(msg), '说清手上是什么', msg.slice(0, 90))
  ok(/需要镐/.test(msg), '说清挖 stone 需要镐子', msg.slice(0, 120))
  ok(/硬挖会一直超时/.test(msg), '说清硬挖的后果', msg.slice(0, 120))
}

/* ─────────── ③ 手上已经是对的工具：不白调 equipForBlock ─────────── */
section('③ 手上已经拿着镐子 ⇒ 不白换工具，照常挖')
{
  const fake = mkBot({ held: { name: 'iron_pickaxe', type: 2, count: 1 } })
  const mc = mkMc(fake)
  const r = await mc.breakBlock({ x: 0, y: 64, z: 0 })
  ok(fake.calls.equipForBlock === 0 && fake.calls.equip === 0, '一次换工具都没调',
    `equipForBlock=${fake.calls.equipForBlock} equip=${fake.calls.equip}`)
  ok(r?.broken === 'stone', '照常挖掉', JSON.stringify(r))
  ok(r?.tool === undefined, '没换过就不报 tool（省 token）', String(r?.tool))
}

/* ─────────── ④ 时间不够就别开始挖；真挖不动也别赖"服务端拒绝" ─────────── */
section('④ 时间不够 ⇒ **一个挖矿包都不发**（进度清零白费）；真挖不动 ⇒ 按 digTime 说实话')
{
  // ④a 这一轮只剩 700ms、这块要 7.5 秒 ⇒ 别开始（用户 2026-10-08 原话"快挖完的时候会重置"）
  const fake = mkBot({ held: { name: 'iron_pickaxe', type: 2, count: 1 }, bag: [], digResolves: false, digTime: 7500 })
  const mc = mkMc(fake)
  mc.setCallDeadline(700)                     // 别真等 11 秒
  const t0 = Date.now()
  const r = await mc.breakBlock({ x: 0, y: 64, z: 0 })
  const ms = Date.now() - t0
  ok(ms < 1000, '立刻返回（没开始挖就不用等）', `${ms}ms`)
  ok(fake.calls.dig === 0, '**一个挖矿包都没发**（`b.dig` 没被调用）', `dig=${fake.calls.dig}`)
  ok(r?.broken === false, '如实报 broken=false', JSON.stringify(r))
  ok(/没开始挖/.test(r?.note ?? ''), 'note 说清"我没开始挖"', String(r?.note).slice(0, 90))
  ok(/进度会清零/.test(r?.note ?? ''), 'note 说清"挖一半到点松手，破坏进度会清零"', String(r?.note).slice(0, 130))
  ok(r?.digMs === 7500, '带 digMs（这块按手上的东西要几毫秒）', String(r?.digMs))
  ok(r?.held === 'iron_pickaxex1', 'note 之外也带 held', String(r?.held))
  ok(!/服务端可能拒/.test(r?.note ?? ''), '**不**赖"服务端可能拒了这次破坏"', String(r?.note).slice(0, 120))

  // ④b 时间够（这块只要 0.3 秒），但服务端就是不给 ack ⇒ 只能超时；文案按 digTime 说实话
  const fake2 = mkBot({ held: { name: 'iron_pickaxe', type: 2, count: 1 }, bag: [], digResolves: false, digTime: 300 })
  const mc2 = mkMc(fake2)
  mc2.setCallDeadline(2000)
  const t1 = Date.now()
  const r2 = await mc2.breakBlock({ x: 0, y: 64, z: 0 })
  const ms2 = Date.now() - t1
  ok(fake2.calls.dig === 1, '时间够就开始挖（`b.dig` 调了一次）', `dig=${fake2.calls.dig}`)
  ok(ms2 < 4000, '到点就返回（没有一直挂着）', `${ms2}ms`)
  ok(r2?.broken === false, '如实报 broken=false', JSON.stringify(r2))
  /* 🔴 2026-10-15 审计（报告 F 第 2 条）：超时文案以前写"还没挖掉" —— 那三个字会先命中
   *    任务台账里"明确失败"的正则，于是"这一轮时间到了"被记成"这一步失败了"，
   *    3 轮之后整条任务被误判成 blocked。现在如实说"时间用完了"，并明说**这不是失败**。 */
  ok(/时间用完了/.test(r2?.note ?? '') && !/没挖掉/.test(r2?.note ?? ''),
    'note 说"这一轮的时间用完了"（不再写"还没挖掉"，那会让台账把它记成失败）', String(r2?.note).slice(0, 90))
  ok(/0\.3 秒/.test(r2?.note ?? ''), 'note 带上"这块按手上的东西要 0.3 秒"', String(r2?.note).slice(0, 140))
  ok(!/服务端可能拒/.test(r2?.note ?? ''), '**不再**赖"服务端可能拒了这次破坏"', String(r2?.note).slice(0, 120))
  ok(r2?.held === 'iron_pickaxex1', 'note 之外也带 held', String(r2?.held))
}

/* ─────────── ⑤ build()：搭完要报"用了哪种方块、手上还剩什么" ─────────── */
section('⑤ mc_build ⇒ 带 used（用了哪种方块）+ held（手上还剩什么）')
{
  const fake = mkBot({ held: { name: 'dirt', type: 4, count: 18 } })
  const mc = mkMc(fake)
  // 只测返回值：placeBlock 直接替换成"放成功且吃掉一块"
  mc.placeBlock = async ({ name }) => {
    fake.bot.heldItem = { name: 'dirt', type: 4, count: fake.bot.heldItem.count - 1 }
    return { placed: name ?? 'dirt', requested: name ?? 'dirt', at: { x: 0, y: 64, z: 0 }, now: name ?? 'dirt', held: 'dirtx17' }
  }
  const r = await mc.build({ x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0, name: 'dirt' })
  ok(r?.used === 'dirt', '带 used（实际用了哪种方块）', JSON.stringify(r))
  ok(r?.held === 'dirtx17', '带 held（搭完手上还剩什么）', String(r?.held))
  ok(r?.heldBefore === 'dirtx18', '带 heldBefore（搭之前是什么）', String(r?.heldBefore))
}

/* ─────────── ⑥ walkTo 垫路：报"垫的是什么、手上还剩什么" ─────────── */
section('⑥ mc_move 垫路 ⇒ 带 pillared + pillaredWith + held')
{
  const fake = mkBot({ held: { name: 'dirt', type: 4, count: 10 }, bag: [{ name: 'dirt', type: 4, count: 10 }], withPathfinder: true })
  const mc = mkMc(fake)
  const r = await mc.walkTo({ x: 0, y: 64, z: 4 }, { arrive: 1.6, budget: 1500 })
  ok(r?.arrived === true, '走到了（假 pathfinder 把它挪到目标）', JSON.stringify(r))
  ok(r?.pillared === 3, 'pillared 还是 3', String(r?.pillared))
  ok(r?.pillaredWith === 'dirt', 'pillaredWith 说清垫的是泥土', String(r?.pillaredWith))
  ok(r?.held === 'dirtx7', 'held 说清垫完手上还剩 7 块', String(r?.held))
  ok(r?.heldBefore === 'dirtx10', 'heldBefore 说清垫之前是 10 块', String(r?.heldBefore))
}

/* ─────────── ⑦ 静态接线（防止以后被改回去）─────────── */
section('⑦ 静态接线')
{
  const coreSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/core.mjs', import.meta.url), 'utf8'))
/* 路线图第 ④ 条第二十七刀：`interact` / `equip` 已搬进 `src\world-use.mjs`。 */
const useSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/world-use.mjs', import.meta.url), 'utf8'))
const buildSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/build.mjs', import.meta.url), 'utf8'))
  // 路线图第 ④ 条第三十六/三十七刀：`walkTo` / `#walkSwim` / `flyTo` / `#walkPathfinder` 搬进 `src/movement.mjs`。
  const movSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/movement.mjs', import.meta.url), 'utf8'))
  // 路线图第 ④ 条第七刀：背包那一层（heldText/invSnap/invUsed/canHarvestNow/toolKinds/countOf/freeSlot）
  // 搬到了 `src/inventory.mjs` —— 下面几条判据改成查新模块，并补"core 确实 import 了"（防搬走 + 忘接）。
  const invSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/inventory.mjs', import.meta.url), 'utf8'))
  // 路线图第 ④ 条第十四刀：挖掘速度那一层（digMsFor/digToolKindOf/digToolSpeedOf/fixDigMs/
  // patchDigTime/bestToolFor）搬到了 `src/dig-speed.mjs`。
  const dsSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/dig-speed.mjs', import.meta.url), 'utf8'))
  const woSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/world-observer.mjs', import.meta.url), 'utf8'))
  ok(/export function digMsFor \(b, blk, itemType = null\) \{/.test(dsSrc), 'dig-speed 有 digMsFor')
  ok(/export function fixDigMs \(b, blk, itemType\) \{/.test(dsSrc), 'dig-speed 有 fixDigMs（上游缺倍率的兜底）')
  ok(/export function patchDigTime \(b\) \{/.test(dsSrc) && /export function bestToolFor \(b, blk\) \{/.test(dsSrc),
    'dig-speed 有 patchDigTime / bestToolFor')
  ok(/export function digToolKindOf \(name\) \{/.test(dsSrc) && /export function digToolSpeedOf \(reg, itemType\) \{/.test(dsSrc),
    'dig-speed 有 digToolKindOf / digToolSpeedOf')
  ok(/ms === best\.ms && durLeftOf\(it\) > durLeftOf\(best\.item\)/.test(dsSrc),
    '🔴 速度打平时选耐久多的那把（2026-10-19 实机：背包里两把石镐，总用快坏的 19/131，满耐久那把闲置）')
  ok(/from '\.\/dig-speed\.mjs'/.test(coreSrc), 'core 确实从 dig-speed.mjs 导入（别只搬不接）')
  ok(!/#digMsFor \(b|#fixDigMs \(b|#digToolKindOf \(|#digToolSpeedOf \(|#bestToolFor \(b|#patchDigTime \(b/.test(coreSrc),
    'core 里没有残留的挖掘速度私有方法定义')
  ok(/patchDigTime \(b\) \{ return patchDigTime\(b\) \}/.test(coreSrc), 'patchDigTime 公开方法保留成薄包装（自检脚本一行都不用改）')
  ok(/export function heldText \(b\) \{/.test(invSrc), 'inventory 有 heldText（统一的"手上那叠"文案）')
  ok(/export function canHarvestNow \(b, blk\) \{/.test(invSrc), 'inventory 有 canHarvestNow（手上这叠能不能挖）')
  ok(/export function toolKinds \(b, blk\) \{/.test(invSrc), 'inventory 有 toolKinds（人话版"需要镐/斧/锹"）')
  ok(/export function invSnap \(b\) \{/.test(invSrc) && /export function invUsed \(b, snap\) \{/.test(invSrc), 'inventory 有 invSnap / invUsed（路上用掉了什么）')
  ok(/export function countOf \(b, name\) \{/.test(invSrc) && /export function freeSlot \(b, itemName = null\) \{/.test(invSrc),
    'inventory 有 countOf / freeSlot（背包计数、选槽位）')
  ok(/from '\.\/inventory\.mjs'/.test(coreSrc), 'core 确实从 inventory.mjs 导入（别只搬不接）')
  ok(/return countOf\(this\.bot, name\)/.test(coreSrc), 'countOf 公开方法保留成薄包装（外部一行都不用改）')
  ok(!/#heldText \(b\) \{|#invSnap \(b\) \{|#freeSlot \(b/.test(coreSrc), 'core 里没有残留的旧私有方法定义')
  ok(/#equipFor \(b, blk, label/.test(coreSrc), 'core 有 #equipFor（动手前换对工具）')
  // 路线图第 ④ 条第十五刀：采集/落地守卫（collectBusy/cancelCollect/waitGrounded/withHeld）
  // 搬到了 `src/dig-guard.mjs`。薄包装同名 ⇒ 所有调用点一行都不用改。
  const dgSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/dig-guard.mjs', import.meta.url), 'utf8'))
  ok(/#withHeld \(out, b, before\) \{ return withHeld\(out, b, before\) \}/.test(coreSrc), 'core 有 #withHeld 薄包装（dig 结果里补"手上变了"）')
  ok(/export function withHeld \(out, b, before\) \{/.test(dgSrc), 'dig-guard 有 withHeld')
  ok(/export function collectBusy \(b\) \{/.test(dgSrc) && /export async function cancelCollect \(b, ctx = \{\}\) \{/.test(dgSrc),
    'dig-guard 有 collectBusy / cancelCollect（停掉后台采集任务）')
  ok(/export async function waitGrounded \(b, \{ maxMs = 1_200, signal = null \} = \{\}\) \{/.test(dgSrc), 'dig-guard 有 waitGrounded（空中挖慢 5 倍）')
  ok(/from '\.\/dig-guard\.mjs'/.test(coreSrc), 'core 确实从 dig-guard.mjs 导入（别只搬不接）')
  ok(/bumpGen: \(who\) => \{ this\._moveGen\+\+; if \(who\) this\._moveGenWho = String\(who\) \}/.test(coreSrc), '薄包装把移动代号推进去（模块不碰 this；带 who 便于追查谁抢的）')
  ok(!/const cap = budgetMs == null/.test(coreSrc) && !/#collectBusy \(b\) \{\r?\n\s+try \{ return Boolean\(b\?\.collectBlock/.test(coreSrc) &&
    !/#waitGrounded \(b, maxMs = 1_200\) \{\r?\n\s+const ent = b\?\.entity/.test(coreSrc) && !/#withHeld \(out, b, before\) \{\r?\n\s+const held = heldText\(b\)/.test(coreSrc),
    'core 里没有残留的旧私有方法体（只剩薄包装）')
  /* 路线图第 ④ 条第三十八刀：`breakBlock` 搬进 `src\mining.mjs`（core 只剩薄包装 + `#mineCtx()`）。 */
  const mineSrc = stripComments(await (await import('node:fs/promises')).readFile(new URL('../src/mining.mjs', import.meta.url), 'utf8'))
  /* 别把参数表钉死：`noClear` 之类的新开关加进来时，这条断言不该跟着挂。 */
  ok(/export async function breakBlock \(self, \{ [^}]*allowDangerous[^}]*\}/.test(mineSrc), 'mining 有 breakBlock（带脚下安全检查开关）')
  ok(/await ctx\.equipFor\(b, blk, `换工具挖 \$\{name\}`\)/.test(mineSrc), 'breakBlock 动手前调 equipFor（实现在 src\\mining.mjs）')
  ok(/const noDrop = !canHarvestNow\(b, blk\)/.test(mineSrc) && /if \(noDrop && !canBreakNow\(b, blk\)\) \{/.test(mineSrc),
    'breakBlock 换不上就拒绝（不硬挖）')
  ok(/canBreakNow/.test(invSrc), 'inventory 有 canBreakNow（"挖得动"与"有掉落"分开判）')
  ok(/硬挖会一直超时/.test(mineSrc), '拒绝文案写清"硬挖会一直超时"')
  ok(/const digMs = digMsFor\(b, blk/.test(mineSrc), 'breakBlock 用 digMsFor 算"这块要几秒"')
  ok(/export function digMsFor \(b, blk, itemType = null\)/.test(dsSrc) && /typeof blk\?\.digTime !== 'function'/.test(dsSrc),
    'digMsFor 走 block.digTime（能算"换成背包里那把会快多少"）')
  ok(/if \(digMs != null && leftMs < digMs \+ 900\)/.test(mineSrc), '时间不够就不开始挖（别挖一半松手）')
  ok(/from '\.\/mining\.mjs'/.test(coreSrc), 'core 确实从 mining.mjs 导入（别只搬不接）')
  ok(/async breakBlock \(opts = \{\}\) \{ return await breakBlockImpl\(this, opts, this\.#mineCtx\(\)\) \}/.test(coreSrc), 'core 有 breakBlock 薄包装')
  ok(!/if \(digMs != null && leftMs < digMs \+ 900\)/.test(coreSrc), 'core 里没有残留的 breakBlock 实现体')
  // 空中挖会慢 5 倍，但 `onGround` 在走路下台阶/贴斜坡边缘时会瞬时为 false ⇒ 实机把"1.1 秒能挖掉"
  // 估成 5650ms，白拒一次。所以判据取"**真在下落**"：离地 **且** 竖直速度明显为负。
  // （2026-10-08 熔炼验证：掉进 7 格深的坑、在下落途中挖原木 ⇒ 真 digTime 是 3 秒 ×5 = 15 秒，
  //   按"站着"估成 3 秒就放行 ⇒ `bot.dig()` 挂满整轮预算只回一句"超时"。）
  /* 🔴 2026-10-15 审计（报告 D 第 5 条）：这个判据原来在 dig-speed.mjs 里写了一份、
   *    world-observer.mjs 的 slowDigWhy 又写了一份**不一样**的 ⇒ 文案说"我在空中挖得慢"，
   *    而那个 ms 根本没乘 5。现在两处共用 fallingNow(b)。 */
  ok(/fallingNow\(b\)/.test(dsSrc) && /export function fallingNow \(b\)/.test(woSrc)
    && /const vY = Number\(b\?\.entity\?\.velocity\?\.y \?\? 0\)/.test(woSrc)
    && /onGround === false && vY < -0\.02/.test(woSrc),
    'digMsFor 只在"真在下落"（离地 + 竖直速度为负）时按空中估，且与 slowDigWhy 共用 fallingNow')
  ok(!/const notOnGround = !b\?\.entity\?\.onGround\s*$/.test(dsSrc),
    '没有只看 `!b.entity.onGround`（瞬时浮空会把估计放大 5 倍、白拒一次）')
  ok(/const roadInfo = \(\) => \{/.test(movSrc) && /pillaredWith: used\[0\]\.name/.test(movSrc)
    && /from '\.\/movement\.mjs'/.test(coreSrc),
    'walkTo 垫路后报 pillaredWith（实现已搬到 src\\movement.mjs）')
  ok(/\.\.\.\(placed \? \{ pillared: placed \} : \{\}\), \.\.\.roadInfo\(\)/.test(movSrc), '两条返回路径都带 roadInfo()（实现在 src\\movement.mjs）')
  /* 路线图第 ④ 条第三十四刀：`build` 已搬进 `src\build.mjs`（core 只剩薄包装）。 */
  ok(/if \(r\?\.placed\) \{ if \(!used\) used = r\.placed; ok\.push\(at\) \}/.test(buildSrc)
    && /fail\.push\(`\$\{at\}: 现在那里是/.test(buildSrc)
    && /from '\.\/build\.mjs'/.test(coreSrc),
    'build 只把**复核过真放上去**的算 placed（placed:false 不再计数；实现已搬到 src\\build.mjs）')
  ok(!/held: b\.heldItem\?\.name \?\? null/.test(coreSrc), 'placeBlock 不再只回方块名（要带数量）')
  ok(/const held = heldText\(b\)/.test(useSrc) && /const got = isHand \? b\.heldItem\?\.name === item\.name : now\?\.name === item\.name/.test(useSrc)
    && /equipped: got,/.test(useSrc)
    && /\.\.\.\(beforeHeld !== held \? \{ beforeHeld \} : \{\}\)/.test(useSrc),
    'equip 的 held **读回来**（换手失败会如实说；实现已搬到 src\\world-use.mjs）')
  ok(/import \{ useBlock, useItem, interact, equip[^}]*\} from '\.\/world-use\.mjs'/.test(coreSrc)
    && /async equip \(opts = \{\}\) \{ return await equip\(this, opts, \{ t: \(p, k, l\) => this\.#t\(p, k, l\) \}\) \}/.test(coreSrc),
    'core 有 equip 薄包装、并且确实从 world-use.mjs 导入（ctx.t 塞的是本轮的 11 秒闸门）')
}

/* ─────────── ⑨ 工具档位：能挖就不升档（2026-10-24） ─────────── */
section('⑨ 工具档位：手上这把已经能挖，就不为了快换更高级的')
try {
  ok(toolTierOf('stone_pickaxe') === 2 && toolTierOf('iron_pickaxe') === 3 && toolTierOf('diamond_axe') === 4,
    '档位：木/金 1、石 2、铁 3、钻 4、合金 5')
  ok(toolTierOf('dirt') === 0 && toolTierOf('iron_sword') === 3, '非工具回 0；剑也算工具（挖木头比空手快）')

  /* 假 bot：只够 equipFor 用 —— 背包里含手上那格（真 mineflayer 语义） */
  const mkT = (held, bag) => {
    const bot = {
      game: { gameMode: 'survival' },
      entity: { position: new Vec3(0, 64, 0), onGround: true, effects: {} },
      inventory: { items: () => [held, ...bag].filter(Boolean), slots: [] },
      heldItem: held,
      equip: async (it) => { bot.heldItem = it },
      registry: { items: {}, itemsByName: {} },
    }
    return bot
  }

  // ① 石镐能挖深板岩（1.1s）而铁镐更快（0.75s）—— 不许换
  const deepslate = { name: 'deepslate', harvestTools: { 1: true, 2: true, 3: true }, digTime: (t) => (t === 2 ? 750 : 1100) }
  const b1 = mkT({ name: 'stone_pickaxe', type: 3, count: 1 }, [{ name: 'iron_pickaxe', type: 2, count: 1 }])
  const r1 = await equipFor({}, b1, deepslate, '换工具', {})
  ok(r1.changed === false && b1.heldItem?.name === 'stone_pickaxe',
    '手上石镐能挖深板岩 ⇒ 不为快三成换铁镐（省耐久）', `held=${b1.heldItem?.name}`)

  // ② 钻石矿石镐挖不动 —— 必须换铁镐
  const dia = { name: 'diamond_ore', harvestTools: { 2: true }, digTime: (t) => (t === 2 ? 900 : null) }
  const b2 = mkT({ name: 'stone_pickaxe', type: 3, count: 1 }, [{ name: 'iron_pickaxe', type: 2, count: 1 }])
  await equipFor({}, b2, dia, '换工具', {})
  ok(b2.heldItem?.name === 'iron_pickaxe', '石镐挖不动钻石矿 ⇒ 照样换铁镐', `held=${b2.heldItem?.name}`)

  // ③ 空手挖土 —— tier 0 不拦，该换铲子还得换
  const dirt = { name: 'dirt', harvestTools: {}, digTime: (t) => (t === 9 ? 150 : 750) }
  const b3 = mkT(null, [{ name: 'iron_shovel', type: 9, count: 1 }])
  await equipFor({}, b3, dirt, '换工具', {})
  ok(b3.heldItem?.name === 'iron_shovel', '空手挖土 ⇒ 照旧换铲子（档位 0 不拦）', `held=${b3.heldItem?.name}`)
} catch (err) {
  ok(false, '⑨ 工具档位测试自己炸了', String(err?.message ?? err))
}

/* ─────────── 收尾 ─────────── */
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
