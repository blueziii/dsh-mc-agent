#!/usr/bin/env node
/**
 * 导航 P2 地形分类 + 路径评分自检 —— `src/terrain.mjs`
 *
 * 用户 2026-10-15 的导航方案（m02868）里点名的第 5 行：
 *   「**地形分类与路径评分** —— 能根据**台阶、落差和危险地形**选策略」
 * 以及"不要用一种搭路方式应付所有地形"、`P2` 的验收标准就是那一句。
 *
 * 这一套钉死五件事：
 *   ① **分类只看方块名**（不依赖 `boundingBox` / 注册表）—— 假世界就能测；
 *   ② **优先级从最要命的往下**：危险 > 沟 > 落差 > 台阶 > 窄道 > 平地，
 *      一个台阶不会把整片平地判成"台阶地形"（有最少证据量）；
 *   ③ **判不出来就说 `unknown`**（区块没加载 / 没 bot / 没坐标）—— 不硬猜；
 *   ④ **用户显式配置永远赢**（`walkMaxDropDown` 之类设过就盖过地形档案，`over` 记下来）；
 *   ⑤ **接线**：`movement.mjs` 每次走路前分类一次，`plugins.mjs` 按类调权重。
 *
 * 用法：node tools/check-terrain.mjs
 */
import { readFileSync } from 'node:fs'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const {
  TERRAIN_RADIUS, TERRAIN_UP, TERRAIN_DOWN, TERRAIN_TEXT,
  TERRAIN_PROFILES, TERRAIN_CFG_KEYS, TERRAIN_CACHE_MS,
  columnAt, columnGlyph, classifyTerrain, classifyTerrainCached,
  terrainCacheStats, profileFor, applyProfile,
} = await import(new URL('../src/terrain.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/* ── 假世界：显式方块表；表里没有但在"已加载区"内 ⇒ air；区外 ⇒ null（未加载） ── */
const REGION = { x0: -40, x1: 40, y0: 0, y1: 160, z0: -40, z1: 40 }
function mkWorld () {
  const map = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const inRegion = (x, y, z) => x >= REGION.x0 && x <= REGION.x1 && y >= REGION.y0 && y <= REGION.y1 && z >= REGION.z0 && z <= REGION.z1
  const w = {
    map,
    set (x, y, z, name) { map.set(key(x, y, z), name); return w },
    del (x, y, z) { map.delete(key(x, y, z)); return w },
    /** 铺一块实心地板 */
    plate (x0, z0, x1, z1, y, name = 'stone') {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) w.set(x, y, z, name)
      }
      return w
    },
    /** 一根实心柱子（从 y0 到 y1 都是 name） */
    pillar (x, z, y0, y1, name = 'stone') {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) w.set(x, y, z, name)
      return w
    },
    blockAt (p) {
      if (!inRegion(p.x, p.y, p.z)) return null
      const n = map.get(key(p.x, p.y, p.z)) ?? 'air'
      return { name: n, position: new Vec3(p.x, p.y, p.z) }
    },
  }
  return w
}
const mkBot = (world, pos) => ({
  entity: { position: new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5), onGround: true },
  blockAt: (p) => world.blockAt(p),
})
/** 平地场景：脚站在 y=64，地板面在 y=63，**下面还有 8 层实心**（不然挖个坑就"没有底"了） */
const flatScene = (feet = { x: 0, y: 64, z: 0 }) => {
  const w = mkWorld()
  for (let y = 55; y <= 63; y++) w.plate(-8, -8, 8, 8, y)
  return { w, b: mkBot(w, feet) }
}
/** 在 (x,z) 那一列挖一个**深到没有落脚点**的竖井（窗口是 60..67） */
const shaft = (w, x, z) => { for (let y = 40; y <= 67; y++) w.del(x, y, z); return w }

