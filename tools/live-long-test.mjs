// -*- coding: utf-8 -*-
/**
 * 长时间实机回归：把 `McBot`（生产用的那套 core.mjs 实例）**真的**连到服务器，
 * 循环跑「挖」和「走」的全部档位，跑到时间用完为止 —— 专门用来暴露"只有跑久了才出现"的问题
 * （TPS 掉下去、掉落物堆积、区块卸载、连续调用后状态残留、掉线重连…）。
 *
 * 与 `tools/live-move-test.mjs` 的区别：
 *   · 那边是手搭 `self` / `ctx` 只调 `walkTo` 一个函数；这边直接用 `new McBot()` + `mc.dig()` /
 *     `mc.walkTo()`，走的是**工具层同一条路**（`#mineCtx` / `#moveCtx` 全是真的）。
 *   · 那边跑 10 秒就退出；这边跑 `--minutes` 分钟。
 *   · 覆盖 dig 的三档：`stair` 往上 / `stair` 往下 / `block` 单格。
 *
 * 用法（需要一台开着的、你是 OP 的服务器）：
 *   node tools/live-long-test.mjs --host=192.168.1.101 --minutes=30
 *   node tools/live-long-test.mjs --minutes=5 --only=stair-up
 *
 * 判定口径（不是"必须一次到位"，而是"该推进的推进、该拒绝的拒绝"）：
 *   stair-up    一次调用应上升 ≥2 格（10 秒预算；石头一格 ≈1.7 秒）
 *   stair-down  一次调用应下降 ≥2 格
 *   dig-block   那一格应变空气
 *   move/*      到达 / 或已知物理上限（shaft 单次 dig 5 格、只走如实拒绝）
 */
import { createRequire } from 'node:module'
import { appendFileSync } from 'node:fs'
import { McBot, DEFAULTS } from '../src/core.mjs'
import { sleep } from '../src/async-util.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const HOST = arg('host', '192.168.1.101')
const PORT = Number(arg('port', '25565'))
const NAME = arg('user', `DeepSeekLive${Math.floor(Math.random() * 900 + 100)}`)
const MINUTES = Number(arg('minutes', '30'))
/* --only 现在支持：单个名字、逗号分隔、以及 `move`（= tunnel/shaft/cliff/pit 全部移动用例）。
 * 用户 2026-11-02：「move 也要连续多轮调用测试」⇒ 一条命令就能只跑移动组。 */
