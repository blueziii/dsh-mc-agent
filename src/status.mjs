/**
 * 连接信息与状态视图 —— 从 `src/core.mjs` 搬出来的"感知"那一层（路线图第 ④ 条第十三刀）。
 *
 * 约定（每一刀都照这个来）：
 *   ① **不反向 import `core.mjs`**；② 不直接 import mineflayer（只往下依赖 `block-names.mjs`
 *   与 `world-observer.mjs`）；③ **只读、同步、不改状态**。
 *
 * 🔴 这两个视图是**公开方法**（`index.js` 的状态条与 `mc_status`/`mc_diag`、`extensions\mc_observe.mjs`
 *    的"程序检测到"、`selfcheck.mjs` 都从**实例**上调 `bot.status()` / `bot.connectionView()`）
 *    ⇒ `core.mjs` 里留**同名薄包装**，调用方一行都不用改。
 *
 * 为什么 `statusOf()` 的签名多一个 `ctx`：它要读**实例状态**（子服名、连接参数、上次错误、
 * 是否在重连、连上时间）—— 这些不属于 `bot`。所以由薄包装把实例字段打包成 `ctx` 传进来，
 * 模块自己保持"只吃参数"的纯形状。
 */
import { isLiquid } from './block-names.mjs'
import { inWaterNow } from './world-observer.mjs'
import { readBossBars } from './bossbar.mjs'

/**
 * 给前端 / 工具看的**连接信息**：只有地址三件套。
 *
 * 🔴 用户 2026-09-16："状态条别只写'在游戏中'，要显示服务器地址。"
 *    `_connectionProfile` 里还带着 `authMode` / `account`（账号名）—— 那是给日志与诊断用的，
 *    **不该跟着这个视图发到浏览器**，所以统一从这里出（`status()` 与 `modeView()` 共用）。
 * @param {{host?: string, port?: number, subserver?: string}|null} profile `_connectionProfile`
 * @returns {{host: string|null, port: number|null, subserver: string|null}|null}
 */
export function connectionViewOf (profile) {
  const p = profile
  if (!p) return null
  return { host: p.host ?? null, port: p.port ?? null, subserver: p.subserver || null }
}

/**
 * 状态视图：离线（可能带 `ghost`/`reconnecting`）或在线（坐标/朝向/游戏模式/血量/饥饿/氧气/手持/在线时长）。
 *
 * @param {object|null} b mineflayer bot
 * @param {{sub?: string|null, connection?: object|null, lastError?: string|null,
 *          reconnecting?: boolean, reconnectPending?: boolean, connectedAt?: number}} ctx
 * @param {object|null} self McBot 实例（可选）—— 只用来读 `stats.deaths` / `_life`（死亡次数与上次死在哪）。
 *   ⚠️ 2026-10-29：`dead`/`deaths` 那两行引用了 `self` 但签名里没有，一调用就
 *   `ReferenceError: self is not defined`（用户实机报的 `mc_observe` 崩）。现在当可选参传进来。
 */
