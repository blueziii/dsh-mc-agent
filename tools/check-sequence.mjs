#!/usr/bin/env node
/**
 * `src/sequence.mjs` 的结果汇总自检（2026-10-29 用户给的输出规范：阶段 2「逐项流水改为汇总」）。
 *
 * 为什么单独一套：`mc_sequence` 以前**没有 `text`** ⇒ 宿主只能把整个返回对象压成 JSON ——
 * 10 步全成功也要 500+ 字符，每步还带 `{"i":0,"op":"move","ok":true,"arrived":true,"remaining":null}`
 * 这种壳。现在成功步骤合成区间、失败步骤逐条（带 arrived/remaining），hint 照旧。
 * 这套钉的就是"合并得对、失败没被合并掉、hint 还在"。
 *
 * 不需要 MC、不需要 DSH：`self` 用 Proxy 兜底，动作全部返回假结果。
 */

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const A = await import(new URL('../src/sequence.mjs', import.meta.url))
const SRC = readFileSync(new URL('../src/sequence.mjs', import.meta.url), 'utf8')

/** 假 self：没定义的方法一律返回“成功”，避免 runStep 里的分支缺依赖。 */
function fakeSelf (walkImpl, leftMs = 9000) {
  return new Proxy({
    msLeft: () => leftMs,
    bot: { entity: { position: { x: 0, y: 64, z: 0 } }, health: 20, players: {} },
    cfg: {},
    abortSignal: null,
    walkTo: walkImpl ?? (async () => ({ arrived: true })),
  }, {
    get (t, k) {
      if (k in t) return t[k]
      return async () => ({ arrived: true })
    },
  })
}

section('① 全成功：合成一行，不逐条列')
{
  const r = await A.runSequence(fakeSelf(), [{ op: 'move', x: 1 }, { op: 'move', x: 2 }, { op: 'move', x: 3 }], {})
  const t = String(r.text ?? '')
  ok(r.succeeded === 3 && r.failed === 0, '返回对象照旧（succeeded=3 / failed=0）', `${r.succeeded}/${r.failed}`)
  ok(t.split('\n').length === 1, 'text 只有一行（3 步合成 1 行）', t.split('\n').length + ' 行')
  ok(/做成 3 步/.test(t), '写出了做成几步', t.slice(0, 60))
  ok(/第 1–3 步/.test(t), '连续的成功步骤合成区间「1–3」', t.slice(0, 60))
  ok(/全部做完/.test(t), '全做完时说清楚（模型不用再猜还剩没剩）', t.slice(0, 60))
  ok(!/"i":0/.test(t), '没有把 results 的 JSON 壳倒出来')
}

section('② 中途失败：成功合并、失败逐条带数值')
{
  let n = 0
  const r = await A.runSequence(
    fakeSelf(async () => (++n === 2 ? { arrived: false, stuck: true, reason: 'timeout', moved: 0.4 } : { arrived: true })),
    [{ op: 'move', x: 1 }, { op: 'move', x: 2 }, { op: 'move', x: 3 }], {})
  const t = String(r.text ?? '')
  ok(r.succeeded === 1 && r.failed === 1, '返回对象：做成 1、失败 1（第 3 步没执行不记失败）', `${r.succeeded}/${r.failed}`)
  ok(/第 2 步没做成/.test(t), '汇总行点明第几步没做成', t.slice(0, 80))
  ok(/✗ 第 2 步 move（arrived=false）/.test(t), '失败行带 arrived 的实际值（不是让模型再看一遍 JSON）', t.split('\n')[1] ?? '')
  ok(/从第 2 步往后发/.test(t), 'hint 仍然带出来（text 优先输出，hint 必须自己拼进去）')
}

section('③ 一步都没做成（预算耗尽）：不复述旧账')
{
  const r = await A.runSequence(fakeSelf(null, 50), [{ op: 'move', x: 1 }], {})
  const t = String(r.text ?? '')
  ok(r.noBudget === true, '返回对象带 noBudget', String(r.noBudget))
  ok(/没分到时间/.test(t), 'text 说清“这次自己没分到时间”，而不是“没做成”', t.slice(0, 90))
  ok(/别当成没动过/.test(t), '提醒先复核现场（防止把已经做完的事重做一遍）', t.slice(0, 90))
}

section('④ 源码：合并逻辑与失败逐条都在')
{
  ok(/function seqTextOf/.test(SRC), '有独立的渲染函数 seqTextOf')
  ok(/out\.text = seqTextOf\(out, results, steps\)/.test(SRC), '仍然返回 results 对象（套件/内部还在读它），只额外挂 text')
  ok(/for \(const x of bad\)/.test(SRC), '失败步骤逐条渲染（不合并）')
  ok(/n === prev \+ 1/.test(SRC), '区间合并按“连号”判断')
}

/* 🔴 2026-11-02 审计（#15/#18）：两条判据以前是"看字段存不存在 / 靠剩余时间猜"。 */
{
  const { stepOk } = await import(new URL('../src/sequence.mjs', import.meta.url))
  // #15：`attacked` 恒为目标名字 ⇒ 不能再拿它判成功；没打死但挥到过 = 这一步做完了
  ok(stepOk({ op: 'attack' }, { killed: true, attacked: 'Bluezi' }) === true, '打死了算成功')
  ok(stepOk({ op: 'attack' }, { killed: false, attacked: 'Bluezi', swings: 3 }) === true,
    '🔴 没打死但挥到过也算做完（以前只认 killed ⇒ 时间到/目标跑了都判失败，整串被掐断）')
  ok(stepOk({ op: 'attack' }, { killed: false, attacked: 'Bluezi', pvpSwings: 2 }) === true,
    'vendor 那边挥到过同样算')
  ok(stepOk({ op: 'attack' }, { killed: false, attacked: 'Bluezi', sawDamage: true }) === true,
    '目标掉了血也说明打到了')
  ok(stepOk({ op: 'attack' }, { killed: false, attacked: 'Bluezi', swings: 0, pvpSwings: 0 }) === false,
    '一下都没挥到（够不着 / 目标没了）才算失败')
  ok(/case 'attack': \{/.test(SRC) && /Number\(r\.swings \?\? 0\) > 0/.test(SRC),
    '攻判据已换成看 swings/pvpSwings（不再拿恒为名字的 attacked 判，也不再只认 killed）')
}
// #18：抛错时必须给 stoppedAt（从第几步接着发）
ok(/if \(stopOnError\) \{ next = i; break \}/.test(SRC),
  '🔴 真出错也记 next（以前直接 break ⇒ 返回里没有 stoppedAt，模型只能整串重发）')
ok(/self\.msLeft\(\) <= 0/.test(SRC) && !/\|\| self\.msLeft\(\) <= 150/.test(SRC),
  '🔴 "没时间了"只在真的一秒不剩时兜底（以前 <=150ms 把任何错误都解释成没时间）')

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
