/**
 * 方块名 → 类别 / 字符 / 颜色（**纯函数**，路线图第 ④ 条第二刀）。
 *
 * 这一刀搬的是"只认字符串"的那一层：给一个方块名，判断它是不是空气 / 液体 / 能穿过去，
 * 以及给地形图挑一个字符和颜色。它们**没有 `this`、没有事件、没有异步、不碰 mineflayer**，
 * 所以能安全地搬出 `core.mjs`；`core.mjs` 里保留同名导出
 * （`export { glyphOf } from './block-names.mjs'`），外部 import 一行都不用改。
 *
 * 迁移规矩（与 `src/format.mjs` 头注释一致）：
 *   1. 一次只搬一个模块；
 *   2. 搬完立刻 `node --check` + 把 `core.mjs` 导入一遍，确认导出还在、行为没变；
 *   3. **移动和挖掘最后再拆** —— `#walkPathfinder()` / `dig()` 共享 `_moveGen`（移动编号）、
 *      `_ctrlLease`（控制位租约）、11 秒预算和一堆事件监听，是最容易"拆完看着没事、跑起来才怪"的部分。
 */

export const isAir = (n) => n === 'air' || n === 'cave_air' || n === 'void_air'
export const isLiquid = (n) => n === 'water' || n === 'lava' || /_water$|_lava$/.test(String(n ?? ''))
/** 岩浆本体（源头 / 流动）。
 *  🔴 不要把 `magma_block`（岩浆块，固体）放进来：站上去掉血但**能站**，
 *  那条路由 `patchHarmfulFloorMoves` 的重罚绕开，和"泡在岩浆里"不是一回事。 */
export const LAVA_LIKE_RE = /^(lava|flowing_lava)$/
export const isLavaLike = (n) => LAVA_LIKE_RE.test(String(n ?? ''))

/**
 * 「水，以及泡在水里的植物」。
 *
 * 🔴 2026-10-24 实机（用户：「在水里会被水草挡住」）：
 *    站在 `seagrass` / `tall_seagrass` / `kelp` 那格里时，物理上明明泡在水里，但
 *    ① `bot.entity.isInWater` 只认**真正的液体方块**（seagrass 不算）⇒ 读成 false；
 *    ② 眼高格、脚格读出来的名字都是 `seagrass`，不是 `water`。
 *    于是 `inWaterNow()` 三条判据全不成立 ⇒ 被当成"站在陆地上"：
 *    swim 分支不触发（改走 pathfinder，而 A* 在水里出不了路）、`recoverFromWater` 也找不到水面。
 *    表现就是"被水草挡住、动不了"。
 *
 * ⚠️ 不要直接放宽 `isLiquid`：它还兼着"会不会淹死/能不能站"的语义，
 *    岩浆和流动水都在里面，改它会波及挖掘、搭桥、渲染一大片。这里只新增一个更窄的判定。
 */
export const WATER_LIKE_RE = /^(water|flowing_water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/
export const isWaterLike = (n) => WATER_LIKE_RE.test(String(n ?? ''))

/**
 * 能"穿过去"的小东西（花草火把之类）—— 洞穴层图里**不算墙**（否则一张图全是 `#`）。
 * 注意：树叶**不在**这里（它挡视线、也算地形），但在 `SOFT_ROOF` 里（头顶有树不算"在地下"）。
 */
export const PASSABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|lantern|soul_lantern|chain|rail|powered_rail|detector_rail|activator_rail|redstone_wire|tripwire|tripwire_hook|lever|lily_pad|scaffolding|string|cobweb|ladder|light)$|_sapling$|_flower$|_carpet$|^carpet$|_sign$|^sign$|_banner$|^banner$|_button$|_pressure_plate$/
export const isPassable = (n) => Boolean(n) && PASSABLE.test(String(n))

