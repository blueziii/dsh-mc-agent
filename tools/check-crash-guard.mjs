/**
 * 未处理拒绝守卫（`src/crash-guard.mjs`）—— GitHub issue #1 的回归测试。
 *
 * 现场：`mc_move` 被调度器抢占之后，上一次的 `pathfinder.goto` 被 reject 成 `PathStopped`，
 * 它早就没人 await 了（派生链 `withTimeout → raceAbort → Promise.race` 一个个先撤），
 * 于是变成 unhandledRejection ⇒ 宿主的 fail-loud `exit(1)` ⇒ **整个 DSH 闪退**。
 *
 * 这里不连服务器，纯进程内造拒绝：
 *   ① 白名单里的 → 拦下、原监听一条都收不到；
 *   ② 白名单外的 → **原样转交**（真 bug 照崩，不掩盖）；
 *   ③ 环境变量关掉 → 一条都不拦；
 *   ④ 卸载之后监听恢复原样。
 */
import { readFileSync } from 'node:fs'
import {
  installRejectionGuard, uninstallRejectionGuard, refreshRejectionGuard, rejectionGuardStats,
  PATH_REJECTION_NAMES, BENIGN_REJECTION_MESSAGE_RES,
} from '../src/crash-guard.mjs'
import { guardDigRejections } from '../src/plugins.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

const named = (name, message = 'test') => { const e = new Error(message); e.name = name; return e }

/** 造一条"没人接"的拒绝，跑一轮事件循环让 process 有机会发出 unhandledRejection */
const leak = async (err) => {
  Promise.reject(err)
  await new Promise((r) => setTimeout(r, 60))
}

/** 把进程现有的 unhandledRejection 监听摘下来，跑完再装回去（别影响别的自检） */
const withCleanProcess = async (fn) => {
  const saved = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  try { return await fn() } finally {
    process.removeAllListeners('unhandledRejection')
    for (const h of saved) process.on('unhandledRejection', h)
  }
}

section('① 白名单：PathStopped / NoPath / GoalChanged / Timeout 都被拦下')
{
  await withCleanProcess(async () => {
    const got = []
    const hostLike = (reason) => got.push(reason?.name)      // 宿主 fail-loud 的替身
    process.on('unhandledRejection', hostLike)

    const r = installRejectionGuard({ enabled: true, log: () => {} })
    ok(r.installed === true, '装上了', JSON.stringify(r))
    ok(r.forwarded === 1, '接管了 1 个原监听（宿主那条）', String(r.forwarded))

    await leak(named('PathStopped'))
    await leak(named('NoPath'))
    await leak(named('GoalChanged'))
    await leak(named('Timeout'))

    ok(got.length === 0, '宿主一条都没收到（不会 exit）', JSON.stringify(got))
    const st = rejectionGuardStats()
    ok(st.swallowed === 4, '吞了 4 条', String(st.swallowed))
    ok(st.forwarded === 0, '没有误转交', String(st.forwarded))
    ok(st.allow.includes('PathStopped') && st.allow.length === 4, '白名单就是那四个名字', JSON.stringify(st.allow))
    uninstallRejectionGuard()
  })
}

section('② 白名单外：原样转交（真 bug 照崩，不掩盖）')
{
  await withCleanProcess(async () => {
    const got = []
    process.on('unhandledRejection', (reason) => got.push(String(reason?.message ?? reason?.name ?? reason)))
    installRejectionGuard({ enabled: true, log: () => {} })

    await leak(new Error('我是真的 bug'))
    ok(got.length === 1, '宿主收到了那条真 bug', JSON.stringify(got))
    ok(/我是真的 bug/.test(String(got[0])), '内容完整转交', String(got[0]))
    ok(rejectionGuardStats().forwarded === 1, '统计记了 1 条转交', String(rejectionGuardStats().forwarded))

    await leak(named('PathStopped'))
    ok(got.length === 1, '白名单那条没跟过去（还是 1）', String(got.length))
    uninstallRejectionGuard()
  })
}

section('③ 环境变量 off：一条都不拦')
{
  await withCleanProcess(async () => {
    const got = []
    process.on('unhandledRejection', (reason) => got.push(reason?.name))
    const old = process.env.DSH_MC_AGENT_REJECTION_GUARD
    process.env.DSH_MC_AGENT_REJECTION_GUARD = 'off'
    const r = installRejectionGuard({ log: () => {} })
    ok(r.installed === false && r.reason === 'disabled', 'off ⇒ 不装', JSON.stringify(r))
    await leak(named('PathStopped'))
    ok(got.length === 1, '照旧交给宿主（这条会 exit，就是要它崩）', JSON.stringify(got))
    if (old === undefined) delete process.env.DSH_MC_AGENT_REJECTION_GUARD
    else process.env.DSH_MC_AGENT_REJECTION_GUARD = old
  })
}

