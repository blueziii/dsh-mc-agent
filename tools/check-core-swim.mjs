#!/usr/bin/env node
/**
 * check-core-swim.mjs —— "别淹死"的回归检查（上浮换气 + 别去挖水）
 *
 * 背景（用户 2026-10-07 原话：「现在容易被淹死」）：
 *   ① **缺氧不掉血，掉到 0 才开始掉血** —— 所以"掉血但 22 格内看不到怪"很可能根本不是被远程怪
 *      隔着墙射，而是**在水里憋气**。旧版 `mc_status` 只报 `inWater`、不报氧气，AI 看不出自己
 *      快淹死了；`mc_auto` 的文案还把它说成"多半是远程/隔墙"，AI 于是跑去找一个不存在的敌人。
 *   ② **水/岩浆是流体，挖不掉** —— 日志里出现过 `破坏 water 这一轮的时间用完了`：AI 想"挖开水"，
 *      白花一次调用，人还在水里继续沉。
 *   ③ 出水要能**真的做到**：`mc_move {mode:"jump"}` 只按 320ms（爬台阶用），在水里不够；
 *      所以补 `swimUp()`（按住 jump 游泳，一次最多 3 秒，到点如实报 remaining/hint）。
 *
 * 用法：node tools/check-core-swim.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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

const TMP_DIRS = []
const mkMc = (bot) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-swim-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = bot
  mc.mcPlugins = {}
  mc.pfReady = false
  return mc
}

/**
 * 假 bot：只带 `swimUp()` / `dig()` 会碰到的字段。
 * @param {object} o
 *   - `inWater` 一开始在不在水里
 *   - `air`     氧气（0–20；`null` = 这个版本读不到）
 *   - `y`       起始 y
 *   - `after`   `{ms, inWater, air, y}`：到点后改状态（模拟"游上来了/换到气了"）
 */
const mkBot = ({ inWater = true, air = 8, y = 60, after = null } = {}) => {
  const calls = { control: [], jump: 0 }
  const bot = {
    entity: { position: new Vec3(0, y, 0), isInWater: inWater, yaw: 0, pitch: 0 },
    _client: {},
    game: { gameMode: 'survival' },
    registry: { itemsByName: {}, blocksByName: {}, items: {} },
    inventory: { items: () => [] },
    heldItem: null,
    blockAt: () => null,
    findBlocks: () => [],
    findBlock: () => null,
    setControlState: (k, v) => { calls.control.push([k, v]); if (k === 'jump' && v) calls.jump++ },
    on: () => bot,
    removeListener: () => {},
  }
  Object.defineProperty(bot, 'oxygenLevel', { get: () => bot.__air, set: (v) => { bot.__air = v } })
  bot.__air = air
  if (after) {
    setTimeout(() => {
      if (after.inWater !== undefined) bot.entity.isInWater = after.inWater
      if (after.air !== undefined) bot.__air = after.air
      if (after.y !== undefined) bot.entity.position = new Vec3(0, after.y, 0)
    }, after.ms)
  }
  return { bot, calls }
}

const jumpOn = (calls) => calls.control.some(([k, v]) => k === 'jump' && v === true)
const jumpOff = (calls) => calls.control.some(([k, v]) => k === 'jump' && v === false)

/* ─────────── ① 不在水里：立刻返回，别乱按 jump ─────────── */
section('① 不在水里 —— 立刻返回、不按 jump')
{
  const { bot, calls } = mkBot({ inWater: false, air: 20 })
  const mc = mkMc(bot)
  const t0 = Date.now()
  const r = await mc.swimUp()
  const ms = Date.now() - t0
  ok(r.inWater === false, '如实报"不在水里"', JSON.stringify({ inWater: r.inWater, note: r.note }))
  ok(/没在水里/.test(String(r.note ?? '')), 'note 说明这是给"在水里憋气"用的')
  ok(calls.control.length === 0, '一个控制位都没碰', `control=${calls.control.length}`)
  ok(ms < 300, '立刻返回（不白等 3 秒）', `${ms}ms`)
}

/* ─────────── ② 在水里游上来：报 rose、松开 jump ─────────── */
section('② 在水里上浮 —— 出水后立刻停、如实报 rose')
{
  const { bot, calls } = mkBot({ inWater: true, air: 6, y: 60, after: { ms: 260, inWater: false, air: 20, y: 61.2 } })
  const mc = mkMc(bot)
  const t0 = Date.now()
  const r = await mc.swimUp()
  const ms = Date.now() - t0
  ok(r.inWater === false, '报"已经出水"', JSON.stringify({ inWater: r.inWater, rose: r.rose, air: r.air }))
  ok(r.rose >= 1 && r.rose <= 1.5, 'rose 报出涨了几格', String(r.rose))
  ok(r.air === 20, '报出出水后的氧气', String(r.air))
  ok(/已经出水/.test(String(r.note ?? '')), 'note = 已经出水了')
  ok(r.remaining === undefined, '出水了就不给 remaining（不用再叫一次）')
  ok(jumpOn(calls) && jumpOff(calls), 'jump 按下又松开（不会一直举着）')
  ok(ms < 1200, '出水就停，不等满 3 秒', `${ms}ms`)
}

/* ─────────── ③ 一直泡着：到点如实返回 remaining + hint ─────────── */
section('③ 一直泡在水里 —— 到点返回 remaining/hint（让 AI 再叫一次）')
{
  const { bot, calls } = mkBot({ inWater: true, air: 3, y: 60 })
  const mc = mkMc(bot)
  const t0 = Date.now()
  const r = await mc.swimUp()
  const ms = Date.now() - t0
  ok(r.inWater === true, '还在水里就如实报 inWater:true')
  ok(r.remaining === 1, 'remaining:1', String(r.remaining))
  ok(/再叫一次 mc_move/.test(String(r.hint ?? '')), 'hint 教它再叫一次同一个工具')
  ok(/水挖不掉/.test(String(r.hint ?? '')), 'hint 里点明"水挖不掉"（别去 mc_dig 水）')
  ok(r.heldMs >= 2900 && r.heldMs <= 3400, '按满默认的 3 秒', `${r.heldMs}ms`)
  ok(ms >= 2900 && ms <= 3600, '墙钟也在 3 秒量级', `${ms}ms`)
  ok(jumpOff(calls), 'finally 里松开 jump（超时也要松）')
}

