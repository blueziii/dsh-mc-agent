/**
 * check-mc-auto.mjs —— 自主层（extensions/mc_auto.mjs）离线自检
 *
 * 不需要 MC、不需要 DSH：假 registry / 假会话 / 假 mineflayer bot + 假时钟，手动 tick。
 * 跑法：node dsh-mc-agent/tools/check-mc-auto.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuto } from '../extensions/mc_auto.mjs'

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) pass++
  else fails.push(`${name}${extra ? ` — ${extra}` : ''}`)
}
const flush = () => new Promise((r) => setTimeout(r, 10))
const section = (t) => console.log(`\n── ${t} ──`)

// 本套件会建临时目录（记忆根覆盖那一段）；跑完统一清掉，别往 %TEMP% 里堆。
// 以前每跑一次留 2 个目录，堆到过 100+ 个。想留现场看内容就加 --keep。
const tmpDirs = []

/* ───────────────────────── 假世界 ───────────────────────── */

const mkP = (x, y, z) => ({
  x, y, z,
  offset (dx, dy, dz) { return mkP(x + dx, y + dy, z + dz) },
  distanceTo (o) { return Math.hypot(x - o.x, y - o.y, z - o.z) },
})

const mkWorld = ({
  pos = [10.5, 64, 20.5], yaw = 1.0, pitch = 0.2, ground = 63, overrides = {},
  // 逐格指定 `block.boundingBox`（'block' / 'partial' / 'empty'）。默认仍按老规矩
  // `air → 'empty'`、其余 `'block'`；只在需要模拟"碰撞盒和方块名不一致"时用（2026-10-22 窒息误报）
  bbOverrides = {},
  items = [], players = [], mobs = [], drops = [], online = true, food = 20, health = 20, thrown = null,
  noPlugins = false,
  // 憋气（溺水）：`air` 是氧气 0–20（`bot.oxygenLevel`；1.21.9/1.21.10 的真服上读不到 ⇒ null），
  // `inWater` 对应 `entity.isInWater`，`submerged` = 眼睛那一格是水（头在水下）
  inWater = false, air = 20, submerged = false,
} = {}) => {
  const calls = {
    look: [], lookAt: [], controls: [], swings: 0, equips: [], consumes: 0,
    attacks: [],
    // 自保"先停手"用：core.mjs 的 interruptMove（自保叫醒时先停底下那件事；仍然不跑、不还手）
    interrupts: [],
    // 现成插件的桩：吃交给 mineflayer-auto-eat，捡交给 mineflayer-collectblock
    eats: { enabled: false, enables: 0, disables: 0, opts: null },
    collects: [],
    listeners: {},
  }
  const entity = { position: mkP(...pos), yaw, pitch, height: 1.8, width: 0.6, isInWater: inWater }
  // 头在水下：眼睛那一格（y + 1.6）返回 water，别的照旧
  const eyeKey = `${Math.floor(pos[0])},${Math.floor(pos[1] + 1.6)},${Math.floor(pos[2])}`
  const blockAt = (p) => {
    if (thrown === 'blockAt') throw new Error('blockAt 炸了')
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    if (submerged && k === eyeKey) return { name: 'water', boundingBox: 'empty' }
    const name = overrides[k] ?? (Math.floor(p.y) <= ground ? 'stone' : 'air')
    return { name, boundingBox: bbOverrides[k] ?? (name === 'air' ? 'empty' : 'block') }
  }
  const entities = { 1: entity }
  let id = 1
  for (const m of mobs) entities[++id] = { id, type: 'mob', name: m.name, kind: m.kind ?? 'Hostile mobs', position: mkP(...m.position) }
  /* 🔴 掉落物实体的字段按**真的**写：`minecraft-data`（1.21.9）里 `name: 'item'`、
   *    `displayName: 'Item'`，而 `type` 是 `'other'`（**不是 `'object'`**）——
   *    以前默认成 `'object'` 会让"只按 type 认掉落物"这种错法在套件里看不出来。 */
  for (const d of drops) entities[++id] = { id, type: d.type ?? 'other', name: d.name ?? 'item', displayName: d.displayName, position: mkP(...d.position) }
  const pl = {}
  for (const p of players) {
    pl[p.name] = {
      username: p.name,
      entity: { position: mkP(...p.position), yaw: p.yaw ?? 0, heldItem: p.held ? { name: p.held } : null },
    }
  }
  // 真 mineflayer 的 bot.players 里**也有自己** ⇒ 自主层必须跳过（否则会盯着自己看、把自己算成"旁边有人"）
  pl.me = { username: 'me', entity }
  pl.me_alias = { username: 'me', entity: { position: mkP(...pos), yaw, heldItem: null } }

  const raw = {
    entity,
    username: 'me', // 真 mineflayer 的 bot.username
    oxygenLevel: air, // 真 mineflayer 的 bot.oxygenLevel（0–20；溺水就靠它判断）
    world: { blockAt },
    blockAt, // 真 mineflayer 的 bot.blockAt(pos)；自主层找地面/看危险方块就靠它
    players: pl,
    entities,
    inventory: { items: () => { if (thrown === 'inventory') throw new Error('背包炸了'); return items } },
    look: (y, pi, f) => { calls.look.push({ yaw: y, pitch: pi, force: f }); return Promise.resolve() },
    lookAt: (p, f) => { calls.lookAt.push({ pos: p, force: f }); return Promise.resolve() },
    setControlState: (k, v) => { if (thrown === 'controls') throw new Error('控制炸了'); calls.controls.push([k, v]) },
    swingArm: () => { if (thrown === 'swing') throw new Error('挥手炸了'); calls.swings++ },
    equip: async (i) => { calls.equips.push(i) },
    consume: async () => { calls.consumes++ },
    // 现成插件（用户 2026-10-06：不要自己写）—— 桩只记录"被怎么用了"
    on: (ev, fn) => { (calls.listeners[ev] ??= []).push(fn) },
    ...(noPlugins ? {} : {
      autoEat: {
        get enabled () { return calls.eats.enabled },
        enableAuto () { calls.eats.enabled = true; calls.eats.enables++ },
        disableAuto () { calls.eats.enabled = false; calls.eats.disables++ },
        setOpts (o) { calls.eats.opts = o },
      },
      collectBlock: {
        collect: async (target, opts) => { calls.collects.push({ target, opts }); return true },
      },
    }),
  }

  const walks = []
  const fire = (ev, ...args) => { for (const fn of calls.listeners[ev] ?? []) fn(...args) }
  const mc = {
    online,
    bot: raw,
    status: () => {
      if (thrown === 'status') throw new Error('状态炸了')
      return { online, food, health, position: { x: Math.round(pos[0]), y: Math.round(pos[1]), z: Math.round(pos[2]) }, held: null, dimension: 'overworld', time: 6000 }
    },
    walkTo: (target, opts) => { if (thrown === 'walkTo') throw new Error('走路炸了'); walks.push({ target, opts }); return Promise.resolve(true) },
    jump: async () => { calls.controls.push(['jump', true]) },
    // core.mjs 的 McBot.interruptMove：抢占"当前这一次移动"（停 pathfinder + 松控制位）
    interruptMove: (why) => { calls.interrupts.push(why); return Promise.resolve(true) },
    // 打怪走的是 core.mjs 的 attack（内部用 mineflayer-pvp）
    attack: (args) => { calls.attacks.push(args); return Promise.resolve({ attacked: args?.who ?? '?' }) },
  }
  return { raw, mc, calls, walks, entities, fire, setHealth: (v) => { health = v } }
}

const mkAgent = (id = 'a1', status = 'idle') => ({ id, status, steers: [], steer (m) { this.steers.push(m) } })

const mkSess = (sid, mc, agent, { gate = null, lastWakeAt = 0 } = {}) => {
  const interrupts = []
  return {
    agentId: sid, bot: mc,
    watchdog: { agent, gate: gate ?? (() => true), lastWakeAt },
    interruptWait: (k) => interrupts.push(k),
    _interrupts: interrupts,
  }
}

const mkReg = (list) => ({
  // 真 registry.listSessions() 返回的是**摘要对象**（只有 agentId/online/watching…，没有 bot/watchdog），
  // 真会话要用 peek() 拿 —— 这里照抄真契约，免得自检比运行时宽松（踩过一次坑）。
  listSessions: () => list.map((s) => ({
    agentId: s.agentId,
    online: Boolean(s.bot?.online),
    mode: 'mc',
    watching: s.watchdog?.status?.() ?? null,
  })),
  peek: (id) => list.find((s) => String(s.agentId) === String(id)) ?? null,
})

/**
 * 时间类断言用的基线间隔。
 * 产品默认值先是 5s（用户 m02357），2026-10-18 审计后改成 10s；但"180s 才叫醒""61s 不叫"这类断言要的是**能分辨的刻度**，
 * 所以除了第 1 节（专门断言默认值）以外，其它小节都用这套基线，跟默认值解耦。
 */
const TIMING_BASE = { idleWakeSec: 180, idleWakeNearPlayerSec: 60, minIdleGapSec: 10 }

/** 造一个控制器 + 一个会话，返回常用句柄 */
const setup = ({ sid = 'a1', agentStatus = 'idle', world = {}, gate = null, lastWakeAt = 0, workspaceOf = null, memRootOf = null, rng = () => 0, patch = {}, timing = true } = {}) => {
  const w = mkWorld(world)
  const agent = mkAgent(sid, agentStatus)
  const sess = mkSess(sid, w.mc, agent, { gate, lastWakeAt })
  const reg = mkReg([sess])
  let T = 1_000_000
  const auto = createAuto({ registry: reg, rng, now: () => T, workspaceOf, memRootOf, logLine: () => {} })
  auto.cfgFor(agent)
  // 2026-10-18：产品默认模式改成 ai-led（反射层不再自己吃/捡/穿/跟/环顾）。
  // 下面这些断言测的是**旧反射层的行为细节**，所以夹具默认跑 legacy；测模式的用例自己传 mode。
  const p = { mode: 'legacy', ...(timing ? TIMING_BASE : {}), ...patch }
  if (Object.keys(p).length) auto.setConfig(agent, p, { persist: false })
  return {
    w, agent, sess, reg, auto,
    at: (ms) => T + ms,
    tick: (t) => auto.tick(t),
    state: () => auto.stateOf(sid),
    cfg: () => auto.cfgFor(agent),
    now: () => T,
    setT: (v) => { T = v },
  }
}

/* ───────────────────────── 1. 配置 ───────────────────────── */

