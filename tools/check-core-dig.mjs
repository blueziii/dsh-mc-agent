#!/usr/bin/env node
/**
 * check-core-dig.mjs —— "采集超时/出错后必须停掉后台任务"的回归检查
 *
 * 背景（用户 2026-10-06 原话：「现在机器人走不了了」）：
 *   `dig()` 用 `withTimeout` 给 mineflayer-collectblock 设了 90 秒上限，但 `withTimeout`
 *   只是让 `await` 提前 reject，**不会取消底层的 collect 任务**。超时之后那个任务继续在
 *   后台按着 `forward`、占着 pathfinder 反复寻路 ⇒ 机器人当场"物理冻住"：
 *   `mc_diag` 里 `controlState.forward === true` 而 `velocity` 全 0、位置一格不动，
 *   之后的 `mc_move` 全部失败（15 秒只挪 0.03 格），**只有重连才恢复**。
 *   而那次的超时文案还写着"机器人可能已失步…必要时 mc_connect 重连"，
 *   于是模型真的去重连了一次 —— 白断线。
 *
 * 这个脚本用最小假 bot 把三件事钉死（防止坑回来）：
 *   ① `dig()` 开头必须停掉上次残留的采集任务，并把 7 个控制位全部松开；
 *   ② 够得着就**自己原地挖**，全程不碰 `collectBlock`（2026-10-08 实机：「挖矿还是会[复原]」）；
 *   ③ `walkTo()` 走路之前，如果发现上次的采集任务还在跑，必须先停掉它（否则抢控制权）；
 *   ④ 采集任务卡死（`cancelTask` 永远等不到 `collectBlock_finished`）时必须清空僵尸队列。
 *
 * 用法：node tools/check-core-dig.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 借依赖：源码树里没有 node_modules，从包目录借 vec3 ────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
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

/** `#releaseControls` 会松开的那些控制位（core.mjs:693 附近的清单） */
const CTRL = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

/**
 * 造一个假 bot —— 只带 `dig()` / `walkTo()` 会碰到的字段。
 *
 * @param {object} o
 *   - `busy`            采集任务是否"还在后台跑"（`collectBlock.targets.empty === false`）
 *   - `collectResolves` `collect()` 是否立刻成功（模拟正常挖到）
 *   - `withCollect`     是否挂 collectBlock 插件
 *   - `withPathfinder`  是否挂 pathfinder 插件
 *   - `withPackets`     是否挂 `_client.on('packet')`（测"服务端认没认"时用 `fire()` 造包）
 */
const mkBot = ({ bx = 0, by = 64, bz = 20, busy = true, collectResolves = false, withCollect = true, withPathfinder = true, withPackets = false } = {}) => {
  const calls = { control: [], cancel: 0, stop: 0, goto: 0, setMovements: 0, seq: [] }
  const state = { dug: false }
  const handlers = []
  const blockPos = new Vec3(bx, by, bz)
  const block = { name: 'oak_log', type: 100, boundingBox: 'block', position: blockPos.clone() }
  const air = { name: 'air', type: 0, boundingBox: 'empty', position: blockPos.clone() }
  const targets = { empty: !busy }
  const isTarget = (p) => Boolean(p) && p.x === bx && p.y === by && p.z === bz

  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    _client: withPackets
      ? { on: (ev, fn) => { if (ev === 'packet') handlers.push(fn) }, removeListener: () => {} }
      : {},
    game: { gameMode: 'survival' },
    registry: { itemsByName: {}, blocksByName: {}, items: {}, blocksByStateId: { 100: { name: 'oak_log' } } },
    inventory: { items: () => [] },
    blockAt: (p) => (isTarget(p) ? (state.dug ? air : block) : null),
    findBlocks: () => [],
    findBlock: () => null,
    setControlState: (k, v) => { calls.control.push([k, v]) },
    on: () => bot,
    removeListener: () => {},
  }
  if (withCollect) {
    bot.collectBlock = {
      targets,
      collect: () => {
        calls.seq.push('collect')
        if (!collectResolves) return new Promise(() => {})   // 永远不 resolve：模拟卡住
        state.dug = true
        targets.empty = true                                 // 正常跑完时 collectAll 会把目标吃空
        return Promise.resolve()
      },
      cancelTask: () => {
        calls.cancel++
        calls.seq.push('cancel')
        targets.empty = true
        return Promise.resolve()
      },
    }
  }
  if (withPathfinder) {
    bot.pathfinder = {
      goto: async () => { calls.goto++; calls.seq.push('goto') },
      stop: () => { calls.stop++ },
      setMovements: () => { calls.setMovements++ },
    }
  }
  return { bot, calls, state, targets, block, fire: (name, data) => { for (const fn of handlers.slice()) fn(data, { name }) } }
}