/* ─────────── ④ 头露出水面、气在恢复 → 提前跳出 ─────────── */
section('④ 头露出水面、氧气回升 —— 提前跳出（不白按满 3 秒）')
{
  const { bot } = mkBot({ inWater: true, air: 5, y: 60, after: { ms: 150, air: 20, y: 61 } })
  const mc = mkMc(bot)
  const r = await mc.swimUp()
  ok(r.heldMs >= 500 && r.heldMs <= 1500, '在 0.5~1.5 秒内就跳出', `${r.heldMs}ms`)
  ok(r.rose >= 0.9, 'rose 报出涨了约 1 格', String(r.rose))
}

/* ─────────── ⑤ 预算钳制：hold 上限 3 秒、本轮时间不够就少按 ─────────── */
section('⑤ 预算钳制 —— hold 上限 3 秒；这一轮时间不够就少按（下次再叫）')
{
  const a = mkBot({ inWater: true, air: 3 })
  const mcA = mkMc(a.bot)
  const rA = await mcA.swimUp({ hold: 99_999 })
  ok(rA.heldMs <= 10_400, 'hold:99999 也只按 10 秒（上限；2026-10-19 用户：swim 得真能动）', `${rA.heldMs}ms`)

  const b = mkBot({ inWater: true, air: 3 })
  const mcB = mkMc(b.bot)
  mcB.setCallDeadline(800)
  const rB = await mcB.swimUp()
  ok(rB.heldMs <= 700, '这一轮只剩 800ms → 只按 ~500ms（留 300ms 余量）', `${rB.heldMs}ms`)
  ok(rB.remaining === 1, '少按了也如实报 remaining:1')
}

/* ─────────── ⑥ dig 拒绝流体（水/岩浆挖不掉） ─────────── */
section('⑥ mc_dig 水/岩浆 —— 直接拒绝，并告诉它怎么出水')
{
  const { bot } = mkBot({ inWater: true, air: 4 })
  const mc = mkMc(bot)
  let err = null
  try { await mc.dig({ name: 'water', count: 1 }) } catch (e) { err = e }
  ok(Boolean(err), 'dig water 抛错（不白跑一趟）')
  ok(/流体，挖不掉/.test(String(err?.message ?? '')), '错误里写清"流体，挖不掉"')
  ok(/朝岸边/.test(String(err?.message ?? '')), '错误里指向"朝岸边 mc_move"（不再让人去叫已删除的 swim 模式）')

  let err2 = null
  try { await mc.dig({ name: 'lava', count: 1 }) } catch (e) { err2 = e }
  ok(/流体，挖不掉/.test(String(err2?.message ?? '')), 'lava 同样拒绝')

  // 别的方块不能被误伤（stone 找不到时是"附近找不到"，不是流体错误）
  let err3 = null
  let out3 = null
  try { out3 = await mc.dig({ name: 'stone', count: 1 }) } catch (e) { err3 = e }
  ok(!err3, 'dig stone 不抛错（没误伤正常采集）')
  ok(Array.isArray(out3) && out3.some((s) => /附近找不到 stone/.test(s)), 'stone 走正常流程', JSON.stringify(out3))
}