/** 头顶有这些东西**不算**"在地下"（树冠、竹子、雪层…）：站在树下 / 竹林里看地表图更有用 */
/**
 * 头在那格里**不会窒息**的方块：门/活板门/栅栏门/床/半砖/楼梯这些**不占满整格**，
 * 加上**作物和贴地的小植物**（小麦/胡萝卜/土豆/甜菜/下界疣/甘蔗/海带/甘蔗苗…）——
 * 它们 `boundingBox === 'empty'`，实体可以直接穿过去。
 *
 * 🔴 2026-10-18 实机：AI 从**开着的门**里走过时，`isSolidBlock('oak_door')` 为真 ⇒ 被当成
 *    "头卡在方块里正在窒息"，每次穿门都叫醒 + `stopWork`，实机表现是"穿个门要两次工具调用"。
 *    判据不是"能不能走"（门在没开时确实不能走），而是"这一格有没有被方块塞满"。
 *
 * 🔴 2026-10-22 实机（用户点名要修）：站在**小麦田**里（`wheat`，y=79 那格）被反复报
 *    "【自保：我头卡在方块里，正在窒息】"。原因是 `isSolidBlock('wheat')` 为真 —— `PASSABLE`
 *    名单里没有作物。真实判据是**碰撞盒**：作物是 `empty`，不闷人。名字表只是没有碰撞盒读数时的
 *    退路（离线假世界 / 旧数据），所以两边都要补上。
 */
export const NON_SUFFOCATING = /_(?:door|trapdoor|fence_gate|bed|slab|stairs)$|^(?:wheat|carrots|potatoes|beetroots|torchflower_crop|pitcher_crop|nether_wart|sugar_cane|kelp|kelp_plant|seagrass|tall_seagrass|sweet_berry_bush|cocoa|bamboo|bamboo_sapling|scaffolding|tripwire|redstone_wire|repeater|comparator|ladder|rail|powered_rail|detector_rail|activator_rail|cake)$/

/**
 * 能**直接走进去**的作物/贴地植物（碰撞盒是 `empty`，实体从里面穿过）。
 *
 * 🔴 2026-10-22 用户实机：「家里非实体方块走不了」—— 家里那片麦田，A* 死活不肯走进去，
 *    绕路 / NoPath / 卡在田边。根因在 vendor `lib/movements.js:233` 的 `b.safe` 判定：
 *    `boundingBox === 'empty' || b.climbable || this.carpets.has(b.type)`；
 *    而 `carpets` 只在 `lib/movements.js:89` 按 `block.shapes[0][4] < 0.1` 自动收集 ——
 *    小麦高度约 0.3125 > 0.1 ⇒ 不进 carpets；prismarine 给的 `boundingBox` 也不是 `'empty'`
 *    ⇒ `safe === false` ⇒ A* 认为"这一格站不进去"，整块田变成障碍物。
 *    所以这份名单 = "要手动补进 `carpets` 的可穿方块"，由 `src/plugins.mjs` 的
 *    `patchPlantPassable()` 执行。
 *    注意：**甜浆果丛不在名单里**（踩上去掉血，宁可绕开）。
 */
export const PLANT_PASSABLE = /^(?:wheat|carrots|potatoes|beetroots|torchflower_crop|pitcher_crop|nether_wart|sugar_cane|kelp|kelp_plant|seagrass|tall_seagrass|cocoa|bamboo|bamboo_sapling|short_grass|tall_grass|fern|large_fern|dead_bush|lily_pad|vine|glow_lichen|hanging_roots|crimson_roots|warped_roots|nether_sprouts|big_dripleaf|small_dripleaf)$/