section('1. 配置（默认值 / 夹取 / 未知键 / 落盘回读）')
{
  const ws = mkdtempSync(join(tmpdir(), 'mc-auto-'))
  const h = setup({ workspaceOf: () => ws, timing: false })
  const d = h.cfg()
  ok('默认开启且待机 10s 就叫醒', d.enabled === true && d.idleWake === true && d.idleWakeSec === 10, JSON.stringify({ e: d.enabled, i: d.idleWake, s: d.idleWakeSec }))
  ok('默认间隔/最小间隔/有人时都是 5s', d.minIdleGapSec === 5 && d.idleWakeNearPlayerSec === 5, JSON.stringify({ g: d.minIdleGapSec, n: d.idleWakeNearPlayerSec }))
  ok('默认每小时上限给了余量（120）', d.idleWakeMaxPerHour === 120, String(d.idleWakeMaxPerHour))
  ok('默认反射项全开（小动作/游荡已删）', d.lookAround && d.autoEat && d.pickup && d.avoid
    && !('fidget' in d) && !('wander' in d) && !('wanderEverySec' in d) && !('wanderRadius' in d))
  ok('默认不跟随任何人', d.follow === null && d.followDistance === 3)
  ok('默认带长期自主目标（正常玩家发育 → 末影龙 + 和玩家一起玩）',
    typeof d.standing === 'string' && d.standing.includes('正常玩家') && d.standing.includes('末影龙')
    && d.standing.includes('和玩家一起玩'))
  const cS = h.auto.setConfig(h.agent, { standing: '  ' + 'x'.repeat(300) }, { persist: false })
  ok('长期目标允许长文本（不被 32 字上限截断）', cS.cfg.standing.length === 240, String(cS.cfg.standing.length))
  const cS2 = h.auto.setConfig(h.agent, { standing: '  先盖个小屋再挖矿  ' }, { persist: false })
  ok('长期目标可改且去空白', cS2.cfg.standing === '先盖个小屋再挖矿', String(cS2.cfg.standing))
  const cS3 = h.auto.setConfig(h.agent, { standing: '' }, { persist: false })
  ok('长期目标置空 → null（文案回退默认那句）', cS3.cfg.standing === null)

  const c1 = h.auto.setConfig(h.agent, { followDistance: 999, idleWakeSec: 1, minIdleGapSec: 1, quietAfterToolMs: 1 }, { persist: false })
  ok('数值被夹到区间内（下限 5s）', c1.cfg.followDistance === 10 && c1.cfg.idleWakeSec === 5 && c1.cfg.minIdleGapSec === 5 && c1.cfg.quietAfterToolMs === 500,
    JSON.stringify({ r: c1.cfg.followDistance, s: c1.cfg.idleWakeSec, g: c1.cfg.minIdleGapSec, q: c1.cfg.quietAfterToolMs }))
  const cUp = h.auto.setConfig(h.agent, { idleWakeSec: 99_999, idleWakeMaxPerHour: 99_999, idleWakeNearPlayerSec: 99_999 }, { persist: false })
  ok('数值上限也被夹住', cUp.cfg.idleWakeSec === 3600 && cUp.cfg.idleWakeMaxPerHour === 720 && cUp.cfg.idleWakeNearPlayerSec === 3600,
    JSON.stringify({ s: cUp.cfg.idleWakeSec, m: cUp.cfg.idleWakeMaxPerHour, n: cUp.cfg.idleWakeNearPlayerSec }))

  const c2 = h.auto.setConfig(h.agent, { 乱写的键: 1, avoid: 'off', follow: '  Steve  ' }, { persist: false })
  ok('未知键被拒绝', c2.rejected.includes('乱写的键') && !('乱写的键' in c2.cfg))
  ok('字符串布尔可解析（off → false）', c2.cfg.avoid === false)
  ok('已删的键（fidget/wander/wanderEverySec/wanderRadius/fight/fightMinHealth）当未知键拒绝',
    h.auto.setConfig(h.agent, {
      fidget: true, wander: true, wanderEverySec: 9, wanderRadius: 9, fight: false, fightMinHealth: 20,
    }, { persist: false }).rejected.length === 6)
  ok('字符串项去掉空白', c2.cfg.follow === 'Steve')
  const c3 = h.auto.setConfig(h.agent, { follow: '不跟' }, { persist: false })
  ok('"不跟" 等价于 null', c3.cfg.follow === null)

  h.auto.setConfig(h.agent, { avoid: false, followDistance: 5 }, { persist: true })
  const file = join(ws, '.dsh-mc-agent', 'auto.json')
  ok('配置落盘到 <ws>/.dsh-mc-agent/auto.json', existsSync(file))
  let saved = {}
  try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 读不到就算失败 */ }
  ok('落盘内容正确', saved.avoid === false && saved.followDistance === 5)

  h.auto.setConfig(h.agent, { standing: '先挖 10 块石头再说' }, { persist: true })
  let saved2 = {}
  try { saved2 = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 读不到就算失败 */ }
  ok('长期目标也落盘', saved2.standing === '先挖 10 块石头再说', String(saved2.standing))

  // 记忆根覆盖（2026-10-06）：Master 设了 config.memoryDir 之后，auto.json 必须跟着记忆根走。
  // 以前写死 `<工作区>/.dsh-mc-agent`，记忆一挪状态就一分为二。
  const wsMem = mkdtempSync(join(tmpdir(), 'mc-auto-wsmem-'))
  const memRoot = mkdtempSync(join(tmpdir(), 'mc-auto-mem-'))
  tmpDirs.push(wsMem, memRoot)
  const hMem = setup({ workspaceOf: () => wsMem, memRootOf: () => memRoot, timing: false })
  hMem.auto.setConfig(hMem.agent, { avoid: false, idleWakeSec: 42 }, { persist: true })
  ok('记忆根覆盖：auto.json 落在记忆根下', existsSync(join(memRoot, 'auto.json')))
  ok('记忆根覆盖：工作区里不再长出 .dsh-mc-agent', !existsSync(join(wsMem, '.dsh-mc-agent')))
  let memSavedCfg = {}
  try { memSavedCfg = JSON.parse(readFileSync(join(memRoot, 'auto.json'), 'utf8')) } catch { /* 读不到算失败 */ }
  ok('记忆根覆盖：内容正确', memSavedCfg.avoid === false && memSavedCfg.idleWakeSec === 42, JSON.stringify(memSavedCfg))

  // 拿不到记忆根（老宿主 / 自检）→ 退回 <工作区>/.dsh-mc-agent，行为不变
  const hFall = setup({ workspaceOf: () => wsMem, memRootOf: () => null, timing: false })
  hFall.auto.setConfig(hFall.agent, { avoid: false }, { persist: true })
  ok('记忆根拿不到 → 退回 <工作区>/.dsh-mc-agent/auto.json', existsSync(join(wsMem, '.dsh-mc-agent', 'auto.json')))

  const h2 = setup({ workspaceOf: () => ws })
  ok('新控制器能读回配置', h2.cfg().avoid === false && h2.cfg().followDistance === 5, JSON.stringify(h2.cfg().avoid))
  ok('新控制器能读回长期目标', h2.cfg().standing === '先挖 10 块石头再说', String(h2.cfg().standing))

  const h3 = setup({})
  const c4 = h3.auto.setConfig(h3.agent, { avoid: false }, { persist: true })
  ok('没有工作区时不落盘也不报错', c4.applied.avoid === false)
  try { rmSync(ws, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
}

/* ───────────────────────── 2. 反射层时序 ───────────────────────── */

section('2. 反射层时序（静默窗口 / running / 只转头不挪窝 / 开关 / 闸门 / 离线）')
{
  const h = setup({ world: { yaw: 1.0, pitch: 0.2 } })
  h.tick(h.at(1000))
  ok('工具调用后 6s 内完全不动', h.w.calls.look.length === 0 && h.w.calls.swings === 0 && h.w.walks.length === 0 && h.agent.steers.length === 0)

  h.agent.status = 'running'
  h.tick(h.at(7000))
  ok('AI 跑着一轮时仍会环顾（不装死）', h.w.calls.look.length === 1, `looks=${h.w.calls.look.length}`)
  ok('环顾围绕"基础朝向"（±0.5 弧度内）', h.w.calls.look[0].yaw >= 0.5 && h.w.calls.look[0].yaw <= 1.5, String(h.w.calls.look[0]?.yaw))
  ok('环顾不强制转头（force=false）', h.w.calls.look[0].force === false)
  ok('AI 跑着一轮时绝不挪窝', h.w.walks.length === 0)
  ok('AI 跑着一轮时不叫醒', h.agent.steers.length === 0)

  h.agent.status = 'idle'
  h.tick(h.at(8000))
  ok('AI 空闲后也不自己挪窝（游荡已删，只有 follow 会走）', h.w.walks.length === 0, JSON.stringify(h.w.walks))

  await flush()
  h.tick(h.at(20000))
  ok('不自己挥手/跳/蹲（小动作已删）', h.w.calls.swings === 0, `swings=${h.w.calls.swings}`)

  const looksBefore = h.w.calls.look.length
  const walksBefore = h.w.walks.length
  h.auto.setConfig(h.agent, { enabled: false }, { persist: false })
  h.tick(h.at(40000))
  ok('反射层关掉后不再环顾/挪窝', h.w.calls.look.length === looksBefore && h.w.walks.length === walksBefore)

  h.auto.setConfig(h.agent, { enabled: true }, { persist: false })
  h.sess.watchdog.gate = () => false
  h.tick(h.at(60000))
  ok('闸门为 false 时全静默（不环顾/不挪窝/不叫醒）', h.w.calls.look.length === looksBefore && h.w.walks.length === walksBefore && h.agent.steers.length === 0)

  h.sess.watchdog.gate = () => true
  h.w.mc.online = false
  const before2 = h.w.calls.look.length
  h.tick(h.at(90000))
  ok('离线时完全不动', h.w.calls.look.length === before2)
  ok('离线时重置空闲计时（重连不会被立刻叫醒）', h.state().lastToolAt === h.at(90000))
  h.w.mc.online = true
  h.tick(h.at(91000))
  ok('重连后仍在静默窗口内', h.agent.steers.length === 0)
}

/* ───────────────────────── 3. 自保 ───────────────────────── */

section('3. 自保（踩到危险方块只叫醒 AI、不自己移动 / 有怪只叫醒 AI、不自己跑）')
{
  const lava = setup({ world: { pos: [10.5, 64, 20.5], ground: 63, overrides: { '10,63,20': 'lava' } }, patch: { lookAround: false } })
  lava.tick(lava.at(1000))
  const lavaMoves = () => lava.w.calls.controls.filter(([k, v]) => (k === 'back' || k === 'jump' || k === 'forward') && v === true).length
  ok('脚下方块是岩浆 → **一步都不动**（只叫醒，用户 2026-10-21 定）', lavaMoves() === 0, JSON.stringify(lava.w.calls.controls))
  ok('自保被记进统计（只叫醒）', lava.state().stats.escapes === 1)
  const before = lava.state().stats.escapes
  lava.tick(lava.at(1200))
  ok('危险没消失时：仍然不动、也不重复计数', lavaMoves() === 0 && lava.state().stats.escapes === before)

  /* 🔴 名单统一（mc_map 第二轮）：反射层原来自己写了一份正则，**漏了灵魂火 / 灵魂营火**。
   *    现在和搭路共用 `src/bridge.mjs` 的 `BRIDGE_FATAL_NAMES`，这几个都该被认出来。 */
  for (const bad of ['soul_fire', 'soul_campfire', 'cactus', 'powder_snow']) {
    const w = setup({ world: { overrides: { '10,63,20': bad } }, patch: { lookAround: false } })
    w.tick(w.at(1000))
    ok(`脚下方块是 ${bad} → 认出来并叫醒，但不动（反射层和搭路共用同一份危险名单）`,
      w.w.calls.controls.filter(([k, v]) => (k === 'back' || k === 'jump' || k === 'forward') && v === true).length === 0
      && w.state().stats.escapes >= 1)
  }
  /* 2026-10-18 审计：甜浆果丛只减速，踩上去能走过去 ⇒ 不能当岩浆一样后退，否则来回震荡。 */
  {
    const w = setup({ world: { overrides: { '10,63,20': 'sweet_berry_bush' } }, patch: { lookAround: false } })
    w.tick(w.at(1000))
    ok('脚下方块是 sweet_berry_bush → 不后退（只减速，别来回震荡）',
      !w.w.calls.controls.some(([k, v]) => k === 'back' && v === true))
  }
  const stone = setup({ world: { overrides: { '10,63,20': 'stone' } }, patch: { lookAround: false } })
  stone.tick(stone.at(1000))
  ok('普通石头不触发自保（名单收紧后没误伤）', !stone.w.calls.controls.some(([k, v]) => k === 'back' && v === true))

  const safe = setup({ world: { overrides: { '10,63,20': 'grass_block' } }, patch: { lookAround: false } })
  safe.tick(safe.at(1000))
  ok('安全方块不会乱后退', !safe.w.calls.controls.some(([k, v]) => k === 'back' && v))

  // 有怪时反射层**不动位置**（用户 m11410：把受到攻击自动跑开去掉）—— 血少血多都一样
  const lowHp = setup({
    world: { health: 5, mobs: [{ name: 'zombie', position: [13.5, 64, 20.5] }] },
    patch: { lookAround: false },
  })
  lowHp.tick(lowHp.at(1000))
  await flush()
  ok('低血 + 8 格内有敌对 → 也不自己跑（只叫醒 AI）', lowHp.w.walks.length === 0, JSON.stringify(lowHp.w.walks))
  ok('低血时也叫醒了 AI 说明情况', lowHp.agent.steers.length === 1, JSON.stringify(lowHp.agent.steers))

  const healthy = setup({ world: { health: 20, mobs: [{ name: 'zombie', position: [13.5, 64, 20.5] }] }, patch: { lookAround: false } })
  healthy.tick(healthy.at(1000))
  await flush()
  ok('血满 + 空手 → 同样不自己跑（还手/撤由 AI 定）', healthy.w.walks.length === 0 && healthy.w.calls.attacks.length === 0)
}

/* ───── 3.5 被怪打/怪贴上来 → 只叫醒 AI（不自己跑、不还手） ─────
   用户 m10335「被攻击先逃跑，让 ai 决定用那种策略」→ m11410「既然选择可以获取怪物位置，
   把受到攻击自动跑离开去掉」→ 随后「反射层兜底还手：judgeFight() 不需要了」：
   反射层**既不移动也不还手**，只报怪名/坐标/距离/血量 + 叫醒 AI；没人值守时只记档。
   2026-10-14 任务驱动第三步（用户："先停止采集，再由 AI 决定逃跑、战斗还是继续任务"）：
   急事叫醒时**先把手里那件事停下**（`dangerStopWork`，默认开，`interruptMove` + 台账那步放回 pending）——
   但"不跑、不还手、不替 AI 决策"这三条**没变**。 */

section('3.5 被怪打/怪贴上来 → 只叫醒 AI（不自己跑、不抢控制权、不还手）')
{
  const MOB = (name, pos = [13.5, 64, 20.5]) => ({ name, position: pos })
  const SWORD = [{ name: 'stone_sword', count: 1 }]
  const walked = (h) => h.w.walks.length > 0                        // 反射层有没有自己动位置
  const steered = (h) => h.agent.steers.map((m) => JSON.stringify(m)).join(' ')
  // "没人值守" = 没有 steer 通道（真环境里是没人值守 / 本小时叫醒配额用完）
  const deaf = (h) => { h.agent.steer = undefined; return h }
  /** 一次 tick 后：既没动、也没打 */
  const still = (h) => !walked(h) && h.w.calls.attacks.length === 0 && h.w.calls.interrupts.length === 0

  // ① 血满 + 有剑 + 僵尸贴上来：**不自己跑、也不还手**，只叫醒 AI 让它定（用户 m11410）
  const armed = setup({ world: { health: 20, items: SWORD, mobs: [MOB('zombie')] }, patch: { lookAround: false } })
  armed.tick(armed.at(1000))
  await flush()
  ok('被怪贴上来：不自己跑开、也不还手，只叫醒 AI',
    !walked(armed) && armed.w.calls.attacks.length === 0,
    JSON.stringify({ walks: armed.w.walks.length, attacks: armed.w.calls.attacks.length }))
  ok('没在干活时不乱停（不调 interruptMove）', armed.w.calls.interrupts.length === 0, JSON.stringify(armed.w.calls.interrupts))
  ok('叫醒 AI（interruptWait + steer 各一次）', armed.sess._interrupts.includes('danger') && armed.agent.steers.length === 1, JSON.stringify(armed.sess._interrupts))
  ok('叫醒文案带怪名 + 坐标 + 血量 + 三个选项（还手 / 撤 / 躲）',
    /zombie/.test(steered(armed)) && /\(14, 64, 21\)/.test(steered(armed)) && /血 20\/20/.test(steered(armed))
      && /attack/.test(steered(armed)) && /mc_move/.test(steered(armed)), steered(armed))
  ok('文案说清"我没有自己跑、也没打断你"', /没有自己跑/.test(steered(armed)), steered(armed))
  ok('统计：自保提醒 +1、叫醒 +1、没自己跑过',
    armed.state().stats.alerts === 1 && armed.state().stats.dangerWakes === 1
      && armed.state().stats.escapes === 0,
    JSON.stringify(armed.state().stats))

  // ② 没人值守（叫不醒）：**也不还手**（用户："judgeFight() 不需要了"），只记档
  const deaf1 = deaf(setup({ world: { health: 20, items: SWORD, mobs: [MOB('zombie')] }, patch: { lookAround: false } }))
  deaf1.tick(deaf1.at(1000))
  await flush()
  ok('没人值守 → 不还手（有剑也不打）、不自己跑、不打断任何东西',
    still(deaf1), JSON.stringify({ attacks: deaf1.w.calls.attacks.length, walks: deaf1.w.walks.length }))
  ok('没人值守时仍然记了档（自保提醒 +1，叫醒 0 —— 没有 steer 通道）',
    deaf1.state().stats.alerts === 1 && deaf1.state().stats.dangerWakes === 0,
    JSON.stringify(deaf1.state().stats))
  ok('没人值守不碰背包（不为了打怪换武器）', deaf1.w.calls.equips.length === 0, JSON.stringify(deaf1.w.calls.equips.map((i) => i?.name)))

  // ③ 苦力怕（会炸）：当然也不打、也不跑
  const creeper = deaf(setup({ world: { health: 20, items: SWORD, mobs: [MOB('creeper')] }, patch: { lookAround: false } }))
  creeper.tick(creeper.at(1000))
  await flush()
  ok('苦力怕 → 不硬刚、也不自己跑、连退都不退（2026-10-21 起只叫醒）', still(creeper))

  // ④ 远程怪（骷髅）：血满 / 血少都一个待遇 —— 不还手（门槛已经删了）
  const skFull = deaf(setup({ world: { health: 20, items: SWORD, mobs: [MOB('skeleton')] }, patch: { lookAround: false } }))
  skFull.tick(skFull.at(1000))
  await flush()
  ok('骷髅 + 血满 + 有剑 → 也不还手', still(skFull))

  const skHurt = deaf(setup({ world: { health: 16, items: SWORD, mobs: [MOB('skeleton')] }, patch: { lookAround: false } }))
  skHurt.tick(skHurt.at(1000))
  await flush()
  ok('骷髅 + 血 16 → 不还手、也不自己跑', still(skHurt))

  // ⑤ 两只以上：不还手（以前是"两只就撤"，现在连撤都没有）
  const two = deaf(setup({
    world: { health: 20, items: SWORD, mobs: [MOB('zombie'), MOB('zombie', [14.5, 64, 20.5])] },
    patch: { lookAround: false },
  }))
  two.tick(two.at(1000))
  await flush()
  ok('两只僵尸 → 不硬刚、也不自己跑', still(two))

  // ⑥ 空手也一样（以前"空手不硬刚"是个条件，现在根本没有还手这条路）
  const bare = deaf(setup({ world: { health: 20, items: [], mobs: [MOB('zombie')] }, patch: { lookAround: false } }))
  bare.tick(bare.at(1000))
  await flush()
  ok('空手 + 没人值守 → 不还手、不自己跑', still(bare))

  // ⑦ 已删的两个配置键被当未知键拒绝（见上面 §1 那条）；这里再钉一次源码里没有 judgeFight
  //    （先剥掉注释 —— 注释里正是拿 judgeFight 当"这里删过什么"的说明）
  const autoSrc = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok('源码里已经找不到 judgeFight（用户："judgeFight() 不需要了"）', !/judgeFight/.test(autoSrc))
  ok('源码里也没有"叫不醒就自己上"的兜底痕迹（weaponInHand/weaponInBag/holdWeapon 全没了）',
    !/weaponInHand|weaponInBag|holdWeapon|NEVER_FIGHT|MELEE_EASY/.test(autoSrc))

  // ⑧ avoid:false → 挨打也完全不反应（不叫醒、不动、不还手）
  const noAvoid = deaf(setup({
    world: { health: 20, items: SWORD, mobs: [MOB('zombie')] },
    patch: { lookAround: false, avoid: false },
  }))
  noAvoid.tick(noAvoid.at(1000))
  await flush()
  ok('avoid:false → 不叫醒、不动、不还手',
    !walked(noAvoid) && noAvoid.w.calls.attacks.length === 0 && noAvoid.state().stats.alerts === 0)

  // ⑨ 远程怪从十几格外就算威胁（用户 m10404：别忘了远程攻击的怪物）
  const far = setup({
    world: { health: 20, mobs: [MOB('skeleton', [13.5, 64, 35.5])] },
    patch: { lookAround: false },
  })
  far.tick(far.at(1000))
  await flush()
  ok('15 格外的骷髅（看得见我）→ 也算威胁：叫醒 + 不自己跑',
    !walked(far) && far.state().stats.dangerWakes === 1 && far.w.calls.interrupts.length === 0,
    JSON.stringify({ walks: far.w.walks.length, wakes: far.state().stats.dangerWakes }))

  // ⑩ 同一个骷髅，中间挡一块石头 → 它打不到我，不算威胁（别神经质地一直叫）
  const blocked = setup({
    world: { health: 20, mobs: [MOB('skeleton', [13.5, 64, 35.5])], overrides: { '12,65,28': 'stone' } },
    patch: { lookAround: false },
  })
  blocked.tick(blocked.at(1000))
  await flush()
  ok('视线被挡住 → 远处骷髅不算威胁（不叫、不动、不打断）',
    !walked(blocked) && blocked.state().stats.dangerWakes === 0 && blocked.w.calls.interrupts.length === 0)

  // ⑪ 挨了打却看不到怪（隔墙 / 超远射）→ 不自己动，报"上次看到它在哪" + 让它 mc_observe 定位
  //    （2026-10-08：`mc_entities` 并进 mc_observe 的"程序检测到"那段，所以这里改成让它 mc_observe {distance:N}）
  const blind = setup({ world: { health: 20, mobs: [] }, patch: { lookAround: false } })
  blind.tick(blind.at(1000))
  await flush()
  blind.w.fire('entityHurt', blind.w.raw.entity)
  blind.setT(blind.now() + 100)
  blind.tick(blind.at(0))
  await flush()
  ok('挨了打但看不到怪 → 也不自己跑', !walked(blind), JSON.stringify(blind.w.walks))
  ok('并叫醒说明"看不到怪"', /看不到怪/.test(steered(blind)), steered(blind))
  ok('看不到怪时告诉它用 mc_observe 定位（"程序检测到"那段隔墙也能给坐标/血量）',
    /mc_observe/.test(steered(blind)) && /distance/.test(steered(blind)), steered(blind))

  // ⑪-b 掉下去了（摔伤）→ **不许说成"被远程怪打"**（2026-10-17 实机：垫柱子时放置被拒，
  //      人从 y=68 掉到 y=47、血 3/20，反射层报"挨了打但 22 格内看不到怪 → 叫醒 AI 定位"，
  //      还 stopWork 打断了移动；AI 照 hint 又爬又掉第二次，掉到 y=33、血 1.9）
  {
    const fall = setup({ world: { health: 20, mobs: [], pos: [10.5, 64, 20.5] }, patch: { lookAround: false } })
    fall.tick(fall.at(1000))
    await flush()
    ok('没掉血时什么都不说', fall.agent.steers.length === 0, steered(fall))
    fall.w.setHealth(3)
    fall.w.raw.entity.position = mkP(10.5, 43, 20.5)      // 净下落 21 格
    fall.w.fire('entityHurt', fall.w.raw.entity)
    fall.setT(fall.now() + 100)
    fall.tick(fall.at(0))
    await flush()
    const fm = steered(fall)
    ok('🔴 判成摔伤，不说"被远程怪打"', /摔下来了/.test(fm) && /这不是被打/.test(fm), fm.slice(0, 90))
    ok('报出净下落几格 + 从哪掉到哪', /净下落 21 格/.test(fm) && /y=64/.test(fm) && /y=43/.test(fm), fm.slice(0, 140))
    ok('文案里不许出现"看不到怪"（那是"被打"的说法，会把 AI 带偏）', !/看不到怪/.test(fm), fm.slice(0, 90))
    ok('🔴 摔伤不打断正在做的事（打断对"往下掉"没用，只会让 AI 失去上下文）',
      fall.w.calls.interrupts.length === 0, JSON.stringify(fall.w.calls.interrupts))
    ok('摔伤也不自己跑', !walked(fall))
    ok('摔伤时劝"别反复垫柱子"（垫柱子要往自己脚下放方块，被拒就半空了）',
      /垫柱子/.test(fm) && /斜台阶/.test(fm), fm.slice(0, 200))
  }
  {
    // 只掉 2 格（下台阶）⇒ 还得按"被远程打"报：摔伤判据不能太宽，否则真挨打时被当成摔伤
    const small = setup({ world: { health: 20, mobs: [], pos: [10.5, 65, 20.5] }, patch: { lookAround: false } })
    small.tick(small.at(1000))
    await flush()
    small.w.setHealth(3)
    small.w.raw.entity.position = mkP(10.5, 63, 20.5)
    small.w.fire('entityHurt', small.w.raw.entity)
    small.setT(small.now() + 100)
    small.tick(small.at(0))
    await flush()
    ok('只掉 2 格 ⇒ 仍然按"挨了打看不到怪"报（判据不能太宽）', /看不到怪/.test(steered(small)), steered(small).slice(0, 90))
  }
  {
    // 掉得够多但**还在往下掉的过程中**也要能判出来：窗口 1.5 秒内的最高点减当前 y
    const src = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
    ok(/const FALL_WINDOW_MS = 1500/.test(src) && /const FALL_MIN_DROP = 3/.test(src),
      '摔伤判据 = 1.5 秒内净下落 ≥ 3 格')
    ok(/const fallDropOf = \(s, e\) => \{/.test(src), '摔伤由统一的一处算（不散在几处）')
    ok(/noteFall\(s, e, t\)/.test(src), '🔴 高度采样在 avoid() 最开头（等挨打那一刻才记，窗口里就一个点，净下落永远是 0）')
    ok(/const fallOnly = fell != null && !drown && !threat/.test(src),
      '🔴 摔伤只在"不是溺水、也没有看得见的怪"时成立')
    ok(/const stopped = \(fallOnly \|\| cfg\.dangerStopWork === false\) \? null : stopWork\(s, sess\)/.test(src),
      '🔴 摔伤不 stopWork（实机那天就是被它掐成 preempted 才又掉第二次）')
  }


  // ⑫ AI 正在动手 + 怪在 4 格外 + 没挨打 → 不打扰（等它这一轮跑完）
  const busy = setup({ world: { health: 20, mobs: [MOB('zombie', [16.5, 64, 20.5])] }, patch: { lookAround: false } })
  busy.auto.noteToolStart('a1')
  busy.tick(busy.at(1000))
  await flush()
  ok('AI 正在动手 + 怪在 4 格外 → 不打扰',
    !walked(busy) && busy.state().stats.dangerWakes === 0 && busy.w.calls.interrupts.length === 0)

  // ⑬ AI 正在动手但怪贴到 4 格内 → 照样只叫醒（不再抢控制权、不再自己跑）
  const urgent = setup({ world: { health: 20, mobs: [MOB('zombie')] }, patch: { lookAround: false } })
  urgent.auto.noteToolStart('a1')
  urgent.tick(urgent.at(1000))
  await flush()
  ok('AI 正在动手但怪贴到 4 格内 → 叫醒 + 先把手里的活停下（但自己不跑）',
    !walked(urgent) && urgent.w.calls.interrupts.length >= 1 && urgent.state().stats.dangerWakes === 1,
    JSON.stringify({ i: urgent.w.calls.interrupts, w: urgent.w.walks.length }))

  // ⑭ 静态检查：自保段里不许再出现"自己跑"的代码（用户 m11410 要的就是去掉它）
  const src = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
  const avoidBody = src.slice(src.indexOf('const avoid = ('), src.indexOf('const follow = ('))
  ok('自保段里没有 walkTo（不再替 AI 走路）', avoidBody.length > 100 && !/walkTo/.test(avoidBody))
  ok('自保段里没有 interruptMove（不再抢控制权）', avoidBody.length > 100 && !/interruptMove/.test(avoidBody))
  ok('逃跑落点的代码已整体删掉（fleeSpot/blindSpot/groundYAt 都不在源码里）',
    !/fleeSpot|blindSpot|groundYAt/.test(src))
  ok('自保的限流字段改成 lastAlert*（不再叫 lastFlee*）',
    /lastAlertAt/.test(avoidBody) && !/lastFlee/.test(src))
  ok('危险方块（岩浆/火/仙人掌）**只叫醒、一步都不动**（用户 2026-10-21："改成叫醒，不自己移动"）',
    !/holdCtl\(sess, 'back'/.test(avoidBody) && !/holdCtl\(sess, 'jump', 200/.test(avoidBody)
    && /只叫醒 AI，不自己移动/.test(avoidBody))
  ok('危险方块那两条不再裸按控制位（裸按会被移动收尾一起松掉）',
    !/setControlState\?\.\('back', true\)/.test(avoidBody) && !/setControlState\?\.\('jump', true\)/.test(avoidBody))
}

/* ─────────── 3.6 在水里憋气（溺水）→ 叫醒 AI 上浮，别当成"被远程怪打" ─────────── */

section('3.6 在水里憋气（氧气见底）→ 叫醒 AI 上浮（不是"挨了打看不到怪"）')
{
  const steered = (h) => h.agent.steers.map((m) => JSON.stringify(m)).join(' ')
  const walked = (h) => h.w.walks.length > 0
  const jumped = (h) => h.w.calls.controls.filter(([k, v]) => k === 'jump' && v === true).length
  // 静态断言前先剥注释：注释里正是拿这些写法当"这里删过/改过什么"的说明
  const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // ① 氧气 5/20 + 在水里：叫醒；文案必须写清"这不是被打"，并给出上浮办法
  //    （用户 2026-10-07："现在容易被淹死" —— 旧版把它当成远程怪隔墙射，AI 跑去找一个不存在的敌人）
  /* 🔴 2026-10-19 用户：「水下自救要让 ai 能开关」+「不要自动到干燥方块」——
   *    所以这一组测的是**显式打开**时的行为（`waterRecover: true`），默认是关的。 */
  const h = setup({ world: { inWater: true, air: 5, submerged: true, health: 18 }, patch: { lookAround: false, waterRecover: true } })
  h.tick(h.at(1000))
  await flush()
  ok('憋气 → 叫醒 AI（steer 一次）', h.agent.steers.length === 1, String(h.agent.steers.length))
  ok('文案写清"这不是被打"、是憋气',
    /这不是被打/.test(steered(h)) && /憋气/.test(steered(h)), steered(h).slice(0, 90))
  ok('文案带氧气 + 血量 + 坐标',
    /氧气 5\/20/.test(steered(h)) && /血 18\/20/.test(steered(h)) && /在 11 64 21/.test(steered(h)), steered(h))
  ok('给出上浮办法（mc_move swim）+ 出水后往岸上走（mc_scan）+ 别挖水',
    // 注意：steered() 是 JSON.stringify 过的，里面的引号是 \" —— 别拿裸引号去匹配
    /mc_move \{[^}]*swim[^}]*\}/.test(steered(h)) && /mc_scan \{[^}]*radius[^}]*\}/.test(steered(h))
      && /水\/岩浆是\*\*流体，挖不掉\*\*/.test(steered(h)),
    steered(h))
  ok('文案里不许出现"看不到怪"（那是"被打"的说法，会把 AI 带偏）',
    !/看不到怪/.test(steered(h)), steered(h).slice(0, 60))
  ok('不还手、不抢控制权（打怪 / 打断 AI 一次都不做）',
    h.w.calls.attacks.length === 0 && h.w.calls.interrupts.length === 0,
    JSON.stringify({ attacks: h.w.calls.attacks.length, interrupts: h.w.calls.interrupts.length }))
  /* 🔴 2026-10-15 用户点名："水下寻路"要**自动接管** —— 反射层现在会自己去搜出口、走一条路线
   *    （`startWaterRecover` → `recoverFromWater`）。但用户同时要求"**绝不偷偷接管**"：
   *    叫醒文案里要说清我同时在干什么，走完还会再 steer 一条报结果。 */
  ok('🔴 水下会自动接管（自己去搜出口、走一条路线），不是干等着',
    walked(h) && h.state().waterRecoverAt > 0,
    JSON.stringify({ walks: h.w.walks.length, at: h.state().waterRecoverAt }))
  ok('🔴 叫醒文案里说清"我同时在试着自己找出口"（不偷偷接管）',
    /同时在试着自己找出口/.test(steered(h)), steered(h).slice(-200))
  ok('统计：自保提醒 +1、叫醒 +1',
    h.state().stats.alerts === 1 && h.state().stats.dangerWakes === 1, JSON.stringify(h.state().stats))

  // ② 氧气 ≤ 4（马上要掉血）：只按住 jump 抬一下，仍然不横向移动、照旧叫醒
  const g = setup({ world: { inWater: true, air: 3, submerged: true, health: 16 }, patch: { lookAround: false, waterRecover: true } })
  g.tick(g.at(1000))
  await flush()
  ok('氧气 ≤4：按住 jump 抬一下（保命动作，和"脚下是岩浆"同类）', jumped(g) >= 1, JSON.stringify(g.w.calls.controls))
  ok('抬一下 + 水下自救都不还手、不打断 AI', g.w.calls.attacks.length === 0 && g.w.calls.interrupts.length === 0,
    JSON.stringify({ walks: g.w.walks.length, attacks: g.w.calls.attacks.length }))
  /* 🔴 2026-10-16 审计（P0-2）：氧气到危险线时 `recoverFromWater` 走"直接上浮换气"那条**短路**
   *    （`src/water-recovery.mjs` 的 `air-out`），整条链路是同步的 ⇒ 同一个 tick 里既叫醒、
   *    又立刻报"没出来"。所以这里不能再钉 `=== 1`：要钉的是**叫醒那条必须在**，
   *    以及**走完照样报结果**（用户要求"绝不偷偷接管"）。 */
  ok('同一 tick 也照旧叫醒 AI（不是默默自救）',
    g.agent.steers.length >= 1 && /这不是被打/.test(steered(g)), String(g.agent.steers.length))
  ok('🔴 自救走完照样报结果（绝不偷偷接管）—— 氧气不够时如实说"没出来"，不假装成功',
    /我在水里没出来/.test(steered(g)) && /氧气/.test(steered(g)), steered(g).slice(-160))

  // ③ 氧气满：在水里也不叫醒（别神经过敏）
  const fine = setup({ world: { inWater: true, air: 20, health: 20 }, patch: { lookAround: false } })
  fine.tick(fine.at(1000))
  await flush()
  ok('氧气满（在水里但气够）→ 不叫醒', fine.agent.steers.length === 0, String(fine.agent.steers.length))
  ok('氧气满也不按 jump', jumped(fine) === 0, JSON.stringify(fine.w.calls.controls))

  // ④ 氧气 10 + 刚掉过血：也算憋气（缺氧的第一信号就是掉血）
  const hurt = setup({ world: { inWater: true, air: 10, submerged: true, health: 17 }, patch: { lookAround: false } })
  hurt.state().lastHealth = 19      // 上一次 19、现在 17 ⇒ hurtRecently
  hurt.tick(hurt.at(1000))
  await flush()
  ok('氧气 10 + 刚掉血 → 也按憋气叫醒（不是"挨了打看不到怪"）',
    hurt.agent.steers.length === 1 && /这不是被打/.test(steered(hurt)), steered(hurt).slice(0, 90))

  // ⑤ 氧气 14 + 刚掉血：氧气还够 → 走"被打"那条，但要点明"我现在在水里"
  const wet = setup({ world: { inWater: true, air: 14, health: 17 }, patch: { lookAround: false } })
  wet.state().lastHealth = 19
  wet.tick(wet.at(1000))
  await flush()
  ok('氧气还够（14）+ 掉血 → 走"被打"那条，但文案点明"我现在在水里"',
    wet.agent.steers.length === 1 && /看不到怪/.test(steered(wet)) && /我现在在水里/.test(steered(wet)),
    steered(wet).slice(0, 120))

  // ⑥ 限流：6 秒内不重复叫；过了 6 秒才再叫
  const th = setup({ world: { inWater: true, air: 4, submerged: true, health: 15 }, patch: { lookAround: false } })
  th.tick(th.at(1000))
  await flush()
  const n1 = th.agent.steers.length
  th.tick(th.at(3000))              // 才过 2 秒（也还没过 avoid 的 5s lastAlertAt 闸门）
  await flush()
  ok('2 秒后不再重复叫（限流）', th.agent.steers.length === n1, `${n1} → ${th.agent.steers.length}`)
  th.tick(th.at(8000))              // 距上次叫醒 7 秒 ⇒ 过 DROWN_WAKE_GAP_MS(6s)
  await flush()
  ok('过了 6 秒才允许再叫一次（氧气没恢复就接着提醒）',
    th.agent.steers.length === n1 + 1, `${n1} → ${th.agent.steers.length}`)

  /* 🔴 ⑦⑧⑨ 实机教训（2026-10-07）：`bot.oxygenLevel` **只在头入水之后**才有读数
   * （mineflayer 收到 `air_supply` 元数据才设它；实机：水面上 null、头一埋进水里就有 7/20），
   * 所以判据必须有 `submerged`（头在水下）这一路 —— 光等氧气会漏掉"元数据没来"的情况。 */

  // ⑦ 读不到氧气 + 刚把头埋进水里（不到 10 秒）→ 先不叫醒
  const sub0 = setup({ world: { inWater: true, air: null, submerged: true, health: 20 }, patch: { lookAround: false } })
  sub0.tick(sub0.at(1000))
  await flush()
  /* 2026-10-29（用户：「自动上浮失效了」）：这条以前还要求 `jumped === 0` ——
   * 但 autoFloat 自己按 jump 上浮不算“神经过敏”（它不叫醒 AI、不动位置），只管“不要叫醒”。 */
  ok('读不到氧气 + 刚下水（头在水下不到 10 秒）→ 先不叫醒（但 autoFloat 自己浮）',
    sub0.agent.steers.length === 0,
    JSON.stringify({ s: sub0.agent.steers.length, j: jumped(sub0) }))

  // ⑧ 头在水下超过 10 秒 → 叫醒，文案照实说"读不到氧气、按头在水下判断"
  sub0.tick(sub0.at(11_000))
  await flush()
  ok('读不到氧气 + 头在水下超过 10 秒 → 叫醒 AI', sub0.agent.steers.length === 1, String(sub0.agent.steers.length))
  ok('文案写清"多半不是被打" + 读不到氧气数字 + 已经在下面多少秒',
    /多半不是被打/.test(steered(sub0)) && /读不到氧气数字/.test(steered(sub0)) && /已经在下面 1[01] 秒/.test(steered(sub0)),
    steered(sub0).slice(0, 170))
  ok('这一条文案也不许出现"看不到怪"', !/看不到怪/.test(steered(sub0)), steered(sub0).slice(0, 60))
  ok('不还手、不抢控制权（水下自救也不打架、不打断 AI）',
    sub0.w.calls.attacks.length === 0 && sub0.w.calls.interrupts.length === 0,
    JSON.stringify({ w: sub0.w.walks.length, a: sub0.w.calls.attacks.length }))

  // ⑨ 头在水下 + 刚掉血（溺水掉血就是这样）→ 立刻叫醒，不用等 10 秒；同时只按一下 jump
  const subHurt = setup({ world: { inWater: true, air: null, submerged: true, health: 17 }, patch: { lookAround: false, waterRecover: true } })
  subHurt.state().lastHealth = 19
  subHurt.tick(subHurt.at(1000))
  await flush()
  ok('头在水下 + 掉血 → 立刻叫醒（不等 10 秒）',
    subHurt.agent.steers.length === 1 && /憋气/.test(steered(subHurt)), steered(subHurt).slice(0, 90))
  ok('这时候按住 jump 抬一下（保命动作），同时也自动接管去找出口',
    jumped(subHurt) >= 1 && subHurt.state().waterRecoverAt > 0,
    JSON.stringify({ j: jumped(subHurt), w: subHurt.w.walks.length, at: subHurt.state().waterRecoverAt }))

  // ⑩ 只是泡在水里、头在水面上 + 掉血 → 不许按憋气报（那是"被打"）
  const swim = setup({ world: { inWater: true, air: null, submerged: false, health: 17 }, patch: { lookAround: false } })
  swim.state().lastHealth = 19
  swim.tick(swim.at(1000))
  await flush()
  ok('头在水面上（只是泡着）+ 掉血 → 走"挨了打"那条，不按憋气报',
    swim.agent.steers.length === 1 && !/这不是被打|多半不是被打/.test(steered(swim)) && /我现在在水里/.test(steered(swim)),
    steered(swim).slice(0, 150))

  // ⑪ 静态检查：判据是"头在水下"，且 blockNameAt 会把普通 {x,y,z} 包成 Vec3
  const autoSrc = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))
  ok('憋气判据用"头在水下"（submergedIn = 眼睛那格是液体）',
    /const submergedIn = \(b, e\) =>/.test(autoSrc)
      && /LIQUID\.test\(String\(blockNameAt\(b, eyeOf\(e\.position\)\) \?\? ''\)\)/.test(autoSrc),
    'submergedIn')
  ok('阈值是常量：头在水下 10 秒出声 / 重复提醒 20 秒',
    /const DROWN_SUBMERGE_MS = 10_000/.test(autoSrc) && /const DROWN_SUBMERGE_GAP_MS = 20_000/.test(autoSrc))
  ok('掉血 + 头在水下 ⇒ 立刻判憋气；头在水下超时 ⇒ 也判',
    /const byHurt = submerged && hurtRecently/.test(autoSrc) && /const byTime = submerged && subMs >= DROWN_SUBMERGE_MS/.test(autoSrc))
  ok('blockNameAt 会把普通 {x,y,z} 包成 Vec3（否则 eyeOf 那一路永远读不到方块）',
    /const asVec = \(b, pos\) =>/.test(autoSrc) && /typeof pos\.floored === 'function' \? pos : asVec\(b, pos\)/.test(autoSrc))
  ok('氧气读数仍然照实报（有就带上、没有就不装）',
    /oxygenLevel/.test(autoSrc) && /氧气读不到/.test(autoSrc))

  // ⑫ 实机教训（2026-10-07 第 2 轮）：氧气读数可能是**旧的** —— mineflayer 不在客户端让它自己往下走，
  //    只在服务端发 air_supply 时更新；潜过水之后站在浅水里，`air` 可能还是 0/-1。头明明在水面上 ⇒ 不许叫醒。
  const stale = setup({ world: { inWater: true, air: 0, submerged: false, health: 20 }, patch: { lookAround: false } })
  stale.tick(stale.at(1000)); stale.tick(stale.at(3000)); stale.tick(stale.at(5000))
  await flush()
  ok('浅水里 + 氧气读数是旧的（0，而且不往下掉）⇒ 不许叫醒（实机误报过两次）',
    stale.agent.steers.length === 0 && stale.state().stats.alerts === 0,
    JSON.stringify({ steers: stale.agent.steers.length, alerts: stale.state().stats.alerts }))
  ok('旧读数也不算"濒死按 jump"（头在水面上按 jump 没意义）', jumped(stale) === 0, JSON.stringify(stale.w.calls.controls))

  // ⑬ 兜底那一路：万一"眼睛那格"读不到（区块没加载/客户端没同步），读数**正在往下掉**也算真在憋气
  const drain = setup({ world: { inWater: true, air: 12, submerged: false, health: 20 }, patch: { lookAround: false } })
  drain.tick(drain.at(1000)); await flush()
  drain.w.raw.oxygenLevel = 5      // 服务端真的在扣气 ⇒ 就算 submerged 判不出来，也得叫醒
  drain.tick(drain.at(2000)); await flush()
  ok('头那格读不到、但氧气在往下掉（12 → 5）⇒ 照旧叫醒（兜底那一路）',
    drain.agent.steers.length >= 1 && /憋气/.test(steered(drain)), steered(drain).slice(0, 120))

  // ⑭ 静态：判据里确实有"读数正在往下掉"这一路，且 state 里声明了 lastAir
  ok('判据里有 draining（读数在往下掉）这一路，state 里也声明了 lastAir',
    /const draining = air != null && s\.lastAir != null && air < s\.lastAir/.test(autoSrc)
      && /\(submerged \|\| draining\)/.test(autoSrc) && /lastAir: null/.test(autoSrc))
}