/* ─────────── ⑦ 在水里走路：绕开 pathfinder，直接 forward+jump 游 ─────────── */
section('⑦ 在水里走路 —— 绕开 pathfinder 直接游（实机 2.05~2.27 格/秒；A* 不把水当节点）')
{
  const TIMERS = []
  /**
   * 假 bot：带"游动模拟" —— 按住 forward 时按 2 格/秒朝**当前朝向**（lookAt 的目标）前进。
   * 这样测的是真逻辑（每 250ms 重新对准 + forward + jump），而不是我手写的假位移。
   */
  const mkWalker = ({ inWater = true, onGround = false, pos = [0, 60, 0], pathfinder = true, landAfter = null, gotoArrives = false } = {}) => {
    const calls = { control: [], lookAt: 0, goto: 0, stop: 0, setMovements: 0 }
    const bot = {
      entity: { position: new Vec3(pos[0], pos[1], pos[2]), isInWater: inWater, onGround, yaw: 0, pitch: 0, eyeHeight: 1.62 },
      game: { gameMode: 'survival' },
      registry: { itemsByName: {}, blocksByName: {}, items: {} },
      inventory: { items: () => [] },
      heldItem: null,
      blockAt: () => null,
      findBlocks: () => [],
      setControlState: (k, v) => calls.control.push([k, v]),
      lookAt: async (p) => { calls.lookAt++; bot.__aim = { x: p.x, y: p.y, z: p.z } },
      on: () => bot,
      removeListener: () => {},
      __aim: null,
    }
    if (pathfinder) {
      bot.pathfinder = {
        goto: async (goal) => { calls.goto++; if (gotoArrives && goal) bot.entity.position = new Vec3(goal.x, goal.y, goal.z) },
        stop: () => { calls.stop++ },
        setMovements: () => { calls.setMovements++ },
      }
    }
    const start = bot.entity.position.clone()
    const held = (k) => calls.control.some(([kk, vv]) => kk === k && vv === true && !calls.control.some(([k2, v2]) => k2 === k && v2 === false && calls.control.indexOf([k2, v2]) > calls.control.indexOf([kk, vv])))
    const forwardHeld = () => {
      let on = false
      for (const [k, v] of calls.control) if (k === 'forward') on = v
      return on
    }
    TIMERS.push(setInterval(() => {
      if (!forwardHeld()) return
      const aim = bot.__aim
      if (!aim) return
      const p = bot.entity.position
      const dx = aim.x - p.x, dz = aim.z - p.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) return
      const step = Math.min(0.2, d)                     // 0.2 格 / 100ms = 2 格/秒
      bot.entity.position = new Vec3(p.x + (dx / d) * step, p.y, p.z + (dz / d) * step)
      // 游出 landAfter 格就算上岸（模拟"到了岸边、脚下是地"）
      if (landAfter != null && start.distanceTo(bot.entity.position) >= landAfter) {
        bot.entity.isInWater = false; bot.entity.onGround = true
      }
    }, 100))
    return { bot, calls }
  }
  const heldAt = (calls, key) => {
    let on = false
    for (const [k, v] of calls.control) if (k === key) on = v
    return on
  }

  // ① 水里游到 4 格外的目标：不走 pathfinder、forward+jump、到点松手
  {
    const { bot, calls } = mkWalker({ inWater: true })
    const mc = mkMc(bot)
    mc.pfReady = true
    mc._pf = { goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } }, Movements: class { constructor() {} } }
    const t0 = Date.now()
    const r = await mc.walkTo({ x: 0, y: 60, z: 4 }, { arrive: 1.6, budget: 4000 })
    const ms = Date.now() - t0
    ok(r.arrived === true, '游到了（arrived:true）', JSON.stringify({ arrived: r.arrived, moved: r.moved, ms: r.ms }))
    ok(r.via === 'swim', 'via=swim（走的是直接游那条）', String(r.via))
    ok(calls.goto === 0, '**一次都没调 pathfinder.goto**（A* 在水里没用）', `goto=${calls.goto}`)
    ok(calls.lookAt >= 2, '反复重新对准（水流/撞岸会把朝向推偏）', `lookAt=${calls.lookAt}`)
    ok(calls.control.some(([k, v]) => k === 'forward' && v === true) && calls.control.some(([k, v]) => k === 'jump' && v === true),
      '按住 forward + jump（jump 是浮在水面，不是跳）')
    ok(!heldAt(calls, 'forward') && !heldAt(calls, 'jump'), '结束时松开 forward/jump（不留按键卡住）')
    ok(ms < 3000, '4 格的水里路 ~1.2 秒游完（2 格/秒）', `${ms}ms`)
  }

  // ② 连 pathfinder 都没有也照样能游（水里的移动不依赖它）
  {
    const { bot, calls } = mkWalker({ inWater: true, pathfinder: false })
    const mc = mkMc(bot)
    mc.pfReady = false
    const r = await mc.walkTo({ x: 0, y: 60, z: 3 }, { arrive: 1.6, budget: 4000 })
    ok(r.arrived === true && r.via === 'swim', '没挂 pathfinder 也能游到（不再报 pathfinder-unavailable）', JSON.stringify({ via: r.via, arrived: r.arrived }))
    ok(calls.control.length > 0, '确实按了控制位', `control=${calls.control.length}`)
  }

  // ③ 游到岸边 → 交给 pathfinder 走完剩下的
  {
    const { bot, calls } = mkWalker({ inWater: true, landAfter: 3, gotoArrives: true })
    const mc = mkMc(bot)
    mc.pfReady = true
    mc._pf = { goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } }, Movements: class { constructor() {} } }
    const r = await mc.walkTo({ x: 0, y: 60, z: 30 }, { arrive: 1.6, budget: 6000 })
    ok(r.swam === true, '如实标注"先游了一段"（swam:true）', JSON.stringify({ swam: r.swam, swimMoved: r.swimMoved }))
    ok(r.swimMoved > 0, '报出游了多少格（swimMoved）', String(r.swimMoved))
    ok(calls.goto === 1, '上岸后交回 pathfinder（goto 调了 1 次）', `goto=${calls.goto}`)
    ok(r.via === 'pathfinder' && r.arrived === true, '最终按 pathfinder 的结果返回', JSON.stringify({ via: r.via, arrived: r.arrived }))
  }

  // ④ 这一轮时间不够：如实报"还在水里" + 再叫一次
  {
    const { bot, calls } = mkWalker({ inWater: true })
    const mc = mkMc(bot)
    mc.pfReady = true
    mc._pf = { goals: { GoalNear: class {} }, Movements: class { constructor() {} } }
    mc.setCallDeadline(800)
    const t0 = Date.now()
    const r = await mc.walkTo({ x: 0, y: 60, z: 60 }, { arrive: 1.6, budget: 10_000 })
    const ms = Date.now() - t0
    ok(ms < 1500, '到点就返回（不硬耗到 10 秒）', `${ms}ms`)
    ok(r.arrived === false && r.reason === 'swim-budget', 'reason=swim-budget', String(r.reason))
    /* 🔴 2026-10-18 审计：预算用完不再等于 stuck（只是"这次没游到"）——
     *    以前 `stuck: !outOfWater` 让正常游泳也被交去自救。 */
    ok(r.stuck === false && r.remaining > 0, '预算用完不算 stuck（只是这次没游到）+ remaining',
      JSON.stringify({ stuck: r.stuck, remaining: r.remaining }))
    ok(/再叫一次 mc_move/.test(String(r.hint ?? '')), 'hint 教它"再叫一次 mc_move 接着游"')
    ok(!heldAt(calls, 'forward') && !heldAt(calls, 'jump'), '超时也松开控制位')
  }

  // ⑤ 不在水里：直接走 pathfinder，别乱按 forward
  {
    const { bot, calls } = mkWalker({ inWater: false, gotoArrives: true })
    const mc = mkMc(bot)
    mc.pfReady = true
    mc._pf = { goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } }, Movements: class { constructor() {} } }
    const r = await mc.walkTo({ x: 0, y: 60, z: 3 }, { arrive: 1.6, budget: 4000 })
    ok(r.swam === undefined && r.via === 'pathfinder', '陆地上还是走 pathfinder（没被游泳逻辑抢走）', String(r.via))
    ok(calls.lookAt === 0 && !calls.control.some(([, v]) => v === true), '陆地上一格控制位都没按下去（只可能松开）', `lookAt=${calls.lookAt} control=${calls.control.length}`)
  }

  for (const t of TIMERS) clearInterval(t)
}