/**
 * "树"这一整类：叶子 / 原木 / 去皮木 / 下界菌柄 / 巨型蘑菇。
 *
 * 🔴 2026-10-24 用户实机：「现在寻路老是会跑到树上」。根因不在我们这层，在 vendor：
 *    `movements.js:233` 里 `b.safe = (boundingBox === 'empty' || climbable || carpets) && !blocksToAvoid`，
 *    树叶/原木的 `boundingBox` 是 `block` ⇒ `safe = false` ⇒ A* 认为"这格不能站"；
 *    紧接着 `safeOrBreak`（:282）说"不能站没关系，能挖开就行"，代价
 *    `(1 + 3*digTime/1000) * digCost` —— 树叶 digTime 约 0.05–0.3 秒、digCost 默认 4，
 *    算下来约 4.6–7.6；而绕开一棵树通常只多走 2–3 步。于是 A* 认定**挖穿树冠比绕树便宜**，
 *    一路挖着树叶往上爬，人就站在树冠高度了。
 *
 * 修法：把这一整类塞进 `mv.blocksCantBreak`（vendor :41 那个 Set）⇒ `safeToBreak()` 返回 false
 * ⇒ `safeOrBreak()` 返回 100（不可行）⇒ A* 根本不规划穿树。
 *
 * ⚠️ **只用于寻路的"别挖它"**，不是"这方块不能挖" —— `mc_dig {name:"oak_log"}` 砍树照样能砍，
 *    那条路不走 A*。所以别拿它去卡 `diggableBlock`。
 * ⚠️ 竹子不算：它在 `PLANT_PASSABLE` 里，能直接穿过去。木板/木棍也不算（`_planks` / `_stairs`）。
 */
export const TREE_BLOCK_RE = /_leaves$|_log$|_wood$|_hyphae$|^(crimson|warped)_stem$|^(brown|red)_mushroom_block$|^mushroom_stem$/
export const isTreeBlock = (n) => Boolean(n) && TREE_BLOCK_RE.test(String(n))
/* 🔴 2026-10-29：树要分两类用 ——
 *   · **树叶**（`_leaves`）：碰撞箱整格、挖起来 0.2 秒。禁止挖它是错的：站在树冠上四面全是树叶时
 *     就彻底无路可走（实机「出生在树上 → 困在竖井里」）。对树叶的正确做法是**加价**（`mv.dshBreakPenalty`），
 *     平时绕路更便宜 ⇒ 不乱穿树；真没别的路时还能挖出去。
 *   · **原木/菌柄/蘑菇块**：挖了树就塌、还可能砸下来，继续留在 `blocksCantBreak` 里，钉死不挖。 */
export const LEAF_BLOCK_RE = /_leaves$/
export const isLeafBlock = (n) => Boolean(n) && LEAF_BLOCK_RE.test(String(n))
export const TREE_LOG_RE = /_log$|_wood$|_hyphae$|^(crimson|warped)_stem$|^(brown|red)_mushroom_block$|^mushroom_stem$/
export const isTreeLog = (n) => Boolean(n) && TREE_LOG_RE.test(String(n))
export const SOFT_ROOF = /_leaves$|_log$|_wood$|^bamboo|^snow|_snow$|cactus|^moss|^melon|^pumpkin|_sapling$|_flower$|^vine$|glow_lichen|^hanging_roots$|^big_dripleaf/

/**
 * **"脚下方块那一层"（地板层视图）**的合成名 → 字符（2026-10-15 用户需求）。
 *
 * 地板图问"**这一层本身**是什么、站上去会不会掉"（`floorMapOf()` 用的键）。
 */
export const FLOOR_GLYPH = {
  floor_walk: '·', floor_wall: '#', floor_drop: 'v',
  floor_water: '~', floor_lava: '≈', floor_void: '?',
}

/** 地板层视图的中文标签 */
export const FLOOR_LABEL = {
  floor_walk: '能站', floor_wall: '墙', floor_drop: '会掉下去',
  floor_water: '水', floor_lava: '岩浆', floor_void: '未加载',
}

/**
 * 这块方块算不算**实心、能托住我**。
 *
 * 🔴 与 `isPassable()` 互补但**不等价**：`isPassable` 只认花草火把那类小东西，
 *    水和岩浆在它眼里同样"不可穿过" —— 所以液体必须单独排掉，否则岩浆会被当成地板。
 * 判据只用方块名（与这个文件里其它判据一致），不依赖 `boundingBox`
 * （`check-core-map.mjs` 的假方块就只有 `name`）。
 */
export const isSolidBlock = (n) => Boolean(n) && !isAir(n) && !isLiquid(n) && !isPassable(n)

