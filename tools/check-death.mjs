#!/usr/bin/env node
/**
 * tools/check-death.mjs —— 死亡识别回归（2026-10-29，用户：「为什么现在 ai 死了好像不知道」）。
 *
 * 钉住五件事：
 *   ① 重生是 mineflayer 默认行为（`loader.js:75` `options.respawn ?? true`）—— 我们**不该**再手动传 `respawn: true`
 *   ② 死亡/重生都要记账（死在哪、重生在哪、死了几次）
 *   ③ `requireBot` 死了要拦（`isAlive === false` 或 `health <= 0`），但 `allowDead:true` 放行
 *   ④ 只读 / 只动嘴的工具必须放行 —— 真死了更该能喊人、能看地图、能查状态
 *   ⑤ 动作期间死过，返回里要能看出来（`died` / `diedAt` / `respawnedTo`）
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireBot } from '../src/runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const rd = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const conn = rd('src/connection.mjs')
const rt = rd('src/runtime.mjs')
const core = rd('src/core.mjs')
const chat = rd('src/chat.mjs')
const idx = rd('index.js')
const status = rd('src/status.mjs')

console.log('\n① 重生：由模型决定（不自动）')
ok(!/respawn:\s*true/.test(conn), 'createBot 没再传 respawn: true（默认就是 true）')
ok(/respawn: false/.test(conn), 'createBot 显式关掉自动重生（respawn: false）')
ok(/export async function respawnNow \(self\)/.test(rt), 'runtime 有 respawnNow（发包 + 等 isAlive/血量）')
ok(/isAlive === true && Number\(b\.health\) > 0/.test(rt), '重生看世界状态确认，不信回包')
ok(/async respawnNow \(\) \{ return await respawnNowImpl\(this\) \}/.test(core), 'core 暴露 respawnNow')
ok(/case 'respawn':/.test(idx), 'mc_act 有 respawn 分支')
ok(/· respawn 重生/.test(idx), 'mc_act 描述写了 respawn')
ok(/b\.isAlive === false \? \{ dead: true/.test(status), 'mc_status 报 dead: true')
ok(/mc_act \{ mode: "respawn" \}/.test(rt), '死了的报错里直接告诉怎么重生')
ok(/respawn\s*=\s*options\.respawn \?\? true/.test(readFileSync(join(ROOT, 'node_modules/mineflayer/lib/loader.js'), 'utf8')),
  '依赖的默认值还在 loader.js 里（升级 mineflayer 时这条会先红）')

console.log('\n② 死亡/重生记账')
ok(/b\.on\('death'/.test(conn), 'death 监听在位')
ok(/self\._life = \{ at: Date\.now\(\), position: self\.position, deaths: self\.stats\.deaths \}/.test(conn),
  'death 记 at / position / deaths', '死在哪能回溯（掉落物 5 分钟消失）')
ok(/b\.on\('respawn'/.test(conn) && /respawnPosition/.test(conn), 'respawn 记重生位置')
ok(/deaths: self\?\.stats\?\.deaths \?\? 0/.test(status) && /lastDeath/.test(status), 'mc_status 报 deaths / lastDeath')

console.log('\n③ requireBot 死了要拦')
ok(/export function requireBot \(self, \{ allowDead = false \} = \{\}\)/.test(rt), 'requireBot 收 allowDead')
ok(/!allowDead && \(b\?\.isAlive === false \|\| Number\(b\?\.health\) <= 0\)/.test(rt), '死检：死亡/血量 0 就抛')
ok(/我已经死了/.test(rt) && /还没重生/.test(rt), '报错说清“已死、还没重生”')
ok(/掉落物 5 分钟后消失/.test(rt), '顺带提醒掉落物时限')

console.log('\n④ 只读 / 只动嘴的放行')
{
  const hits = (src) => (src.match(/requireBot\(\{ allowDead: true \}\)/g) ?? []).length
  ok(hits(core) >= 9, 'core.mjs 只读方法放行（scan/heightmap/mapImage/inventory/lookAt/entities/bossbar/command）', `${hits(core)} 处`)
  ok(hits(chat) === 2, 'chat.mjs 放行（活着能说，死了更能喊人）', `${hits(chat)} 处`)
  ok(!/requireBot\(\{ allowDead: true \}\)[^\n]*giveItem/.test(core) && /async giveItem \(opts = \{\}\) \{\n?\s*const b = this\.requireBot\(\)/.test(core),
    '动世界的（giveItem）照旧被拦')
}

console.log('\n⑤ 动作期间死过要能看出来')
ok(/const deathMarkOf = \(sess\) =>/.test(idx) && /const deathNoteOf = \(sess\) =>/.test(idx), '有死亡对账/说明两个 helper')
ok(/died: true/.test(idx) && /diedAt/.test(idx) && /respawnedTo/.test(idx), '返回里带 died / diedAt / respawnedTo')
ok(/deathMarkOf\(sess\) > deaths0/.test(idx), 'mc_move 按“这一趟死没死过”判')
ok(/这期间我死了一次/.test(idx), '文案直说目标作废')

console.log('\n⑥ 行为级：allowDead 真的放行')
{
  const dead = { online: true, stats: { deaths: 2 }, _life: { position: { x: 1, y: 2, z: 3 } }, bot: { isAlive: false, health: 0, _client: { ended: false }, entity: {} } }
  let threw = ''
  try { requireBot(dead) } catch (e) { threw = String(e?.message ?? e) }
  ok(threw.includes('已经死了'), '默认拦：死死拦住', threw.slice(0, 40))
  ok(threw.includes('(1, 2, 3)'), '报错带死亡坐标', threw.match(/死在 [^）]*/)?.[0] ?? '')
  let okDead = null
  try { okDead = requireBot(dead, { allowDead: true }) } catch (e) { okDead = null }
  ok(okDead === dead.bot, 'allowDead：死了也把 bot 给它（能说话/能查状态）')

  const alive = { online: true, stats: { deaths: 0 }, bot: { isAlive: true, health: 20, _client: { ended: false }, entity: {} } }
  let okAlive = null
  try { okAlive = requireBot(alive) } catch { okAlive = null }
  ok(okAlive === alive.bot, '活着照常')
}