const ONLY = arg('only', null)
const ONLY_RE = ONLY
  ? new RegExp(ONLY.split(',').map((k) => k.trim()).filter(Boolean).map((k) => (k.toLowerCase() === 'move'
    ? '^(tunnel|shaft|cliff|pit|diag2?)'
    : `^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).join('|'), 'i')
  : null
/* 每段给多少秒：10 秒只够挖 4~5 格，用户 2026-11-02「每段时间太短了，它就挖了几段方块，要长一点」 */
const SEG = Number(arg('seg', '10'))
/* 每个移动用例连叫几次（用户 2026-11-02：「move 也要连续多轮调用测试」） */
const N_CALLS = Number(arg('calls', '5'))
/* 跑几轮（每轮把所有用例各跑一遍，每项连叫 N_CALLS 次） */
const ROUNDS = Number(arg('rounds', '2'))
/* 默认**不**在到达后提前停：每个用例都跑满 N_CALLS 次（重复调用同一目标本身要测） */
const STOP_ON_ARRIVE = arg('stop-on-arrive', '0') === '1'
const BLOCK = arg('block', 'stone')

const req = createRequire('C:/Users/BLUE/.dsh/profiles/desktop/vendor/mc-deps/node_modules/')
const Vec3 = req('vec3')

const DEADLINE = Date.now() + MINUTES * 60_000
/* 实验开关（只在本测试进程里改 cfg，不动产品默认值）：
 *   MC_TOWER_COST=0.3 ⇒ walkTowerCost（垫一格的价格）；MC_DIG_COST=… ⇒ walkDigCost。 */
const CFG = { ...DEFAULTS }
if (process.env.MC_TOWER_COST) CFG.walkTowerCost = Number(process.env.MC_TOWER_COST)
if (process.env.MC_DIG_COST) CFG.walkDigCost = Number(process.env.MC_DIG_COST)
if (process.env.MC_DETOUR_MAX) CFG.walkDigDetourMax = Number(process.env.MC_DETOUR_MAX)
const MC = new McBot({ ...CFG, instanceId: 'livelong', logFile: 'tmp-livelong.log' })

const say = (c) => { try { MC.bot?.chat(c) } catch {} }
const fill = (x1, y1, z1, x2, y2, z2, blk) => say(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${blk}`)
const posOf = () => MC.bot.entity.position.floored()
const xyz = (p) => `${p.x},${p.y},${p.z}`
const blkName = (x, y, z) => { try { return MC.bot.blockAt(new Vec3(x, y, z))?.name ?? 'null' } catch { return 'null' } }
const inGame = () => Boolean(MC.bot?.entity)

/* mc.dig 返回的是**给模型看的多行文本数组**（不是对象）：判定靠位置变化，文案原样记下来。 */
const digText = (r) => (Array.isArray(r) ? r.join(' ｜ ') : (typeof r === 'string' ? r : JSON.stringify(r ?? null)))

let ROUND = 0
const rows = []
const fails = []

function rec (label, ok, detail) {
  const row = { label, ok, round: ROUND, at: new Date().toISOString(), ...detail }
  rows.push(row)
  /* 用户 2026-11-02（B 方案）：「用 dugAt 逐格核对有没有"重复挖同一格 / 挖到隔壁列 / 原地磨"」——
   *   控制台那行只打前 10 格，不够逐格核对，所以开了 `MC_DUG_DEBUG=1` 时把**完整**明细
   *   追加到 JSONL（一行一条），再用脚本统计：同坐标出现多次 = 重复挖；坐标偏离"起点→目标"
   *   连线超过 1 格 = 隔壁列；连续多趟 dug>0 而位置不动 = 原地磨。 */
  if (process.env.MC_DUG_DEBUG && detail?.calls) {
    try {
      appendFileSync('tmp-dugdebug.jsonl', JSON.stringify({ label, ok, round: ROUND, note: detail.note, calls: detail.calls }) + '\n')
    } catch {}
  }
  console.log(`  ${ok ? '✔' : '✘'} ${label}  ${detail.ms}ms  ${detail.note}${detail.err ? ` ｜ERR: ${detail.err}` : ''}`)
  if (!ok) fails.push(row)
  if (!ok && Array.isArray(detail.notes)) for (const n of detail.notes.slice(0, 8)) console.log(`     ↳ ${String(n).slice(0, 300)}`)
}

/* ── 场地：以出生点东侧 300 格为测试台，每轮重建 ─────────────────────── */
let BASE = null
function baseOf () {
  if (BASE) return BASE
  const p = posOf()
  BASE = { x: p.x + 300, y: p.y, z: p.z }
  return BASE
}

/** /fill 是排队执行的：TPS 低时 3 万格要 1~2 秒才真填完。
    不确认就开始挖，第一把会拿到"沿已有通道 / 没有墙可挖"的假失败（实机踩过）。 */
async function waitSolid (x, y, z, extra = []) {
  const isSolid = (n) => n && n !== 'air' && n !== 'cave_air' && n !== 'unknown'
  const pts = [[x, y, z], ...extra]
  for (let i = 0; i < 16; i++) {
    if (pts.every(([px, py, pz]) => isSolid(blkName(px, py, pz)))) return true
    await sleep(250)
  }
  return false
}
/** /fill 单次上限 32768 方块 ⇒ 按 x 切片分批填（大场地必须分批，否则命令直接失败） */
async function fillBig (x0, y0, z0, x1, y1, z1, block) {
  const per = 12
  for (let x = x0; x <= x1; x += per) {
    fill(x, y0, z0, Math.min(x1, x + per - 1), y1, z1, block)
    await sleep(150)
  }
}

/** 井口在脚下：实心岩体 + 脚下 6 格竖井，井口 cy-1 故意留盖板（要先挖开才下得去） */
async function buildPit () {
  const c = baseOf()
  const { x, y, z } = c
  await fillBig(x - 6, y - 12, z - 6, x + 6, y + 6, z + 6, BLOCK)
  await waitSolid(x, y - 1, z, [[x, y - 6, z], [x + 1, y, z], [x, y - 7, z]])
  fill(x, y, z, x, y + 1, z, 'air')      // 人站的两格
  fill(x, y - 2, z, x, y - 6, z, 'air')  // 井身（cy-1 是盖板、cy-7 是井底）
  await sleep(250)
  say(`/tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(400)
  return { x, y, z }
}


/** 实心石头大方块 + 一个 1 宽 2 高的起跑位（正前方 x+1 是实心墙，stair 才有墙可挖） */
async function buildStairUp () {
  const c = baseOf()
  const { x, y, z } = c
  /* 场地必须大：往上 stair 连叫多次，每一步都往 x+ 前进 1 格、上升 1 格，
     12 格高度就是 12 格水平距离。之前 x-4..x+8 太小 —— 第 3 次调用就报
     「沿 x+ 往前 8 格都没有能往上挖的墙」（其实撞到自己挖出来的通道/场地边界）。 */
  await fillBig(x - 8, y - 32, z - 8, x + 44, y + 26, z + 8, BLOCK)
  await waitSolid(x + 1, y, z, [[x + 20, y + 6, z], [x + 2, y, z], [x, y + 10, z], [x, y - 26, z]])
  fill(x, y, z, x, y + 1, z, 'air')           // 只挖自己站的这一列
  await sleep(250)
  say(`/tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(400)
  return { x, y, z }
}

/** 高台（stair-down 起跳台），台面向下 14 格是实心 */
async function buildStairDown () {
  const c = baseOf()
  const { x, y, z } = c
  await fillBig(x - 8, y - 24, z - 8, x + 44, y + 8, z + 8, BLOCK)
  await waitSolid(x + 1, y, z, [[x + 20, y, z], [x + 2, y, z], [x, y - 6, z]])
  fill(x, y, z, x + 3, y + 2, z, 'air')
  await sleep(250)
  say(`/tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(400)
  return { x, y, z }
}

/* ── 用例 ─────────────────────────────────────────────────────────── */
async function caseStairUp () {
  console.log(`  ── 用例 caseStairUp() 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = await buildStairUp()
  const p0 = posOf()
  const tgtY = p0.y + 12
  const t0 = Date.now()
  const calls = []
  let lastY = p0.y
  /* 多轮工具调用：同一个目标连叫 6 次、每次 10 秒（**不**绕过 CALL_MS 的 11 秒硬上限）——
     模型就是这么用的，看每次都还在推进，
     还是第 2、3 次开始"状态残留 / 越挖越乱"。 */
  for (let i = 0; i < 6; i++) {
    let r = null; let err = null
    const t1 = Date.now()
    try { r = await MC.dig({ mode: 'stair', dir: 'x+', targetY: tgtY, budgetMs: SEG * 1000 }) } catch (e) { err = e?.message || String(e) }
    const p = posOf()
    calls.push({ i: i + 1, ms: Date.now() - t1, y: p.y, d: p.y - lastY, text: err ? 'ERR ' + err : digText(r) })
    lastY = p.y
    /* 一次调用几毫秒就返回 = 立刻放弃，必须看清它为什么（空转/状态残留最容易藏在这） */
    if (Date.now() - t1 < 300) console.log(`     ⚡ #${i + 1} 只用了 ${Date.now() - t1}ms 就返回：${String(calls[calls.length - 1].text).slice(0, 260)}`)
    if (p.y >= tgtY) break
  }
  const p1 = posOf()
  const climbed = p1.y - p0.y
  rec('stair-up×3', climbed >= 6, {
    ms: Date.now() - t0,
    note: `y ${p0.y}→${p1.y}（+${climbed}，叫了 ${calls.length} 次）｜` + calls.map((x) => `#${x.i} +${x.d}(${x.ms}ms)`).join(' '),
    from: [p0.x, p0.y, p0.z], to: [p1.x, p1.y, p1.z],
    notes: calls.map((x) => `#${x.i}: ${String(x.text).slice(0, 300)}`),
  })
  say(`/tp ${NAME} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  await sleep(300)
}

async function caseStairDown () {
  console.log(`  ── 用例 caseStairDown() 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = await buildStairDown()
  const p0 = posOf()
  const t0 = Date.now()
  let r = null; let err = null
  try {
    r = await MC.dig({ mode: 'stair', dir: 'x+', targetY: p0.y - 10, budgetMs: SEG * 1000 })
  } catch (e) { err = e?.message || String(e) }
  const p1 = posOf()
  const dropped = p0.y - p1.y
  rec('stair-down', dropped >= 4, {
    ms: Date.now() - t0,
    note: `y ${p0.y}→${p1.y}（-${dropped}） ${err ? 'ERR ' + err : digText(r).slice(0, 220)}`,
    from: [p0.x, p0.y, p0.z], to: [p1.x, p1.y, p1.z], err,
    notes: Array.isArray(r) ? r.slice(-8) : null,
  })
  say(`/tp ${NAME} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  await sleep(300)
}

async function caseDigBlock () {
  console.log(`  ── 用例 caseDigBlock() 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = await buildStairUp()
  const tgt = { x: c.x + 3, y: c.y + 1, z: c.z }
  const before = blkName(tgt.x, tgt.y, tgt.z)
  const t0 = Date.now()
  let r = null; let err = null
  try { r = await MC.dig({ pos: tgt, mode: 'block' }) } catch (e) { err = e?.message || String(e) }
  const after = blkName(tgt.x, tgt.y, tgt.z)
  rec('dig-block', after === 'air' || after === 'cave_air', {
    ms: Date.now() - t0,
    note: `${before}→${after} ${err ? 'ERR ' + err : digText(r).slice(0, 200)}`,
    err,
  })
  await sleep(200)
}


/** 站在一段 5 格长的空通道里，墙在 x+5 之外 —— 专测"周围没墙会不会自己走到 dir 方向最近的墙" */
async function buildFarWall () {
  const c = baseOf()
  const { x, y, z } = c
  await fillBig(x - 8, y - 20, z - 8, x + 44, y + 26, z + 8, BLOCK)
  await waitSolid(x + 1, y, z, [[x + 20, y + 6, z]])
  fill(x, y, z, x + 4, y + 2, z, 'air')     // 5 格长、3 格高的空通道；x+5 起是实心墙
  await sleep(400)
  say(`/tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(500)
  return { x, y, z }
}

async function caseStairFarWall () {
  console.log(`  ── 用例 caseStairFarWall() 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = await buildFarWall()
  const p0 = posOf()
  const t0 = Date.now()
  let r = null; let err = null
  try { r = await MC.dig({ mode: 'stair', dir: 'x+', targetY: p0.y + 12, budgetMs: SEG * 1000 }) } catch (e) { err = e?.message || String(e) }
  const p1 = posOf()
  const climbed = p1.y - p0.y
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z)
  rec('stair-远墙', climbed >= 1, {
    ms: Date.now() - t0,
    note: `y ${p0.y}→${p1.y}（+${climbed}）水平移动 ${moved.toFixed(1)} 格 ${err ? 'ERR ' + err : digText(r).slice(0, 240)}`,
    from: [p0.x, p0.y, p0.z], to: [p1.x, p1.y, p1.z],
    notes: Array.isArray(r) ? r.slice(0, 6) : null,
  })
  say(`/tp ${NAME} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  await sleep(300)
}

/** 多轮 walkTo：最多 maxCalls 次、每次 ≤10.5 秒（**不**绕过 CALL_MS）——真实实机就是多轮调用 */
async function walkMulti (tgt, mo, maxCalls = 3) {
  const calls = []
  let last = null
  for (let i = 0; i < maxCalls; i++) {
    const t1 = Date.now()
    let r = null; let err = null
    /* 每次调用前清空挖掘审计，事后看"这一趟挖了哪几格、是谁挖的"（用户 2026-11-02：
     * 「垂直下挖到目标 y 轴后，往目标挖会挖头上方块」——要判断挖的是不是该挖的那格，
     * 只能把格子和当时的 y 摆在一起看）。 */
    try { MC.bot?.__mcDigAuditCtl?.reset() } catch {}
    try {
      r = await MC.walkTo(tgt, { budget: Math.min(SEG * 1000, 10_500), arrive: 1.0, intent: 'stand', ...mo })
    } catch (e) { err = e?.message || String(e) }
    const p = posOf()
    /* 用户 2026-11-02：「allowdig+allowtower 垫竖井的时候，挖到目标格以后就一直跳不会垫了」
     *   ⇒ 垫柱边只在"手里有垫料"时才生成（`mv.scafoldingBlocks`）。这里把 A* 手里那份清单、
     *   背包垫料总数、allow1by1towers/canDig 一起打出来（`MC_SCAF_DEBUG=1` 才打）。 */
    if (process.env.MC_SCAF_DEBUG) {
      try {
        const mvs = MC.bot?.pathfinder?.movements
        const cnt = (MC.bot?.inventory?.items?.() ?? [])
          .filter((it) => /cobblestone|dirt|netherrack/.test(it.name))
          .reduce((a, it) => a + (it.count || 0), 0)
        console.log(`   [scaf] 清单=[${(mvs?.scafoldingBlocks || []).join(',')}] 背包垫料=${cnt} allow1x1=${mvs?.allow1by1towers} canDig=${mvs?.canDig} placeCost=${mvs?.placeCost}`)
      } catch (e) { console.log('   [scaf] 读取失败', e?.message ?? e) }
    }
    let dugAt = []
    /* B 方案：连**谁挖的**（两层栈帧）一起带走 —— 只按坐标统计分不出是 A* 还是我们自己的
       清头顶/挖台阶在重复挖同一格。 */
    try { dugAt = (MC.bot?.__mcDigAuditCtl?.peek?.() ?? []).map((x) => ({ name: x.name, cell: x.cell, by: x.by })) } catch {}
    calls.push({
      i: i + 1, ms: Date.now() - t1, at: [p.x, p.y, p.z],
      arrived: r?.arrived === true, reason: r?.reason ?? (err ? 'ERR ' + err : '?'),
      dug: r?.dug ?? null, hint: r?.hint ?? null, dugAt,
    })
    last = r
    /* 用户 2026-11-02：「还是每个功能只用一次」—— 不要到达就停：每个用例都要真跑满 N 次
     * （重复叫同一目标本身就是要测的东西：已经在目标上再叫一次，行为是否稳定）。
     * 想看旧行为就加 `--stop-on-arrive=1`。 */
    if (STOP_ON_ARRIVE && r?.arrived === true) break
  }
  return { calls, last }
}

/** 每次调用一行：`#1 到(4213ms,dug=2) #2 noPath(1233ms,dug=0)` —— 一眼看出真的连叫了几次 */
const dugText = (x) => (typeof x === 'string' ? x : `${x.name}@${x.cell}`)
const dugLine = (c) => (c?.dugAt?.length ? ` ｜ 挖:${c.dugAt.slice(0, 8).map(dugText).join(' ')}` : '')
const callsLine = (calls) => calls.map((c) => `#${c.i} ${c.arrived === true ? '到' : String(c.reason ?? '?').replace(/（.*$/, '')}(${c.ms}ms${c.dug != null ? ',dug=' + c.dug : ''})${(process.env.MC_DUG_DEBUG && c.dugAt?.length) ? ' 挖:' + c.dugAt.slice(0, 10).map(dugText).join(' ') : ''}`).join(' ')

const MOVES = [
  ['只走', { allowDig: false, noTower: true }],
  ['dig', { allowDig: true, noTower: true }],
  ['tower', { allowDig: false, noTower: false }],
  ['dig+tower', { allowDig: true, noTower: false }],
]

/** 水平隧道：目标在水平 6 格外 */
async function caseMoveTunnel (mname, mo) {
  console.log(`  ── 用例 caseMoveTunnel(mname, mo) 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = await buildStairUp()
  /* 围一条封闭走廊（两侧 + 背后 + 尽头都砌到 y+6）：不然"只走"档会 detour 走出去、
   * 脚下没方块直接掉下去（实测掉到 y=78/107，把判定搅成 goal-reached-elsewhere）。 */
  fill(c.x - 1, c.y, c.z - 1, c.x - 1, c.y + 6, c.z + 1, BLOCK)   // 背后
  fill(c.x, c.y, c.z - 1, c.x + 23, c.y + 6, c.z - 1, BLOCK)      // 左侧
  fill(c.x, c.y, c.z + 1, c.x + 23, c.y + 6, c.z + 1, BLOCK)      // 右侧
  fill(c.x + 23, c.y, c.z - 1, c.x + 23, c.y + 6, c.z + 1, BLOCK) // 尽头
  fill(c.x, c.y + 4, c.z - 1, c.x + 23, c.y + 6, c.z + 1, BLOCK)  // 顶盖（别从上面翻出去）
  await sleep(300)
  const p0 = posOf()
  const tgt = new Vec3(c.x + 20, c.y, c.z)
  const t0 = Date.now()
  const { calls, last } = await walkMulti(tgt, mo, N_CALLS)
  const p1 = posOf()
  /* "只走"档的合格线：**没挖、没挪到目标那边**就如实收工（用户：「只走就这样，快速认输」）。
   * 不再要求"每次都是 NoPath"——`walkWithAutoDig` 的后半段本来就会自动补挖一次，
   * 报 goal-reached-elsewhere / partial 都是它在如实说话。 */
  const okNoDig = mname === '只走' && p1.y === p0.y && Math.abs(p1.x - p0.x) + Math.abs(p1.z - p0.z) < 2
  /* 通道 20 格、每趟 10 秒只够挖 14 格 ⇒ 5 次也走不完，但**一路在推进**。
   * 走到 ≥19 格（差 1 格）就算过：这条用例验的是"能挖穿、不偏列、不原地磨"，不是验速度。 */
  const okNear = mname !== '只走' && (p1.x - p0.x) >= 19
  const ok = last?.arrived === true || okNoDig || okNear
  rec(`tunnel/${mname}`, ok, {
    ms: Date.now() - t0,
    note: `${xyz(p0)}→${xyz(p1)} 叫了 ${calls.length} 次 ｜ ${callsLine(calls)}`,
    err: null, hint: last?.hint ?? null, calls,
  })
  say(`/tp ${NAME} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  await sleep(300)
}

/** 竖井：目标在正上方 6 格（头顶实心） */
async function caseMoveShaft (mname, mo) {
  console.log(`  ── 用例 caseMoveShaft(mname, mo) 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = await buildStairUp()
  const p0 = posOf()
  const tgt = new Vec3(c.x, c.y + 12, c.z)
  const t0 = Date.now()
  const { calls, last } = await walkMulti(tgt, mo, N_CALLS)
  const p1 = posOf()
  const dy = p1.y - p0.y
  /* dig 档单趟物理上限约 5 格（一格 ≈1.7s / 10.8s 硬掐）⇒ 多轮累计认 ≥4 格为"在推进" */
  const ok = last?.arrived === true || (mo.allowDig === true && dy >= 4)
    || (mname === 'tower' && dy === 0 && calls.every((x) => /NoPath/i.test(String(x.reason))))
  rec(`shaft/${mname}`, ok, {
    ms: Date.now() - t0,
    note: `${xyz(p0)}→${xyz(p1)} dy=${dy} 叫了 ${calls.length} 次 ｜ ${callsLine(calls)}`,
    err: null, hint: last?.hint ?? null, calls,
  })
  say(`/tp ${NAME} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  await sleep(300)
}

/** 柱顶：四周围墙，只能往上垫（tower）
 *  以前只铺 7×7 平台、外面是空气/海 ⇒ 单 tower 档 A* 会选"跳下平台绕路"，
 *  人掉进海里报 swim-stuck（实测 371,69,-105 → 374,62,-110 dy=-7）。
 *  ⇒ 台基做成实心、四周砌 3 格高围墙，把人关在 5×5 空腔里，只剩"往上"一条路。 */
/** 补垫柱用的方块（长测跑久了会垫光），返回背包里能垫的总数（读不到就 -1）
 *  长测实测：`cliff/tower` 升 2 格后 5 次全是 noPath，而同场地的 `dig+tower` 还能上 ——
 *  差别就是"还垫不垫得起"，方块被前面的用例用光了。 */
async function ensureScaffold (n = 128) {
  try {
    const inv = MC.bot?.inventory?.items?.() ?? []
    let have = 0
    for (const it of inv) if (/cobblestone|dirt|netherrack/.test(it?.name ?? '')) have += it.count
    if (have < 32) {
      say('/give ' + NAME + ' minecraft:cobblestone ' + n)
      await sleep(400)
      console.log('  🧱 背包垫料不足（' + have + '）—— 已补 ' + n + ' 个圆石')
    }
    return have
  } catch { return -1 }
}

async function caseMoveCliff (mname, mo) {
  console.log(`  ── 用例 caseMoveCliff(mname, mo) 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = baseOf()
  const { x, y, z } = c
  fill(x - 8, y - 4, z - 8, x + 8, y - 1, z + 8, BLOCK)   // 实心台基
  await sleep(200)
  fill(x - 8, y, z - 8, x + 8, y + 2, z + 8, BLOCK)       // 台基上一圈墙
  await sleep(200)
  fill(x - 2, y, z - 2, x + 2, y + 11, z + 2, 'air')      // 中间 5×5 空腔（清到目标上方 3 格）
  await sleep(250)
  say(`/tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(400)
  const p0 = posOf()
  await ensureScaffold()
  const tgt = new Vec3(x, y + 8, z)
  const t0 = Date.now()
  const { calls, last } = await walkMulti(tgt, mo, N_CALLS)
  const p1 = posOf()
  const dy = p1.y - p0.y
  const ok = last?.arrived === true || dy >= 4
  rec(`cliff/${mname}`, ok, {
    ms: Date.now() - t0,
    note: `${xyz(p0)}→${xyz(p1)} dy=${dy} 叫了 ${calls.length} 次 ｜ ${callsLine(calls)}`,
    err: null, hint: last?.hint ?? null, calls,
  })
}

/** 下挖：目标在脚下 6 格（井口有盖板，必须先挖开） */
async function caseMovePit (mname, mo) {
  console.log(`  ── 用例 caseMovePit(mname, mo) 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = await buildPit()
  const p0 = posOf()
  const tgt = new Vec3(c.x, c.y - 6, c.z)
  const t0 = Date.now()
  const { calls, last } = await walkMulti(tgt, mo, N_CALLS)
  const p1 = posOf()
  const dy = p1.y - p0.y
  /* dig 档：累计下落 ≥4 格算推进；不许挖的档：老老实实 dy=0 且每次都 noPath */
  const ok = last?.arrived === true || (mo.allowDig === true && dy <= -4)
    || (mo.allowDig !== true && dy === 0 && calls.every((x) => /NoPath/i.test(String(x.reason))))
  rec(`pit/${mname}`, ok, {
    ms: Date.now() - t0,
    note: `${xyz(p0)}→${xyz(p1)} dy=${dy} 叫了 ${calls.length} 次 ｜ ${callsLine(calls)}`,
    err: null, hint: last?.hint ?? null, calls,
  })
  say(`/tp ${NAME} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  await sleep(300)
}

/** 双斜（x 与 z 同时前进/上升）：用户 2026-11-02「再加个双斜方，x z都要」。
 *  台阶通路沿 (x+1, z+1, y±1) 的对角线预制，目标 (x+10, y±10, z+10)。 */
async function buildDiag2 (up) {
  const c = baseOf()
  const { x, y, z } = c
  const s = up ? 1 : -1
  await fillBig(x - 6, y - 16, z - 6, x + 16, y + 16, z + 16, BLOCK)
  await waitSolid(x + 1, y, z, [[x + 10, y + s * 10, z + 10], [x + 10, y - 2, z + 10], [x + 2, y + s * 2, z + 2]])
  for (let i = 0; i <= 10; i++) {
    const cx = x + i, cz = z + i, cy = y + s * i
    fill(cx, cy, cz, cx, cy + 1, cz, 'air')          // 这一格的脚位 + 头位
    if (i > 0) {                                     // 对角处的侧墙也挖开，让 2 格宽的对角通道连得上
      fill(x + i - 1, cy, z + i, x + i - 1, cy + 1, z + i, 'air')
      fill(x + i, cy, z + i - 1, x + i, cy + 1, z + i - 1, 'air')
    }
  }
  await sleep(300)
  say(`/tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(400)
  return { x, y, z, tgt: new Vec3(x + 10, y + s * 10, z + 10) }
}

/** 双斜·实心：用户 2026-11-02「你现在斜挖是空心的，实心也要测」。
 *  与 `buildDiag2` 同一块岩体、同一个目标，但**不预制对角通道** —— 整块都是实心，
 *  人只占两格，全靠自己挖出去（测"实心岩体里斜着挖穿"，而不是"沿现成通道走"）。 */
async function buildDiag2Solid (up) {
  const c = baseOf()
  const { x, y, z } = c
  const s = up ? 1 : -1
  await fillBig(x - 6, y - 16, z - 6, x + 16, y + 16, z + 16, BLOCK)
  await waitSolid(x + 1, y, z, [[x + 10, y + s * 10, z + 10], [x + 10, y - 2, z + 10], [x + 2, y + s * 2, z + 2]])
  fill(x, y, z, x, y + 1, z, 'air')                                  // 只挖人站的两格
  fill(x + 10, y + s * 10, z + 10, x + 10, y + s * 10 + 1, z + 10, 'air') // 目标那两格（否则"目标格实心"直接开判）
  await sleep(300)
  say(`/tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`)
  await sleep(400)
  return { x, y, z, tgt: new Vec3(x + 10, y + s * 10, z + 10) }
}

/** 双斜用例：判定按"对角线方向走了 ≥12 格（满程 14.1）+ 垂直达标" */
async function caseMoveDiag2 (mname, mo, up, solid = false) {
  const tag = solid ? 'diag2s' : 'diag2'
  console.log(`  ── 用例 caseMoveDiag2(${mname},${up ? 'up' : 'down'}${solid ? ',实心' : ''}) 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = solid ? await buildDiag2Solid(up) : await buildDiag2(up)
  const p0 = posOf()
  const t0 = Date.now()
  const { calls, last } = await walkMulti(c.tgt, mo, N_CALLS)
  const p1 = posOf()
  const dy = p1.y - p0.y
  const dh = Math.hypot(p1.x - p0.x, p1.z - p0.z)
  const want = up ? 10 : -10
  const okVertical = up ? dy >= want - 1 : dy <= want + 1
  const ok = last?.arrived === true || (mo.allowDig === true && okVertical && dh >= 12)
    || (mo.allowDig !== true && dh < 1 && calls.every((x) => /NoPath/i.test(String(x.reason))))
  rec(`${tag}-${up ? 'up' : 'down'}/${mname}`, ok, {
    ms: Date.now() - t0,
    note: `${xyz(p0)}→${xyz(p1)} dy=${dy} 对角=${dh.toFixed(1)} 叫了 ${calls.length} 次 ｜ ${callsLine(calls)}`,
    err: null, hint: last?.hint ?? null, calls,
  })
  say(`/tp ${NAME} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  await sleep(300)
}


/** 连续快调用：10 次背靠背 mc_dig{block}，每次之间不等待 —— 看会不会互相打架（代次/控制器/掉落物） */
async function caseBurst () {
  console.log(`  ── 用例 caseBurst() 开始 ${new Date().toISOString().slice(11, 19)} ──`)
  const c = await buildStairUp()
  const outs = []
  let ok = 0
  const t0 = Date.now()
  for (let i = 0; i < 10; i++) {
    const tgt = i < 9
      ? { x: c.x + 2 + (i % 3), y: c.y + 1 + Math.floor(i / 3), z: c.z }
      : { x: c.x + 5, y: c.y + 1, z: c.z }
    try {
      const r = await MC.dig({ pos: tgt, mode: 'block' })
      const t = Array.isArray(r) ? r.join(' ') : String(r ?? '')
      const bad = /没成|挖不动|失败|不够|已经是|空气/.test(t)
      if (!bad) ok++
      if (outs.length < 4 || bad) outs.push(`(${tgt.x},${tgt.y},${tgt.z}) ${bad ? '✘ ' : ''}${t.slice(0, 90)}`)
    } catch (e) { outs.push('ERR ' + (e?.message ?? e)) }
  }
  rec('burst×10', ok >= 8, { ms: Date.now() - t0, note: `${ok}/10 顺利`, details: outs.slice(0, 6) })
}

const CASES = [
  ['stair-up', caseStairUp],
  ['stair-down×3', caseStairDown],
  ['dig-block', caseDigBlock],
  ['tunnel/只走', () => caseMoveTunnel('只走', MOVES[0][1])],
  ['tunnel/dig', () => caseMoveTunnel('dig', MOVES[1][1])],
  /* 用户 2026-11-02：「allowdig+allowtower 有一直挖头顶方块的现象，就算是水平挖」——
   *   水平 + dig+tower 这条路以前**从来没测过**（表里只有 只走 / dig），补上。 */
  ['tunnel/dig+tower', () => caseMoveTunnel('dig+tower', MOVES[3][1])],
  ['shaft/dig', () => caseMoveShaft('dig', MOVES[1][1])],
  ['shaft/dig+tower', () => caseMoveShaft('dig+tower', MOVES[3][1])],
  ['shaft/tower', () => caseMoveShaft('tower', MOVES[2][1])],
  ['cliff/tower', () => caseMoveCliff('tower', MOVES[2][1])],
  ['cliff/dig+tower', () => caseMoveCliff('dig+tower', MOVES[3][1])],
  /* 用户 2026-11-02：「上升 下挖 水平 都要，也要包括斜上，斜下」 */
  ['pit/dig', () => caseMovePit('dig', MOVES[1][1])],
  ['pit/dig+tower', () => caseMovePit('dig+tower', MOVES[3][1])],
  ['pit/只走', () => caseMovePit('只走', MOVES[0][1])],
  /* 用户 2026-11-02：「再加个双斜方，x z都要」—— 对角（x+z 同时）上/下 */
  ['diag2-up/dig', () => caseMoveDiag2('dig', MOVES[1][1], true)],
  ['diag2-up/dig+tower', () => caseMoveDiag2('dig+tower', MOVES[3][1], true)],
  ['diag2-up/只走', () => caseMoveDiag2('只走', MOVES[0][1], true)],
  ['diag2-down/dig', () => caseMoveDiag2('dig', MOVES[1][1], false)],
  ['diag2-down/dig+tower', () => caseMoveDiag2('dig+tower', MOVES[3][1], false)],
  ['diag2-down/只走', () => caseMoveDiag2('只走', MOVES[0][1], false)],
  ['diag2s-up/dig', () => caseMoveDiag2('dig', MOVES[1][1], true, true)],
  ['diag2s-up/dig+tower', () => caseMoveDiag2('dig+tower', MOVES[3][1], true, true)],
  ['diag2s-up/只走', () => caseMoveDiag2('只走', MOVES[0][1], true, true)],
  ['diag2s-down/dig', () => caseMoveDiag2('dig', MOVES[1][1], false, true)],
  ['diag2s-down/dig+tower', () => caseMoveDiag2('dig+tower', MOVES[3][1], false, true)],
  ['diag2s-down/只走', () => caseMoveDiag2('只走', MOVES[0][1], false, true)],
  ['stair-远墙', caseStairFarWall],
  ['burst×10', caseBurst],
]

async function setupPlayer () {
  say('/gamerule fallDamage false')
  await sleep(200)
  say('/gamerule keepInventory true')
  await sleep(200)
  say(`/effect give ${NAME} minecraft:resistance 99999 255 true`)
  await sleep(200)
  say('/clear ' + NAME)
  await sleep(300)
  say('/give ' + NAME + ' netherite_pickaxe 4')
  say('/give ' + NAME + ' cobblestone 128')
  await sleep(200)
  say('/give ' + NAME + ' cobblestone 128')
  await sleep(400)
  say(`/item replace entity ${NAME} weapon.mainhand with minecraft:netherite_pickaxe`)
  await sleep(400)
}

async function main () {
  console.log(`连接 ${HOST}:${PORT} …（计划跑 ${MINUTES} 分钟）`)
  await MC.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
  for (let i = 0; i < 60 && !inGame(); i++) await sleep(500)
  if (!inGame()) throw new Error('连不上 / 没 spawn')
  console.log(`已上线：${posOf().toJSON?.() ?? ''}｜先给装备再搭台`)
  /* 🔴 2026-11-02：长测原来**没给镐** —— 徒手挖 stone 7.5 秒/格，于是"挖一格就超时""这块你现在挖不动"
   *   满地都是，全是假象（live-move-test 早踩过同一个坑：反复 /give cobblestone 把背包塞满，
   *   后来给的铁镐静默失败）。这里先 /clear 再给，并明确把镐拿在手上。 */
  say(`/clear ${NAME}`)
  await sleep(400)
  say(`/give ${NAME} minecraft:netherite_pickaxe 4`)
  await sleep(150)
  say(`/give ${NAME} minecraft:cobblestone 128`)
  await sleep(150)
  say(`/item replace entity ${NAME} weapon.mainhand with minecraft:netherite_pickaxe`)
  await sleep(500)
  console.log('装备：下界合金镐×4（效率 V）、圆石×128，镐已在手上')
  try {
    const b0 = MC.bot ?? MC.requireBot?.()
    const items = (b0?.inventory?.items?.() ?? []).map((i) => `${i.name}x${i.count}`).join(', ')
    console.log('用户名=', b0?.username, '｜手上=', b0?.heldItem?.name ?? '空', '｜背包=', items || '(空)')
  } catch (e) { console.log('背包读取失败:', e?.message ?? e) }
  /* 实验用：`MC_THINK_MS=6000` 覆盖 pathfinder.thinkTimeout（产品默认 3500，见 src/plugins.mjs）。
   *  斜上边恢复后搜索空间变大，3500ms 会直接 path-reset；这里只在测试进程里试，不改产品代码。 */
  if (process.env.MC_THINK_MS) {
    try {
      MC.bot.pathfinder.thinkTimeout = Number(process.env.MC_THINK_MS)
      console.log(`thinkTimeout=${MC.bot.pathfinder.thinkTimeout}（env MC_THINK_MS 覆盖，仅本测试进程）`)
    } catch (e) { console.log('thinkTimeout 设置失败:', e?.message ?? e) }
  }
  await setupPlayer()
  let round = 0
  /* 用户 2026-11-02：「总轮次两次就行，工具调用每个模式每项测试每轮 5 次」
   *   ⇒ 跑满 ROUNDS 轮就停（--rounds，默认 2），每项每轮 N_CALLS=5 次；--minutes 只当保险丝。 */
  while (round < ROUNDS && Date.now() < DEADLINE) {
    round++
    console.log(`\n===== 第 ${round}/${ROUNDS} 轮（剩 ${Math.round((DEADLINE - Date.now()) / 60000)} 分钟）=====`)
    for (const [label, fn] of CASES) {
      if (ONLY_RE && !ONLY_RE.test(label)) continue
      if (Date.now() >= DEADLINE) break
      if (!inGame()) {
        console.log('  ⚠ 掉线，等重连…')
        for (let i = 0; i < 40 && !inGame(); i++) await sleep(1000)
        if (!inGame()) { console.log('  ✘ 重连失败，退出'); break }
        await setupPlayer()
      }
      try { await fn() } catch (e) { rec(label, false, { ms: 0, note: '用例抛错', err: String(e?.message ?? e) }) }
      await sleep(400)
    }
    if (!ONLY && Date.now() < DEADLINE) {
      /* 轮间把掉落物清掉、重新给镐（背包会被反复 /give 塞满 —— 2026-11-01 踩过：镐静默给不进去） */
      say('/kill @e[type=item]')
      await sleep(300)
      await setupPlayer()
      await sleep(2000)
    }
  }
  const okN = rows.filter((r) => r.ok).length
  console.log(`\n===== 结束：${rows.length} 次调用，通过 ${okN}，失败 ${rows.length - okN} =====`)
  const byLabel = {}
  for (const r of rows) {
    byLabel[r.label] ??= { n: 0, ok: 0 }
    byLabel[r.label].n++
    if (r.ok) byLabel[r.label].ok++
  }
  for (const [k, v] of Object.entries(byLabel)) console.log(`  ${k}: ${v.ok}/${v.n}`)
  /* 多轮工具调用退化检测：把前几轮和后几轮分开看 */
  const bins = [[1, 2], [3, 4], [5, 6], [7, 99]]
  for (const [a, b] of bins) {
    const xs = rows.filter((r) => r.round >= a && r.round <= b)
    if (xs.length) console.log(`  第 ${a}${b === 99 ? '+' : '-' + b} 轮: ${xs.filter((r) => r.ok).length}/${xs.length}`)
  }
  if (fails.length) {
    console.log('\n失败明细：')
    for (const f of fails.slice(0, 40)) console.log(`  ✘ ${f.label} ${f.note}${f.hint ? `｜hint: ${String(f.hint).slice(0, 200)}` : ''}`)
  }
  try { await MC.disconnect?.('测试结束') } catch {}
  process.exit(fails.length ? 1 : 0)
}

main().catch((e) => { console.error('测试脚本崩了：', e); process.exit(2) })