/* ═══════════════ ① columnAt ═══════════════ */
section('① columnAt：一根柱子能不能站、是不是缺口/墙')
{
  const { w, b } = flatScene()
  const c = columnAt(b, 1, 1, 64)
  ok(c.y === 64 && !c.gap && !c.wall && !c.unloaded, '平地：能站的那一层就是自己那一层', JSON.stringify(c))
  ok(c.hazard === null && c.wet === false, '平地：没有危险也没有水')
  ok(columnAt(b, 1, 1, 65).y === 64, '从高一格看同一根柱子 ⇒ 还是找到 y=64（往下找到的）')
  ok(columnAt(b, 1, 1, 62).y === 64, '从低两格看 ⇒ 找的是**上面**能站的那一层（往上找优先）')

  // 缺口：挖一个深到没有落脚点的竖井
  const { w: w2, b: b2 } = flatScene()
  shaft(w2, 1, 1)
  const g = columnAt(b2, 1, 1, 64)
  ok(g.y === null && g.gap === true && g.wall === false, '整根找不到落脚点、自己那层是空气 ⇒ gap', JSON.stringify(g))

  // 墙：自己那一层就是实心
  const { w: w3, b: b3 } = flatScene()
  w3.pillar(1, 1, 58, 66)
  const wall = columnAt(b3, 1, 1, 64)
  ok(wall.y === null && wall.wall === true && wall.gap === false, '自己那一层是实心 ⇒ wall（不是缺口）', JSON.stringify(wall))

  // 未加载
  const { b: b4 } = flatScene()
  const un = columnAt(b4, 999, 999, 64)
  ok(un.y === null && un.unloaded === true && un.gap === false && un.wall === false, '区外 ⇒ unloaded（不当成缺口）', JSON.stringify(un))

  // 危险 / 水
  const { w: w5, b: b5 } = flatScene()
  w5.set(1, 63, 1, 'lava')
  ok(columnAt(b5, 1, 1, 64).hazard === 'lava', '地板是岩浆 ⇒ hazard 是 lava')
  const { w: w6, b: b6 } = flatScene()
  w6.set(1, 63, 1, 'water')
  ok(columnAt(b6, 1, 1, 64).wet === true && columnAt(b6, 1, 1, 64).hazard === null, '水 ⇒ wet（不是 hazard）')

  // 窗外的危险不报（只在自己上下 up+1..down 的窗口里找）
  const { w: w7, b: b7 } = flatScene()
  w7.set(1, 40, 1, 'lava')
  ok(columnAt(b7, 1, 1, 64).hazard === null, '窗口外的岩浆不算（只看脚边这几格）')
  ok(TERRAIN_UP === 2 && TERRAIN_DOWN === 4, '窗口是上 2 下 4（跟常量一致）')
}

/* ═══════════════ ② columnGlyph ═══════════════ */
section('② columnGlyph：一眼能扫的地形字符')
{
  ok(columnGlyph({ unloaded: true }) === '?', '没加载 ⇒ ?')
  ok(columnGlyph({ hazard: 'lava' }) === '!', '危险 ⇒ !')
  ok(columnGlyph({ wet: true }) === '~', '水 ⇒ ~')
  ok(columnGlyph({ wall: true }) === '#', '墙 ⇒ #')
  ok(columnGlyph({ gap: true }) === '_', '缺口 ⇒ _')
  ok(columnGlyph({ y: 64 }) === '.', '能站 ⇒ .')
  ok(columnGlyph({ hazard: 'lava', gap: true }) === '!', '危险优先于缺口')
}

