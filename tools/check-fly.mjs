#!/usr/bin/env node
/**
 * check-fly.mjs —— 创造模式飞行（`mc_move {mode:"fly"}`）的回归检查
 *
 * 用户原话（2026-10-19）：「创造模式fly现在用不了」
 *
 * 两个真根因（都在 `src/movement.mjs` 的 `flyTo` 里修掉）：
 *   A. **没告诉服务端"我在飞"**。`bot.creative.startFlying()`（含上游 `creative.flyTo`）只把本地
 *      `physics.gravity` 置 0，一个包都不发；服务端判位移合法看的是 **abilities 里 flying 那一位**。
 *      ⇒ 现在起飞前/收尾都发 `b._client.write('abilities', { flags })`。
 *   B. **速度超上限**。旧实现每 60ms 硬写 `b.entity.position` 挪 2 格 = 约 33 m/s
 *      （原版创造飞行约 10.9 m/s）⇒ 服务端一定打回。现在按 tick 给速度：
 *      每 `FLY_TICK_MS=50` 把 `b.entity.velocity` 设成 `FLY_SPEED_PER_TICK=0.45` 格/tick（约 9 m/s），
 *      由物理循环积分成位移。
 *
 * 这个脚本钉死六件事：
 *   ① 非创造模式明确拒绝（不再"飞了一半才报没到"）；
 *   ② 起飞前发 abilities(flying)，收尾发 abilities(不 flying)；
 *   ③ 位移是"每 tick 一小步"，**没有**任何一次跳动超过 FLY_SPEED_PER_TICK（防止又改回硬写坐标）；
 *   ④ 到位就返回 `arrived:true`，并且**重力一定被恢复**（否则之后走路全废）；
 *   ⑤ 撞墙飞不动时**早停**（2.5s 内返回，不耗满预算），文案说清是撞地形/权限；
 *   ⑥ 源码级断言：`flyTo` 里不许再出现 `b.entity.position =`，必须有 abilities 包与限速常量。
 *
 * 用法：node tools/check-fly.mjs
 */
import { readFileSync } from 'node:fs'
import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const {
  flyTo, setFlyingAbilities, endHoverFlight, solidUnder,
  FLY_TICK_MS, FLY_SPEED_PER_TICK, ABILITY_FLYING, ABILITY_ALLOW_FLYING, ABILITY_CREATIVE
} = await import(new URL('../src/movement.mjs', import.meta.url))

/**
 * 假 bot：`entity.velocity` 是 setter —— 一赋速度就"走一个 tick"（把速度加到位置上），
 * 这正是 mineflayer 物理循环做的事（`entity.position += velocity`）。
 * `blocked:true` 模拟"撞墙/服务端不接受"：速度记下来但位置不动。
 */