section('④ 幂等与卸载')
{
  await withCleanProcess(async () => {
    const hostLike = () => {}
    process.on('unhandledRejection', hostLike)
    const a = installRejectionGuard({ enabled: true, log: () => {} })
    const b = installRejectionGuard({ enabled: true, log: () => {} })
    ok(a.installed === true, '第一次装上', JSON.stringify(a))
    ok(b.installed === false && b.reason === 'already', '第二次幂等（不重复包装）', JSON.stringify(b))

    ok(uninstallRejectionGuard() === true, '卸得掉')
    ok(process.listeners('unhandledRejection').length === 1, '原监听回来了（1 条）', String(process.listeners('unhandledRejection').length))
    ok(rejectionGuardStats().installed === false, '卸载后没有状态', JSON.stringify(rejectionGuardStats()))
  })
}

section('⑥ 装完之后才注册的监听：补挂能收编回来')
{
  await withCleanProcess(async () => {
    const late = []
    installRejectionGuard({ enabled: true, log: () => {} })
    /* 模拟"宿主的 fail-loud 晚于插件安装" */
    process.on('unhandledRejection', (reason) => late.push(String(reason?.name ?? '')))
    ok(process.listeners('unhandledRejection').length === 2, '现在进程里有 2 个 handler（我们 + 后挂的）', String(process.listeners('unhandledRejection').length))
    const n = refreshRejectionGuard({ log: () => {} })
    ok(n === 1, '补挂收编了 1 个', String(n))
    ok(process.listeners('unhandledRejection').length === 1, '又回到"只有我们一个 handler"', String(process.listeners('unhandledRejection').length))
    await leak(named('PathStopped'))
    ok(late.length === 0, '白名单那条没跑到后挂的监听里去', JSON.stringify(late))
    await leak(new Error('真 bug'))
    ok(late.length === 1, '真 bug 照样转交给它', JSON.stringify(late))
    uninstallRejectionGuard()
  })
}

section('⑤ 白名单是冻结常量（别被人手改）')
{
  ok(Object.isFrozen(PATH_REJECTION_NAMES), 'PATH_REJECTION_NAMES 冻结了')
  ok(PATH_REJECTION_NAMES.join(',') === 'PathStopped,NoPath,GoalChanged,Timeout', '四个名字一个不多一个不少', PATH_REJECTION_NAMES.join(','))
}

section('⑦ 名字不在白名单、但带 mcTimeout/mcAborted 标记：也拦（issue #3 那次崩溃）')
{
  await withCleanProcess(async () => {
    const got = []
    process.on('unhandledRejection', (r) => got.push(r?.name))
    installRejectionGuard({ enabled: true, log: () => {} })

    /* 这两条在旧版会原样转交给宿主 —— 名字都叫 `Error`，白名单认不出来。 */
    const t = new Error('寻路 超时（200ms）：这一步在限定时间内没做完')
    t.mcTimeout = true
    await leak(t)
    const b = new Error('这一轮的走路时间已经用完了')
    b.mcBudgetOut = true
    await leak(b)

    ok(got.length === 0, '宿主一条都没收到（不会 fatal load failure）', JSON.stringify(got))
    ok(rejectionGuardStats().swallowed === 2, '吞了 2 条', String(rejectionGuardStats().swallowed))
    ok(rejectionGuardStats().lastFew.includes('mcTimeout'), '账上记的是标记名（看日志能认出是哪一类）', JSON.stringify(rejectionGuardStats().lastFew))

    /* 不带标记的普通 Error 仍然转交 —— 别把真 bug 一起吞了。 */
    await leak(new Error('真 bug'))
    ok(got.length === 1 && got[0] === 'Error', '不带标记的 Error 照样转交（不掩盖真错）', JSON.stringify(got))
    uninstallRejectionGuard()
  })
}