/* ═══════════════ ③ classifyTerrain ═══════════════ */
section('③ classifyTerrain：六类 + 优先级 + 最少证据量')
{
  const flat = classifyTerrain(flatScene().b)
  ok(flat.kind === 'flat', '一片平地 ⇒ flat', flat.kind)
  ok(flat.columns > 0 && flat.unloaded === 0 && flat.hazards === 0, '平地：柱子都量到了、没有危险', JSON.stringify(flat))
  ok(flat.worstDrop === 0 && flat.maxStep === 0 && flat.ups === 0 && flat.downs === 0, '平地：没有任何高差')
  ok(TERRAIN_TEXT.flat === '平地' && !!TERRAIN_PROFILES.flat, 'flat 在种类表里且有人话名字')
  ok(String(flat.glyph).includes('@'), '俯视图里标出了自己站的那一格 @')
  ok(String(flat.glyph).split('\n').length === TERRAIN_RADIUS * 2 + 1, '俯视图是 (2r+1) 行', String(String(flat.glyph).split('\n').length))

  // 台阶：一格高的台阶**不算**（最少证据量 3）
  const s1 = (() => {
    const { w, b } = flatScene()
    w.pillar(1, 0, 64, 64)          // 一格高
    return classifyTerrain(b)
  })()
  ok(s1.kind === 'flat', '只有一格台阶 ⇒ 还是 flat（不会被一格带偏）', `${s1.kind} ups=${s1.ups} maxStep=${s1.maxStep}`)

  const s2 = (() => {
    const { w, b } = flatScene()
    w.pillar(1, 0, 64, 64)
    w.pillar(2, 0, 64, 64)
    w.pillar(3, 0, 64, 64)
    return classifyTerrain(b)
  })()
  ok(s2.kind === 'steps', '三格一高的台阶 ⇒ steps', `${s2.kind} ups=${s2.ups}`)

  const s3 = (() => {
    const { w, b } = flatScene()
    w.pillar(1, 0, 64, 65)          // 两格高（一步 ≥2）
    return classifyTerrain(b)
  })()
  ok(s3.kind === 'steps' && s3.maxStep === 2, '一个两格高的台阶 ⇒ steps（最高一步 ≥2）', `${s3.kind} maxStep=${s3.maxStep}`)

  // 落差：往下 3 格
  const d1 = (() => {
    const { w, b } = flatScene()
    for (let y = 61; y <= 63; y++) w.del(1, y, 0)   // 地板面从 63 掉到 60
    return classifyTerrain(b)
  })()
  ok(d1.kind === 'drops' && d1.worstDrop === -3, '一个三格深的坑 ⇒ drops', `${d1.kind} worstDrop=${d1.worstDrop}`)

  const d2 = (() => {
    const { w, b } = flatScene()
    for (const dx of [1, 2, 3]) w.del(dx, 63, 0)     // 三处各往下 1 格
    return classifyTerrain(b)
  })()
  ok(d2.kind === 'drops' && d2.downs >= 3, '三处各往下 1 格 ⇒ drops（数量够）', `${d2.kind} downs=${d2.downs}`)

  // 沟：整根没有落脚点
  const g1 = (() => {
    const { w, b } = flatScene()
    shaft(w, 1, 0); shaft(w, 2, 0)
    return classifyTerrain(b)
  })()
  ok(g1.kind === 'gap' && g1.gaps === 2, '两处深竖井 ⇒ gap', `${g1.kind} gaps=${g1.gaps}`)

  const g2 = (() => {
    const { w, b } = flatScene()
    shaft(w, 1, 0)
    return classifyTerrain(b)
  })()
  ok(g2.kind === 'gap' && g2.gaps === 1, '一个深竖井也算 gap（缺一个洞就能掉下去）', g2.kind)

  // 危险：优先级最高
  const h1 = (() => {
    const { w, b } = flatScene()
    w.set(1, 63, 1, 'lava')
    shaft(w, 2, 0); shaft(w, 3, 0)
    w.pillar(4, 0, 64, 65)
    return classifyTerrain(b)
  })()
  ok(h1.kind === 'hazard' && h1.hazards === 1, '岩浆 + 缺口 + 台阶 ⇒ hazard 赢（最要命的最先报）', h1.kind)

  const h2 = (() => {
    const { w, b } = flatScene()
    w.set(1, 63, 1, 'cactus')
    return classifyTerrain(b)
  })()
  ok(h2.kind === 'hazard', '仙人掌也算危险地形', h2.kind)

  // 窄道：半径 1，一半以上是墙
  const n1 = (() => {
    const { w, b } = flatScene()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) w.pillar(dx, dz, 58, 66)
    return classifyTerrain(b, { radius: 1 })
  })()
  ok(n1.kind === 'narrow' && n1.walls >= 4, '半径 1 里四面都是墙 ⇒ narrow', `${n1.kind} walls=${n1.walls}`)

  // unknown
  const u1 = classifyTerrain({ blockAt: () => null, entity: { position: new Vec3(0.5, 64, 0.5) } })
  ok(u1.kind === 'unknown' && u1.columns === 0, '整圈都读不到 ⇒ unknown（不硬猜）', `${u1.kind} ${u1.note}`)
  ok(classifyTerrain(null).kind === 'unknown', '没有 bot ⇒ unknown')
  ok(classifyTerrain({ blockAt: () => null }).kind === 'unknown', '没有坐标 ⇒ unknown')
  ok(classifyTerrain({ blockAt: () => { throw new Error('boom') }, entity: { position: new Vec3(0.5, 64, 0.5) } }).kind === 'unknown', 'blockAt 抛错 ⇒ unknown（不炸）')

  // 传 feet 就不用读 entity
  const f2 = classifyTerrain({ blockAt: flatScene().w.blockAt }, { feet: { x: 0, y: 64, z: 0 } })
  ok(f2.kind === 'flat' && f2.columns > 0, '可以直接传 feet（不用 entity）', f2.kind)

  ok(classifyTerrain(flatScene().b).columns === (TERRAIN_RADIUS * 2 + 1) ** 2 - 1, '柱子数 = (2r+1)² − 自己那一格', String(classifyTerrain(flatScene().b).columns))
}

