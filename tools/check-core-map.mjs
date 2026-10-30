#!/usr/bin/env node
/**
 * check-core-map.mjs —— `mc_map` 地形图的回归检查
 *
 * 背景（用户 2026-10-08 原话：「map工具ai说只能看地表的，添加在地下变成看以自身为中心上下2格
 *   洞穴。就像地图模组那样」）——**那条需求 2026-10-22 已被用户撤回**（原话「把 cave 去掉」）：
 *   洞穴层视图整块删除（`isUnderground` / `caveCell` / `CAVE_GLYPH` / `CAVE_LABEL` / `mode:"auto"`
 *   / `mode:"cave"` / `slab`）。现在 `mc_map` 只有三种模式：
 *
 *   · `floor`（默认）—— 脚下方块那一层（`floorMapOf()`，2026-10-15 用户需求）；
 *   · `surface` —— 地表图（`heightmapOf()`，每列从 `cy+yTop` 往下扫，取第一块非空气）；
 *   · `column` —— 竖列图（`columnOf()`，只看脚下这一格往下/往上看几格）。
 *
 * 下面按功能分区跑：⑥ 地板层 / ⑦ 坐标换算 / ⑧ 危险格 / ⑨ 导航摘要 / ⑩ 竖列图 / ⑪ 头顶 /
 * ⑤ 静态接线（core.mjs / index.js 的骨架有没有被改烂）。
 *
 * 🔴 2026-10-08 路线图第 ④ 条第十一刀：这一层的实现已搬到 `src/map-render.mjs`
 *   （`heightmapOf(b, …)` / `floorMapOf(b, …)` / `glyphMapText(…)` / `mapImageOf(b, …)`），
 *   `core.mjs` 只留同名薄包装（公开面不变）⇒ 下面⑤那些"按源码文本找代码"的断言
 *   必须去**新模块**里找（踩坑档案第 46 条那个坑，第十一次）。
 *
 * 用法：node tools/check-core-map.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 借依赖：源码树里没有 node_modules，从包目录借 vec3 ────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑，')
  console.log('  或确认已安装 mineflayer。')
  process.exit(2)
}
const Vec3 = req('vec3')
const { McBot, glyphOf } = await import(new URL('../src/core.mjs', import.meta.url))
/* 2026-10-15：`mc_map` 默认改成"脚下方块那一层" —— 新函数直接从 map-render.mjs 取
 *（工具层就是这么 import 的，没经过 core.mjs 的薄包装）。 */