function makeBot ({ x = 0, y = 64, z = 0, creative = true, blocked = false, airBelow = false } = {}) {
  const sent = []
  const calls = []
  const steps = []
  const bot = {
    game: { gameMode: creative ? 'creative' : 'survival' },
    physics: { gravity: 0.08 },
    _client: { write: (name, data) => sent.push({ name, data }) },
    // `solidUnder()` 只问脚下方块：airBelow=true ⇒ 飞在半空，false ⇒ 脚下有地
    blockAt: () => (airBelow ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' }),
    creative: {
      startFlying () { calls.push('startFlying'); bot.physics.gravity = 0 },
      stopFlying () { calls.push('stopFlying'); bot.physics.gravity = 0.08 }
    }
  }
  bot.entity = { position: new Vec3(x, y, z) }
  let vel = new Vec3(0, 0, 0)
  Object.defineProperty(bot.entity, 'velocity', {
    get: () => vel,
    set: (v) => {
      vel = v
      steps.push(Math.hypot(v.x, v.y, v.z))
      if (!blocked) bot.entity.position = bot.entity.position.plus(v)
    }
  })
  return { bot, sent, calls, steps }
}

function makeSelf (bot) {
  const self = {
    requireBot: () => bot,
    msLeft: () => 9000,
    abortSignal: new AbortController().signal,
    _moveGen: 0,
    _selfMovingAt: 0
  }
  const ctx = { beginMove: () => { self._moveGen += 1; return self._moveGen } }
  return { self, ctx }
}

/* ───────── ① 非创造模式明确拒绝 ───────── */
section('① 非创造模式')
{
  const { bot } = makeBot({ creative: false })
  const { self, ctx } = makeSelf(bot)
  let err = ''
  try { await flyTo(self, 0, 80, 0, {}, ctx) } catch (e) { err = e.message }
  ok(/创造模式/.test(err), 'survival 下直接报"飞行只在创造模式可用"', err)
}

/* ───────── ② abilities 包 ───────── */
section('② abilities 包（服务端认不认飞行就靠它）')
{
  const { bot, sent } = makeBot({ y: 64 })
  const { self, ctx } = makeSelf(bot)
  const r = await flyTo(self, 0, 74, 0, {}, ctx)
  const abil = sent.filter((s) => s.name === 'abilities')
  ok(abil.length >= 2, '至少发了两次 abilities（起飞 + 落地）', `发了 ${abil.length} 次`)
  const first = abil[0]?.data?.flags ?? 0
  const last = abil[abil.length - 1]?.data?.flags ?? 0
  ok((first & ABILITY_FLYING) === ABILITY_FLYING, '起飞那次 flags 里带 flying 位', '0x' + first.toString(16))
  ok((first & ABILITY_ALLOW_FLYING) === ABILITY_ALLOW_FLYING && (first & ABILITY_CREATIVE) === ABILITY_CREATIVE, '同时带 allowFlying + creative', '0x' + first.toString(16))
  ok((last & ABILITY_FLYING) === 0, '收尾那次 flags 里不带 flying 位', '0x' + last.toString(16))
  ok(r.arrived === true, '飞到目标（arrived:true）', `distance=${r.distance}`)
}

/* ───────── ③ 每 tick 一小步，不许再硬写坐标 ───────── */
section('③ 位移是"每 tick 一小步"')
{
  const { bot, steps } = makeBot({ y: 64 })
  const { self, ctx } = makeSelf(bot)
  await flyTo(self, 0, 74, 0, {}, ctx)
  const maxStep = Math.max(0, ...steps)
  ok(maxStep <= FLY_SPEED_PER_TICK + 1e-9, '单 tick 位移不超过 FLY_SPEED_PER_TICK', `最大 ${maxStep.toFixed(3)} 格（上限 ${FLY_SPEED_PER_TICK}）`)
  ok(FLY_SPEED_PER_TICK <= 0.55, '限速低于原版创造飞行上限（约 0.545 格/tick）', `${FLY_SPEED_PER_TICK} 格/tick ≈ ${(FLY_SPEED_PER_TICK * 20).toFixed(1)} m/s`)
  ok(FLY_TICK_MS === 50, '按 1 tick = 50ms 推进', `${FLY_TICK_MS}ms`)
  ok(steps.length >= 5, '确实飞了好几 tick，不是一步瞬移', `${steps.length} 步`)
}

/* ───────── ④ 重力一定恢复 ───────── */
section('④ 收尾')
{
  const { bot, calls } = makeBot({ y: 64 })
  const { self, ctx } = makeSelf(bot)
  await flyTo(self, 0, 74, 0, {}, ctx)
  ok(bot.physics.gravity === 0.08, '重力被恢复成原值（否则之后走路全废）', String(bot.physics.gravity))
  ok(calls.includes('stopFlying'), '调了 stopFlying')
  ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z) === 0, '速度归零（不会自己飘走）')
}

/* ───────── ⑤ 撞墙早停，不耗满预算 ───────── */
section('⑤ 飞不动（撞地形 / 服务端不认）')
{
  const { bot } = makeBot({ y: 64, blocked: true })
  const { self, ctx } = makeSelf(bot)
  const t0 = Date.now()
  const r = await flyTo(self, 0, 94, 0, {}, ctx)
  const ms = Date.now() - t0
  ok(r.arrived === false, '如实报没到')
  ok(ms < 4000, '2.5 秒判"推不动"就早停，不耗满 10 秒预算', `${ms}ms`)
  ok(/撞到地形|飞行权限/.test(String(r.note ?? '')), '文案说清是撞地形还是权限问题', String(r.note ?? '').slice(0, 60))
  ok(bot.physics.gravity === 0.08, '早停也要恢复重力')
}