/* ═══════════════ ④ profileFor ═══════════════ */
section('④ profileFor：每一类一套权重，用户配置优先')
{
  const flat = profileFor('flat')
  ok(flat.cost.maxDropDown === 3 && flat.cost.digCost === 4 && flat.cost.placeCost === 12 && flat.cost.liquidCost === 4,
    'flat = 改动前那套全局值（3/4/4/12）', JSON.stringify(flat.cost))
  ok(flat.cost.allowParkour === false, 'flat：跳远默认关')
/* 🔴 2026-10-30 用户：「智能规划路线，不要兜底」—— 以前 8 档全关，柱林/断崖之间
 *   A* 必然 NoPath（只能靠兜底一格一格试）。现在只给"本来就过不去"的三档开：
 *   跑酷边要求落点实心 + 上方两格净空（vendor `getMoveParkourForward` 自己查），
 *   再加 `parkourPenalty`（默认 4）⇒ 只有"省下的路 > 4 步"时才选。 */
for (const kind of ['drops', 'gap', 'narrow']) {
  ok(profileFor(kind, {}).cost.allowParkour === true, `${kind}：开跑酷（跨 1~2 格空隙 = 真能过）`, String(profileFor(kind, {}).cost.allowParkour))
}
for (const kind of ['flat', 'steps', 'hazard', 'unknown']) {
  ok(profileFor(kind, {}).cost.allowParkour === false, `${kind}：仍然关（平地跳没意义 / 台阶、危险地形摔不起）`, String(profileFor(kind, {}).cost.allowParkour))
}
ok(profileFor('gap', { walkAllowParkour: false }).cost.allowParkour === false, '用户显式 walkAllowParkour:false ⇒ 听用户的（档案盖不过）')
  ok(flat.over.length === 0, '没配 cfg ⇒ 没有任何覆盖')
  ok(profileFor('flat').cost.maxDropDown === TERRAIN_PROFILES.flat.maxDropDown, 'cost 跟 TERRAIN_PROFILES 一致')

  ok(profileFor('hazard').cost.maxDropDown === 1, '危险地形：一格都不许往下跳')
  ok(profileFor('hazard').cost.liquidCost > profileFor('flat').cost.liquidCost, '危险地形：更不想下水')
  ok(profileFor('gap').cost.placeCost < profileFor('flat').cost.placeCost, '沟边：垫方块比平地便宜（这地方就是要垫/搭）')
  ok(profileFor('gap').cost.placeCost >= profileFor('gap').cost.digCost,
    '🔴 沟边垫方块不许比挖一格还便宜（2026-10-17 实机：垫柱子时放置被拒，人在半空掉了 21 格）')
  ok(profileFor('steps').cost.digCost < profileFor('flat').cost.digCost, '台阶：挖穿比绕远便宜')
  ok(profileFor('drops').cost.maxDropDown < profileFor('flat').cost.maxDropDown, '落差：允许往下跳的格数收窄')
  ok(profileFor('narrow').cost.digCost > profileFor('flat').cost.digCost, '窄道：挖更贵（挖了容易把自己埋了）')
  for (const k of Object.keys(TERRAIN_PROFILES)) ok(profileFor(k).kind === k, `${k} 有自己的一套档案`)

  ok(profileFor('胡说八道').kind === 'unknown', '不认识的类名 ⇒ 退回 unknown')
  ok(typeof TERRAIN_PROFILES.unknown === 'object' && TERRAIN_PROFILES.unknown !== null,
    '不认识的类名那套档案在（`TERRAIN_DEFAULTS` 2026-10-20 精简时删了：它就是 `TERRAIN_PROFILES.unknown` 的别名）')

  // 用户配置优先
  const o1 = profileFor('hazard', { walkMaxDropDown: 8 })
  ok(o1.cost.maxDropDown === 8, '🔴 用户设了 walkMaxDropDown=8 ⇒ 盖过危险地形的 1', String(o1.cost.maxDropDown))
  ok(o1.over.some((s) => s.includes('walkMaxDropDown')), 'over 里记下是谁盖的', JSON.stringify(o1.over))
  ok(profileFor('hazard', { walkLiquidCost: 2 }).cost.liquidCost === 2, '用户设了 walkLiquidCost ⇒ 盖过危险地形的 20')
  ok(profileFor('flat', { walkAllowParkour: true }).cost.allowParkour === true, '用户开了跳远 ⇒ 开着')
  ok(profileFor('flat', { walkAllowParkour: 'yes' }).cost.allowParkour === false, '跳远只认严格的 true（"yes" 不算）')
  ok(profileFor('flat', { walkDigCost: 'abc' }).cost.digCost === 4, 'cfg 给的不是数 ⇒ 不覆盖（不把权重弄成 NaN）')
  ok(profileFor('flat', { walkMaxDropDown: null }).cost.maxDropDown === 3, 'cfg 是 null ⇒ 不算设过')
  ok(Object.keys(TERRAIN_CFG_KEYS).length === 5, '5 个可覆盖字段都登记了配置键', JSON.stringify(TERRAIN_CFG_KEYS))
}