/** 方块名 → 单字符（给没有视觉的模型"看"地形） */
export function glyphOf (name) {
  if (!name) return '?'
  if (FLOOR_GLYPH[name]) return FLOOR_GLYPH[name]
  if (isAir(name)) return ' '
  if (/_water$|water|_ice$|^ice$/.test(name)) return '~'
  if (/sand/.test(name)) return '.'
  if (/_leaves$|grass_block|short_grass|tall_grass|_flower|fern|bush|cactus|moss/.test(name)) return '"'
  if (/_log$|_wood$|_planks$|fence|door|sign|stairs|slab|bookshelf|crafting_table|chest/.test(name)) return 'T'
  if (/stone|cobble|deepslate|brick|concrete|terracotta|copper|iron|gold|diamond|obsidian|quartz|purpur|anvil|enchant/.test(name)) return ':'
  /* 🔴 2026-10-15 审计：这里原来还写了 `quartz|iron_block`，但上一行已经先匹配 `quartz` 和
   *    `iron` 并返回 `':'` ⇒ 那两个分支永远不可达。删掉，别再让读的人以为它们会走到。 */
  if (/snow|white_|glass/.test(name)) return '#'
  if (/dirt|podzol|mud|gravel|clay|farmland|wheat|carrot|potato|beetroot/.test(name)) return '_'
  return '+'
}

export const COLORS = {
  // 地板层视图（`mode:'floor'`，2026-10-15）：能站 = 亮，墙 = 暗，掉下去 = 偏蓝
  floor_walk: [205, 205, 195], floor_wall: [95, 95, 100], floor_drop: [125, 125, 175],
  floor_water: [51, 76, 178], floor_lava: [222, 110, 40], floor_void: [40, 40, 48],
  grass_block: [106, 170, 64], dirt: [134, 96, 67], sand: [219, 207, 163], suspicious_sand: [200, 185, 140],
  sandstone: [216, 203, 155], smooth_sandstone: [214, 200, 150], stone: [125, 125, 125], cobblestone: [110, 110, 110],
  water: [51, 76, 178], ice: [160, 180, 240], snow_block: [250, 250, 250], oak_log: [110, 84, 50],
  oak_leaves: [60, 120, 45], oak_planks: [162, 130, 78], glass: [200, 220, 230], farmland: [110, 80, 50],
  wheat: [190, 180, 90], bricks: [150, 97, 83], bookshelf: [140, 110, 70], obsidian: [30, 20, 45],
}

export function colorOf (name) {
  if (!name) return [70, 20, 90]
  if (COLORS[name]) return COLORS[name]
  if (/_water$/.test(name)) return [51, 76, 178]
  if (/_leaves$/.test(name)) return [55, 115, 45]
  if (/_log$|_wood$/.test(name)) return [105, 80, 48]
  if (/_planks$/.test(name)) return [162, 130, 78]
  if (/_sand/.test(name)) return [219, 207, 163]
  if (/_concrete$/.test(name)) return [160, 160, 160]
  if (/_wool$/.test(name)) return [220, 220, 220]
  if (/_ore$/.test(name)) return [125, 125, 125]
  if (/stone|cobble|deepslate|brick/.test(name)) return [120, 120, 120]
  return [150, 150, 150]
}
/** 路线图第 ④ 条第八刀：把"右键交互判据 + 能不能放方块"搬进来（都是纯方块名/方块对象判据，2026-10-08） */

/** 右键能**打开窗口**的方块（`use` 之后窗口该出现，这就是"交互成功"的硬证据） */
export const CONTAINER_RE = /chest|barrel|shulker_box|furnace|smoker|hopper|dispenser|dropper|brewing_stand|enchanting_table|anvil|grindstone|smithing_table|loom|cartography_table|stonecutter|crafting_table|beacon|lectern|fletching_table|respawn_anchor|decorated_pot|chiseled_bookshelf|crafter/i