/* ───────── ⑥ 源码级断言 ───────── */
section('⑥ 源码（防止只改一处 / 被改回去）')
{
  const m = src('../src/movement.mjs')
  ok(/export function setFlyingAbilities/.test(m), 'movement.mjs 导出 setFlyingAbilities')
  ok(/w\.call\(b\._client, 'abilities', \{ flags \}\)/.test(m), '真的发 abilities 包')
  ok(/export const FLY_SPEED_PER_TICK/.test(m) && /export const FLY_TICK_MS/.test(m), '限速/节拍是导出常量')
  const flyBody = m.slice(m.indexOf('export async function flyTo'), m.indexOf('export async function flyTo') + 4000)
  ok(!/b\.entity\.position\s*=/.test(flyBody), 'flyTo 里不再硬写 b.entity.position（那是 33 m/s 的根源）')
  ok(/b\.entity\.velocity = new Vec3/.test(flyBody), '改成按 tick 给 velocity')
  ok(/setFlyingAbilities\(b, true\)/.test(flyBody) && /setFlyingAbilities\(b, false\)/.test(flyBody), '起飞/落地都发能力包')
  ok(/export function endHoverFlight/.test(m), 'movement.mjs 导出 endHoverFlight（收悬停的唯一入口）')
  for (const fn of ['export async function jump', 'async function walkToOnce', 'export async function walkPathfinder', 'export async function walkSwim']) {
    const at = m.indexOf(fn)
    const body = m.slice(at, at + 600)
    ok(/endHoverFlight\(b\)/.test(body), `${fn.split(' ').at(-1)} 开跑前会先 endHoverFlight（否则零重力把走路拖死）`)
  }
  const noClient = { game: { gameMode: 'creative' } }
  ok(setFlyingAbilities(noClient, true) === false, '没有 _client 时静默返回 false（不炸）')
}

/* ───────── ⑦ 飞到空中悬停 / 地面移动自动落地 ───────── */
section('⑦ 悬停（用户选「要悬停，走路时自动落地」）')
{
  const { bot, sent } = makeBot({ y: 64, airBelow: true })
  const { self, ctx } = makeSelf(bot)
  const r = await flyTo(self, 0, 74, 0, {}, ctx)
  ok(r.hovering === true, '落在空中 ⇒ 结果带 hovering:true', String(r.hovering))
  ok(bot.physics.gravity === 0, '悬停时重力保持 0（不然会掉下去）', String(bot.physics.gravity))
  ok(bot._hoverFlying === true, '打了 _hoverFlying 标记')
  const last = sent.filter((s) => s.name === 'abilities').at(-1)?.data?.flags ?? 0
  ok((last & ABILITY_FLYING) === ABILITY_FLYING, '收尾那次 abilities **保留** flying 位（服务端才不会把我拽下来）', '0x' + last.toString(16))

  const released = endHoverFlight(bot)
  ok(released === true, 'endHoverFlight 报告确实收了飞行')
  ok(bot.physics.gravity === 0.08, '收完重力恢复', String(bot.physics.gravity))
  ok(bot._hoverFlying === false, '标记被清掉（可以重复调不炸）')
  const after = sent.filter((s) => s.name === 'abilities').at(-1)?.data?.flags ?? 0
  ok((after & ABILITY_FLYING) === 0, '收完补发 abilities(不 flying)', '0x' + after.toString(16))
  ok(endHoverFlight(bot) === false, '没在悬停时 endHoverFlight 是空操作')
}
{
  const { bot } = makeBot({ y: 64, airBelow: false })
  const { self, ctx } = makeSelf(bot)
  const r = await flyTo(self, 0, 74, 0, {}, ctx)
  ok(r.hovering === undefined, '脚下有地 ⇒ 不悬停（照常落地）')
  ok(bot.physics.gravity === 0.08 && bot._hoverFlying === false, '落地就把重力还回来')
}
{
  ok(solidUnder({ blockAt: () => ({ name: 'stone' }) }, new Vec3(0, 64, 0)) === true, 'solidUnder：脚下石头 ⇒ true')
  ok(solidUnder({ blockAt: () => ({ name: 'air' }) }, new Vec3(0, 64, 0)) === false, 'solidUnder：空气 ⇒ false')
  ok(solidUnder({ blockAt: () => null }, new Vec3(0, 64, 0)) === false, 'solidUnder：读不到（没加载）⇒ false，宁可悬着别掉')
}/* 🔴 2026-11-05 issue #6 ⑥："创造模式 fly 也是 0 格"。客户端改 velocity 是本地位移，服务端不认就发
 *    position 包把我们拽回去（mineflayer 抛 forcedMove）；以前只报"飞不动了"，分不清是撞地形还是没权限。 */
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/let forcedMoves = 0/.test(src) && /b\.on\?\.\('forcedMove', onForced\)/.test(src), '飞的时候数服务端把我们拽回去几次（forcedMove）')
  ok(/try \{ b\.removeListener\?\.\('forcedMove', onForced\) \} catch/.test(src), '收尾一定摘掉监听（别在断了的连接上留钩子）')
  ok(/serverMoved: forcedMoves/.test(src) && /stallWhy/.test(src), '结果里给出 serverMoved + stallWhy：被拽回去过就说是权限/区域问题，没拽过才说撞地形')
}


console.log(`\n通过 ${pass} · 失败 ${fail}`)
process.exit(fail ? 1 : 0)