/* ─────────── ⑧ 静态接线（防止以后被改回去） ─────────── */
section('⑧ 静态接线：core / index 都在')
{
  const src = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const core = strip(src)
  const index = strip(idx)
  const autoSrc = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))

  /* 🔴 第三十五刀：`jump` / `swimUp` 整段搬进 `src\movement.mjs`（那边去掉 2 格缩进、`this.` → `self.`、
   *    `#beginMove()` → `ctx.bumpGen()`）⇒ 这一组判据改查新模块，core 那边只留"薄包装 + 确实导入了"。 */
  const movSrc = strip(readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8'))
  ok(/export async function swimUp \(self, \{ hold = 3_000 \} = \{\}, ctx = \{\}\)/.test(movSrc), 'movement.mjs 有 swimUp(self, {hold=3000}, ctx)')
  ok(/b\.setControlState\('jump', true\)/.test(movSrc), 'swimUp 里按住 jump')
  /* 🔴 2026-10-24 全量体检：`bot.oxygenLevel` 是 `Math.round(air_supply / 15)`，满值 **20**。
   *    曾经误写成 `airNow <= 120`（拿 air_supply 的 300 量程去比 oxygenLevel）⇒ 对 0–20 恒真，
   *    只要脚泡水、脚不着地，每次 walkTo 都先白上浮 1.2 秒，还顺带 bumpGen 掐掉自己。钉住单位。 */
  ok(/airNow <= 8/.test(movSrc), '换气阈值按 oxygenLevel 的 0–20 量程写（<= 8，约 40%）')
  ok(!/airNow <= 120/.test(movSrc), '没有再用 air_supply 的量程（120）去比 oxygenLevel')
  /* 🔴 2026-10-24 实机（用户：「在水里会被水草挡住」）：海草/海带那格不是 water，
   *    以前 inWaterNow 三条判据全不成立 ⇒ 站在水草里被当成"在陆地上"，原地卡死。
   *    钉住三处：isWaterLike 存在、inWaterNow 用它、出口搜索也把它当水。 */
  const obsSrc = strip(readFileSync(new URL('../src/world-observer.mjs', import.meta.url), 'utf8'))
  const wnavSrc = strip(readFileSync(new URL('../src/water-navigation.mjs', import.meta.url), 'utf8'))
  const bnSrc = strip(readFileSync(new URL('../src/block-names.mjs', import.meta.url), 'utf8'))
  ok(/export const isWaterLike =/.test(bnSrc), 'block-names 有 isWaterLike（水 + 水里植物）')
  ok(/seagrass\|tall_seagrass\|kelp\|kelp_plant/.test(bnSrc), '名单里含海草/高海草/海带')
  ok(/if \(isWaterLike\(eye\)\) return true/.test(obsSrc), 'inWaterNow 眼高格用 isWaterLike')
  ok(/return isWaterLike\(n\)/.test(obsSrc), 'inWaterNow 脚格用 isWaterLike')
  ok(/isWaterLike\(n\) \|\| isLiquid\(n\)\) return 'water'/.test(wnavSrc), '出口搜索把水草当水（不再是墙）')
  /* 🔴 2026-10-08 第十刀：`#inWaterNow` 搬进 `src/world-observer.mjs`（改名 `inWaterNow`）
   *    ⇒ 调用点变成 `inWaterNow(b)`，判据要跟着改，并确认 movement.mjs 真的导入了。 */
  ok(/if \(!inWaterNow\(b\)\) break/.test(movSrc), '出水就 break（走 inWaterNow）')
  /* 2026-10-27 放宽：岩浆里也允许上浮 ⇒ 判据变成 `!inWaterNow(b) && !inLava`。
   * 断言的本意是"先看自己在不在水里"，别把参数表钉死。 */
  ok(/if \(!inWaterNow\(b\)(?: && !inLava)?\) \{\r?\n[\s\S]{0,200}?return \{ inWater: false/.test(movSrc),
    'swimUp 开头就用 inWaterNow 判断"我在不在水里"（以前只看 isInWater ⇒ 泡水柱里回"我本来就没在水里"）')
  ok(/from '\.\/world-observer\.mjs'/.test(movSrc), 'movement.mjs：观察层从 world-observer.mjs 导入')
  ok(/export function inWaterNow \(b\)/.test(strip(readFileSync(new URL('../src/world-observer.mjs', import.meta.url), 'utf8'))),
    'world-observer：inWaterNow 在新模块里（第十刀搬过去的）')
  ok(!/if \(!e\?\.isInWater\) \{\r?\n      return \{ inWater: false/.test(movSrc), 'swimUp 不再只看 entity.isInWater')
  /* 2026-10-19：中间插了"窒息判据"那段（2026-10-18 修误报），原来 1200 字符的窗口不够了 ——
     * 放宽到 4000，断言的本意只是"先算 submerged 再合成 inWater"，不是钉住中间那段长度。 */
  ok(/const submerged = submergedIn\(b, e\)[\s\S]{0,4000}const inWater = submerged \|\| Boolean\(e\?\.isInWater\)/.test(autoSrc),
    'mc_auto 的憋气判据以"头在水下"为主（以前 isInWater 读不到就整条分支不执行）')
  ok(/submergedIn = \(b, e\) => \{\r?\n  try \{\r?\n    if \(!e\?\.position\) return false/.test(autoSrc),
    'mc_auto 的 submergedIn 不再要求 e.isInWater')
  ok(/rose >= 0\.4 && a != null && a >= 20/.test(movSrc), '头露出水面 + 氧气回升也 break')
  ok(/self\.callLeft\(\)[\s\S]{0,700}left - 300/.test(movSrc), 'swimUp 给这一轮留 300ms 余量')
  /* 🔴 2026-10-08 第四份审计报告 ①④⑧：swimUp 以前不认中断、预算归零白送 200ms、`hold:0` 被当 3000。 */
  ok(/if \(self\.abortSignal\?\.aborted\) throw abortError\('上浮'/.test(movSrc), 'swimUp 认中断')
  ok(/raceAbort\(sleep\(100\), self\.abortSignal, '上浮'\)/.test(movSrc), 'swimUp 的 sleep 可中断')
  ok(/const gen = bumpGen\(\)/.test(movSrc) && /if \(self\._moveGen !== gen\) \{ preempted = true; break \}/.test(movSrc),
    'swimUp 领 _moveGen 号、被接管就让位')
  ok(/if \(self\._moveGen === gen\) \{ try \{ b\.setControlState\('jump', false\) \}/.test(movSrc), 'swimUp 只在还是自己时松 jump')
  ok(!/Math\.max\(200, Math\.min\(Number\(hold\)/.test(movSrc), '预算归零时不再白送 200ms')
  ok(/Number\.isFinite\(Number\(hold\)\) \? Number\(hold\) : 9_000/.test(movSrc), 'hold:0 不再被当成 9000（默认值只给 NaN）')
  /* 第三十五刀接线：core 那边只剩薄包装，私有 `#beginMove` 靠 `ctx.bumpGen` 递进去（迁移规矩第 28 条）。 */
  ok(/from '\.\/movement\.mjs'/.test(core), 'core：movement 从 movement.mjs 导入')
  ok(/async jump \(\) \{ return await jumpImpl\(this, \{ bumpGen: \(\) => this\.#beginMove\(\) \}\) \}/.test(core), 'core 的 jump 是薄包装')
  ok(/async swimUp \(opts = \{\}\) \{ return await swimUpImpl\(this, opts, \{ bumpGen: \(\) => this\.#beginMove\(\) \}\) \}/.test(core), 'core 的 swimUp 是薄包装')
  /* 🔴 第二十二刀：步骤分发（`#runStep`）搬进 `src\sequence.mjs` ⇒ 改成查新模块（那边是 `self.`）。 */
  const seqSrc = strip(readFileSync(new URL('../src/sequence.mjs', import.meta.url), 'utf8'))
  ok(/case 'swim':/.test(seqSrc) && /self\.walkTo\(s, \{ budget: callBudget\(s\.budgetMs\) \}\)/.test(seqSrc) && /self\.swimUp\(s\)/.test(seqSrc),
    'sequence.mjs 的 op 里有 swim（给坐标=游过去并带上步骤的 budgetMs，不给=上浮）')
  // 🔴 水里不能用 pathfinder（它的 A* 明确拒绝水节点，见 #walkSwim 的注释）
  // 路线图第 ④ 条第三十六刀：`walkTo` / `#walkSwim` 的函数体已搬进 `src\movement.mjs`（core 只剩薄包装）。
  ok(/export async function walkSwim \(self, target, \{ arrive = 1\.6, budget = self\.cfg\.moveBudgetMs, intent = 'near' \} = \{\}, ctx = \{\}\)/.test(movSrc), 'movement.mjs 有 walkSwim（直接游）')
  ok(/if \(inWaterNow\(b\) && b\.entity\?\.onGround !== true\) \{/.test(movSrc) && /const swim = await walkSwim\(self, target, \{ arrive, budget, intent \}, ctx\)/.test(movSrc), 'walkTo 在水里（悬空）先走 walkSwim；站实地上交给 pathfinder')
  ok(/return \{ \.\.\.rest, swam: true, swimMoved: swim\.moved, swimMs: swim\.ms \}/.test(movSrc), '上岸后交回 pathfinder（并标注 swam/swimMoved）')
  ok(/via: 'swim'/.test(movSrc), 'walkSwim 返回 via:swim')
  ok(/b\.setControlState\('forward', true\)/.test(movSrc) && /const wantJump = jumpOverride === null \? swimJumpWanted\(/.test(movSrc), 'walkSwim 按 forward，并按目标高度决定要不要上浮（不再死按 jump）')
  ok(/const reason = outOfWater \? 'swim-shore' : \(stuckWhy \?\? 'swim-budget'\)/.test(movSrc), '如实区分"上岸了" / "这一轮用完了" / "这段游不过去"')
  ok(/from '\.\/movement\.mjs'/.test(core), 'core 确实从 movement.mjs 导入（搬走 + 忘接 = 假绿）')
  /* 路线图第 ④ 条第四十刀：`dig()` 已搬进 `src\mining.mjs`。 */
  const mineSrc = strip(readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8'))
  ok(/const fluid = name \?\?/.test(mineSrc) && /if \(fluid && isLiquid\(fluid\)\)/.test(mineSrc)
    && /from '\.\/mining\.mjs'/.test(core), 'dig() 先拒流体（实现已搬到 src\\mining.mjs）')
  /* 路线图第 ④ 条第十三刀：`status()` 已搬进 `src/status.mjs` —— 下面五条改查那个文件。 */
  const stSrc = strip(readFileSync(new URL('../src/status.mjs', import.meta.url), 'utf8'))
  /* 2026-10-24 实机：陆地/矿洞里报出「氧气 -1」—— 残留值 + 负数。现在只在头真的在水下时报、夹到 0 以上。 */
  ok(/air: airNow/.test(stSrc) && /const airNow = submergedNow && Number\.isFinite\(b\.oxygenLevel\)/.test(stSrc)
    && /Math\.max\(0, Math\.round\(Number\(b\.oxygenLevel\)\)\)/.test(stSrc), 'status() 报氧气 air（只在头在水下时报，夹到 0 以上）')
  // 🔴 实机（2026-10-07）：`bot.oxygenLevel` 只在头入水后才有读数（水面上是 null）⇒ 判据要有"头在水下"
  ok(/const submergedNow = \(\(\) => \{/.test(stSrc) && /submerged: submergedNow/.test(stSrc), 'status() 报"头在水下"submerged（氧气读不到时的可靠判据）')
  ok(/b\.entity\.position\.offset\(0, b\.entity\.eyeHeight \?\? 1\.62, 0\)/.test(stSrc), 'submerged 用眼睛那一格算')
  ok(/return isLiquid\(b\.blockAt\(eye\)\?\.name\)/.test(stSrc), 'submerged = 眼睛那格是液体')
  ok(!/if \(!b\.entity\.isInWater\) return false/.test(stSrc), 'status().submerged 不再先要求 entity.isInWater（泡水柱时它会漏报）')

  /* 🔴 2026-10-27（用户 m05868：「把 mode swim 去掉」）：mc_move 不再有 swim 分支 ——
   *   给坐标本来就等于 walkTo（水里自动游），不给坐标的上浮换气由游泳循环自己保。 */
  ok(!/mode === 'swim'/.test(index), 'index.js 的 mc_move 已经没有 swim 分支了')
  ok(!/sess\.bot\.swimUp\(\{ hold: callBudget/.test(index), 'index.js 里不再有"只上浮"的分支（上浮由 walkSwim 自己按 jump）')
  /* 2026-10-15：walkTo 的返回值现在过 `withOutcome(..., { expect: 'moved' })`（结果台账要判得动）。 */
  ok(/walkWithAutoDig\(sess, target, \{ allowDig,[^}]*?noTower: args\.allowTower !== true[^}]*?intent: intentArgOf\(args\.intent\)[^}]*?waterRecover: typeof args\.waterRecover === 'boolean'[^}]*?xz: wantsXZ \}/.test(index), 'walk 仍走 walkWithAutoDig（走不通改成挖；自救开关透传）')
  ok(/在水里会自动改成"直接游"/.test(index), 'mc_move 描述里写明"在水里自动直接游"')
  ok(/在水里（氧气/.test(index), 'mc_status 瘦身视图里带氧气')
  ok(/头在水下/.test(index), 'mc_status 读不到氧气时也说清"头在水下"')
  ok(!/mode="swim"/.test(index), 'mc_move 描述里不再出现 swim')
  ok(/walk \/ fly \/ jump \/ boat/.test(index) && !/walk \/ fly \/ jump \/ swim/.test(index), 'mode 说明改成 walk / fly / jump / boat')
  ok(!/walk \/ walk-nodig \/ fly/.test(index) && !/mode === 'walk-nodig'/.test(index),
    '`mode:"walk-nodig"` 已删除（2026-10-25 用户要求，和"不许挖"重复 —— 现在就是 `allowDig:false` 这个默认）')

  const auto = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))
  ok(/const DROWN_WAKE_GAP_MS = 6_000/.test(auto), 'mc_auto 有憋气叫醒间隔')
  // 氧气只当"加速器"：必须 `submerged`（头真在水下）或"读数正在往下掉"（真的在憋气）才算 ——
  // 读数可能是旧的（潜过水后站在浅水里还是 0/-1，实机 2026-10-07 误报过两次）
  ok(/const byAir = air != null && \(submerged \|\| draining\) && \(air <= DROWN_AIR/.test(auto),
    'mc_auto 有氧气的判据（读得到才用，而且必须头在水下或读数在掉）')
  ok(/const draining = air != null && s\.lastAir != null && air < s\.lastAir/.test(auto),
    'mc_auto 会拿上一次读数比（判断气是不是真的在掉）')
  ok(/const submergedIn = \(b, e\) =>/.test(auto), 'mc_auto 有"头在水下"判据')
  ok(/const DROWN_SUBMERGE_MS = 10_000/.test(auto), '头在水下 10 秒出声')
  ok(/drown: true, air, submerged, subSec/.test(auto), '叫醒时带上 drown/air/submerged/subSec')
  ok(/这不是被打/.test(auto) && /多半不是被打/.test(auto), '文案写清"不是被打"（读不到氧气时是"多半"）')
  ok(/水\/岩浆是\*\*流体，挖不掉\*\*/.test(auto), '文案里点明水挖不掉')
}

/* ═══════════ ⑧ 分水域控制 + 有效进度检测（用户 2026-10-17 方案） ═══════════
 * 用户实机点出两件事：
 *   ① 水面游和水下游用同一套控制（一直按住 jump）⇒ 目标在水下时永远下不去；
 *   ② 循环里没有"这一段时间到底有没有**靠近**目标"的判据 —— `moved` 报的是总位移。
 * 这里钉住三件事：按目标高度决定上浮 / 连续没靠近就收手 / 别把"总位移"当进展。 */
section('⑧ 游泳：按目标高度决定上浮 + 连续没靠近就收手')
{
  const M = await import(new URL('../src/movement.mjs', import.meta.url))
  const { walkSwim, swimJumpWanted, SWIM_WINDOW_MS, SWIM_STALL_WINDOWS, SWIM_FIXUPS } = M

  /* 用户建议的窗口是 500–750ms —— 钉住这个范围，别哪天被改成 5 秒或 50ms */
  ok(SWIM_WINDOW_MS >= 500 && SWIM_WINDOW_MS <= 750, `观测窗口 ${SWIM_WINDOW_MS}ms 落在用户建议的 500–750ms 内`)
  ok(SWIM_STALL_WINDOWS >= 2, '连续 ≥2 个窗口没进展才算卡住（别一个窗口就下结论）')
  ok(SWIM_FIXUPS >= 1, '纠偏至少试一次再放弃')

  const me = { y: 60 }
  ok(swimJumpWanted({}, { y: 62 }, me, 20) === true, '目标在上面 ⇒ 上浮')
  ok(swimJumpWanted({}, { y: 60 }, me, 20) === true, '同一层 ⇒ 还是按着（水里不按每秒沉约 2 格）')
  /* 🔴 2026-10-30 用户：「在水下不应该恒上浮，y 大于当前位置才上浮」——
   *    判据变成：更高/同层 ⇒ 浮着；更低 ⇒ **只有那格真是水**才松手沉下去；
   *    更高但读不出方块（假 bot / 区块没加载）⇒ 保守上浮，不会一路沉。 */
  const botWater = { blockAt: () => ({ name: 'water' }) }
  const botStone = { blockAt: () => ({ name: 'stone' }) }
  ok(swimJumpWanted({}, { y: 55 }, me, 20) === true,
    '目标更低但那格**不是水**（读不到/岸上那格的 y）⇒ 仍然上浮（不一路沉）')
  ok(swimJumpWanted(botWater, { y: 55 }, me, 20) === false,
    '🔴 目标更低且那格真是水 ⇒ 松手沉下去（这才是"潜到水下"）')
  ok(swimJumpWanted(botStone, { y: 55 }, me, 20) === true,
    '目标更低、那格是石头（AI 猜的 y）⇒ 上浮，不拿头去撞地')
  ok(swimJumpWanted(botWater, { y: 55 }, me, 4) === true,
    '🔴 目标是水下的，但快没气了 ⇒ 先上去换气（命比目标重要）')
  ok(swimJumpWanted(botWater, { y: 60 }, me, 20) === true,
    '目标在水里且**同层** ⇒ 还是按着（横渡不按每秒沉 2 格）')
  ok(swimJumpWanted({}, { y: 55 }, me, 4) === true, '🔴 快没气了 ⇒ 不管目标在哪都先上去')
  ok(swimJumpWanted({}, { y: 60 }, null, 20) === true, '读不到自己的位置 ⇒ 保守上浮（别乱沉）')
  /* 用户 2026-10-30：「要到水下如果没关 auto 的自动上浮，要提醒」——
   *   autoFloat 每 500ms 把人顶回水面，跟"目标更低就沉下去"打架。这里只查**契约**：
   *   `mc_auto` 把开关挂到 b.__mcAutoFloat、游泳段读到就提醒，而且**不替用户关**。 */
  const movSrc0 = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const autoSrc0 = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
  ok(/b\.__mcAutoFloat = beh\.autoFloat !== false/.test(autoSrc0),
    'mc_auto 把 autoFloat 开着没有挂到 b.__mcAutoFloat 上')
  ok(/diveGoal && b\.__mcAutoFloat === true/.test(movSrc0),
    '游泳段：目标是水下 + autoFloat 还开着 ⇒ 触发提醒')
  ok(/autoFloatBlocking: true/.test(movSrc0) && /autoFloat":false/.test(movSrc0),
    '提醒里给出关法（mc_auto {set:{"autoFloat":false}}），但**不自己关**')

  /** 自带的假 bot：`forward` 按住时按 2 格/秒朝 aim 走（y 不变）；`frozen` = 一格都不动。 */
  const mkSwimBot = ({ frozen = false, pos = [0, 60, 0] } = {}) => {
    const calls = { control: [], lookAt: 0 }
    const bot = {
      entity: { position: new Vec3(pos[0], pos[1], pos[2]), isInWater: true, onGround: false, yaw: 0, pitch: 0, eyeHeight: 1.62 },
      game: { gameMode: 'survival' },
      registry: { itemsByName: {}, blocksByName: {}, items: {} },
      inventory: { items: () => [] },
      heldItem: null,
      blockAt: () => null,
      findBlocks: () => [],
      setControlState: (k, v) => calls.control.push([k, v, Date.now()]),
      lookAt: async (p) => { calls.lookAt++; bot.__aim = { x: p.x, y: p.y, z: p.z } },
      on: () => bot, removeListener: () => {},
      __aim: null,
    }
    let timer = null
    if (!frozen) {
      timer = setInterval(() => {
        const last = calls.control.filter(([k]) => k === 'forward').slice(-1)[0]
        if (!last || last[1] !== true || !bot.__aim) return
        const p = bot.entity.position
        const dx = bot.__aim.x - p.x, dz = bot.__aim.z - p.z
        const d = Math.hypot(dx, dz)
        if (d < 0.05) return
        const step = Math.min(0.2, d)
        bot.entity.position = new Vec3(p.x + (dx / d) * step, p.y, p.z + (dz / d) * step)
      }, 100)
    }
    return { bot, calls, stop: () => { if (timer) clearInterval(timer) } }
  }
  const mkCtx = (mc) => ({ beginMove: () => ++mc._moveGen, releaseControls: () => {} })

  // ① 目标在水下 4 格 ⇒ 也照样按 jump 浮着（2026-10-27 用户：「一直浮在水面」）
  {
    const { bot, calls, stop } = mkSwimBot({ pos: [0, 60, 0] })
    const mc = mkMc(bot)
    const t0 = Date.now()
    const r = await walkSwim(mc, { x: 0, y: 56, z: 3 }, { arrive: 1.6, budget: 6000 }, mkCtx(mc))
    stop()
    /* 注意：现在每轮无条件写 `jump`（控制位会被寻路器/反射层清掉，只在变化时写就会漏），
     * 所以第一次上浮一定发生在很靠前 —— 这里钉的就是"一上来就浮着"。 */
    const ups = calls.control.filter(([k, v]) => k === 'jump' && v === true)
    const firstUpAt = ups.length ? ups[0][2] - t0 : null
    ok(firstUpAt !== null && firstUpAt < 500,
      '🔴 目标在水下也一上来就按 jump（默认一直浮在水面，不再为了下沉而放弃上浮）',
      `第一次上浮在 ${firstUpAt}ms`)
    ok(r.via === 'swim' && r.arrived === false, '没游到就如实报没游到', JSON.stringify({ via: r.via, arrived: r.arrived }))
  }

  // ② 一格都不动 ⇒ 连续两个窗口没靠近就该收手，别把整轮预算耗光
  {
    const { bot, calls, stop } = mkSwimBot({ frozen: true })
    const mc = mkMc(bot)
    const t0 = Date.now()
    const r = await walkSwim(mc, { x: 0, y: 60, z: 8 }, { arrive: 1.6, budget: 8000 }, mkCtx(mc))
    const ms = Date.now() - t0
    stop()
    ok(r.reason === 'swim-stuck', '🔴 连续没靠近 ⇒ reason = swim-stuck（不是含糊的 swim-budget）', String(r.reason))
    ok(r.stuck === true, 'stuck:true（上层据此交给水下自救）')
    ok(r.fixups >= 1, '先纠偏过（把上浮/下沉反过来试）', String(r.fixups))
    ok(ms < 7000, '不用等满 8 秒预算就收手', `${ms}ms`)
    ok(/别再往这个方向硬游/.test(r.hint ?? ''), 'hint 明确劝"别再往这个方向硬游"', String(r.hint).slice(0, 60))
    ok(calls.control.length > 0, '确实按过控制位（不是空转）')
  }

  // ③ 一直在靠近 ⇒ 不许误报卡住（"别过度调整"）
  {
    const { bot, calls, stop } = mkSwimBot({ pos: [0, 60, 0] })
    const mc = mkMc(bot)
    const r = await walkSwim(mc, { x: 0, y: 60, z: 4 }, { arrive: 1.6, budget: 6000 }, mkCtx(mc))
    stop()
    ok(r.arrived === true, '有进展就一路游到（不纠偏、不收手）', JSON.stringify({ arrived: r.arrived, ms: r.ms }))
    ok(r.fixups === undefined, '没有纠偏记录（说明一次都没误判）', String(r.fixups))
    ok(calls.lookAt >= 2, '还是每 250ms 重新对准', `lookAt=${calls.lookAt}`)
  }

  // ④ 静态：判据必须是"离目标变近"，不是"总位移"；且必须用**等完之后**的采样
  {
    const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
    ok(/const gained = winLeft - nowLeft/.test(src), '🔴 窗口判据是"离目标变近了没有"（不是总位移）')
    ok(!/const gained = .*start\.distanceTo/.test(src), '🔴 绝不用 `start.distanceTo` 当进展（被水推着横漂也是位移）')
    /* 🔴 2026-10-17 复审：原来窗口用的是循环开头那个 `me`，而 `me` 只是 `b.entity.position`
     *    的**引用** —— 靠"物理 tick 原地改这个 Vec3"才碰巧读得到新坐标。一旦位置被换成新对象
     *    （传送就是），读到的是 250ms 之前的旧坐标，`gained` 恒 0 ⇒ 明明在靠近也判"没进展"。
     *    这里钉两件事：① 采样必须在 `await sleep(250)` **之后**；② 采样必须 `clone()` 下来。 */
    ok(/const sample = b\.entity\?\.position\?\.clone\?\.\(\)/.test(src),
      '🔴 窗口进度用**快照**采样（不靠"别人会原地改这个对象"）')
    ok(/const nowLeft = sample\.distanceTo\(goal\)/.test(src), '`nowLeft` 由快照算出')
    const iSleep = src.indexOf("await raceAbort(sleep(250), self.abortSignal, '游泳')")
    const iSample = src.indexOf('const sample = b.entity?.position?.clone?.()')
    ok(iSleep > 0 && iSample > iSleep, '🔴 采样在"等 250ms"**之后**（等之前采的样是旧坐标）')
    ok(!/winLeft - me\.distanceTo\(goal\)/.test(src), '旧的"拿循环开头那个 me 算进度"写法已消失')
    ok(/if \(fixups < SWIM_FIXUPS\)/.test(src) && /jumpOverride = !wantJump/.test(src), '纠偏 = 把上浮/下沉反过来试一轮')
    ok(/stuckWhy = 'swim-stuck'/.test(src), '纠偏用尽 ⇒ 记 swim-stuck 收手')
  }
}

/* ─────────── ⑨ 头顶封死：立刻说清，别白按 jump ─────────── */
/* 2026-10-25 实机（用户：「我看它基本没浮起来，自救没用了？」）：以前头顶是实心方块时
 * 照样按满 hold 的 jump，rose 恒 0，最后只回"没上去" —— AI 只能自己猜"头顶哪格挡着"。 */
section('⑨ 头顶封死 —— 立刻返回 ceiling，一次 jump 都不按')
{
  const { bot, calls } = mkBot({ inWater: true, air: 6, y: 53 })
  bot.blockAt = () => ({ name: 'stone', position: new Vec3(0, 54, 0) })
  const mc = mkMc(bot)
  const t0 = Date.now()
  const r = await mc.swimUp({ hold: 3_000 })
  const ms = Date.now() - t0
  ok(r.reason === 'ceiling', '返回 reason=ceiling', JSON.stringify(r.reason))
  ok(r.ceiling?.name === 'stone', '报出天花板方块名', JSON.stringify(r.ceiling))
  ok(r.rose === 0 && r.heldMs === 0, 'rose/heldMs 都是 0（没白按）')
  ok(!jumpOn(calls), '一次 jump 都没按')
  ok(ms < 500, '几乎立刻返回（不是等满 3 秒）', `${ms}ms`)
  ok(/上浮没路/.test(String(r.hint)) && /mc_act/.test(String(r.hint)), 'hint 说清"上浮没路"并给出挖开/挖空气袋的做法')
}
section('⑩ 头顶是水草/气泡柱 —— 不算封死，照常上浮')
{
  for (const nm of ['seagrass', 'kelp', 'bubble_column', 'water']) {
    const { bot, calls } = mkBot({ inWater: true, air: 6, y: 53, after: { ms: 120, inWater: false, air: 20, y: 55 } })
    bot.blockAt = () => ({ name: nm, position: new Vec3(0, 54, 0) })
    const mc = mkMc(bot)
    const r = await mc.swimUp({ hold: 1_000 })
    ok(r.reason !== 'ceiling' && jumpOn(calls), `${nm} 不当天花板（照常按 jump）`)
  }
}
section('⑪ 静态接线：ceiling 早退在 bumpGen 之前')
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const iCeil = src.indexOf("reason: 'ceiling'")
  const iBump = src.indexOf('const gen = bumpGen()', Math.max(0, iCeil))
  ok(iCeil > 0, 'movement.mjs 有 reason: ceiling 分支')
  ok(iBump > iCeil, '天花板检查在领移动号之前（不推代次、不打断别人）')
  ok(/const ceilingOf = \(\) =>/.test(src), '有 ceilingOf() 读头顶两格')
}

/* ─────────── ⑬ 岩浆里也能按 jump 上浮（🔴 2026-10-27 实机：掉在岩浆里动不了） ─────────── */
section('⑬ 岩浆里也允许上浮')
{
  /* 以前这里只认水：泡在岩浆里叫 `mc_move {mode:"swim"}` 会被回一句"我本来就没在水里"，
   * 于是一个真能救命的动作（岩浆里按 jump = 往上浮）被语义挡在门外，人只能沉底挨烧。 */
  const { bot, calls } = mkBot({ inWater: false, air: 20 })
  bot.entity.isInLava = true
  bot.blockAt = () => ({ name: 'lava' })
  const mc = mkMc(bot)
  const r = await mc.swimUp({ hold: 120 })
  ok(!/本来就没在水里/.test(String(r.note)),
    '🔴 岩浆里不再回"我本来就没在水里"', String(r.note))
  ok(jumpOn(calls) && jumpOff(calls),
    '🔴 岩浆里真的按住 jump（上浮）又松开', JSON.stringify(calls.control))

  /* 负例：既不在水里也不在岩浆里 ⇒ 仍然立刻返回（别为了岩浆把"不在水里"也放行） */
  const b2 = mkBot({ inWater: false, air: 20 })
  const mc2 = mkMc(b2.bot)
  const r2 = await mc2.swimUp()
  ok(r2.inWater === false && /本来就没在水里/.test(String(r2.note)),
    '陆地/空气里仍然立刻返回（不误按 jump）', String(r2.note))
}

/* ─────────── 收尾 ─────────── */
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