/** 把假 bot 直接塞进 McBot（不走 connect），并备好 `_pf` / `pfReady` / 小超时 */
const TMP_DIRS = []                     // 收尾要删掉，别在 %TEMP% 里留一堆 wc-coredig-*
const mkMc = (fake) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-coredig-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = fake.bot
  mc.mcPlugins = fake.bot.collectBlock ? { collectBlock: true } : {}
  mc.pfReady = true
  mc._pf = {
    goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    Movements: class { constructor() {} },
  }
  mc.cfg.collectBudgetMs = 300          // 别真等 90 秒
  return mc
}

/* ─────────── ① dig() 开头：旧任务必须停掉、控制位必须松开 ─────────── */
section('① dig() 开头必须停掉旧任务、松开控制位（够不着就如实说，不再交给 collectBlock）')
{
  const fake = mkBot({ busy: true, collectResolves: false })
  const mc = mkMc(fake)
  const t0 = Date.now()
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 20 } })
  const ms = Date.now() - t0
  ok(ms < 4000, '超时后及时返回（没有一直挂着）', `${ms}ms`)
  ok(fake.calls.cancel >= 1, '调用了 collectBlock.cancelTask()', `cancel=${fake.calls.cancel}`)
  ok(fake.calls.stop >= 1, '顺带 pathfinder.stop()', `stop=${fake.calls.stop}`)
  const last = new Map()
  for (const [k, v] of fake.calls.control) last.set(k, v)
  ok(CTRL.every((k) => last.get(k) === false), '7 个控制位最后都被设成 false',
    CTRL.map((k) => `${k}=${last.get(k)}`).join(' '))
  ok(out.some((l) => /够不着/.test(l)), '够不着就如实说"够不着"', String(out[0]).slice(0, 70))
  /* 🔴 2026-10-08 实机（用户「挖矿还是会」）：`dig()` **不再**把方块交给 mineflayer-collectblock。
   *    collectBlock 走过去用 `GoalLookAtBlock`（vendor CollectBlock.js:30）—— **看得见就算到**，
   *    站 6 格开外也 `bot.dig()` ⇒ 服务端按"眼睛→方块中心 ≤4.5"拒收，而 mineflayer 的
   *    `finishDigging()`（digging.js:158）已经把**客户端**那格写成 air ⇒ 画面就是"挖完又复原"；
   *    更糟的是服务端不回 air 更新 ⇒ `diggingTask` 永不 resolve ⇒ 采集任务永远挂着
   *    ⇒ 之后几分钟走不了路（实机日志 02:38–02:43 连打 20 次）。这条断言把"不许再交出去"钉死。 */
  ok(!fake.calls.seq.includes('collect'), '不再把方块交给 collectBlock 去挖',
    `seq=${fake.calls.seq.join(' → ')}`)
}

/* ─────────── ② 够得着就原地挖：不碰 collectBlock，旧任务只停一次 ─────────── */
section('② dig() 够得着就原地挖 —— 全程不碰 collectBlock，旧任务只停一次')
{
  const fake = mkBot({ bz: 3, busy: true })
  const b = fake.bot
  b.entity.onGround = true
  b.dig = () => { fake.state.dug = true; return Promise.resolve() }
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(/挖掉 oak_log/.test(out[0] ?? '') && /现在 air/.test(out[0] ?? ''),
    '报了"挖掉 → 现在 air"', String(out[0]).slice(0, 70))
  ok(!fake.calls.seq.includes('collect'), '够得着时也不调 collectBlock',
    `seq=${fake.calls.seq.join(' → ')}`)
  ok(fake.calls.cancel === 1, '旧任务只停一次（开头 interruptMove，不反复 cancel）',
    `cancel=${fake.calls.cancel}`)
  ok(fake.calls.stop >= 1 && fake.calls.stop <= 2, '停 pathfinder 也只在这一处（开头）',
    `stop=${fake.calls.stop}`)
}

