// -*- coding: utf-8 -*-
/**
 * dsh-mc-agent / check-connection-stale.mjs
 * 连接假死（包静默）检测的离线套件。
 *
 * 2026-10-23 实机（用户："也是完全卡住，我tp也不行，最后重开才好" / "是它重进游戏"）：
 * socket 看着还在，服务端其实不回包了 —— 我们的 `b.dig()` 永远等不到 `blockUpdate`，
 * 位置不再更新，连 tp 都发不出去。以前的代码没有任何"多久没收到包"的概念，
 * 所以只能陪着一起卡到预算上限、然后一遍遍重试。
 *
 * 这套件钉住四件事：
 *   ① 静默多久算假死（阈值 + 边算边判）；
 *   ② 假死时 `walkTo` **立刻**认输（不走进 pathfinder、不等到 11 秒）；
 *   ③ 看门狗到点**主动断开**让自动重连接手（假死没有 `end` 事件，autoReconnect 永不触发）；
 *   ④ 下线/断线时定时器一定被清掉（不留后台在跑）。
 */
import { readFileSync } from 'node:fs'
import {
  PACKET_STALE_MS, SILENCE_CHECK_MS,
  packetSilenceMs, connectionStale, startSilenceWatch, clearSilenceWatch,
} from '../src/connection.mjs'
import { walkTo } from '../src/movement.mjs'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
let pass = 0, fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')) }
}
const section = (t) => console.log('\n── ' + t + ' ──')
const src = readFileSync(new URL('../src/connection.mjs', import.meta.url), 'utf8')
const mvSrc = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ═══════════════ ① 静默时长怎么算 ═══════════════ */
section('① packetSilenceMs / connectionStale')
{
  ok(PACKET_STALE_MS === 40_000, '阈值 40 秒（服务端每秒都在发包，40 秒全静默必然是死了）', String(PACKET_STALE_MS))
  ok(SILENCE_CHECK_MS > 0 && SILENCE_CHECK_MS <= PACKET_STALE_MS,
    '检查间隔比阈值短（不然发现得比阈值晚太多）', String(SILENCE_CHECK_MS))
  ok(packetSilenceMs({}) === null, '没开始记（旧连接/假 bot）⇒ null，不瞎判')
  ok(packetSilenceMs({ _lastPacketAt: 0 }) === null, '_lastPacketAt = 0 也当"无从判断"')
  const fresh = packetSilenceMs({ _lastPacketAt: Date.now() })
  ok(fresh != null && fresh < 1000, '刚收到包 ⇒ 静默时间 ≈ 0', String(fresh))
  ok(connectionStale({ _lastPacketAt: Date.now() }) === null, '刚收到包 ⇒ 不算假死')
  ok(connectionStale({}) === null, '无从判断 ⇒ 不报假死（宁可不动，不误杀）')
  const bad = connectionStale({ _lastPacketAt: Date.now() - 41_000 })
  ok(bad && bad.reason === 'connection-stale', '静默 41 秒 ⇒ 判假死', JSON.stringify(bad))
  ok(bad && bad.silenceSec >= 40 && bad.silenceSec <= 42, '报出静默了多少秒', JSON.stringify(bad?.silenceSec))
  ok(bad && /mc_connect \{force:true\}/.test(bad.hint), '提示里给出"怎么救"（重连），不是只报错')
  ok(bad && /假死/.test(bad.hint) && /别再原样重试/.test(bad.hint), '说清"不是路难走"且别原样重试')
  ok(connectionStale({ _lastPacketAt: Date.now() - 5_000 }, { staleMs: 1_000 })?.reason === 'connection-stale',
    '阈值可注入（测试/调参用）')
}