const { floorMapOf, floorCell, floorKeyOf, gridToWorld, hazardCellsOf, navSummaryOf,
  columnOf, columnText, columnKindOf, parseXZ, surfaceYOf, glyphMapText } =
  await import(new URL('../src/map-render.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (bot) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-map-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = bot
  mc.mcPlugins = {}
  mc.pfReady = false
  return mc
}

/**
 * 假世界：`cells` 里显式给 `x,y,z` → 方块名（`null` = 未加载），其它一律 `fill`。
 * 只实现 `blockAt(Vec3)` —— 而且**喂普通对象就抛**（真 mineflayer 就是 `pos.floored is not a function`，
 * 这条纪律害过我们：`eyeOf()` 给普通对象 ⇒ `blockNameAt` 恒 null）。
 */
const mkWorld = ({ fill = 'air', cells = {} } = {}) => {
  const map = new Map()
  for (const [k, v] of Object.entries(cells)) map.set(k, v)
  const K = (x, y, z) => `${x},${y},${z}`
  const world = {
    set (x, y, z, n) { map.set(K(x, y, z), n); return world },
    get (x, y, z) { return map.has(K(x, y, z)) ? map.get(K(x, y, z)) : fill },
    blockAt (v) {
      if (!v || typeof v.x !== 'number' || typeof v.floored !== 'function') {
        throw new TypeError('pos.floored is not a function')
      }
      const n = world.get(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))
      return n == null ? null : { name: n, position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) }
    },
  }
  return world
}
const mkBot = ({ pos = [0, 64, 0], world = mkWorld() } = {}) => ({
  entity: { position: new Vec3(pos[0], pos[1], pos[2]), isInWater: false, yaw: 0, pitch: 0 },
  blockAt (v) { return world.blockAt(v) },
})

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section('⑥ 地板层视图（2026-10-15 用户需求：默认看"脚下方块那一层"）')

  {
    /* 房间：地板在 y=63（机器人 y=64 ⇒ 默认层 = 63）
     *   (0,63,0) 石头地面、身体空间空      ⇒ 能站
     *   (1,63,0) 地板石头 + 头顶 (1,64,0) 被堵 ⇒ 墙（**实心 ≠ 能站**）
     *   (2,63,0) 这一层是空气、下面也空     ⇒ 会掉下去
     *   (3,63,0) 水                        ⇒ 液体
     *   (4,63,0) 读不到（区块没加载）       ⇒ 未加载，**不能当成能走** */
    const w = mkWorld({ fill: 'air' })
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) w.set(x, 63, z, 'stone')
    w.set(1, 64, 0, 'stone')            // 身体被堵
    w.set(2, 63, 0, 'air')              // 这一层空
    w.set(3, 63, 0, 'water')
    w.set(4, 63, 0, null)               // 未加载
    const b = mkBot({ pos: [0, 64, 0], world: w })
    const m = floorMapOf(b, { radius: 6 })
    const at = (dx, dz) => m.names[m.radius + dz][m.radius + dx]
    const cellAt = (dx, dz) => m.cells[m.radius + dz][m.radius + dx]

    ok(m.mode === 'floor' && m.layer.y === 63, '默认层 = 脚底下那一层（feetY - 1）', `layer.y=${m.layer.y}`)
    ok(at(0, 0) === 'floor_walk', '实心地面 + 身体空间空 ⇒ floor_walk（能站）')
    ok(at(1, 0) === 'floor_wall', '地板实心但身体被堵 ⇒ floor_wall（**实心 ≠ 能站**）')
    ok(at(2, 0) === 'floor_drop', '这一层是空气、下面也没地板 ⇒ floor_drop（会掉下去）')
    ok(at(3, 0) === 'floor_water', '水 ⇒ floor_water')
    ok(at(4, 0) === 'floor_void', '读不到 ⇒ floor_void，**不能当成空气/能走**')
    ok(cellAt(4, 0).loaded === false && cellAt(0, 0).loaded === true, '每格带 loaded（未加载明确是 false）')
    ok(cellAt(0, 0).supported === true && cellAt(2, 0).supported === false, '每格带 supported（脚下有没有可靠支撑）')
    ok(cellAt(3, 0).hazard === 'water' && cellAt(0, 0).hazard === null, '每格带 hazard（水/岩浆）')
    ok(cellAt(4, 0).kind === 'unknown' && cellAt(4, 0).surfaceY === null, '未知状态必须**保留**（别猜一个高度出来）')
    ok(m.counts.walkable > 0 && m.counts.unknown >= 1, 'counts 分类计数', JSON.stringify(m.counts))
    ok(typeof m.originX === 'number' && m.cellSize === 1, '带 originX/originZ/cellSize')
  }
  {
    // layer 可以自己指定；不指定就是 feetY-1
    const w = mkWorld({ fill: 'air' })
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) w.set(x, 50, z, 'stone')
    const b = mkBot({ pos: [0, 64, 0], world: w })
    ok(floorMapOf(b, { radius: 4, layer: 50 }).layer.y === 50, 'layer 参数能指定看哪一层')
    ok(floorMapOf(b, { radius: 4 }).layer.y === 63, '不给 layer ⇒ 脚底下那一层')
    const c = floorCell(b, 0, 50, 0, { depth: 4 })
    ok(c.surfaceY === 50 && c.kind === 'walkable', 'floorCell 单格也能用（surfaceY = 地板那一层）')
    ok(floorKeyOf(c) === 'floor_walk', 'floorKeyOf 映射到字形键')
    ok(floorKeyOf({ kind: 'unknown' }) === 'floor_void' && floorKeyOf(null) === 'floor_void',
      'floorKeyOf 把未知/空都算成 floor_void')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑦ 坐标换算（用户"第三刀"：字符图第几行第几列 ⇒ 真实世界坐标）')

  {
    const w = mkWorld({ fill: 'air' })
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) w.set(x, 63, z, 'stone')
    const b = mkBot({ pos: [10, 64, -7], world: w })
    const m = floorMapOf(b, { radius: 8 })
    const mid = gridToWorld(m.radius, m.radius, m)
    ok(mid.x === 10 && mid.z === -7, '中心格（行=列=radius）就是机器人实际位置', `got (${mid.x}, ${mid.z})`)
    const tl = gridToWorld(0, 0, m)
    ok(tl.x === 2 && tl.z === -15, '左上角 = (cx-R, cz-R)', JSON.stringify(tl))
    ok(gridToWorld(m.radius, m.radius + 1, m).x === 11, '列 +1 ⇒ x +1（东）')
    ok(gridToWorld(m.radius + 1, m.radius, m).z === -6, '行 +1 ⇒ z +1（南）')
    // 抽稀步长变了，坐标也要跟着变 —— 所以一律走 gridToWorld，别自己乘
    const m2 = { ...m, cellSize: 2 }
    ok(gridToWorld(0, 1, m2).x === m2.originX + 2, 'cellSize=2（glyphStep=2）时列 +1 ⇒ x +2')
    ok(m.bounds.minX === m.originX && m.bounds.maxX === m.originX + m.radius * 2 - 1,
      'bounds 与 origin/cellSize 自洽')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑧ 危险格 / 未加载（hazardCellsOf）')

  {
    const w = mkWorld({ fill: 'air' })
    for (let x = -8; x <= 8; x++) {
      for (let z = -8; z <= 8; z++) { w.set(x, 63, z, 'stone'); w.set(x, 64, z, 'air'); w.set(x, 65, z, 'air') }
    }
    w.set(2, 63, 0, 'lava')
    w.set(-2, 63, 1, 'water')
    w.set(0, 63, 3, null)              // 未加载
    const b = mkBot({ pos: [0, 64, 0], world: w })
    const m = floorMapOf(b, { radius: 6 })
    ok(m.hazards.length === 3, 'hazards 里同时有岩浆/水/未加载（没有多余的深坑）', `n=${m.hazards.length}`)
    ok(m.hazards[0].kind === 'lava', '岩浆排第一（最危险）', JSON.stringify(m.hazards[0]))
    ok(m.hazards.every((h) => typeof h.x === 'number' && typeof h.z === 'number' && typeof h.d === 'number'),
      'hazards 每项都带真实坐标和距离')
    const lava = m.hazards.find((h) => h.kind === 'lava')
    ok(lava.x === 2 && lava.z === 0, 'hazards 里的坐标是**真实世界坐标**（不是行列号）', JSON.stringify(lava))
    ok(m.hazards.some((h) => h.kind === 'unloaded' && h.x === 0 && h.z === 3), '未加载也算危险格')
    ok(hazardCellsOf(m, { limit: 1 }).length === 1, 'limit 生效')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑨ 导航摘要（purpose=navigation / hazards）')

  {
    const w = mkWorld({ fill: 'air' })
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) w.set(x, 63, z, 'stone')
    w.set(3, 63, 3, 'lava')
    const b = mkBot({ pos: [0, 64, 0], world: w })
    const m = floorMapOf(b, { radius: 6 })
    ok(navSummaryOf(m, { purpose: 'overview' }).lines.length === 0, 'overview 不加摘要（维持现状、省 token）')
    const nav = navSummaryOf(m, { purpose: 'navigation', target: '10,63,4' })
    const txt = nav.lines.join('\n')
    ok(/10, ?63, ?4/.test(txt), 'navigation 摘要里带目标坐标')
    ok(/直线距离/.test(txt) && /方位/.test(txt), 'navigation 摘要里带距离和方位')
    ok(/mc_move|pathfinder/.test(txt), 'navigation 摘要里说清"路通不通要真走一次"（职责边界）')
    ok(/mc_scan/.test(txt), 'navigation 摘要里说清"动手前再 mc_scan 复核"')
    ok(nav.nearbyTargets.length === 1 && nav.nearbyTargets[0].x === 10, 'nearbyTargets 也带出来')
    ok(navSummaryOf(m, { purpose: 'navigation' }).lines.join('\n').includes('没给 target'),
      '不给 target 时如实说"想算方位就把坐标传进来"')
    const hz = navSummaryOf(m, { purpose: 'hazards' }).lines.join('\n')
    ok(/岩浆/.test(hz) && /3, 3/.test(hz), 'hazards 摘要点名岩浆并给坐标')
    const clean = mkWorld({ fill: 'stone' })
    ok(navSummaryOf(floorMapOf(mkBot({ pos: [0, 64, 0], world: clean }), { radius: 4 }), { purpose: 'hazards' })
      .lines.join('\n').includes('没有'), '没有危险时明确说"没有"（别让模型自己猜）')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑩ 竖列图（2026-10-15 用户需求："加一个竖向的，单格就行，让ai知道下面有没有空的方块"）')

  {
    ok(columnKindOf('stone') === 'solid', '石头 ⇒ 实心')
    ok(columnKindOf('air') === 'air', '空气 ⇒ 空腔')
    ok(columnKindOf('water') === 'water' && columnKindOf('lava') === 'lava', '水 / 岩浆分开')
    ok(columnKindOf('snow') === 'air' && columnKindOf('ladder') === 'air',
      '🔴 雪层 / 梯子 ⇒ **空腔**（`isAir` 会说它们"空"，可它们托不住你）')
    ok(columnKindOf(null) === 'unloaded', '读不到 ⇒ 未加载（**不是"空"**）')
  }
  {
    ok(JSON.stringify(parseXZ('2,-3')) === '{"x":2,"z":-3}', 'parseXZ 认 "x,z"（两个数）')
    ok(JSON.stringify(parseXZ('2,63,-3')) === '{"x":2,"z":-3}', 'parseXZ 认 "x,y,z"（取第 1、3 个数）')
    ok(parseXZ({ x: 1, z: 2 })?.x === 1 && parseXZ({ x: 1, z: 2 })?.z === 2, 'parseXZ 认对象')
    ok(parseXZ('乱写') === null && parseXZ(null) === null, '乱写 / 不给 ⇒ null')
  }
  {
    /* 机器人站在 **(3, 64, -2)**（故意不是 0,0）：脚下 y=63 草、62 土、61/60 石（4 格实心），
     * y=59..56 是 4 格空腔，再往下 y=55..40 全是石头。 */
    const w = mkWorld({ fill: 'air' })
    w.set(3, 63, -2, 'grass_block')
    w.set(3, 62, -2, 'dirt')
    w.set(3, 61, -2, 'stone')
    w.set(3, 60, -2, 'stone')
    for (let y = 59; y >= 56; y--) w.set(3, y, -2, 'air')
    for (let y = 55; y >= 40; y--) w.set(3, y, -2, 'stone')
    const b = mkBot({ pos: [3, 64, -2], world: w })
    const col = columnOf(b, { yBottom: -20 })

    ok(col.x === 3 && col.z === -2, '不给 x/z ⇒ 看机器人自己那一格（3, -2）')
    ok(col.feetY === 64, 'feetY = 脚站的那一层')
    /* 🔴 这条钉的是 `Number(null) === 0` 那个坑：写成 `Number.isFinite(Number(yTop))`
     *    会让"没传"变成"传了 0"，于是永远从 y=0 开始扫。 */
    ok(col.from === 63 && col.to === 44,
      '🔴 默认从**脚底那一格**（feetY-1 = 63）往下扫到 44 —— 不是从脚站的那格、更不是从 y=0', `${col.from}..${col.to}`)
    ok(col.solidRun === 4, '往下 4 格实心（63..60）', `solidRun=${col.solidRun}`)
    ok(col.firstGap?.y === 59 && col.firstGap?.to === 56 && col.firstGap?.thickness === 4,
      '第一处空腔 y=59..56、厚 4 格', JSON.stringify(col.firstGap))
    ok(col.firstGap?.below === 'stone', '空腔下面是石头')
    ok(col.gaps.length === 1, '这一段只探到一处空腔')
    ok(col.unloaded === 0 && col.complete === true, '这一段没有未加载')

    const t = columnText(col)
    ok(/脚底 y=64/.test(t) && /从 y=63 往下扫到 y=44/.test(t), '抬头写清脚底与扫描范围')
    ok(/# y=63\.\.60 实心 4 格/.test(t), '每段一行：`# y=a..b 实心 N 格`')
    ok(/脚底往下 \*\*4 格是实心\*\*/.test(t) && /y=59\.\.56 是 \*\*4 格空腔\*\*/.test(t),
      '🔴 摘要直接回答"几格实心、然后几格是空的"')
    ok(/挖到 y=60 再往下就会掉下去/.test(t), '🔴 给出"挖到哪一格就得停"')

    ok(columnOf(b, { x: -2, z: 5, yBottom: -20 }).x === -2, '给了 x/z 就用给的')
    ok(columnOf(b, { x: 0, z: 0, yBottom: -20 }).x === 0, '🔴 传 x=0 是"真的看 0"，不是"没传"')
  }
  {
    /* 脚底那一格就是空的 ⇒ 得明说"托不住"，别报成"放心挖" */
    const w = mkWorld({ fill: 'stone' })
    w.set(0, 63, 0, 'air')
    const col = columnOf(mkBot({ pos: [0, 64, 0], world: w }), { yBottom: -8 })
    ok(col.solidRun === 0 && col.firstGap?.y === 63, '脚底那格是空气 ⇒ solidRun = 0、第一处空腔就是它')
    ok(/托不住你/.test(columnText(col)) && /别往下挖/.test(columnText(col)), '摘要说"托不住你，别往下挖"')
  }
  {
    /* 全实心 + 深处未加载：不能拍胸脯说"放心挖" */
    const w = mkWorld({ fill: 'stone' })
    for (let y = 55; y >= 50; y--) w.set(0, y, 0, null)   // 未加载（不是空气）
    const col = columnOf(mkBot({ pos: [0, 64, 0], world: w }), { yBottom: -20 })
    ok(col.solidRun === 8 && col.unloaded === 6, '实心 8 格（63..56）、下面 6 格未加载',
      `solidRun=${col.solidRun} unloaded=${col.unloaded}`)
    ok(!col.firstGap, '未加载**不算空腔**（"不知道" ≠ "空的"）')
    const t = columnText(col)
    ok(/先停下再看一次/.test(t) && !/可以放心往下挖/.test(t),
      '🔴 深处有未加载 ⇒ 不许说"可以放心往下挖"')
  }
  {
    /* 未加载在**最上面**（脚底那格就没加载）：要说"没加载"，不能说成"托不住" */
    const w = mkWorld({ fill: 'stone' })
    w.set(0, 63, 0, null)
    const t = columnText(columnOf(mkBot({ pos: [0, 64, 0], world: w }), { yBottom: -8 }))
    ok(/没加载/.test(t) && !/托不住你/.test(t), '🔴 脚底未加载 ⇒ 说"没加载"，不能说"托不住你"（那是断言世界的样子）')
  }
  {
    /* 🔴 2026-10-15 用户问「如果是水和岩浆呢」——
     *    空腔 / 水 / 岩浆都"托不住你"，但后果差着量级：掉下去 vs 淹死/冲走 vs 烧死。
     *    原来三种情况共用一句"再往下就会掉下去"，把"掉进岩浆"说成了"掉下去" —— 危险量级说反了。 */
    const mk = (layers) => {
      const w = mkWorld({ fill: null })   // 区外一律未加载，断言只看脚底这一段
      for (const [y, n] of Object.entries(layers)) w.set(0, Number(y), 0, n)
      return columnOf(mkBot({ pos: [0, 64, 0], world: w }), { yBottom: -8 })
    }
    const AIR = mk({ 63: 'grass_block', 62: 'dirt', 61: 'stone', 60: 'air', 59: 'air', 58: 'stone' })
    const WAT = mk({ 63: 'grass_block', 62: 'dirt', 61: 'stone', 60: 'water', 59: 'water', 58: 'stone' })
    const LAV = mk({ 63: 'grass_block', 62: 'dirt', 61: 'stone', 60: 'lava', 59: 'stone' })
    const DEEP = mk({ 63: 'grass_block', 62: 'dirt', 61: 'air', 60: 'stone', 59: 'lava' })

    ok(AIR.firstGap?.kind === 'air' && WAT.firstGap?.kind === 'water' && LAV.firstGap?.kind === 'lava',
      'firstGap.kind 把空腔 / 水 / 岩浆分开')

    const ta = columnText(AIR); const tw = columnText(WAT); const tl = columnText(LAV)
    ok(/⚠️/.test(ta) && /挖到 y=61 再往下就会掉下去（落差 6 格）/.test(ta), '空腔 ⇒ ⚠️ + "掉下去"（带落差）')
    ok(/🌊/.test(tw) && /挖到 y=61 就\*\*挖进水\*\*了/.test(tw) && /水会灌下来/.test(tw),
      '🔴 水 ⇒ 🌊 + "挖进水、水会灌下来、可能被冲走或淹死"')
    ok(/🔥/.test(tl) && /挖到 y=61 就\*\*挖穿到岩浆\*\*了/.test(tl) && /掉进去会死，别挖/.test(tl),
      '🔴 岩浆 ⇒ 🔥 + "挖穿到岩浆、掉进去会死、别挖"')
    ok(!/就会掉下去/.test(tw) && !/就会掉下去/.test(tl),
      '🔴 水 / 岩浆**不许**共用"掉下去"那句（危险量级说反了）')

    /* hazards 字段：给 AI 一份能直接判的（不用去啃文案） */
    ok(WAT.hazards.water.length === 1 && WAT.hazards.water[0].y === 60 && WAT.hazards.water[0].to === 59
      && WAT.hazards.water[0].thickness === 2 && WAT.hazards.lava.length === 0, 'hazards.water 记了 y/到哪/几格',
      JSON.stringify(WAT.hazards))
    ok(LAV.hazards.lava.length === 1 && LAV.hazards.lava[0].y === 60 && LAV.hazards.water.length === 0,
      'hazards.lava 分开记')
    ok(AIR.hazards.lava.length === 0 && AIR.hazards.water.length === 0, '普通空腔不算 hazard')

    /* 第一处是普通空腔、更深处有岩浆 ⇒ 单独点名（只报第一处会漏掉真正致命的那个） */
    const td = columnText(DEEP)
    ok(/再往下还有 \*\*岩浆\*\*（y=59）/.test(td), '🔴 更深处有岩浆 ⇒ 单独提一行，别只报第一处空腔')
    ok(DEEP.hazards.lava.length === 1 && DEEP.hazards.lava[0].y === 59, 'DEEP 的岩浆记在 hazards.lava')

    /* 脚底那格本身就是液体：也要点名是什么，不能只说"托不住" */
    const FOOTW = mk({ 63: 'water', 62: 'water', 61: 'stone' })
    const FOOTL = mk({ 63: 'lava', 62: 'stone' })
    const tfw = columnText(FOOTW); const tfl = columnText(FOOTL)
    ok(FOOTW.solidRun === 0 && /🌊/.test(tfw) && /脚底那一格是 \*\*水\*\*/.test(tfw) && /水会灌下来/.test(tfw),
      '🔴 脚底是水 ⇒ 点名"水"，不是笼统的"托不住"')
    ok(FOOTL.solidRun === 0 && /🔥/.test(tfl) && /脚底那一格是 \*\*岩浆\*\*/.test(tfl) && /先挪一步，别在这上面挖/.test(tfl),
      '🔴 脚底是岩浆 ⇒ 点名"岩浆"+ 最重的措辞')
    const tfa = columnText(mk({ 63: 'air', 62: 'stone' }))
    ok(/⚠️/.test(tfa) && /脚底那一格是 \*\*空的\*\*/.test(tfa) && /别往下挖，先挪一步/.test(tfa),
      '脚底是空气 ⇒ 还是原来那句"别往下挖，先挪一步"')
  }
  {
    /* 🔴 2026-10-17 实机（用户报：「这个实际脚下是水」）——
     *    机器人在水坑里（脚那一格是水、人一直在游），竖列图却说
     *    「往下 24 格全是实心 —— **可以放心往下挖**」。
     *    下面那串 `runs` 扫的是 `feetY-1` **往下**，**不含机器人自己站的这一格** ⇒
     *    报告对"你现在处在什么环境里"一个字都没说。
     *    游戏里那个 AI 的思考记录紧接着就写「simplest: **dig down**! The column says y=59..36 all solid,
     *    no caves」—— 照着挖下去，水就灌进坑里了。 */
    const mk2 = (here, below = null) => {
      const w = mkWorld({ fill: 'stone' })   // 全实心 ⇒ unloaded=0、无空腔 ⇒ 走到"可以放心往下挖"那条
      w.set(0, 64, 0, here)                  // 机器人**自己站的这一格**（不在往下扫的范围里）
      for (const [y, n] of Object.entries(below ?? {})) w.set(0, Number(y), 0, n)
      return columnOf(mkBot({ pos: [0, 64, 0], world: w }), { yBottom: -8 })
    }
    const INW = mk2('water')
    const INL = mk2('lava')
    const INA = mk2('air')

    ok(INW.here?.kind === 'water' && INW.here?.y === 64,
      '🔴 here 报出"你自己站的这一格"是水（它不在下面那串 runs 里）', JSON.stringify(INW.here))
    ok(INA.here?.kind === 'air' && INL.here?.kind === 'lava', 'here 把空气 / 岩浆也分得清')

    const tw2 = columnText(INW); const tl2 = columnText(INL); const ta2 = columnText(INA)
    ok(/🌊 你现在\*\*这一格（y=64）是水\*\*/.test(tw2) && /泡在水里/.test(tw2),
      '🔴 人泡在水里 ⇒ 抬头先点名（不能只说"下面全是实心"）')
    ok(/你人泡在水里/.test(tw2) && !/可以放心往下挖/.test(tw2),
      '🔴 泡在水里时**不许**说"可以放心往下挖" —— 挖开水会灌进坑')
    ok(/🔥 你现在\*\*这一格（y=64）就是岩浆\*\*/.test(tl2) && !/可以放心往下挖/.test(tl2),
      '🔴 人在岩浆里 ⇒ 先让人出来，别说"放心挖"')
    ok(!/你现在/.test(ta2) && /可以放心往下挖/.test(ta2),
      '站在空气里 ⇒ 一个字都不多说，还是原来那句"可以放心往下挖"')

    /* 脚底那格也是水时，"水会灌下来"是句废话（人已经在泡了）—— 该说的是"你先出去" */
    const t1 = columnText(mk2('water', { 63: 'water' }))
    ok(/你自己就在水里/.test(t1) && !/水会灌下来/.test(t1),
      '🔴 脚底是水 + 人也在水里 ⇒ 说"先游出去"，不是"水会灌下来"')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑪ 头顶（2026-10-18 用户需求："map竖井模式加上头上有什么"）')

  {
    /* 站在 y=64 的竖井底：脚底 y=63 实心、自己 y=64 空气、脑袋 y=65 空气 ⇒ **头顶第一格是 y=66**。
     * `above` 必须从 `fy + 2` 起算 —— 从 `fy + 1` 起算的话，第一格永远是"自己的脑袋"，永远"实心"。 */
    const shaft = (cells = {}, up = null) => {
      const w = mkWorld({ fill: 'air' })
      w.set(0, 63, 0, 'stone')
      for (const [y, n] of Object.entries(cells)) w.set(0, Number(y), 0, n)
      return columnOf(mkBot({ pos: [0, 64, 0], world: w }), { yBottom: -4, up })
    }

    /* ① 默认值 / 坐标范围 */
    const OPEN = shaft()
    ok(OPEN.above?.from === 66 && OPEN.above?.to === 105 && OPEN.above?.layers.length === 40,
      '🔴 头顶从 y=66（脚 64 + 2）看到 y=105，默认 40 格', `${OPEN.above?.from}..${OPEN.above?.to}`)
    ok(OPEN.above.head?.y === 66 && OPEN.above.head?.kind === 'air', 'head = 头顶第一格（y=66）')
    ok(OPEN.layers[0].y === 63, '往下那一段还是从脚底 63 起（头顶没把下面挤掉）')
    ok(OPEN.above.ceiling === null && OPEN.above.headroom === 40 && OPEN.above.truncated === true,
      '头顶 40 格全空 ⇒ 没有天花板、headroom=40、truncated（只看到这里，不代表通天）')
    const tOpen = columnText(OPEN)
    ok(/头顶 40 格（y=66\.\.105）没有实心方块/.test(tOpen) && /能跳、也能垫脚往上/.test(tOpen),
      '🔴 头顶全空 ⇒ 明说"能跳、能垫脚往上"')
    ok(/再往上没扫/.test(tOpen) && !/通天/.test(tOpen.replace('不代表通天', '')),
      '🔴 没扫到上限之外 ⇒ 必须有"再往上没扫"的限定（不能装作看见天了）')
    ok(/头顶看 y=66\.\.105/.test(tOpen), '抬头也写清"头顶看到哪"')

    /* ② 头顶第一格就封死 ⇒ 跳不起来（PATHFINDER 那个"垫了也上不去"的原因） */
    const FLAT = shaft({ 66: 'jungle_planks' })
    ok(FLAT.above.ceiling?.y === 66 && FLAT.above.headroom === 0, '头顶那一格实心 ⇒ headroom=0')
    ok(FLAT.above.truncated === false, '碰到实心 ⇒ truncated=false（看见了，不是猜的）')
    const tFlat = columnText(FLAT)
    ok(/头顶那一格（y=66）就是 \*\*jungle_planks\*\*/.test(tFlat) && /跳不起来/.test(tFlat),
      '🔴 头顶封死 ⇒ 说"跳不起来"')
    ok(/别在原地试垫脚/.test(tFlat) && !/能跳/.test(tFlat),
      '🔴 还要说"别在原地试垫脚" —— 跳不起来时垫脚是件不可能的事')

    /* ③ 头顶空几格再封顶 ⇒ 能跳，但上面封住了 */
    const ROOM = shaft({ 70: 'stone' })
    ok(ROOM.above.headroom === 4 && ROOM.above.ceiling?.y === 70,
      '头顶空 4 格（66..69），y=70 封顶', JSON.stringify(ROOM.above.ceiling))
    const tRoom = columnText(ROOM)
    ok(/头顶连续 4 格没有实心（y=66\.\.69）/.test(tRoom) && /y=70 是 \*\*stone\*\*/.test(tRoom),
      '🔴 报"空几格 + 第几格封的、封的是什么"')
    ok(/能跳/.test(tRoom) && /想上去得挖开或垫脚/.test(tRoom), '🔴 能跳，但要告诉它上面得挖开才上得去')

    /* ④ up 参数：看几格是能调的，且**传小就只看到那儿** */
    const SHORT = shaft({ 80: 'stone' }, 3)
    ok(SHORT.above.to === 68 && SHORT.above.layers.length === 3, 'up=3 ⇒ 只看 y=66..68')
    ok(SHORT.above.ceiling === null, 'up=3 看不到 y=80 ⇒ 不能凭空报出天花板')
    ok(/头顶 3 格（y=66\.\.68）/.test(columnText(SHORT)), 'up=3 ⇒ 文案也只说 3 格')
    ok(shaft({}, 0).above.layers.length === 1, '🔴 up=0 ⇒ 至少看 1 格（不是"一格都不看"这种空报告）')
    ok(shaft({}, 999).above.layers.length === 96, 'up 超过 96 ⇒ 夹到 96（跟往下扫同一个上限）')

    /* ⑤ 未加载 = 不知道，不能说成"空"、也不能说成"能跳" */
    const UNL = shaft({ 66: null, 67: null, 68: null })
    ok(UNL.above.head?.kind === 'unloaded' && UNL.above.headroom === 0,
      '头顶第一格没加载 ⇒ headroom=0（停下，不替世界下结论）')
    ok(/头顶那一格（y=66）\*\*没加载\*\*/.test(columnText(UNL)) && !/能跳/.test(columnText(UNL)),
      '🔴 头顶没加载 ⇒ 说"没加载"，不许说"空"、更不许说"能跳"')
    const UNL2 = shaft({ 68: null }, 10)
    ok(UNL2.above.unloaded === 1 && UNL2.above.headroom === 2,
      '半路没加载 ⇒ unloaded 记 1、headroom 停在它前面（2 格）')
    ok(/其中有 1 格没加载/.test(columnText(UNL2)), '🔴 半路没加载 ⇒ 文案点名"其中有几格没加载"')

    /* ⑥ 头顶的水 / 岩浆：和"空腔"不是一回事 —— 从上面浇下来比往下掉更难救 */
    const WAT = shaft({ 66: 'water', 67: 'water', 70: 'stone' }, 10)
    ok(WAT.above.hazards.water.length === 1 && WAT.above.hazards.water[0].y === 66
      && WAT.above.hazards.water[0].to === 67 && WAT.above.hazards.lava.length === 0,
      'above.hazards.water 记了 y/到哪/几格', JSON.stringify(WAT.above.hazards))
    const tWat = columnText(WAT)
    ok(/🌊 头顶上方有\*\*水\*\*（y=66\.\.67，2 格）/.test(tWat), '🔴 头顶有水 ⇒ 单独一行点名')
    ok(/能跳/.test(tWat), '水不挡路 ⇒ 仍然"能跳"（别把水说成天花板）')
    const LAV = shaft({ 68: 'lava' }, 10)
    const tLav = columnText(LAV)
    ok(/🔥 头顶上方是\*\*岩浆\*\*（y=68，1 格）/.test(tLav) && /别往上挖/.test(tLav),
      '🔴 头顶是岩浆 ⇒ 最重的措辞"别往上挖"')
    ok(columnText(shaft({ 66: 'water' }, 4)).match(/🌊/) && !/头顶上方是\*\*岩浆\*\*/.test(columnText(shaft({ 66: 'water' }, 4))),
      '水不会被说成岩浆')

    /* ⑦ 结构不打架：上面那段和下面那段互不重叠 */
    const MIX = shaft({ 66: 'air', 67: 'stone' }, 4)
    ok(MIX.above.layers.every((l) => l.y >= 66) && MIX.layers.every((l) => l.y <= 63),
      '🔴 头顶（≥66）与脚底往下（≤63）两段不重叠 —— 自己那两格（64 脚 / 65 头）哪边都不算')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑤ 静态接线（core.mjs / index.js）')

  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const names = readFileSync(new URL('../src/block-names.mjs', import.meta.url), 'utf8')
  const mapSrc = readFileSync(new URL('../src/map-render.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const checks = [
    [names, /export const PASSABLE = /, 'block-names：有"能穿过去的小东西"名单（花草火把不算墙）'],
    [core, /from '\.\/block-names\.mjs'/, 'core：这些纯方块名判据改成从 block-names.mjs 导入（路线图第 ④ 条第二刀）'],
    [core, /from '\.\/map-render\.mjs'/, 'core：地图那一层改成从 map-render.mjs 导入（路线图第 ④ 条第十一刀）'],
    [core, /heightmap \(opts = \{\}\) \{ return heightmapOf\(this\.requireBot\((?:[^)]*)\), opts\) \}/, 'core：heightmap() 留成薄包装'],
    [core, /static glyphMap \(names, step = 2, selfIndex = null, opts = \{\}\) \{ return glyphMapText\(names, step, selfIndex, opts\) \}/, 'core：static glyphMap() 留成薄包装（opts 透传）'],
    [core, /mapImage \(opts = \{\}\) \{ return mapImageOf\(this\.requireBot\((?:[^)]*)\), opts\) \}/, 'core：mapImage() 留成薄包装'],
    [strip(idx), /mode: \{ type: 'string'/, 'index：mc_map 有 mode 参数'],
    [strip(idx), /const legendText = hm\.legend\.slice\(0, 8\)/, 'index：图例渲染抽成 legendText（只留前 8 种）'],
    [strip(idx), /e\?\.glyph \? `\$\{e\.glyph\}\$\{e\.name\}×\$\{e\.count\}`/, 'index：图例渲染认 glyph（地板层的图例带字形）'],
    /* ── 2026-10-23 晚（用户 m05002「map · surface 的输出怎么这么奇怪」）：字符图默认不压缩 ── */
    [mapSrc, /glyphMapText \(names, step = 2, selfIndex = null, \{ compress = false \} = \{\}\)/, 'map-render：glyphMapText 收 compress 开关，默认 false'],
    [mapSrc, /out\.push\(compress \? rleGlyphs\(line\) : line\)/, 'map-render：只有 compress 才走 RLE'],
    [strip(idx), /compress: \{ type: 'boolean'/, 'index：mc_map 有 compress 参数'],
    [strip(idx), /McBot\.glyphMap\(hm\.names, step, \{ x: hm\.radius, y: hm\.radius \}, \{ compress: args\.compress === true \}\)/, 'index：compress 真的传到 glyphMap'],
    /* ── 2026-10-15：地板层视图（用户需求）── */
    [names, /export const FLOOR_GLYPH = \{/, 'block-names：地板层字形表'],
    [names, /export const isSolidBlock = /, 'block-names：isSolidBlock（实心判据，与 isPassable 互补但不等价）'],
    [mapSrc, /export function floorMapOf \(b, \{ radius = 32, layer = null, depth = 4 \} = \{\}\)/, 'map-render：floorMapOf()（脚下方块那一层）'],
    [mapSrc, /export function gridToWorld \(row, col, map\)/, 'map-render：gridToWorld（行列 ⇒ 真实坐标）'],
    [mapSrc, /export function navSummaryOf \(map, \{ purpose = 'overview', target = null \} = \{\}\)/, 'map-render：navSummaryOf（purpose 摘要）'],
    [strip(idx), /purpose: \{ type: 'string'/, 'index：mc_map 有 purpose 参数'],
    [strip(idx), /floorMapOf\(sess\.bot\.requireBot\(\), \{ radius: args\.radius, layer: args\.layer, depth: args\.depth \}\)/, 'index：floor 模式走 floorMapOf'],
    [strip(idx), /navSummaryOf\(hm, \{ purpose, target: args\.target \}\)/, 'index：purpose 摘要接 navSummaryOf'],
    [strip(idx), /🪨 地板层图/, 'index：文案区分"地板层图"'],
  ]
  for (const [src, re, label] of checks) ok(re.test(src), label)
  ok(!/isUnderground|caveCell/.test(strip(core)), 'core：cave 相关的薄包装已删干净（2026-10-22 用户要求）')
  ok(!/isUnderground|caveCell|cave_void|cave_deep|CAVE_GLYPH|CAVE_LABEL/.test(strip(mapSrc) + strip(names)),
    'map-render / block-names：洞穴层视图彻底没了（没有 isUnderground / caveCell / cave_* / CAVE_* 残留）')
  ok(!/export \{[^}]*\} from '\.\/map-render\.mjs'/.test(core),
    'core：没有多写 re-export（公开面靠四个同名薄包装）')
  ok(!/hm\.legend\.slice\(0, 15\)\.join\(' '\)/.test(strip(idx)),
    '顺手修掉的老 bug：图例不再是 [object Object]（以前 legend 是对象却直接 join）')
  ok(/modeArg === 'surface' \|\| modeArg === 'column' \? modeArg : 'floor'/.test(strip(idx)),
    'index：mc_map 只认 floor / surface / column，其余（含 auto、cave）一律退回 floor')
  ok(!/modeArg === 'cave'|modeArg === 'auto'/.test(strip(idx)), 'index：mode 解析里已经没有 cave / auto 了')
  /* ⑩ 竖列图的接线（2026-10-15） */
  ok(/if \(mode === 'column'\) \{/.test(strip(idx)), 'index：mc_map 有 mode:"column" 分支')
  ok(/columnOf\(sess\.bot\.requireBot\(\), \{\s*x: tgt\?\.x \?\? null, z: tgt\?\.z \?\? null, yBottom: args\.yBottom, up: args\.up,/.test(strip(idx)),
    'index：column 分支直接调 map-render 的 columnOf（不经过 core 薄包装），并透传 `up`')
  ok(/parseXZ\(args\.target\)/.test(strip(idx)), 'index：column 用 target 定 x/z')
  ok(/text: columnText\(view\)/.test(strip(idx)), 'index：column 的 text 走 columnText()（view 带上 mine/surfaceY）')
  ok(/here: col\.here/.test(strip(idx)), 'index：column 分支把 here（你自己站的那一格）透传出去')
  ok(/const hereName = b\?\.blockAt\?\.\(new Vec3\(fx, fy, fz\)\)\?\.name \?\? null/.test(strip(mapSrc)),
    'map-render：columnOf 真的去读机器人自己那一格（here 不是编的）')
  ok(/"column"（竖列/.test(idx), 'index：mc_map 描述里写了 column 模式')
  /* ⑪ 头顶的接线（2026-10-18） */
  ok(/up: \{ type: 'number'/.test(strip(idx)), 'index：mc_map 有 `up` 参数（头顶看几格）')
  ok(/above: col\.above/.test(strip(idx)), 'index：column 分支把 above（头顶扫描）透传出去')
  ok(/头顶什么封着/.test(idx), 'index：mc_map 描述里写了"头顶什么封着/跳不跳得起来"')
  ok(/export const COLUMN_UP_DEFAULT = 40/.test(mapSrc), 'map-render：COLUMN_UP_DEFAULT = 40（头顶一次最多看 40 格）')
  ok(/export function columnOf \(b, \{ x = null, z = null, yTop = null, yBottom = -24, maxDepth = COLUMN_MAX, up = null, anchorY = null \} = \{\}\) \{/.test(mapSrc),
    'map-render：columnOf(b, {x,z,yTop,yBottom,maxDepth,up,anchorY})')
  ok(/const headFrom = fy \+ 2/.test(strip(mapSrc)),
    '🔴 map-render：头顶从 `fy + 2` 起算 —— `fy` 是脚、`fy + 1` 是脑袋，从 fy+1 起算就自己的头算成方块了')
  ok(/export function columnText \(col\) \{/.test(mapSrc), 'map-render：columnText(col)')
  ok(/const given = \(v\) => v !== null && v !== undefined && v !== '' && Number\.isFinite\(Number\(v\)\)/.test(mapSrc),
    '🔴 map-render：columnOf 里判"传没传"必须用 `given()` 先挡 null —— `Number(null) === 0` 会让"没传"变成"传了 0"')
  {
  /* ═══════════════════════════════════════════════════════════════════════════
   * ⑳ 查**别的列**：那一列的地表在 y 几（2026-10-23 用户 m00855
   *    「现在为什么不知道 y 轴，不是有 map 的竖轴吗」）
   *
   * 竖列图原来只回答"我这一层上下那一列是什么"（窗口钉死在我的脚上），
   * 远处目的地那一列的地表在几米，它说不了 —— 而"该给哪个 y"正是跑远路时最缺的那一个数。
   * ═══════════════════════════════════════════════════════════════════════════ */
  section('⑳ 查别的列：那一列的地表 y（2026-10-23 用户 m00855）')

  const w = mkWorld({ fill: 'air', cells: { '5,63,7': 'stone', '5,64,7': 'grass_block' } })
  const b = mkBot({ pos: [0, 64, 0], world: w })

  const sf = surfaceYOf(b, { x: 5, z: 7 })
  ok(sf.loaded === true, '加载了的列 ⇒ loaded:true', JSON.stringify(sf))
  ok(sf.y === 64 && sf.name === 'grass_block', '地表 = 自上而下第一个非空气方块（y=64 草方块）', JSON.stringify(sf))
  ok(surfaceYOf(b, { x: 0, z: 0 }).y === null && surfaceYOf(b, { x: 0, z: 0 }).loaded === true,
    '整根都是空气 ⇒ 没有地表但"读到了"（是虚空，不是没加载）')

  const col = columnOf(b, { x: 5, z: 7, anchorY: sf.y + 1, yBottom: -4 })
  ok(col.feetY === 65, 'anchorY 决定"脚"在哪（= 地表上面那一格）', String(col.feetY))
  ok(col.from === 64, '🔴 往下扫**从那一列的地表那一格开始**（不是我脚底下）', String(col.from))
  ok(col.solidRun >= 2, '那一列地表下面连续实心', String(col.solidRun))
  ok(col.anchorY === 65, '结果里带着 anchorY（上层能分清"这是谁的列"）')

  const view = { ...col, mine: false, surfaceY: sf.y }
  const t = columnText(view)
  ok(/地表在 y=64/.test(t), '别的列直接报"地表在 y=64"')
  ok(!/脚底 y=/.test(t), '🔴 别的列不许说"脚底"——那不是你的脚')
  ok(/mc_move \{x: 5, y: 65, z: 7\}/.test(t), '顺手给出"该给哪个 y"：地表上面那一格')

  /* 我自己的列：一个字都不能变（还是"脚底"那套） */
  const mineCol = columnOf(b, { x: 0, z: 0, yBottom: -8 })
  const tm = columnText({ ...mineCol, mine: true, surfaceY: null })
  ok(/脚底 y=64/.test(tm), '自己的列照旧说"脚底 y=…"（老行为不动）')

  /* 未加载：地表**不知道**，不能说成 y=0 或"没有地面" */
  const wUn = mkWorld({ fill: null })
  const sfUn = surfaceYOf(mkBot({ pos: [0, 64, 0], world: wUn }), { x: 40, z: 40 })
  ok(sfUn.loaded === false && sfUn.y === null, '🔴 区块没加载 ⇒ loaded:false、y 是 null（不知道，不是没有）', JSON.stringify(sfUn))

  /* 🔴 世界外 ≠ 没加载：1.18+ 的世界是 -64..319，y=320 起 `blockAt` 也返回 null。
   *    照 320 起扫就会被误判成"区块没加载"，把明明查得到的列报成"读不到"。 */
  const inner = mkBot({ pos: [0, 64, 0], world: mkWorld({ fill: 'air', cells: { '0,63,0': 'stone' } }) })
  const bEdge = {
    entity: inner.entity,
    game: { minY: -64, height: 384 },
    blockAt (v) { return v.y > 319 ? null : inner.blockAt(v) },
  }
  const sfEdge = surfaceYOf(bEdge, { x: 0, z: 0 })
  ok(sfEdge.loaded === true && sfEdge.y === 63, '🔴 世界外的高度（y>319）不算"没加载"：照样读到 y=63 的石头', JSON.stringify(sfEdge))

  /* 工具面 + 线上接线 */
  const idxRaw = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  /* 只去掉注释（和上面 `strip` 同一套规则，但这里作用域不同，得自己来一份） */
  const idx2 = idxRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  ok(/surfaceYOf/.test(idx2), 'index：真的用了 surfaceYOf（不是只在 import 里挂着）')
  ok(/anchorY: sf \? sf\.y \+ 1 : null/.test(idx2), 'index：查到地表就把窗口锚到那一列')
  ok(/还没加载/.test(idx2) && /别猜 y/.test(idx2), 'index：没加载时明说"别猜 y"')
  ok(/surfaceY: sf\.y/.test(idx2), 'index：结果里报 surfaceY')
  ok(/竖列可以查\*\*任意一列\*\*/.test(idxRaw), 'index：mc_map 描述里写了"竖列能查任意一列/报地表 y"')
  }
  /* ── 2026-10-23 晚（用户 m05002「map · surface 的输出怎么这么奇怪」）──
   * 整行同字符被压成 X*n ⇒ 一行看不出任何形状。默认不压了，只有 compress:true 才压。 */
  section('㉑ 字符图默认不压缩（整行同字符不许变成压缩串）')
  {
    const names = [
      ['grass_block', 'grass_block', 'grass_block', 'grass_block', 'grass_block', 'grass_block'],
      ['grass_block', 'stone', 'grass_block', 'stone', 'grass_block', 'stone'],
    ]
    const plain = glyphMapText(names, 1, null).split('\n')
    ok(!plain[0].includes('*'), `默认不给压缩串（第一行：${JSON.stringify(plain[0])}）`)
    ok(plain[0].length === 6, `默认一行 6 格就是 6 个字符（实际 ${plain[0].length}）`)
    ok(glyphMapText(names, 1, null, {}).split('\n')[0].length === 6, '传空对象也不压')
    const zip = glyphMapText(names, 1, null, { compress: true }).split('\n')
    ok(zip[0].includes('*6'), `compress:true 才压（第一行：${JSON.stringify(zip[0])}）`)
    ok(zip[0].length < plain[0].length, '压缩确实变短了（6 格 → 3 字符）')
  }
} finally {
  for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log(`\n────────────────────────────────────────────────────────────`)
console.log(`check-core-map：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