/* ═══════════════ ⑤ applyProfile ═══════════════ */
section('⑤ applyProfile：写到真的 Movements 上')
{
  const mv = { maxDropDown: 4, liquidCost: 1, digCost: 1, placeCost: 1, allowParkour: true }
  const changed = applyProfile(mv, profileFor('flat'))
  ok(mv.maxDropDown === 3 && mv.digCost === 4 && mv.placeCost === 12 && mv.liquidCost === 4, '权重真的写进去了', JSON.stringify(mv))
  ok(mv.allowParkour === false, '跳远也被关掉了')
  ok(changed.length === 5, '5 个字段都变了 ⇒ changed 5 条', JSON.stringify(changed))
  ok(changed.every((s) => s.includes('=')), 'changed 里是 "字段=值" 的样子', JSON.stringify(changed))

  const mv2 = { maxDropDown: 3, liquidCost: 4, digCost: 4, placeCost: 12, allowParkour: false }
  ok(applyProfile(mv2, profileFor('flat')).length === 0, '值本来就对 ⇒ 不算改动（changed 空）')

  ok(applyProfile(null, profileFor('flat')).length === 0, '没有 mv ⇒ 空数组，不炸')
  ok(applyProfile({}, null).length === 0, '没有档案 ⇒ 空数组，不炸')
  const odd = Object.freeze({})
  let threw = false
  try { applyProfile(odd, profileFor('flat')) } catch { threw = true }
  ok(!threw, '写不进去的对象（冻结）⇒ 跳过，不抛错')
}