/** 右键会**翻转状态**的方块（门/活板门/栅栏门/按钮/拉杆）—— 可以复核状态有没有变 */
export const TOGGLE_RE = /(_door|_trapdoor|fence_gate|button|lever)$/i

/**
 * 这个位置**能不能放方块进去**（= 该方块不占空间 / 是可替换物）。
 *
 * 判据用 `boundingBox === 'empty'`，**不是**"名字是不是 air"。
 * 旧版只认 air/cave_air/void_air，2026-09-15 用真实 minecraft-data(26.2) 实测发现漏了一大片：
 *   ✅ air / cave_air / void_air   → 'empty'
 *   ✅ **water / lava**             → 'empty'  ← 旧版这里直接失败，**水里建不了东西**（码头/桥全废）
 *   ✅ 草/花/蕨/雪/藤蔓/海草/海带/气泡柱/火把/火/树苗/地毯/铁轨 → 'empty'
 *   ❌ 石头/木板/台阶/楼梯/土径      → 'block'  （正确拒绝）
 * ⚠️ 未加载（blockAt 返回 null）**不算可放** —— 不能盲放。
 */
export const canPlaceInto = (blk) => {
  if (!blk) return false
  if (blk.boundingBox === 'empty') return true
  return isAir(blk.name) || isLiquid(blk.name)     // 兜底：个别版本 boundingBox 可能不准
}

/* ── 作物成熟度（2026-10-18 用户实机："现在ai看不到作物的成熟等级"）────────────────
 *
 * 方块名只告诉你"这格是 wheat"，**不告诉你熟没熟** —— `age` 在方块状态里（`getProperties()`）。
 * 以前 `mc_scan {name:"wheat"}` 只回坐标，AI 只能"收一次看掉的是小麦还是种子"来猜，
 * 或者靠 `mc_act {use}` 的 `changed` 里碰巧带出 `age: 0 → 3`。
 *
 * `age` 的取值范围**按作物不同**（小麦/胡萝卜/马铃薯 0~7，甜菜根/地狱疣 0~3，可可 0~2），
 * 所以"7 就是熟"只对一部分作物成立 —— 这里把上限一起给出来，别再让 AI 自己背这张表。
 * 拿不到 age 时返回 null：**"不知道"不许当成"刚种下"**。
 */
export const CROP_MAX_AGE = {
  wheat: 7, carrots: 7, potatoes: 7, beetroots: 3,
  nether_wart: 3, cocoa: 2,
  melon_stem: 7, pumpkin_stem: 7,
  sweet_berry_bush: 3, torchflower_crop: 3, pitcher_crop: 4,
}

/**
 * 读作物生长阶段。`name` 是方块 id（`carrots` 这种复数要照实写），`props` 是 `block.getProperties()`。
 * @returns {{age:number,maxAge:number,ripe:boolean}|null} 不是作物 / 读不到 age ⇒ null
 */
export function cropStageOf (name, props) {
  const maxAge = CROP_MAX_AGE[String(name ?? '')]
  if (!maxAge || !props) return null
  const age = Number(props.age)
  if (!Number.isFinite(age)) return null
  return { age, maxAge, ripe: age >= maxAge }
}

/** 放下去变成**实体**的物品（船 / 矿车 / 刷怪蛋 / 盔甲架 / 末影水晶）。
 *
 * 🔴 2026-10-20 实机：这些**不能用** `placeBlock` / `activateBlock` 放 —— mineflayer 的
 *    `lib/plugins/place_entity.js` 要先 `_genericPlace()` 再**补发一个 `use_item` 包**，
 *    少发后面那个，服务端就当"空手右键"，永远不生成（用户报的"船放不出来"）。
 *    放在这个叶子模块里，`place.mjs`（负责放）和 `world-use.mjs`（负责提示）都能 import，
 *    不会绕出循环依赖。 */
export const ENTITY_ITEM_RE = /(boat|raft|minecart|spawn_egg|end_crystal|armor_stand)$/i
export const isEntityItem = (name) => Boolean(name) && ENTITY_ITEM_RE.test(String(name))
