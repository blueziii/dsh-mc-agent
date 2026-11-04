// -*- coding: utf-8 -*-
/** 临时诊断：水平挖隧道时"一卡一卡"的时间都花在哪（20ms 采样，直接看 bot 状态）。
 *  用完即删。用法：node tmp-diag-tunnel.mjs [--allowTower=1] [--calls=1] */
import { createRequire } from 'node:module'
import { McBot, DEFAULTS } from '../src/core.mjs'
import { sleep } from '../src/async-util.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const NAME = arg('user', `DeepSeekDiag${Math.floor(Math.random() * 900 + 100)}`)
const ALLOW_TOWER = arg('allowTower', '0') === '1'
const NODROP = arg('nodrop', '0') === '1'
const CALLS = Number(arg('calls', '1'))
const BLOCK = 'stone'

const req = createRequire('C:/Users/BLUE/.dsh/profiles/desktop/vendor/mc-deps/node_modules/')
const Vec3 = req('vec3')

const THINK = Number(arg('think', '0'))
const RADIUS = Number(arg('radius', '0'))
const CFG = { ...DEFAULTS }
if (THINK > 0) CFG.pfThinkTimeoutMs = THINK
if (RADIUS > 0) CFG.pfSearchRadius = RADIUS
const TICK = Number(arg('tick', '0'))
if (TICK > 0) CFG.pfTickTimeoutMs = TICK
const MC = new McBot({ ...CFG, instanceId: 'diag', logFile: 'tmp-diag.log' })
const say = (c) => { try { MC.bot?.chat(c) } catch {} }
const fill = (x1, y1, z1, x2, y2, z2, blk) => say(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${blk}`)
const posOf = () => MC.bot.entity.position.floored()
const xyz = (p) => `${p.x},${p.y},${p.z}`
const blkName = (x, y, z) => { try { return MC.bot.blockAt(new Vec3(x, y, z))?.name ?? 'null' } catch { return 'null' } }

async function waitSolid (x, y, z) {
  for (let i = 0; i < 16; i++) {
    const n = blkName(x, y, z)
    if (n && n !== 'air' && n !== 'cave_air' && n !== 'unknown') return true
    await sleep(250)
  }
  return false
}
async function fillBig (x0, y0, z0, x1, y1, z1, block) {
  for (let x = x0; x <= x1; x += 12) { fill(x, y0, z0, Math.min(x1, x + 11), y1, z1, block); await sleep(150) }
}

/* ── 采样器：20ms 一次，把每一 tick 归到 dig / move / idle 三类 ── */
const S = { t0: 0, lastPos: null, lastDigKey: null, lastMoveAt: 0, events: [], acc: { dig: 0, move: 0, idle: 0 }, byPhase: {}, idles: [], idleFrom: null }
let __lastTick = 0
let __gaps = []
function sample () {
  const b = MC.bot
  if (!b?.entity) return
  const p = b.entity.position
  const tb = b.targetDigBlock
  const digKey = tb ? `${tb.name}@${tb.position.x},${tb.position.y},${tb.position.z}` : '-'
  const ph = String(b.__mcPhase || '?')
  const __nowPerf = performance.now()
  const t = Math.round(__nowPerf - S.t0)
  if (__lastTick) { const dt = __nowPerf - __lastTick; if (dt > 45) __gaps.push({ at: t, dt: Math.round(dt), ph: String(b.__mcPhase || '?') }) }
  __lastTick = __nowPerf
  const moved = !S.lastPos || Math.hypot(p.x - S.lastPos.x, p.y - S.lastPos.y, p.z - S.lastPos.z) >= 0.05
  if (moved) { S.lastPos = { x: p.x, y: p.y, z: p.z }; S.lastMoveAt = t }
  const cls = tb ? 'dig' : (t - S.lastMoveAt <= 150 ? 'move' : 'idle')
  if (S.lastX != null) { const dx = p.x - S.lastX; if (dx <= -0.15) S.events.push({ t, ev: `后退 ${dx.toFixed(2)}`, ph, pos: `${p.x.toFixed(2)},${p.z.toFixed(2)}` }) }
  S.lastX = p.x
  S.acc[cls] += 20
  S.byPhase[ph] = S.byPhase[ph] || { dig: 0, move: 0, idle: 0 }
  S.byPhase[ph][cls] += 20
  if (digKey !== S.lastDigKey) {
    S.events.push({ t, ev: digKey === '-' ? '挖完' : '开挖', blk: digKey, ph, pos: `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` })
    S.lastDigKey = digKey
  }
  if (cls === 'idle' && S.idleFrom == null) { S.idleFrom = t; S.idles.push({ from: t, to: t, ph, busy: (() => { try { const pf = b.pathfinder; if (pf?.isBuilding?.() === true) return 'place'; if (pf?.isMining?.() === true) return 'dig'; return 'none' } catch { return '?' } })() }) }
  else if (cls === 'idle' && S.idleFrom != null) { const last = S.idles[S.idles.length - 1]; if (last) last.to = t }
  else if (cls !== 'idle') S.idleFrom = null
}

async function main () {
  await MC.connect({ host: '192.168.1.101', port: 25565, auth: { mode: 'offline', name: NAME } })
  for (let i = 0; i < 40 && !MC.bot?.entity; i++) await sleep(500)
  if (!MC.bot?.entity) throw new Error('连不上服务器')
  await sleep(1500)
  say('/gamerule sendCommandFeedback false')
  if (NODROP) { say('/gamerule doTileDrops false'); say('/kill @e[type=item]'); console.log('（NODROP：不掉落 + 清掉落物）') }
  say('/gamerule fallDamage false')
  say('/clear')
  say('/give ' + NAME + ' netherite_pickaxe')
  say('/give ' + NAME + ' cobblestone 128')
  await sleep(800)

  const p = posOf()
  /* 固定场地：每次跑到同一片实心岩，A/B 才可比 */
  const FIXED = arg('fixed', '1') === '1'
  const c = FIXED ? { x: 3000, y: 120, z: 3000 } : { x: p.x + 300, y: p.y, z: p.z }
  await fillBig(c.x - 8, c.y - 32, c.z - 8, c.x + 44, c.y + 26, c.z + 8, BLOCK)
  await waitSolid(c.x + 1, c.y, c.z)
  fill(c.x, c.y, c.z, c.x, c.y + 1, c.z, 'air')
  await sleep(300)
  /* 走廊：两侧 + 背后 + 尽头 + 顶盖 */
  fill(c.x - 1, c.y, c.z - 1, c.x - 1, c.y + 6, c.z + 1, BLOCK)
  fill(c.x, c.y, c.z - 1, c.x + 23, c.y + 6, c.z - 1, BLOCK)
  fill(c.x, c.y, c.z + 1, c.x + 23, c.y + 6, c.z + 1, BLOCK)
  fill(c.x + 23, c.y, c.z - 1, c.x + 23, c.y + 6, c.z + 1, BLOCK)
  fill(c.x, c.y + 4, c.z - 1, c.x + 23, c.y + 6, c.z + 1, BLOCK)
  say(`/tp ${NAME} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  await sleep(800)

  const tgt = new Vec3(c.x + 20, c.y, c.z)
  console.log(`参数 tick=${TICK || '默认40'} nodrop=${NODROP ? 1 : 0} think=${THINK || '默认3500'} radius=${RADIUS || '默认192'}`)
  console.log(`起点 ${xyz(posOf())} 目标 ${xyz(tgt)} allowDig=1 allowTower=${ALLOW_TOWER ? 1 : 0}`)

  S.t0 = performance.now()
  const timer = setInterval(sample, 20)
  for (let i = 0; i < CALLS; i++) {
    const t1 = Date.now()
    try {
      await MC.walkTo(tgt, { budget: 10_500, arrive: 1.0, intent: 'stand', allowDig: true, noTower: !ALLOW_TOWER })
    } catch (e) { console.log(`  第 ${i + 1} 趟抛错：${e?.message ?? e}`) }
    console.log(`  第 ${i + 1} 趟 ${Date.now() - t1}ms → ${xyz(posOf())}`)
  }
  clearInterval(timer)

  const tot = S.acc.dig + S.acc.move + S.acc.idle
  console.log(`── 总计 ${tot}ms：挖(有 targetDigBlock)=${S.acc.dig}ms 走/动=${S.acc.move}ms 干站着=${S.acc.idle}ms`)
  console.log('── 分阶段 ──', JSON.stringify(S.byPhase))
  const lost = __gaps.reduce((a, g) => a + (g.dt - 20), 0)
  console.log(`── 采样卡顿(主线程被占)：${__gaps.length} 次 >45ms，合计 ${lost}ms ──`)
  for (const g of __gaps.sort((a, b) => b.dt - a.dt).slice(0, 12)) console.log(`   ${g.at}ms 一次停了 ${g.dt}ms 阶段=${g.ph}`)
  const big = S.idles.filter((x) => x.to - x.from >= 200).sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 15)
  console.log('── 最长"干站着"片段 ──')
  for (const x of big) console.log(`   ${x.from}→${x.to}ms  ${x.to - x.from}ms  阶段=${x.ph} busy=${x.busy}`)
  try { console.log(`── 结束时实体数：${Object.keys(MC.bot.entities ?? {}).length}（掉落物 ${Object.values(MC.bot.entities ?? {}).filter((e) => e?.name === 'item').length}）`) } catch {}
  console.log('── 事件时间线 ──')
  for (const e of S.events) {
    const extra = e.blk ? ` ${e.blk} 阶段=${e.ph} 手=${e.held}` : (e.ph ? ` 阶段=${e.ph}` : '')
    console.log(`  ${String(e.t).padStart(6)}ms  ${e.ev}${extra}${e.pos ? ` 位=${e.pos}` : ''}`)
  }
  try { await MC.disconnect?.('诊断结束') } catch {}
  await sleep(300)
  process.exit(0)
}
main().catch((e) => { console.error('DIAG FAIL', e); process.exit(1) })

