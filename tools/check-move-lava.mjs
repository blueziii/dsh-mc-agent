/* check-move-lava.mjs —— 「move 会往流动的岩浆里走」的回归体检
 *
 * 🔴 2026-11-04 用户实机：「move 会往流动的岩浆里走」。
 *    bot 日志里同一天两次 `lavaEscape`（20:02:41 血 13.2→9.1、20:10:20 血 14→10.7），
 *    都是在 Nether 岩浆湖边走路时掉进去的。
 *
 * 病根（vendor `lib/movements.js`）：
 *    `blocksToAvoid` 只让 `b.safe` 变 false（`:237`），而 `safeOrBreak()` 拿到 safe=false
 *    之后还会问 `safeToBreak()` —— 岩浆是"可挖方块"，于是"走进岩浆"被当成一条
 *    **挖开岩浆再走进去** 的边（`getMoveJumpUp` 实测给出 cost≈453、`toBreak=[lava]` 的邻居）。
 *    只有把岩浆同时塞进 `blocksCantBreak`，那条边才变 Infinity。
 *
 * 这里用**真的** vendor Movements + 真的 minecraft-data registry 验邻居表：
 *    ① 上游默认会给出"跳上岩浆格"的边（留作对照，证明这个坑是真的）
 *    ② 我们的 `movements()` 配过之后，一条都不许有（落点不是岩浆、toBreak 也不含岩浆）
 *    ③ 泡在岩浆里时反过来：不许把岩浆锁死，得能规划着游出去
 *    ④ 源码钉：岩浆同时进两张名单，`inLava` 时两张一起放
 *
 * 用法：node tools/check-move-lava.mjs [vendor 目录]
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const VENDOR = process.argv[2] ?? process.env.MC_DEPS_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'vendor', 'mc-deps')
const PF_DIR = join(VENDOR, 'node_modules', 'mineflayer-pathfinder')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

const req = createRequire(join(PF_DIR, 'index.js'))

let mcData = null
for (const v of ['1.21.9', '1.21.4', '1.21.1', '1.20.4', '1.16.5']) {
  try { mcData = req('minecraft-data')(v); break } catch { /* 换下一个 */ }
}
if (!mcData) {
  console.log('✗ 加载不了 minecraft-data（Movements 的构造函数要它）')
  process.exit(2)
}

const Movements = req(join(PF_DIR, 'lib', 'movements.js'))
const Block = req('prismarine-block')(mcData)
const Vec3 = req('vec3').Vec3 ?? req('vec3')

const LAVA = mcData.blocksByName.lava.id
const cells = new Map()
const key = (x, y, z) => `${x},${y},${z}`
const put = (x, y, z, name) => {
  const b = Block.fromStateId(mcData.blocksByName[name].defaultState, 0)
  b.position = new Vec3(x, y, z)
  cells.set(key(x, y, z), b)
}
/** 干净场景：y=63 石头地板、上面四层空气，正前方 (1,64,0)+(1,65,0) 是岩浆 */
const build = () => {
  cells.clear()
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      put(x, 63, z, 'stone')
      put(x, 64, z, 'air')
      put(x, 65, z, 'air')
      put(x, 66, z, 'air')
    }
  }
  put(1, 64, 0, 'lava')
  put(1, 65, 0, 'lava')
}
build()

const mkBot = (pos = new Vec3(0.5, 64, 0.5)) => ({
  registry: mcData,
  username: 'check',
  entity: { position: pos, username: 'check', effects: [] },
  entities: {},
  game: { minY: -64 },
  pathfinder: { bestHarvestTool: () => null },
  blockAt: (p) => cells.get(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) ?? null
})

const { movements } = await import(new URL('../src/plugins.mjs', import.meta.url))
const NODE = { x: 0, y: 64, z: 0, remainingBlocks: 64 }
const landIsLava = (m) => {
  const b = cells.get(key(m.x, m.y, m.z))
  return b?.type === LAVA
}
const brokeLava = (m) => (m.toBreak ?? []).some((p) => cells.get(key(p.x, p.y, p.z))?.type === LAVA)