section('⑧ issue #5：按消息认 `Digging aborted`（name 只是普通 Error，标记也没有）')
{
  await withCleanProcess(async () => {
    const got = []
    process.on('unhandledRejection', (r) => got.push(String(r?.message ?? r?.name ?? '')))
    installRejectionGuard({ enabled: true, log: () => {} })

    ok(BENIGN_REJECTION_MESSAGE_RES.length === 1 && BENIGN_REJECTION_MESSAGE_RES[0].source === '^Digging aborted$',
      '按消息认的只有一句（^Digging aborted$）', BENIGN_REJECTION_MESSAGE_RES.map(String).join(','))
    ok(Object.isFrozen(BENIGN_REJECTION_MESSAGE_RES), '这个列表是冻结的')

    /* 真实现场：mineflayer `stopDigging()` 抛的就是这一句，name 是普通 Error、没有任何标记 */
    const aborted = new Error('Digging aborted')
    ok(aborted.name === 'Error' && !aborted.mcTimeout && !aborted.mcAborted,
      '（前提）它 name=Error、不带任何软标记 —— 旧判据认不出来', aborted.name)
    await leak(aborted)
    const st = rejectionGuardStats()
    ok(got.length === 0, '宿主一条都没收到（不会闪退）', JSON.stringify(got))
    ok(st.swallowed === 1 && st.lastFew.includes('dig-aborted'), '账上记成 dig-aborted', JSON.stringify(st.lastFew))
    ok(Array.isArray(st.allowMsg) && st.allowMsg.length === 1, '统计里能看到这条按消息的判据', JSON.stringify(st.allowMsg))

    /* 只认这一句：长得像但不是那句的，照样转交（不顺手吞掉一堆） */
    await leak(new Error('Digging aborted: 但这句话后面还挂着别的东西'))
    ok(got.length === 1, '长相接近但不是那一句 ⇒ 照样转交', JSON.stringify(got))
    uninstallRejectionGuard()
  })
}

section('⑨ issue #5：`bot.dig` 的返回 promise 一律"已处理"（不靠 race 兜）')
{
  await withCleanProcess(async () => {
    const got = []
    process.on('unhandledRejection', (r) => got.push(String(r?.message ?? '')))
    const rejects = []
    const bot = { dig: () => new Promise((_, rej) => { rejects.push(rej) }) }

    ok(guardDigRejections(bot) === true, '挂上了')
    ok(bot.__dshGuardedDigReject === true, '记了幂等标记')
    ok(guardDigRejections(bot) === false, '重复调用不再包一层（否则每趟多一层闭包）')

    const p1 = bot.dig()                    // 谁都不接（race 已经先赢的那种）
    const p2 = bot.dig()                    // 调用方自己接
    let caught = null
    p2.catch((e) => { caught = e })
    for (const rej of rejects) rej(new Error('Digging aborted'))
    await new Promise((r) => setTimeout(r, 60))

    ok(got.length === 0, '没人接的那条也不会变成 unhandledRejection（宿主不会 exit）', JSON.stringify(got))
    ok(caught?.message === 'Digging aborted', '调用方自己 .catch 仍照常收到（不改返回值）', String(caught?.message))
    void p1
  })
}

section('⑩ 源码：三个挖掘入口开新挖前先自己松手 + 给 raw promise 挂 catch')
{
  const mv = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const pl = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
  const cnt = (s, sub) => s.split(sub).length - 1
  ok(cnt(pl, 'export function guardDigRejections') === 1, 'plugins 里有 guardDigRejections')
  ok(cnt(pl, 'guardDigRejections(b, { log: (m) => self.log(m) })') === 1, 'setupPlugins 里真的调了它',
    String(cnt(pl, 'guardDigRejections(b, { log: (m) => self.log(m) })')))
  ok(cnt(mv, 'const pDig = b.dig(blk, true)') === 3, 'digOneGuarded / digOneSafe / stepUp 的 digAt 都拿到 raw promise',
    String(cnt(mv, 'const pDig = b.dig(blk, true)')))
  ok(cnt(mv, 'pDig?.catch?.(() => {})') === 3, '三个入口都给 raw promise 挂了空 catch',
    String(cnt(mv, 'pDig?.catch?.(() => {})')))
  ok(cnt(mv, 'if (b?.targetDigBlock) { try { b.stopDigging?.() } catch {} ; await sleep(0) }') === 3,
    '开新挖前都先自己松手（把掐断放进我们的 try 里）',
    String(cnt(mv, 'if (b?.targetDigBlock) { try { b.stopDigging?.() } catch {} ; await sleep(0) }')))
  ok(!/Promise\.resolve\(b\.dig\(blk, true\)\)/.test(mv), '不再有"先 dig 再包 race、迟到拒绝没人接"的旧写法')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