/* ⑥ 2026-10-29 实机：`mc_observe` 报 `Error: self is not defined` —— `statusOf` 里读了
 *   `self._life` / `self.stats` 但签名只有 `(b, ctx)`。这一组把它钉住：
 *   ① 源码里不允许出现裸 `self.`（必须 `self?.` 或进签名）。
 *   ② 不传 self 也不能抛错（降级成“不显示死亡记录”）。
 *   ③ 传了 self 就要真的读到 deaths / diedAt。 */
{
  const stSrc = readFileSync(new URL('../src/status.mjs', import.meta.url), 'utf8')
  ok(/export function statusOf \(b, ctx = \{\}, self = null\)/.test(stSrc),
    'statusOf 签名接受第三参 self')
  {
    /* 先剥掉注释——我自己在注释里写了 `self._life` 当反例说明，不能自己绔自己 */
    const code = stSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    ok(!/(?<![.\w])self\._life/.test(code) && !/(?<![.\w])self\.stats/.test(code),
      'statusOf 里不再有裸 self（用 self?.）')
  }
  const { statusOf } = await import('../src/status.mjs')
  const fakeBot = {
    entity: { position: { x: 1, y: 64, z: 2 }, yaw: 0, pitch: 0, eyeHeight: 1.62 },
    isAlive: false, health: 0, food: 20, oxygenLevel: 20,
    blockAt: () => ({ name: 'air' }), players: {}, game: { gameMode: 'survival' },
    time: { timeOfDay: 0 }, heldItem: null,
    _client: { ended: false }, inventory: { items: () => [] },
  }
  let threw = null
  let plain = null
  try { plain = statusOf(fakeBot, {}) } catch (e) { threw = e }
  ok(threw === null, '不传 self 也不抛错（这就是那个 ReferenceError）', String(threw?.message ?? ''))
  ok(plain?.dead === true, '死着要能看出来 dead:true')
  const withSelf = statusOf(fakeBot, {}, {
    stats: { deaths: 3 }, _life: { position: { x: 9, y: 12, z: 9 } },
  })
  ok(withSelf?.deaths === 3 && withSelf?.diedAt?.x === 9 && withSelf?.lastDeath?.y === 12,
    '传了 self 就读到 deaths / diedAt / lastDeath', JSON.stringify({ d: withSelf?.deaths, diedAt: withSelf?.diedAt }))
}

console.log(`\ncheck-death：pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