/* ═══════════════ ⑥ 静态接线 ═══════════════ */
section('⑥ 静态接线')
{
  const terrain = read('../src/terrain.mjs')
  const plugins = read('../src/plugins.mjs')
  const core = read('../src/core.mjs')
  const movement = read('../src/movement.mjs')

  ok(!/from '\.\/core\.mjs'/.test(terrain), '🔴 terrain.mjs 不反向 import core.mjs（不然循环导入）')
  ok(!/from 'mineflayer'|from 'prismarine/.test(terrain), '🔴 terrain.mjs 不 import 游戏运行时（只用 vec3 + 方块名）')
  ok(/from '\.\/block-names\.mjs'/.test(terrain), 'terrain.mjs 用 block-names 的判据')
  ok(/from '\.\/bridge\.mjs'/.test(terrain), 'terrain.mjs 复用 bridge 的危险方块名单')
  ok(/const at = \(yy\) => \{ try \{ return b\.blockAt/.test(terrain), 'blockAt 包了 try（假 bot / 空世界不炸）')

  ok(/export function movements \(self, \{ terrain = null/.test(plugins), '🔴 plugins.mjs 的 movements 收地形参数')
  ok(/profileFor\(terrain\?\.kind \?\? 'unknown', self\.cfg\)/.test(plugins), '按地形 + cfg 取档案')
  ok(/applyProfile\(mv, profile\)/.test(plugins), '档案落到 Movements 上')
  ok(/export function adaptMovements \(self, \{ feet = null, radius = null \} = \{\}\)/.test(plugins), 'adaptMovements 是"地形变了就换策略"的入口')
  ok(/b\.pathfinder\.setMovements\(mv\)/.test(plugins), 'adaptMovements 真的重挂了一份')
  ok(/classifyTerrainCached\(b, \{ feet/.test(plugins), 'adaptMovements 自己也会分类（走缓存版）')

  ok(/#movements \(terrain = null[^)]*\) \{ return movements\(this, \{ terrain/.test(core), '🔴 core.mjs 的 #movements 把地形透下去')
  ok(/movements: \(terrain, opts\) => this\.#movements\(terrain, opts\)/.test(core), '🔴 pathCtx 把地形参数透下去')

  ok(/let terrain = classifyTerrainCached\(b\)/.test(movement), '🔴 movement.mjs 每次走路前分类一次（走缓存版；`let` 是为了脱困后局部重估）')
  ok(/const fresh = classifyTerrainCached\(b\)[\s\S]{0,400}?terrain = fresh/.test(movement),
    '🔴 脱困后按新地形重估一次（不再拿出发时的旧判断走到底）')
  ok(movement.indexOf('const terrain = classifyTerrainCached(b)') < movement.indexOf('ctx.movements(terrain'), '分类发生在取 Movements 之前')
  ok(/const mv = ctx\.movements\(terrain, \{ digFirst \}\)/.test(movement), '把分类结果交给 ctx.movements')
  ok(/\[opts\.arrived \? 'terrainAtStart' : 'terrain'\]: terrain\.kind \}/.test(movement), '返回值里带上地形（平地/未知时不报）')
  ok(/const arrivedTerrain = \(\) => \{[\s\S]{0,80}?classifyTerrainCached\(b\)/.test(movement), '🔴 到达时重算落点地形（出发时那份会写着 gap，属主动误导）')
  ok(/\.\.\.moveInfo\(\{ arrived: true \}\), \.\.\.arrivedTerrain\(\),/.test(movement), '到达分支用 terrainAtStart + arrivedTerrain 这一对')
  ok(/arrivedNote: now\.note/.test(movement), '落点地形带一句说明')
  ok(/脚边是\$\{terrain\.text\}/.test(movement), '不是平地时日志里说一句（模型/人看得见）')
  ok(/!preempted && terrain\.kind === 'gap'/.test(movement), '走不通时按地形给不同的下一步（沟 → mc_act{mode:"bridge"}）')
  ok(/!preempted && terrain\.kind === 'hazard'/.test(movement), '危险地形单独说一句"别从这边走"')

  const index = read('../index.js')
  ok(/import \{ terrainCacheStats \} from '\.\/src\/terrain\.mjs'/.test(index), 'index.js 引了 terrainCacheStats')
  ok(/const terrainCache = terrainCacheStats\(sess\.bot\.bot\)/.test(index), 'mc_diag 里读导航缓存的账')
  ok([...index.matchAll(/terrainCache,/g)].length >= 2, '在线/离线两个 return 都带上它', String([...index.matchAll(/terrainCache,/g)].length))

  const order = read('./check-all.mjs')
  ok(/check-terrain\.mjs/.test(order), '✅ check-all.mjs 的 ORDER 里登记了这一套')
}

/* ═══════════════ ⑧ 导航缓存：同样的答案不重算 ═══════════════ */
section('⑧ 导航缓存：没挪窝、世界没变 ⇒ 不重扫')
{
  const mkEmitter = () => {
    const ls = new Map()
    return {
      on (ev, fn) { if (!ls.has(ev)) ls.set(ev, []); ls.get(ev).push(fn); return this },
      fire (ev, ...a) { for (const fn of ls.get(ev) ?? []) fn(...a) },
    }
  }
  const scene = () => {
    const { w } = flatScene()
    const em = mkEmitter()
    const bot = mkBot(w, { x: 0, y: 64, z: 0 })
    bot.on = em.on.bind(em)
    return { w, bot, em }
  }

  const { bot, em, w } = scene()
  const c1 = classifyTerrainCached(bot)
  ok(c1.cached === false && c1.kind === 'flat', '第一次 ⇒ 真扫（cached:false）', JSON.stringify([c1.cached, c1.kind]))
  const c2 = classifyTerrainCached(bot)
  ok(c2.cached === true && c2.kind === 'flat', '🔴 同一个位置再问 ⇒ 命中缓存（cached:true）', String(c2.cached))
  ok(terrainCacheStats(bot).scans === 1, '只真扫过 1 次', String(terrainCacheStats(bot).scans))
  ok(terrainCacheStats(bot).hits === 1 && terrainCacheStats(bot).misses === 1, '账对得上（1 命中 / 1 未命中）')

  bot.entity.position = new Vec3(3.5, 64, 0.5)
  ok(classifyTerrainCached(bot).cached === false, '人挪到别的格子 ⇒ 重扫（键里带脚下那一格）')
  ok(classifyTerrainCached(bot).cached === true, '挪过去之后又稳住了 ⇒ 继续命中')

  em.fire('blockUpdate', { position: new Vec3(1, 63, 0) })
  ok(classifyTerrainCached(bot).cached === false, '🔴 世界变了（blockUpdate）⇒ 缓存失效')
  ok(terrainCacheStats(bot).version === 1, 'version 记到了这次变更')

  em.fire('chunkDidLoad', {})
  ok(classifyTerrainCached(bot).cached === false, 'chunkDidLoad 也算世界变了')

  ok(classifyTerrainCached(bot, { now: () => Date.now() + 60_000 }).cached === false, '🔴 过了 TTL ⇒ 重扫（兜底）')
  ok(terrainCacheStats(bot).scans >= 1, '缓存统计能读（`terrainCacheClear` 2026-10-20 精简时删了：生产零调用）')

  // unknown 不缓存
  const dead = { blockAt: () => null, entity: { position: new Vec3(0.5, 64, 0.5) }, on: () => {} }
  ok(classifyTerrainCached(dead).cached === false, 'unknown 第一次：真扫')
  ok(classifyTerrainCached(dead).cached === false, '🔴 unknown 不进缓存（区块还在加载时别把它记死）', String(classifyTerrainCached(dead).cached))

  // 半径不同 ⇒ 不同的键
  const { bot: bot2 } = scene()
  classifyTerrainCached(bot2)
  ok(classifyTerrainCached(bot2, { radius: 1 }).cached === false, '半径变了 ⇒ 重扫（键里带半径）')
  ok(classifyTerrainCached(bot2, { radius: 1 }).cached === true, '同半径再来 ⇒ 命中')

  // 世界真的变了，答案也要跟着变
  const { bot: bot3, w: w3, em: em3 } = scene()
  const before = classifyTerrainCached(bot3).kind
  shaft(w3, 1, 0)
  em3.fire('blockUpdate', {})
  const after = classifyTerrainCached(bot3).kind
  ok(before === 'flat' && after === 'gap', '🔴 挖了个深井 + 一条 blockUpdate ⇒ 分类跟着变（不是拿旧答案糊弄）', `${before} → ${after}`)

  ok(terrainCacheStats(null).scans === 0, '没 bot ⇒ 不炸（WeakMap 的键得是对象）')
  ok(classifyTerrainCached({ blockAt: () => null }).kind === 'unknown', '没坐标也没事')

  ok(TERRAIN_CACHE_MS >= 1000 && TERRAIN_CACHE_MS <= 10_000, '缓存 TTL 落在 1–10 秒（够短：漏掉的更新最多旧这么久）', String(TERRAIN_CACHE_MS))

  /* ── 异步计算的判决：**用数据说话**，不是拍脑袋上 Worker ──
   * `src/perf-monitor.mjs` 的判据是 `cpuMs ≥ 30 && cpuRatio ≥ 0.5` 才值得搬 Worker。
   * 一次扫描连 1ms 都不到 ⇒ 结论是"不搬"，这条断言就是那个结论的锚点。 */
  const benchBot = mkBot(flatScene().w, { x: 0, y: 64, z: 0 })
  for (let i = 0; i < 50; i++) classifyTerrain(benchBot)     // 预热
  const t0 = process.hrtime.bigint()
  const N = 500
  for (let i = 0; i < N; i++) classifyTerrain(benchBot)
  const perMs = Number(process.hrtime.bigint() - t0) / 1e6 / N
  ok(perMs < 30, `一次扫描 ${perMs.toFixed(3)}ms < 30ms ⇒ 按 perf-monitor 的判据**不需要 Worker**`, `${perMs.toFixed(3)}ms`)
}

/* ═══════════════ ⑦ 端到端：真的接起来了吗 ═══════════════ */
section('⑦ 端到端：movements(self, { terrain }) 真的换了一套权重')
{
  const { movements } = await import(new URL('../src/plugins.mjs', import.meta.url))
  class FakeMovements { constructor (b) { this.bot = b } }
  const self = (cfg = {}) => ({ bot: mkBot(flatScene().w, { x: 0, y: 64, z: 0 }), cfg, _pf: { Movements: FakeMovements } })

  const flat = movements(self())
  ok(flat.maxDropDown === 3 && flat.digCost === 4 && flat.placeCost === 12 && flat.liquidCost === 4,
    '不给地形 ⇒ 平地那套（= 改动前的全局值）', JSON.stringify([flat.maxDropDown, flat.digCost, flat.placeCost, flat.liquidCost]))
  ok(flat.canDig === true && flat.allowSprinting === true && flat.dontMineUnderFallingBlock === true,
    '跟地形无关的那几项照旧（canDig / 疾跑 / 别挖悬空方块下面）')

  const hazard = movements(self(), { terrain: { kind: 'hazard' } })
  ok(hazard.maxDropDown === 1 && hazard.liquidCost === 20, '给 hazard ⇒ 危险地形那套', JSON.stringify([hazard.maxDropDown, hazard.liquidCost]))
  ok(hazard.canDig === true, 'canDig 不受地形影响（还是配置说了算）')

  const gap = movements(self(), { terrain: { kind: 'gap' } })
  ok(gap.placeCost === 8 && gap.placeCost < flat.placeCost, '沟边垫方块比平地便宜、但不再是最便宜的那一档')
  ok(movements(self(), { terrain: { kind: 'steps' } }).digCost === 3, '台阶上挖便宜一点')
  ok(movements(self(), { terrain: { kind: 'drops' } }).maxDropDown === 2, '落差上允许往下跳的格数收窄')

  const mine = movements(self({ walkMaxDropDown: 9, walkAllowParkour: true }), { terrain: { kind: 'hazard' } })
  ok(mine.maxDropDown === 9 && mine.allowParkour === true, '🔴 用户配置赢过地形档案', JSON.stringify([mine.maxDropDown, mine.allowParkour]))
  ok(mine.liquidCost === 20, '用户没设的项还是按地形给')

  ok(movements({ bot: null, cfg: {}, _pf: { Movements: FakeMovements } }) !== undefined, '没有 bot 也不炸')
  ok(movements({ bot: null, cfg: {}, _pf: {} }) === null, '没有 Movements 构造器 ⇒ null（照旧）')
}

/* ═══════════════ ⑨ 二档：藤蔓能爬 / 掉进岩浆能脱困 ═══════════════ */
section('⑨ 二档补丁：藤蔓能爬、掉进岩浆能规划着游出来')
{
  const { movements, patchClimbables } = await import(new URL('../src/plugins.mjs', import.meta.url))
  /* 最小 Movements 假件：只要那几个 Set 在，movements() 里所有 add/delete 都不会炸 */
  class Mv {
    constructor (b) {
      this.bot = b
      this.blocksToAvoid = new Set([7])       // 7 = fire（上游默认那批的占位）
      this.climbables = new Set([5])          // 5 = ladder（上游唯一那个）
      this.carpets = new Set()
      this.openable = new Set()
    }
  }
  const reg = { blocksByName: { lava: { id: 9 }, ladder: { id: 5 }, vine: { id: 6 } }, blocksArray: [] }
  const selfOf = (isInLava) => {
    const b = mkBot(flatScene().w, { x: 0, y: 64, z: 0 })
    b.registry = reg
    b.entity.isInLava = isInLava
    return { bot: b, cfg: {}, _pf: { Movements: Mv } }
  }

  const dry = movements(selfOf(false))
  ok(dry.blocksToAvoid.has(9) === true, '🔴 不在岩浆里 ⇒ 岩浆留在寻路黑名单（照旧绕开）')
  ok(dry.__dshInLava === false, '记了"当前不在岩浆里"')

  const wet = movements(selfOf(true))
  ok(wet.blocksToAvoid.has(9) === false, '🔴 掉进岩浆 ⇒ 岩浆从黑名单里放出来（A* 才能规划着游出去）')
  ok(wet.__dshInLava === true, '记了"当前在岩浆里"')
  ok(wet.liquids?.has?.(9) !== true, '🔴 但**不**把岩浆算成水路（不然平时就往岩浆湖里钻）')

  const mv = new Mv({ registry: reg })
  ok(patchClimbables(mv, { registry: reg }) === 1 && mv.climbables.has(6), '藤蔓进 climbables（vendor 那行是注释掉的）')
  ok(patchClimbables(mv, { registry: reg }) === 0, '再叫一次不重复加（幂等）')
  ok(patchClimbables(null, { registry: reg }) === 0 && patchClimbables(mv, null) === 0, '没有 mv / 没有 registry ⇒ 0，不炸')

  const src = read('../src/plugins.mjs')
  ok(/const CLIMBABLE_NAMES = \[[\s\S]*?'vine'[\s\S]*?'weeping_vines'[\s\S]*?'cave_vines_plant'[\s\S]*?\]/.test(src),
    '藤蔓族名单齐全（vine / 缠怨藤 / 垂泪藤 / 洞穴藤蔓 各两个形态）')
  ok(/patchClimbables\(mv, b\)/.test(src), 'movements() 结尾真的调了 patchClimbables')
  /* 🔴 2026-10-27：判据从 `entity.isInLava` 换成 `inLavaNow`（三层兜底）——
   *  断言只验"用当下位置判 + 在岩浆里就放开黑名单"这个语义，别把某一行写法钉死。 */
  ok(/inLavaNow\(b\)/.test(src) && /if \(inLava\) mv\.blocksToAvoid\.delete\(lavaId\)/.test(src),
    '岩浆避让按"当下是否在岩浆里"判')
}

console.log('\n' + '─'.repeat(50))
console.log(`check-terrain：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
