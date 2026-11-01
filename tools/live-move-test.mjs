#!/usr/bin/env node
/**
 * 实机回归测试：mc_move 的四种模式（只走 / allowDig / allowTower / allowDig+allowTower）
 *
 * 为什么要它：`tools/check-*.mjs` 全是“读源码比对文本”，一条也不会真的跑 `walkPathfinder`
 * —— 至今已经漏过 6 次「用了没定义的名字」和好几次「判据写反」。这个脚本是真的连服务器跑。
 *
 * 用法（需要一台开着、且你是 OP 的服务器）：
 *   node tools/live-move-test.mjs --host=192.168.1.101 --scene=all
 *   node tools/live-move-test.mjs --scene=cliff --mode=tower --rounds=3
 *
 * 场景：
 *   tunnel  地下实心石头里，目标在水平 6 格外的空腔（必须挖穿 5 格）
 *   shaft   地下 1×1 竖井，目标在正上方 6 格（头顶是实心，要一格格挖上去）
 *   cliff   1×1 石柱顶端，四周全空，目标在正上方 6 格（没有任何东西可挖，只能垫）
 *
 * 期望（不是“必须 arrived”，而是“该成的成、该老实拒绝的拒绝”）：
 *   tunnel  dig / dig+tower  应到达；只走 应如实说挖得动但没挖
 *   shaft   dig              应逐次上升（单次 10 秒不够，靠多轮接续）
 *   cliff   tower / dig+tower 应上升 ≥3 格（纯垫柱，dug 必须是 0）
 */
import { createRequire } from 'node:module'
import { DEFAULTS } from '../src/core.mjs'
import { movements } from '../src/plugins.mjs'
import { walkTo, walkPathfinder } from '../src/movement.mjs'
import { sleep } from '../src/async-util.mjs'

const arg = (k, d = null) => {
  const m = process.argv.find((a) => a.startsWith('--' + k + '='))
  return m ? m.slice(k.length + 3) : d
}
const HOST = arg('host', '192.168.1.101')
const PORT = Number(arg('port', '25565'))
const NAME = arg('user', 'DeepSeekLive')
const SCENE = arg('scene', 'all')          // all | tunnel | shaft | cliff
const MODE = arg('mode', 'all')            // all | walk | dig | tower | both
const ROUNDS = Number(arg('rounds', '3'))
const BUDGET = Number(arg('budget', '9000'))
/* 日志尾巴：默认最后 4 条 / 每条 260 字（够看结论）；查"为什么这么慢"要看全过程时
   传 `--logtail=200 --logchars=300`（2026-11-01 竖井 dig+tower 只升 3 格就是靠这个查的）。 */
const LOG_TAIL = Number(arg('logtail', '4'))
const LOG_CHARS = Number(arg('logchars', '260'))
/* 造场景用什么方块：`--block=deepslate` 复现世界里"深板岩里往上挖"的慢速场景
 * （石头徒手 7.5 秒 / 铁镐 0.4 秒；深板岩更硬，10 秒预算能换几格是要量的数）。 */
const SCENE_BLOCK = arg('block', 'stone')

const req = createRequire('C:/Users/BLUE/.dsh/profiles/desktop/vendor/mc-deps/node_modules/')
const mineflayer = req('mineflayer')
const { pathfinder, Movements, goals } = req('mineflayer-pathfinder')
const Vec3 = req('vec3')

const MODES = [
  ['只走', { allowDig: false, noTower: true }],
  ['dig', { allowDig: true, noTower: true }],
  ['tower', { allowDig: false, noTower: false }],
  ['dig+tower', { allowDig: true, noTower: false }],
]
const wantModes = MODE === 'all' ? MODES : MODES.filter(([n]) => n === MODE || ({ walk: '只走' })[MODE] === n)

let dug = 0
const dugList = []
const logs = []
const summary = []

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, auth: 'offline', version: false })
bot.loadPlugin(pathfinder)