/* ─────────── 3.7 busy 期间照样检测；重连复位 eatHooked；日志别写死默认值 ───────────
   2026-10-08 审计（子代理 d9c21f85 报告第 5/7/8 条）：
   ① `avoid()` 开头 `if (s.busy) return` 把**整条**自保链停掉 —— `pickup` 最长 8 秒、`follow` 最长 3.4 秒，
      这期间岩浆/挨打/憋气全不检测。`busy` 只该挡住"反射层替你按控制位"。
   ② `eatFinish/eatFail` 挂在 bot 对象上，重连换了新 bot，离线分支只复位 `s.hooked` 漏了 `s.eatHooked`。
   ③ 加载日志写死"空闲 180s、旁边有人 60s"，实际默认 5s/5s。 */

section('3.7 busy 期间照样检测并叫醒（先停手，但不抢控制位）')
{
  const MOB = (name, pos = [13.5, 64, 20.5]) => ({ name, position: pos })
  const steered = (h) => h.agent.steers.map((m) => JSON.stringify(m)).join(' ')
  const backPresses = (h) => h.w.calls.controls.filter(([k, v]) => k === 'back' && v === true).length
  const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // ① busy（AI 那一步还在跑）时怪贴上来：**照样叫醒**，并把手里那件事停下
  //    （2026-10-14 任务驱动第三步：先停止采集，再由 AI 决定；但一下控制位都不碰）
  const h = setup({ world: { health: 20, mobs: [MOB('zombie')] }, patch: { lookAround: false } })
  h.state().busy = true
  h.tick(h.at(1000))
  await flush()
  ok('busy 期间照样叫醒 AI（旧版 `if (s.busy) return` 直接吞掉）',
    h.agent.steers.length === 1 && /zombie/.test(steered(h)), steered(h).slice(0, 120))
  ok('busy 期间先把手里那件事停下（interruptMove），但自己不走路',
    h.w.calls.interrupts.length >= 1 && h.w.walks.length === 0,
    JSON.stringify({ i: h.w.calls.interrupts, w: h.w.walks.length }))

  // ② busy 期间踩到岩浆：不按 back（不跟 AI 抢），但探测与统计照做
  const lava = { '10,63,20': 'lava' }
  const hb = setup({ world: { overrides: lava }, patch: { lookAround: false } })
  hb.state().busy = true
  hb.tick(hb.at(1000))
  await flush()
  ok('busy 期间脚下是岩浆：只提醒、不按 back', backPresses(hb) === 0 && hb.state().stats.escapes === 1,
    JSON.stringify({ back: backPresses(hb), escapes: hb.state().stats.escapes }))
  const hn = setup({ world: { overrides: lava }, patch: { lookAround: false } })
  hn.tick(hn.at(1000))
  await flush()
  ok('不 busy 时脚下是岩浆：同样一步都不动（只叫醒）', backPresses(hn) === 0, String(backPresses(hn)))

  // ③ 静态：busy 只挡动作，不挡检测
  const src = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))
  ok('`if (s.busy) return` 已经不存在（剥注释后）', !/if \(s\.busy\) return/.test(src))
  ok('改成 `const busy = Boolean(s.busy)`（危险方块已不按控制位，busy 只剩"别打断你"的意思）',
    /const busy = Boolean\(s\.busy\)/.test(src) && !/if \(busy\) return/.test(src))

  // ④ 重连必须一起复位 eatHooked（不然 eatFinish/eatFail 永久挂在死 bot 上）
  ok('离线分支同时复位 hooked 与 eatHooked',
    /s\.hooked = false[\s\S]{0,160}s\.eatHooked = false/.test(src))

  // ⑤ 加载日志的默认值从 AUTO_DEFAULTS 现算，不再写死 180s/60s
  ok('加载日志不再写死"空闲 180s、旁边有人 60s"',
    !/空闲 180s/.test(src) && /AUTO_DEFAULTS\.idleWakeSec/.test(src))
}

