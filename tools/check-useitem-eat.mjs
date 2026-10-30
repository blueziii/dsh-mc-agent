#!/usr/bin/env node
/**
 * check-useitem-eat.mjs —— "到底吃下去没有"（useItem 的 ate / autoHoldForFood / ateNote）
 *
 * 背景：2026-10-22 实机，模型连着两次"吃了面包却还饿着"—— 旧 useItem 对食物只发一个
 *   activateItem 就立刻 deactivateItem（等于举一下又放下），却照样回 used:bread。
 *   吃饭是**能力**不是决策：这里只钉"如实报有没有咽下去"，不替模型决定吃不吃。
 *
 * 钉死的四件事：
 *   ① 食物不给 hold ⇒ 自动按住 ~1800ms，并把 autoHoldForFood 报回去；
 *   ② 收到自己的 entity_status 9 ⇒ ate:true（判据同 mineflayer-auto-eat）；
 *   ③ 收不到 ⇒ ate:false + 一句能照做的提示（含 hold:1800 / 饥饿已满两种情况）；
 *   ④ 非食物（末影珍珠等）不掺食物字段，hold 原样。
 *
 * 用法：node tools/check-useitem-eat.mjs（**必须从包目录跑**）
 */
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { useItem } from '../src/world-use.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')) } }

function mkBot ({ name, count = 8, foodPoints, food = 15, emits = false }) {
  const client = new EventEmitter()
  const bot = {
    entity: { id: 7, position: { x: 0, y: 64, z: 0 } },
    _client: client,
    food,
    heldItem: { name, count, ...(foodPoints === undefined ? {} : { foodPoints }) },
    inventory: { items: () => [bot.heldItem] },
    activateItem: async () => {
      if (!emits) return
      setTimeout(() => client.emit('entity_status', { entityId: 7, entityStatus: 9 }), 60)
    },
    deactivateItem: async () => {},
  }
  return bot
}

console.log('① 面包没给 hold：默认按住 + 收到消耗回执 ⇒ ate:true')
{
  const b = mkBot({ name: 'bread', foodPoints: 5, emits: true })
  const t0 = Date.now()
  const r = await useItem(b, {}, {})
  ok(r.autoHoldForFood === true, '自动补了 hold（autoHoldForFood）', JSON.stringify(r.autoHoldForFood))
  ok(r.heldMs >= 1_700, '真的按住了 ~1800ms', String(r.heldMs))
  ok(r.ate === true, 'ate:true（收到 entity_status 9）', JSON.stringify(r.ate))
  ok(!r.ateNote, '没有"没吃进去"的提示', String(r.ateNote))
  ok(Date.now() - t0 >= 1_700, '确实等了那么久（不是空转）')
}

console.log('② 面包但服务端没回执 ⇒ ate:false + 可执行提示')
{
  const b = mkBot({ name: 'bread', foodPoints: 5, emits: false })
  const r = await useItem(b, { hold: 100 }, {})
  ok(r.ate === false, 'ate:false', JSON.stringify(r.ate))
  ok(/entity_status 9/.test(r.ateNote ?? ''), '提示里说清判据', String(r.ateNote))
  ok(/hold:1800/.test(r.ateNote ?? ''), '提示给了可直接照做的命令', String(r.ateNote))
  ok(r.autoHoldForFood === undefined, '给了 hold 就不自动补', JSON.stringify(r.autoHoldForFood))
  ok(r.heldMs === 100, 'heldMs 如实是 100', String(r.heldMs))
}

console.log('③ 饥饿已满 ⇒ 提示"吃不下"，不误导')
{
  const b = mkBot({ name: 'cooked_beef', foodPoints: 8, food: 20, emits: false })
  const r = await useItem(b, { hold: 50 }, {})
  ok(r.ate === false && /饥饿是满的/.test(r.ateNote ?? ''), '饥饿满 ⇒ 明说吃不下', String(r.ateNote))
  ok(r.foodBefore === 20, '带 foodBefore', String(r.foodBefore))
}

console.log('④ 非食物（末影珍珠）⇒ 不掺食物字段，hold 原样')
{
  const b = mkBot({ name: 'ender_pearl', count: 3 })
  const r = await useItem(b, { hold: 60 }, {})
  ok(r.ate === undefined, '没有 ate 字段', JSON.stringify(r.ate))
  ok(r.ateNote === undefined, '没有 ateNote', String(r.ateNote))
  ok(r.heldMs === 60 && r.used === 'ender_pearl', 'heldMs/used 原样', JSON.stringify({ h: r.heldMs, u: r.used }))
}

/* 🔴 2026-11-02 审计（#17）：\`autoHoldForFood\` 是我们自己把按住时间从 0 拉长到 1.8 秒的，
 *    松手条件却只看 \`want > 0\` ⇒ 吃完东西一直举在手上。谁延长谁负责松。 */
{
  const src = readFileSync(new URL('../src/world-use.mjs', import.meta.url), 'utf8')
  ok(/\(want > 0 \|\| autoHoldForFood\) && typeof b\.deactivateItem === 'function'/.test(src),
    '🔴 自动延长按住时间（autoHoldForFood）时也要松手，不然食物一直举在手上')
}
console.log(`\nverify-eat：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