/* ═══════════════ ② 假死时 walkTo 立刻认输 ═══════════════ */
section('② walkTo 假死 ⇒ 立刻返回（不进 pathfinder、不等预算）')
{
  let pfCalled = false
  const bot = {
    _lastPacketAt: Date.now() - 41_000,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    pathfinder: { goto () { pfCalled = true; return Promise.resolve() } },
  }
  const self = { requireBot: () => bot, cfg: {}, msLeft: () => 10_000, log: () => {} }
  const t0 = Date.now()
  const r = await walkTo(self, { x: 100, y: 64, z: 0 }, { budget: 10_000 }, {})
  const ms = Date.now() - t0
  ok(r.arrived === false && r.stuck === true, '假死 ⇒ 不报到达', JSON.stringify(r).slice(0, 120))
  ok(r.reason === 'connection-stale', '🔴 reason 明确是连接假死（不是 stuck/NoPath）', String(r.reason))
  ok(Number(r.silenceSec) >= 40, '报出静默了多少秒', String(r.silenceSec))
  ok(/mc_connect/.test(String(r.hint)), 'hint 给出"重连再试"')
  ok(pfCalled === false, '🔴 根本没去调 pathfinder（不陪着一起卡）')
  ok(ms < 500, '立刻返回（不是等到 10 秒预算用完）', ms + 'ms')
  ok(r.remaining > 0 && Number.isFinite(r.remaining), '报出还剩多远（模型据此判断要不要重连后接着走）', String(r.remaining))
  ok(r.position && r.position.z === 0, '报出当前坐标', JSON.stringify(r.position))
}
{
  /* 连接正常时这条捷径不能误伤：同样会走到 pathfinder */
  let pfCalled = false, err = null
  const bot = {
    _lastPacketAt: Date.now(),
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    heldItem: null,
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air' }),
    setControlState: () => {},
    clearControlStates: () => {},
    on: () => {},
    removeListener: () => {},
    stopDigging: () => {},
    pathfinder: {
      isMining: () => false,
      isBuilding: () => false,
      setMovements: () => {},
      setGoal: () => {},
      goto () { pfCalled = true; return Promise.reject(new Error('NoPath')) },
    },
  }
  const self = { requireBot: () => bot, cfg: { moveBudgetMs: 200 }, msLeft: () => 200, log: () => {}, _moveGen: 0, pfReady: true }
  const ctx = {
    walkGuardMs: 60,
    beginMove: () => {}, stopPathing: () => {}, releaseControls: () => {},
    collectBusy: () => false, cancelCollect: () => {},
    walkPathfinder: () => { pfCalled = true; return Promise.reject(new Error('NoPath')) },
  }
  await walkTo(self, { x: 2, y: 64, z: 0 }, { budget: 200 }, ctx).catch((e) => { err = e })
  ok(pfCalled === true, '连接正常 ⇒ 照常走进 pathfinder（捷径不误伤）', err && err.message)
}