export function statusOf (b, ctx = {}, self = null) {
  // 连的哪个服（用户 2026-09-16："状态条别只写'在游戏中'，要显示服务器地址"）。
  // 只回地址/端口/子服，**不含账号与凭据**；前端负责"太长就截断"。
  const connection = ctx.connection ?? null
  // 🔴 「幽灵在线」（2026-09-19）：断线/被踢后 `bot.entity` 会残留，光看它就把死连接报成在线。
  //    连接已结束就按离线报，并明确标出 ghost，免得 AI 与用户都以为还在游戏里。
  const ended = b?._client?.ended === true
  if (!b?.entity || ended) {
    const reconnecting = Boolean(ctx.reconnecting || ctx.reconnectPending)
    return {
      online: false, sub: ctx.sub, connection, lastError: ctx.lastError,
      ...(reconnecting ? { reconnecting: true } : {}),
      ...(ended && b?.entity
        ? {
            ghost: true,
            hint: reconnecting
              ? '连接已经断了（bot.entity 是 mineflayer 的残留），插件正在自动重连——重连成功会自动告诉你'
              : '连接已经结束了（bot.entity 是 mineflayer 的残留）——要回到游戏里请重新 mc_connect',
          }
        : {}),
    }
  }
  const p = b.entity.position
  /* 🔴 2026-10-19：末影龙/凋灵的血**不进**实体元数据（`entitiesNear()` 读不到），
   *    只在 Boss Bar 包里。这里带上，`mc_status` 就能一眼看到打龙打到几成。 */
  const bossBars = readBossBars(b)
  /* 🔴 2026-10-24 实机（用户贴的 AI 思考）：在**石头里**挖矿时，observe 一路报「氧气 18 → 10 → -1 → 8」，
   *    把 AI 吓到了（它以为要淹死）。根因两条：
   *    ① `bot.oxygenLevel` 是 mineflayer 把 air_supply 除以 15 得来的**气泡数（0–20）**，
   *       而窒息时 air_supply 会掉到负值 ⇒ 读出 **-1** 这种没法解释的数；
   *    ② 它只在服务端发 air_supply 元数据时才更新 —— **上岸/在陆地上时是残留值**，
   *       人明明在石头里，读数还停在水里那一档。
   *    现在：只在**头真的在水下**时报，并且夹到 0 以上（0 = 正在窒息掉血）。 */
  const submergedNow = (() => {
    try {
      /* 🔴 2026-10-08 实机：这里以前先看 `entity.isInWater` —— 而它泡在水柱里会读出
       *    undefined（实测机器人 (-31,59,261) 脚/头两格都是 water 却报"没在水里"）。
       *    头在水下就是头在水下，直接看眼睛那一格。 */
      const eye = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0)
      return isLiquid(b.blockAt(eye)?.name)
    } catch { return false }
  })()
  const airNow = submergedNow && Number.isFinite(b.oxygenLevel)
    ? Math.max(0, Math.round(Number(b.oxygenLevel)))
    : null
  return {
    online: true, sub: ctx.sub, connection,
    position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    yaw: b.entity.yaw, pitch: b.entity.pitch,
    gamemode: b.game?.gameMode, dimension: b.game?.dimension, time: b.time?.timeOfDay,
    health: b.health, food: b.food, players: Object.keys(b.players ?? {}),
    /* 2026-10-29：死着（没重生）要能一眼看出来 —— 现在不自动重生，要叫 mc_act { mode: "respawn" }。 */
    ...(b.isAlive === false ? { dead: true, ...(self?._life?.position ? { diedAt: self?._life?.position } : {}) } : {}),
    /* 2026-10-29：死过几次、上次死在哪 —— 以前完全看不到（用户：「为什么 ai 死了好像不知道」）。 */
    ...(self?.stats?.deaths || self?._life ? { deaths: self?.stats?.deaths ?? 0, ...(self?._life?.position ? { lastDeath: self?._life?.position } : {}) } : {}),
    held: b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : null,
    uptimeSec: Math.round((Date.now() - ctx.connectedAt) / 1000),
    /* 连接假死（2026-10-23 实机：用户"完全卡住，tp 也不行，只能重进"）：多久没收到任何包。
     * 正常游戏里服务端每秒都在发包，这里到 40 秒 = 连接已经死了（阈值见 connection.mjs）。
     * 直接读 `b._lastPacketAt` 而不是 import connection.mjs —— 少一条状态层和连接层的依赖。 */
    silenceSec: (() => {
      const t = Number(b?._lastPacketAt)
      if (!Number.isFinite(t) || t <= 0) return null
      return Math.round((Date.now() - t) / 1000)
    })(),
    inWater: inWaterNow(b),
    // 氧气（0–20 气泡，20 = 满）。在水里憋气会一路掉到 0，然后开始掉血 —— 淹死就是这么来的。
    // 🔴 只有**头真的在水下**（`submergedNow`）才报：陆地/石头上这项是残留值，报出来只会误导。
    // 0 = 已经在窒息掉血（mineflayer 读到的原始值可能是负数，已夹到 0）。
    air: airNow,
    submerged: submergedNow,
    /* 🔴 2026-10-27 实机（session-514c21b6，AI 自己的复盘）：「从岩浆里爬出来脚还在岩浆边
     *   就停下吃东西，直接烧死了」。全仓之前**没有任何地方读 `entity.fire`**（grep 0 处）——
     *   出了岩浆不等于火灭了：引燃还在烧，站着不动就是等死。不报这一项，模型不知道"现在不能停"。 */
    fire: b?.entity?.fire === true,
    ...(bossBars.length ? { bossBars } : {}),
  }
}