/* ─────────── ②′ 服务端把方块改回来（"复原"）时不许报成功 ─────────── */
section('②′ 服务端拒绝破坏时会把原方块发回来（"复原"）—— 不许报成功')
{
  /* 用户 m19917「挖矿还是会[复原]」/ m20106「煤矿正常、铁矿不对」的根因：
   *   服务端拒收破坏时，原版把这个位置的**真实方块**（就是原方块本身）用 `block_change`
   *   发回来纠正客户端，mineflayer `blocks.js:396-399` 照着把客户端世界改回去 ⇒ 玩家看到"方块复原"。
   *   旧代码把这个**复原包**当成"服务端认了" ⇒ 报「挖掉 …（服务端已确认）」，紧接着方块在眼前回来。 */
  const fake = mkBot({ bz: 3, busy: true, withPackets: true })
  const b = fake.bot
  b.entity.onGround = true
  b.dig = () => {
    fake.state.dug = true                                                    // 客户端预测：先写成 air
    fake.fire('block_change', { location: { x: 0, y: 64, z: 3 }, type: 100 }) // 服务端：把这块改回 oak_log
    fake.state.dug = false                                                   // 客户端应用服务端的包 ⇒ 复原
    return Promise.resolve()
  }
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  const text = out.join(' ｜ ')
  ok(!/服务端已确认/.test(text), '不报"服务端已确认"（复原包不是"认了"）', text.slice(0, 70))
  ok(!out.some((l) => /^挖掉 /.test(l)), '不报"挖掉"（`没挖掉` 是如实说，不算）', text.slice(0, 70))
  ok(/复原/.test(text) && /改回了 oak_log/.test(text), '如实说"服务端把这块改回了 oak_log（复原）"', text.slice(0, 90))
  ok(/mc_move/.test(text) && /force:true/.test(text), '给出下一步（走近再挖 / 真重连）', text.slice(0, 90))
}
{
  /* 正对照：服务端真的发 air 时照旧报"服务端已确认"（别把好路也堵了）。 */
  const fake = mkBot({ bz: 3, busy: true, withPackets: true })
  const b = fake.bot
  b.entity.onGround = true
  b.dig = () => { fake.state.dug = true; fake.fire('block_change', { location: { x: 0, y: 64, z: 3 }, type: 0 }); return Promise.resolve() }
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(out.some((l) => /挖掉 oak_log/.test(l) && /服务端已确认/.test(l)),
    '真的收到 air 回包 ⇒ 照旧报"服务端已确认"', String(out[0]).slice(0, 70))
}
{
  /* `multi_block_change` 的位段格式必须按 mineflayer `blocks.js:363-394` 解（不能整包算"没有证据"）：
   *   1.18+ 每个 record 一个数字 —— `y = record & 0x0f`、`z = (record >> 4) & 0x0f`、
   *   `x = (record >> 8) & 0x0f`、状态 = `record >> 12`；坐标原点 = `chunkCoordinates`（区块段坐标）×16。
   *   这里 (0,64,3) 落在区块段 (0,4,0) 的 (0,0,3)。 */
  const rec = 0 | (3 << 4) | (0 << 8) | (0 << 12)                            // air
  const fake = mkBot({ bz: 3, busy: true, withPackets: true })
  const b = fake.bot
  b.entity.onGround = true
  b.dig = () => { fake.state.dug = true; fake.fire('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: 0 }, records: [rec] }); return Promise.resolve() }
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(out.some((l) => /服务端已确认/.test(l)), 'multi_block_change 里的 air 也认（位段解对了）', String(out[0]).slice(0, 70))
}
{
  /* 反向：multi_block_change 里是**别的方块** ⇒ 同样是"复原"，不许报成功。 */
  const rec = 0 | (3 << 4) | (0 << 8) | (100 << 12)                          // oak_log
  const fake = mkBot({ bz: 3, busy: true, withPackets: true })
  const b = fake.bot
  b.entity.onGround = true
  b.dig = () => { fake.state.dug = true; fake.fire('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: 0 }, records: [rec] }); return Promise.resolve() }
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  const text = out.join(' ｜ ')
  ok(/复原/.test(text) && !/服务端已确认/.test(text), 'multi_block_change 里的非空气也当"复原"', text.slice(0, 80))
}

/* ─────────── ③ walkTo()：先停后台任务，再走路 ─────────── */
section('③ walkTo() —— 上次的采集任务还在跑时，必须先停掉再走路')
{
  const fake = mkBot({ busy: true })
  const mc = mkMc(fake)
  const r = await mc.walkTo({ x: 0, y: 64, z: 2 }, { arrive: 1.6, budget: 2000 })
  ok(fake.calls.cancel >= 1, '走路前调了 cancelTask()', `cancel=${fake.calls.cancel}`)
  const iCancel = fake.calls.seq.indexOf('cancel')
  const iGoto = fake.calls.seq.indexOf('goto')
  ok(iCancel >= 0 && iGoto >= 0 && iCancel < iGoto, 'cancel 发生在 goto **之前**',
    `seq=${fake.calls.seq.join(' → ')}`)
  ok(r?.via === 'pathfinder', '返回 via=pathfinder', String(r?.via))

  const clean = mkBot({ busy: false })
  const mc2 = mkMc(clean)
  await mc2.walkTo({ x: 0, y: 64, z: 2 }, { arrive: 1.6, budget: 2000 })
  ok(clean.calls.cancel === 0, '没有泄漏任务时不白调 cancelTask', `cancel=${clean.calls.cancel}`)
}

/* ─────────── ④ 没有 collectBlock 插件：不炸，退回原地挖 ─────────── */
section('④ 没有 collectBlock 插件 —— 不抛异常，退回原地挖并如实说')
{
  const fake = mkBot({ withCollect: false })
  const mc = mkMc(fake)
  let err = null, out = []
  try { out = await mc.dig({ pos: { x: 0, y: 64, z: 20 } }) } catch (e) { err = e }
  ok(!err, '没有 collectBlock 也不炸', err ? String(err.message) : '')
  ok(out.some((l) => /够不着/.test(l)), '退回原地挖：够不着就如实说', out.join(' | ').slice(0, 70))
}

/* ─────────── ⑤ 够不着的文案：教模型走近，别骗它去重连 ─────────── */
section('⑤ 够不着的文案 —— 教模型走近 + 说清"会复原"，不骗它去重连')
{
  const fake = mkBot({ busy: false, collectResolves: false })
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 20 } })
  const line = out.find((l) => /够不着/.test(l)) ?? ''
  ok(line.length > 0, '有"够不着"的说明', line.slice(0, 80))
  ok(/mc_move/.test(line), '告诉模型先用 mc_move 走近')
  ok(/复原/.test(line), '说清"站远了挖服务端不认、方块会复原"')
  ok(!/失步/.test(line), '不再说"机器人可能已失步"')
  ok(!/mc_connect/.test(line), '不再建议 mc_connect 重连')
}

/* ─────────── ⑤′ 「不挖」就是真不挖 —— 绝不偷偷改成挖穿（2026-11-02 审计）─────────── */
section('⑤′ 「不挖」就是真不挖 —— 不偷偷把 allowDig 翻成 true 重试')
{
  const src = await readFile(new URL('../src/mining.mjs', import.meta.url), 'utf8')
  ok(!/allowDig: true/.test(src), 'mining 从不自己把 allowDig 翻成 true')
  ok(/budget, allowDig \}\)/.test(src), '走路用的就是调用方给的那个 allowDig')
  ok(/我没有挖墙/.test(src) && /digThrough:true/.test(src),
    '不挖模式走不过去时：如实说"没挖墙"并指出 digThrough 这条路')
  /* 🔴 2026-11-02 审计（#6）：视线只该跳「自己站的那两格（脚下 + 眼睛）+ 竖直方向最后一格」，
   *   跳 3×3×3 会让贴身那一面墙恒判看得见（隔一格厚的墙就是最常见的情形）。 */
  ok(/if \(bx === eyeX && bz === eyeZ && \(by === eyeY \|\| by === feetY/.test(src)
    && !/Math\.max\(Math\.abs\(bx - near\.fx0\)/.test(src),
    '视线自检只跳过自己站的那几格（不再跳过以眼为心的 3×3×3）')
  /* 🔴 2026-11-02 审计（#5）：清障这条路也必须过 underfootRiskOf，别把自己脚下挖空 */
  ok(/const foot = underfootRiskOf\(b, cell\)/.test(src) && /foot\.bad === true/.test(src),
    '清障（digCell）也过 underfootRiskOf —— 挖了会塌/会掉进危险就不挖')
}

/* ─────────── ⑥ 够得着就原地挖：复核过才算挖掉，掉落物要自己捡回来 ─────────── */
section('⑥ 够得着就原地挖 —— 复核过才算挖掉，掉落物要自己捡回来（2026-10-08 实机）')
{
  /* 背景：`dig()` 的"够得着就原地挖"分支直接 `bot.dig()`，**绕过了 collectBlock**，
   * 而 collectBlock 平时是"挖完还会把掉落物捡回来"的 ⇒ 实机挖 3 根原木，背包里只有 1 根。
   * 这里把两件事钉死：① 掉落物要交给 collectBlock 捡；② 方块还在时不许报"挖掉"。 */
  const mk = (digWorks, { pickFails = false, invFull = false } = {}) => {
    const fake = mkBot({ bz: 3, busy: false })
    const b = fake.bot
    b.entity.onGround = true
    b.dig = () => { if (digWorks) fake.state.dug = true; return Promise.resolve() }
    /* 🔴 掉落物实体的字段要按**真的**写：`minecraft-data` 里 `name: 'item'`、`displayName: 'Item'`，
     *    但 **`type` 是 `'other'`**（不是 `'object'`）—— 实机就是被这一点坑的
     *    （`#grabDrops` 里那句 `e.type !== 'object'` 让它永远返回 0）。
     *    另外塞一头牛：`displayName: 'Cow'` 的**非**掉落物绝不能被交给 collectBlock。 */
    /* 🔴 2026-10-25：掉落物改到**脚边 1.8 格**（原来 3.5 格）—— 挖完只捡 2.5 格内的，
     *    更远的不替它决定（用户：「超过两格还是会去自动捡很远的掉落物」）。 */
    const drop = { type: 'other', name: 'item', displayName: 'Item', position: new Vec3(0.5, 64, 1.8), isValid: true }
    const cow = { type: 'mob', name: 'cow', displayName: 'Cow', position: new Vec3(1.5, 64, 3.5), isValid: true }
    b.entities = { 7: drop, 9: cow }
    /* 🔴 `#grabDrops` 现在按**背包差**报数（不再看 `e.isValid` —— 实机上那个字段来不及变 false），
     *    所以假 bot 的背包得真的会长：捡一个掉落物就多一件。 */
    const inv = []
    b.inventory = { items: () => inv, emptySlotCount: () => (invFull ? 0 : 36) }
    const picked = []
    b.collectBlock.collect = (t) => {
      picked.push(t)
      /* `pickFails`：模拟"走不过去 / 捡不动"（collect 直接拒）⇒ 背包不涨 ⇒ 必须点一句"东西还在地上"。 */
      if (pickFails) return Promise.reject(new Error('走不过去'))
      inv.push({ name: 'oak_log', type: 100, count: 1 })
      return Promise.resolve()
    }
    return { fake, mc: mkMc(fake), picked, drop, cow }
  }

  const a = mk(true)
  const outA = await a.mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  const jA = outA.join(' | ')
  ok(outA.some((l) => /挖掉 oak_log/.test(l) && /原地/.test(l)), '够得着就走"原地挖"这条路', jA.slice(0, 90))
  ok(a.picked.length === 1 && a.picked[0] === a.drop, '挖完把掉落物交给 collectBlock 捡回来', `picked=${a.picked.length}`)
  ok(!a.picked.includes(a.cow), '非掉落物（牛）不许交给 collectBlock（几乎每个实体都有 displayName）', `picked=${a.picked.length}`)
  ok(outA.some((l) => /掉落物：.*顺手捡回 1 个/.test(l)), '如实报捡回了几个', jA.slice(0, 120))

  /* 挖到了但**一个都没捡到**（走不过去 / 捡不动）⇒ 必须点一句"东西还在地上"。
   * 用户 2026-10-08 原话："挖完方块…老是忘记走过去拾取" —— 捡不捡是决策，但结果里得让它知道。 */
  const b2 = mk(true, { pickFails: true, invFull: true })
  const outB2 = await b2.mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  const jB2 = outB2.join(' | ')
  ok(outB2.some((l) => /挖掉 oak_log/.test(l)), '捡不到也不影响"挖掉了"这个事实', jB2.slice(0, 90))
  ok(outB2.some((l) => /地上还有 1 个掉落物没捡/.test(l)),
    '一个都没捡到 ⇒ 点一句"地上还有 N 个没捡"（牛不算）', jB2.slice(0, 200))
  ok(outB2.some((l) => /mc_move/.test(l) && /几分钟就消失/.test(l)),
    '提示要写清"走过去站上去"和"东西会消失"', jB2.slice(0, 200))
  ok(outB2.some((l) => /背包满了/.test(l) && /mc_chest/.test(l)),
    '背包满了 ⇒ 提醒先存箱子 / 丢东西（走过去也塞不进去）', jB2.slice(0, 220))

  const c = mk(false)
  const outC = await c.mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  const jC = outC.join(' | ')
  ok(outC.some((l) => /没挖成 oak_log/.test(l)), '方块还在时**不许**报"挖掉"', jC.slice(0, 90))
  ok(outC.some((l) => /服务端没认这次破坏/.test(l)), '如实说服务端没认这次破坏', jC.slice(0, 120))
  ok(c.picked.length === 0, '没挖掉就不去捡掉落物', `picked=${c.picked.length}`)
}

/* ─────────── ⑦ 采集任务卡死：cancelTask 等不到事件 ⇒ 必须清空僵尸队列 ─────────── */
/* ─────────── ⑥′ 挖自己脚下：下面没落脚点/是岩浆 ⇒ 拦（2026-10-18 审计 P1-5） ─────────── */
section('⑥′ 挖自己脚下的支撑：下面没落脚点就别挖（除非 allowDangerous）')
{
  const mkWorld = (map) => (p) => {
    const k = `${p.x},${p.y},${p.z}`
    return k in map ? map[k] : null
  }
  const fake = mkBot({ bx: 0, by: 63, bz: 0 })
  const b = fake.bot
  b.entity.position = new Vec3(0.5, 64, 0.5)   // 脚 y=64 ⇒ 支撑格是 (0,63,0)
  b.entity.onGround = true
  b.blockAt = mkWorld({
    '0,63,0': { name: 'dirt', type: 3, boundingBox: 'block' },
    '0,62,0': { name: 'air', type: 0, boundingBox: 'empty' },
    '0,61,0': { name: 'air', type: 0, boundingBox: 'empty' },
  })
  b.dig = () => { fake.state.dug = true; return Promise.resolve() }
  const mc = mkMc(fake)
  const r = await mc.breakBlock({ x: 0, y: 63, z: 0 })
  ok(r.broken === false && r.dangerous === true, '踩着的方块下面是空的 ⇒ 拒绝挖（dangerous:true）',
    JSON.stringify(r).slice(0, 120))
  ok(/脚下的支撑/.test(String(r.note)) && /allowDangerous/.test(String(r.note)),
    '说清"这是脚下的支撑"并指出 allowDangerous', String(r.note).slice(0, 90))
  ok(fake.state.dug === false, '一块都没挖')

  const mc2 = mkMc(mkBot({ bx: 0, by: 63, bz: 0 }))
  const b2 = mc2.bot
  b2.entity.position = new Vec3(0.5, 64, 0.5)
  b2.entity.onGround = true
  b2.blockAt = mkWorld({
    '0,63,0': { name: 'dirt', type: 3, boundingBox: 'block' },
    '0,62,0': { name: 'lava', type: 4, boundingBox: 'empty' },
  })
  b2.dig = () => Promise.resolve()
  const r2 = await mc2.breakBlock({ x: 0, y: 63, z: 0, allowDangerous: true })
  ok(r2.dangerous !== true, 'allowDangerous:true ⇒ 照挖（不再拦）', JSON.stringify(r2).slice(0, 100))

  /* 挖脚下的**侧面**（同层相邻方块）不管 —— 那是寻路的事；只有当方块就在自己列上才算拆支撑。 */
  const mc3 = mkMc(mkBot({ bx: 1, by: 63, bz: 0 }))
  const b3 = mc3.bot
  b3.entity.position = new Vec3(0.5, 64, 0.5)
  b3.entity.onGround = true
  b3.blockAt = mkWorld({
    '1,63,0': { name: 'dirt', type: 3, boundingBox: 'block' },
    '1,62,0': { name: 'air', type: 0, boundingBox: 'empty' },
  })
  b3.dig = () => Promise.resolve()
  const r3 = await mc3.breakBlock({ x: 1, y: 63, z: 0 })
  ok(r3.dangerous !== true, '旁边那一列的同层方块 ⇒ 不拦（不是我的支撑）', JSON.stringify(r3).slice(0, 100))
}

section('⑦ 采集任务卡死（cancelTask 永远等不到 collectBlock_finished）—— 清空僵尸队列')
{
  /* 背景（2026-10-08 实机日志 02:38–02:43 连打 20 次"上次的采集任务还在后台跑"）：
   *   `cancelTask()` 内部是 `await once(bot, 'collectBlock_finished')`，而那个事件只有 `collect()`
   *   的 finally 才 emit。采集卡在 `yield bot.dig(block)` 里时事件永远不来 ⇒ `targets` 一直非空
   *   ⇒ `#collectBusy` 恒真 ⇒ 之后每次走路都只打印警告、机器人几分钟走不了路。
   *   这里模拟"cancelTask 永不返回"，要求兜底把 `targets` 清掉。 */
  const fake = mkBot({ busy: true })
  const b = fake.bot
  b.collectBlock.cancelTask = () => new Promise(() => {})   // 永远不 resolve
  b.collectBlock.targets.clear = () => { fake.calls.cleared = true; fake.targets.empty = true }
  const mc = mkMc(fake)
  const t0 = Date.now()
  const r = await mc.walkTo({ x: 0, y: 64, z: 2 }, { arrive: 1.6, budget: 1500 })
  const ms = Date.now() - t0
  ok(fake.calls.cleared === true, 'cancelTask 卡住时清空了 targets（僵尸任务挡不住走路）',
    `cleared=${fake.calls.cleared}`)
  ok(ms < 4000, '清队列不会把这一轮拖爆', `${ms}ms`)
  ok(r?.via === 'pathfinder', '清完照样继续走路', String(r?.via))
}

section('⑧ 只给坐标时 count 不生效（否则第二格会去挖"空气"）')
{
  /* 背景（2026-10-19 实机）：`mc_dig {x,y,z,count:2}` 的第二格，`want` 取的是
   * `blockAt(pos).name` —— 而那格刚被挖空，读回来是 `air`，于是 `findBlocks` 抓一堆**空气**
   * 当目标，返回里就成了"（12,-60,28）已经不在了"。指定坐标的语义本来就是"挖这一格"。
   * 这里用源码断言钉死（跑真 bot 的整条链太重，而这两处的形状就是判据本身）。 */
  const src = await readFile(new URL('../src/mining.mjs', import.meta.url), 'utf8')
  ok(/const n = Math\.min\(Math\.max\(pos \? 1 : count, 1\), 16\)/.test(src),
    '🔴 给了 pos 时 n 强制成 1（count 不再去找空气）')
  ok(!/const want = name \?\?/.test(src),
    '🔴 不再用"pos 那格的方块名"当第二个目标（那格已经挖空了）')

  /* 🔴 2026-10-29（用户：「mc_dig coal_ore 挖几块后开始挖其他地方的矿，最近的并没挖完」）：
   *   候选不能只扫一次。挖掉一块会把旁边的矿露出来，
   *   必须重扫才能“先把这一片挖完”。 */
  ok(/const queue = targets\.slice\(\)/.test(src) && /const rescan = \(wantName\) =>/.test(src),
    '🔴 dig 用可动队列 + rescan（不再一次扫完就固定）')
  /* 🔴 2026-10-29（用户：「这个等挖矿结束后最后检查」）：掉落物等待**不在块内**，
   *   整轮挖完统一收一次。 */
  ok(!/waitForPickup\(self, b, \{ at: p \}\)/.test(src) && !/graceMs: pickupGrace/.test(src),
    '🔴 循环里不再逐块等掉落物吸附')
  /* 🔴 2026-10-29（用户的输出规范）：挖成功不再逐块写一行。 */
  ok(/const okLog = \[\]/.test(src) && /⛏ 挖掉 \$\{okLog\.length\} 块/.test(src),
    '🔴 多块成功合并成一行汇总（按名字计数）')
  ok(/byName\.set\(o\.nm, \(byName\.get\(o\.nm\) \?\? 0\) \+ 1\)/.test(src),
    '汇总按方块名计数（coal_ore×3 这样）')
  ok(!/out\.push\(`挖掉 \$\{nm\} @ \$\{p\}（原地/.test(src),
    '单块那条改到收工处统一写（不在挖的循环里直接 push）')
  ok(/let lastDig = null/.test(src) && /waitForPickup\(self, b, \{ at: lastDig \?\? undefined/.test(src),
    '整轮结束统一检查一次（参照最后一次挖掘点）')
  ok(/const enough = leftOf\(\) > 500/.test(src),
    '时间不够就只报不捡（别把返回文本挤掉）')
  ok(/import \{ PICKUP_GRACE_MS, waitForPickup \} from '\.\/pickup\.mjs'/.test(src),
    '常量从 pickup.mjs 引，不写字面量')
  ok(/if \(okCount > 0 && !queueNear\(\)\) rescan\(name\)/.test(src),
    '🔴 队首还在脚边就不重扫（连续挖同一片不付扫描开销）')
  ok(/maxDistance: Math\.min\(maxDistance, DIG_RESCAN_RADIUS\)/.test(src)
    && /const DIG_RESCAN_RADIUS = 12/.test(src),
    '重扫只扫近处（12 格内），远处那几块不插队')
  ok(/found\.sort\(\(a, c\) => \(tierOf\(a\) - tierOf\(c\)\) \|\| \(distOf\(a\) - distOf\(c\)\)\)/.test(src),
    '重扫后仍按“够得着 > 同一层 > 距离”排序')
  ok(/tried\.has\(cellKeyOf\(blk\)\)/.test(src) && /tried\.add\(cellKeyOf\(target\)\)/.test(src),
    '重扫会排除已处理过的坐标（不反复围着同一块转）')
  ok(!/for \(const target of targets\)/.test(src),
    '不再用固定数组 for-循环遍历候选（那样中途没法重排）')
}

/* 🔴 2026-10-29 用户：「mc_dig · coal_ore 不挖脚底下的」（脚下的矿就是自己的支撑，以前一律拦）。
 *   现在跟“往下走”对齐：≤ dropMax 格、落点实心、没液体 ⇒ 照挖。 */
{
  const { underfootRiskOf, UNDERFOOT_DROP_MAX } = await import('../src/mining.mjs')
  const mkBot = (cells, hp = 20) => ({
    health: hp,
    entity: { position: { x: 0, y: 64, z: 0, floored: () => ({ x: 0, y: 64, z: 0 }) } },
    blockAt: (q) => {
      const k = `${q.x},${q.y},${q.z}`
      return k in cells ? { name: cells[k] } : null
    },
  })
  const at = (dy, name) => [`0,${64 - dy},0`, name]
  const r1 = underfootRiskOf(mkBot(Object.fromEntries([at(2, 'air'), at(3, 'air'), at(4, 'stone')])), { x: 0, y: 63, z: 0 })
  ok(r1?.bad === false && r1?.dropTo === 2, '脚下矿方下面是 2 格落差 ⇒ 照挖（掉 2 格落在实心上）', JSON.stringify(r1))
  const r2 = underfootRiskOf(mkBot(Object.fromEntries([at(2, 'air'), at(3, 'air'), at(4, 'air'), at(5, 'air'), at(6, 'air'), at(7, 'stone')])), { x: 0, y: 63, z: 0 })
  /* 🔴 2026-10-29：旧的“落差超过 ${UNDERFOOT_DROP_MAX} 格就拦”已废 ——
   *   改成按摔落伤害判：摔不死就挖，会摔死才拦。 */
  ok(r2?.bad === false && r2?.fallDamage > 0,
    '落差大但摔不死 ⇒ 照挖（只回报 fallDamage）', String(r2?.why ?? '-') + ' dmg=' + String(r2?.fallDamage))
  const r3 = underfootRiskOf(mkBot(Object.fromEntries([at(2, 'air'), at(3, 'lava'), at(4, 'stone')])), { x: 0, y: 63, z: 0 })
  ok(r3?.bad === true && /lava/.test(String(r3?.why ?? '')), '下面是岩浆 ⇒ 拦并点名', String(r3?.why ?? ''))
  const cells4 = Object.fromEntries([at(2, 'air'), at(3, 'air'), at(4, 'air'), at(5, 'stone')])
  const r4 = underfootRiskOf(mkBot(cells4, 6), { x: 0, y: 63, z: 0 })
  /* 血 < 10 时上限降到 3 格：3 格落差仍然放行，4 格才拦 */
  ok(r4?.bad === false && r4?.dropTo === 3, '血量 < 10 时 3 格落差仍放行（上限 3）', JSON.stringify(r4))
  /* 🔴 2026-11-02 审计（#19）：这条原来叫"血量 < 10 时 4 格落差要拦"，可它的格子里
   *   下面全是 air、一个落点都没有 ⇒ 走的是 `land == null`（读不到底）那条分支，
   *   跟血量一点关系都没有 —— **假通过**。现在拆成两条真用例： */
  const cells5 = Object.fromEntries([at(2, 'air'), at(3, 'air'), at(4, 'air'), at(5, 'air')])
  const r5 = underfootRiskOf(mkBot(cells5, 6), { x: 0, y: 63, z: 0 })
  ok(r5?.bad === true && /读不到|不知道多深/.test(String(r5?.why ?? '')),
    '往下读不到底（不知道多深）⇒ 拦，且说清是"不知道"不是"确定很深"', String(r5?.why ?? ''))
  /* 落差 9 格、血 6：MC 摔落伤害 = 9 − 3 = 6 ≥ 6 ⇒ 会摔死，拦。 */
  const deep = Object.fromEntries([...Array.from({ length: 9 }, (_, i) => at(2 + i, 'air')), at(11, 'stone')])
  const r6 = underfootRiskOf(mkBot(deep, 6), { x: 0, y: 63, z: 0 })
  ok(r6?.bad === true && r6?.fallDamage === 6, '血 6 掉 9 格会摔死（6 点）⇒ 拦', String(r6?.why ?? ''))
  const r7 = underfootRiskOf(mkBot(deep, 20), { x: 0, y: 63, z: 0 })
  ok(r7?.bad === false && r7?.fallDamage === 6, '同样 9 格、满血 20 ⇒ 摔不死，照挖', String(r7?.why ?? ''))
}

/* ─────────── 收尾 ─────────── */
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