/* ── ① 上游默认（对照，证明坑是真的） ─────────────────────────────── */
section('① 上游默认 Movements（对照：它确实会规划"跳上岩浆格"）')
{
  const mv = new Movements(mkBot())
  const nb = mv.getNeighbors(NODE)
  const bad = nb.filter((m) => landIsLava(m) || brokeLava(m))
  console.log(`   （信息）邻居 ${nb.length} 条，其中"落点或挖开的是岩浆" ${bad.length} 条` +
    (bad.length ? `：${bad.map((m) => `${m.x},${m.y},${m.z}`).join(' / ')}` : ''))
  ok(true, '对照跑完（不断言上游行为，只记录事实）')
}

/* ── ② 我们的配置：一条都不许进岩浆 ──────────────────────────────── */
section('② 我们 movements() 配过之后：A* 眼里没有"走进岩浆"这种边')
{
  const self = { bot: mkBot(), cfg: {}, _pf: { Movements }, log: () => {} }
  const mv = movements(self, {})
  ok(mv !== null, '拿到了 Movements（生产同一份配置函数）')
  ok(mv.blocksToAvoid.has(LAVA) === true, '岩浆在 blocksToAvoid（"这格不能站"）')
  ok(mv.blocksCantBreak.has(LAVA) === true, '🔴 岩浆同时在 blocksCantBreak（没这条就会被当成"挖开再走进去"）')
  const nb = mv.getNeighbors(NODE)
  ok(nb.length > 0, `还有别的路可走（邻居 ${nb.length} 条，不是把路全封死）`)
  ok(nb.filter(landIsLava).length === 0, '没有任何一步的落点是岩浆格')
  ok(nb.filter(brokeLava).length === 0, '也没有任何一步要"挖开岩浆"')
  /* 正前方那格是岩浆：不许出现落点 (1,64,0) / (1,65,0) */
  ok(!nb.some((m) => m.x === 1 && m.z === 0), '正前方那格是岩浆 ⇒ 没有"往岩浆里迈一步"的边')
}

/* ── ③ 泡在岩浆里：反过来必须能规划出去 ─────────────────────────── */
section('③ 自己就泡在岩浆里：不许把岩浆锁死（要能规划着游出去）')
{
  build()
  put(0, 64, 0, 'lava')
  put(0, 65, 0, 'lava')
  const bot = mkBot(new Vec3(0.5, 64, 0.5))
  bot.entity.isInLava = true
  const self = { bot, cfg: {}, _pf: { Movements }, log: () => {} }
  const mv = movements(self, {})
  ok(mv.__dshInLava === true, '认出了"当下在岩浆里"')
  ok(mv.blocksToAvoid.has(LAVA) === false, '岩浆从 blocksToAvoid 里放出来')
  ok(mv.blocksCantBreak.has(LAVA) === false, '🔴 也从 blocksCantBreak 里放出来（不然连"游出去"都不许挖）')
  const nb = mv.getNeighbors({ x: 0, y: 64, z: 0, remainingBlocks: 64 })
  ok(nb.length > 0, `能从岩浆里往外规划（邻边 ${nb.length} 条）`)
  ok(nb.some((m) => !landIsLava(m)), '其中至少有一条落在非岩浆格上（真能上岸）')
}

/* ── ④ 源码钉 ────────────────────────────────────────────────────── */
section('④ 源码钉：两张名单一起管，流动岩浆也算')
{
  const src = readFileSync(join(ROOT, 'src', 'plugins.mjs'), 'utf8')
  ok(/const lavaIds = \[\]/.test(src) && /for \(const nm of \['lava', 'flowing_lava'\]\)/.test(src),
    "lava 与 flowing_lava 两个 id 都收（老版本里流动岩浆是独立方块）")
  ok(/mv\.blocksToAvoid\.add\(lavaId\)[\s\S]{0,80}mv\.blocksCantBreak\.add\(lavaId\)/.test(src),
    '不在岩浆里 ⇒ 两张名单都加')
  ok(/mv\.blocksToAvoid\.delete\(lavaId\)[\s\S]{0,2000}mv\.blocksCantBreak\.delete\(lavaId\)/.test(src),
    '在岩浆里 ⇒ 两张名单都删')
  ok(!/mv\.liquids\.add\(lavaId\)/.test(src), '🔴 不把岩浆算成水路（那等于告诉 A* 岩浆湖是水下通道）')
}

console.log('\n' + '─'.repeat(50))
console.log(`check-move-lava：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