const say = (c) => { try { bot.chat(c) } catch {} }
const fill = (x1, y1, z1, x2, y2, z2, blk) => say(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${blk}`)
const solid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b && b.boundingBox === 'block' }
const standable = (x, y, z) => {
  const a = bot.blockAt(new Vec3(x, y, z)); const h = bot.blockAt(new Vec3(x, y + 1, z))
  return a && h && a.boundingBox !== 'block' && h.boundingBox !== 'block' && solid(x, y - 1, z)
}

bot.on('kicked', (r) => { console.log('KICKED', JSON.stringify(r).slice(0, 200)); process.exit(1) })
bot.on('error', (e) => { console.log('ERROR', e?.message); process.exit(1) })

function mkSelf (budget) {
  const deadline = Date.now() + budget
  const self = {
    bot,
    cfg: { ...DEFAULTS, moveBudgetMs: budget },
    requireBot: () => bot,
    log: (m) => { if (logs.length < 500) logs.push(String(m)) },
    msLeft: () => Math.max(0, deadline - Date.now()),
    callLeft: () => Math.max(0, deadline - Date.now()),
    getBlock: (p) => bot.blockAt(p),
    _moveGen: 0, _moveGenWho: 'test',
    beginMove: (who) => { self._moveGen++; self._moveGenWho = who || 'test'; return self._moveGen },
    bumpGen: (who) => { self._moveGen++; if (who) self._moveGenWho = who },
    _pf: { pathfinder, Movements, goals },
    _waterStall: null, _navRoute: null, pfReady: true, _selfMovingAt: 0, abortSignal: null,
  }
  return self
}
function mkCtx (self) {
  const c = {
    cfg: self.cfg, goals, t: (p) => p, sleep, log: self.log,
    movements: (t, o) => movements(self, o),
    beginMove: self.beginMove, bumpGen: self.bumpGen,
    collectBusy: () => false, releaseControls: () => {},
    stopPathing: () => { try { bot.pathfinder.stop() } catch {} },
  }
  c.walkPathfinder = (target, opts) => walkPathfinder(self, target, opts, c)
  return c
}

async function runOnce (label, tgt, mo) {
  dug = 0; dugList.length = 0; logs.length = 0
  const self = mkSelf(BUDGET); const ctx = mkCtx(self)
  const pA = bot.entity.position.floored()
  const t0 = Date.now()
  let r = null; let err = null
  try {
    r = await walkTo(self, new Vec3(tgt.x, tgt.y, tgt.z),
      { budget: BUDGET, arrive: 1.0, intent: 'stand', xz: false, noBridge: true, ...mo }, ctx)
  } catch (e) { err = e?.message || String(e) }
  const pB = bot.entity.position.floored()
  const rec = {
    label, ms: Date.now() - t0,
    from: [pA.x, pA.y, pA.z], to: [pB.x, pB.y, pB.z],
    dy: pB.y - pA.y, rest: Math.hypot(pB.x - tgt.x, pB.y - tgt.y, pB.z - tgt.z),
    dug,
    /* 挖了哪几格（坐标 + 名字）：`dug=N` 只说明"动了镐"，看不出是谁挖的
       —— 2026-11-01「只走 / 单 tower 也挖了 2 格」就是靠这个定位的。 */
    dugAt: dugList.slice(0, 12), arrived: r?.arrived ?? false, reason: r?.reason ?? (err ? 'ERROR' : '?'),
    err, planTried: r?.planTried ?? [],
    digBy: r?.digLog?.by ?? (() => {
      /* walkTo 抛错（walk-hung / 预算见底）时返回值不存在，`digLog` 拿不到 ——
         但审计器挂在 bot 上，直接问它要，否则"谁挖的"在失败场景永远查不到。 */
      try {
        const ctl = bot.__mcDigAuditCtl
        if (!ctl) return {}
        const s = ctl.summary()
        return s.by ?? {}
      } catch { return {} }
    })(),
    digLast: (() => {
      try { return (bot.__mcDigAuditCtl?.summary?.().rows ?? []).map((x) => `${x.name}@${x.cell}<-${x.by}`) } catch { return [] }
    })(),
    /* 80 字截断会把「🔎 清头顶：…」这类一条打全的诊断削掉后半段（挖了几格 / 为什么没挖成），
       排查时等于白跑一趟 —— 2026-11-01 踩过。放宽到 260 字、只留最后 4 条。 */
    log: logs.slice(-LOG_TAIL).map((s) => s.slice(0, LOG_CHARS)),
  }
  summary.push(rec)
  console.log(`  ${label}  ${rec.ms}ms  ${rec.from.join(',')} -> ${rec.to.join(',')}  dy=${rec.dy}  剩=${rec.rest.toFixed(1)}  dug=${rec.dug}`)
  if (rec.placeFail) console.log('    placeFail=' + JSON.stringify(rec.placeFail))
  if (rec.reason) console.log('    reason=' + String(rec.reason).slice(0, 200))
  if (err) console.log('    ERR=' + err)
  else console.log(`    arrived=${rec.arrived} reason=${rec.reason} planTried=${JSON.stringify(rec.planTried)} digBy=${JSON.stringify(rec.digBy)}`)
  if (rec.dugAt.length) console.log('    dugAt=' + rec.dugAt.join(' | '))
  if (rec.digLast.length) console.log('    digLast=' + rec.digLast.join(' | '))
  if (rec.log.length) console.log('    log: ' + rec.log.join(' | '))
  try { bot.pathfinder.stop() } catch {}
  await sleep(300)
  return rec
}

bot.once('spawn', async () => {
  const orig = bot.dig.bind(bot)
  bot.dig = async (blk, force, face) => {
    dug++
    if (dugList.length < 40) dugList.push(`${blk?.name}@${blk?.position?.x},${blk?.position?.y},${blk?.position?.z}`)
    return orig(blk, force, face)
  }
  await sleep(1500)
  /* 高空建场地必须先把摔伤关掉：`/fill ... air` 会把 bot 脚下的方块一起清掉，
     128 格的落差摔下来直接死，测试结果全废（2026-11-01 实机踩过）。 */
  say('/gamerule fallDamage false')
  await sleep(200)
  say('/gamerule keepInventory true')
  await sleep(200)
  say('/effect give ' + NAME + ' minecraft:resistance 9999 255 true')
  await sleep(300)
  /* 🔴 2026-11-01 实机踩坑：这里原来只 `/give iron_pickaxe 1`，而反复跑测试会一次次
   *   `/give cobblestone 64`，很快把 36 格背包**塞满** —— 镐根本给不进去（give 静默失败），
   *   手上永远是垫柱用的圆石 ⇒ 一挖就判"石头 7.5 秒挖不动" ⇒ 清头顶 dug=0、
   *   整趟 1.3 秒报 noPath。看着像"竖井上不去"，其实是测试环境里根本没有镐。
   *   现在每次开局先 /clear，镐和方块都给足。 */
  say('/clear')
  await sleep(500)
  say('/give ' + NAME + ' iron_pickaxe 4')
  await sleep(400)
  say('/give ' + NAME + ' cobblestone 128')
  await sleep(400)
  say('/give ' + NAME + ' cobblestone 128')
  await sleep(800)
  say(`/item replace entity ${NAME} weapon.mainhand with minecraft:iron_pickaxe`)   // 开局手上先拿镐

  const sp = bot.entity.position.floored()
  const cx = sp.x; const cy = sp.y - 30; const cz = sp.z
  console.log(`场地 (${cx},${cy},${cz})  手上=${bot.heldItem?.name || '(空手)'}`)

  /* 三个场地彼此隔开 40 格、全部建在 y=200 的高空石台上：
     ① 彼此不干扰（同一个中心点测过，上一档挖的洞会让下一档“直接就通”）；
     ② 高空没有地形和水流（低处测过，水会灌进场地把结论全带偏）。 */
  const CENTER = {
    tunnel: { x: sp.x, y: 200, z: sp.z },
    shaft: { x: sp.x + 40, y: 200, z: sp.z },
    cliff: { x: sp.x, y: 200, z: sp.z + 40 },
    plain: { x: sp.x + 40, y: 200, z: sp.z + 40 },
  }

  const build = async (sc) => {
    const c = CENTER[sc]
    const cx = c.x; const cy = c.y; const cz = c.z
    /* 先把 bot 挪到场地外面再清空 —— 否则第一刀 `/fill ... air` 会把它脚下的方块挖掉，
       人在空中开始掉，等 tp 回来时早就不在原地了（实测起点会从 200 掉到 72）。 */
    say(`/tp ${NAME} ${cx + 40.5} ${cy + 40} ${cz + 40.5}`)
    await sleep(400)
    fill(cx - 10, cy - 12, cz - 10, cx + 10, cy + 14, cz + 10, 'air')
    await sleep(600)
    fill(cx - 8, cy - 1, cz - 8, cx + 8, cy - 1, cz + 8, SCENE_BLOCK)   // 脚下的地面
    await sleep(500)
    if (sc === 'tunnel') {
      /* 墙必须**够厚**（只造一层 z 的话 bot 从旁边 z±1 就绕过去了，四档全“到达”、dug=0） */
      fill(cx, cy, cz - 1, cx + 8, cy + 6, cz + 1, SCENE_BLOCK)
      await sleep(500)
      fill(cx, cy, cz, cx, cy + 1, cz, 'air')             // 自己站的两格
      fill(cx + 1, cy, cz, cx + 2, cy + 1, cz, 'air')     // 一点起跑空间
      fill(cx + 6, cy, cz, cx + 6, cy + 1, cz, 'air')     // 墙后空腔 = 目标
    } else if (sc === 'shaft') {
      /* 真正的竖井：外面必须是**实心岩体**，否则 1×1 的柱子四周全空，
       * 人一跳就落到柱子外边去了（实测起点 98,200 → 97,201）。 */
      fill(cx - 4, cy - 1, cz - 4, cx + 4, cy + 10, cz + 4, SCENE_BLOCK)
      await sleep(500)
      fill(cx, cy, cz, cx, cy + 10, cz, SCENE_BLOCK)          // 补一下竖井本体
      await sleep(500)
      fill(cx, cy, cz, cx, cy + 1, cz, 'air')             // 只有脚下两格空，头顶全是石头
      fill(cx, cy + 6, cz, cx, cy + 7, cz, 'air')         // 上方 6 格是空腔 = 目标
    } else {
      /* 不要预放目标脚下那块石头：垫柱是自己往脚下垫、一层层垫上去的，
         预放一块实心反而把“该垫的那格”挡住（实测垫到第 3 格就再也垫不上）。 */
      fill(cx, cy - 1, cz, cx, cy - 8, cz, SCENE_BLOCK)       // 1×1 石柱，四周全空
    }
    await sleep(700)
    say(`/tp ${NAME} ${cx + 0.5} ${cy} ${cz + 0.5}`)
    await sleep(1100)
    say('/give ' + NAME + ' cobblestone 64')
    await sleep(600)
    return { cx, cy, cz }
  }

  const scenes = SCENE === 'all' ? ['tunnel', 'shaft', 'cliff'] : [SCENE]
  for (const sc of scenes) {
    const c0 = await build(sc)

    const tgt = sc === 'tunnel' ? { x: c0.cx + 6, y: c0.cy, z: c0.cz } : { x: c0.cx, y: c0.cy + 6, z: c0.cz }
    console.log(`\n=== ${sc} ===  中心 ${c0.cx},${c0.cy},${c0.cz}  目标 ${JSON.stringify(tgt)} 可站=${standable(tgt.x, tgt.y, tgt.z)}`)

    /* 垫柱边存在的前提：node.remainingBlocks > 0，来自 countScaffoldingItems()，
     * 后者只看 mv.scafoldingBlocks（我们按背包里现有什么方块算的）。这里一次打清楚。 */
    try {
      const inv = bot.inventory.items().map((i) => i.name + 'x' + i.count).join(', ')
      /* 这里原来是 `movements(self, {})` —— self 在 spawn 回调里根本不存在，
       * 每次都被 catch 掉、只打一句「诊断失败: self is not defined」，等于这段诊断从来没生效过。 */
      const mvT = movements(mkSelf(1000), {})
      console.log(' 背包: ' + (inv || '(空)') + '  scafoldingBlocks=' + JSON.stringify(mvT.scafoldingBlocks) + '  count=' + mvT.countScaffoldingItems())
    } catch (e) { console.log(' 诊断失败: ' + e.message) }
    for (const [mName, mo] of wantModes) {
      await build(sc)          // 每一档都从干净场地 + 起点重来
      console.log(`\n--- ${sc} / ${mName} ---`)
      for (let round = 1; round <= ROUNDS; round++) {
        const rec = await runOnce(`${sc}/${mName} #${round}`, tgt, mo)
        if (rec.to[1] >= tgt.y && rec.rest < 2.5) { console.log('    ✔ 到达目标'); break }
      }
    }
  }

  const ok = summary.filter((r) => r.arrived || r.rest < 2.5).length
  console.log(`\n===== 汇总：${summary.length} 次调用，${ok} 次到达目标 =====`)
  for (const r of summary) {
    console.log(` ${r.label.padEnd(28)} ms=${String(r.ms).padStart(5)} dy=${String(r.dy).padStart(3)} dug=${String(r.dug).padStart(2)} arrived=${r.arrived} reason=${r.reason}`)
    if (r.digLog) console.log(`     digLog: ${JSON.stringify(r.digLog.by ?? r.digLog)}`)
    else console.log(`     keys: ${Object.keys(r).join(',')}`)
  }
  process.exit(0)
})

setTimeout(() => { console.log('TIMEOUT（整体 15 分钟）'); process.exit(1) }, 15 * 60 * 1000)