section('3.8 头卡在方块里（窒息）→ 叫醒 AI（2026-10-18 审计）')
{
  const steered = (h) => h.agent.steers.map((m) => (m?.content ?? []).map((c) => c?.text ?? '').join('\n')).join('\n')
  const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  /* 假世界：地面 y=63 是石头，y≥64 是空气。窒息 = 头那格（y+1）刚被盖住，或者头被盖住且正在掉血。
   * 🔴 不能用 `world:{air:5}` 造假 —— 现实里窒息（沙埋/卡墙）**不消耗气泡条**，地面 oxygenLevel 是 null；
   *    假 air 会让"需要氧气读数"这种错判据照样全绿（这是审计抓到的 P0）。 */
  const buried = (over = {}) => setup({ world: { overrides: { '10,65,20': 'stone', ...over } }, patch: { lookAround: false } })

  // ① 沙子刚砸在头上（上一拍头还是空的）：叫醒，且不需要 oxygenLevel
  const h = buried({ '10,65,20': 'sand' })
  h.state().lastHeadSolid = false
  h.tick(h.at(1000))
  await flush()
  ok('头刚从空变实心 ⇒ 叫醒（氧气读数是 null 也照样报）', h.agent.steers.length === 1, steered(h).slice(0, 80))
  const t = steered(h)
  ok('文案点名窒息、报出方块与头那格坐标', /窒息/.test(t) && /sand/.test(t) && /10\.5,\s*65,\s*20\.5/.test(t), t.slice(0, 260))
  ok('标题是窒息，不是溺水、也不是"挨了打看不到怪"',
    /【自保：.*窒息/.test(t) && !/正在溺水|溺水｜/.test(t) && !/看不到怪/.test(t), t.slice(0, 200))
  ok('break 给的是 x/y/z（mc_act 不认 pos）', /"x":10/.test(t) && /"y":65/.test(t) && /"z":20/.test(t) && !/\\"pos\\"/.test(t), t.slice(0, 300))
  ok('让 AI 用 mc_observe 看头格（mc_status 不报方块）', /mc_observe/.test(t) && !/mc_status`?（血、氧气/.test(t), t.slice(0, 300))
  ok('计入自保统计（alerts）', h.state().stats.alerts >= 1, JSON.stringify(h.state().stats))

  // ② 8 秒内不重复；还在掉血 ⇒ 过了窗口再喊
  h.w.setHealth(19)
  h.tick(h.at(2_000))
  await flush()
  ok('8 秒内不重复喊窒息', h.agent.steers.length === 1, String(h.agent.steers.length))
  h.w.setHealth(18)
  h.tick(h.at(11_000))
  await flush()
  h.tick(h.at(12_000))
  await flush()
  ok('头一直实心但还在掉血 ⇒ 过了窗口再喊一次', h.agent.steers.length === 2, String(h.agent.steers.length))

  // ③ 一直实心、没掉血、也不是刚变化 ⇒ 不喊（站在 1 格高的洞里那种正常情况）
  const top = setup({ world: { overrides: { '10,65,20': 'stone' } }, patch: { lookAround: false } })
  top.state().lastHeadSolid = true
  top.tick(top.at(1000))
  await flush()
  ok('头一直实心但没掉血 ⇒ 不喊（避免 1 格高矿道误报）', top.agent.steers.length === 0, steered(top).slice(0, 80))

  // ④ 连脚那格也被沙填了（埋死/挤进墙）：照样喊，别沉默
  const inside = buried({ '10,65,20': 'sand', '10,64,20': 'sand' })
  inside.state().lastHeadSolid = false
  inside.tick(inside.at(1000))
  await flush()
  ok('脚也被填住 ⇒ 照样喊（不是沉默）', inside.agent.steers.length === 1, steered(inside).slice(0, 80))
  ok('文案给"横着挪 / 别往上跳"的出路', /横着挪|别往上跳/.test(steered(inside)), steered(inside).slice(0, 300))

  // ⑤ 树叶/原木里不窒息（SOFT_ROOF）
  const leaf = buried({ '10,65,20': 'oak_leaves' })
  leaf.state().lastHeadSolid = false
  leaf.tick(leaf.at(1000))
  await flush()
  ok('头在树叶里（SOFT_ROOF）⇒ 不按窒息报', leaf.agent.steers.length === 0, steered(leaf).slice(0, 80))

  // ⑤′ 穿门/站门里（开着的门）⇒ **不**报窒息（门不占满整格；2026-10-18 实机穿门被误判）
  const door = buried({ '10,65,20': 'oak_door' })
  door.state().lastHeadSolid = false
  door.tick(door.at(1000))
  await flush()
  ok('头那格是门 ⇒ 不按窒息报（穿门不该被叫醒）', door.agent.steers.length === 0, steered(door).slice(0, 80))
  const slab = buried({ '10,65,20': 'oak_slab' })
  slab.state().lastHeadSolid = false
  slab.tick(slab.at(1000))
  await flush()
  ok('头那格是半砖 ⇒ 不按窒息报（半格塞不满）', slab.agent.steers.length === 0, steered(slab).slice(0, 80))
  const bed = buried({ '10,65,20': 'red_bed' })
  bed.state().lastHeadSolid = false
  bed.tick(bed.at(1000))
  await flush()
  ok('头那格是床 ⇒ 不按窒息报', bed.agent.steers.length === 0, steered(bed).slice(0, 80))

  /* ⑤″ 作物 ⇒ **不**报窒息。
   * 🔴 2026-10-22 实机（用户点名要修）：站在**麦田**里（头那格 `wheat`）被反复报"我头卡在方块里，
   *    正在窒息"，实际血一点没掉。根因是 `isSolidBlock('wheat')` 为真 —— `PASSABLE` 名单里没有作物。
   *    两条路都要测：① 名字表兜底（离线/假世界只有方块名）；② 以真实碰撞盒为准（作物 = 'empty'）。 */
  for (const crop of ['wheat', 'carrots', 'potatoes', 'beetroots']) {
    const cw = buried({ '10,65,20': crop })
    cw.state().lastHeadSolid = false
    cw.tick(cw.at(1000))
    await flush()
    ok(`头那格是 ${crop}（作物）⇒ 不按窒息报`, cw.agent.steers.length === 0, steered(cw).slice(0, 80))
  }
  // 名字不认识、但碰撞盒是 empty ⇒ 照样不算闷人（真服上以 boundingBox 为准）
  const hollow = setup({
    world: { overrides: { '10,65,20': 'some_unknown_plant' }, bbOverrides: { '10,65,20': 'empty' } },
    patch: { lookAround: false },
  })
  hollow.state().lastHeadSolid = false
  hollow.tick(hollow.at(1000))
  await flush()
  ok('碰撞盒 empty 的陌生方块 ⇒ 不按窒息报（碰撞盒优先于名字表）', hollow.agent.steers.length === 0, steered(hollow).slice(0, 80))
  // 反过来：名字不认识、但碰撞盒塞满整格 ⇒ 照报（不能因为"名字不在名单里"就沉默）
  const solidish = setup({
    world: { overrides: { '10,65,20': 'some_unknown_wall' }, bbOverrides: { '10,65,20': 'block' } },
    patch: { lookAround: false },
  })
  solidish.state().lastHeadSolid = false
  solidish.tick(solidish.at(1000))
  await flush()
  ok('碰撞盒是整格的陌生方块 ⇒ 照样报窒息', solidish.agent.steers.length === 1, steered(solidish).slice(0, 80))

  // ⑥ 头是空气（正常站着）⇒ 当然不报
  const clean = setup({ patch: { lookAround: false } })
  clean.tick(clean.at(1000))
  await flush()
  ok('头那格是空气 ⇒ 不报窒息', clean.agent.steers.length === 0, steered(clean).slice(0, 80))

  // ⑦ 静态：判据不再依赖氧气，且"刚变化"必须上一拍明确读到空
  const src = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))
  ok('不再拿氧气读数当窒息门槛', !/air != null && air <= 19/.test(src))
  ok('判据 = 头实心 +（上一拍是空 / 正在掉血）',
    /const headChanged = headSolidNow && s\.lastHeadSolid === false/.test(src) && /suffocant = !submerged && !fellRecently && headSolidNow/.test(src))
  ok('SOFT_ROOF 不按窒息算', /SOFT_ROOF/.test(src))
  ok('窒息判据以碰撞盒为准（empty/partial 不算闷人）',
    /boundingBox/.test(src) && /bb === 'empty' \|\| bb === 'partial'/.test(src))
}

/* ───────────────────────── 4. 吃 / 捡 ───────────────────────── */

section('4. 吃 / 捡（交给现成的 mineflayer-auto-eat / mineflayer-collectblock）')
{
  // ① 自动吃：本层只负责"开关 + 记事件"，手写的 equip/consume 那套已删
  const eat = setup({ world: { food: 10, items: [{ name: 'bread', count: 3 }] }, patch: { lookAround: false } })
  eat.tick(eat.at(7000))   // 必须过了 quietAfterToolMs(6s)：吃/捡只在"静默窗口之后"才动
  await flush()
  ok('饿了：让插件开自动吃', eat.w.calls.eats.enabled === true && eat.w.calls.eats.enables === 1, JSON.stringify(eat.w.calls.eats))
  ok('不再自己 equip/consume（手写那套已删）', eat.w.calls.equips.length === 0 && eat.w.calls.consumes === 0, JSON.stringify(eat.w.calls.equips))
  eat.w.fire('eatFinish')
  ok('插件吃完 → 记进统计', eat.state().stats.eats === 1, String(eat.state().stats.eats))
  eat.w.fire('eatFail', new Error('没有食物'))
  ok('插件失败 → 记进 lastError', /没有食物/.test(String(eat.state().lastError ?? '')), String(eat.state().lastError))

  // ② 关掉开关 → 必须真的 disableAuto（否则插件会一直吃下去）
  eat.auto.setConfig(eat.agent, { autoEat: false }, { persist: false })
  eat.tick(eat.at(9000))
  await flush()
  ok('关掉自动吃：让插件 disableAuto', eat.w.calls.eats.disables === 1 && eat.w.calls.eats.enabled === false, JSON.stringify(eat.w.calls.eats))

  // ③ 插件不在场（bot 没有 autoEat/collectBlock）→ 什么都不做，也不许抛
  const noPlugin = setup({ world: { food: 6, drops: [{ name: 'item', position: [13.5, 64, 20.5] }], noPlugins: true }, patch: { lookAround: false } })
  noPlugin.tick(noPlugin.at(7000))
  await flush()
  ok('插件不在场：不抛错、也不自己吃/捡', noPlugin.state().lastError == null && noPlugin.w.calls.consumes === 0 && noPlugin.w.walks.length === 0,
    JSON.stringify({ err: noPlugin.state().lastError, walks: noPlugin.w.walks.length }))

  // ④ 捡东西：交给 mineflayer-collectblock
  const pick = setup({ world: { drops: [{ name: 'item', position: [13.5, 64, 20.5] }] }, patch: { lookAround: false } })
  pick.tick(pick.at(7000))
  await flush()
  ok('掉落物交给 collectBlock（带 ignoreNoPath）',
    pick.w.calls.collects.length === 1 && pick.w.calls.collects[0].opts.ignoreNoPath === true,
    JSON.stringify(pick.w.calls.collects.map((c) => c.opts)))
  ok('不再自己 walkTo 过去捡', pick.w.walks.length === 0, JSON.stringify(pick.w.walks))
  ok('捡东西被记进统计', pick.state().stats.pickups === 1, String(pick.state().stats.pickups))

  const crowded = setup({
    world: { drops: [{ name: 'item', position: [12.0, 64, 20.5] }], players: [{ name: 'Steve', position: [11.0, 64, 20.5] }] },
    patch: { lookAround: false },
  })
  crowded.tick(crowded.at(7000))
  await flush()
  ok('旁边有人时不从人身上踩过去', crowded.w.calls.collects.length === 0)

  const skipBoat = setup({ world: { drops: [{ name: 'oak_boat', position: [13.5, 64, 20.5] }] }, patch: { lookAround: false } })
  skipBoat.tick(skipBoat.at(7000))
  await flush()
  ok('船/矿车之类的实体不当掉落物捡', skipBoat.w.calls.collects.length === 0)
}

/* ───────────────────────── 5. 空闲叫醒 ───────────────────────── */

section('5. 空闲叫醒（首叫 / 间隔 / 退避 / 工具重置 / 上限 / 各种不该叫的情况）')
{
  const h = setup({ patch: { enabled: false, avoid: false } })
  const textOf = (m) => m?.content?.[0]?.text ?? ''
  // 叫醒文案（"自主行动轮"）和催促（"别问了，直接做"）都会进 steers，所以要分开数
  const nWakes = () => h.agent.steers.filter((m) => textOf(m).includes('自主行动轮')).length
  const nNudges = () => h.agent.steers.filter((m) => textOf(m).includes('别问了，直接做')).length

  h.tick(h.at(179_000))
  ok('179s 还不叫（默认 180s）', nWakes() === 0)
  h.tick(h.at(181_000))
  ok('180s 后叫醒一次', nWakes() === 1)
  const m1 = h.agent.steers[0]
  ok('叫醒文案带"自主行动轮"和已闲秒数', textOf(m1).includes('自主行动轮') && /我已经 \d+s 没被安排/.test(textOf(m1)))
  ok('文案把 mc_observe 列成可选项 + 按长期目标开工',
    textOf(m1).includes('mc_observe') && textOf(m1).includes('长期目标') && textOf(m1).includes('自己决定'))
  ok('看图不强制：文案里 mc_observe 那一步明确写着"不强制"、没有"（必须）"',
    textOf(m1).includes('不强制') && !textOf(m1).includes('看一眼眼前（必须）'))
  ok('文案明确禁止反问 Master', textOf(m1).includes('不要问他') && textOf(m1).includes('要我做什么'))
  ok('文案禁止用 mc_events 干等', textOf(m1).includes('mc_events waitSec') && textOf(m1).includes('不算行动'))
  ok('文案不再教它"拿不准就先问一句"', !textOf(m1).includes('拿不准就先问一句'))
  ok('文案带默认长期目标（正常玩家 / 末影龙 / 和玩家一起玩）',
    textOf(m1).includes('正常玩家') && textOf(m1).includes('末影龙') && textOf(m1).includes('和玩家一起玩'))
  ok('文案带"正常玩家的发育路线"台阶（木头→石具→铁→钻石→下界→末地）',
    textOf(m1).includes('发育路线') && textOf(m1).includes('末地传送门') && textOf(m1).includes('别跳级'))
  ok('文案带用户定的约束（别拆别人东西）', textOf(m1).includes('别拆别人'))
  /* mc_map 第二轮：自主层也吃结构化地图数据 —— 叫醒时附一句"脚下一层长什么样"，
   * 省得 AI 醒来第一件事就是调 mc_map。 */
  ok('叫醒文案里带脚下一层的结构化摘要', textOf(m1).includes('🧭 脚下一层'), textOf(m1).split('\n').find((l) => l.includes('🧭')) ?? '(没有这一行)')
  {
    const src = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
    ok('🔴 危险名单不再自己写一份（和搭路共用 src/bridge.mjs 的 BRIDGE_FATAL）',
      /const DANGER = BRIDGE_FATAL/.test(src) && !/const DANGER = \/lava\|fire/.test(src))
    ok('navLineOf 在 idleText 里被调用', /const navLine = navLineOf\(sess\)/.test(src))
    ok('navLineOf 半径压到 8 格（floorMapOf 是逐列扫描，别每 tick 全图跑）', /const NAV_RADIUS = 8/.test(src))
    ok('navLineOf 拿不到世界时返回空串、不抛（try/catch 兜住）',
      /const navLineOf = \(sess\) => \{[\s\S]{0,2500}?catch \{ return '' \}/.test(src))
  }  ok('消息来源是 plugin:dsh-mc-agent', m1?.source?.kind === 'plugin:dsh-mc-agent', String(m1?.source?.kind))
  ok('注入前打断了正在等的工具', h.sess._interrupts.includes('idle'))
  ok('叫醒被记进统计', h.state().stats.wakes === 1 && h.state().lastWakeAt === h.at(181_000))

  const T1 = h.at(181_000)
  h.tick(T1 + 61_000)
  ok('刚叫过 61s 内不再叫（间隔没到）', nWakes() === 1)
  ok('但 45s 后 AI 还没动手 → 补了一条催促', nNudges() === 1, `nudges=${nNudges()}`)
  ok('催促文案是"别问了，直接做"', textOf(h.agent.steers.at(-1)).includes('别问了，直接做'))
  h.tick(T1 + 181_000)
  ok('间隔到了再叫一次', nWakes() === 2)
  const T2 = T1 + 181_000
  h.tick(T2 + 181_000)
  ok('上次叫醒后 AI 没动作 → 间隔翻倍（181s 不够）', nWakes() === 2, `streak=${h.state().noActionStreak}`)
  ok('第二次叫醒的文案带"连着 N 轮没动作"升级警告', (() => {
    const t2 = textOf(h.agent.steers.filter((m) => textOf(m).includes('自主行动轮'))[1] ?? {})
    return t2.includes('连着 1 轮') && t2.includes('先动手再说话')
  })())
  h.tick(T2 + 240_000)
  h.tick(T2 + 300_000)
  ok('同一轮叫醒只催一次（不会追着喊）', nNudges() === 2, `nudges=${nNudges()}`)
  h.tick(T2 + 361_000)
  ok('翻倍到 360s 后才会再叫', nWakes() === 3)
  ok('连续没动作的次数在累计', h.state().noActionStreak >= 2, String(h.state().noActionStreak))

  // 工具调用 = AI 动了 → 退避清零、间隔回到 180s
  const T3 = T2 + 361_000
  h.setT(T3 + 1000)
  h.auto.noteToolStart('a1')
  h.auto.noteToolEnd('a1')
  h.tick(T3 + 1000 + 179_000)
  ok('AI 调过工具后重新计 180s（179s 不叫）', nWakes() === 3)
  h.tick(T3 + 1000 + 181_000)
  ok('180s 后叫醒', nWakes() === 4)
  ok('AI 动过 → 退避清零', h.state().noActionStreak === 0, String(h.state().noActionStreak))
  ok('inFlight 配平（start/end 成对）', h.state().inFlight === 0)
  ok('动过手的那个窗口不再补催促', nNudges() === 2, `nudges=${nNudges()}`)

  // 每小时上限
  h.auto.setConfig(h.agent, { idleWakeMaxPerHour: 2 }, { persist: false })
  h.state().wakeTimes = []
  h.state().lastWakeAt = 0
  h.state().lastToolAt = h.now() - 999_000
  let fired = 0
  for (let i = 0; i < 3; i++) {
    h.setT(h.now() + 400_000)
    h.auto.noteToolStart('a1'); h.auto.noteToolEnd('a1')   // 每轮"AI 动过"→ 清退避，逼它到上限
    const n = nWakes()
    h.tick(h.now() + 181_000)
    if (nWakes() > n) fired++
  }
  ok('每小时上限生效（只叫 2 次）', fired === 2 && h.state().stats.denied >= 1, `fired=${fired} denied=${h.state().stats.denied}`)

  // 不该叫的三种情况
  const running = setup({ agentStatus: 'running', patch: { enabled: false, avoid: false } })
  running.tick(running.at(400_000))
  ok('AI 正在跑一轮时不插嘴', running.agent.steers.length === 0)

  const off = setup({ patch: { enabled: false, avoid: false, idleWake: false } })
  off.tick(off.at(400_000))
  ok('idleWake 关掉后完全不叫', off.agent.steers.length === 0)

  const wd = setup({ lastWakeAt: 0, patch: { enabled: false, avoid: false } })
  wd.sess.watchdog.lastWakeAt = wd.at(395_000)   // 看门狗 5s 前刚叫过
  wd.tick(wd.at(400_000))
  ok('看门狗刚叫过就不重复叫', wd.agent.steers.length === 0)

  const nosteer = setup({ patch: { enabled: false, avoid: false } })
  nosteer.agent.steer = undefined
  nosteer.tick(nosteer.at(400_000))
  ok('agent 没有 steer 能力时不崩（也注不进去）', true)
}

/* ───────────────────────── 6. 工具 mc_auto ───────────────────────── */

section('6. 工具 mc_auto（spec / status / on-off / stay / follow / set / wake）')
{
  const h = setup({})
  const spec = h.auto.toolSpec()
  ok('工具名是 mc_auto', spec.name === 'mc_auto')
  ok('parameters 是扁平映射（action/who/patch）', spec.parameters?.action?.type === 'string' && spec.parameters?.who?.type === 'string' && spec.parameters?.patch?.type === 'object')
  ok('输出 schema 允许额外字段（宿主契约）', spec.output?.schema?.additionalProperties === true)
  ok('render 返回 text 块', Array.isArray(spec.output.render(null, { text: 'x' })) && spec.output.render(null, { text: 'x' })[0].type === 'text')

  const exec = { agent: h.agent }
  const st = await spec.execute({ action: 'status' }, exec)
  ok('status 返回文本摘要', st.ok === true && st.text.includes('自主层') && st.text.includes('空闲'))
  ok('status 带本会话信息', st.session !== null && typeof st.session.idleSec === 'number')
  ok('status 显示长期目标 + 怎么改', st.text.includes('长期目标') && st.text.includes('standing'))
  ok('status 的 config 里带 standing', typeof st.config.standing === 'string' && st.config.standing.includes('末影龙'))

  const off = await spec.execute({ action: 'off' }, exec)
  ok('off 关掉反射层', off.config.enabled === false && h.cfg().enabled === false)
  const on = await spec.execute({ action: 'on' }, exec)
  ok('on 打开反射层', on.config.enabled === true && h.cfg().enabled === true)

  await spec.execute({ action: 'follow', who: 'Steve' }, exec)
  const stay4 = await spec.execute({ action: 'stay' }, exec)
  ok('stay = 站定（取消跟随，反射层仍开）', h.cfg().follow === null && h.cfg().enabled === true && stay4.note.includes('站定'))

  const fo = await spec.execute({ action: 'follow', who: 'Steve' }, exec)
  ok('follow 设上跟随目标', fo.config.follow === 'Steve' && h.cfg().follow === 'Steve')
  await spec.execute({ action: 'follow' }, exec)
  ok('follow 不传 who = 取消跟随', h.cfg().follow === null)

  const se = await spec.execute({ action: 'set', patch: { followDistance: 4, 胡写: 1 } }, exec)
  ok('set 改参数并回报被忽略的键', h.cfg().followDistance === 4 && se.note.includes('胡写'))

  const unknown = await spec.execute({ action: '飞' }, exec)
  ok('不认识的 action 有提示而不是抛错', unknown.ok === true && unknown.note.includes('不认识的 action'))

  const before = h.agent.steers.length
  const wk = await spec.execute({ action: 'wake' }, exec)
  ok('wake 立即叫醒一次', h.agent.steers.length === before + 1 && wk.note.includes('手动叫醒'))
  ok('wake 文案也是自主行动轮', (h.agent.steers.at(-1)?.content?.[0]?.text ?? '').includes('自主行动轮'))

  const st2 = await spec.execute({ action: 'set', patch: { standing: '先把这片树砍光' } }, exec)
  ok('set 能改长期目标', st2.config.standing === '先把这片树砍光')
  const st3 = await spec.execute({ action: 'status' }, exec)
  ok('改完立刻反映在 status 里', st3.text.includes('先把这片树砍光'))

  const noSess = await spec.execute({ action: 'status' }, { agent: { id: '别的会话' } })
  ok('没有对应会话时也能看配置', noSess.ok === true && noSess.session === null)
}

/* ───────────────────────── 7. 健壮性 ───────────────────────── */

section('7. 健壮性（bot 抛异常 / 没有 agentId / 会话消失）')
{
  // 游荡删掉后，唯一还会"从 tick 里同步调 bot"的活路是 follow → walkTo（原来靠 wander 触发）
  const boom = setup({
    world: { thrown: 'walkTo', players: [{ name: 'Steve', position: [15.5, 64, 20.5] }] },
    patch: { lookAround: false, autoEat: false, pickup: false, avoid: false, follow: 'Steve' },
  })
  let threw = false
  try { boom.tick(boom.at(20_000)) } catch { threw = true }
  ok('bot 内部抛异常不会炸掉 tick', !threw)
  ok('异常被记进 lastError', typeof boom.state().lastError === 'string', String(boom.state().lastError))

  const noid = setup({})
  noid.reg.listSessions = () => [{ bot: noid.w.mc, watchdog: { agent: noid.agent, gate: () => true } }]
  let threw2 = false
  try { noid.tick(noid.at(1000)) } catch { threw2 = true }
  ok('没有 agentId 的会话被跳过而不是崩', !threw2)

  const gone = setup({})
  gone.tick(gone.at(1000))
  ok('会话在列表里时状态存在', gone.auto.sessions.has('a1'))
  gone.reg.listSessions = () => []
  gone.tick(gone.at(2000))
  ok('会话消失后状态被清掉（不泄漏）', !gone.auto.sessions.has('a1'))

  const mixed = setup({})
  const other = mkAgent('a2', 'idle')
  const otherW = mkWorld({})
  const otherSess = mkSess('a2', otherW.mc, other, {})
  mixed.reg.listSessions = () => [mixed.sess, otherSess]
  mixed.tick(mixed.at(400_000))
  ok('多会话各自独立叫醒', mixed.agent.steers.length === 1 && other.steers.length === 1,
    JSON.stringify({ a1: mixed.agent.steers.length, a2: other.steers.length }))
  ok('tick 返回会话数', mixed.auto.tick(mixed.at(500_000)).sessions === 2)
}

/* ───────────────────────── 8. 看玩家 / 帮玩家 ───────────────────────── */

section('8. 空闲关心玩家（盯着看 / 观察内容 / 更勤叫醒 / 不自己挪窝）')
{
  const steve = { name: 'Steve', position: [13.0, 64, 20.5], yaw: 0, held: 'diamond_pickaxe' }
  const noMove = { avoid: false, pickup: false, autoEat: false, lookAround: false }

  const h = setup({ world: { players: [steve] }, patch: { ...noMove, lookAround: true } })
  h.tick(h.at(7000))
  ok('附近有人 → 转头盯着他看（不是随机晃）', h.w.calls.lookAt.length === 1 && h.w.calls.look.length === 0,
    JSON.stringify({ lookAt: h.w.calls.lookAt.length, look: h.w.calls.look.length }))
  ok('看的是"头"（y + 1.55）', Math.abs((h.w.calls.lookAt[0]?.pos?.y ?? 0) - 65.55) < 0.01, JSON.stringify(h.w.calls.lookAt[0]?.pos))
  ok('看玩家被单独计数（watches）', h.state().stats.watches === 1 && h.state().stats.looks === 1)
  const obs = h.state().playerObs?.[0]
  ok('观察结果：距离 / 在动没动 / 手持 / 朝向',
    obs?.username === 'Steve' && Math.abs(obs.distance - 2.5) < 0.01 && obs.moving === false
      && obs.held === 'diamond_pickaxe' && obs.facing === '北',
    JSON.stringify(obs))
  ok('nearPlayers 被记下来（供叫醒间隔用）', h.state().nearPlayers === 1)
  ok('不把自己当玩家（players 里含自己也跳过）',
    (h.state().playerObs ?? []).every((p) => p.username !== 'me') && h.state().nearPlayers === 1,
    JSON.stringify(h.state().playerObs))

  const spec2 = h.auto.toolSpec()
  const st2 = await spec2.execute({ action: 'status' }, { agent: h.agent })
  ok('status 文本里能看到旁边的人', st2.text.includes('Steve') && st2.text.includes('2.5'))
  const c = h.auto.setConfig(h.agent, { playerNearRadius: 999, idleWakeNearPlayerSec: 1 }, { persist: false })
  ok('新参数也会被夹取（下限 5s）', c.cfg.playerNearRadius === 64 && c.cfg.idleWakeNearPlayerSec === 5,
    JSON.stringify({ r: c.cfg.playerNearRadius, s: c.cfg.idleWakeNearPlayerSec }))

  // 有人 → 60s 就叫醒（idleWakeNearPlayerSec），而且文案是"直接上手帮，别先问"
  const near = setup({ world: { players: [steve] }, patch: { enabled: false, avoid: false } })
  near.tick(near.at(61_000))
  ok('旁边有人 → 空闲 60s 就叫醒（不用等 180s）', near.agent.steers.length === 1, String(near.agent.steers.length))
  const t1 = near.agent.steers[0]?.content?.[0]?.text ?? ''
  ok('叫醒文案带上"玩家在干什么"', t1.includes('Steve') && t1.includes('diamond_pickaxe') && t1.includes('面向北'))
  ok('有人时的文案 = 直接上手帮 + 不用先问 + 只动他东西才 mc_say',
    t1.includes('旁边有人') && t1.includes('直接上手帮') && t1.includes('不用先问') && t1.includes('mc_say') && t1.includes('mc_observe'))
  ok('文案不再出现"拿不准就先问一句"', !t1.includes('拿不准就先问一句') && !t1.includes('优先去关心玩家'))

  const alone = setup({ patch: { enabled: false, avoid: false } })
  alone.tick(alone.at(61_000))
  ok('没人在旁边 → 61s 还不叫（默认 180s）', alone.agent.steers.length === 0)
  alone.tick(alone.at(181_000))
  const t2 = alone.agent.steers[0]?.content?.[0]?.text ?? ''
  ok('没人时文案说"附近没有别的玩家"', t2.includes('没有别的玩家') && !t2.includes('旁边有人：'))

  // 游荡已删 → 旁边有没有人，反射层都不会自己挪窝（只有 follow 才走）
  const stay = setup({ world: { players: [steve] }, patch: noMove })
  stay.tick(stay.at(60_000))
  ok('旁边有人时不自己挪窝', stay.w.walks.length === 0, JSON.stringify(stay.w.walks))
  const alone2 = setup({ patch: noMove })
  alone2.tick(alone2.at(60_000))
  ok('旁边没人也不自己溜达（游荡已删）', alone2.w.walks.length === 0, JSON.stringify(alone2.w.walks))

  // watchPlayers:false → 不再盯着人（回到随机晃）
  const off = setup({ world: { players: [steve] }, rng: () => 0.9, patch: { ...noMove, lookAround: true, watchPlayers: false } })
  off.tick(off.at(7000))
  ok('watchPlayers:false → 不盯着人看，改随机晃', off.w.calls.lookAt.length === 0 && off.w.calls.look.length === 1,
    JSON.stringify({ lookAt: off.w.calls.lookAt.length, look: off.w.calls.look.length }))
}

/* ───────────────────────── 9. 自主决策（不许反问） ───────────────────────── */

section('9. 自主决策（长期目标 / 别问直接做 / 催促的边界）')
{
  const textOf = (m) => m?.content?.[0]?.text ?? ''
  const nW = (a) => a.steers.filter((m) => textOf(m).includes('自主行动轮')).length
  const nN = (a) => a.steers.filter((m) => textOf(m).includes('别问了，直接做')).length

  // 换成自定义长期目标后，叫醒文案里就是新目标
  const h = setup({ patch: { enabled: false, avoid: false, standing: '今天先把羊圈围起来' } })
  h.tick(h.at(181_000))
  const t = textOf(h.agent.steers[0])
  // 注意：台阶那行（…→末地传送门→末影龙）是**固定**的，跟 standing 无关，
  // 所以"默认目标没出现"只能拿默认目标自己的开头几个字来判，不能拿"末影龙"判。
  ok('叫醒文案用自定义长期目标（默认那句不再出现）',
    t.includes('今天先把羊圈围起来') && !t.includes('和正常玩家一样发展'), t.slice(0, 120))
  ok('文案开头是"自主行动轮"而不是"自主时间"', t.includes('【自主行动轮｜'))
  ok('文案带三条硬规矩（不许反问 / 不许 waitSec 干等 / 观察不算行动）',
    t.includes('不要问他') && t.includes('要我做什么') && t.includes('mc_events waitSec') && t.includes('不算行动'))
  ok('文案告诉它对方改主意时先改长期目标', t.includes('他刚发话给了新指令') && t.includes('先 `mc_auto set {"standing"'))
  ok('整段文案不以问句结尾（不会诱导反问）', !/[？?]\s*$/.test(t.trim()))

  // idleWake:false → 既不叫醒也不催促
  const off = setup({ patch: { enabled: false, avoid: false, idleWake: false } })
  off.tick(off.at(400_000))
  ok('idleWake:false → 没有叫醒也没有催促', off.agent.steers.length === 0)

  // 叫醒后 AI 动手了 → 不催促
  const acted = setup({ patch: { enabled: false, avoid: false } })
  const tA = acted.at(181_000)
  acted.tick(tA)
  acted.setT(tA + 1000)
  acted.auto.noteToolStart('a1')
  acted.auto.noteToolEnd('a1')
  acted.tick(tA + 60_000)
  ok('叫醒后动了手 → 不催促', nN(acted.agent) === 0 && nW(acted.agent) === 1)

  // AI 正在跑一轮 → 不催它（等它跑完）
  const running = setup({ agentStatus: 'running', patch: { enabled: false, avoid: false } })
  running.tick(running.at(181_000))
  running.state().lastWakeAt = running.at(180_000)
  running.state().lastToolAt = running.at(100_000)
  running.tick(running.at(300_000))
  ok('AI 正在跑 → 不叫醒也不催', running.agent.steers.length === 0)

  // 催促也占叫醒额度
  const capped = setup({ patch: { enabled: false, avoid: false, idleWakeMaxPerHour: 1 } })
  capped.tick(capped.at(181_000))
  ok('额度 1 → 叫醒 1 次', nW(capped.agent) === 1)
  capped.tick(capped.at(181_000 + 60_000))
  ok('额度用完 → 催促也被挡掉', nN(capped.agent) === 0 && capped.agent.steers.length === 1)

  // 连叫两轮没动作 → 文案升级 + 催促次数可查
  const twice = setup({ patch: { enabled: false, avoid: false } })
  twice.tick(twice.at(181_000))
  twice.tick(twice.at(181_000 + 60_000))
  ok('第一轮没动作 → 45s 后催促', nN(twice.agent) === 1)
  twice.tick(twice.at(181_000 + 400_000))
  ok('第二轮叫醒（退避翻倍）', nW(twice.agent) === 2, String(nW(twice.agent)))
  twice.tick(twice.at(181_000 + 460_000))
  ok('第二轮没动作 → 再催一条', nN(twice.agent) === 2, JSON.stringify({ w: nW(twice.agent), n: nN(twice.agent) }))
  const st = await twice.auto.toolSpec().execute({ action: 'status' }, { agent: twice.agent })
  ok('status 里能看到催促次数与长期目标', st.text.includes('催促') && st.text.includes('长期目标'))
}

/* ───────────────────────── 10. 待机 5 秒触发 ───────────────────────── */

section('10. 待机 10 秒触发（默认值真的生效 / 退避仍然管用）')
{
  const textOf = (m) => m?.content?.[0]?.text ?? ''
  const h = setup({ timing: false, patch: { enabled: false, avoid: false } })
  const c = h.cfg()
  ok('默认 idleWakeSec = 10（审计后从 5s 改宽）', c.idleWakeSec === 10, String(c.idleWakeSec))
  ok('默认 minIdleGapSec = 5', c.minIdleGapSec === 5, String(c.minIdleGapSec))
  ok('默认 idleWakeNearPlayerSec = 5', c.idleWakeNearPlayerSec === 5, String(c.idleWakeNearPlayerSec))

  h.tick(h.at(9_000))
  ok('待机 9s 还不叫', h.agent.steers.length === 0, String(h.agent.steers.length))
  h.tick(h.at(10_000))
  ok('待机 10s 就叫醒（默认值）', h.agent.steers.length === 1, String(h.agent.steers.length))
  h.tick(h.at(19_000))
  ok('第一次叫醒后还没动作 → 19s 还不叫第二次', h.agent.steers.length === 1, String(h.agent.steers.length))
  h.tick(h.at(20_000))
  ok('到 10s 间隔叫第二次', h.agent.steers.length === 2, String(h.agent.steers.length))
  ok('第二轮文案提示"连着 1 轮只是说话/站着"', textOf(h.agent.steers[1]).includes('连着 1 轮'))
  h.tick(h.at(39_000))
  ok('第二轮也没动作 → 退避翻倍（39s 还不叫）', h.agent.steers.length === 2, String(h.agent.steers.length))
  h.tick(h.at(40_000))
  ok('翻倍后的 20s 叫第三次', h.agent.steers.length === 3, String(h.agent.steers.length))

  // 旁边有人时用的也是 5s（min(idleWakeNearPlayerSec, idleWakeSec)）
  const near = setup({ timing: false, world: { players: [{ name: 'Steve', position: [13.0, 64, 20.5], yaw: 0 }] }, patch: { enabled: false, avoid: false } })
  near.tick(near.at(5_000))
  ok('旁边有人也是 5s 触发', near.agent.steers.length === 1, String(near.agent.steers.length))

  // 说明文案别再说"3 分钟"
  const spec = h.auto.toolSpec()
  ok('工具 description 写的是 10 秒、不再写"3 分钟"',
    spec.description.includes('10 秒') && !spec.description.includes('3 分钟'), spec.description.slice(0, 200))
  const st = await h.auto.toolSpec().execute({ action: 'status' }, { agent: h.agent })
  ok('status 里显示"空闲 10s 叫醒"', st.text.includes('空闲 10s 叫醒'), st.text.slice(0, 200))
}

section('11. 叫醒文案省 token：完整版每 10 分钟一次，其余短版（2026-10-18 审计）')
{
  const textOf = (m) => (m?.content ?? []).map((c) => c?.text ?? '').join('\n')
  const wakes = (h) => h.agent.steers.filter((m) => /自主行动轮/.test(textOf(m)))
  const h = setup({ patch: { lookAround: false, idleWakeSec: 5, minIdleGapSec: 5, idleWakeNearPlayerSec: 5 } })
  h.tick(h.at(6_000))
  await flush()
  const first = textOf(wakes(h)[0] ?? {})
  ok('第一次叫醒是完整版（带发育路线）', /发育路线|末影龙/.test(first), first.slice(0, 120))
  ok('第一次叫醒带三条硬规矩', /三条硬规矩/.test(first), first.slice(0, 120))
  const longLen = first.length

  // 10 分钟内第二次叫醒 ⇒ 短版：不带路线/规矩/默认约束，但该带的都在
  const s1 = h.state()
  s1.lastWakeAt = 0
  s1.noActionStreak = 0
  s1.wakeTimes = []
  h.setT(h.at(12_000))
  h.tick(h.now())
  await flush()
  const second = textOf(wakes(h)[1] ?? {})
  ok('10 分钟内的第二次叫醒是短版', !/发育路线/.test(second) && first.length > 0, second.slice(0, 120))
  ok('短版确实更短（省 token）', second.length > 0 && second.length < longLen * 0.75,
    JSON.stringify({ long: longLen, short: second.length }))
  ok('短版保留：现状 / 长期目标 / 要动手，但不复述规矩条文',
    /长期目标/.test(second) && /只做一个动作/.test(second) && !/不要问他"要我做什么"/.test(second), second.slice(0, 200))
  ok('短版明确说"路线、规矩照上一条"（不丢约束）', /照上一条/.test(second), second.slice(0, 200))

  // 过了 10 分钟 ⇒ 又发完整版
  const s2 = h.state()
  s2.lastBriefAt = h.now() - 11 * 60_000
  s2.lastWakeAt = 0
  s2.wakeTimes = []
  h.setT(h.at(20_000))
  h.tick(h.now())
  await flush()
  const third = textOf(wakes(h)[2] ?? {})
  ok('过了 10 分钟再发完整版', /三条硬规矩/.test(third) && /发育路线/.test(third), third.slice(0, 120))

  // 静态：常量与分支都在
  const strip = (x) => String(x).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))
  ok('常量 BRIEF_EVERY_MS = 10 分钟', /BRIEF_EVERY_MS = 10 \* 60_000/.test(src))
  ok('短版分支只看"这一轮必须知道的"', /if \(!briefFull\) \{/.test(src))
}

section('12. 事件 / 决策审计 / 三种模式（2026-10-18 用户方案 P0+P1+P2）')
{
  const strip = (x) => String(x).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))
  ok('默认模式是 ai-led', /mode: 'ai-led'/.test(src))
  ok('三档模式表存在', /MODE_DEFAULTS = \{/.test(src) && /balanced/.test(src) && /legacy/.test(src))
  ok('显式键优先于模式', /__explicit/.test(src))

  const h = setup({ timing: false, patch: { enabled: true, mode: 'ai-led' } })
  const b0 = h.auto.behaviorOf(h.cfg())
  /* 2026-10-23 审计：ai-led 的 waterRecover 改成 false —— ai-led 承诺「连保命后退也不做」，
   * 而 true 时反射层会自己规划出水路线并抢 jump 控制位（和 AI 的寻路抢 goal）。 */
  ok('ai-led：不环顾/不吃/不捡/不穿/不跟/不保命（含水下自救也不自己走）',
    b0.mode === 'ai-led' && b0.lookAround === false && b0.autoEat === false && b0.pickup === false
    && b0.wearArmor === false && b0.follow === false && b0.avoidReact === false
    && b0.creeperFlee === false && b0.waterRecover === false, JSON.stringify(b0))

  h.auto.setConfig(h.agent, { autoEat: true }, { persist: false })
  const b1 = h.auto.behaviorOf(h.cfg())
  ok('显式 autoEat:true 只改这一项', b1.autoEat === true && b1.pickup === false && b1.mode === 'ai-led', JSON.stringify(b1))

  h.auto.setConfig(h.agent, { mode: 'legacy' }, { persist: false })
  const b2 = h.auto.behaviorOf(h.cfg())
  ok('legacy 全开（含 waterRecover：2026-10-19 用户「要默认开」，但可以用 mc_auto set 关掉）', b2.lookAround && b2.autoEat && b2.pickup && b2.wearArmor && b2.avoidReact && b2.creeperFlee && b2.waterRecover, JSON.stringify(b2))
  h.auto.setConfig(h.agent, { pickup: false }, { persist: false })
  ok('显式 pickup:false 覆盖 legacy', h.auto.behaviorOf(h.cfg()).pickup === false)

  const e1 = h.auto.pushEvent('a1', 'threat', 'z1', { name: 'zombie', distance: 3 })
  const e2 = h.auto.pushEvent('a1', 'threat', 'z1', { distance: 2 })
  ok('同 kind+key 事件合并（不刷屏）', e1 && e2 && e1.id === e2.id && e2.hits >= 2, JSON.stringify({ id: e1?.id, hits: e2?.hits }))
  h.auto.pushEvent('a1', 'drowning', 'w1', { air: 3, health: 8 })
  const pe = h.auto.pendingEvents(h.state(), h.now())
  ok('优先级：溺水排在威胁前面', pe[0]?.kind === 'drowning', pe.map((x) => x.kind).join(','))
  ok('事件带事实字段', pe[0]?.data?.air === 3 && pe[0]?.data?.health === 8, JSON.stringify(pe[0]?.data))

  h.setT(h.now() + 61_000)
  h.tick(h.now())
  await flush()
  const st1 = h.state()
  ok('事件叫醒会开一轮决策', Boolean(st1.decision) && st1.decision.triggers.length === 2, JSON.stringify(st1.decision))
  ok('事件叫醒后事件标 sent（不重复报）', st1.events.filter((e) => e.state === 'sent').length === 2, JSON.stringify(st1.events.map((e) => [e.kind, e.state])))

  h.auto.noteToolStart('a1', { name: 'mc_move' })
  const mid = h.state()
  ok('动作工具给决策分配 actionId', mid.decision?.actionId != null && mid.decision.phase === 'acting', JSON.stringify(mid.decision))
  h.auto.noteToolEnd('a1', { name: 'mc_move', state: 'error' })
  const rec = h.state().decisions[0]
  ok('动作结束写审计：工具/结果/触发事件', Boolean(rec) && rec.chosenTool === 'mc_move' && rec.executionOutcome === 'error' && rec.triggers.length === 2, JSON.stringify(rec))
  ok('决策收尾会结算事件', h.state().events.every((e) => e.state === 'done'), JSON.stringify(h.state().events.map((e) => e.state)))
  h.auto.noteToolStart('a1', { name: 'mc_observe' })
  h.auto.noteToolEnd('a1', { name: 'mc_observe' })
  ok('观察工具递增 obsVer 并回填下一条决策', h.state().obsVer >= 1 && h.state().decisions[0].nextObservationId != null,
    JSON.stringify({ obs: h.state().obsVer, next: h.state().decisions[0].nextObservationId }))

  const hs = setup({ patch: { quietAfterToolMs: 500, idleWakeSec: 99_999, minIdleGapSec: 5, lookAround: false } })
  hs.sess.bot.taskList = () => [{ taskId: 't1', status: 'running', updatedAt: 111, steps: [{ id: 's1', status: 'running' }] }]
  // 第一条 tick 只是建状态（lastToolAt = 现在，quiet 为 false），所以多推几拍
  hs.setT(hs.at(10_000)); hs.tick(hs.now()); await flush()
  hs.setT(hs.at(20_000)); hs.tick(hs.now()); await flush()
  hs.setT(hs.at(120_000)); hs.tick(hs.now()); await flush()
  hs.setT(hs.at(220_000)); hs.tick(hs.now()); await flush()
  ok('台账 90 秒没变化 ⇒ 记 task_stalled 事件', hs.state().events.some((e) => e.kind === 'task_stalled'), JSON.stringify(hs.state().events.map((e) => e.kind)))

  const st = h.auto.statusOf(h.agent, h.sess)
  ok('status 报模式与生效行为', st.mode === 'legacy' && st.behavior?.pickup === false, JSON.stringify({ mode: st.mode }))
  ok('status 报待处理事件与最近决策', Array.isArray(st.pendingEvents) && Array.isArray(st.recentDecisions), JSON.stringify(Object.keys(st)))

  ok('stopWork 记 interrupt 事件', /pushAutoEvent\(s, 'interrupt'/.test(src))
  ok('step 里有事件叫醒与任务停滞', /eventWake\(s, sess, cfg, t\)/.test(src) && /task_stalled/.test(src))
  ok('提示词要求一次只做一个动作', /只做一个动作/.test(src) && /一次只走一步/.test(src))
  ok('工具描述写了三档模式与默认 ai-led', /ai-led/.test(src) && /默认 `ai-led`/.test(src))
}

section('创造 / 旁观模式不自行报警（2026-10-19 实机：一晚上七十多次"slime 贴上来了"）')
{
  const autoSrc = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
  ok('🔴 威胁检测入口对创造/旁观模式直接返回（不掉血的模式不该叫醒）',
    /if \(b\.game\?\.gameMode === 'creative' \|\| b\.game\?\.gameMode === 'spectator'\) return/.test(autoSrc))
}

section('龙息云提醒（2026-10-19 用户：「现在不会躲龙息，检测到龙息应该提醒」）')
{
  const autoSrc = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
  ok('import 了 danger.mjs 的 breathNear / fireballNear',
    /import \{ breathNear, BREATH_NEAR_R, fireballNear, FIREBALL_NEAR_R \} from '\.\.\/src\/danger\.mjs'/.test(autoSrc))
  ok('火球检测排在龙息云之前（火球还在飞 ⇒ 落地才变云）',
    autoSrc.indexOf('const ball = fireballNear(b, FIREBALL_NEAR_R)') > 0
    && autoSrc.indexOf('const ball = fireballNear(b, FIREBALL_NEAR_R)') < autoSrc.indexOf('const breath = breathNear(b, BREATH_NEAR_R)'))
  ok('有专属叫醒分支"龙息火球飞过来了"', /自保：龙息火球飞过来了/.test(autoSrc))
  ok('火球文案给侧移坐标 + "躲到方块后面"', /横向挪开（首选，火球走直线）/.test(autoSrc) && /躲到方块后面/.test(autoSrc))
  ok('事件 kind=fireball 入队', /pushAutoEvent\(s, 'fireball'/.test(autoSrc))
  ok('事件优先级 fireball 高于 breath', /fireball: 94, breath: 93/.test(autoSrc))
  ok('steer 的 summary 能认出 fireball', /summary: ball/.test(autoSrc))
  ok('每 tick 先查龙息（排在威胁清单之前）',
    autoSrc.indexOf('const breath = breathNear(b, BREATH_NEAR_R)') > 0
    && autoSrc.indexOf('const breath = breathNear(b, BREATH_NEAR_R)') < autoSrc.indexOf('const foes = hostilesNear(b, RANGED_NEAR_RADIUS, { hurtRecently })'))
  ok('踩进云里（<=3 格）直接 return，不排别的险情', /if \(breath\.distance <= 3\) return/.test(autoSrc))
  ok('有专属节流常量 BREATH_WAKE_GAP_MS', /const BREATH_WAKE_GAP_MS = \d+/.test(autoSrc))
  ok('事件入队 kind=breath（决策审计里能看到）', /pushAutoEvent\(s, 'breath'/.test(autoSrc))
  ok("事件优先级表里有 breath（比 creeper 高、比 drowning 低）", /breath: 93/.test(autoSrc))
  ok('叫醒文案有专属分支（不是混在"被打"里）', /自保：龙息云贴上来了/.test(autoSrc))
  ok('叫醒文案给出"往哪跑"的 mc_move 坐标', /跑出云外（首选）/.test(autoSrc))
  ok('文案里带上"往上垫两格"这条退路（云贴地）', /云贴地、不往上涨/.test(autoSrc))
  ok('steer 的 summary 能认出 breath', autoSrc.includes('summary: ball') && autoSrc.includes('MC 自保：龙息云在'))
}

/* 🔴 2026-10-28 用户：「现在游泳还是不是自动浮，要游的时候才会浮。我要的是 auto 自动浮起来，
 *   可关掉。和有没有 move 没关系」—— 新增 autoFloat：头在水下就按住 jump，眼睛一出水立刻松手。
 *   和 waterRecover 是两件事：那条是自己搜出口逃出去，这条只负责"别沉底"。 */
section('autoFloat：落水自动上浮（与 move 无关、可关）')
{
  const autoSrc3 = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
  ok('默认开', /autoFloat: true,/.test(autoSrc3))
  ok('三档模式都有它（ai-led 也开）', (autoSrc3.match(/autoFloat: true/g) || []).length >= 4)
  ok('显式写过就覆盖模式默认（over 列表里有 autoFloat）', /over\('autoFloat'\)/.test(autoSrc3))
  /* 🔴 2026-10-29 用户：「自动上浮跳动太大，平稳一点…最好让它稳在水面上」——
   *    旧判据是"眼睛那格是液体就按、一出水就撒手"，出水时带上冲速度 ⇒ 冲出水面再砸回来。
   *    现在按**水面高度**（autoFloatTop）做带死区的开关量控制。 */
  ok('按水面高度判（autoFloatTop：连续液体最高一格 + 1）',
    /const autoFloatTop = \(b, e\) =>/.test(autoSrc3) && /const topY = autoFloatTop\(b, e\)/.test(autoSrc3))
  ok('不再拿"眼睛那格是液体"当开关（会同复拉锯）',
    !/const headUnder = submerged\b/.test(autoSrc3) && !/Boolean\(e\?\.isInWater\) && submergedIn/.test(autoSrc3))
  ok('沉到水面下 0.12 格才上浮（死区，不来回切）', /below > 0\.12/.test(autoSrc3))
  ok('高出水面 0.10 格就松手', /below < -0\.10/.test(autoSrc3))
  ok('快出水带冲速时提前松手（别冲过头）', /vy > 0\.20 && below < 0\.5/.test(autoSrc3))
  ok('按住 jump（走 holdCtl 统一口子，400ms 短脉冲）', /holdCtl\(sess, 'jump', 400/.test(autoSrc3))
  /* 2026-10-29（用户：「自动上浮失效了」）：以前是“工具刚调完 1.2 秒就让开”，
   * 只要 AI 在连着调工具（挖矿/打怪/观察）就永远让开 ⇒ 人一路沉底。
   * 现在只看“游泳段是不是正在控 jump”（walkSwim 每拍写 `b.__swimCtlAt`）。 */
  ok('让开只认“游泳段正在控 jump”（不再因为工具刚调完就让开）',
    /const swimCtl = t - num\(b\?\.__swimCtlAt, 0\) < 600/.test(autoSrc3)
    && /const ready = topY != null && eyeY != null && !swimCtl/.test(autoSrc3)
    && !/t - num\(s\.lastToolAt, 0\) > 1_200/.test(autoSrc3))
  ok('这一段里不叫醒、不寻路（只有 holdCtl）',
    !/if \(beh\.autoFloat !== false\) \{[\s\S]{0,700}?(wakeForDanger|startWaterRecover)/.test(autoSrc3))
  ok('状态字段齐（floatAt / floatHeld / lastFloatLoggedAt）',
    /floatAt: 0,/.test(autoSrc3) && /floatHeld: false,/.test(autoSrc3) && /lastFloatLoggedAt: 0,/.test(autoSrc3))
  /* 行为级：假世界里"眼睛那格是水" ⇔ world.submerged，其余格子是 air。 */
  const wet = setup({ world: { inWater: true, air: 20, submerged: true, health: 20 }, patch: { lookAround: false, waterRecover: false, autoFloat: true } })
  wet.tick(wet.at(5000))
  ok('泡在水面下 ⇒ 真的按住 jump 往上浮（行为级）',
    wet.w.calls.controls.filter(([k, v]) => k === 'jump' && v === true).length >= 1)
  const dry = setup({ world: { inWater: false, air: 20, submerged: false, health: 20 }, patch: { lookAround: false, waterRecover: false, autoFloat: true } })
  dry.tick(dry.at(5000))
  ok('没在水里 ⇒ 一下都不按（不会站着乱跳）',
    dry.w.calls.controls.filter(([k, v]) => k === 'jump' && v === true).length === 0)
}

/* ───────────────────────── 汇总 ───────────────────────── */

console.log('')
if (fails.length) {
  console.log(`✘ 失败 ${fails.length} 项：`)
  for (const f of fails) console.log(`   · ${f}`)
}
console.log(`check-mc-auto：pass=${pass} fail=${fails.length}`)
if (!process.argv.includes('--keep')) {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ } }
}
process.exit(fails.length ? 1 : 0)