/* ═══════════════ ③ 看门狗：到点主动断开 ═══════════════ */
section('③ startSilenceWatch：静默到点主动断开重连')
{
  const logs = [], emitted = []
  let ended = false
  const bot = {
    _lastPacketAt: Date.now() - 41_000,
    end () { ended = true },
    quit () { ended = true },
  }
  const self = {
    bot, stopped: false,
    log: (m) => logs.push(String(m)),
    emit: (k, v) => emitted.push([k, v]),
  }
  startSilenceWatch(self, bot, { everyMs: 20 })
  ok(Boolean(self._silenceTimer), '挂上了定时器')
  await sleep(90)
  ok(ended === true, '🔴 假死 ⇒ 主动 end()（让既有 autoReconnect 接手；假死没有 end 事件）')
  ok(self._silenceTimer === null, '触发后自己把定时器清掉（不重复触发）')
  ok(logs.some((l) => /连接假死/.test(l) && /主动断开/.test(l)), '日志说清"是假死，不是走不动"', JSON.stringify(logs))
  ok(emitted.some(([k]) => k === 'silence'), '给上层发 silence 事件')
  const n = emitted.length
  await sleep(60)
  ok(emitted.length === n, '不会再触发第二次（定时器已清）')
}
{
  /* 包一直在进来 ⇒ 永不触发 */
  let ended = false
  const bot = { _lastPacketAt: Date.now(), end () { ended = true } }
  const self = { bot, stopped: false, log: () => {}, emit: () => {} }
  startSilenceWatch(self, bot, { everyMs: 10 })
  const tick = setInterval(() => { bot._lastPacketAt = Date.now() }, 5)
  await sleep(80)
  clearInterval(tick)
  clearSilenceWatch(self)
  ok(ended === false, '包一直在进 ⇒ 不误杀（正常挂机不会被踢）')
}
{
  /* 已经下线/换连接 ⇒ 不触发、自己退出 */
  let ended = false
  const bot = { _lastPacketAt: Date.now() - 41_000, end () { ended = true } }
  const self = { bot: { other: true }, stopped: false, log: () => {}, emit: () => {} }
  startSilenceWatch(self, bot, { everyMs: 10 })
  await sleep(60)
  ok(ended === false && self._silenceTimer === null, '不是当前连接 ⇒ 不碰它，定时器自清')
  let ended2 = false
  const bot2 = { _lastPacketAt: Date.now() - 41_000, end () { ended2 = true } }
  const self2 = { bot: bot2, stopped: true, log: () => {}, emit: () => {} }
  startSilenceWatch(self2, bot2, { everyMs: 10 })
  await sleep(60)
  ok(ended2 === false && self2._silenceTimer === null, '已主动下线（stopped）⇒ 不触发')
}

/* ═══════════════ ④ 接线与收尾 ═══════════════ */
section('④ 接线：记包 / 清定时器')
{
  ok(/b\._lastPacketAt = Date\.now\(\)/.test(src), '连上后开始记"最后一个包的时间"')
  ok(/b\._client\?\.on\?\.\('packet'/.test(src), '🔴 真的挂在底层客户端的 packet 事件上')
  ok(/startSilenceWatch\(self, b\)/.test(src), '连上后启动看门狗')
  const clears = (src.match(/clearSilenceWatch\(self\)/g) || []).length
  ok(clears >= 3, '断线 / 下线 / 触发后都清定时器（≥3 处）', 'count=' + clears)
  ok(/import \{ connectionStale \} from '\.\/connection\.mjs'/.test(mvSrc), 'movement 拿到了 connectionStale')
  ok(/const stale = connectionStale\(b\)/.test(mvSrc), '🔴 walkTo 开头就查假死')
  ok(/reason: 'connection-stale'/.test(mvSrc) || /\.\.\.stale/.test(mvSrc), '结果里带上假死原因')
  /* 定时器 unref：插件退出时不因为一个看门狗把进程吊住 */
  ok(/unref\?\.\(\)/.test(src), '定时器 unref（不让它吊住宿主进程）')
}

/* 🔴 2026-11-05 issue #6 ②：上次**死在游戏里**直接断线 ⇒ playerdata 里 Health:0 ⇒ 服务端停在死亡界面、
 *    **不发 spawn 包** ⇒ 我们干等到 connectTimeoutMs（45s）才报"超时"，换名字秒进、用回原名必卡。
 *    修法是等 spawn 等太久就主动补发一次重生。 */
{
  const src = readFileSync(new URL('../src/connection.mjs', import.meta.url), 'utf8')
  ok(/const respawnMs = Math\.max\(3_000, Math\.min\(8_000/.test(src), '兜底重生提前到 3~8 秒触发（一定早于 connectTimeoutMs 的超时）')
  ok(/b\.respawn\?\.\(\)/.test(src), '等不到 spawn 就主动补发一次重生请求（死着下线的存档能立刻进世界）')
  ok(/if \(settled \|\| respawned \|\| self\.bot !== b\) return/.test(src), '兜底只发一次，且只在这条连接还活着时发（别去捅新连接）')
  ok(/clearTimeout\(tRespawn\)/.test(src), 'spawn 一到就清掉兜底定时器（正常连接不会被补发重生）')
}
console.log(`\ncheck-connection-stale：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
