/**
 * dsh-mc-agent —— DSH 原生 Minecraft Agent 插件（host 半端）
 * ============================================================================
 * 目标：把"我"接进 MC 做成**一等公民**，而不是外挂一个 MCP 子进程。
 *
 *  1. 原生工具：mc_status / mc_say / mc_move / mc_map / mc_dig / ... 直接注册进
 *     ctx.tools（所有会话可见），不再依赖 @deepseek-ai/dsh-mcp-client。
 *  2. 🔴 **每会话独立实例**：每个 agent（会话）有自己的 McBot + 事件队列 + 看门狗。
 *     不同会话可以连不同服务器、用不同账号，互不干扰。
 *     同一个会话内只能有一个 bot 实例（一个游戏角色）。
 *  3. 🔴 **连接参数工具化**：服务器地址/端口/登录凭据/子服 全部由 mc_connect 工具
 *     运行时传参，AI 根据用户指令或记忆文件决定连哪里。Config 里不再有硬编码的
 *     服务器/凭据（0.1 时代的遗留 fallback 字段已于 2026-10-02 清理）。
 *  4. 事件通知**只有一条通道**：`mc_watch` 后台看门狗任务（job 结算 → DSH followup
 *     唤醒**同一个会话**）。本插件**不存在**任何跨会话唤醒实现。
 *
 * 机器人核心在 ./src/core.mjs（不依赖 DSH，可独立测试）。
 * 挂载：profile cordis.patch.yml 里 `- id: dsh-mc-agent / name: dsh-mc-agent`。
 * ============================================================================
 */
/* 🔴 2026-10-04（GitHub issue #5）：这里**曾经**是两行静态 import（`@deepseek-ai/schemastery` /
 * `@deepseek-ai/dsh-tools`）—— 它们是 **optional peer**（包管理器永远不装），官方 dsh-desktop 上宿主
 * 解析层也喂不进来 ⇒ 模块**链接期**就失败，宿主只报一句 `failed to import`。现在两条路都"拿不到也能活"：
 * `z` 在下面按需动态 import（拿不到就**不导出** Config）；`defineTool` 来自 src/tool-def.mjs（宿主优先 + 内置兜底）。 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync, statSync, renameSync, realpathSync, rmSync, cpSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolve, sep, join, isAbsolute, dirname, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { briefOf } from './src/brief.mjs'
import { McBot, lossless, logLine, logDebug, logOnce, logLevel, libraryInfo, CALL_MS, callBudget, redactPath } from './src/core.mjs'
import { defineTool, toolDefKind, loosenNumberParams, coerceNumberArgs } from './src/tool-def.mjs'
import { inWaterNow } from './src/world-observer.mjs'
import { briefMoveOf, briefMoveTextOf } from './src/movement.mjs'
/* 路线图第 ⑥ 条：把每个动作的结局说清（已确认成功 / 动作失败 / 结果未知）。纯函数，不碰游戏状态。 */
import { outcomeOf, verdictText } from './src/task-runner.mjs'
import { runText } from './src/task-exec.mjs'
import { prepCheck } from './src/prep.mjs'
import { fishOnce } from './src/fish.mjs'
import { isDropEntity, HOSTILE_RE } from './src/entity-names.mjs'
import { tradeVillager } from './src/trade.mjs'
import { buildBlueprint } from './src/blueprint.mjs'
import { sleepInBed, wakeUp, farmArea } from './src/farm.mjs'
import { PRIORITY, DEFAULT_WAIT_MS } from './src/action-scheduler.mjs'
import {
  versionPromptText, versionPromptTitle, versionPromptSource, versionPromptPath, VERSION_PROMPT_FILE,
  readVersionPrompt, writeVersionPrompt, resetVersionPrompt, syncVersionPrompt,
} from './src/version-prompt.mjs'
import { EXPRESS_DIR, OUT_DIR, expressRootOf, outRootOf, parseExpressPath, safeExpressTarget, mimeOf, SANDBOX_TYPES, expressRefFor, EXPRESS_OFF_TEXT, EXPRESS_NEED_BASE_TEXT, normalizeExpressBase, onlineUrlOf } from './src/express.mjs'
import { Watchdog, WATCH_DEFAULTS } from './src/watchdog.mjs'
/* 2026-10-15：`mc_map` 默认改成"脚下方块那一层"（地板层视图）—— 直接调 `src/map-render.mjs`
 * 的新函数，**不往 `core.mjs` 加薄包装**（那个文件已经贴着 `check-module-load` 的 1000 行上限）。 */
import { floorMapOf, navSummaryOf, hazardCellsOf, columnOf, columnText, parseXZ, surfaceYOf, sliceMapOf, sliceMapText } from './src/map-render.mjs'
/* 2026-10-15：事件循环延迟 / CPU 占用监测（用户「异步与多线程优化」方案第 1 步）——
 * **用数据决定要不要上 Worker 线程**，`mc_diag` 的 `perf` 段直接给结论。 */
import { perfWrap, perfSnapshot, perfText, perfReset } from './src/perf-monitor.mjs'
import { terrainCacheStats } from './src/terrain.mjs'
import { workerPoolStats } from './src/worker-pool.mjs'
import { MemoryStore } from './src/memory.mjs'
import { createInjector } from './src/inject.mjs'
import { installRejectionGuard, refreshRejectionGuard } from './src/crash-guard.mjs'
import { recordChat } from './src/chat-log.mjs'
import { PluginConfig, DEFAULT_CONFIG, resolveStateDir, pickPresetTarget, pickPresetSource, isCopiedPresetDescription, PREFERRED_PRESET_SOURCES, MC_PRESET_SPEC, planPresetAction, patchPersonaInComposition, personaTextKeyOf, disableShellInComposition, patchToolGroupsIntoComposition, MC_PRESET_TOOL_GROUPS, matchCommandList, isRegexEntry } from './src/config.mjs'
import { COMMAND_GROUPS, catalogNames, COMMANDS_THAT_MOVE_ME, splitCommands, commandNameOf, MAX_COMMANDS_PER_CALL } from './src/commands.mjs'
import { readBossBars, formatBossBars } from './src/bossbar.mjs'
import { AccountStore, parseAuthlibCard, normalizeServerUrl, dashUuid } from './src/accounts.mjs'
import { msaCacheDir, msaHasCache, msaJobOf, msaJobStart, msaJobClear, msaSupported } from './src/msa.mjs'
import { DEFAULT_AGENTS_MD, agentsMdPath, legacyAgentsMdPath, migrateLegacyAgentsMd, readAgentsMd, writeAgentsMd, resetAgentsMd, syncRulesVersion } from './src/agentsmd.mjs'
import { wsConfigPath, isWsConfigData, migrate as migrateWorkspaceConfig, values as workspaceConfigValues, patch as patchWorkspaceConfig, readRulesVersion, readVersionPromptVersion } from './src/wsconfig.mjs'
import { PROTECTED_FILES, isProtectedPathArg, WRITE_FILE_TOOLS, MEMORY_WRITE_ACTIONS, rejectionText } from './src/protected.mjs'
import { encodePng } from './src/png.mjs'
import { userMessage, messageFactoryKind, pluginLoadNote } from './src/user-message.mjs'
import { ImageEngine, imageEngineAvailable, imageEngineError } from './src/image.mjs'
import { listenLanBroadcast } from './src/lan.mjs'
import { statusPing, parseAddress, formatAddress, flattenMotd } from './src/ping.mjs'
import { ServerHistory } from './src/serverhistory.mjs'
import { buildConnectPrompt } from './src/connect-prompt.mjs'
import { waitForEvents } from './src/wait.mjs'
import { launchBoat } from './src/boat.mjs'
import { lookTrack } from './src/look-track.mjs'
import { WorldRegistry, WORLDS_FILE, WORLDS_DIR, UNCONNECTED_KEY, addrKeyOf, isOwnHost, normalizeHost, safeWorldDir, worldNameFromMotd } from './src/worlds.mjs'

export const name = 'dsh-mc-agent'
export const inject = ['webServer', 'tools']

/** 插件版本（`mc_capabilities` 会报给他；读不到就 unknown） */
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? 'unknown' } catch { return 'unknown' }
})()

/* ============================ HTTP 工具与信任栅栏 ============================ */
/* 与 @deepseek-ai/dsh-client-connection 的 /api 同款栅栏（DNS-rebinding + 跨站），
 * 非认证层。照抄 dsh-serve 的实现，保持同源插件行为一致。 */

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
    && parts[0] === '127'
}

function parseAuthority(authority) {
  try { return new URL(`http://${authority}`) } catch { return undefined }
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    const canonical = port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
    return canonical === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedRequest(headers, trustedHosts) {
  const host = headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

/** 请求体上限（**字节**，不是字符）。 */
const MAX_BODY_BYTES = 1_000_000

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; fn(v) } }
    req.on('data', (chunk) => {
      if (settled) return
      bytes += Buffer.byteLength(chunk)
      /* 🔴 审计：旧写法 `if (data.length > 1_000_000) req.destroy()` 有两个毛病 ——
       *  ① `resolve` 只挂在 `'end'`/`'error'` 上，而 `destroy()` 只发 `'close'`/`'aborted'`
       *     ⇒ promise **永不 settle**，调用方 `await readJsonBody(req)` 永久挂起（协程 + 闭包泄漏），
       *     前端拿到的是网络错误而不是一个能看懂的 JSON。
       *  ② `data.length` 是 UTF-16 字符数不是字节数（中文约 3MB 才触发），跟"防大包"本意差一截。
       * 现在按字节数算，超限**明确拒绝**并带 413。 */
      if (bytes > MAX_BODY_BYTES) {
        const err = new Error(`请求体太大（超过 ${MAX_BODY_BYTES} 字节）`)
        err.statusCode = 413
        err.code = 'BODY_TOO_LARGE'
        done(reject, err)
        try { req.destroy() } catch { /* 已经断了就算了 */ }
        return
      }
      data += chunk
    })
    req.on('end', () => { try { done(resolve, JSON.parse(data || '{}')) } catch { done(resolve, {}) } })
    req.on('error', () => done(resolve, {}))
    req.on('close', () => done(resolve, {}))
  })
}

/**
 * Config = 纯**行为配置**（与"连哪个服"无关）。
 * 连接参数全在 mc_connect 工具里；0.1 时代的遗留 fallback 字段
 * （host/port/subserver/authUrl/authUser/authPass/autoConnect）已无人读，2026-10-02 清除。
 *
 * 🔴 2026-10-04：schema 由宿主 `@deepseek-ai/schemastery` 提供，**拿不到就不导出 Config**（= undefined）——
 *   cordis 对此是容忍的（`if (!runtime.Config) return config`），但也就**不会替我们填默认值** ⇒
 *   `apply()` 里自己兜 `DEFAULT_MENTIONS`。
 *   ⚠️ **绝不能**退化成一个普通对象：cordis 会去调 `Config['~standard'].validate` 而当场炸。
 */
let z = null
try { z = (await import('@deepseek-ai/schemastery')).default ?? null } catch { /* 宿主没喂 ⇒ 不要 Config */ }

/**
 * 默认"喊我"触发词（正则，大小写不敏感）。聊天里命中这些词才算在叫我。
 *
 * 🔴 2026-09-16 用户投诉："为什么这台服务器上会有那种叫法的记忆？你暴露了些什么东西出去了！"
 *    根因就是这里**曾经把私人的账号名/昵称写成了默认值**——那串名字跟着代码进了**公开的开源副本**。
 *    默认值只留**通用叫法**；具体账号名由插件在连接成功后**从登录档案里现学**
 *    （见 `Watchdog.learnName`），外号用 `mc_config {patch:{mentionPatterns:[…]}}` 加
 *    —— **代码里永不再出现私人名字**。
 */
export const DEFAULT_MENTIONS = [
  'deepseek', 'deep\\s*seek', '\\bds\\b', '\\bdsh\\b', '\\bai\\b', 'agent',
  '机器人', '麦块',
]

export const Config = z ? z.object({
  // ── 行为配置 ──
  mentions: z.array(z.string()).default(DEFAULT_MENTIONS),
}) : undefined


/* ======================== 每会话独立实例 ======================== */

/**
 * 一个会话的 MC 状态：独立 McBot + 事件队列 + 看门狗。
 * 不同会话的 McSession 互不干扰。
 */
class McSession {
  constructor(agentId, config, lockDir = null) {
    this.agentId = agentId
    this.config = config
    // 不传固定 config：连接参数走 connect()；instanceId 让每个会话有独立的锁与日志标识。
    // 🔴 lockDir = 插件的家（`$DSH_HOME/dsh-mc-agent/`）：**别把锁文件写进插件包目录**
    //    （装进 node_modules 后可能是只读的，升级时也会被覆盖）——与日志同一条理由。
    this.bot = new McBot({ instanceId: agentId, ...(lockDir ? { lockDir } : {}) })
    /* 🔴 「遇到危险打不打断」是**插件级**配置（`mc_admin_config` 可当场改）。
     *    长动作在循环里读 `self.cfg.stopOnDanger`，所以这里给它挂一个**活的** getter ——
     *    改完配置立刻生效，不用重建会话。（用户 2026-10-19：「不要打断只提醒」） */
    Object.defineProperty(this.bot.cfg, 'stopOnDanger', {
      get: () => this.config?.get?.('stopOnDanger') === true,
      configurable: true, enumerable: true,
    })
    this.mode = 'standby'           // standby / active / sleep
    this.events = []                // 未消费的 MC 事件
    /* 🔴 审计报告 F2：事件带**单调 seq**。队列满 200 条时 `#pushEvent` 从头部 splice，
     *    `events.length` 就恒等于 200 ⇒ 用长度判"有没有新事件"在长挂机会话里必然漏。
     *    `eventSeq` 是"已经产出过多少条"的累计值，只增不减。 */
    this.eventSeq = 0
    this.maxEvents = 200
    this.watchdog = null            // 看门狗（Watchdog 实例，进服自动挂载）
    this.selectedAccount = null     // 本会话选定的账户 innerID（mc_accounts{action:"use"}）
    // 「正在等待」被打断的标记（看门狗要唤醒 AI 时置位）——见 src/wait.mjs 的文件头说明：
    // 宿主把 steer 放在下一个 step 边界投递，而 step 边界要等当前工具返回 ⇒
    // 一个 mc_events{waitSec} 就能把唤醒拖到最后。这个标记让等待提前收工。
    this.waitInterruptedAt = 0
    this.waitInterruptReason = null
    this._wired = false
    this._wiredHandlers = []
  }

  /**
   * 打断本会话正在进行的 `mc_events {waitSec}` 等待（看门狗注入前调用）。
   * 只置一个标记：等待循环每 250ms 看一眼，见到就立刻返回（工具一返回，step 结束，唤醒文案当场投出去）。
   */
  interruptWait(reason = null) {
    this.waitInterruptedAt = Date.now()
    this.waitInterruptReason = reason ? String(reason) : null
  }

  /* ── 事件绑定（懒绑：首次使用时才 wire，避免未连接的 bot 产生无意义事件）── */

  ensureWired(pluginCtx) {
    if (this._wired) return
    this._wired = true
    const self = this

    /* 🔴 审计：这些监听挂在 `this.bot` 上，销毁时必须摘掉 —— 否则销毁后的 session 还被
     * bot 一直持有（闭包里的 self / pluginCtx 跟着活着），bot 断开时还会往已经没人看的
     * `events` 里写。用 `on()` 统一登记，`#unwire()` 里摘。 */
    const on = (ev, fn) => { this.bot.on(ev, fn); this._wiredHandlers.push([ev, fn]) }

    on('log', (line) => pluginCtx.logger?.info?.(`[${self.agentId}] ${line}`))
    on('spawn', (e) => self.#pushEvent('lifecycle', `已上线 ${e.sub} @ ${JSON.stringify(e.position)}`))
    on('death', (e) => self.#pushEvent('lifecycle', `我死了 @ ${JSON.stringify(e.position)}`))
    on('reconnect', (e) => self.#pushEvent('lifecycle', `已重连 ${e.sub}`))
    // 🔴 断线也要进事件队列（2026-09-19）：`mc_events` 里看得见，AI 才不会以为"一直在线"。
    on('offline', (e) => self.#pushEvent('lifecycle',
      `连接断开：${e?.reason ?? '连接结束'}${e?.willReconnect ? '（正在自动重连）' : '（不会自动重连）'}`))
    on('chat', ({ who, text }) => self.#pushEvent('chat', `<${who}> ${text}`, { who }))
    on('system', ({ text }) => self.#pushEvent('system', text))
    on('damage', (e) => self.#pushEvent('damage', `血量降到 ${e.health} @ ${JSON.stringify(e.position)}`))
  }

  /** 摘掉 `ensureWired()` 挂上的全部 bot 监听（销毁时调用，防止 session 被 bot 反向持有）。 */
  #unwire() {
    for (const [ev, fn] of this._wiredHandlers) {
      try { this.bot.off(ev, fn) } catch { /* 摘不掉也不影响销毁 */ }
    }
    this._wiredHandlers = []
  }

  /* ── 清理 ── */

  destroy() {
    try { this.watchdog?.disarm('会话结束') } catch {}
    try { this.#unwire() } catch {}
    // 🔴 审计：`McBot.disconnect()` 是 **async**（src/core.mjs → src/connection.mjs），
    // 旧写法 `try { … } catch {}` 只挡同步抛出，抓不到 promise 的拒绝 —— 一旦断开过程里抛错
    // 就是"未处理拒绝"，宿主是 fail-loud（会 exit(1)，插件自己在别处也记过这条）。
    try {
      void Promise.resolve(this.bot.disconnect('会话结束')).catch((e) => {
        try { logLine(`销毁会话时退出游戏失败（不影响清理）：${e?.message ?? e}`) } catch {}
      })
    } catch (e) {
      try { logLine(`销毁会话时退出游戏失败（不影响清理）：${e?.message ?? e}`) } catch {}
    }
    this.watchdog = null
    this.events = []
  }

  /* ── 事件队列 ── */

  /** 公开的事件入队（看门狗注入失败时也要留个痕，见审计报告 F4）。 */
  pushEvent(kind, text, extra = {}) { this.#pushEvent(kind, text, extra) }

  #pushEvent(kind, text, extra = {}) {
    this.events.push({ seq: ++this.eventSeq, at: Date.now(), kind, text, ...extra })
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents)
  }

  drainEvents(limit = 20, kind = null) {
    const taken = []
    const rest = []
    for (const e of this.events) {
      if (taken.length < limit && (!kind || e.kind === kind)) taken.push(e)
      else rest.push(e)
    }
    this.events = rest
    return taken
  }

  /* 🔴 审计报告 F5：以前 `peek` 取**最新** N 条（`slice(-limit)`）而消费取**最早** N 条，
   *    同一个队列两个方向，描述里又没说 ⇒ 模型 peek 一遍、再消费一遍，拿到的完全是两批。
   *    现在两边都是**最早的先出**（队列语义），`peek` 只是不删。 */
  peekEvents(limit = 20, kind = null) {
    const out = []
    for (const e of this.events) {
      if (out.length >= limit) break
      if (!kind || e.kind === kind) out.push(e)
    }
    return out
  }

  /* ── 模式 ── */

  modeView() {
    return {
      mode: this.mode,
      online: this.bot.online,
      // 断了但还要重连（含"正在尝试连接"那段，最长 45s）：前端要能显示"重连中"，AI 也别以为还能操作角色
      reconnecting: Boolean(this.bot.reconnecting || this.bot.reconnectPending),
      sub: this.bot.sub,
      connection: this.bot.connectionView(),
      pendingEvents: this.events.length,
      watch: this.watchdog?.status() ?? null,
    }
  }

  /* ── "喊我"判定 ── */

  /* 🔴 审计：这里原来还有一对 `mentionRegex()` / `isCalled()`，两个毛病：
   *  ① `mentionRegex()` 的缓存判据是 `this._mentionRe?.source !== this.config.mentions.join('|')`，
   *     但它赋值的是 `mentions.map((p) => `(?:${p})`).join('|')` —— `.source` 永远带 `(?:)` 包装，
   *     跟裸 `join('|')` **恒不相等** ⇒ 恒真条件，每次调用都重建正则；
   *  ② 全仓（含 client.js / selfcheck.mjs / tools/）**没有任何调用点**，真正在用的是 `calledBy()`。
   * 两个都删了。 */

  /** 这段文本里出现了哪几个"喊我"的叫法（按 mentions 的书写顺序，返回命中的模式原文）。 */
  calledBy(text) {
    const s = String(text ?? '')
    return this.config.mentions.filter((p) => { try { return new RegExp(`(?:${p})`, 'i').test(s) } catch { return false } })
  }
}


/* ======================== 全局注册表 ======================== */

/**
 * 管理所有活跃的 McSession。按 agentId 索引。
 * 插件卸载时统一清理。
 */
class McRegistry {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** 插件状态目录（`$DSH_HOME/dsh-mc-agent/`）：会话锁文件放这里，不写插件包目录 */
    this.lockDir = null
    /** @type {Map<string, McSession>} */
    this.sessions = new Map()
  }

  /** 获取当前会话的 McSession（不存在就创建） */
  getOrCreate(agentId) {
    let sess = this.sessions.get(agentId)
    if (!sess) {
      sess = new McSession(agentId, this.config, this.lockDir)
      sess.ensureWired(this.ctx)
      this.sessions.set(agentId, sess)
      this.ctx.logger?.info?.(`[dsh-mc-agent] 新建会话实例：${agentId}`)
    }
    return sess
  }

  /** 只读查询：不存在就返回 undefined（**不要**用 getOrCreate——查状态不该建实例） */
  peek(agentId) { return this.sessions.get(agentId) }

  /** 销毁某个会话的实例 */
  destroy(agentId) {
    const sess = this.sessions.get(agentId)
    if (sess) {
      sess.destroy()
      this.sessions.delete(agentId)
      this.ctx.logger?.info?.(`[dsh-mc-agent] 销毁会话实例：${agentId}`)
    }
  }

  /** 销毁所有（插件卸载时） */
  destroyAll() {
    for (const [id, sess] of this.sessions) {
      try { sess.destroy() } catch {}
    }
    this.sessions.clear()
  }

  /** 列出所有活跃实例（诊断用） */
  listSessions() {
    return [...this.sessions.entries()].map(([id, sess]) => ({
      agentId: id,
      online: sess.bot.online,
      sub: sess.bot.sub,
      mode: sess.mode,
      connection: sess.bot.connectionView(),
      pendingEvents: sess.events.length,
      watching: sess.watchdog?.status() ?? null,
    }))
  }
}


/* ======================== 看门狗（绑定到具体 McSession）======================== */

/**
 * 拿到（或创建）本会话的看门狗。
 * 看门狗要往会话里注入消息，必须绑 agent —— 在这里补齐并随时刷新引用。
 * @param gate - 可选：**模式闸门**，返回 false 时看门狗不往会话里注入（见 `Watchdog#gate`）。
 *   切出 MC 模式后仍 armed 的看门狗靠它闭嘴；切回 MC 模式自动恢复。
 */
function ensureWatchdog (ctx, sess, agent, promptSignal = null, gate = null) {
  if (!sess.watchdog) {
    // 注意：看门狗**不**往 sess.events 写（唯一写入方是 McSession.ensureWired）——
    // 两边都写会让同一句话进队列两遍。
    sess.watchdog = new Watchdog({ ctx, sess, agent, promptSignal })
  } else {
    if (agent) sess.watchdog.agent = agent
    if (promptSignal) sess.watchdog.promptSignal = promptSignal
  }
  if (gate) sess.watchdog.gate = gate
  return sess.watchdog
}


/* ============================ 插件主体 ============================ */

export function apply(ctx, rawConfig) {
  /* 拿得到 schemastery 时，宿主按 Config schema 把 `mentions` 的默认值填好；拿不到时（官方 desktop）
     cordis 原样透传（甚至整个 config 是 undefined）—— 这里兜一次。
     显式传了数组（包括空数组 = "不认任何叫法"）就尊重原值。 */
  const config = { ...(rawConfig ?? {}) }
  if (!Array.isArray(config.mentions)) config.mentions = [...DEFAULT_MENTIONS]
  const registry = new McRegistry(ctx, config)

  /* ── 插件状态目录（**配置 + 账户库**）：`$DSH_HOME/dsh-mc-agent/` ──────────────────
   * 🔴 2026-09-16 用户要求：配置和账户**不该躺在工作区里** —— 工作区是项目的家，
   *    插件有插件自己的家。宿主（app-boot）`ctx.provide('dshHomePath', …)` 给了这个路径，
   *    与 `$DSH_HOME/skills` / `.agent-presets` / `storages` / `attachments` 同一套规矩。
   * ------------------------------------------------------------------------ */
  const dshHomePath = (() => { try { return ctx.get('dshHomePath') } catch { return undefined } })()
  const stateDir = resolveStateDir({ dshHomePath, stateDirOverride: process.env.DSH_MC_AGENT_DIR })
  registry.lockDir = stateDir      // 会话锁文件也放插件自己的家（别写进插件包目录）

  /* ── 世界登记表（`<插件状态目录>/worlds.json`）：记忆「按世界分」时由它认定"哪个世界" ──────
   * 用户 2026-10-26：MC 设置里加选项「按世界存记忆 / 按会话存记忆」，
   * 且「因为如果是 dhcp 地址有可能会变」→ 不能直接拿地址当世界标识，得有一张可编辑的
   * 「地址 → 世界」对应表（同一个世界可以挂多个地址，DHCP 换地址后把新地址指过去即可）。
   * 详见 src/worlds.mjs 顶部注释。
   * ------------------------------------------------------------------------ */
  const worlds = new WorldRegistry(join(stateDir, WORLDS_FILE), { log: (m) => logLine(m) })

  /* ── 记忆 / 提示词：挂在**会话工作区**下，不再假设"插件装在工作区里" ──────────────
   * 抽取成标准插件后，包可能装在 `node_modules/` 或任意目录，**不能**再用 `__dirname/..` 推工作区。
   * 正路：宿主给工具的 `exec.agent.session.header.cwd` 就是该会话的工作区（tool-fs 同款来源）。
   * 记忆与提示词都挂它下面：`<工作区>/.dsh-mc-agent/`。
   * 优先级：`DSH_MC_AGENT_MEMORY_DIR` → `config.memoryDir` → `<工作区>/.dsh-mc-agent`
   *         （**没有会话上下文时**兜底 `DSH_MC_AGENT_DIR` 或 `$DSH_HOME/dsh-mc-agent/memory`）。
   * ------------------------------------------------------------------------ */
  /** 会话工作区（拿不到就 null：说明调用方没有 agent 上下文） */
  const workspaceOf = (agent) => {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
  }

  /* ── 记忆按什么分（用户 2026-10-26：「在 mc 设置里添加选项，可选按世界存记忆还是按会话存记忆」）──
   * `memoryScope` 三态（见 src/config.mjs）：
   *   · `'world'` = `<基根>/worlds/<世界目录>/`：同一世界开几个会话都共享一份，换世界换一份；
   *   · `'session'`         = `<基根>/sessions/<短会话 id>/`（2026-10-06 的补丁，现在只是取值之一）；
   *   · `'shared'`          = 老行为：全部共用基根（老配置 `memoryPerSession:false` 迁移过来就是它）。
   * 世界由 `src/worlds.mjs` 的登记表认定：服务器按地址、本地按存档名（`localWorldName`）；
   * 还没连过 / 认不出地址 → `<基根>/worlds/_unconnected/`（先放临时筐，绝不跟别的世界混在一起）。
   * ------------------------------------------------------------------------ */
  /** 会话 id（agent.id；拿不到就 null）—— 记忆按会话分时用它当文件夹名 */
  const agentIdOf = (agent) => {
    try {
      const id = agent?.id ?? agent?.session?.header?.id ?? null
      return id ? String(id) : null
    } catch { return null }
  }
  /** 会话 id → 安全的短文件夹名（`session-abc123` → `abc123`） */
  const sessionDirName = (id) => {
    const s = String(id).replace(/^session-/, '').replace(/[^A-Za-z0-9._-]/g, '_')
    return s.slice(0, 24) || 'default'
  }
  /**
   * 「这个工作区现在是谁的」兜底表。
   * 🔴 有些调用点只拿得到**工作区路径**（三个扩展的 `memoryFor(ws)`、GUI 设置页、express 路由），
   *    拿不到 agent。让 `getSession()`（每次工具调用都走）和提示词注入那处记一笔，
   *    这些调用点就能落到**当前会话**的记忆根；同一工作区同时跑两个会话才会有歧义
   *    （显式传了 agentId 的调用点不受影响）。
   */
  const lastAgentByCwd = new Map()
  const noteAgent = (agent) => {
    const id = agentIdOf(agent)
    const cwd = workspaceOf(agent)
    if (id && cwd) lastAgentByCwd.set(cwd, id)
    return id
  }

  /** 记忆**基根**（不含按世界/按会话分的子目录）—— 播种、默认提示词版本同步要的都是它 */
  const memoryBaseFor = (cwd) => {
    const explicit = process.env.DSH_MC_AGENT_MEMORY_DIR ?? pluginConfig.memoryDir
    return explicit || (cwd ? join(cwd, '.dsh-mc-agent') : (process.env.DSH_MC_AGENT_DIR ? stateDir : join(stateDir, 'memory')))
  }

  /**
   * 这个会话当前连的**世界**（登记表条目）；拿不到连接信息就 null。
   * 地址没登记过 → **自动登记**一个新世界（名字先取地址，之后可在「MC设置 → 记忆」里改名/归并）。
   * 只在 `memoryScope === 'world'` 时被调用（别的模式不碰登记表，行为与升级前一致）。
   */
  const worldOfSession = (agentId = null) => {
    const sess = agentId ? registry.peek(agentId) : null
    let conn = null
    try { conn = sess?.bot?.connectionView?.() ?? null } catch { conn = null }
    const host = normalizeHost(conn?.host)
    if (!host) return null
    // 本机**与局域网**都按存档名认（用户 2026-10-26：「局域网的 192.168.1.4:25565 联机，但还是按服务器存」）
    const local = isOwnHost(host)
    /* 存档名从哪来（只有自己开的服才这么认）：
     *   ① 进服时 ping 到的 MOTD 里 ` - ` 后面那段（`Bluezi - test` ⇒ `test`，见 learnWorldFromMotd）
     *   ② 设置里手填的「本地存档名」（`localWorldName`）
     *   ③ 都没有 ⇒ 退回 `localhost:<端口>` / `<ip>:<端口>`
     * 服务器名称（MOTD 前半段）**不参与** —— 用户 2026-10-26：「服务器名称不要影响世界名」。 */
    const localName = local ? (worlds.motdWorld(host, conn?.port) || pluginConfig.localWorldName) : ''
    const addr = addrKeyOf(conn, { localName })
    if (!addr) return null
    const hit = worlds.byAddr(addr)
    if (hit) return hit
    try {
      return worlds.ensure({ addr, name: local ? (localName || addr) : addr, local })
    } catch (e) {
      logDebug(`世界登记失败（记忆先落到 ${UNCONNECTED_KEY}）：${e?.message ?? e}`)
      return null
    }
  }

  /**
   * 进服后认一下**世界名**（用户 2026-10-26 指出的界面那行 `Bluezi - test`）：
   * 「对局域网开放」的 MOTD 固定是 `<玩家名> - <世界名>`，后半段就是存档名。
   * 认出来就写进内存缓存，`worldOfSession` 随即按它落目录 —— 比手填准，DHCP 换 IP 也不受影响。
   * 🔴 专用服不认：MOTD 是服主随手写的（「欢迎来到xx」），认错会把记忆扔进奇怪的目录。
   * 失败一律静默（ping 不到就沿用设置里的存档名），绝不阻断进服。
   * @returns {Promise<string>} 认出来的世界名；没认出来 = 空串
   */
  const learnWorldFromMotd = async (sess) => {
    if (pluginConfig.memoryScope !== 'world') return ''
    let conn = null
    try { conn = sess?.bot?.connectionView?.() ?? null } catch { return '' }
    const host = normalizeHost(conn?.host)
    if (!host || !isOwnHost(host)) return ''
    const port = Number(conn?.port) || 25565
    try {
      const p = await statusPing({ host, port, timeoutMs: 1500 })
      const wn = worldNameFromMotd(p?.motd)
      // 认不出来就清掉旧缓存（同一个地址换了存档、或服主改了 MOTD 格式）—— 别拿旧世界名硬套
      worlds.setMotdWorld(host, port, wn)
      if (wn) logDebug(`MOTD 认出世界名：${wn}（${host}:${port}）`)
      return wn
    } catch { return '' }
  }

  /** 记忆根（按 `memoryScope` 分；三态的落点见上面那段注释） */
  const memoryRootFor = (cwd, agentId = null) => {
    const base = memoryBaseFor(cwd)
    const scope = pluginConfig.memoryScope
    if (scope === 'shared') return base
    const id = agentId ?? (cwd ? lastAgentByCwd.get(cwd) ?? null : null)
    if (scope === 'session') return id ? join(base, 'sessions', sessionDirName(id)) : base
    const w = worldOfSession(id)
    return w ? join(base, WORLDS_DIR, w.dir) : join(base, WORLDS_DIR, UNCONNECTED_KEY)
  }

  /**
   * 老版本（≤0.3.x）把**全局** config/accounts 放在 `<工作区>/.dsh-mc-agent/`：每个工作区首次见到时搬一次。
   * ⚠️ config.json 现在是**本插件按工作区**的配置（src/wsconfig.mjs），不再是旧遗留：
   *    只搬"看着像旧全局配置"的（能解析、且不是本格式）；坏文件与新格式一概不碰。
   */
  const migratedWorkspaces = new Set()
  const migrateWorkspaceState = (cwd) => {
    if (!cwd || migratedWorkspaces.has(cwd)) return
    migratedWorkspaces.add(cwd)
    for (const [name, label] of [['config.json', '全局配置'], ['accounts.json', '账户库']]) {
      const from = join(cwd, '.dsh-mc-agent', name)
      const to = join(stateDir, name)
      try {
        if (existsSync(to) || !existsSync(from)) continue
        if (name === 'config.json') {
          let parsed = null
          try { parsed = JSON.parse(readFileSync(from, 'utf8')) } catch { parsed = null }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
          if (isWsConfigData(parsed)) continue     // 按工作区的新配置：不是遗留，别搬
        }
        mkdirSync(stateDir, { recursive: true })
        copyFileSync(from, to)
        if (readFileSync(to, 'utf8') === readFileSync(from, 'utf8')) unlinkSync(from)
        logLine(`已把${label}搬出工作区：${from} → ${to}`)
      } catch (e) { logLine(`${label}搬迁失败（保留旧位置）：${e.message}`) }
    }
  }

  /** 按工作区缓存 MemoryStore（同一工作区不重复扫盘） */
  const memoryCache = new Map()
  const memoryFor = (cwd, agentId = null) => {
    const root = memoryRootFor(cwd, agentId)
    let store = memoryCache.get(root)
    if (!store) {
      migrateWorkspaceState(cwd)
      // 🔴 `create:false`：**读**记忆不该顺手把 `.dsh-mc-agent/` 建出来。
      //    建目录/建行事准则（RULES.md）只发生在"首次发起 MC 模式会话"与"点开 MC设置"这两个时机
      //    （用户 2026-09-16 定），由 `ensureMemoryRoot` 显式做。
      store = new MemoryStore(root, { create: false })
      memoryCache.set(root, store)
    }
    return store
  }

  /** 按工作区的配置（`<记忆根>/config.json`，src/wsconfig.mjs）：读值 / 改三个提示词开关 */
  const wsCfgValues = (cwd) => workspaceConfigValues(memoryRootFor(cwd))
  const wsCfgPatch = (cwd, partial) => patchWorkspaceConfig(memoryRootFor(cwd), partial)

  const pluginConfig = new PluginConfig(stateDir)
  /** 无会话上下文时用的兜底记忆库（`capabilities` / 扩展 api / 全局注入用） */
  const memory = memoryFor(null)
  /**
   * 把「游戏内聊天 → 记忆」的钩子挂到会话的 bot 上（用户 2026-10-20：「记忆加和玩家游戏内的聊天记录」）。
   *
   * 为什么挂在 `onChatLine`（而不是看门狗/工具里）：`src/chat.mjs` 的 `pushChat()` 是**所有**聊天行的
   * 唯一入口（玩家说的、我自己 `mc_say` 说的、系统消息），钩在那儿一条不漏、也不用重复判包。
   * 钩子只记 `player` / `self`，系统消息不进文件（那部分看门狗的事件队列已经记了）。
   * 写盘失败只会记一行 debug 日志 —— 聊天本身绝不能被记忆搞挂。
   */
  const attachChatLog = (sess, agent) => {
    try {
      const bot = sess?.bot
      if (!bot) return null
      const store = memoryFor(workspaceOf(agent), agentIdOf(agent))
      bot.onChatLine = (entry) => {
        if (!pluginConfig.chatLog) return
        const r = recordChat(store, entry, { keepDays: pluginConfig.chatLogDays })
        if (r && r.written === false && r.why === 'error') logDebug(`聊天记录没写进去：${r.error}`)
      }
      return store.root
    } catch (e) {
      logDebug(`挂「聊天记录」钩子失败（不影响游戏）：${e?.message ?? e}`)
      return null
    }
  }
  /** 这个会话的工作区根（mc_kit_image / 地图落盘用）；拿不到就给个兜底目录 */
  const workspaceRootFor = (agent) => workspaceOf(agent) ?? join(stateDir, 'workspace')

  /**
   * 按 sessionId 找**这个会话选中的工作区**：
   *   ① 活着的 agent（`agent.session.header.cwd`，首选，最准）；
   *   ② 冷会话 → 问宿主的 `sessionQuery.listSessions()`（header 里有 cwd）。
   * 都没有 = 这个会话没选工作区（用户 2026-09-16：那种情况要**拒绝** MC 模式与 MC设置）。
   */
  const workspaceOfSession = async (sessionId) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return null
    const live = workspaceOf(safeAgentById(sid))

    if (live) return live
    try {
      const q = ctx.get('sessionQuery')
      const records = await q?.listSessions?.()
      const rec = (records ?? []).find((r) => String(r?.header?.id ?? r?.id ?? '') === sid)
      const cwd = rec?.header?.cwd ?? rec?.cwd ?? null
      return typeof cwd === 'string' && cwd.trim() ? cwd : null
    } catch { return null }
  }

  /** 按 sessionId 找 agent（HTTP 那几个接口用；拿不到就 null） */
  const safeAgentById = (sessionId) => {
    if (!sessionId) return null
    try { return ctx.get('agents')?.get?.(String(sessionId)) ?? null } catch { return null }
  }
  /* 🔴 2026-10-06（本机补丁）：原来这里写死"记忆 <会话工作区>/.dsh-mc-agent"，
   *    可 用户 一设 `config.memoryDir`（本机就把记忆挪到了 $DSH_HOME/dsh-mc-agent/memory），
   *    这行日志就会骗人。改成打印**真实生效的记忆根**。 */
  /* 🔴 2026-10-06（日志优化）：加**版本号**与日志级别 —— 以前日志里没有任何版本标记，
   *    今天修的行和几天前的旧行混在一起根本分不出是哪份代码打出来的。 */
  logLine(`dsh-mc-agent v${PLUGIN_VERSION}：配置 ${pluginConfig.file}｜记忆 ${memory.root}`
    + `（没设 memoryDir 时才是 <会话工作区>/.dsh-mc-agent）`
    + `｜工具定义 ${toolDefKind() === 'host' ? '宿主 @deepseek-ai/dsh-tools' : '自带兜底'}`
    + `｜Config ${Config ? 'schema（宿主 schemastery）' : '无（宿主 schemastery 不可用）'}`
    + `｜日志 ${['quiet', 'info', 'debug'][logLevel()] ?? 'info'}（MC_LOG_LEVEL 可调）`)

  /* ─────────── 发布区（`.dsh-mc-agent/.express/`）：地址用**工作区 uuid** ───────────
   * 用户 2026-09-17 定稿：`<base>/api/dsh-mc-agent/express/<工作区 uuid>/<剩余路径>`。
   * uuid 直接从宿主的工作区注册表拿（`ctx.workspaceRegistry.list()` 是**同步**的，`path` 已 realpath 规范化）——
   * 不再用"目录名 + 进程内见过的工作区集合"那套（同名会撞、改名会失效、重启要重新见过）。
   * 🔴 用户定的兜底是 **(a) 拒绝**：注册表里查不到这个 cwd 对应的 uuid 就不分享（不退回目录名）。
   * ------------------------------------------------------------------------ */
  /* ── 「MC设置 → 更新」用的插件作用域状态 ──────────────────────────────────
   * 🔴 2026-10-20 真机踩的：这三个原来写在 `handleSettingsApi` 里 ⇒
   *    ① 每次请求都是新的 `updateCache`，10 分钟缓存**等于没做**（每次开页面都真去 git fetch）；
   *    ② 同一函数里"路由在前、`const checkUpdate` 在后" ⇒ 一调就 TDZ 抛
   *       `Cannot access 'checkUpdate' before initialization`。
   *    状态放这儿、函数留在下面（函数按请求重建无所谓，缓存必须跨请求）。
   * ------------------------------------------------------------------------ */
  const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))
  const UPDATE_TTL_MS = 10 * 60 * 1000
  const updateCache = { at: 0, data: null }
  /** 启动后多久查第一次更新：别跟插件初始化抢资源，也别让首屏等它 */
  const START_UPDATE_CHECK_MS = 15_000
  const EXPRESS_MAX_BYTES = 32 * 1024 * 1024

  /** 宿主的工作区注册表（可能还没就绪 → 返回空表，别抛） */
  const workspaceRows = () => {
    try {
      const rows = ctx.get('workspaceRegistry')?.list?.()
      return Array.isArray(rows) ? rows : []
    } catch { return [] }
  }

  /** cwd → 工作区 uuid（比对 realpath 规范化后的路径；查不到 = null） */
  const workspaceIdOfCwd = (cwd) => {
    const s = typeof cwd === 'string' ? cwd.trim() : ''
    if (!s || !isAbsolute(s)) return null
    let real = s
    try { real = realpathSync(s) } catch { /* 目录可能还不存在，就用原样比 */ }
    for (const w of workspaceRows()) {
      const p = String(w?.path ?? '')
      if (p && (p === real || p === s)) return String(w.id)
    }
    return null
  }

  /** 工作区 uuid → cwd（注册表里的规范路径） */
  const workspaceCwdById = (id) => {
    const key = String(id ?? '')
    if (!key) return null
    for (const w of workspaceRows()) if (String(w?.id) === key) return String(w.path)
    return null
  }

  /** cwd → 工作区显示名（注册表里的 `title`；查不到 = null。前端回退路径尾段） */
  const workspaceTitleOfCwd = (cwd) => {
    const s = typeof cwd === 'string' ? cwd.trim() : ''
    if (!s || !isAbsolute(s)) return null
    let real = s
    try { real = realpathSync(s) } catch { /* 目录可能还不存在，就用原样比 */ }
    for (const w of workspaceRows()) {
      const p = String(w?.path ?? '')
      if (p && (p === real || p === s)) {
        const title = String(w?.title ?? '').trim()
        return title || null
      }
    }
    return null
  }

  /* ─────────── 「文件分享」页要的两件事：看现状 / 清除数据（用户 2026-09-17 定）───────────
   * · 现状 = 这个工作区的发布区在哪、攒了几个文件、多大（分享模式本身是全局配置，见 configView）；
   * · 清除 = 用户确认后把 `.express/` 下的东西**全删掉**（目录自己留着，AI 不用重新建）。
   * 🔴 目录永远由服务端按「工作区 + `.dsh-mc-agent/.express`」推出来，**不接受任何用户给的路径**。
   * ------------------------------------------------------------------------ */
  const sharedStat = (cwd) => {
    const root = expressRootOf(memoryRootFor(cwd))
    let files = 0
    let bytes = 0
    const walk = (dir) => {
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) { walk(p); continue }
        if (!ent.isFile()) continue
        files++
        try { bytes += statSync(p).size } catch { /* 读不到大小就当 0 */ }
      }
    }
    if (existsSync(root)) walk(root)
    return { dir: root, exists: existsSync(root), files, bytes }
  }

  const clearShared = (cwd) => {
    const root = expressRootOf(memoryRootFor(cwd))
    const before = sharedStat(cwd)
    if (!existsSync(root)) return { ...before, existed: false, removed: 0 }
    try {
      rmSync(root, { recursive: true, force: true })     // 连目录一起删（里面有符号链接也只删链接本身）
      mkdirSync(root, { recursive: true })               // 立刻重建：发布区随时可用
    } catch (e) {
      throw new Error(`清除分享数据失败：${e.message}`)
    }
    logLine(`「文件分享」清除分享数据：${root}（${before.files} 个文件 / ${before.bytes} 字节）`)
    return { ...before, existed: true, removed: before.files }
  }

  /* ─────────── 「MC设置 → 记忆」页要的两件事：看目录内容 / 打开所在位置 ───────────
   * 用户 2026-10-20：「把『文件分享』那页改成『记忆』，分享那些开关一律不要了，
   *   只显示**这个会话的记忆文件在哪**（lessons.md / world.md …），并且能打开文件夹」。
   * 🔴 目录照旧由服务端推导（`memoryRootFor`），**不接受客户端给的任意路径**。
   * ------------------------------------------------------------------------ */
  const memoryDirView = (dir, { agentId = null } = {}) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { entries = [] }
    const files = []
    const dirs = []
    for (const ent of entries) {
      const name = String(ent.name ?? '')
      // 内部件（`.express` / `.out` / `config.json` 这类点开头的）不往外列
      if (!name || name.startsWith('.')) continue
      if (ent.isDirectory()) { dirs.push({ name }); continue }
      if (!ent.isFile()) continue
      let st = null
      try { st = statSync(join(dir, name)) } catch { /* 读不到大小就只给名字 */ }
      files.push({ name, bytes: st ? st.size : null, mtime: st ? st.mtimeMs : null })
    }
    /** README.md 排最前（它是索引），其余按名字排 —— 让用户一眼看到"从哪开始读" */
    const rank = (n) => (n === 'README.md' ? 0 : 1)
    files.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    const scope = pluginConfig.memoryScope
    const world = scope === 'world' ? worldOfSession(agentId) : null
    return {
      dir,
      exists: existsSync(dir),
      /** 记忆分法（`world` / `session` / `shared`）—— 页面顶部的选择器读它 */
      memoryScope: scope,
      /** 兼容老字段：以前只有"按会话分"一个开关 */
      memoryPerSession: scope === 'session',
      /** `memoryScope === 'world'` 时：这份记忆属于哪个世界（没连过 = null，目录落在 `_unconnected`） */
      world: world ? worlds.viewOf(world) : null,
      /** 本地存档名（页面上的输入框读它；只有连本地服才有意义） */
      localWorldName: pluginConfig.localWorldName,
      files,
      dirs,
    }
  }

  /**
   * 用系统文件管理器打开记忆目录（给了 `name` 就在里面**选中**那个文件）。
   *
   * 为什么放在服务端：浏览器拿不到本地路径，只能让宿主机去开。
   * `name` 只认**文件名**（`basename`），拼路径前先剥掉目录部分 —— 不让它跳出记忆根。
   */
  const openInFileManager = async (dir, name = null) => {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }) } catch (e) { throw new Error(`记忆目录不存在，也建不出来：${e.message}`) }
    }
    const nm = name ? basename(String(name)) : ''
    const picked = nm && existsSync(join(dir, nm)) ? join(dir, nm) : null
    const target = picked ?? dir
    const { spawn } = await import('node:child_process')
    const plat = process.platform
    const [cmd, args] = plat === 'win32'
      ? ['explorer.exe', picked ? ['/select,' + picked] : [dir]]
      : plat === 'darwin'
        ? ['open', picked ? ['-R', picked] : [dir]]
        : ['xdg-open', [picked ? dirname(picked) : dir]]
    await new Promise((resolvePromise) => {
      let done = false
      const fin = (err) => { if (done) return; done = true; resolvePromise(err) }
      let child = null
      try {
        child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      } catch (e) {
        return fin(e)
      }
      child.on?.('error', (e) => fin(e))
      child.unref()
      /* 🔴 explorer.exe 常驻不退出（它自己就是外壳），不能等它 exit —— 800ms 没报错就当开成了 */
      setTimeout(() => fin(null), 800)
    })
    logLine(`「记忆」打开所在位置：${target}`)
    return { opened: true, dir, target }
  }

  /**
   * 「当前地址」= 浏览器**实际在用**的那个地址（在线 base 的默认值 / 「获取当前」按钮的值）。
   *
   * 精度从高到低：
   *   ① **浏览器自己报的** `clientOrigin`（查询参数，前端塞 `location.origin`）——
   *     协议/域名/端口都是它真在用的，反代终止 TLS 也不会错。只认 host 与请求 Host 一致的；
   *   ② `Origin` 请求头；
   *   ③ `Referer`（只取 origin，且 host 必须与 Host 一致）；
   *   ④ `X-Forwarded-Proto` + `Host`；
   *   ⑤ `Host` + socket 是否 TLS。
   * 都拿不到就回 `''`（前端提示手填）。
   *
   * 🔴 为什么必须有 ①/③ 这两档：用户可能从 `https://域名` 访问、而 TLS 是**反代终止**的
   * （转发到本机是明文 http，代理也未必带 `X-Forwarded-Proto`）—— 只看 Host 会推出 `http://域名`：
   * 协议错，图片会被浏览器当混合内容挡掉。
   * ⚠️ DSH **没有"挂载前缀"概念**（`API_PATH` 是常量 `/api`，前端一律用根绝对路径调接口），
   * 所以反代额外加的路径前缀不可能自动得知 —— 那种情况由用户自己补（前缀会原样拼在 base 后面）。
   */
  const currentBaseOf = (req, hints = {}) => {
    const host = String(req?.headers?.host ?? '').trim()
    const sameHost = (value) => {
      try { return Boolean(host) && new URL(value).host === new URL(`http://${host}`).host } catch { return false }
    }
    const originPart = (value) => {
      try {
        const u = new URL(String(value))
        return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.host}` : ''
      } catch { return '' }
    }
    // ① 浏览器报上来的（最准：协议/域名/端口都是它真在用的）——服务端不裁剪它；host 必须与请求 Host 一致
    const hint = normalizeExpressBase(hints.clientOrigin)
    if (hint && sameHost(hint)) return hint
    // ② Origin 头
    const o = normalizeExpressBase(originPart(req?.headers?.origin))
    if (o) return o
    // ③ 同源 Referer
    const ref = originPart(req?.headers?.referer)
    if (ref && sameHost(ref)) {
      const r = normalizeExpressBase(ref)
      if (r) return r
    }
    if (!host) return ''
    // ④ 反代声明的协议 + Host；⑤ Host + socket
    const fwd = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
    const proto = fwd === 'https' || fwd === 'http' ? fwd : (req?.socket?.encrypted ? 'https' : 'http')
    return normalizeExpressBase(`${proto}://${host}`) ?? ''
  }

  /* ─────────── MC账户库：元数据在 $DSH_HOME/dsh-mc-agent/accounts.json，凭据只进宿主凭据服务 ───────────
   * 🔴 LLM 永远拿不到密码/token：工具只回基本信息；凭据只在这两个 helper 里出现，且不外传。
   * ------------------------------------------------------------------------ */
  const accounts = new AccountStore({ dir: stateDir, logger: ctx.logger ?? null })
  /* 正版账户的令牌缓存**不在**宿主凭据服务里，而是 `prismarine-auth` 自己的一堆 json 文件
     （`<stateDir>/msa/<innerID>/`）。账户库要能回答"这个正版号登录过没有"，就得知道目录怎么算。 */
  accounts.msaDirOf = (innerID) => msaCacheDir(stateDir, innerID)
  /* 🔴 2026-10-15 审计（报告 E 第 1 条）：账户库读失败时**绝不能** `ensureDefaults()` + 写盘 ——
   *    那会把用户的账户库覆盖成"空库 + 一个默认离线号"，账户**永久丢失**（旧代码就是这么干的，
   *    而且一声不响）。读失败时只报错、不动盘，让人去修文件或从备份恢复。 */
  if (accounts.loadFailed) {
    logLine(`🔴 账户库读取失败，已按空库运行但**不会写盘**：${accounts.loadError ?? '原因不明'}`
      + `\n　　→ 请先修好 ${accounts.file}（比如从备份恢复）；在那之前「MC设置」里的账户列表是空的，且任何改动都不会保存。`)
  } else {
    accounts.ensureDefaults()
  }
  /** 「连接到MC」弹窗的服务器地址历史（**全局**，只存地址；见 src/serverhistory.mjs） */
  const serverHistory = new ServerHistory({ dir: stateDir, log: logLine })
  /* 🔴 2026-10-26 审计：`loadFailed` / `loadError` 这对访问器是 2026-10-15 为"读失败要说一声"加的，
   *   但加完之后**没有任何地方读它** ⇒ 服务器历史读坏了照样静默按空跑。照 accounts 的样子在这里报一次。 */
  if (serverHistory.loadFailed) {
    logLine(`🔴 服务器地址历史读取失败，已按空跑（列表是空的，但之后新记的会覆盖写回）：${serverHistory.loadError ?? '原因不明'}`
      + `\n　　→ 文件：${serverHistory.file}`)
  }
  // 凭据服务可能晚就绪 → 必须 ctx.inject 等（老教训：apply() 时 ctx.get() 常是 undefined）
  ctx.inject(['credentials'], (scope) => {
    accounts.credentials = scope.get('credentials') ?? null
    // 🔴 必须 catch：未处理的 Promise 拒绝会被宿主的 fail-loud 当致命错误 → exit(1)（2026-09-17 真炸过）
    void accounts.refreshCredentialIndex().then(() => {
      logDebug(`账户库就绪：${accounts.list().length} 个账户｜凭据服务 ${accounts.credentialsReady ? '可用' : '不可用（拒绝存密码）'}`)
    }).catch((e) => { logLine(`凭据索引刷新失败（不影响启动）：${e?.message ?? e}`) })
  })

  /** 账户 → core 的 auth 描述符（**唯一**读凭据的地方；返回值含密码，绝不外传） */
  const resolveAuth = async (innerID = null) => {
    const acc = accounts.resolve(innerID)
    if (!acc) {
      const e = new Error('一个账户都没有——请在「MC设置」里新建一个（默认应该有一个离线账户 DeepSeek）')
      e.needUserAction = true
      throw e
    }
    const view = accounts.view(acc)
    if (acc.type === 'offline') {
      return { innerID: acc.innerID, label: view.name, auth: { mode: 'offline', name: view.name, uuid: view.uuid } }
    }
    /* 正版（Microsoft）：凭据是 `prismarine-auth` 的**令牌缓存文件**，没有密码、也没有我们自己的 token。
       邮箱必填（缓存文件名认它）。登录本身不在这里做 —— 那是「MC设置 → 账户」里的一次设备码流程。 */
    if (acc.type === 'microsoft') {
      const email = String(acc.login ?? '').trim()
      if (!email) {
        const e = new Error(`正版账户「${view.name}」没有填微软邮箱`)
        e.needUserAction = true
        e.hint = '请在「MC设置」里给它补上邮箱，再点「登录」走一遍设备码'
        throw e
      }
      if (!msaSupported()) {
        const e = new Error('这台机器上找不到 prismarine-auth，正版登录用不了')
        e.needUserAction = true
        e.hint = '它应该跟 mineflayer 一起装在插件依赖里；缺了就重装一次插件'
        throw e
      }
      return {
        innerID: acc.innerID,
        label: view.name,
        auth: { mode: 'microsoft', msaEmail: email, msaCacheDir: msaCacheDir(stateDir, acc.innerID) },
      }
    }
    const srv = accounts.listAuthServers().find((s) => s.id === acc.serverId)
    if (!srv) {
      const e = new Error(`账户「${view.name}」用的认证服务器已经被移除了`)
      e.needUserAction = true
      e.hint = '请在「MC设置」里给这个账户换一个认证服务器，或删掉它'
      throw e
    }
    const cred = await accounts.getCredential(acc.innerID)
    if (!cred?.password && !cred?.accessToken) {
      const e = new Error(`账户「${view.name}」还没有保存的登录凭据`)
      e.needUserAction = true
      e.hint = '请在「MC设置」里重新登录这个账户（输入账号密码）'
      throw e
    }
    return {
      innerID: acc.innerID,
      label: view.name,
      auth: {
        mode: 'yggdrasil',
        authUrl: srv.url,
        authUser: acc.login ?? null,
        authPass: cred.password ?? null,
        accessToken: cred.accessToken ?? null,
        clientToken: cred.clientToken ?? null,
      },
    }
  }

  /**
   * 登录成功后回写：皮肤站账户把**档案名/UUID/账号 id** 更新进账户库，并把**新令牌**存回凭据服务。
   * ⚠️ 只对皮肤站账户做 name/uuid 覆盖：离线账户的 UUID 是"按名字派生"的，写死会毁掉这个语义。
   */
  const persistAuth = async (resolved, profile, session) => {
    try {
      const acc = accounts.get(resolved.innerID)
      if (!acc) return
      if (acc.type === 'yggdrasil' || acc.type === 'microsoft') {
        const patch = {}
        const uuid = dashUuid(profile?.id)
        if (uuid) patch.uuid = uuid
        if (profile?.name) patch.name = String(profile.name)
        if (session?.user?.id) patch.id = String(session.user.id)
        if (Object.keys(patch).length) accounts.update(resolved.innerID, patch)
        /* ⚠️ 只有皮肤站把令牌写进宿主凭据服务：正版的令牌归 `prismarine-auth` 自己管
           （写在 `<stateDir>/msa/<innerID>/`），我们**不碰**它 —— 抄一份反而会两边不同步。 */
        if (acc.type === 'yggdrasil' && session?.accessToken) {
          const cur = await accounts.getCredential(resolved.innerID)
          await accounts.setCredential(resolved.innerID, {
            password: resolved.auth.authPass ?? cur?.password ?? null,
            accessToken: session.accessToken,
            clientToken: session.clientToken ?? cur?.clientToken ?? null,
          })
        }
      }
      await accounts.refreshCredentialIndex()
    } catch (e) { ctx.logger?.warn?.(`[dsh-mc-agent] 回写账户信息失败：${e.message}`) }
  }

  /** 把"需要用户处理"的提示拼进错误里（让 LLM 知道该叫用户去「MC设置」） */
  const withUserHint = (e, label) => {
    if (!e?.needUserAction) return e
    const hint = e.hint ?? '请让用户在「MC设置」里重新登录这个账户，或点它的「刷新」'
    const out = new Error(`${e.message}｜${hint}${label ? `（账户：${label}）` : ''}`)
    out.needUserAction = true
    return out
  }

  // 注入用的 AbortSignal（插件生命周期）。`sessionController.prompt` 是 @Remote 方法，
  // 签名 (request, signal)，**必须传 signal**——否则 undefined.throwIfAborted() 直接炸。
  const promptAbort = new AbortController()
  ctx.effect(() => () => { try { promptAbort.abort() } catch {} }, 'dsh-mc-agent: prompt signal')

  ctx.effect(() => () => { registry.destroyAll() })

  /* ─────────── HTTP API：状态条 UI 用（状态查询 / 强制停止 / 普通停止）─────────── */

  /** 运行期信任列表（--trusted-host 等） */
  const liveTrustedHosts = () => {
    const runtime = ctx.get('webRuntime')
    return runtime !== undefined && Array.isArray(runtime.trustedHosts) ? runtime.trustedHosts : []
  }

  /**
   * **强制停止**某个会话的 MC —— 用户 2026-09-16 定的语义与顺序：
   *
   *   ① **先停 LLM**（如果它正在输出）。不先停的话：它还会继续调工具、甚至把刚退掉的游戏重连回来。
   *      中断之所以有效，靠的是工具侧 raceAbort 监听 exec.signal —— 宿主自己**没有**硬中断能力
   *      （`tools/index.ts:219` 原话 "cannot hard-kill same-process code"），所以"让工具必然结算"是唯一出路。
   *   ② **先尝试优雅退出游戏**（`bot.quit` + 宽限期，真走不掉才强断；见 src/core.mjs 的 disconnect）。
   *   ③ **再强清该会话全部后台任务**（看门狗就在里面）。
   *   ④ **最后再停一次 LLM**：②③期间会有退服事件/注入（"你被踢了"、工具被 abort 的结算）可能又把它推起来，
   *      收尾再停一次，避免会话停在异常状态。
   *
   * ⚠️ **普通停止已移除**（用户要求："移除停止，只剩强行停止"）。唯一的例外是 `cancelTurn:false`：
   * 给 **AI 自己调 `mc_stop`** 用——工具就跑在被停的那一轮里，cancel 会 abort 掉它自己所在的 turn
   * （表现为 "tool call aborted"，真机报告过）。UI 的按钮走 HTTP，用默认的 cancelTurn:true。
   *
   * @param {string} sessionId
   * @param {{reason?: string, cancelTurn?: boolean}} [opts]
   */
  const stopSession = async (sessionId, { reason = '用户强制停止', cancelTurn = true } = {}) => {
    const sess = registry.peek(sessionId)
    const agents = ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    const out = {
      sessionId, reason, order: [],
      stoppedLLM: false, finalStopLLM: false, stopLLMError: null,
      /* 🔴 审计：这个字段原来是 `kicked`（"被踢"），但它其实只在**主动优雅退出成功**时置真
       * （真正的异常在下面的 catch 里记 `quitError`）—— 名字跟语义反了，而且 `out` 会 JSON
       * 给前端看。改名 `quitOk`。 */
      quit: null, quitOk: false, killedJobs: [],
      /* 调度器清账的结果（见 ② 后面的 `releaseAll`）—— 清不掉要说出来，别假装干净了 */
      released: null, releaseError: null,
    }

    /** 停 LLM：优先 sessionController.cancel（宿主正路），退到 agent.cancel */
    const cancelLLM = () => {
      try {
        const sc = ctx.get('sessionController')
        if (typeof sc?.cancel === 'function') { sc.cancel({ sessionId }); return true }
        if (typeof agent?.cancel === 'function') { agent.cancel({ kind: 'user' }, { keepInbox: true }); return true }
      } catch (e) { out.stopLLMError = String(e?.message ?? e) }
      return false
    }

    /**
     * 等它真的停下来（running → 其它）。拿不到 status 就只给一小段缓冲，别白等。
     * 详见 packages/core/agent-loop/src/agent.ts 的 `get status()`。
     */
    const waitIdle = async (ms) => {
      const known = agent?.status !== undefined
      const budget = known ? ms : Math.min(ms, 120)
      const t0 = Date.now()
      while (Date.now() - t0 < budget) {
        if (known && agent.status !== 'running') return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return !known
    }

    // ① 先停 LLM
    if (cancelTurn) {
      out.stoppedLLM = cancelLLM()
      out.order.push('stop-llm')
      await waitIdle(1500)
    }

    // ② 先尝试退出游戏（关看门狗 → 优雅 quit → 走不掉才强断）
    if (sess?.watchdog) { try { sess.watchdog.disarm(reason, { notify: false }) } catch {} }
    if (sess) {
      try {
        out.quit = await sess.bot.disconnect(reason)
        out.quitOk = true
      } catch (e) { out.quitError = String(e?.message ?? e) }
      sess.mode = 'standby'
      out.order.push('quit-game')
    }
    /* 🔴 2026-10-16 审计（P0-1，场景一）：**调度器要在"停"这条路上显式清一次**。
     *   断线确实会 `releaseAll`（`src/connection.mjs` 的 `end` 事件），但那条路只在
     *   **真的从在线变成离线**时走 —— 机器人本来就掉线、或者强断失败时，`end` 不会再响，
     *   而表里可能还留着上一轮的动作（它们占着 movement / interaction 不放）。
     *   人按「强制停止」的语义就是"全都停下"，所以这里不依赖事件、直接清。 */
    try {
      const rel = sess?.bot?.actionScheduler?.()?.releaseAll?.(`强制停止：${reason}`)
      out.released = rel ?? null
    } catch (e) { out.releaseError = String(e?.message ?? e) }

    // ③ 再强清该会话全部后台任务
    //
    // 🔴 2026-09-24：**只杀属于本会话的 job**。宿主 `jobs-local` 的 `list(caller)` 口径是
    //    `job.owner === undefined || job.owner.id === session` —— 除了自己的，它**还会把
    //    `owner === undefined` 的"无主 job"（宿主自己起的后台任务）一起列出来**；
    //    而 `assertAccess()` 是 `if (job.owner !== undefined && ...) throw`，**对无主 job 不设防**。
    //    照旧代码那样"列出来就全杀"，点一次「强制停止」会顺手清掉跟这个会话毫无关系的宿主任务。
    //    （同一个坑 PR #2 的作者也报过，见 <user>/dsh-mc-agent#2。）
    //    🔴 2026-10-04（同 PR #2）：`caller` 必须是**会话 id 字符串**——`list(caller)` 内部
    //    按 `job.owner.id === caller` 过滤、`kill(id, caller)` 的 `assertAccess` 也一样；
    //    传 agent 对象时"自己的 job 一个都列不出来、也杀不掉"（还会把无主 job 列出来）。
    //    判据用**快照里带的 owner 身份**，两种宿主版本的字段名都认：
    //    `ownerSession`（本版）/ `owner`（0.1.7 起）。
    const jobs = ctx.get('jobs')
    if (jobs && typeof sessionId === 'string' && sessionId) {
      try {
        for (const j of jobs.list(sessionId) ?? []) {
          const id = j?.id ?? j?.jobId
          if (!id) continue
          /* 🔴 审计：`owner` 在宿主里是**对象**（`{ id, … }`），旧写法直接拿它跟 sessionId
           * 字符串比 ⇒ 恒不相等 ⇒ `mc_stop` 的 `killedJobs` 永远是空的、job 其实还在跑，
           * 而外层 `catch {}` 把一切吞掉，界面上却显示"已清理"。两种形状都认。 */
          const o = j?.ownerSession ?? j?.owner
          const ownerOf = (o && typeof o === 'object') ? (o.id ?? o.sessionId ?? null) : (o ?? null)
          if (ownerOf !== sessionId) continue          // 无主 job / 别人的 job：不归我们管
          try { jobs.kill(id, sessionId, reason); out.killedJobs.push(id) } catch {}     // eslint-disable-line no-empty
        }
      } catch (e) { out.jobsError = String(e?.message ?? e) }
    }
    out.order.push('kill-jobs')

    // ④ 最后再停一次 LLM（收尾，避免状态异常）
    if (cancelTurn) {
      out.finalStopLLM = cancelLLM()
      out.order.push('stop-llm-final')
      await waitIdle(800)
    }

    ctx.logger?.info?.(`[dsh-mc-agent] 强制停止 ${sessionId}｜${JSON.stringify(out)}`)
    return out
  }

  /* ─────────── 归档保护（用户 2026-09-15 补充要求）───────────
   * "会话归档前要自动强行停止，或者阻止归档。"
   *
   * 做法：包一层 `ctx.workspaceRegistry.archiveSession`。归档一个正在玩 MC 的会话时，
   * 先把机器人踢下线、关看门狗、清后台任务、中断当前轮，**再**放行归档。
   * 选择"自动停止"而不是"阻止归档"——用户想归档就该让它归档，只是别留个孤儿 bot 在线。
   *
   * 为什么能包：`archiveSession` 是 workspace 服务上的普通方法（`workspace/src/index.ts:243`），
   * 不是抽象/私有；卸载时还原原方法。
   * ------------------------------------------------------------------------ */

  /**
   * 安装归档保护。
   *
   * ⚠️ 必须在 `workspaceRegistry` **就绪之后**才能装：`apply()` 跑的时候它往往还没起来，
   *    `ctx.get('workspaceRegistry')` 会返回 undefined（隔离实例实测踩到）。
   *    正解是 `ctx.inject(['workspaceRegistry'], cb)` —— 服务就绪（或重新就绪）时回调，
   *    并且回调里的 `scope.effect` 把还原逻辑挂在**那个 fiber** 上。
   *    参照宿主自己的写法：`packages/client/modules/src/index.ts:576`。
   */
  const installArchiveGuard = (scope) => {
    const wsRegistry = scope.get('workspaceRegistry')
    if (!wsRegistry || typeof wsRegistry.archiveSession !== 'function') {
      logLine('宿主没有 workspaceRegistry：归档保护未启用')
      return
    }
    const originalArchive = wsRegistry.archiveSession
    wsRegistry.archiveSession = async function (sessionId) {
      const id = String(sessionId)
      const sess = registry.peek(id)
      if (sess && (sess.bot?.online || sess.watchdog?.armed)) {
        logLine(`会话 ${id} 将被归档 → 先强制停止 MC`)
        try {
          await stopSession(id, { reason: '会话被归档' })
        } catch (e) {
          logLine(`归档前停止失败（仍继续归档）：${e.message}`)
        }
      }
      return originalArchive.call(this, sessionId)
    }
    scope.effect(() => () => { wsRegistry.archiveSession = originalArchive }, 'dsh-mc-agent: archive guard')
    logDebug('已挂上归档保护（归档前自动停止 MC）')
    scope.logger?.info?.('[dsh-mc-agent] 已挂上归档保护（归档前自动停止 MC）')
  }

  if (ctx.get('workspaceRegistry') === undefined) {
    ctx.inject(['workspaceRegistry'], (scope) => installArchiveGuard(scope))
  } else {
    installArchiveGuard(ctx)
  }

  /**
   * 「MC设置」模态框的后端（账户 / 认证服务器 / 指令白名单）。
   * 🔴 响应里**永远没有密码或 token**；错误统一 200 + `{ok:false,error,needUserAction?,hint?}`，
   *    这样前端只管解析 JSON，不用管状态码。
   */
  let authProbe = null
  const probeBot = () => (authProbe ??= new McBot({ instanceId: 'auth-probe', lockDir: stateDir }))

  /**
   * 设置页要的那几项配置（集中一处，GET/PATCH 共用）。
   * 全局键来自 PluginConfig（`$DSH_HOME/dsh-mc-agent/config.json`）；
   * 三个提示词开关是**按工作区**的（`<记忆根>/config.json`，src/wsconfig.mjs）。
   *
   * 🔴 `cwd` 可为 **null**（从插件菜单等"无会话/无工作区"入口打开设置时）：
   *    此时只回全局键，工作区键一律 `null`。**绝不能**把 null 喂给
   *    `wsCfgValues` / `wsConfigPath(memoryRootFor(null))` —— `memoryRootFor(null)`
   *    会兜底到 `stateDir(/memory)` 这个**全局**目录（见 memoryRootFor），
   *    那等于把"无工作区"错当成一个真实工作区去读写。
   */
  const configView = (cwd) => {
    const hasWorkspace = Boolean(cwd)
    const ws = hasWorkspace ? wsCfgValues(cwd) : null
    return {
      hasWorkspace,
      workspaceName: hasWorkspace ? workspaceTitleOfCwd(cwd) : null,
      commandWhitelist: pluginConfig.get('commandWhitelist'),
      allowAllCommands: pluginConfig.get('allowAllCommands'),
      /* 「指令白名单」页那一排开关：目录（名字 + 说明 + danger）由 `src/commands.mjs` 给，
       * `on` **一律由服务端算**（`commandInList`，只看名单）—— 客户端一行 import 都没有，
       * 再抄一份匹配逻辑就等于有两个真相（踩坑档案第 103 条那个教训）。 */
      commandCatalog: COMMAND_GROUPS.map((g) => ({
        group: g.group,
        items: g.items.map((it) => ({
          name: it.name,
          desc: it.desc,
          ...(it.danger ? { danger: true } : {}),
          on: pluginConfig.commandInList(it.name),
        })),
      })),
      /* 白名单里"不是目录里某个精确名"的那些条目（正则 / `*` / 目录外的名字）。
       * 设置页把它们**单独列出来带一个 ×**，绝不允许静默丢；`covers` 说清它现在罩着目录里哪几条
       * —— 用户把 `give` 的开关拨下去却发现它还亮着时，答案就在这里。 */
      commandExtra: (() => {
        const names = catalogNames()
        const wl = pluginConfig.get('commandWhitelist')
        if (!Array.isArray(wl)) return []
        const out = []
        for (const raw of wl) {
          const entry = String(raw ?? '').trim()
          if (!entry) continue
          // 目录里的精确名由上面那排开关负责，这里不重复列
          if (!isRegexEntry(entry) && entry !== '*' && names.includes(entry.replace(/^\//, '').toLowerCase())) continue
          out.push({ entry, covers: names.filter((n) => matchCommandList([entry], n)) })
        }
        return out
      })(),
      injectDshMcAgentAgentsMd: ws ? ws.injectDshMcAgentAgentsMd : null,
      injectWorkspaceAgentsMd: ws ? ws.injectWorkspaceAgentsMd : null,
      // 「提示词」页的「随版本更新」（默认开；按工作区）
      rulesFollowVersion: ws ? ws.rulesFollowVersion !== false : null,
      // 「MC设置 → 文件分享」：开关 + base（只有"在线"这一种方式，见 config.mjs `expressEnabled`）
      expressEnabled: pluginConfig.expressEnabled,
      expressBase: pluginConfig.expressBase,
      /* 「MC设置 → 记忆」页顶部的两个新控件（2026-10-26）：
       *   · memoryScope  = 记忆按什么分（world 按世界 / session 按会话 / shared 全共用）
       *   · localWorldName = 本地存档名（服务器不广播 level-name，只能手填） */
      memoryScope: pluginConfig.memoryScope,
      localWorldName: pluginConfig.localWorldName,
      memoryPerSession: pluginConfig.memoryScope === 'session',   // 兼容老前端
      // 「MC设置」入口的模式门控：前端拿这份名单 + 会话记录的 preset 就能**本地**判定
      // （不必为按钮问一次服务端；2026-09-16 事故：一次性请求失败后按钮永久消失）
      mcModePresets: pluginConfig.mcModePresets,
      // 其中哪些是 **MC+ 变体**（前端显示「MC+模式」标签用；显示名仍以宿主 preset 的 name 为准）
      mcPlusPresets: pluginConfig.mcPlusPresets,
      configFile: pluginConfig.file,
      workspaceConfigFile: hasWorkspace ? wsConfigPath(memoryRootFor(cwd)) : null,
    }
  }

  /**
   * 「连接到MC」弹窗的**局域网探测**（🔴 后端做，前端只拿结果）：
   *   ① 被动多播听一小段拿候选（src/lan.mjs——不发包、不扫段）；
   *   ② 对候选逐个做一次 STATUS ping（src/ping.mjs）拿**在线人数 / 版本 / MOTD**；
   *   ③ 地址用 `formatAddress` 规范化（IPv6 加方括号、默认端口省略）。
   * 失败/超时的行**照样保留**（`players:null`），别让用户连地址都看不到。
   */
  const probeLan = async ({ seconds = 3, maxHosts = 16, pingTimeoutMs = 1500, concurrency = 6 } = {}) => {
    const secs = Math.max(1, Math.min(Number(seconds) || 3, 15))
    let found = []
    let lanWarnings = []
    try {
      const r = await listenLanBroadcast({ seconds: secs })
      found = Array.isArray(r?.found) ? r.found : (Array.isArray(r) ? r : [])
      lanWarnings = Array.isArray(r?.warnings) ? r.warnings : []
    } catch (e) { lanWarnings = [`探测失败：${e?.message ?? e}`] }
    const hosts = found.slice(0, maxHosts)
    const servers = []
    for (let i = 0; i < hosts.length; i += concurrency) {
      const rows = await Promise.all(hosts.slice(i, i + concurrency).map(async (h) => {
        const host = String(h?.host ?? '').trim()
        const port = Number(h?.port) || 25565
        if (!host) return null
        let ping = null
        try { ping = await statusPing({ host, port, timeoutMs: pingTimeoutMs }) } catch { ping = null }
        const ok = ping?.ok === true
        return {
          host,
          port,
          address: formatAddress(host, port),
          // MOTD 一律**剥掉颜色码**（§x）、**换行符换成空格**再给前端（前端按"固定两行"折行显示）
          motd: flattenMotd(ok ? ping.motd : h?.motd).replace(/[\r\n]+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim(),
          version: ok ? (ping.version ?? null) : null,
          players: ok ? { online: ping.players?.online ?? null, max: ping.players?.max ?? null } : null,
        }
      }))
      for (const r of rows) if (r) servers.push(r)
    }
    return { servers, seconds: secs, ...(lanWarnings.length ? { warnings: lanWarnings } : {}) }
  }

  /* `checkUpdate` 定义在 `handleSettingsApi` 里（它要用路由那些闭包），启动钩子却在外层 ——
   * 用这个盒子把函数递出来（用户 2026-10-21：开 DSH 就该查一次）。 */
  const updaterRef = { check: null }

  const handleSettingsApi = async (req, res, path, url) => {
    const ok = (body) => sendJson(res, 200, { ok: true, ...body })
    // ⚠️ DELETE **也带 body**（前端把 innerID/id 放在 body 里）——只有 GET 没有 body。
    //    E2E 实测踩过：早先按 "GET/DELETE 都不读体" 写，两个删除接口全废。
    const body = req.method === 'GET' ? {} : await readJsonBody(req)

    /* 前端**门控**要的那份名单（哪些 preset 算 MC 模式）：极小、只读、不需要 sessionId / 工作区。
     * 绝不能挂在 `settingsGate` 后面 —— 否则浏览器拿不到名单就静默退回兜底值，
     * 按钮显示与否会和服务端口径不一致（2026-09-16 自查出来的自伤）。 */
    if (path === '/api/mc/presets' && req.method === 'GET') {
      /* 🟢 2026-10-15 审计（client.js 报告第 10 条）：顺手带上**支持版本范围**。
       *    客户端的「版本不匹配就别连」那道门以前是 `MC_VERSION_IN_RANGE = () => null`
       *    —— 一个永远"未知"的桩，于是拦截与红标**一行都到不了**。
       *    范围来自 mineflayer 的 `lib/version.js`（`libraryInfo()` 已经 import 好了，
       *    不新增端点、不连服、无副作用）。
       *    注意 `testedVersions` 是**稀疏的实测清单**，上游只用它定**上界拒绝**，
       *    所以客户端那边是"比 latest 新才算不支持"，不是 `includes`。 */
      const lib = libraryInfo()
      return ok({
        mcModePresets: pluginConfig.mcModePresets,
        testedVersions: lib.testedVersions,
        oldestVersion: lib.oldest,
        latestVersion: lib.latest,
      })
    }

    /* ── 「连接到MC」弹窗（2026-10-04）：服务器地址历史 + 局域网探测 ──────────────
     * 都**不需要工作区**（历史是全局的；探测是纯网络动作），所以不走 settingsGate。 */
    if (path === '/api/mc/servers' && req.method === 'GET') {
      return ok({ servers: serverHistory.list() })
    }
    if (path === '/api/mc/servers' && req.method === 'POST') {
      const addr = String(body.address ?? '').trim()
      if (!addr) throw new Error('address 不能为空')
      return ok({ servers: serverHistory.record(addr) })
    }
    if (path === '/api/mc/servers' && req.method === 'DELETE') {
      return ok({ servers: serverHistory.remove(String(body.address ?? '')) })
    }
    if (path === '/api/mc/lan' && req.method === 'POST') {
      return ok(await probeLan({ seconds: body.seconds }))
    }

    /**
     * 客户端报上来的 `cwd` 能不能当工作区用。
     *
     * 🔴 审计（唯一一条 🔴）：原来只验 `isAbsolute` + `statSync().isDirectory()` —— 于是
     * **任意一个已存在的目录**都能被当成工作区：
     *   · `DELETE /api/mc/express?cwd=C:\任意目录`（不带 sessionId）→ `clearShared()` 里
     *     `rmSync(root, { recursive: true, force: true })` 会把那个目录下的 `.dsh-mc-agent/.express` 整个删掉；
     *   · `PUT /api/mc/agents-md` 之类还会在任意目录 `mkdirSync('.dsh-mc-agent')` 并写进
     *     README.md / RULES.md / config.json。
     * 而 `:1214` 附近的注释还写着"目录由服务端推导，前端传不了路径"——那句话是假的。
     * 现在要求它**在宿主的工作区注册表里**（`workspaceIdOfCwd`），或者至少已经带着我们建过的
     * `.dsh-mc-agent/`（说明以前真的把它当工作区用过）。注册表没就绪时也不会误放行任意目录。
     * 说明：这条要先拿到本机同源请求才触发（栅栏挡跨站/非回环），不是远程可利用，但边界必须是真的。
     */
    const usableWorkspace = (p) => {
      const s = String(p ?? '').trim()
      if (!s || !isAbsolute(s)) return null
      try { if (!statSync(s).isDirectory()) return null } catch { return null }
      if (workspaceIdOfCwd(s)) return s
      // 注册表里没有（或还没就绪）：只认"已经是我们用过的工作区"——目录里已有 `.dsh-mc-agent/`。
      try { if (statSync(join(s, '.dsh-mc-agent')).isDirectory()) return s } catch { /* 没有就不认 */ }
      return null
    }
    /**
     * 解析"这次请求属于哪个工作区"（**可空、不报错、不建档**）。
     *   · 优先按 sessionId 找会话的工作区；
     *   · 新对话页那个会话可能**还没落盘**（客户端已经选好工作区了）→ 允许客户端直接报 `cwd`；
     *   · 都没有 → `null`（"无工作区"模式：从插件菜单等入口打开设置时）。
     * 🔴 建档（`ensureMemoryRootForCwd`）**不**在这里做 —— 只有真拿到工作区的请求才该建。
     */
    const resolveWorkspaceCwd = async (sessionId, cwdHint) => {
      const sid = String(sessionId ?? '').trim()
      let cwd = sid ? await workspaceOfSession(sid) : null
      let from = cwd ? 'session' : null
      if (!cwd) {
        cwd = usableWorkspace(cwdHint)
        if (cwd) from = 'client'
      }
      return cwd ? { cwd, from } : null
    }
    /**
     * 「MC设置」这组接口的**工作区闸门**（用户 2026-09-16）：没有工作区 → 拒绝（400），
     * 不猜、也不落到 `$DSH_HOME` 兜底目录。顺带承担"**点开 MC设置**"这个时机：
     * 把该工作区的 `.dsh-mc-agent/`（README.md / RULES.md）备好。
     * （"无工作区也能用"的接口改用下面的 `cwdOf`，不走这里。）
     */
    const settingsGate = async (sessionId, cwdHint) => {
      const r = await resolveWorkspaceCwd(sessionId, cwdHint)
      if (!r) {
        const sid = String(sessionId ?? '').trim()
        const hinted = String(cwdHint ?? '').trim()
        // 传了 cwd 却被拒：多半是"注册表里没这个目录"（审计修的 🔴，防的是任意目录被当工作区）。
        if (hinted) {
          return {
            ok: false,
            error: `这个目录不能当工作区用：\`${hinted}\` 不在宿主的工作区列表里（也没见它带过 \`.dsh-mc-agent/\`）。`
              + '请先把这个文件夹**添加为工作区**再打开「MC设置」。',
          }
        }
        return {
          ok: false,
          error: sid
            ? '这个会话**没有选中工作区**，「MC设置」不可用：请先在会话里选定一个工作区（记忆与提示词都放在那里）。'
            : '缺少 sessionId：这组接口只在某个会话里可用（要用它的工作区放记忆与提示词）；新对话页请先选好工作区。',
        }
      }
      ensureMemoryRootForCwd(r.cwd, agentIdOf(safeAgentById(sessionId)))
      return { ok: true, cwd: r.cwd, from: r.from }
    }
    const gateOf = (b) => settingsGate(
      url.searchParams.get('sessionId') ?? b?.sessionId,
      url.searchParams.get('cwd') ?? b?.cwd,
    )
    /** 可空版：解析工作区，拿不到就 `null`（给"无工作区也能用"的接口；**不建档**）。 */
    const cwdOf = (b) => resolveWorkspaceCwd(
      url.searchParams.get('sessionId') ?? b?.sessionId,
      url.searchParams.get('cwd') ?? b?.cwd,
    ).then((r) => (r ? r.cwd : null))

    /* 账户 / 认证服务器是**全局**数据（`$DSH_HOME/dsh-mc-agent/accounts.json` + 凭据库），
     * 不绑工作区：从插件菜单等"无工作区"入口打开设置也要能增删账户 —— 所以这组**不走 settingsGate**。
     * （顺带"点开设置即建档 .dsh-mc-agent"的副作用改由 config GET 承担，见下。） */
    if (path === '/api/mc/accounts' && req.method === 'GET') {
      return ok({
        defaultAccount: accounts.resolve()?.innerID ?? null,
        authServers: accounts.listAuthServers(),
        accounts: accounts.list(),
        credentialsReady: accounts.credentialsReady,
      })
    }
    if (path === '/api/mc/accounts' && req.method === 'POST') {
      // 第三方账户：允许**顺手把认证服务器记住**——前端「新建第三方账户」就是"先填服务器、再填账号密码"，
      // 只给一个地址，这里负责 resolve-or-create（免得前端要发两次请求、也不怕重复地址）。
      let serverId = body.serverId ? String(body.serverId) : null
      if (String(body.type) === 'yggdrasil' && !serverId && body.serverUrl) {
        const url = normalizeServerUrl(String(body.serverUrl))
        const existing = accounts.listAuthServers().find((s) => s.url === url)
        serverId = existing ? existing.id : accounts.addAuthServer({ name: body.serverName ?? null, url }).id
      }
      // 选了缓存里的服务器、但把**名字**改了 → 顺手改名（名字只给人看，id 不动）。
      // 不填就不动：`addAuthServer` 默认拿域名当名字，用户想改成"认证服务器"这种看得懂的就靠这一步。
      if (serverId && body.serverName) {
        const cur = accounts.listAuthServers().find((s) => s.id === serverId)
        const nm = String(body.serverName).trim()
        if (cur && nm && nm !== cur.name) accounts.renameAuthServer(serverId, nm)
      }
      const acc = accounts.add({
        type: body.type, name: body.name, uuid: body.uuid ?? null,
        serverId, login: body.login ?? null,
      })
      if (body.password) await accounts.setCredential(acc.innerID, { password: String(body.password) })
      if (body.default === true) accounts.update(acc.innerID, { default: true })
      await accounts.refreshCredentialIndex()
      return ok({ account: accounts.view(accounts.get(acc.innerID)) })
    }
    if (path === '/api/mc/accounts' && req.method === 'PATCH') {
      const innerID = String(body.innerID ?? '')
      const cur = accounts.get(innerID)
      if (!cur) throw new Error(`没有这个账户：${innerID}`)
      const patch = { ...body }
      delete patch.innerID
      delete patch.password
      /* 第三方账户：和 POST 同一套 —— 允许换认证服务器（resolve-or-create）、顺手改名。
         🔴 少了这一段，「编辑第三方账户」发来的 `serverUrl`/`password` 会被 `update()`
            **静默忽略**（它只认 name / uuid / login / id / serverId / default），
            用户改完会觉得"点了保存但没生效"。 */
      if (cur.type === 'yggdrasil') {
        let serverId = body.serverId ? String(body.serverId) : null
        if (!serverId && body.serverUrl) {
          const u = normalizeServerUrl(String(body.serverUrl))
          const existing = accounts.listAuthServers().find((s) => s.url === u)
          serverId = existing ? existing.id : accounts.addAuthServer({ name: body.serverName ?? null, url: u }).id
        }
        if (serverId) patch.serverId = serverId
        if (serverId && body.serverName) {
          const s = accounts.listAuthServers().find((x) => x.id === serverId)
          const nm = String(body.serverName).trim()
          if (s && nm && nm !== s.name) accounts.renameAuthServer(serverId, nm)
        }
      }
      accounts.update(innerID, patch)
      // 🔴 密码**留空 = 不改**：没给 `password` 就保持原来的那份凭据
      if (body.password) await accounts.setCredential(innerID, { password: String(body.password) })
      await accounts.refreshCredentialIndex()
      return ok({ account: accounts.view(accounts.get(innerID)) })
    }
    if (path === '/api/mc/accounts' && req.method === 'DELETE') {
      return ok(await accounts.remove(String(body.innerID ?? '')))
    }
    if (path === '/api/mc/accounts/refresh' && req.method === 'POST') {
      const innerID = String(body.innerID ?? '')
      const resolved = await resolveAuth(innerID)
      if (resolved.auth.mode === 'offline') {
        return ok({ account: accounts.view(accounts.get(innerID)), note: '离线账户不需要认证（UUID 按名字派生）' })
      }
      /* 正版账户**不能**在这里走 `authOnly` —— 缓存失效时它会启动一次设备码流程，
         而用户在这条 HTTP 请求里根本看不到那个码（白等十几分钟才过期）。只如实报缓存状态。 */
      if (resolved.auth.mode === 'microsoft') {
        const has = msaHasCache(resolved.auth.msaCacheDir)
        return ok({
          account: accounts.view(accounts.get(innerID)),
          note: has
            ? '令牌缓存还在（真正的续期由 prismarine-auth 在连接时自己做）'
            : '这个正版账户还没登录过（或缓存被清掉了）—— 点「登录」走一遍设备码',
        })
      }
      let captured = null
      await probeBot().authOnly(resolved.auth, { onSession: (s) => { captured = s } })
      if (captured) await persistAuth(resolved, captured.selectedProfile, captured)
      return ok({ account: accounts.view(accounts.get(innerID)) })
    }
    /* ── 正版（Microsoft）登录：设备码流程 ───────────────────────────────────
     * 🔴 **绝不能占着一次 HTTP 请求等用户去浏览器点** —— POST 起一条后台任务后立刻返回，
     *    前端拿 `userCode`/`verificationUri` 显示出来，再轮询 GET 看好了没有。
     *    一个账户同时只跑一条（两条设备码会互相作废）。
     * ---------------------------------------------------------------------- */
    if (path === '/api/mc/accounts/msa' && req.method === 'POST') {
      const innerID = String(body.innerID ?? '')
      const acc = accounts.get(innerID)
      if (!acc) throw new Error(`没有这个账户：${innerID}`)
      if (acc.type !== 'microsoft') throw new Error('这个账户不是正版（微软）账户')
      const email = String(acc.login ?? '').trim()
      if (!email) throw new Error('这个正版账户还没填微软邮箱（先在「编辑」里补上）')
      if (!msaSupported()) throw new Error('这台机器上找不到 prismarine-auth，正版登录用不了')
      const job = msaJobStart({
        innerID,
        email,
        cacheDir: msaCacheDir(stateDir, innerID),
        /* 登录成功后把**游戏内名字/UUID**回写进账户库（跟皮肤站那条走同一个落点） */
        onDone: (res) => {
          try {
            const patch = {}
            const uuid = dashUuid(res?.uuid)
            if (uuid) patch.uuid = uuid
            if (res?.name) patch.name = String(res.name)
            if (Object.keys(patch).length) accounts.update(innerID, patch)
            logLine(`正版账户「${res?.name ?? email}」登录成功`)
          } catch (e) { ctx.logger?.warn?.(`[dsh-mc-agent] 正版账户回写失败：${e.message}`) }
        },
      })
      return ok({ job, account: accounts.view(accounts.get(innerID)) })
    }
    if (path === '/api/mc/accounts/msa' && req.method === 'GET') {
      const innerID = String(url?.searchParams?.get('innerID') ?? '')
      return ok({ job: innerID ? msaJobOf(innerID) : null, account: innerID ? accounts.view(accounts.get(innerID)) : null })
    }
    if (path === '/api/mc/accounts/msa' && req.method === 'DELETE') {
      const innerID = String(body.innerID ?? url?.searchParams?.get('innerID') ?? '')
      return ok({ cleared: msaJobClear(innerID) })
    }
    if (path === '/api/mc/authservers' && req.method === 'POST') {
      let url = body.url ? String(body.url) : null
      if (!url && body.card) {
        url = parseAuthlibCard(body.card)
        if (!url) throw new Error('这张卡片里没找到认证服务器地址（要 `authlib-injector:yggdrasil-server:<网址>` 或一条网址）')
      }
      if (!url) throw new Error('要给 url，或把卡片拖进来（card）')
      return ok({ server: accounts.addAuthServer({ name: body.name ? String(body.name) : null, url }) })
    }
    if (path === '/api/mc/authservers' && req.method === 'DELETE') {
      return ok(accounts.removeAuthServer(String(body.id ?? '')))
    }
    /* `/api/mc/config` **可无工作区**（全局键照常，工作区键为 null）。
     * 顺带承担"点开 MC设置即建档 .dsh-mc-agent"这个时机 —— 但**只在该请求真有工作区时**，
     * 否则 `memoryRootFor(null)` 会落到全局兜底目录。 */
    if (path === '/api/mc/config' && req.method === 'GET') {
      const cwd = await cwdOf(null)
      if (cwd) ensureMemoryRootForCwd(cwd, agentIdOf(safeAgentById(url?.searchParams?.get('sessionId'))))
      return ok(configView(cwd))
    }
    if (path === '/api/mc/config' && req.method === 'PATCH') {
      const cwd = await cwdOf(body)
      if (cwd) ensureMemoryRootForCwd(cwd, agentIdOf(safeAgentById(body?.sessionId ?? url?.searchParams?.get('sessionId'))))
      // 全局键 → PluginConfig（**无条件**）；三个提示词开关 → **本工作区**的 config.json（有工作区才写）
      for (const k of ['commandWhitelist', 'allowAllCommands', 'expressEnabled', 'expressBase', 'memoryScope', 'localWorldName']) {
        if (body[k] !== undefined) pluginConfig.set(k, body[k])
      }
      const wsPatch = {}
      for (const k of ['injectDshMcAgentAgentsMd', 'injectWorkspaceAgentsMd', 'rulesFollowVersion']) {
        if (body[k] !== undefined) wsPatch[k] = body[k]
      }
      if (cwd && Object.keys(wsPatch).length) wsCfgPatch(cwd, wsPatch)
      return ok(configView(cwd))
    }

    /* ── 「MC设置 → 文件分享」：这个工作区的发布区现状 / 清除分享数据 ──────────────
     * 分享**模式与 base** 是全局配置（走 `/api/mc/config`）；这两个接口是**按工作区**的：
     *   · GET    看发布区在哪、攒了多少（页面上显示，省得用户去翻文件夹）；
     *   · DELETE 「清除分享数据」—— 前端必须**先让用户确认**再调它（不可撤销）。
     * 目录由服务端推导：客户端只能报 `sessionId`（或一个**注册表里认得的工作区** `cwd`），
     * 其余一律拒绝 —— 见 `usableWorkspace()` 的注释（2026-10-15 审计修的 🔴）。
     * ------------------------------------------------------------------------ */
    if (path === '/api/mc/express' && req.method === 'GET') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      // 顺带把「当前地址」给前端：base 的「获取当前」按钮 / 切到在线时的自动填，都用它
      // （`clientOrigin` = 浏览器塞进来的 `location.origin`，最精准那一档）
      return ok({
        ...sharedStat(gate.cwd),
        currentBase: currentBaseOf(req, { clientOrigin: url?.searchParams?.get('clientOrigin') }),
      })
    }
    if (path === '/api/mc/express' && req.method === 'DELETE') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      return ok(clearShared(gate.cwd))
    }

    /* ── 「MC设置 → 记忆」：这个会话的记忆目录 + 里面有哪些文件 + 打开所在位置 ────────
     * 用户 2026-10-20：原来那页是「文件分享」，现在整页换成「记忆」——
     * 分享开关/base/清除全部下线，这页只回答：**我的记忆存在哪**、**里面有什么**、**帮我打开它**。
     *   · GET  `/api/mc/memory`      → `{ dir, exists, files, dirs, memoryPerSession }`
     *   · POST `/api/mc/memory/open` → 用系统文件管理器打开（带 `name` 就是在里面选中它）
     * 目录只认服务端推导（`memoryRootFor`），客户端不能直接塞路径 —— 同 `usableWorkspace()` 的规矩。
     * ------------------------------------------------------------------------ */
    if (path === '/api/mc/memory' && req.method === 'GET') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      const sid = String(url?.searchParams?.get('sessionId') ?? '')
      const agentId = agentIdOf(safeAgentById(sid))
      return ok(memoryDirView(memoryRootFor(gate.cwd, agentId), { agentId }))
    }
    if (path === '/api/mc/memory/open' && req.method === 'POST') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      const sid = String(body?.sessionId ?? url?.searchParams?.get('sessionId') ?? '')
      const dir = memoryRootFor(gate.cwd, agentIdOf(safeAgentById(sid)))
      return ok(await openInFileManager(dir, body?.name ? String(body.name) : null))
    }

    /* ── 「MC设置 → 记忆」：世界登记表（`memoryScope === 'world'` 时"哪个世界"由它说了算）──────
     * 用户 2026-10-26：「可选按世界存记忆还是按会话存记忆」+「因为如果是 dhcp 地址有可能会变」。
     * 地址变了**不用搬文件夹**：把新地址 `link` 到同一个世界，记忆照旧接着用。
     *   · GET  `/api/mc/worlds?sessionId=` → 当前连接地址 + 全部世界（带 `matchesCurrent`）
     *   · POST `/api/mc/worlds` { action, … } → rename / link / unlink / remove / create
     * 🔴 只动登记表与 `worlds/<dir>` 目录，**从不**改记忆文件内容（`remove` 默认也只删登记）。
     * ------------------------------------------------------------------------ */
    const worldsView = (cwd, sid) => {
      const agentId = agentIdOf(safeAgentById(String(sid ?? '')))
      const sess = agentId ? registry.peek(agentId) : null
      let conn = null
      try { conn = sess?.bot?.connectionView?.() ?? null } catch { conn = null }
      const addr = addrKeyOf(conn, { localName: pluginConfig.localWorldName })
      const base = memoryBaseFor(cwd)
      const cur = addr ? worlds.byAddr(addr) : null
      return {
        memoryScope: pluginConfig.memoryScope,
        localWorldName: pluginConfig.localWorldName,
        base,
        worldsDir: join(base, WORLDS_DIR),
        /** 当前这个会话连的地址（没连过 = `addr: ''`）；`unconnected` = 记忆暂落 `_unconnected` */
        current: {
          host: conn?.host ?? null,
          port: conn?.port ?? null,
          addr,
          worldId: cur?.id ?? null,
          unconnected: !addr,
        },
        /** 登记表读盘失败时的原因（页面提示用；不影响记忆本身） */
        loadError: worlds.loadError,
        worlds: worlds.list().map((w) => worlds.viewOf(w, { addr: addr || null })),
      }
    }
    if (path === '/api/mc/worlds' && req.method === 'GET') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      const sid = String(url?.searchParams?.get('sessionId') ?? '')
      return ok(worldsView(gate.cwd, sid))
    }
    if (path === '/api/mc/worlds' && req.method === 'POST') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      const sid = String(body?.sessionId ?? url?.searchParams?.get('sessionId') ?? '')
      const base = memoryBaseFor(gate.cwd)
      const action = String(body?.action ?? '').trim()
      let done = null
      try {
        if (action === 'create') {
          done = { created: worlds.viewOf(worlds.create({ name: body?.name, local: body?.local === true })) }
        } else if (action === 'rename') {
          const r = worlds.rename(String(body?.id ?? ''), body?.name, { base })
          done = { entry: worlds.viewOf(r.entry), moved: r.moved }
        } else if (action === 'link') {
          /* 不给 addr 就用**当前连接地址**（页面上"把当前地址指到这个世界"最常用） */
          const agentId = agentIdOf(safeAgentById(sid))
          const sess = agentId ? registry.peek(agentId) : null
          let conn = null
          try { conn = sess?.bot?.connectionView?.() ?? null } catch { conn = null }
          const addr = String(body?.addr ?? '').trim() || addrKeyOf(conn, { localName: pluginConfig.localWorldName })
          if (!addr) throw new Error('还没有连接地址：先连一次服务器，或手动填地址')
          done = { entry: worlds.viewOf(worlds.link(addr, String(body?.id ?? ''))), addr }
        } else if (action === 'unlink') {
          const w = worlds.unlink(String(body?.addr ?? ''))
          done = { entry: w ? worlds.viewOf(w) : null }
        } else if (action === 'remove') {
          done = { removed: worlds.viewOf(worlds.remove(String(body?.id ?? ''), { base, purge: body?.purge === true })) }
        } else {
          throw new Error(`未知动作 "${action}"（可用：create / rename / link / unlink / remove）`)
        }
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e?.message ?? String(e) })
      }
      logLine(`「MC设置 → 记忆」世界登记：${action}${done?.entry?.name ? `（${done.entry.name}）` : ''}`)
      return ok({ ...done, ...worldsView(gate.cwd, sid) })
    }

    /* ── 更新（「MC设置 → 更新」页，用户 2026-10-20）─────────────────────────────
     * 🔴 这个插件是 `link:<源码目录>` 装的（npm 上没有包），所以「新版本」**只可能来自 git 远端**：
     *   比对本地 HEAD 与 `<remote>/<branch>`，落后的提交 + `CHANGELOG.md` 新增的那几行 = "新版加了什么"。
     *   源优先级：**gitee → origin**（用户：优先用 gitee，github 兜底）。结果缓存 10 分钟，
     *   红点靠 `GET /api/mc/update` 轮询，别每次开页面都真去 fetch。 */
    /* 下面三个在**插件作用域**（不是每个请求里）—— 见 §「更新」那段开头的说明 */

    /** 跑一条 git 命令（不弹窗、带超时）。返回 `{ code, out, err }`，**永不抛**。 */
    const gitRun = async (args, timeoutMs = 20000, cwd = PLUGIN_ROOT) => {
      const { spawn } = await import('node:child_process')
      return await new Promise((resolvePromise) => {
        let out = ''
        let err = ''
        let settled = false
        const fin = (r) => { if (!settled) { settled = true; resolvePromise(r) } }
        let child
        try {
          child = spawn('git', args, { cwd, windowsHide: true })
        } catch (e) {
          return fin({ code: -1, out: '', err: `起不了 git：${e?.message ?? e}` })
        }
        const timer = setTimeout(() => {
          try { child.kill() } catch { /* 已经退了 */ }
          fin({ code: -2, out, err: err + `超时（${timeoutMs}ms）` })
        }, timeoutMs)
        child.stdout?.on('data', (d) => { out += String(d) })
        child.stderr?.on('data', (d) => { err += String(d) })
        child.on('error', (e) => { clearTimeout(timer); fin({ code: -1, out, err: err + String(e?.message ?? e) }) })
        child.on('close', (code) => { clearTimeout(timer); fin({ code, out, err }) })
      })
    }

    /** 从 `git diff` 里挑出 CHANGELOG 的**新增行**（比整篇 CHANGELOG 更贴近"这次加了什么"）。 */
    const changelogAddedOf = (diffText) => {
      const out = []
      for (const l of String(diffText).split(/\r?\n/)) {
        if (l.startsWith('+') && !l.startsWith('+++')) out.push(l.slice(1))
      }
      return out.join('\n').trim().slice(0, 4000)
    }

    /* ── 复制安装（目录里没有 `.git`）的「覆盖式更新」────────────────────────────
     * 用户 2026-10-20 在 Windows 服务器上遇到的：插件是**整份复制**进宿主 `node_modules` 的，
     * 那份目录自己没 `.git` ⇒ 没有远端可比、也没法拉。做法改成：
     * 临时 `git clone --depth 30` 一份 → 比版本/提交 → 要更新就**先整份备份**再覆盖。
     * 🔴 覆盖只动代码与文档：`.git` / `node_modules` 一律不碰（依赖是宿主装的，动它会炸）。 */
    const UPDATE_REMOTES = [
      'https://gitee.com/bluezi/dsh-mc-agent.git',
      'https://github.com/blueziii/dsh-mc-agent.git',
    ]
    const INSTALL_MARK = '.dsh-mc-agent-install.json'

    const stampNow = () => {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }
    const readJsonFile = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
    /** 版本号比较（只认数字段，`0.2.0` vs `0.10.0` 别按字符串比）。返回 -1 / 0 / 1。 */
    const cmpVersion = (a, b) => {
      const pa = String(a ?? '').split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0)
      const pb = String(b ?? '').split(/[.\-+]/).map((x) => Number.parseInt(x, 10) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
        const x = pa[i] ?? 0
        const y = pb[i] ?? 0
        if (x !== y) return x > y ? 1 : -1
      }
      return 0
    }
    /** 取 CHANGELOG 最上面那一节（还没有正式版本号时就是 `## [未发布]` 那段）。 */
    const topChangelogSection = (text) => {
      const lines = String(text ?? '').split(/\r?\n/)
      const start = lines.findIndex((l) => /^##\s+/.test(l))
      if (start === -1) return ''
      let end = lines.length
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s+/.test(lines[i])) { end = i; break }
      }
      return lines.slice(start, end).join('\n').trim().slice(0, 4000)
    }
    /** 临时 clone 一份最新代码（gitee 优先，github 兜底）。失败返回 `{dir:null, errors}`。 */
    const cloneLatest = async () => {
      const base = mkdtempSync(join(tmpdir(), 'dsh-mc-agent-up-'))
      const dir = join(base, 'repo')
      const errors = []
      for (const url of UPDATE_REMOTES) {
        const r = await gitRun(['clone', '--depth', '30', '--quiet', url, dir], 120000, base)
        if (r.code === 0) return { base, dir, url, errors }
        errors.push(`${url}: ${(r.err || r.out || `exit ${r.code}`).trim().slice(0, 200)}`)
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 没建出来 */ }
      }
      try { rmSync(base, { recursive: true, force: true }) } catch { /* 同 */ }
      return { base: null, dir: null, url: null, errors }
    }
    const dropClone = (base) => { try { if (base) rmSync(base, { recursive: true, force: true }) } catch { /* 临时目录，清不掉也没事 */ } }

    /** 覆盖时哪些不碰：`.git`、`node_modules`、上次的备份目录。 */
    const copyKeepOut = (srcPath) => {
      const name = basename(srcPath)
      if (name === '.git' || name === 'node_modules') return false
      if (name.startsWith('.bak-') || /\.bak-\d{8}-\d{6}$/.test(name)) return false
      return true
    }
    /** 把插件目录整份备份一份（不含 node_modules/.git）。返回备份路径。 */
    const backupPluginDir = () => {
      const dst = `${PLUGIN_ROOT.replace(/[\\/]+$/, '')}.bak-${stampNow()}`
      cpSync(PLUGIN_ROOT, dst, { recursive: true, force: true, filter: copyKeepOut })
      return dst
    }
    /** 把 clone 出来的代码覆盖进插件目录，返回动过多少个条目。 */
    const copyIntoPluginDir = (srcDir) => {
      let n = 0
      cpSync(srcDir, PLUGIN_ROOT, {
        recursive: true,
        force: true,
        filter: (p) => { if (!copyKeepOut(p)) return false; n++; return true },
      })
      return n
    }
    /** 复制安装时查更新：clone 一份比提交/版本，决定能不能「覆盖式更新」。 */
    const fillCopyUpdate = async (data) => {
      const clone = await cloneLatest()
      if (!clone.dir) {
        data.ready = false
        data.reason = `插件目录不是 git 仓库（复制安装），而且拉不到远端代码：${clone.errors.join('；').slice(0, 400)}`
        return
      }
      try {
        const pkg = readJsonFile(join(clone.dir, 'package.json')) ?? {}
        if (pkg.name !== 'dsh-mc-agent') {
          data.ready = false
          data.reason = `拉到的仓库不是 dsh-mc-agent（name=${pkg.name ?? '?'}），没敢拿它覆盖。`
          return
        }
        data.source = clone.url
        data.latestVersion = String(pkg.version ?? '') || null
        const lc = await gitRun(['rev-parse', '--short', 'HEAD'], 8000, clone.dir)
        data.latestCommit = String(lc.out).trim() || null
        const mark = readJsonFile(join(PLUGIN_ROOT, INSTALL_MARK)) ?? null
        data.currentCommit = String(mark?.commit ?? '') || null
        /* 落后几个提交：上次覆盖留下的提交号还在这份浅 clone 里就能精确算，否则只能按版本号猜 */
        let behind = null
        if (mark?.commit) {
          const rg = await gitRun(['rev-list', '--count', `${mark.commit}..HEAD`], 10000, clone.dir)
          if (rg.code === 0) behind = Math.max(0, Number(String(rg.out).trim()) || 0)
        }
        const vcmp = cmpVersion(data.latestVersion, data.currentVersion)
        if (behind === null) {
          data.behind = vcmp > 0 ? 1 : 0
          data.canPull = vcmp > 0
          data.forcePull = vcmp <= 0
          data.reason = vcmp > 0
            ? `复制安装：远端是 ${data.latestVersion}，你这里是 ${data.currentVersion}。`
            : `复制安装：版本号一样（${data.currentVersion}），看不出有没有更新 —— 想保险可以点「覆盖到最新」（会先整份备份）。`
        } else {
          data.behind = behind
          data.canPull = behind > 0
          data.reason = behind > 0
            ? `复制安装：落后 ${behind} 个提交。`
            : '已经是最新（和上次覆盖时是同一个提交）。'
        }
        if (data.canPull || data.forcePull) {
          const range = mark?.commit && behind !== null ? `${mark.commit}..HEAD` : ''
          const lg = await gitRun(['log', '--no-decorate', '--pretty=%h\t%s', ...(range ? [range] : ['-n', '20'])], 10000, clone.dir)
          data.commits = String(lg.out).split(/\r?\n/).filter(Boolean).map((line) => {
            const i = line.indexOf('\t')
            return i === -1 ? { hash: line.trim(), subject: '' } : { hash: line.slice(0, i), subject: line.slice(i + 1) }
          })
          try { data.changelog = topChangelogSection(readFileSync(join(clone.dir, 'CHANGELOG.md'), 'utf8')) } catch { data.changelog = '' }
        }
      } finally {
        dropClone(clone.base)
      }
    }
    /** 复制安装时真去覆盖：先备份，再覆盖，最后写"这次装的是哪个提交"的标记。 */
    const applyUpdateCopy = async (info) => {
      const clone = await cloneLatest()
      if (!clone.dir) return { ok: false, error: `拉不到远端代码：${clone.errors.join('；').slice(0, 600)}` }
      try {
        const pkg = readJsonFile(join(clone.dir, 'package.json')) ?? {}
        if (pkg.name !== 'dsh-mc-agent') return { ok: false, error: `拉到的仓库不是 dsh-mc-agent（name=${pkg.name ?? '?'}），没敢覆盖。` }
        const commit = String((await gitRun(['rev-parse', 'HEAD'], 8000, clone.dir)).out).trim() || null
        if (info.currentCommit && commit && commit === info.currentCommit) {
          return { ok: false, error: '远端和你这里是同一个提交，不用覆盖。' }
        }
        let backup = null
        try {
          backup = backupPluginDir()
        } catch (e) {
          return { ok: false, error: `备份失败，先不动手：${e?.message ?? e}` }
        }
        let files = 0
        try {
          files = copyIntoPluginDir(clone.dir)
        } catch (e) {
          return { ok: false, error: `覆盖中途出错（备份在 ${backup}，可以手动还原）：${e?.message ?? e}` }
        }
        try {
          writeFileSync(join(PLUGIN_ROOT, INSTALL_MARK), `${JSON.stringify({ commit, version: String(pkg.version ?? ''), source: clone.url, at: Date.now(), backup }, null, 2)}\n`, 'utf8')
        } catch { /* 标记写不进去只是下次"看不出更新"，不影响插件能用 */ }
        updateCache.at = 0
        updateCache.data = null
        return {
          ok: true,
          mode: 'copy',
          output: `覆盖了 ${files} 个条目（旧版备份在 ${backup}）`,
          backup,
          commit,
          version: String(pkg.version ?? ''),
          needRestart: true,
        }
      } finally {
        dropClone(clone.base)
      }
    }

    /**
     * 查有没有新版本。`force` = 忽略 10 分钟缓存（用户点了「检查更新」）。
     * 返回值恒是对象（`ok:false` 时 `reason` 说人话），前端直接照着渲染。
     */
    const checkUpdate = async (force = false) => {
      if (!force && updateCache.data && Date.now() - updateCache.at < UPDATE_TTL_MS) return updateCache.data
      const data = {
        ready: true,
        checkedAt: Date.now(),
        currentVersion: PLUGIN_VERSION,
        root: PLUGIN_ROOT,
        mode: 'git',
        isRepo: false,
        source: null,
        remotes: [],
        branch: null,
        currentCommit: null,
        latestCommit: null,
        latestVersion: null,
        ahead: 0,
        behind: 0,
        commits: [],
        changelog: '',
        dirty: 0,
        dirtyFiles: [],
        canPull: false,
        forcePull: false,
        reason: '',
      }
      const remember = () => {
        updateCache.at = Date.now()
        updateCache.data = data
        return data
      }

      const inside = await gitRun(['rev-parse', '--is-inside-work-tree'], 8000)
      if (inside.code !== 0 || String(inside.out).trim() !== 'true') {
        /* 用户 2026-10-20：有人是把包**复制**进宿主 node_modules 的（没有 .git）⇒ 走覆盖式更新 */
        data.mode = 'copy'
        await fillCopyUpdate(data)
        return remember()
      }
      data.mode = 'git'
      data.isRepo = true

      const br = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], 8000)
      data.branch = String(br.out).trim() || 'main'
      const head = await gitRun(['rev-parse', '--short', 'HEAD'], 8000)
      data.currentCommit = String(head.out).trim() || null

      const st = await gitRun(['status', '--porcelain'], 8000)
      const dirtyList = String(st.out).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      data.dirty = dirtyList.length
      data.dirtyFiles = dirtyList.slice(0, 20)

      const rm = await gitRun(['remote'], 8000)
      data.remotes = String(rm.out).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      data.source = ['gitee', 'origin'].find((x) => data.remotes.includes(x)) ?? data.remotes[0] ?? null
      if (!data.source) {
        data.ready = false
        data.reason = '这个仓库一个远端都没配（`git remote` 是空的），不知道去哪找新版本。'
        return remember()
      }

      const fetched = await gitRun(['fetch', data.source, '--prune', '--quiet'], 30000)
      if (fetched.code !== 0) {
        data.ready = false
        data.reason = `拉不到 ${data.source}：${(fetched.err || fetched.out || '').trim().slice(0, 300) || `exit ${fetched.code}`}`
        return remember()
      }

      const ref = `${data.source}/${data.branch}`
      const has = await gitRun(['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], 8000)
      if (has.code !== 0) {
        data.ready = false
        data.reason = `远端没有 ${ref} 这个分支（本地分支叫 ${data.branch}）。`
        return remember()
      }
      const lc = await gitRun(['rev-parse', '--short', ref], 8000)
      data.latestCommit = String(lc.out).trim() || null

      const cnt = await gitRun(['rev-list', '--left-right', '--count', `HEAD...${ref}`], 8000)
      const parts = String(cnt.out).trim().split(/\s+/)
      data.ahead = Number(parts[0]) || 0
      data.behind = Number(parts[1]) || 0

      if (data.behind > 0) {
        const lg = await gitRun(['log', '--no-decorate', '--pretty=%h\t%s', `HEAD..${ref}`, '-n', '20'], 10000)
        data.commits = String(lg.out).split(/\r?\n/).filter(Boolean).map((line) => {
          const i = line.indexOf('\t')
          return i === -1 ? { hash: line.trim(), subject: '' } : { hash: line.slice(0, i), subject: line.slice(i + 1) }
        })
        const lv = await gitRun(['show', `${ref}:package.json`], 10000)
        try { data.latestVersion = JSON.parse(lv.out).version ?? null } catch { data.latestVersion = null }
        const cl = await gitRun(['diff', '--unified=0', `HEAD..${ref}`, '--', 'CHANGELOG.md'], 15000)
        data.changelog = changelogAddedOf(cl.out)
        data.canPull = data.dirty === 0
        data.reason = data.dirty === 0
          ? ''
          : `本地有 ${data.dirty} 个未提交改动，直接 pull 会被拦 —— 先提交或 stash。`
      } else {
        data.reason = '已经是最新。'
      }
      return remember()
    }

    /** 真去拉。只在能拉时才动手；失败把 git 的原话原样给用户。 */
    const applyUpdate = async () => {
      const info = await checkUpdate(true)
      if (info.mode === 'copy') return await applyUpdateCopy(info)
      if (!info.isRepo) return { ok: false, error: info.reason }
      if (info.behind === 0) return { ok: false, error: '已经是最新，没什么可拉的。' }
      if (info.dirty > 0) {
        return { ok: false, error: `本地有 ${info.dirty} 个未提交改动，先提交或 stash 再来：\n${info.dirtyFiles.join('\n')}` }
      }
      const pull = await gitRun(['pull', '--ff-only', info.source, info.branch], 60000)
      if (pull.code !== 0) {
        return { ok: false, error: (pull.err || pull.out || `git pull 退出码 ${pull.code}`).trim().slice(0, 1200) }
      }
      updateCache.at = 0
      updateCache.data = null
      const after = await checkUpdate(true)
      return {
        ok: true,
        output: String(pull.out).trim().slice(0, 1200),
        behind: after.behind,
        needRestart: true,
      }
    }

    updaterRef.check = checkUpdate

    /* ── 更新（用户 2026-10-20）：`GET /api/mc/update` 查 / `POST /api/mc/update/apply` 拉 ──
     * 🔴 这两条**不要求工作区**：红点要出现在"新会话页"上，那时候根本还没有工作区。 */
    if (path === '/api/mc/update' && req.method === 'GET') {
      const force = String(url?.searchParams?.get('force') ?? '') === '1'
      return ok(await checkUpdate(force))
    }
    if (path === '/api/mc/update/apply' && req.method === 'POST') {
      const r = await applyUpdate()
      return r.ok ? ok(r) : sendJson(res, 400, { ok: false, error: r.error })
    }

    /* ── 提示词（「MC设置 → 提示词」页 = `.dsh-mc-agent/RULES.md` + `<记忆根>/版本提示.md`）──
     * 🔴 两份都是**按会话工作区**的**文件**（用户 2026-10-08：规则放文件里，会话自己去读）。
     *   · GET  **可无工作区** —— 无则**只读**返回内置默认（前端展示用，不建档）；
     *   · PUT/DELETE **必须有工作区**（写入没地方放）；`body.target` 选改哪份（默认 `rules`）。
     * 有工作区则顺带把文件备好（点开设置即建）。 */
    if (path === '/api/mc/agents-md') {
      const sessionId = String(body.sessionId ?? url?.searchParams?.get('sessionId') ?? '')
      if (req.method === 'GET') {
        const cwd = await cwdOf(null)
        if (!cwd) {
          return ok({
            text: DEFAULT_AGENTS_MD,
            source: 'default',
            path: null,
            isDefault: true,
            defaultText: DEFAULT_AGENTS_MD,
            // 无工作区：两块都只是内置默认（只读展示），形状与有工作区分支保持一致
            default: {
              text: DEFAULT_AGENTS_MD,
              source: 'default',
              path: null,
              exists: false,
              isDefault: true,
              bytes: Buffer.byteLength(DEFAULT_AGENTS_MD),
              builtinText: DEFAULT_AGENTS_MD,
              sharedWithSession: true,
            },
            followVersion: false,
            rulesVersion: null,
            pluginVersion: PLUGIN_VERSION,
            workspacePath: null,
            workspaceExists: false,
            rulesExists: false,
            // 版本提示（随版本发布、现在是文件）——无工作区时也要能看到它说了什么
            versionPrompt: {
              version: PLUGIN_VERSION, title: versionPromptTitle(PLUGIN_VERSION), path: null,
              source: 'default', isDefault: true, bytes: Buffer.byteLength(versionPromptText(PLUGIN_VERSION)),
              text: versionPromptText(PLUGIN_VERSION), defaultText: versionPromptText(PLUGIN_VERSION),
              versionPromptVersion: null,
            },
            injection: null,
            hasWorkspace: false,
            readOnly: true,
          })
        }
        ensureMemoryRootForCwd(cwd, agentIdOf(safeAgentById(sessionId)))
        const promptDir = memoryRootFor(cwd, agentIdOf(safeAgentById(sessionId)))
        const wsPath = join(workspaceRootFor(safeAgentById(sessionId)), 'AGENTS.md')
        const cur = readAgentsMd(promptDir)
        const vp = readVersionPrompt(promptDir, PLUGIN_VERSION)
        /* 「提示词」页分成**上下两块**（用户 2026-10-15）：
         *   · 上：**默认提示词** = **基根**那份（`memoryBaseFor`）。新会话的记忆根是
         *     `seedSessionRoot()` 从基根**拷** RULES.md 播种的（见 SESSION_SEED_FILES），
         *     所以基根那份就是"以后新建的会话拿到的"，改它只影响**以后**的会话。
         *   · 下：**会话提示词** = `memoryRootFor()`（本会话那份，就是 `cur`）。
         * 🔴 没开 `memoryPerSession` 时 `base === promptDir`，两块是**同一份文件** —— 这时
         *    必须如实告诉前端（`sharedWithSession`），不然"改上面那块"会让人以为没生效。 */
        const baseDir = memoryBaseFor(cwd)
        const baseCur = readAgentsMd(baseDir)
        return ok({
          text: cur.text,
          source: cur.source,
          path: cur.path,
          isDefault: cur.source === 'default',
          defaultText: DEFAULT_AGENTS_MD,
          // 「默认提示词」那一块（基根 / 新会话的种子）
          default: {
            text: baseCur.text,
            source: baseCur.source,
            path: baseCur.path,
            exists: existsSync(baseCur.path),
            isDefault: baseCur.source === 'default',
            bytes: Buffer.byteLength(baseCur.text),
            builtinText: DEFAULT_AGENTS_MD,
            sharedWithSession: baseDir === promptDir,
          },
          // 「随版本更新」：开关 + 当前内容对应的版本 —— 都来自本工作区的 config.json（src/wsconfig.mjs）
          followVersion: wsCfgValues(cwd).rulesFollowVersion !== false,
          rulesVersion: readRulesVersion(promptDir),
          pluginVersion: PLUGIN_VERSION,
          workspacePath: wsPath,
          workspaceExists: existsSync(wsPath),
          // 本提示词那个文件（RULES.md）在不在 —— 前端据此给名字加"缺失"样式
          rulesExists: existsSync(cur.path),
          // 版本提示（顶层放一份，无工作区分支同构，省得前端分两路取）
          versionPrompt: {
            version: PLUGIN_VERSION,
            title: versionPromptTitle(PLUGIN_VERSION),
            path: vp.path,
            source: vp.source,
            isDefault: vp.source === 'default',
            bytes: Buffer.byteLength(vp.text),
            text: vp.text,
            defaultText: versionPromptText(PLUGIN_VERSION),
            versionPromptVersion: readVersionPromptVersion(promptDir),
          },
          // 「提示词」页要能直接告诉用户"这几段到底会不会进模型"（省得靠猜）
          injection: promptInjectionStatus(safeAgentById(sessionId)),
          hasWorkspace: true,
          readOnly: false,
        })
      }
      // PUT / DELETE：写入必须有工作区（顺带建档）
      //   · `target` 选哪一份（`rules` 默认 / `version` 版本提示）
      //   · `scope`  选哪一块（`session` 默认 = 本会话那份 / `default` = **基根**那份，
      //     也就是"以后新建的会话会拿到的那份"，见 `seedSessionRoot` / `SESSION_SEED_FILES`）
      //   · `from`   （只对 DELETE + scope=session 有意义）`default` = 把**基根那份**重新播种进
      //     本会话，而不是写回内置默认 —— 用户在「默认提示词」里定制过之后，"恢复默认"该回到
      //     **他自己定的那个默认**，不是插件的出厂值。
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      const sessionDir = memoryRootFor(gate.cwd, agentIdOf(safeAgentById(sessionId)))
      const baseDir = memoryBaseFor(gate.cwd)
      const isVersion = String(body.target ?? 'rules') === 'version'
      const scope = String(body.scope ?? 'session') === 'default' ? 'default' : 'session'
      // 版本提示只有会话那一份（不参与"默认 / 会话"分块）
      const dir = (scope === 'default' && !isVersion) ? baseDir : sessionDir
      if (req.method === 'PUT') {
        return ok(isVersion
          ? { ...writeVersionPrompt(dir, body.text, PLUGIN_VERSION), source: 'custom', target: 'version', scope }
          : { ...writeAgentsMd(dir, body.text), source: 'custom', target: 'rules', scope })
      }
      if (req.method === 'DELETE') {
        if (isVersion) return ok({ ...resetVersionPrompt(dir, PLUGIN_VERSION), source: 'default', target: 'version', scope })
        if (scope === 'default') return ok({ ...resetAgentsMd(dir), source: 'default', target: 'rules', scope })
        // scope=session 且 from=default：用基根那份**重新播种**本会话
        if (String(body.from ?? '') === 'default') {
          const src = agentsMdPath(baseDir)
          const dst = agentsMdPath(sessionDir)
          // 没开 memoryPerSession 时两者是同一个文件 —— 拷自己会 EBUSY/EPERM，直接当"已经是默认"
          if (src === dst) {
            const same = readAgentsMd(sessionDir)
            return ok({
              restored: true, from: 'default', sharedWithSession: true, path: same.path,
              bytes: Buffer.byteLength(same.text), source: same.source, target: 'rules', scope: 'session',
            })
          }
          if (!existsSync(src)) return sendJson(res, 400, { ok: false, error: '默认提示词那份文件还不存在（先去上面那块点保存）' })
          try {
            if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true })
            copyFileSync(src, dst)
            const now = readAgentsMd(sessionDir)
            return ok({
              restored: true, from: 'default', path: now.path,
              bytes: Buffer.byteLength(now.text), source: now.source, target: 'rules', scope: 'session',
            })
          } catch (e) { return sendJson(res, 500, { ok: false, error: `从默认播种失败：${e.message}` }) }
        }
        return ok({ ...resetAgentsMd(sessionDir), source: 'default', target: 'rules', scope })
      }
    }
    throw new Error(`未知的设置接口：${req.method} ${path}`)
  }

  /**
   * 发布区服务：`GET/HEAD /api/dsh-mc-agent/express/<工作区 uuid>/<剩余路径>`
   *   → `<工作区>/.dsh-mc-agent/.express/<剩余路径>`（**子目录可以有**）。
   *
   * 用户 2026-09-16 定的规矩（照做）：
   *   · **不用 token**（DSH 本身禁止公网访问；真要架公网，架的人自己加代理与鉴权）；
   *   · **目录即白名单**：只有 `.express/` 下的文件可访问，`.out/`（默认输出）不对外；
   *   · **所有扩展名都放行**（用户自己把握）；
   *   · 🔴 **必须防穿透**：段级校验（`.dsh-mc-agent` 那边已做）之后，这里再用
   *     `realpath` 复查一次"真实路径仍在发布区里" —— 这样**符号链接也跳不出去**。
   *   · 信任栅栏在路由入口处（非回环且不在 trustedHosts → 403）。
   *
   * 🔴 2026-09-17：地址里的"工作区指代"从**目录名**换成**工作区 uuid**（`workspaceRegistry` 的 id）。
   *    查不到对应工作区（或段不合法）→ 统一 404，不给探测依据。
   */
  const serveSharedFile = (req, res, hit) => {
    const notFound = (why) => {
      // 统一 404（不区分"没有这个工作区/没有这个文件/段不合法"）：不给人做探测的依据
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`not found${why ? ` (${why})` : ''}`)
      return true
    }
    try {
      const cwd = workspaceCwdById(hit.workspaceId)
      if (!cwd) {
        logLine(`发布区：工作区注册表里没有 uuid=「${hit.workspaceId}」`)
        return notFound()
      }
      const root = expressRootOf(memoryRootFor(cwd))
      const target = safeExpressTarget(root, hit.segments)
      if (!target) return notFound()
      let real = null
      try { real = realpathSync(target) } catch { return notFound() }   // 不存在
      const rootReal = (() => { try { return realpathSync(root) } catch { return root } })()
      const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
      if (real !== rootReal && !real.startsWith(prefix)) {              // 符号链接跳出去了
        logLine(`发布区：拒绝越界（符号链接）${real}`)
        return notFound()
      }
      let st = null
      try { st = statSync(real) } catch { return notFound() }
      if (!st.isFile()) return notFound()                                // 目录不列目录
      if (st.size > EXPRESS_MAX_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`too large (${st.size} > ${EXPRESS_MAX_BYTES})`)
        return true
      }
      const type = mimeOf(real)
      const head = {
        'content-type': type,
        'content-length': st.size,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        // 会被当文档执行脚本的类型（svg/html/xml/js）→ 加 sandbox：内联 <img> 照常显示，导航过去跑不了脚本
        ...(SANDBOX_TYPES.test(type) ? { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
      }
      res.writeHead(200, head)
      if (req.method === 'HEAD') { res.end(); return true }
      res.end(readFileSync(real))
      return true
    } catch (e) {
      logLine(`发布区服务失败：${e?.message ?? e}`)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('internal error')
      return true
    }
  }

  const handleMcApi = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // 🔴 2026-09-17：发布区**不再挂在 `/api/mc` 下**（旧地址 `/api/mc/dsh-mc-agent/<目录名>/…` 已停用）。
    //    新地址是 `/api/dsh-mc-agent/express/<工作区 uuid>/…`，由**自己的顶层前缀路由**服务（见 shareRoute）。

    if (req.method === 'GET' && path === '/api/mc/status') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const sess = registry.peek(sessionId)
      if (!sess) return sendJson(res, 200, { ok: true, active: false })
      // 🔴 active = **真在游戏里**（机器人在线 或 看门狗挂着），不是"这个会话碰过 mc_* 工具"。
      //    只要调过一次 mc_status 就会建 McSession；若按"存在即 active"，
      //    状态条会在所有用过的会话上永久显示"未上线"（用户要的是"只在真进游戏时显示"）。
      // 🔴 2026-09-19 补：**正在自动重连**时也要算 active —— 否则刚断线状态条就整个消失，
      //    用户看不到"断了、正在重连"，还以为插件把状态忘了。
      //    （用 reconnecting || reconnectPending：后者覆盖"正在尝试连接"那段，最长 45s）
      const active = Boolean(sess.bot.online)
        || Boolean(sess.bot.reconnecting || sess.bot.reconnectPending)
        || Boolean(sess.watchdog?.armed)
      if (!active) return sendJson(res, 200, { ok: true, active: false })
      return sendJson(res, 200, {
        ok: true, active: true, sessionId,
        ...sess.bot.status(), ...sess.modeView(),
        lastTimeout: sess.bot.lastTimeout ?? null,
        timeouts: sess.bot.stats?.timeouts ?? 0,
      })
    }

    if (req.method === 'GET' && path === '/api/mc/sessions') {
      return sendJson(res, 200, { ok: true, sessions: registry.listSessions() })
    }

    /* ── 「MC设置」入口的模式门控（2026-09-16；2026-09-18 调整）─────────────
     * 前端只该在 **MC 模式**的会话里显示设置入口（普通会话显示过按钮，出过事故）。
     * 这里给出**与 restrict/guard 完全同一个判据**（isMcModeAgent）的真值。
     *
     * 🔴 2026-09-18 用户要求改口径：**有没有选工作区，只要新对话选中了 MC 模式就显示按钮**；
     *    工作区改到**点按钮时**再检查，没有就提示用户先选。
     *    所以这里**不再**因为"没工作区"把 `mcMode` 压成 false（那正是前端藏入口的依据）——
     *    改成额外报 `hasWorkspace`，让前端自己决定是打开设置还是提示。
     *    注意：`applyMcModePolicy` 里"没工作区就不当 MC 会话"的**服务端行为没变**
     *    （不套工具白名单、不注入提示词、`.dsh-mc-agent` 也不建），变的只是**入口可见性**。
     * ──────────────────────────────────────────────────────────────────── */
    if (req.method === 'GET' && path === '/api/mc/mode') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      let mcMode = false
      let mcPlus = false
      let agent = null
      let reason = null
      let hasWorkspace = null
      if (sessionId) {
        try {
          agent = ctx.get('agents')?.get?.(sessionId) ?? null
          // 🔴 判据是 **preset**（与 restrict/guard 同一个 isMcModeAgent）——
          //    **不再**因为"没工作区"把它压成 false：那是前端藏入口的旧依据，
          //    而 2026-09-18 起入口一律显示、工作区改到点击时检查（另报 hasWorkspace）。
          mcMode = agent ? isMcModeAgent(agent) : mcModeAgentIds.has(sessionId)
          mcPlus = agent ? isMcPlusAgent(agent) : mcPlusAgentIds.has(sessionId)
        } catch {
          mcMode = mcModeAgentIds.has(sessionId)
          mcPlus = mcPlusAgentIds.has(sessionId)
        }
        if (agent) {
          hasWorkspace = Boolean(workspaceOf(agent))
          if (!hasWorkspace && mcMode) reason = 'no-workspace'
        } else if (noWorkspaceRefused.has(sessionId)) {
          reason = 'no-workspace'
          hasWorkspace = false
        }
      }
      // 诊断：把"判定依据"和"各段实际长度"一并报出来。
      // 2026-09-16 事故的教训：只回一个 false，谁都查不出是 preset 没认出来还是段没注册。
      let diag = null
      if (sessionId) {
        try {
          const cwd = workspaceOf(agent)
          const aid = noteAgent(agent)
          const root = cwd ? memoryRootFor(cwd, aid) : null
          const cur = root ? readAgentsMd(root) : { path: null, source: null, text: '' }
          const sent = sentNoticeRels(agent)
          diag = {
            reason,
            workspace: cwd,
            presetId: (agent && lastPresetSeen.get(agent)) ?? null,
            agentFound: Boolean(agent),
            serviceReady: Boolean(agentPresetsSvc) || (() => { try { return Boolean(ctx.get('agentPresets')) } catch { return false } })(),
            memoryRoot: root,
            agentsMd: { path: cur.path, exists: cur.path ? existsSync(cur.path) : false, source: cur.source, bytes: Buffer.byteLength(cur.text) },
            // **实际投出去的**插件提示行（不是"我们打算投"）：投递是唯一通道，这里就是判据
            notices: sent,
            segments: {
              'agents-md': sent.includes('.dsh-mc-agent/RULES.md') ? cur.text.length : 0,
              'workspace-agents-md': sent.includes('AGENTS.md') ? 1 : 0,
              'memory-index': sent.includes('.dsh-mc-agent/README.md') && root ? memoryIndexText(memoryFor(cwd, aid)).length : 0,
            },
          }
        } catch (e) { diag = { reason, error: String(e.message) } }
      }
      return sendJson(res, 200, { ok: true, sessionId, mcMode, mcPlus, hasWorkspace, diag })
    }

    if (req.method === 'POST' && path === '/api/mc/stop') {
      const body = await readJsonBody(req)
      const sessionId = String(body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId 必填' })
      // 用户 2026-09-16：**普通停止已移除**，这里只有强制停止一种语义
      // （顺序：停 LLM → 优雅退游戏 → 清该会话后台任务 → 再停一次 LLM）。
      // body.hard 不再有意义，传了也忽略（旧前端/旧脚本兼容）。
      const result = await stopSession(sessionId, {
        reason: body.reason ? String(body.reason) : '用户强制停止',
      })
      return sendJson(res, 200, { ok: true, ...result })
    }

    /* ── 「连接到MC」弹窗点「连接」/ 局域网行：**注入提示词 + 让该会话跑一轮** ──────────
     * 🔴 这里**只注入、不真连**：真正的连接由 LLM 去调 `mc_connect` 完成（用户 2026-10-04 定）。
     * 🔴 注入走**插件提示行**（`source.kind='plugin:dsh-mc-agent'`），**绝不冒充用户发言**；
     *    唤醒范式照抄看门狗（先 interruptWait，再 steer——空闲起一轮、运行中插话）。
     * 历史只记**手动输入**的地址（`via!=='lan'`）；局域网直连不记。 */
    if (req.method === 'POST' && path === '/api/mc/connect') {
      const body = await readJsonBody(req)
      const sessionId = String(body.sessionId ?? '')
      const address = String(body.address ?? '').trim()
      const via = body.via === 'lan' ? 'lan' : 'manual'
      if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId 必填' })
      if (!address) return sendJson(res, 400, { ok: false, error: 'address 不能为空' })
      const agent = safeAgentById(sessionId)
      if (!agent) return sendJson(res, 400, { ok: false, error: '找不到这个会话（sessionId 不对或会话已结束）' })
      const acc = accounts.resolve(String(body.accountId ?? '').trim() || null)
      const view = acc ? accounts.view(acc) : null
      const accountLabel = view ? `${view.name} (id: ${view.innerID})` : '(默认账户)'
      const asUser = body.asUser === true
      const text = buildConnectPrompt({ address, account: accountLabel, via })
      if (via !== 'lan') serverHistory.record(address)
      // 唤醒范式（照抄 src/watchdog.mjs）：先打断可能的 mc_events 等待，再 steer
      try { registry.peek(sessionId)?.interruptWait?.('connect') } catch { /* 没在等就算了 */ }
      /**
       * 🔴 **新对话页**（`asUser:true`）：插件提示行在新会话里不灵（实测）⇒ **模拟玩家发言**：
       *    来源 `kind:'user'`、正文前加 `[system] `。**对话中**仍走插件提示行（`plugin:dsh-mc-agent` + notice）。
       */
      const message = asUser
        ? userMessage({ content: [{ type: 'text', text: `[system] ${text}` }], source: { kind: 'user' } })
        : userMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:dsh-mc-agent', form: 'notice', summary: `连接到MC：${address}`.slice(0, 120) },
        })
      agent.steer(message)
      logLine(`连接到MC：已${asUser ? '投递玩家消息' : '注入提示词'}（${address}｜${accountLabel}｜via=${via}）`)
      return sendJson(res, 200, { ok: true, injected: true, asUser, address, account: accountLabel })
    }

    /* ── 「MC设置」模态框用的接口（门控名单 / 账户 / 认证服务器 / 白名单 / 提示词 / 文件分享 / 服务器历史与探测）──
     * 🔴 2026-09-17 隔离实例实测抓到的**真 bug**：`/api/mc/presets` 一直没进这个分派名单
     *    （它只在 `handleSettingsApi` 里判过），于是真机上它一律 404 —— 前端只能靠
     *    `MC_PRESETS_FALLBACK` 兜底，名单一旦和默认值不同就悄悄失灵。谁再加接口，**记得也加这里**。 */
    if (path.startsWith('/api/mc/accounts') || path.startsWith('/api/mc/authservers')
      || path.startsWith('/api/mc/agents-md') || path === '/api/mc/config'
      || path === '/api/mc/express' || path === '/api/mc/memory' || path === '/api/mc/memory/open'
      || path === '/api/mc/worlds'
      || path === '/api/mc/update' || path === '/api/mc/update/apply'
      || path === '/api/mc/presets'
      || path === '/api/mc/servers' || path === '/api/mc/lan') {
      try {
        return await handleSettingsApi(req, res, path, url)
      } catch (e) {
        const err = { ok: false, error: String(e?.message ?? e) }
        if (e?.needUserAction) { err.needUserAction = true; if (e.hint) err.hint = String(e.hint) }
        // 审计：请求体超限等错误自带 statusCode，别一律回 200。
        return sendJson(res, Number(e?.statusCode) || 200, err)
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown endpoint ${req.method} ${path}` })
  }

  const apiRoute = {
    kind: 'prefix',
    path: '/api/mc',
    handler: async (req, res) => {
      if (!isTrustedRequest(req.headers, liveTrustedHosts())) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      try { await handleMcApi(req, res) } catch (e) {
        ctx.logger?.warn?.(`[dsh-mc-agent] /api/mc 处理失败：${e instanceof Error ? e.message : String(e)}`)
        sendJson(res, Number(e?.statusCode) || 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(apiRoute), 'dsh-mc-agent: /api/mc 路由')

  /**
   * 发布区服务路由（用户 2026-09-17 定稿）：`/api/dsh-mc-agent/express/<工作区 uuid>/<剩余路径>`。
   *
   * 为什么单独一条前缀路由而不是挂 `/api/mc` 下：
   *   · 用户要求地址**放在 `/api` 后面**、但不要混进 `/api/mc`（那是设置接口）；
   *   · webServer 是**最长前缀优先**（`packages/host/webserver/src/index.ts:317`），
   *     所以 `/api/dsh-mc-agent` 会赢过宿主自己在 `/api` 上的 RPC 前缀，跟注册顺序无关；
   *   · 信任栅栏得**自己再过一遍**（`/api/mc` 那道只管它自己），判据与用法完全一致。
   *
   * 🔴 只有「在线」模式才服务（关闭模式 404）：不留"以为关了其实还能访问"的口子。
   */
  const shareRoute = {
    kind: 'prefix',
    path: '/api/dsh-mc-agent',
    handler: async (req, res) => {
      if (!isTrustedRequest(req.headers, liveTrustedHosts())) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      try {
        if (!pluginConfig.expressEnabled) {
          logLine('发布区：当前「文件分享」是关闭的，不提供访问（/api/dsh-mc-agent/… 只在开启时开）')
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('not found (sharing disabled)')
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const hit = parseExpressPath(url.pathname)
        if (!hit || (req.method !== 'GET' && req.method !== 'HEAD')) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('not found')
          return
        }
        serveSharedFile(req, res, hit)
      } catch (e) {
        ctx.logger?.warn?.(`[dsh-mc-agent] /api/dsh-mc-agent 处理失败：${e instanceof Error ? e.message : String(e)}`)
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(shareRoute), 'dsh-mc-agent: /api/dsh-mc-agent 路由（发布区）')

  // 启动自检标记：确认"插件到底加载了没"（同时写 dsh-mc-agent.log 与宿主日志）
  const startup = `插件已加载｜pid=${process.pid}｜每会话独立实例｜工具注册中…`
  logLine(startup)
  ctx.logger?.info?.(`[dsh-mc-agent] ${startup}`)

  /* ─────────── 「遗言」网：未处理拒绝会要了整个 Harness 的命，至少把原因留下来 ───────────
   * 背景（2026-09-17 真机）：宿主的 `installFailLoud`（`apps/cli/src/profile-boot.ts:311` →
   * `packages/boot/app-boot/src/index.ts:652`）把**任何**未处理拒绝当致命，打印
   * `dsh: fatal load failure` 然后 `exit(1)`。插件**无法否决**它的 exit（别的监听的
   * `process.exit` 拦不住），所以能做的只有两件：① 自己链路零悬空 + 把第三方已知的悬空点补掉
   * （见 core.mjs 的 yggdrasil 兼容层与 sessionFlags）；
   * ② 在进程被杀之前**把那条拒绝的栈写进我们的日志**，免得下次只能看到一句 fatal load failure。
   * ⚠️ 只记录，不吞：宿主该怎么处置还是怎么处置（我们不改变它的行为）。
   * ------------------------------------------------------------------------ */
  try {
    let logged = 0
    process.on('unhandledRejection', (reason) => {
      if (logged >= 5) return                    // 别刷爆日志
      logged++
      const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      logLine(`⚠️ 未处理拒绝（宿主可能会因此 exit(1)，栈如下，请据此定位）：${stack.split('\n').slice(0, 6).join(' ⏎ ')}`)
    })
  } catch (e) { logLine(`装未处理拒绝记录器失败（不影响使用）：${e?.message ?? e}`) }

  /* ─────────── 「别让它崩」闸：把寻路那几种**正常结局**的未处理拒绝拦下来 ───────────
   * 2026-10-20（GitHub issue #1，用户报的一晚上闪退 3 次）：`mc_move` 被抢占之后，
   * `mineflayer-pathfinder` 会把上一次的 goto reject 成 `PathStopped`，而它已经没人 await 了
   * （超时先返回 / 新目标顶掉 / collectBlock 内部先撤）⇒ unhandledRejection ⇒ 宿主 fail-loud exit(1)。
   * 上面那条"遗言"只能记录，救不回来；`work.catch()` 与 `guardPathfinderRejections()` 只盖住
   * goto 直接返回的那个 promise，**派生链（withTimeout → raceAbort → Promise.race）盖不住**。
   * 所以这里接管宿主的 unhandledRejection：白名单内吞（记一行日志），其余原样转交 —— 真 bug 照崩。
   * 详见 `src/crash-guard.mjs`；`DSH_MC_AGENT_REJECTION_GUARD=off` 可关。 */
  try {
    const g = installRejectionGuard({ log: (m) => logLine(m) })
    if (g.installed) logLine(`未处理拒绝守卫已装：拦 PathStopped / NoPath / GoalChanged / Timeout，其余照旧转交（接管了 ${g.forwarded} 个原监听）`)
    else if (g.reason === 'disabled') logLine('未处理拒绝守卫：环境变量 DSH_MC_AGENT_REJECTION_GUARD 已关闭，仍按宿主默认处置')
    /* 装完之后可能还有人注册 unhandledRejection（宿主 fail-loud 晚于插件、或别的插件后来插一条）——
     * 那种会排在我们后面单独跑，照样能 exit。低频补挂一次，保持"只有我们一个 handler"。 */
    if (g.installed) {
      ctx.effect(() => {
        const t = setInterval(() => { try { refreshRejectionGuard({ log: (m) => logLine(m) }) } catch {} }, 60_000)
        t?.unref?.()
        return () => clearInterval(t)
      }, 'dsh-mc-agent: 未处理拒绝守卫补挂')
    }
  } catch (e) { logLine(`装未处理拒绝守卫失败（不影响使用）：${e?.message ?? e}`) }

  /* ─────────── 开 DSH 时查一次更新（用户 2026-10-21：「可以做到开 dsh 检查一次吗」）───────────
   * 只查一次、不重试，约 15 秒后跑（别跟插件初始化抢资源）；结果落进 `updateCache`，
   * 于是红点和更新页第一次打开就是现成的，不用等 git。查失败只记 debug，绝不打扰。
   * 关掉：配置 `updateCheckOnStart: false`，或环境变量 `DSH_MC_AGENT_UPDATE_ON_START=off`。 */
  if (pluginConfig.updateCheckOnStart !== false && String(process.env.DSH_MC_AGENT_UPDATE_ON_START ?? '').toLowerCase() !== 'off') {
    ctx.effect(() => {
      const t = setTimeout(() => {
        Promise.resolve()
          .then(() => updaterRef.check?.(true))
          .then((d) => {
            if (d?.behind > 0) logLine(`发现新版本（启动检查）：落后 ${d.behind} 个提交，设置 → 更新 里可以一键更新`)
            else if (d?.ready === false) logDebug(`启动检查更新：${d.reason ?? '拿不到远端信息'}`)
          })
          .catch((e) => logDebug(`启动检查更新失败（不影响使用）：${e?.message ?? e}`))
      }, START_UPDATE_CHECK_MS)
      t?.unref?.()
      return () => clearTimeout(t)
    }, 'dsh-mc-agent: 启动查一次更新')
  }

  /* ─────────── 「闪退」网：uncaughtException 至少留下栈 ───────────
   * 2026-10-18：mineflayer-pathfinder 的 tick 监听在某次 `placingBlock` 为 undefined 时抛错，
   * 从 setInterval 回调冒到进程级 ⇒ 宿主直接弹"应用无法启动或已意外停止"。
   * 真正的修法是接管那个监听（`src/plugins.mjs` 的 `guardPathfinderTicks`），
   * 这里只是**最后一层记录**：真还有别的裸抛，至少下次能在插件日志里看到栈。
   * ⚠️ 只记录，不 exit（宿主自己的处置照旧）。 */
  try {
    let loggedCrash = 0
    process.on('uncaughtException', (err) => {
      if (loggedCrash >= 5) return
      loggedCrash++
      const stack = err?.stack ?? String(err)
      logLine(`🔴 未捕获异常（可能是宿主崩掉的原因，栈如下）：${stack.split('\n').slice(0, 8).join(' ⏎ ')}`)
    })
  } catch (e) { logLine(`装未捕获异常记录器失败（不影响使用）：${e?.message ?? e}`) }


  /**
   * 紧凑 JSON（2026-10-18 审计）：把 `null` / `undefined` / 空对象 / 空数组先剔掉，
   * 再 `JSON.stringify` 成**一行**。
   *
   * 以前 `text()` 兜底 `JSON.stringify(v, null, 2)` —— `mc_act` / `mc_move` 成功时
   * 也是一整片缩进换行（几十个字段里一半是 `/` 与 `"),`），模型要读的只是其中几项。
   * 单行 + 去空字段能省掉 30~50% 的字符，形状和键名都不变。
   */
  const compactJson = (v) => {
    const strip = (x) => {
      if (Array.isArray(x)) return x.map(strip).filter((y) => y !== undefined && y !== null)
      if (x && typeof x === 'object' && !(x instanceof Date)) {
        const o = {}
        for (const [k, v2] of Object.entries(x)) {
          if (v2 === undefined || v2 === null) continue
          const sv = strip(v2)
          if (Array.isArray(sv) && sv.length === 0) continue
          if (sv && typeof sv === 'object' && !Array.isArray(sv) && Object.keys(sv).length === 0) continue
          o[k] = sv
        }
        return o
      }
      return x
    }
    try { return JSON.stringify(strip(v)) } catch { return JSON.stringify(v) }
  }

  /**
   * 工具输出渲染：有 text 就用 text，否则走 compactJson（单行、去空字段）。
   *
   * 🔴 2026-10-23 审计：以前兜底是 `JSON.stringify(value2, null, 2)` —— 23 个没写 text 的工具
   *    （mc_move / mc_act / mc_attack / mc_trade …）每次都以两空格缩进的多行 JSON 交给模型。
   *    同一份数据实测多 38%（有嵌套对象 + around 数组时更多）。`compactJson` 本来就是为省 token 写的，
   *    只是当时只接到了个别分支上。键名与形状不变，模型读起来只有"换行没了"这一处差别。
   *
   * ⚠️ 定义必须排在 `compactJson` 之后（它是 const 箭头函数，提前引用会踩 TDZ，插件直接加载失败）。
   */
  /* 🔴 2026-10-29（用户给的输出规范）：兜底从"有 text 用 text / 否则整对象"改成走 `briefOf` ——
   *   ① 多行流水超 8 行就折叠明细（**留下所有失败/进度行**）；
   *   ② 成功结果删掉现场快照（`around`/`entities`）与诊断中间量；
   *   ③ 失败/部分完成一律保留诊断（`blockedAhead`/`hint`/`remaining`/`reason`）。
   *   执行结果与验证逻辑一个字没动，只改模型看到的东西。 */
  const text = (value, render) => ({
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (args, value2) => [{
      type: 'text',
      text: render ? render(args, value2) : briefOf(value2, { json: compactJson }),
    }],
  })
  /** 保留两位小数（省 token：`-3.366740127096657` → `-3.37`；不是数字就原样返回） */
  const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : n)

  /**
   * 给动作结果补"三种结局"（用户 2026-10-08 路线图第 ⑥ 条）。
   *
   * 为什么值得多两个字段：模型看到 `{arrived:false, moved:3.2, reason:'budget'}` 时，
   * 只能自己猜"这是失败了还是还没走完"。而 `budget`/`timeout`/`preempted` 的真实含义是
   * **结果未知** —— 人可能已经挪了几格、那一镐可能已经挖下去了。把结局写在结果里，
   * 模型就不会把"时间到了"当"没做成"再重做一遍（重做有时比不动更糟：刚放好的方块又被挖掉）。
   *
   * 只加字段、不改原有结构（`text()` 的渲染是 `JSON.stringify`，新字段自动出现在输出里）；
   * 数组/标量返回值原样透传（`dig()` 那种返回数组的走"往数组里 push 一行判决"那条路）。
   */
  /* 🔴 2026-10-23 审计：mc_config 无论改没改都把 `config` 与 `defaults` 各回一遍 —— 用户多半只在默认值时读它，
   *    那份重复等于把同一坨 JSON 说两遍。只有真的改过（值不同于默认）才附 `defaults` 供对照。 */
  const configPair = (cfg) => {
    const defaults = JSON.parse(JSON.stringify(WATCH_DEFAULTS))
    const same = JSON.stringify(cfg) === JSON.stringify(defaults)
    return same ? { config: cfg } : { config: cfg, defaults }
  }

  const withOutcome = (res, opts = {}) => {
    if (!res || typeof res !== 'object' || Array.isArray(res)) return res
    if (res.outcome) return res
    const outcome = outcomeOf(res, opts)
    return { ...res, outcome, outcomeText: verdictText(outcome) }
  }

  /* 2026-10-29（用户：「为什么现在 ai 死了好像不知道」）：
   * 死亡会自动重生（mineflayer `loader.js:75` 默认 `respawn = true`），位置一下就跳回重生点。
   * 以前这件事只进事件队列（要主动 mc_events 才看得到），工具返回里只剩“走不动/没路/太远”
   * —— 模型看不出是因为死了一次。这里给动作开一份“这期间死过没”的对账。 */
  const deathMarkOf = (sess) => Number(sess?.stats?.deaths ?? 0) || 0
  const deathNoteOf = (sess) => {
    const life = sess?._life ?? {}
    const pos = life.position ?? null
    const back = life.respawnPosition ?? null
    return {
      died: true,
      ...(pos ? { diedAt: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } } : {}),
      ...(back ? { respawnedTo: { x: Math.round(back.x), y: Math.round(back.y), z: Math.round(back.z) } } : {}),
    }
  }
  const deathLineOf = (sess) => {
    const n = deathNoteOf(sess)
    const f = (q) => (q ? `(${q.x}, ${q.y}, ${q.z})` : '位置不明')
    return `\n\u2620 这期间我死了一次（死在 ${f(n.diedAt)}），现在在重生点 ${f(n.respawnedTo)} —— 刚才那个目标作废了。`
  }

  /**
   * 🔴 2026-10-25（用户：「move和dig如果没办法到那格应该自动切换成可破坏」）：
   *   默认不挖（`noDig:true`）走不通时，**自动**改成允许挖穿挡路方块再走一次。
   *   只在这几种原因上重试：路被方块挡住 / 卡住 / 目标不可达 / 头顶被堵（`no-headroom`）。
   *   区块没加载、预算用完、危险方块、服务端不回包、被叫停都不重试（挖了也没用，还可能添乱）。
   *   时间分配：第一遍不挖只给 40%（优先让它绕路），剩下的 60% 留给挖穿那一遍（总共仍不超过一次调用的预算）。
   */
  /* 🔴 2026-10-25 自查：以前这里写的是 'stuck' / 'no-path' / 'unreachable' —— **全是幽灵值**，
   *   `src/movement.mjs` 根本不产生这几个 reason（真实值是下面这些，含大写 `NoPath`）。
   *   写错就等于自动挖穿从来没生效过，所以列真值并把断言钉在 `check-mc-pathfinder`。 */
  const AUTO_DIG_REASONS = new Set(['NoPath', 'ceiling', 'goal-not-standable', 'goal-reached-elsewhere', 'goal_reached-but-far'])
  /* 🔴 2026-10-28 实机（用户：「工具报回来的移动预算只有 4 秒左右，所以从 y48 爬回地表花了六七次调用」）：
   *   第一遍只给 40%（10 秒 → 4 秒），而以 `timeout` 结束时以前**不认**（这里只列 NoPath 一类），
   *   于是"4 秒用完 + 剩下 6 秒直接扔掉"，一次调用只推进 3~4 格。
   *   眼前确实有方块挡着（`blockedAhead`）时，剩下的时间正好改成挖穿 —— 仍不超过这一次调用的总预算。 */
  const autoDigWorth = (r) => Boolean(r) && r.arrived === false
    && (AUTO_DIG_REASONS.has(String(r.reason ?? '')) || r?.stepUp?.why === 'no-headroom'
      || (String(r.reason ?? '') === 'timeout' && Boolean(r.blockedAhead)))
  const walkWithAutoDig = async (sess, target, opts, budgetMs, autoDig) => {
    const total = callBudget(budgetMs)
    if (!autoDig) return await sess.bot.walkTo(target, { ...opts, noDig: opts.noDig !== false, budget: total })
    /* 🔴 2026-10-27 实机（用户：「水里用 move」）：`noDig:true` 那套"先一格不挖试 40%、走不通再改成挖穿"
     *   在**深水**里毫无意义 —— 水格挖不动也绕不开，游泳是唯一的路。以前照样按 40% 试、失败再来一遍，
     *   实测 5 次 `swim-budget` 全是 `budgetMs × 0.4`（9000→3.8 秒、10000→4.0 秒）：一条 20 格的河
     *   被切成两段各 3~4 秒，模型得连叫三次才过。深水里直接一遍吃满预算（第二遍对游泳没有新信息）。 */
    let deepWater = false
    try { deepWater = inWaterNow(sess?.bot) && sess?.bot?.entity?.onGround !== true } catch { deepWater = false }
    if (deepWater) return await sess.bot.walkTo(target, { ...opts, noDig: true, budget: total })
    const secOf = (ms) => `${(Math.max(0, Math.round(ms / 100)) / 10).toFixed(1)} 秒`
    const t0 = Date.now()
    /* 第一遍（一格不挖）只分 40%：优先让它绕路。剩下的时间一定留给"挖穿"那一遍，
     * 别再出现"第一遍 4 秒超时、剩下 6 秒白扔"（2026-10-28 实机）。 */
    /* 🔴 2026-10-28（用户：「刚刚的 move 就给 4 秒」）：这里以前把第一遍切成 `total × 0.4`
     *    —— 10 秒的预算第一遍只有 4 秒，用户看到的就是"move 只给 4 秒"。
     *    现在第一遍**直接吃满**：真走不通会很快返回（实测 NoPath 0.3 秒），剩下的时间自然
     *    全留给"挖穿"那一遍；而"一直在走、只是没走到"本来就不该被切碎。
     *    第二遍的门槛提到 3 秒 —— 剩不到 3 秒挖穿也挖不了几块，白折腾。 */
    const first = await sess.bot.walkTo(target, { ...opts, noDig: true, budget: total })
    if (!autoDigWorth(first)) return { ...first, budgetPlan: { totalMs: total, trialMs: total } }
    const left = total - (Date.now() - t0)
    if (left < 3_000) return { ...first, budgetPlan: { totalMs: total, trialMs: total, digMs: 0 } }
    const second = await sess.bot.walkTo(target, { ...opts, noDig: false, budget: left })
    if (second?.arrived === true) {
      return {
        ...second,
        autoDug: true,
        budgetPlan: { totalMs: total, trialMs: total, digMs: left },
        hint: [second.hint, `（这一轮一共 ${secOf(total)}：先试"不挖绕路"没成，最后 ${secOf(left)} 改成挖穿挡路的方块过来的）`].filter(Boolean).join(' '),
      }
    }
    return {
      ...first,
      autoDugTried: true,
      budgetPlan: { totalMs: total, trialMs: total, digMs: left },
      hint: [first.hint, `（这一轮一共 ${secOf(total)}：先试不挖绕路、再用 ${secOf(left)} 挖穿，都没到：${second?.reason ?? first.reason ?? '未知原因'}）`].filter(Boolean).join(' '),
    }
  }

  /**
   * 工具定义统一入口：
   *   ① 返回值无损化（宿主要求无损 JSON；mineflayer 到处返回 Vec3 类实例）
   *   ② 注入本轮 turn 的 exec.signal 给 bot —— 这是"停止按钮真的有效"的关键：
   *      宿主的 cancel 只是 abort 一个 signal（它无法抛弃同进程 pending 的 promise，
   *      见 packages/core/tools/src/index.ts:219 "cannot hard-kill same-process code"），
   *      所以必须由我们在每个 mineflayer await 上监听它，否则按停止要等本地超时（最长 25s）。
   */
  /**
   * MC 模式白名单里的**文件工具**（宿主 tool-fs / tool-fs-search 注册的名字）。
   *
   * 🔴 用户 2026-09-16："读写文件都只能在记忆文件夹内！" —— 这几个工具留在可见面上
   *    （看地图、写 SVG、读回自己存的图都要用），但路径由 guard 硬限在 `<工作区>/.dsh-mc-agent/`。
   */
  const MC_FILE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'read_image']

  /**
   * MC 模式白名单里的**交付工具**：`present`（宿主 `@deepseek-ai/dsh-tool-present`）。
   *
   * 🔴 用户 2026-09-16 定的：删掉 `mc_kit_share`（它其实是在调宿主另装的 dsh-file-host，插件本身
   *    没有文件服务器），改用 DSH 自带的交付机制 —— `present` 会往会话里写 `deliverables/presented`，
   *    Web 端 `ui-deliverables` 在该轮末尾渲染**产出文件卡片**（可预览、可打开），正文里写成行内代码的
   *    文件名也会变成可点链接。也就是说："让本地用户看到文件"这件事，宿主本来就提供。
   *    它按 preset 挂载（随附 Web 的 standard/ptc/cordis 有，minimal 没有）—— 我们负责
   *    ①把 `tool-present` 组补进 MC 模式的 preset ②把它放进白名单。
   * 交付路径由 guard 限在**本会话工作区**内（`.dsh-mc-agent/` 与 `out/` 都在里面）。
   */
  /**
   * 配套插件（**别的包**装的工具）里，MC 模式**默认放行**的那些。
   *
   * 🔴 用户 2026-10-19：「MC 模式这个会话的工具集里默认缺了 ACP 那一族。这个可以做成默认打开吗，
   *    让用户装完就能用压缩等插件」。
   *
   * 名单 = billion-context（ACP）那一族：上下文压缩/还原/检索 + 状态 + 缓存账本。
   * 它们**只读会话上下文、不碰世界**，进 MC 模式没有任何越权风险（文件工具那条
   * `<工作区>/.dsh-mc-agent/` 的限制跟它们无关）；而 MC 会话动辄两三小时、上下文最吃紧，
   * 少了 `compress` 就只能硬扛。
   *
   * ⚠️ 这是**名字**不是包名：宿主没装/没挂同名工具时会被 `restrict({allow})` 过滤掉
   * （见下面的 applyAllow），不会让整次白名单作废。开关：`mcMode.allowCompanionTools`。
   */
  const MC_COMPANION_TOOLS = [
    'compress', 'decompress', 'search_context', 'acp_status', 'acp_cache', 'acp_read_original_image',
  ]
  const MC_PRESENT_TOOL = 'present'

  /**
   * 从一次工具调用里取"要碰的路径"：是文件工具才返回（不是 → null；是但没给路径 → 空串）。
   * 路径参数名按宿主用 `path`，也兼容 harness 的 `file_path`；glob/grep 的目录参数同样是 `path`。
   */
  const fileToolPath = (exec) => {
    const name = String(exec?.name ?? '')
    /* 🔴 2026-10-15 审计（报告 C 第 3 条）：`ops_replace`（批量正则替换）会**真的写盘**，
     *   必须跟 write/edit 走同一套围栏（受保护文件只读 + 只能在记忆文件夹内）。它的路径参数也叫 `path`。 */
    if (!/^(read|write|edit|glob|grep|read_image|ops_replace)$/i.test(name)) return null
    const args = exec?.arguments ?? {}
    const v = args.path ?? args.file_path ?? args.dir ?? args.directory
    if (v === undefined || v === null) return ''
    return String(v)
  }

  /** `present` 那次调用里要交付的文件路径列表（不是 present → null） */
  const presentPaths = (exec) => {
    if (String(exec?.name ?? '') !== MC_PRESENT_TOOL) return null
    const files = exec?.arguments?.files
    if (!Array.isArray(files)) return []
    return files.map((f) => String(f?.path ?? '')).filter(Boolean)
  }

  /** 我们自己注册的工具名（MC 模式做工具白名单时要带上它们，否则会被 restrict 一并滤掉） */
  const ourToolNames = []

  /**
   * 工具注册的**唯一漏斗**（核心工具和所有扩展都走它）。
   *
   * 🔴 用户要求：**单次工具调用别超过 11 秒，宁可少量多次** ——
   *    一次挂几分钟的时候用户看不到消息、也没法插话（"太久根本获取不了消息"）。
   *    所以这里做两件事：
   *    ① 每次调用前给 bot 设"本轮截止时刻"（`CALL_MS`），`McBot` 内部的长动作
   *       （走远路 / 挖一片 / 搭一片 / 连串步骤 / 盯熔炉）都看它，到点**带着进度返回**，
   *       返回里带 `hint` 告诉模型"再叫一次接着做"；
   *    ② 把工具自己的 `timeoutMs` 压到 `CALL_MS + 1000` 兜底（DSH 层硬顶）。
   *    例外见 `LONG_TOOLS`：那些"一次调用就是要把握手/连接做完"或纯本地算图的。
   */
  const LONG_TOOLS = new Set(['mc_connect', 'mc_disconnect', 'mc_map', 'mc_kit_image'])
  /* 工具处理器表：`mc_task {action:"run"}` 的任务执行器靠它"干活"。
   * 为什么不让执行器直接调 `bot` 的方法（2026-10-14 "任务驱动"第二步）：
   * 任务层的分工是"看现场 → 决定下一步 → 干活 → 读结果"，干活必须走**和模型调用
   * 完全同一条路**（同一套参数、同一套 `lossless`），否则"执行器做的"和"模型做的"
   * 会慢慢分叉 —— 模型试出来的参数能行、执行器照抄却不行。
   * 存的是**裸 `execute`**（不是 `asTool` 包过的那层）：外面那层每次都会
   * `setCallDeadline(CALL_MS)` 重新给 11 秒，会把执行器自己那一轮的预算冲掉。 */
  const TOOL_HANDLERS = new Map()

  /**
   * 写动作统一走**动作调度器**（用户 2026-10-14 设计「统一动作调度」的**阶段 P0：只记账**）。
   *
   * 这一层只做四件事：给动作编号、登记它占了哪些资源、撞车时记一笔（或挡住）、
   * 让子步骤复用父动作的 `actionId`。**它不碰** `interruptMove()` / `_moveGen` / `_ctrlLease` ——
   * 抢占仍然只有 `interruptMove` 一条路（用户特意点名：不要再造第二套移动代次）。
   *
   * 只读工具（`resourceSpecOf()` 认不出）**根本不进这里**，行为与改动前逐字一致；
   * 写动作的返回值也原样透传（`r.result`），异常原样重抛 —— 所以 `observe-only` 模式下
   * "现有抢占和动作结果与改动前一致"是**结构上**成立的，不靠运气。
   */
  const runScheduled = async (sess, name, args, exec, fn, parent = null) => {
    const spec = sess.bot.actionSpecOf(name, args)
    if (!spec) return await fn(args, exec)
    /* 🔴 审计 F9：`TOOL_SPEC` 里没有一条写过 `priority` ⇒ `spec.priority` 恒 `undefined`，
     * 调度器把**所有**动作都当 `task`(30)。于是 `enforce` 模式下用户直接下的 `mc_move`
     * 抢不动任务执行器正在跑的 `mc_dig`（两者同级）。这里按调用来源分：
     * **顶层调用 = 用户指令**（`PRIORITY.user`），**任务执行器调出去的子步骤 = 任务**。 */
    const priority = spec.priority ?? (parent ? PRIORITY.task : PRIORITY.user)
    /* 🔴 阶段 P1 的排队预算（用户方案第 ③ 条）：
     *   · **子步骤一律 `0`（不排队）** —— 这是"等自己"那道死锁的结构性防线：子步骤要等的是
     *     它自己的父动作，而父动作不会在它退出前释放资源。子步骤只记账、不排队。
     *   · 顶层动作愿意等，但**不能等穿这一轮的调用预算** —— 留 800ms 给"等到之后真的干活"，
     *     否则等到最后 1ms 才拿到资源、动作一起步就被 `callLeft()` 掐掉，白排。 */
    const waitMs = parent
      ? 0
      : Math.max(0, Math.min(DEFAULT_WAIT_MS, Number(sess.bot.msLeft?.() ?? DEFAULT_WAIT_MS) - 800))
    const r = await sess.bot.actionScheduler().run({
      name,
      owner: agentIdOf(exec?.agent) ?? null,
      resources: spec.resources,
      priority,
      parent,
      waitMs,
      signal: exec?.signal ?? null,
      execute: async ({ actionId, signal: schedSignal }) => {
        /* 把"当前动作"放在 exec 上：`mc_task {action:"run"}` 要拿它当父动作，
         * 好让执行器调出去的子工具**继承同一个 actionId**。存旧值再还原 ——
         * 子动作退出时不能把父动作的 id 抹掉（否则后面的兄弟步骤就变成顶层动作了）。 */
        const prev = exec && typeof exec === 'object' ? exec.__actionId : undefined
        if (exec && typeof exec === 'object') exec.__actionId = actionId
        /* 🔴 阶段 P1：把调度器的信号**接进 bot 的中断链**。不接的话 `#preempt()` 的
         * `.abort()` 谁也看不见 —— 动作照跑、资源照占，抢占就成了"只写了行日志"。
         * 调度器的 controller 本来就转发宿主的 `exec.signal`，所以这一句是**包含**关系，不是替换。 */
        try { if (schedSignal) sess.bot.setAbortSignal(schedSignal) } catch { /* 接不上就算了 */ }
        try { return await fn(args, exec) } finally {
          if (exec && typeof exec === 'object') exec.__actionId = prev ?? null
        }
      },
    })
    if (r.status === 'failed') throw r.error
    if (r.status === 'busy') return { busy: true, blockedBy: r.blockedBy, note: r.note, waitedMs: r.waitedMs ?? 0 }
    return r.result
  }

  const asTool = (spec) => {
    if (spec?.name && !ourToolNames.includes(spec.name)) ourToolNames.push(spec.name)
    /* 表里存的是**包过调度器**的 handler（仍然不重置 `setCallDeadline`，预算没被冲掉）：
     * 任务执行器调出去的子工具因此也走同一条路，不会"绕开锁直接改状态"。
     * 父动作从 `exec.__actionId` 取 —— 模型直接调时它是空的（顶层动作）。 */
    if (spec?.name && typeof spec.execute === 'function') {
      TOOL_HANDLERS.set(spec.name, (args, exec) => runScheduled(
        getSession(exec), spec.name, args, exec, spec.execute,
        (exec && typeof exec === 'object' ? exec.__actionId : null) ?? null
      ))
    }
    const timeoutMs = LONG_TOOLS.has(spec?.name)
      ? spec?.timeoutMs
      : Math.min(Number(spec?.timeoutMs) || CALL_MS + 1_000, CALL_MS + 1_000)
    const strictParams = spec?.parameters
    return defineTool({
      ...spec,
      ...(strictParams && typeof strictParams === 'object' ? { parameters: loosenNumberParams(strictParams) } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      async execute(rawArgs, exec) {
        const args = coerceNumberArgs(strictParams, rawArgs)
        const sess = getSession(exec)
        sess.bot.setAbortSignal(exec?.signal)
        // 本轮截止时刻：长动作到点就带着进度返回，而不是把这次调用挂住
        sess.bot.setCallDeadline(CALL_MS)
        /* 📋 任务状态机（用户 2026-10-08 路线图第 ②③ 条）：每次调用喂一次记忆根，
         * 让"挖 16 根原木"这种长活儿的进度落在 `<记忆根>/tasks.json` 里 ——
         * 掉线、重连、换一轮对话回来都还在，不只在模型的对话上下文里。
         * 拿不到工作区/记忆根（理论上不会）就让 `setTaskDir(null)` 退化成只在内存里记。 */
        try { sess.bot.setTaskDir(memoryRootFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent))) } catch { /* 记不了就不记 */ }
        return lossless(await perfWrap(spec.name, () => runScheduled(sess, spec.name, args, exec, spec.execute, null)))
      },
    })
  }

  /** 从 exec 里拿 agentId，再拿到当前会话的 McSession */
  const getSession = (exec) => {
    const agent = exec?.agent
    if (!agent) throw new Error('拿不到当前会话（exec.agent 不可用）')
    // 记忆按会话分：每次工具调用都记一笔"这个工作区现在是谁的"，
    // 好让只拿得到工作区路径的调用点（扩展 / GUI / express）也能落到当前会话的记忆根。
    noteAgent(agent)
    return registry.getOrCreate(agent.id)
  }

  /* ── 状态与开关 ── */

  /**
   * `mc_status` 的**省 token 视图**（默认）。
   *
   * 🔴 2026-10-07 实测（`session-238258f4`，一局 156 步）：`mc_status` 被调了 14 次、每次约 2400 字符，
   *    合计 3.5 万字符 ≈ 全场工具输出的 1/4，而且**之后每一步都要重读一遍**。大头不是"现在要知道的"，
   *    而是三块**静态或可查**的东西：
   *      · `watch.config`（10 个 wakeOn 开关 + 10 条 mentionPatterns + 7 个阈值）≈ 900 字符 —— 用 `mc_watch`/`mc_config` 查；
   *      · `recentChat` 5 条**全文** ≈ 800 字符（自己说的话还被服务端回显一遍，`self` + `player` 两条一模一样）；
   *      · `modeView()` 里与 `status()` 重复的 `online` / `sub` / `connection`，以及没用的长浮点。
   *    默认只回"看一眼就知道该干什么"的；要明细传 `verbose:true`。前端 UI 走 `sessionView()`，不受影响。
   *
   * 🔴 再省一层（同一轮）：**直接回一行行文本**，不回对象。宿主的规则是"有 `text` 用 text，
   *    没有就把对象 pretty-print 成 JSON"——回对象的话光是键名 + 缩进 + 引号就多花一倍字符。
   */
  /* 🔴 2026-10-19：打 Boss（末影龙/凋灵）时**只有 Boss Bar 有血**，实体列表读不到
   *    ⇒ 每个动作结果里顺手带一份，射一箭就知道"打到几成了"，不用再问用户。 */
  const bossBarsField = (bot) => {
    try {
      const bars = bot?.readBossBars?.() ?? []
      return bars.length ? { boss: formatBossBars(bars), bossBars: bars } : {}
    } catch { return {} }
  }

  const statusLean = (sess, s, w) => {
    const bits = [s.online ? `🟢 ${sess.mode}` : `⚪ ${sess.mode}`]
    if (sess.bot.reconnecting || sess.bot.reconnectPending) bits.push('重连中')
    if (s.online) {
      const p = s.position ?? {}
      bits.push(
        `我在 (${p.x}, ${p.y}, ${p.z})（y=脚底那格，脚下方块在 y-1）`,
        /* 2026-10-23 审计：mc_observe 用度（yaw=180°）、mc_status 原来用弧度（yaw 3.14），
         * 同一个朝向两个口径会让模型读错。统一成度。 */
        `朝 yaw ${Math.round((((s.yaw * 180) / Math.PI) % 360 + 360) % 360)}° / pitch ${Math.round((s.pitch * 180) / Math.PI)}°`,
        `血 ${round2(s.health)}/20`, `食 ${s.food}`, `手 ${s.held ?? '空'}`,
        /* 🔴 2026-10-27 实机：AI 从岩浆爬出来后「脚还在岩浆边就停下吃东西，直接烧死了」。
         *   `entity.fire`（身上着火）必须在状态里出现，否则模型不知道自己还在烧。 */
        ...(s.fire === true ? ['🔥 **身上还在烧**（刚从岩浆/火里出来，别停下吃东西：先走到水里或空地，火灭了再干别的）'] : []),
        `${s.gamemode ?? '?'} / ${s.dimension ?? '?'} / 时间 ${s.time ?? '?'}`,
      )
      // 在水里就把氧气一起报出来：淹死 = 氧气掉到 0 之后开始掉血，不报这一项 AI 看不出自己快淹死了。
      // 🔴 1.21.9/1.21.10 的服上氧气读数常常是 null（见 core.mjs status() 的注释），
      //    所以 `submerged`（头在水下）才是可靠信号 —— 读不到氧气时也要说清"头在水下"。
      if (s.inWater) {
        const head = s.submerged === true
          ? '，头在水下（憋气中）'
          : (s.submerged === false ? '，头在水面上' : '')
        bits.push(s.air == null
          ? `在水里${head || '（读不到氧气读数）'}${s.submerged === true ? '（游泳会自己上浮换气）' : ''}`
          : `在水里（氧气 ${s.air}/20${s.air <= 6 ? '，快淹死了：直接 mc_move 到岸上，路上自己会上浮' : ''}）${head}`)
      }
    } else {
      bits.push('不在游戏里')
      if (s.ghost) bits.push('（连接已结束，bot.entity 是残留）')
      if (s.reconnecting) bits.push('正在自动重连')
      if (s.lastError) bits.push(`上次错误：${s.lastError}`)
    }
    const lines = [bits.join(' ｜ ')]
    /* 🔴 2026-10-19 用户点的坑"读不到末影龙血量"：龙/凋灵的血只在 Boss Bar 里，
     *    实体列表读不到 ⇒ 有血条就把"还剩几成 / 多少点"直接放状态条第二行。 */
    if (s.online && s.bossBars?.length) lines.push(`🗡 ${formatBossBars(s.bossBars)}`)
    /* 2026-10-23 审计：以前把**全部**在线玩家名都打出来（大服能到 800 字符，且绝大多数与本轮决策无关）。
     * 只报人数 + 前 4 个名字，剩下的省略号带过。 */
    if (s.online && s.players?.length) {
      const more = s.players.length > 4 ? ` 等 ${s.players.length} 人` : ''
      lines.push(`👥 ${s.players.slice(0, 4).join('、')}${more}`)
    }
    if (sess.events?.length) lines.push(`📨 有 ${sess.events.length} 条事件没看（mc_events）`)
    if (w) {
      const fired = Number(w.stats?.fired ?? 0)
      lines.push(`🐕 看门狗${w.armed ? '守着' : '没守'}`
        + `${fired ? `（已唤醒 ${fired} 次${w.lastWakeKind ? `，最近 ${w.lastWakeKind}` : ''}）` : ''}`
        + `${w.pending ? `，攒着 ${w.pending} 条待唤醒` : ''}`)
    }
    const chat = sess.bot.recentChat(3)
    if (chat.length) {
      lines.push(`💬 ${chat.map((c) => `${c.kind === 'self' ? '我' : (c.who ?? '系统')}: ${String(c.text ?? '').slice(0, 70)}`).join(' ｜ ')}`)
    }
    return lines.join('\n')
  }

  /* audit 2026-10-22（用户：全量审计 + 减少 token 消耗）：坐标参数一律走 numOf/coordOf/boxOf。
   *   以前直接写 Number(args.x) —— 传 "12abc" / {} / null 只会得到 NaN，一路灌进 GoalNear(NaN)，
   *   最后回报一句 NoPath。AI 看到的是谜语，而不是「你 x 写错了」。现在缺参 / 非数字 / Infinity
   *   全都当场抛中文错，省掉一整轮试错。 */
  /* 2026-10-23 审计（移动层报告第 9 条）：`intent` 写错一个词原来会**静默回落 near**
   * （movement.mjs 的 intentOf 注释里明说"不报错"），于是 `intent:"stand"` 写成
   * `"stan"` / `"stand on block"` 时 AI 以为是"站那一格上"，实际按 1.6 格判"到了"。
   * 入口这里直接报错，列出四个合法值 —— 与「非法输入要明确报错」的原则一致。 */
  const INTENT_VALUES = new Set(['near', 'stand', 'interact', 'same-level'])
  function intentArgOf (v) {
    if (v == null) return undefined
    const t = String(v).trim()
    if (INTENT_VALUES.has(t)) return t
    throw new Error('参数 intent 只能是 near / stand / interact / same-level（现在是 "' + t + '"）')
  }

  function numOf (v, label) {
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error('参数 ' + label + ' 必须是数字，收到的是 ' + JSON.stringify(v ?? null))
    return n
  }
  function coordOf (args) {
    return { x: numOf(args?.x, 'x'), y: numOf(args?.y, 'y'), z: numOf(args?.z, 'z') }
  }
  function boxOf (args) {
    return {
      x1: numOf(args?.x1, 'x1'), y1: numOf(args?.y1, 'y1'), z1: numOf(args?.z1, 'z1'),
      x2: numOf(args?.x2, 'x2'), y2: numOf(args?.y2, 'y2'), z2: numOf(args?.z2, 'z2'),
    }
  }
  ctx.tools.register(asTool({
    name: 'mc_status',
    description: '看我在 Minecraft 里的状态：在线 / 坐标 / 朝向 / 血量 / 饱食度 / 手持物 / 模式（active 或 standby）/ 看门狗是否在守 / 最近 3 条聊天。\n'
      + '要完整明细（连接信息、看门狗全部开关、最近 5 条聊天原文）传 `verbose:true`。',
    parameters: {
      verbose: { type: 'boolean', description: 'true = 回完整明细（默认 false，只回一眼能看懂的摘要）' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const s = sess.bot.status()
      const w = sess.watchdog?.status() ?? null
      if (args.verbose === true) {
        /* 🔴 2026-10-20 审计（用户："减少 token 消耗"）：这里以前直接回裸对象 ⇒ 宿主
         *    pretty-print JSON，18 个字段 + modeView + chat 能展开成上百行。
         *    同样的信息现在压成几行文本（结构化字段照旧保留，老调用方不受影响）。 */
        const mv = sess.modeView()
        const chat = sess.bot.recentChat(5)
        const lines = [statusLean(sess, s, w)]
        const flat = []
        for (const [k, v] of Object.entries(mv ?? {})) {
          if (v == null) continue
          flat.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        }
        if (flat.length) lines.push(`⚙ ${flat.join(' ｜ ')}`)
        if (chat.length) {
          lines.push('💬 最近聊天：')
          for (const c of chat) {
            lines.push(`  ${c.kind === 'self' ? '我' : (c.who ?? '系统')}: ${String(c.text ?? '').slice(0, 120)}`)
          }
        }
        return { ...s, ...mv, recentChat: chat, text: lines.join('\n') }
      }
      return { text: statusLean(sess, s, w) }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_lan',
    description: '探测**局域网里的 Minecraft 服务器**（只读：不连接）。只听原版"对局域网开放"的多播公告（`224.0.2.60:4445`），拿到地址+端口+MOTD。\n'
      + '🔴 不扫端口、不发探测包，所以**恒定在 `seconds` 秒内返回**（默认 3，上限 15）；拿到 host/port 后用 `mc_connect` 进服。\n'
      + '没听到时：确认对方真开了"对局域网开放"（或 `enable-lan-visibility`）；部分 WiFi / VPN / 容器会挡多播，那种直接问对方地址。',
    /* 🔴 审计：原来 parameters 里还声明了 mode（探测模式，目前只有 broadcast），但 execute 里
     * 是**写死** broadcast、从不读 args.mode —— 声明一个读了也没用的旋钮，模型会以为能切模式。
     * 删掉（真要加模式时再连实现一起加）。 */
    parameters: {
      seconds: { type: 'number', description: '听多久（默认 3 秒，上限 15）' },
    },
    output: text(),
    async execute(args, exec) {
      // 只有广播这一条路：不扫端口、不连服。恒定在 seconds 秒内返回。
      const seconds = Math.max(1, Math.min(Number(args.seconds) || 3, 15))
      const r = await listenLanBroadcast({ seconds })
      const broadcast = Array.isArray(r?.found) ? r.found : (Array.isArray(r) ? r : [])
      const warnings = Array.isArray(r?.warnings) ? r.warnings : []
      return {
        /* 🔴 审计报告 F6：以前恒定 `ok:true` —— 多播被拦也回"没听到"。
         *    现在有 warning 就带上（`ok` 仍是"这次探测跑完了"，细节看 warnings）。 */
        ok: true,
        mode: 'broadcast',
        seconds,
        count: broadcast.length,
        found: broadcast.slice(0, 20),
        ...(warnings.length ? { warnings } : {}),
        ...(broadcast.length ? {} : { hint: '没听到公告。确认对方已经"对局域网开放"（或服务端开了 enable-lan-visibility）；有些网络（部分 WiFi / VPN / 容器）会挡多播，那种情况原版客户端自己也看不到——直接问对方地址即可。' }),
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_ping',
    description: '【单地址探测】**已知地址**时先问一句"你是谁、通不通"——发一次 Minecraft STATUS ping，拿 **通不通** / **版本** / **协议号** / **MOTD** / **人数** / **延迟**。\n'
      + '🔴 **不登录、不用账户、不进服**，拿到就断；超时自己兜，**不会挂住**。连不上时把原因说成人话（ECONNREFUSED=端口没人听 / ENOTFOUND=域名拼错 / 超时=防火墙或 enable-status=false）。\n'
      + '分工：先用 `mc_ping` 确认地址与版本（推荐）再 `mc_connect` 进服；不知道地址时用 `mc_lan` 听局域网公告。',
    parameters: {
      address:   { type: 'string', description: '地址，认 `example.com` / `example.com:25566` / `[::1]:25565`（必填）' },
      port:      { type: 'number', description: '端口（默认 25565）；address 里已经带 `:端口` 时以 address 为准' },
      timeoutMs: { type: 'number', description: '超时（默认 5000，钳到 1000–10000；返回里的 timeoutMs 是生效值）' },
      subserver: { type: 'string', description: '（可选）Velocity 之类的子服域名：握手里的 serverHost 用它路由到子服，如 mc.example.com' },
    },
    output: text(),
    async execute(args) {
      const { host, port } = parseAddress(args.address, Number(args.port) || 25565)
      /* 🔴 审计报告 F7：只有上限、没有下限，且 0/负数被 `|| 5000` 吞掉。
       *    现在下限 1000ms（和 statusPing 内部一致），返回里的 timeoutMs 是**真正生效**的值。 */
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 5000, 1_000), 10_000)
      const r = await statusPing({ host, port, timeoutMs, fakeHost: args.subserver ? String(args.subserver) : '' })
      /* 🔴 2026-10-23 审计：以前整包透传（host/port/timeoutMs/elapsedMs/handshakeMs/statusMs/motdRaw…），
       *    没一句结论，而且与 mc_lan（文本风格）两套。这里补一句人话，字段原样保留。 */
      const where = `${r.host}:${r.port}`
      const text = r.ok
        ? `📡 ${where} 通（${r.elapsedMs}ms，延迟 ${r.latencyMs ?? '?'}ms）｜ 版本 ${r.version ?? '?'}（协议 ${r.protocol ?? '?'}）`
          + `｜ 在线 ${r.players?.online ?? '?'}/${r.players?.max ?? '?'}`
          + (r.motd ? `\nMOTD：${r.motd}` : '')
        : `📡 ${where} 不通（${r.elapsedMs ?? '?'}ms）：${r.error ?? '未知原因'}`
          + (r.hint ? `\n${r.hint}` : '')
      /* 🔴 2026-10-25 回归：瘦身时误把 `ok`/`code` 也删了 —— 那是**错误语义**（宿主/调度靠它判失败），
       *    不是给人看的冗余字段。selfcheck 那条「工具路径也不抛异常、原样回 ok:false」当场抓到。
       *    现在只留 ok + code + text，其余（host/port/timeoutMs/elapsedMs/motdRaw…）不重复。 */
      return { ok: r.ok === true, ...(r.ok === true ? {} : { code: r.code ?? 'PING_FAILED' }), text }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_connect',
    description: '连接到 MC 服务器。**这里没有账号密码**——用哪个账户由「MC设置」里维护的账户决定：\n'
      + '先用 `mc_accounts` 看有哪些账户（用 `action:"use"` 选定，或用本工具的 `account` 参数指名 innerID）。\n'
      /* 🔴 审计：原来写"不传就用插件配置里的 fallback" —— 那是 0.1 时代的遗留说法，
       * 那些字段 2026-10-02 已清除（见文件顶部注释），本工具只把 args 透传下去。
       * 真正的兜底是环境变量 MC_HOST。 */
      + '服务器地址/端口/子服由你传（`host` 不传就看环境变量 `MC_HOST`，两个都没有会直接报错）；连接成功后会等区块加载完成。\n'
      + '登录失败时会明确说"需要用户处理"——那就告诉用户去「MC设置」里重新登录或点「刷新」。',
    parameters: {
      host:      { type: 'string', description: '服务器地址（如 example.com）' },
      port:      { type: 'number', description: '端口（默认 25565）' },
      subserver: { type: 'string', description: '子服域名（Velocity fakeHost 路由，如 mc.example.com）' },
      account:   { type: 'string', description: '（可选）用哪个账户：innerID（mc_accounts 里能看到）；不传就用本会话选定的/默认账户' },
      version:   { type: 'string', description: 'MC 版本（如 1.20.4 / 1.21.4）。**默认不传 = 自动探测**（发 STATUS ping 按服务端上报的协议号反查），这是推荐用法；只有探测失败时才手填。' },
      force:     { type: 'boolean', description: '已经连着也要**先断开再连**（否则是空操作）。⚠️ 真退出再进服：服务器会广播「你离开了游戏」。**别拿它当刷新区块的手段**（先走远 32 格回来让区块重发）；非做不可先 mc_say 说一声。' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const innerID = args.account ? String(args.account) : (sess.selectedAccount ?? null)
      const resolved = await resolveAuth(innerID)
      sess.selectedAccount = resolved.innerID

      const opts = { auth: resolved.auth }
      if (args.host)      opts.host      = String(args.host)
      if (args.port)      opts.port      = Number(args.port)
      if (args.subserver) opts.subserver = String(args.subserver)
      if (args.version)   opts.version   = String(args.version)
      if (args.force)     opts.force     = true
      // 登录成功后把（皮肤站的）档案信息与新令牌回写；回调只活在插件层，不进工具返回值
      // ⚠️ 回写是"顺带"的事：失败只能记日志，**绝不能**变成未处理拒绝（那会 exit(1)）
      opts.onAuth = ({ profile, session }) => {
        Promise.resolve()
          .then(() => persistAuth(resolved, profile, session))
          .catch((e) => logLine(`登录后回写账户信息失败（不影响本次进服）：${e?.message ?? e}`))
      }

      try {
        await sess.bot.connect(opts)
      } catch (e) {
        throw withUserHint(e, resolved.label)
      }
      sess.mode = 'active'
      // 世界名从 MOTD 认（必须赶在 attachChatLog / 记忆根计算**之前**，否则这次进服还按旧世界落）
      await learnWorldFromMotd(sess)
      // 记忆里的聊天记录（用户 2026-10-20）：进服就把钩子挂上，之后每条公屏都进 chat-log.md
      const chatLogRoot = attachChatLog(sess, exec?.agent)
      const ready = await sess.bot.waitForChunks()
      // 进服自动挂看门狗（用户要求：进游戏自动打开）
      const wd = ensureWatchdog(ctx, sess, exec?.agent, promptAbort.signal, watchdogGate(sess))
      // 把自己的游戏名学进叫法（默认叫法里**没有**私人名字 —— 见 learnName 的注释）
      try { wd.learnName(sess.bot?.bot?.username) } catch { /* 拿不到就算了 */ }
      if (wd.config.autoArm && !wd.armed) {
        try { wd.arm() } catch (e) { ctx.logger?.warn?.(`[dsh-mc-agent] 看门狗自动挂载失败：${e.message}`) }
      }
      /* 🔴 2026-10-23 审计：以前回**整份** accounts.view()（innerID/id/login/name/uuid/uuidSource/type/
       *    server/hasCredential）—— 刚连上只需要知道"用哪个号进来的"，完整信息 mc_accounts 随时可看。
       *    而且整包没有一句结论：连上之后站哪、什么模式、看门狗挂没挂，全靠模型自己从字段里拼。 */
      const accView = accounts.view(accounts.get(resolved.innerID))
      const st = sess.bot.status()
      const armed = wd.status().armed
      return {
        connected: true,
        account: accView ? { innerID: accView.innerID, name: accView.name, type: accView.type } : null,
        position: st.position, gamemode: st.gamemode, dimension: st.dimension,
        chunksReady: ready,
        // 连接信息（host/port/子服）已在 status() 里；这里**不再**回带
        // `_connectionProfile`（那份含 authMode 与账号名，没必要发出去）。
        watchdog: armed ? '已自动挂载' : '未挂载（autoArm 关闭）',
        text: `✅ 已进服：${st.connection?.host ?? '?'}:${st.connection?.port ?? '?'}`
          + (st.sub ? `（子服 ${st.sub}）` : '')
          + `\n我：${st.position?.x ?? '?'}, ${st.position?.y ?? '?'}, ${st.position?.z ?? '?'}`
          + `｜ ${st.gamemode ?? '?'} ｜ ${st.dimension ?? '?'}`
          + `\n看门狗：${armed ? '已自动挂载（有人喊我会叫醒我）' : '未挂载'}`
          + '\n先 mc_observe 看一眼周围再动手。',
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_accounts',
    description: '【账户】列出 / 搜索 / 刷新 / 选定 MC 账户。**永远拿不到密码或 token**——只有基本信息。\n'
      + 'action：\n'
      + '· list（默认）列出所有账户：innerID / ID / 游戏名 / UUID / 类型（离线或皮肤站）/ 服务器名与地址 / 是否已存凭据\n'
      + '· search  按指令搜（名字、UUID、服务器名、登录账号都行）：给 query\n'
      + '· use     选定本会话要用的账户：给 innerID（之后 mc_connect 就用它）\n'
      + '· refresh 刷新某个账户的登录状态（皮肤站会去认证服换新令牌）：innerID 不传就用当前选定/默认的\n'
      + '⚠️ 刷新或登录失败时会带 needUserAction——**这时候要明确告诉用户**：请到「MC设置」里重新登录该账户，'
      + '或点它的「刷新」按钮（密码只有用户能填，你拿不到）。',
    parameters: {
      action:  { type: 'string', description: 'list（默认）/ search / use / refresh' },
      innerID: { type: 'string', description: '账户内部 id（list 里能看到，形如 acc-xxxxxxxx）' },
      query:   { type: 'string', description: 'search 的关键词' },
    },
    output: text(),
    async execute(args, exec) {
      const action = String(args.action ?? 'list').toLowerCase()
      const sess = getSession(exec)

      if (action === 'list') {
        return {
          accounts: accounts.list(),
          authServers: accounts.listAuthServers(),
          credentialsReady: accounts.credentialsReady,
          selected: sess.selectedAccount ?? accounts.resolve()?.innerID ?? null,
        }
      }
      if (action === 'search') return accounts.search(args.query)

      if (action === 'use') {
        const id = String(args.innerID ?? '').trim()
        if (!id) throw new Error('use 要给 innerID（先 action:"list" 看看有哪些账户）')
        const acc = accounts.get(id)
        if (!acc) throw new Error(`没有这个账户：${id}`)
        sess.selectedAccount = id
        return {
          selected: accounts.view(acc),
          note: '本会话之后 mc_connect 就用这个账户（要进服请再调 mc_connect）',
        }
      }

      if (action === 'refresh') {
        const innerID = args.innerID ? String(args.innerID) : (sess.selectedAccount ?? accounts.resolve()?.innerID ?? null)
        const resolved = await resolveAuth(innerID)
        if (resolved.auth.mode === 'offline') {
          return {
            refreshed: resolved.innerID, type: 'offline',
            account: accounts.view(accounts.get(resolved.innerID)),
            note: '离线账户不需要认证；UUID 按名字派生（想固定就在「MC设置」里给它设自定义 UUID）',
          }
        }
        let captured = null
        let out
        try {
          out = await sess.bot.authOnly(resolved.auth, { onSession: (s) => { captured = s } })
        } catch (e) {
          throw withUserHint(e, resolved.label)
        }
        if (captured) await persistAuth(resolved, captured.selectedProfile, captured)
        return {
          refreshed: resolved.innerID, type: 'yggdrasil', auth: out,
          account: accounts.view(accounts.get(resolved.innerID)),
        }
      }

      throw new Error(`未知 action："${action}"（可用 list/search/use/refresh）`)
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_stop',
    description: '停止本会话的 Minecraft：**先尝试优雅退出游戏，再清空本会话全部后台任务（看门狗在里面）**。\n'
      + '⚠️ 它**不会中断你自己当前这一轮**（你正跑在这轮里，自我 abort 会表现为 "tool call aborted"）。'
      + '所以它适合"我不想玩了，下线"——想停掉自己正在跑的动作，直接别再调工具就行。\n'
      + '页面上标题旁只剩一个「强制停止」按钮，它比这个工具更狠：**先停 LLM → 再优雅退游戏 → '
      + '再清后台任务 → 最后再停一次 LLM**（那是给人按的）。',
    parameters: {
      reason: { type: 'string', description: '原因（写进日志）' },
    },
    output: text(),
    async execute(args, exec) {
      const sessionId = exec?.agent?.id
      if (!sessionId) throw new Error('拿不到当前会话')
      // cancelTurn:false —— 工具就跑在被停的这一轮里，绝不能让 stop 把这一轮 abort 掉
      return stopSession(sessionId, {
        reason: args.reason ? String(args.reason) : 'AI 主动下线',
        cancelTurn: false,
      })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_disconnect',
    description: '从 MC 下线（当前会话的机器人退出游戏）。不影响其他会话的机器人。看门狗会自动关闭并提醒你。',
    parameters: { reason: { type: 'string' } },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const why = args.reason ? String(args.reason) : 'agent 主动下线'
      // 退服自动关看门狗 + 提醒（用户要求：退出游戏会提醒 AI）
      let watchOff = null
      let watchErr = null
      /* 🔴 审计报告 F10：以前 `catch {}` 把 disarm 失败吞掉，返回里就只剩 `watchOff=null`
       *    ⇒ 文案说成"本来就没挂"（假的）。现在三态分清：关掉了 / 本来就没挂 / 关不掉（带原因）。 */
      if (sess.watchdog) {
        try { watchOff = sess.watchdog.disarm(`下线：${why}`, { notify: true }) } catch (e) { watchErr = e?.message ?? String(e) }
      }
      const quit = await sess.bot.disconnect(why)      // 优雅优先，走不掉才强断
      /* 🔴 审计：这里原来**无条件** `sess.mode = 'standby'`。可是 `disconnect()` 是"优雅优先、
       * 走不掉才强断"，强断也失败时机器人**还在游戏里** —— 那时把 mode 写成 standby，
       * 就是让 `modeView()` 里 `mode:"standby"` 与 `online:true` 自相矛盾（AI 会以为已经下线）。
       * 只在真的下线了才切 standby；还在线就如实留着原模式。 */
      const stillOnline = Boolean(sess.bot.online)
      if (!stillOnline) sess.mode = 'standby'
      return {
        online: stillOnline, quit,
        watchdog: watchErr ? `关不掉（${watchErr}）` : watchOff ? '已关闭并已提醒' : '本来就没挂',
      }
    },
  }))

  /* ── 说话与事件 ── */

  ctx.tools.register(asTool({
    name: 'mc_say',
    description: '在 MC 公屏说话（游戏里所有玩家能看到）。',
    parameters: { message: { type: 'string', required: true, description: '要说的话（单行，会被截断到 220 字）' } },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const asked = String(args.message ?? '')
      const sent = sess.bot.chatSay(asked)
      /* 🔴 2026-10-23 审计：以前只回 { sent: '原话' } —— 没说明发没发出去、也没提醒被压成单行/截断。 */
      const squashed = sent !== asked.trim()
      return {
        sent,
        text: `💬 公屏已发出：「${sent}」`
          + (squashed ? `\n（原话 ${asked.length} 字，发出前压成单行并截到 220 字 —— 太长就分几次说）` : ''),
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_watch',
    description: '看门狗控制（**唯一**的事件通知通道）。看门狗在**进服时自动挂载、退服时自动卸载**，'
      + '整局游戏期间持续运行：记录所有事件，命中唤醒条件就在**同一个对话里**提醒你——'
      + '你空闲时开新一轮；你正在跑时在下一步插话（不打断）。'
      + 'action="status"（默认）看状态与配置；"arm" 手动挂载；"disarm" 关闭；"log" 看最近事件留档。'
      + '默认叫醒：有人喊我 / 身边有人说话 / **任何玩家说话**（wakeOn.anyChat，默认开）/ 受击 / 死亡 / 被传送 / 断线。'
      + '唤醒条件/近距半径/心跳/观察窗口等一律用 mc_config 调（有默认值）。',
    parameters: {
      action: { type: 'string', description: 'status（默认）/ arm / disarm / log' },
      reason: { type: 'string', description: 'disarm 时的原因（会写进日志）' },
      limit: { type: 'number', description: 'log：回最近几条（默认 12，最多 30；每条超过 200 字会截断）' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const agent = exec?.agent
      if (!agent) throw new Error('拿不到当前会话（exec.agent 不可用），看门狗必须绑定会话')
      const wd = ensureWatchdog(ctx, sess, agent, promptAbort.signal, watchdogGate(sess))
      const action = String(args.action ?? 'status')
      if (action === 'arm') return { ...wd.arm(), note: '看门狗已挂载，整局游戏期间有效（退服自动卸载并提醒你）。' }
      if (action === 'disarm') return wd.disarm(args.reason ? String(args.reason) : 'AI 主动关闭')
      if (action === 'log') {
        /* 返回瘦身（用户 2026-10-23）：原来固定回最近 30 条**全文**，聊天多的服一次就几千字符。
         * 现在默认 12 条、每条最多 200 字（超了打点省略），要更多给 limit。 */
        const cap = Math.max(1, Math.min(30, Number(args?.limit) || 12))
        const recent = wd.log.slice(-cap).map((e) => {
          const text = String(e?.text ?? '')
          return text.length > 200 ? { ...e, text: text.slice(0, 200) + '…' } : e
        })
        return {
          armed: wd.armed,
          stats: { ...wd.stats },
          total: wd.log.length,
          recent,
          ...(wd.log.length > cap ? { hint: `一共 ${wd.log.length} 条，这里只给最近 ${cap} 条；要看更多把 limit 调大（最多 30）` } : {}),
        }
      }
      return wd.status()
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_config',
    description: '读写本会话的 MC 配置（看门狗唤醒条件、近距半径、心跳间隔、观察窗口、叫法等）。'
      + '不传参数 = 看当前配置 + 默认值。改配置传 patch；嵌套项用点号键，'
      + '如 {"wakeOn.itemPickup":true,"nearRadius":24,"mentionPatterns":["ds","用户"]}。'
      + '嫌"任何玩家说话都叫醒"太吵就把 "wakeOn.anyChat" 设成 false。'
      + '叫法是**配置不是硬编码**——学到玩家的新称呼就加进 mentionPatterns。',
    parameters: {
      patch: { type: 'object', additionalProperties: true, description: '要改的配置项（浅合并）；不传=只读' },
      reset: { type: 'boolean', description: 'true=恢复默认配置' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const clone = (v) => JSON.parse(JSON.stringify(v))
      /* 🔴 审计报告 F11：以前**纯只读**也调 `ensureWatchdog` ⇒ 看门狗还没挂时，读一次配置
       *    就凭空把它挂上了（连带唤醒注入）。只读就走默认值，别产生副作用。 */
      const wantsChange = Boolean(args.reset) || Object.keys(args.patch ?? {}).length > 0
      if (!sess.watchdog && !wantsChange) {
        return {
          config: clone(WATCH_DEFAULTS),
          note: '看门狗还没挂（进服后会自动挂上）—— 上面就是默认配置；改配置会真的挂上看门狗',
        }
      }
      const wd = ensureWatchdog(ctx, sess, exec?.agent, promptAbort.signal, watchdogGate(sess))
      if (args.reset) {
        wd.config = clone(WATCH_DEFAULTS)
        // 🔴 F11：reset 以前少回 `defaults`（和 set 分支结构不一致，模型无从对照）
        return { reset: true, ...configPair(wd.config) }
      }
      // 把 "wakeOn.itemPickup": true 这种点号键拆成嵌套补丁
      const patch = {}
      for (const [k, v] of Object.entries(args.patch ?? {})) {
        const dot = k.indexOf('.')
        if (dot > 0) {
          const head = k.slice(0, dot)
          patch[head] = { ...(patch[head] ?? {}), [k.slice(dot + 1)]: v }
        } else patch[k] = v
      }
      if (Object.keys(patch).length) wd.updateConfig(patch)
      return { ...configPair(wd.config) }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_capabilities',
    description: '【边界信息】这个插件能做什么、边界在哪：**支持的 MC 版本范围**（testedVersions）、底层 mineflayer 版本、'
      + '支持的登录方式、工具命名空间、各种上限（序列步数/记忆大小/事件队列）以及当前配置要点。\n'
      + '**进服前不确定版本能不能连时先看它**；确实不支持就如实跟他说一声，别硬试。',
    parameters: {
      detail: { type: 'boolean', description: 'true = 连工具名清单、准则注入路径等细节一起给（默认精简）' },
    },
    output: text(),
    async execute(args, exec) {
      const detail = args.detail === true
      const lib = libraryInfo()
      return {
        plugin: { name: 'dsh-mc-agent', version: PLUGIN_VERSION, dir: redactPath(fileURLToPath(new URL('.', import.meta.url))) },
        game: {
          testedVersions: lib.testedVersions,
          oldest: lib.oldest,
          latest: lib.latest,
          mineflayer: lib.mineflayer,
          dataVersions: lib.dataVersions,
          note: 'testedVersions = "实测可用"清单（也是上界拒绝的依据）。不在这份清单里的版本**可能**仍能连'
            + '（协议数据更全），但属于未验证；连不上就如实反馈，别反复硬试。',
        },
        auth: {
          modes: ['offline（离线账户）', 'yggdrasil（皮肤站/外置登录）', 'microsoft（微软正版，设备码登录）'],
          notSupported: msaSupported() ? [] : ['microsoft（微软正版）—— 这台机器上没找到 prismarine-auth，装不上就用不了'],
          note: '凭据只存本机 DSH 凭据库（正版登录的令牌缓存按账户放在 <stateDir>/msa/<账户>/）；'
            + 'AI 只能看到账户基本信息（innerID/ID/名字/UUID/服务器），看不到密码或 token。'
            + '正版账户要先在「MC设置 → 账户」里点「登录」走一次设备码（在浏览器里输码），AI 替不了这一步。',
        },
        tools: {
          namespaces: {
            mc_: '游戏内',
            mc_kit_: '游戏外辅助（记忆/画图/交付）',
            mc_admin_: '管理（MC 模式看不见也调不动；普通模式与 MC+ 模式可见）',
            note: 'mc_* / mc_kit_* 只在 MC模式 / MC+模式 会话里暴露（其他模式隐藏 + guard 硬拒）。',
          },
          count: ourToolNames.length,
          ...(detail ? { names: [...ourToolNames] } : { note: '要完整工具名清单加 detail:true' }),
        },
        limits: {
          perCallMs: CALL_MS,          // 🔴 单次工具调用的硬上限（用户要求 ≤11 秒，长动作分几次）
          sequence: { steps: 64, budgetMs: callBudget(undefined) },
          memory: { textBytes: 256 * 1024, blobBytes: 16 * 1024 * 1024, files: 2000, depth: 5 },
          eventsQueued: 200,
          timeoutsMs: { lookAt: 4000, equip: 6000, dig: 25000, place: 6000, flyTo: 30000 },
        },
        config: {
          // 🔴 F12：一律脱敏成 `$DSH_HOME/...`，别把主机用户名写进工具返回
          file: redactPath(pluginConfig.file),
          keys: Object.keys(DEFAULT_CONFIG),
          commandWhitelist: pluginConfig.get('commandWhitelist'),
          allowAllCommands: pluginConfig.get('allowAllCommands'),
          memoryDir: redactPath(memoryFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent)).root),
          workspaceConfigFile: redactPath(wsConfigPath(memoryRootFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent)))),
          mcModePresets: pluginConfig.mcModePresets,
          mcPlusPresets: pluginConfig.mcPlusPresets,
        },
        ...(detail ? {
          prompt: {
            agentsMd: redactPath(agentsMdPath(memoryFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent)).root)),
            injectDshMcAgentAgentsMd: wsCfgValues(workspaceOf(exec?.agent)).injectDshMcAgentAgentsMd,
            injectWorkspaceAgentsMd: wsCfgValues(workspaceOf(exec?.agent)).injectWorkspaceAgentsMd,
          },
        } : {}),
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_sessions',
    description: '列出当前所有活跃的 MC 会话实例（诊断用：确认各会话的 bot 状态、连接信息）。',
    parameters: {},
    output: text(),
    async execute() {
      return {
        note: '每会话独立实例；事件只经 mc_watch 回各自会话。',
        sessions: registry.listSessions(),
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_events',
    description: '读取/消费当前会话的 MC 事件队列（**看门狗记下来的**：聊天、系统消息、受伤、上线/死亡/重连/断线）。'
      + '默认消费掉；`peek=true` 只看不清（**都是最早的先出**）。返回一行一条（时间 + 类型 + 内容），省 token。\n'
      + '⚠️ **被传送 / 捡物 / 其他玩家上下线不在这里**（那些只在看门狗的留档里，用 `mc_watch {action:"log"}` 看）。\n'
      + '⚠️ `waitSec` 是**兜底**，别用它长时间空等：有人叫你（mention）/ 受击 / 死亡 / 断线时，'
      + '**看门狗会主动叫醒你**，而且**会打断这个等待**（返回里 `interrupted:true` 就是在告诉你"有人找你了，'
      + '唤醒内容马上会作为提示注入进来"）。真需要盯着某一类事件时才给 waitSec（**上限 5 秒**）。',
    parameters: {
      limit: { type: 'number', description: '最多取几条（默认 20）' },
      kind: { type: 'string', description: '只看某类：chat / system / damage / lifecycle' },
      peek: { type: 'boolean', description: 'true=只看不消费' },
      waitSec: { type: 'number', description: '先等最多几秒（默认 0=不等，上限 5；想继续等就再叫一次）。⚠️ 会被看门狗唤醒打断，别长等' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100)
      const kind = args.kind ? String(args.kind) : null

      // 可选阻塞等待（吸收原 mc_wait）。⚠️ 等待逻辑在 src/wait.mjs：**看门狗唤醒会打断它**
      //    —— 否则 steer 注入要等这个工具跑完（2026-09-19 真机：用户空等特别久）。
      const waitSec = Math.min(Math.max(Number(args.waitSec ?? 0), 0), 5)   // 上限 5 秒（用户 2026-10-19：等太久了）
      let waitedMs = 0
      let interrupted = false
      let interruptReason = null
      if (waitSec > 0) {
        const r = await waitForEvents({
          sess, fromSeq: sess.eventSeq, kind, waitSec, signal: exec?.signal ?? null,
        })
        waitedMs = r.waitedMs
        interrupted = r.interrupted
        interruptReason = r.reason
      }

      const list = args.peek
        ? sess.peekEvents(limit, kind)
        : sess.drainEvents(limit, kind)
      /* 🔴 省 token（2026-10-07）：原来直接 `return { waitedMs, count, events: list }`，
       *    宿主没拿到 `text` ⇒ 把整个对象 pretty-print 成 JSON（每条事件 5 行、约 180 字符，
       *    实测 10 次 mc_events 花掉 6,069 字符）。现在压成"一行一条"：
       *      · [22:35:03] 聊天 **Bluezi**：你怎么不动了
       *    事件对象本身只有 `{ at, kind, text, who? }`（见 `#pushEvent`）。 */
      const clock = (at) => {
        const d = new Date(Number(at) || Date.now())
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
      }
      const TAG = { chat: '聊天', system: '系统', damage: '受伤', lifecycle: '状态' }
      const one = (e) => {
        const t = String(e?.text ?? '').replace(/\s+/g, ' ').slice(0, 180)
        const tag = TAG[e?.kind] ?? e?.kind ?? '事件'
        return `· [${clock(e?.at)}] ${tag}${e?.who ? ` **${e.who}**` : ''}：${t}`
      }
      const lines = [
        list.length
          ? `📨 事件 ${list.length} 条（${args.peek ? '只看没消费' : '已消费'}${kind ? `，只看 ${kind}` : ''}${waitedMs ? `，等了 ${waitedMs}ms` : ''}）`
          : `📨 没有${kind ? ` ${kind} ` : ''}事件${waitedMs ? `（等了 ${waitedMs}ms）` : ''}`,
        ...list.map(one),
      ]
      if (interrupted) {
        lines.push('⏸️ 等待被打断：看门狗命中唤醒条件（有人叫你 / 受击 / 死亡 / 断线…），'
          + '唤醒内容马上会作为提示注入——**先别急着再 wait**，等那条提示进来（或直接看上面的事件）。')
      }
      return { text: lines.join('\n') }
    },
  }))

  /* ── 世界读取 ── */

  ctx.tools.register(asTool({
    name: 'mc_scan',
    description: '扫描我周围方块：给 name 就找这种方块的位置；不给就返回方块占比（分母不含空气）。'
      + '\n· 竖向窗口默认以脚底为中心 ±height；看高处传 `y` 指定中心。'
      /* 🔵 2026-10-26 用户：「现在流动的水 scan 出来也是水，区分一下」——
       *    1.13+ 水/岩浆只有 `water`/`lava` 一个名字，源头和流动靠 `level` 状态区分。
       *    现在统计和点名都拆开了：要流动水就传 `flowing_water`，别再传 `water` 然后嫌它少。 */
      + '\n· 占比里水/岩浆按状态分开：`water`（源头）/`flowing_water`（流动）/`lava`/`flowing_lava`。'
      + '`name` 传族名（`water`/`lava`）会连流动的一起找（每条用 `stat` 标出是哪一种）；'
      + '只想找流动的就传 `flowing_water`/`flowing_lava`。',
    parameters: {
      radius: { type: 'number', description: '水平半径（默认 16，上限 48）' },
      height: { type: 'number', description: '垂直范围 ±（默认 4，上限 16）' },
      y: { type: 'number', description: '可选：竖向窗口的中心高度（绝对 y；默认我脚底）' },
      name: { type: 'string', description: '可选：只找这种方块（如 oak_log）' },
      limit: { type: 'number', description: 'name 模式最多返回几个（默认 10）' },
      tail: { type: 'boolean', description: '占比看最少的 10 种（默认最多的 10 种）' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      await sess.bot.waitForChunks()
      const r = await sess.bot.scan({
        radius: args.radius, height: args.height,
        name: args.name ? String(args.name) : null,
        limit: args.limit,
        y: args.y,
      })
      /* 🔴 2026-10-18 审计（token）：不点名时以前把整个 `{center,radius,height,counts}` 用
       *    `JSON.stringify(…, null, 2)` 打印（半径 40 时约 970 字），一半是缩进和键名。
       *    计数模式改**一行式**（有 `text` 就走它），结构化字段仍然留在返回值里给程序用。 */
      if (r && !args.name && Array.isArray(r.counts)) {
        /* 🔵 2026-10-22 用户："扫描周围的方块占比，例如草方块 10%、泥土 20%、石头 70%"。
         *    以前是 `name×count`，比例得自己除。现在直接带百分比（分母 = 非空气方块总数，
         *    由 world-scan.mjs 算好）。只列前 14 种，所以把"剩下那些种加起来多少"也折算成一句，
         *    免得把前 14 种当成全部。 */
        /* 🔵 2026-10-22 用户第二轮："去掉 1% 的限制，显示前 10 种，再加个输入，可以显示后 10 种"。
         *    ⇒ 不再按占比筛（小零碎也是信息），固定列 10 种；tail:true 翻过来看最少的 10 种。
         *    没显示的那一头折算成一句"其余 N 种共 X%"，免得把 10 种当成全部。 */
        const TOP_N = 10
        const fmtPct = (v) => (v == null ? '' : (v > 0 && v < 0.1 ? '<0.1%' : `${v}%`))
        const tail = Boolean(args.tail)
        const shown = tail ? r.counts.slice(-TOP_N).reverse() : r.counts.slice(0, TOP_N)
        const shownPct = shown.reduce((a, c) => a + (c.pct ?? 0), 0)
        const restPct = Math.round((100 - shownPct) * 10) / 10
        const restKinds = r.counts.length - shown.length
        const list = shown.map((c) => `${c.name}×${c.count} ${fmtPct(c.pct)}`).join('、')
        const more = restKinds > 0 ? ` 等 ${r.counts.length} 种` : ''
        const total = Number.isFinite(r.total) ? r.total : r.counts.reduce((a, c) => a + c.count, 0)
        const head = tail
          ? `🧱 周围 ${r.radius} 格（上下 ${r.height}）共 ${total} 个方块（最少的 ${shown.length} 种，从少到多）：`
          : `🧱 周围 ${r.radius} 格（上下 ${r.height}）共 ${total} 个方块：`
        return {
          total: r.total ?? null, unloaded: r.unloaded ?? 0,
          text: `${head}${list || '（空的）'}${more}`
            + `${restPct > 0.05 && restKinds > 0 ? `；其余 ${restKinds} 种共 ${fmtPct(restPct)}` : ''}`
            + `${r.unloaded ? `；另有 ${r.unloaded} 格未加载（不算空）` : ''}`
            + (tail ? '' : ' — 要看最少的 10 种就传 tail:true；要坐标就给 name 点名'),
        }
      }
      /* 🔴 2026-10-20 审计（用户："减少 token 消耗"）：`name` 模式原来回裸对象 ⇒ 宿主
       *    pretty-print JSON，每条 `pos` 占三行（`{ "x": …, "y": …, "z": … }`）。
       *    这里补一句一行式的 `text`；结构化字段（`blocks[].state` 等）照旧留在返回值里。 */
      if (r && args.name) {
        const found = Array.isArray(r.found) ? r.found : []
        const where = `周围 ${r.radius ?? args.radius ?? 16} 格（上下 ${r.height ?? args.height ?? 4}）`
        if (!found.length) {
          return {
            total: r.total ?? null, unloaded: r.unloaded ?? 0,
            text: `⛏ ${where}没找到 ${args.name}`
              + (r.unloaded ? `（但有 ${r.unloaded} 格未加载 —— **不算"没有"**，可以走近再看）` : ''),
          }
        }
        /* 🔴 2026-10-23 审计：以前写成 `5,64,-3 距 2.1` —— 坐标和距离挤在一起看不出哪部分是坐标。 */
        /* 🔵 2026-10-27 用户："还是没显示流动的水"：点名 `water` 现在把流动水也算进来，
         *    但文本只给坐标 ⇒ 看不出哪几个是流动的（`stat` 早就标在返回值里了，只是没渲染）。
         *    `world-scan.mjs` 只在"和点名的名字不一样"时才带 `stat`，所以有值就是被泛化匹配上的那个。 */
        const statTag = (s) => (!s ? '' : s === 'flowing_water' ? ' 流动水' : (s === 'flowing_lava' ? ' 流动岩浆' : ` ${s}`))
        const items = (r.blocks ?? []).map((blk) => `(${blk.pos})`
          + `${blk.distance != null ? ` 距 ${blk.distance}` : ''}`
          + statTag(blk.stat)
          + `${blk.ripe === true ? ' 熟' : (blk.ripe === false ? ' 没熟' : '')}`
          + `${blk.age != null && blk.maxAge != null ? ` ${blk.age}/${blk.maxAge}` : ''}`)
        const anyTagged = (r.blocks ?? []).some((b) => b.stat)
        return {
          total: r.total ?? null, unloaded: r.unloaded ?? 0,
          text: `⛏ ${args.name}：${r.total} 个`
            + `${found.length < r.total ? `（列最近 ${found.length} 个）` : ''}`
            + `${anyTagged ? `（没标名的是 ${args.name} 本身，标了名的是同类）` : ''}\n`
            + items.join('\n')
            + `${r.cropSummary ? `\n${r.cropSummary}` : ''}`
            + `${r.unloaded ? `\n（另有 ${r.unloaded} 格未加载，不算空）` : ''}`,
        }
      }
      return r
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_map',
    description: '看周围地形。**默认给"脚下方块那一层"**（地板层图：这一层哪里是实心地面、哪里是坑/岩浆/未加载）：'
      + '· 能站 # 墙 v 会掉下去 ~ 水 ≈ 岩浆 ? 未加载。'
      + 'mode="floor"（默认）/ "surface"（地表：@ 我 · . 沙 · " 草木 · T 木构 · : 石/建筑 · _ 土/农田）'
      + '/ "column"（竖列：往下几格实心、哪里开始是空的、头顶什么封着、跳不跳得起来）。'
      + '🔴 竖列可以查**任意一列**：给 `target:"x,z"` 就看那一列，并报出**那一列的地表 y**'
      + '（跑远路前先探一眼，比猜 y 靠谱）；读不到 = 区块没加载，别猜。'
      + 'format="image" 出**俯视图像**（有视觉的模型能直接看，并落盘）。'
      + '🔴 想让 用户 看到图：见 out 参数。'
      + '🔴 **看竖直剖面（洞顶/矿脉/有没有落石）用 `axis:"x"` 或 `"z"`**（固定一条 x 或 z，纵轴是 y）；`axis:"all"` 三张一起给。'
      + '字符图省 token 且坐标精确；形状/外观问题用图像。'
      + '（字符图**默认不压缩**，一行就是一格；确实要省 token 再加 compress:true。）',
    parameters: {
      radius: { type: 'number', description: '半径（默认 32，上限 96）' },
      mode: { type: 'string', description: 'floor（默认，脚下方块那一层）/ surface（地表图）/ column（竖列）；2026-10-22 起 cave 与 auto 已删除，传它们等于没传' },
      purpose: { type: 'string', description: 'overview（默认）/ navigation（加目标方位）/ hazards（先列危险格）' },
      target: { type: 'string', description: '（可选）目标坐标 "x,y,z"（mc_scan 给的）；竖列图用它定 x/z' },
      up: { type: 'number', description: '竖列图头顶看几格（默认 40）' },
      axis: { type: 'string', description: 'floor 的切片方向：y（默认，水平看某一层）/ x（固定 x 的竖直剖面）/ z（固定 z 的竖直剖面）/ all（三张一起）' },
      layer: { type: 'number', description: 'floor 的层（axis:"y" 时是 y，"x" 时是 x，"z" 时是 z；默认取我自己那一格）' },
      depth: { type: 'number', description: 'floor 层往下探几格找地面（默认 4，0–8）' },
      glyphStep: { type: 'number', description: '字符图抽稀步长（默认 2；1 最细）' },
      compress: { type: 'boolean', description: '整行同字符压成 X*n（默认 false：给纯字符图，能看出形状；只在确实要省 token 时开）' },
      yTop: { type: 'number', description: '地表搜索起始高度偏移（默认 +10，仅地表图用）' },
      yBottom: { type: 'number', description: '向下搜索深度（默认 -24；地表图与竖列图用）' },
      format: { type: 'string', description: 'chars（默认）/ image / both' },
      scale: { type: 'number', description: '图像每格放大倍数（默认 4，1–16）' },
      out: { type: 'string', description: `落盘路径（工作区相对；默认 .dsh-mc-agent/${OUT_DIR}/mc-map-<时间>.png 不对外）。`
        // 🔴 2026-10-19 实机踩到：发布区跟着 memoryDir 走，早就不在工作区下了 ——
        //    按"工作区/.dsh-mc-agent/.express/"写会渲染成功但 mc_kit_express 说"不在发布区"。
        + `想让 用户 看到就写到**记忆根**下的 ${EXPRESS_DIR}/<子目录>/x.png（不是工作区里的），再用 mc_kit_express 取那一行` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }]
        // 图像以附件形式内联；纯文本模型由宿主自动降级成文本占位
        if (value?.image?.attachment) blocks.push({ type: 'image', attachment: value.image.attachment })
        return blocks
      },
    },
    /* 🔴 2026-10-08 第五份审计报告 ⑨：以前 60 秒 —— 而 `heightmap`/`mapImage` 全是**同步**代码，
     *    会阻塞事件循环。现在 `heightmap` 自带 2.5 秒软上限（`truncated`），这里跟着收到 20 秒。 */
    timeoutMs: 20_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      await sess.bot.waitForChunks()
      const format = String(args.format ?? 'chars').toLowerCase()
      const step = Math.max(1, Number(args.glyphStep ?? 2))
      const modeArg = String(args.mode ?? '').toLowerCase()
      /* 🔴 2026-10-15（用户需求）：**默认给"脚下方块那一层"**（地板层视图）。
       *    2026-10-22（用户要求「把 cave 去掉」）：`auto` / `cave` 两个取值删了（洞穴层视图整块没了），
       *    现在只认 `floor` / `surface` / `column`；不传、或传了不认识的值（含 `auto`/`cave`）⇒ `floor`。 */
      const mode = modeArg === 'surface' || modeArg === 'column' ? modeArg : 'floor'
      /* 🔴 2026-10-15（用户需求）：**竖列图** —— 只看一格，从脚底那一格往下，回答"我往下挖会不会掉下去"。
       *    它跟俯视图是两件事（一个是"周围哪能走"，一个是"底下有没有空的"），所以拿到 x/z 就直接返回，
       *    不参与 radius / legend / 导航摘要那一套。`target` 用 `parseXZ` 定 x/z（`"12,-4"` 或 `"12,63,-4"`），
       *    不给就用机器人自己站的那一格；`yBottom`（默认 -24）就是往下看多深；`format` 忽略，恒出字符。 */
      if (mode === 'column') {
        const tgt = parseXZ(args.target)
        /* 🔴 2026-10-23（用户 m00855）：给了**别的列**的 x/z ⇒ 纵向窗口改以"那一列的地表"为基准，
         *    并顺手报出地表 y —— 这就是"跑远路该给哪个 y"的答案。读不到 = 区块没加载，那就别猜。 */
        const feetPos = sess.bot.requireBot()?.entity?.position
        const mineXZ = !tgt || (Math.floor(tgt.x) === Math.floor(feetPos?.x ?? 0) && Math.floor(tgt.z) === Math.floor(feetPos?.z ?? 0))
        let sf = null
        if (!mineXZ) {
          sf = surfaceYOf(sess.bot.requireBot(), { x: tgt.x, z: tgt.z })
          if (!sf.loaded) {
            return {
              mode: 'column', x: Math.floor(tgt.x), z: Math.floor(tgt.z), surfaceY: null, loaded: false,
              text: `🕳 竖列 (${Math.floor(tgt.x)}, ${Math.floor(tgt.z)})：那一列**还没加载**（区块没到）—— 读不到地表高度。`
                + '别猜 y：按 xz 走过去（`mc_move {x, z}`），到了那一带再看。',
            }
          }
        }
        const col = columnOf(sess.bot.requireBot(), {
          x: tgt?.x ?? null, z: tgt?.z ?? null, yBottom: args.yBottom, up: args.up,
          anchorY: sf ? sf.y + 1 : null,
        })
        const view = { ...col, mine: mineXZ, surfaceY: sf ? sf.y : null }
        return {
          mode: 'column', x: col.x, z: col.z, feetY: col.feetY, from: col.from, to: col.to,
          solidRun: col.solidRun, firstGap: col.firstGap, gaps: col.gaps, hazards: col.hazards,
          here: col.here,
          /* 头顶：跳不跳得起来 / 封着什么 / 上面是不是水或岩浆（2026-10-18 用户需求） */
          above: col.above,
          unloaded: col.unloaded, complete: col.complete, runs: col.runs, layers: col.layers,
          ...(mineXZ ? {} : { mine: false, surfaceY: sf.y, surfaceBlock: sf.name }),
          text: columnText(view),
        }
      }
      /* 🔴 2026-10-25 用户：「map floor 加 x z all 的功能，默认还是 y」——
       * floor 默认是**水平切片**（固定 y）。axis:"x"/"z" 改成**竖直剖面**（固定 x 或 z、纵轴 y），
       * axis:"all" 三张一起给。剖面只如实报「那一格是什么」，不判断能不能站（那是 floor 的语义）。 */
      const axisArg = String(args.axis ?? 'y').toLowerCase()
      if (mode === 'floor' && (axisArg === 'x' || axisArg === 'z' || axisArg === 'all')) {
        const bot = sess.bot.requireBot()
        const axes = axisArg === 'all' ? ['y', 'x', 'z'] : [axisArg]
        const parts = []
        const out = { mode: 'floor', axis: axisArg, format: 'chars', cellSize: step }
        for (const ax of axes) {
          if (ax === 'y') {
            const hm = floorMapOf(bot, { radius: args.radius, layer: args.layer, depth: args.depth })
            parts.push(`【y 平面：y=${hm.layer.y}（脚下方块那一层）】\n`
              + McBot.glyphMap(hm.names, step, { x: hm.radius, y: hm.radius }, { compress: args.compress === true }))
            out.y = { layer: hm.layer, radius: hm.radius }
          } else {
            const down = Math.max(1, Math.abs(Number(args.yBottom ?? -12)) || 12)
            const sm = sliceMapOf(bot, { axis: ax, layer: args.layer, radius: args.radius, up: args.up, down })
            parts.push(`【${ax} 剖面：${ax}=${sm.fixed}（纵轴 y ${sm.topY}→${sm.bottomY}，横轴 ${ax === 'x' ? 'z' : 'x'}）】\n`
              + sliceMapText(sm, { step, compress: args.compress === true }))
            out[ax] = { fixed: sm.fixed, topY: sm.topY, bottomY: sm.bottomY, radius: sm.radius }
          }
        }
        out.text = parts.join('\n\n') + '\n图例：# 实心 · 空气 ~ 水 ≈ 岩浆 ? 未加载 @ 我'
        return out
      }
      /* `floor` 走新函数（直接 import `src/map-render.mjs`，不经过 `core.mjs` 的薄包装 —— 那文件贴着 1000 行上限）；
       * `surface` 走 `sess.bot.heightmap()`（它现在只会出地表图，没有 mode/slab）。 */
      const hm = mode === 'floor'
        ? floorMapOf(sess.bot.requireBot(), { radius: args.radius, layer: args.layer, depth: args.depth })
        : sess.bot.heightmap({ radius: args.radius, yTop: args.yTop, yBottom: args.yBottom })
      const purposeArg = String(args.purpose ?? '').toLowerCase()
      const purpose = purposeArg === 'navigation' || purposeArg === 'hazards' ? purposeArg : 'overview'
      const nav = navSummaryOf(hm, { purpose, target: args.target })

      const out = {
        center: hm.center, radius: hm.radius, unloadedTiles: hm.unloaded, mode: hm.mode,
        ...(hm.layer ? { layer: hm.layer } : {}),
        format,
        /* ── 2026-10-15 结构化地图数据 ──
         * `cellSize` = 字符图每一格代表几个方块（= `glyphStep`）：字符图上的"第 i 行第 j 列"
         * 要用 `origin + 行列 × cellSize` 才换得回世界坐标，**别拿抽稀过的格子当精确坐标**。
         * `bounds` / `hazards` / `nearbyTargets` 里的坐标**已经是真实世界坐标**。 */
        purpose,
        cellSize: step,
        origin: { x: hm.originX ?? (hm.center.x - hm.radius), z: hm.originZ ?? (hm.center.z - hm.radius) },
        complete: hm.complete ?? !hm.truncated,
        hazards: (hm.hazards ?? hazardCellsOf(hm, { limit: 12 })).slice(0, 12),
        nearbyTargets: nav.nearbyTargets,
      }
      if (format === 'chars' || format === 'both') {
        out.glyphMap = McBot.glyphMap(hm.names, step, { x: hm.radius, y: hm.radius }, { compress: args.compress === true })
      }
      if (format === 'image' || format === 'both') {
        const img = await sess.bot.mapImageAsync({
          radius: args.radius, yTop: args.yTop, yBottom: args.yBottom, scale: args.scale, mode,
          layer: args.layer, depth: args.depth,
        })
        const png = encodePng(img.width, img.height, img.rgba)
        /* 输出瘦身：图的尺寸/字节数对 AI 没用，路径与附件才有用。 */
        out.image = {}

        // ① 内联给模型/前端看
        const att = ctx.get('attachments')
        if (att && typeof att.saveImage === 'function') {
          try {
            out.image.attachment = await att.saveImage({
              data: new Uint8Array(png), mediaType: 'image/png', name: 'mc-map.png',
            })
          } catch (e) { out.image.attachmentError = e.message }
        } else {
          out.image.attachmentError = '宿主没有 attachments 服务'
        }
        // ② 顺手落盘：默认 **`.dsh-mc-agent/.out/`**（不对外）。给了 `out`（例如
        //    `.dsh-mc-agent/.express/world1/map.png`）就写那儿 —— 落在发布区时结果里会带上
        //    现成的 `express.url` 与 `express.markdown`（`![](url)`），原样粘进回复 用户 就能看到。
        try {
          const { writeFileSync, mkdirSync } = await import('node:fs')
          const wsRoot = workspaceRootFor(exec?.agent)
          /* 🔴 2026-10-06（本机补丁）：记忆根可能已被 用户 挪出工作区（`config.memoryDir`）。
           *    默认输出必须落在**记忆根**的 `.out/`，否则每调一次 mc_map 就会在工作区里
           *    重新长出一个 `.dsh-mc-agent/`。规则与 mc_observe 扩展一致：
           *      · `.dsh-mc-agent/...` 前缀 = 记忆根相对（老写法，兼容）
           *      · 其它相对路径 = 工作区相对；绝对路径原样 */
          const memRoot = memoryRootFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent)) ?? wsRoot
          const rel = args.out
            ? String(args.out)
            : `.dsh-mc-agent/${OUT_DIR}/mc-map-${Date.now()}.png`
          const memPrefix = /^\.dsh-mc-agent[\\/]/i
          const file = isAbsolute(rel)
            ? resolve(rel)
            : memPrefix.test(rel)
              ? resolve(memRoot, rel.replace(memPrefix, ''))
              : resolve(wsRoot, rel)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, png)
          out.image.file = rel
          out.image.hint = `要让用户看到这张图：把它写到发布区（out:".dsh-mc-agent/${EXPRESS_DIR}/<子目录>/x.png"），`
            + '再用 mc_kit_express 取"给用户的那一行"（按「文件分享」模式返回路径/URL/或一句提示）。'
            + '默认输出（.out/）不对外。'
        } catch (e) { out.image.fileError = e.message }
      }
      /* 🔴 省 token（2026-10-07）：这个工具的 `output.render` 规则是"有 `text` 就用 text，
       *    没有就把**整个对象** pretty-print 成 JSON"——而这里返回的是对象（`legend` 数组 +
       *    `glyphMap` 全文）⇒ 不给 `text` 就会输出一大坨带 `\n` 转义的 JSON（实测均 1,664 字符/次）。
       *    现在给一份紧凑文本：一行图例 + 字符图 + 一行图信息。
       * 🔴 2026-10-08：顺手修掉图例里 `[object Object]` 的老 bug（`legend` 是 `{name,count}` 对象，
       *    以前直接 `.join(' ')`）。洞穴层视图的图例带 `glyph`，所以两种形状都渲染。 */
      /* 2026-10-23 审计（感知层报告 D[3]）：图例只留前 8 种（默认半径 32 时 15 种要 225 字符），
       * 剩下的都是极少数方块，`mc_scan` 要看占比时再看。 */
      const legendText = hm.legend.slice(0, 8)
        .map((e) => (e?.glyph ? `${e.glyph}${e.name}×${e.count}` : `${e?.name ?? '?'}×${e?.count ?? 0}`))
        .join(' ')
      const lines = [
        hm.mode === 'floor'
          ? `🪨 地板层图（脚下方块那一层）y=${hm.layer.y} ｜ 中心 (${hm.center.x}, ${hm.center.z}) ｜ 半径 ${hm.radius} ｜ 未加载 ${hm.unloaded} 格`
          : `🗺️ 地形图 中心 (${hm.center.x}, ${hm.center.z}) ｜ 半径 ${hm.radius} ｜ 未加载 ${hm.unloaded} 格`,
        `图例 ${legendText}`,
      ]
      if (hm.mode === 'floor') {
        const t = hm.counts ?? {}
        lines.push(`能站 ${t.walkable ?? 0} 格 ｜ 墙 ${t.blocked ?? 0} ｜ 会掉下去 ${t.drop ?? 0} ｜ 液体 ${t.liquid ?? 0} ｜ 未加载 ${t.unknown ?? 0}`)
        /* 2026-10-23 审计：符号说明与工具 description 重复，改成最短形式并顺手说明游程压缩。
         * 2026-10-23 晚：默认不压缩了，所以 X*n 的说明只在真的压缩时才出现。 */
        lines.push(args.compress === true
          ? '（·能站 #墙 v掉下去 ~水 ≈岩浆 ?未加载 ｜ X*n = 连续 n 个 X）'
          : '（·能站 #墙 v掉下去 ~水 ≈岩浆 ?未加载）')
      }
      /* 2026-10-15：`purpose` 的紧凑摘要（导航/危险）—— 让模型不用自己从几十行字符图里数 */
      for (const l of nav.lines) lines.push(l)
      if (out.glyphMap) lines.push(out.glyphMap)
      if (out.image) {
        lines.push(`🖼️ ${hm.mode === 'floor' ? '地板层俯视图' : '俯视图'} ${out.image.width}×${out.image.height}（每格 ${out.image.scale}px，${out.image.bytes} B）`
          + `${out.image.file ? ` 落盘：${out.image.file}` : ''}${out.image.attachment ? '（已内联）' : ''}`)
        if (out.image.attachmentError) lines.push(`（内联失败：${out.image.attachmentError}）`)
        if (out.image.fileError) lines.push(`（落盘失败：${out.image.fileError}）`)
      }
      out.text = lines.join('\n')
      return out
    },
  }))

  /* mc_entities（附近有谁）已于 2026-10-08 并进 mc_observe 的三段式感知（② 程序检测到）——
   * 用户要求「不要只让 AI 看截图，也不要只让 AI 读取方块坐标」，所以一次调用给全：图 + 程序侧实体（坐标/血量）。
   * 实体数据仍走 src/core.mjs 的 entities()（同一份判据），功能没有损失。 */
  ctx.tools.register(asTool({
    name: 'mc_inventory',
    description: '看背包、装备栏和手持物品。',
    parameters: {},
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const inv = sess.bot.inventory()
      return { text: inv.text }
    },
  }))

  /* ── 行动 ── */

  /* 周围实体快照（用户 m01114：走完一步要能看见"身边有谁"，不用再单独叫 mc_entities）。
   * 只列 12 格内、最多 6 个；附近没人就返回 {}（常态零额外 token）。 */
  /* 🔴 2026-10-23 审计（用户："怎么全是item"）：掉落物统一叫 item，地上摊着几件就把真怪挤没了。
   *    口径与 src/attack.mjs 的 nearOf 一致：活体优先（同类合并成 count），掉落物只报个数、不占名额。
   *    距离字段统一叫 distance（以前这里叫 d，mc_observe 叫 distance，同一个意思两个名）。 */
  const aroundOf = (sess, radius = 12) => {
    const b = sess?.bot?.bot
    const me = b?.entity?.position
    if (!me) return {}
    const live = new Map()
    let junk = 0
    let junkNearest = Infinity
    for (const e of Object.values(b.entities ?? {})) {
      if (!e || !e.position || e.id === b.entity?.id) continue
      let d = Infinity
      try { d = me.distanceTo(e.position) } catch { continue }
      if (!(d <= radius)) continue
      const name = e.username || e.name || e.displayName
      if (!name) continue
      if (isDropEntity(e) || /^experience_orb$/i.test(String(e.name ?? ""))) {
        junk++
        if (d < junkNearest) junkNearest = d
        continue
      }
      const cur = live.get(name)
      if (cur) {
        cur.n += 1
        if (Number(d.toFixed(1)) < cur.distance) cur.distance = Number(d.toFixed(1))
      } else {
        live.set(name, {
          name, n: 1, distance: Number(d.toFixed(1)),
          ...(HOSTILE_RE.test(name) ? { hostile: true } : {}),
          ...(Number.isFinite(Number(e.health)) ? { hp: e.health } : {}),
        })
      }
    }
    const around = [...live.values()]
      .sort((a, c) => a.distance - c.distance)
      .slice(0, 6)
      .map(({ n, ...rest }) => (n > 1 ? { ...rest, count: n } : rest))
    if (!around.length && !junk) return {}
    return {
      ...(around.length ? { around } : {}),
      ...(junk ? { junk: { count: junk, nearest: Number(junkNearest.toFixed(1)) } } : {}),
    }
  }

  ctx.tools.register(asTool({
    name: 'mc_move',
    description: '移动。mode="walk" 走过去（自动避障；**在水里会自动改成"直接游"**）；mode="fly" 创造直飞（约 9 格/秒，会先发飞行权限包）；'
      + 'mode="jump" 原地跳一下（不需要坐标）；\n'
      + '在水里不用选模式：给 x/y/z 就自己游过去（默认一直浮在水面，不会沉下去）。\n'
      + 'mode="boat" 开船（先 use 上船；下船用 mode="dismount"）。\n'
      + '🔴 **一次只走 10 秒**。没走到返回 `arrived:false`+`remaining`+`hint`——**再叫一次往同一目标走**。\n'
      + '🔴 默认不垫方块、不搭路：垒柱子要 `allowTower:true`，路断了自动铺桥要 `allowBridge:true`。\n'
      + '🪜 **一格台阶会先试着踩上去**（量真实位移才算成功）；头顶被堵就跳不起来 —— 允许挖时只清头顶那格，不挖报 `stepUp.why="no-headroom"`。\n'
      + '🔴 走不动会分清挡着的是什么：`entity`（实体，别挖）/ `lava`（岩浆，挖不动）/ `waiting_chunks`（区块没加载，等）/ `stepUp`（一格台阶）。\n'
      + '🧭 `intent` 决定"到"的标准：near（默认）/ stand / interact（2.2 格）/ same-level。\n'
      + '🔴 **长程赶路只给 x/z 就够**（`xz:true`）：不必猜高度，按"到那一列"算（哪一层由寻路器定）—— 别编个 y 把自己挂半空。**给了 y 就按 y 走，xz 被忽略。**\n'
      + '🔴 没走到时报 `pathLen`（剩余路径几格）+ `estCalls`（还要几次调用，一次 10 秒 ≈ 24 格）。\n'
      + '🔴 结果带 `above`（头顶净空 `headroom` / `canJump`）：`canJump:false` 就是跳不起来（`note` 说哪格堵着），先挖开或换落点，别反复 `mode:"jump"`。\n'
      + '🔴 掐断报 `reason:"walk-hung"`（服务端不回包，不是路不通）；`digStalled`=挖方块卡在回包上。别原样第三次重叫。\n'
      + '🔴 **卡住时按执行顺序升**（`planStep`=最后试的那级）：允许挖（`noDig:false`，或自动升级那一遍）时 开门→重算→跳→**挖**→后退→绕行→垫柱；'
      + '不挖的那一遍**没有"挖"这一级**：开门→重算→跳→后退→绕行→垫柱。'
      + '`planTried` 列出真试过哪几级。同目标 90 秒内再叫会**从上次那级接着升**。',
    parameters: {
      x: { type: 'number' },
      y: { type: 'number', description: '脚底那格：y=77 站在 76 的方块上，不是 76 那块' },
      z: { type: 'number' },
      mode: { type: 'string', description: 'walk / fly / jump / boat（创造缺省 fly；jump 不需坐标；boat 要先上船；水里自动游，没有 swim）' },
      noDig: { type: 'boolean', description: '走路时挖不挖方块（**默认不挖**，只绕路；绕不过去会自动改成挖穿再走一遍）；写 false = 第一遍就允许挖，而且**按最短路线挖**（该挖就挖，不再优先绕路）' },
      xz: { type: 'boolean', description: '长程赶路：只给 x/z 就够（按"到那一列"算 GoalXZ）；给了 y 就按 y 走；写 false 等于必须给 y；fly/boat 仍必须给 y' },
      budgetMs: { type: 'number', description: '走路/游泳最长时间（≤10000）' },
      waterRecover: { type: 'boolean', description: '游不动时自动找出口（默认 true）' },
      allowTower: { type: 'boolean', description: '允许垫 1×1 柱往上爬（默认不许，容易摔死）' },
      allowBridge: { type: 'boolean', description: '允许自动搭路：A* 没路时朝目标铺方块造桥（直线、一次≤4格、血量<8 不铺）' },
      intent: { type: 'string', description: 'near（默认）/ stand / interact / same-level' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const mode = String(args.mode ?? '')
      /* 用户 2026-10-20 定：**默认不挖** —— 走路一格都不挖，非挖不可要显式 `noDig:false`。
       * 只影响走路那一条：寻路的 `canDig` 关掉，卡住时"挖开台阶"的补救也关掉
       * （见 `src/movement.mjs` 的 `walkPathfinder`）。
       * 2026-10-25 用户：「删掉」`mode:"walk-nodig"` —— 它跟 `noDig:true` 效果重复，
       *   唯一区别是硬盖住 `noDig:false`，而默认本来就不挖，留着只会让人多学一个值。 */
      const noDig = args.noDig !== false
      if (mode === 'jump') return { ...(await sess.bot.jump()), ...aroundOf(sess) }
      /* 🔴 2026-10-27（用户 m05868：「把 mode swim 去掉」）：这个分支删了。
       *   给坐标那条本来就等于 `walkTo`（人在水里会自动走"直接游"那条，见 movement.mjs 的
       *   `walkToOnce` 游泳分支）；不给坐标那条只是上浮换气 —— 而上浮现在由游泳循环自己保：
       *   在水里一律按着 jump 浮着（`swimJumpWanted`），空气低于 `SWIM_MIN_AIR` 之前也会先浮上去。
       *   于是"游泳"不再是一个模式，游不游由**人在哪儿**决定。 */
      /* 🔴 2026-10-23（P0-a，用户 m00634）：允许**只给 x/z** —— 长程目标的 y 是猜的，
       *    以前强制三维点等于逼 AI 编一个高度（编高就垫方块上天、编低就 NoPath）。
       *    `xz:true` 或"给了 x/z 没给 y"都按"到那一列"算；替换成的 y 只是**当天的脚下高度**，
       *    留给 watcher / 兜底逻辑参考，不参与 goal。 */
      /* 🔴 2026-10-23 修（用户 m00786「为什么现在用不了 y」）：**给了 y 就以 y 为准**。
       *    以前 `xz:true` 会把同时给的 y 静默吃掉（换成脚下高度），等于 y 白写；
       *    现在只有"没给 y"才按 xz 走，给了 y 就按三维（GoalNear），写没写 xz 都一样。 */
      const yGiven = args.y !== undefined && args.y !== null
      /* 🔴 2026-10-24 通审：`xz` 这个参数**以前从来没人读** —— 真正决定"按列走"的只有"给没给 y"，
       *    于是它是个幽灵参数（写 xz:true 没效果，写 xz:false 也没效果）。现在让它有用：
       *    显式 `xz:false` + 没给 y ⇒ 当场说清楚（而不是悄悄按列走，让人以为 y 生效了）。 */
      if (!yGiven && args.xz === false) {
        throw new Error('写了 xz:false 就得给 y —— 不想猜高度就别写 xz:false（只给 x/z 就按"到那一列"走）')
      }
      const wantsXZ = !yGiven
      if (args.x === undefined || args.z === undefined) {
        throw new Error('walk/fly 需要 x/z；只想跳一下请给 mode:"jump"（水里会自动游，没有 swim）')
      }
      const target = wantsXZ
        ? { x: numOf(args.x, 'x'), y: Math.floor(Number(sess.bot.bot?.entity?.position?.y ?? 64)), z: numOf(args.z, 'z') }
        : coordOf(args)
      const creative = sess.bot.bot?.game?.gameMode === 'creative'
      const use = mode || (creative ? 'fly' : 'walk')
      // 🔴 2026-10-08 审计⑤：fly 以前不传 budgetMs —— 写 budgetMs:2000 也照样跑满 10 秒
      /* 🔴 2026-10-29（用户：「mc_move 的输出单独做一次精简」）：模型只看三形态
       *   `progress` / `arrived` / `blocked`；寻路细节（roadInfo/moveInfo/fellInfo/dugBlocks/
       *   shaft/briefBlocks/逐级 planTried…）**只进本地日志**，不进模型上下文。 */
      const deaths0 = deathMarkOf(sess)
      const finish = (res) => {
        const brief = briefMoveOf(res, sess.bot.bot?.entity?.position ?? null)
        /* 明细落日志：出问题时翻日志能看到全部字段（原来这些都在返回里）。 */
        try {
          logLine(`mc_move 明细 target=${JSON.stringify(target)} args=${JSON.stringify(args)} → ${JSON.stringify(res)}`)
        } catch { /* 日志写不进去不影响结果 */ }
        const died = deathMarkOf(sess) > deaths0
        return { ...brief, ...(died ? deathNoteOf(sess) : {}), text: briefMoveTextOf(brief) + (died ? deathLineOf(sess) : '') }
      }
      if (use === 'fly') {
        if (wantsXZ) throw new Error('fly 是三维直飞，必须给 y（xz:true 只对 walk 有效）')
        return finish(withOutcome(await sess.bot.flyTo(target.x, target.y, target.z, { budget: callBudget(args.budgetMs) }), { expect: 'moved' }))
      }
      if (use === 'boat') {
        if (wantsXZ) throw new Error('boat 要有终点高度，必须给 y（xz:true 只对 walk 有效）')
        return finish(withOutcome(await sess.bot.driveBoat(target, { arrive: args.intent === 'stand' ? 1.2 : 2, budget: callBudget(args.budgetMs) }), { expect: 'moved' }))
      }
      if (use !== 'walk') throw new Error(`未知 mode："${use}"（可用 walk / fly / jump / boat）`)
      /* 2026-10-25：走不通就自动改成「挖穿挡路的方块」再走一次（显式 `noDig:false` 除外）。 */
      return finish(withOutcome(await walkWithAutoDig(sess, target, { noDig, noTower: args.allowTower !== true, noBridge: args.allowBridge !== true, intent: intentArgOf(args.intent), waterRecover: typeof args.waterRecover === 'boolean' ? args.waterRecover : undefined, xz: wantsXZ }, args.budgetMs, noDig === true), { expect: 'moved' }))
    },
  }))

  /* ── 行动：看向/走近/放置/破坏/使用/攻击/装备/丢弃（统一入口）── */

  ctx.tools.register(asTool({
    name: 'mc_act',
    /* 🔴 2026-10-20 审计（用户："减少 token 消耗"）：每行只留"这个 mode 干什么 + 影响决策的行为"，
     *    参数细节交给下面那张参数表 —— 原来每个 mode 后面都跟着一长串解释，673 字里有近一半是重复的。 */
    description: '与游戏世界互动（**优先用它，别用服务器指令**）。mode：\n'
      + '· look 看向坐标或玩家(who)；要看方向/速度就加 track:1500 + samples（末影之眼指路）\n'
      + '· toward 看向并走近某个玩家(who)\n'
      + '· place 放方块 (x,y,z)；悬空先垫脚（=搭高）\n'
      + '· bridge 搭路：朝 (x,y,z) 铺脚下一层；加 slope:±1 就每格升降 1（搭楼梯）；脚下悬空/区块没加载/血量<8 就停，岩浆与深空只警告\n'
      + '· break 破坏 (x,y,z)：自动换对的工具；视线被挡会先把挡路的挖开\n'
      + '· use 用方块/实体(who)：门/按钮/拉杆/喂动物；都不给=用手上的\n'
      + '· useitem 用手上的东西：扔眼睛/雪球；**带 x/y/z 先瞄准、停 450ms 再用**（舀水/骨粉/补种）\n'
      + '· equip 装备(name)：护甲自动穿、盾进副手\n'
      + '· toss 丢弃(name,count)\n'
      + '· jump 原地跳\n'
      + '· sleep 睡最近的床（夜里/雷雨才行；白天直接说别白跑）\n'
      + '· wake 起床（躺着时才有用）\n'
      + '· farm 耕地+播种（给 x/y/z 就那一格，不给就在周围找；熟了的先收）\n'
      + '· boat 放船并坐上去：自动找周围 2–4 格内**能放船的水面**（水 + 上方空气），对准水面放、\n'
      + '  放下后复核船底是水，默认上船（board:false 只放），给 x/y/z 就在那附近找\n'
      + '· dismount 下船/下车（开船用 mc_move boat）\n'
      + '· respawn 重生（死着时用，不叫就躺着）',
    parameters: {
      mode: { type: 'string', description: '见上面各 mode（默认 look）' },
      who: { type: 'string', description: '玩家/实体名（look/toward/use）' },
      x: { type: 'number', description: '要动的那一块的方块坐标 x（整数格）' },
      y: { type: 'number', description: '要动的那一块的方块坐标 y（整数格）' },
      z: { type: 'number', description: '要动的那一块的方块坐标 z（整数格）' },
      allowDangerous: { type: 'boolean', description: 'break：允许挖自己脚下的支撑（默认拦）' },
      noClear: { type: 'boolean', description: 'break：视线被挡时不自动挖开挡路的方块（默认会自动挖）' },
      name: { type: 'string', description: '方块或物品名（place/equip/toss 用）' },
      to: { type: 'string', description: 'equip 装哪格：head/torso/legs/feet/off-hand；只给=脱掉' },
      count: { type: 'number', description: 'toss 丢几个（默认 1）/ farm 最多处理几格（默认 6，上限 16）' },
      slope: { type: 'number', description: 'bridge：每格升降几格（0 平铺默认；1 往上搭阶梯，-1 往下）' },
      hold: { type: 'number', description: 'useitem 按住毫秒（拉弓 1000）' },
      approach: { type: 'boolean', description: 'toward 走近吗（默认 true）' },
      budgetMs: { type: 'number', description: 'toward/sleep/farm 的走动毫秒（默认 10000）' },
      seed: { type: 'string', description: 'farm：种什么（默认背包里第一种种子；wheat_seeds / carrot / potato / beetroot_seeds）' },
      harvest: { type: 'boolean', description: 'farm：上面熟了的先收（默认 true）' },
      clear: { type: 'boolean', description: 'farm：上面有杂物先挖掉（默认 false，只跳过并报出来）' },
      radius: { type: 'number', description: 'sleep 找床 / farm 找地的范围（sleep 默认 32 上限 64；farm 默认 4 上限 8）' },
      waitMs: { type: 'number', description: 'sleep：躺上后最多等多久醒（默认 8000，上限 20000）' },
      board: { type: 'boolean', description: 'boat：放下后要不要直接坐上去（默认 true）' },
      newEntity: { type: 'number', description: 'look：从现在起多少毫秒内**新出现**的实体（扔眼睛/珍珠才生成；默认 0=不等）' },
      track: { type: 'number', description: 'look：跟踪多少毫秒（边跟边采样；默认 0=只转一次头）' },
      samples: { type: 'string', description: 'look+track：summary（默认）/ raw（附原始点序列）' },
      useItem: { type: 'boolean', description: 'look：等新实体前先用手上的东西（扔眼睛）—— 比先 useitem 再 look 更准，中间不漏' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const bot = sess.bot
      const mode = String(args.mode ?? 'look')
      switch (mode) {
        /* 🔴 2026-10-23 实机（用户直接把『未知 mode："jump"』贴回来）：跳一下属于移动，
         *    但人在 mc_act 里找它（脱困 / 爬台阶时手最顺的就是这个工具）。与其报错让人换工具，
         *    直接把 jump 接过来 —— 和 mc_move {mode:"jump"} 走同一条路（同一个 bumpGen）。 */
        /* 2026-10-29（用户：「改成由 ai 选择重生」）：现在不自动重生，模型叫这里。 */
        case 'respawn': return withOutcome({ mode, ...(await bot.respawnNow()) }, { ...aroundOf(sess) })
        case 'jump':    return withOutcome({ mode, ...(await bot.jump()) }, { ...aroundOf(sess) })
        case 'look': {
          /* 2026-10-24：带 newEntity / track / samples / useItem 时走跟踪层（src/look-track.mjs）。
           * 都不给 = 原来的一次性转头，行为一字未变。 */
          if (args.newEntity || args.track || args.samples || args.useItem) {
            return withOutcome({ mode, ...(await lookTrack(bot.requireBot(), args, {
              useItem: args.useItem ? () => bot.useItem({ hold: args.hold }) : null,
              moveGenOf: () => bot._moveGen,
            })) })
          }
          return withOutcome({ mode, ...(await bot.lookAt(args)) })
        }
        case 'toward':  return withOutcome({ mode, ...(await bot.interact(args)) })
        case 'place':   return withOutcome({ mode, ...(await bot.placeBlock(args)) }, { expect: 'placed' })
        /* P0-2（用户 m02868）：搭路是**独立状态机** —— 每格"放一块 → 等服务端确认 → 才走"，任何一处
         * 对不上（脚下悬空 / 区块没加载 / 血量太低 / 回读没确认）立刻停，绝不继续往下铺；桥下有岩浆/火、或者下方是 >64 格深空 ⇒ **只警告不拦**（2026-10-22 用户要求），结果里带 warnings/risk。
         * `x/y/z` 是**终点那一格**（铺在脚下一层），方向与格数由 `bridgeDirTo()` 反推。 */
        case 'bridge':  return withOutcome({ mode, ...(await bot.bridge({ x: args.x, y: args.y, z: args.z, name: args.name, slope: args.slope })) })
        case 'break':   return withOutcome({ mode, ...(await bot.breakBlock(args)) })
        case 'use': {
          // 没给坐标也没给 who ⇒ 不是"右键某个东西"，而是"用手上的东西"（对着空气用）
          const noTarget = args.who == null && args.x == null && args.y == null && args.z == null
          if (noTarget) return withOutcome({ mode: 'useitem', ...(await bot.useItem(args)) })
          return withOutcome({ mode, ...(await bot.useBlock(args)) })
        }
        case 'useitem': return withOutcome({ mode, ...(await bot.useItem(args)) })
        case 'fish':    return withOutcome({ mode, ...(await fishOnce(bot.requireBot())) })
        case 'equip':   return withOutcome({ mode, ...(await bot.equip({ name: args.name, to: args.to })) })
        case 'toss':    return withOutcome({ mode, ...(await bot.tossItem({ name: args.name, count: args.count })) })
        /* 用户 2026-10-20：「还有下船」—— 上船一直有（`use`→`activateEntity`），下来没有：
         * `bot.dismount()` 只发包不确认，实现在 `src/boat.mjs`（发完轮询 `bot.vehicle`）。 */
        /* 2026-10-23 一档第 4 条（用户「1档和2档做一下」）：睡觉 / 起床 / 耕地播种。
         * 睡和种都是"夜里 / 远处才用得上的长活"，塞进 mc_act 是因为脱困过夜时手最顺的就是这个工具。 */
        case 'sleep':   return withOutcome({ mode, ...(await sleepInBed(bot, { x: args.x, y: args.y, z: args.z, radius: args.radius, waitMs: args.waitMs, budgetMs: args.budgetMs })) })
        case 'wake':    return withOutcome({ mode, ...(await wakeUp(bot)) })
        case 'farm':    return withOutcome({ mode, ...(await farmArea(bot, { x: args.x, y: args.y, z: args.z, seed: args.seed, harvest: args.harvest, clear: args.clear, radius: args.radius, count: args.count })) })
        /* 2026-10-24 用户：「能走到水边，但是放不下，没有对着水面，太远或者太近」—— 放船真正的难点是**选哪一格**，
         * 不是发不发包。所以这里一步做完：找水面 → 视线对准 → 放 → 复核船底下是水 → 上船；失败自动换下一个水面点。 */
        case 'boat':    return withOutcome({ mode, ...(await launchBoat(bot, { x: args.x, y: args.y, z: args.z, name: args.name, board: args.board, radius: args.radius })) }, { expect: 'placed' })
        case 'dismount': return withOutcome({ mode, ...(await bot.dismountVehicle()) })
        default: throw new Error(`未知 mode："${mode}"（可用 look/toward/place/bridge/break/use/useitem/fish/equip/toss/jump/sleep/wake/farm/boat/dismount；走路/飞/游泳用 mc_move，射箭/打怪/自查/方块台另见 mc_shoot / mc_attack / mc_prep / mc_station）`)
      }
    },
  }))

  /* 钓鱼（用户 2026-10-22：「加一个钓鱼的功能」，随后「加工具，不要管预算」）——
   * 手里有竿就抛，盯浮标有没有明显往下沉（那就是咬钩），沉了收竿。
   * 实现在 `src/fish.mjs`：单次最多盯 8 秒，没咬钩浮标留在水里，**再叫一次接着盯**，不必重新抛。 */
  ctx.tools.register(asTool({
    name: 'mc_fish',
    description: '**钓鱼**：自动抛竿 → 盯浮标 → 咬钩就收竿（浮标明显往下沉才算咬钩）。\n'
      + '· 手上有 fishing_rod 就用手上那把；没有就从背包换出来，都没有会告诉你先 `mc_craft {name:"fishing_rod"}`。\n'
      + '· **一次只盯 8 秒**：没咬钩返回 `reason:"timeout"`，浮标还在水里 —— 再叫一次 `mc_fish` 接着盯，不用重新抛。\n'
      + '· 抛竿了却没浮标 ⇒ 前方不是水面（走到水边 2~4 格、看得见水面再钓）。\n'
      + '· 收竿后战利品掉在水边，要自己走过去踩上捡。',
    parameters: {
      timeoutMs: { type: 'number', description: '最多盯多久（毫秒，默认 8000，夹在 1000~10000）' },
    },
    output: text(),
    timeoutMs: CALL_MS + 3_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const budget = Math.min(Math.max(Number(args.timeoutMs ?? 8000), 1_000), 10_000)
      const r = await fishOnce(sess.bot.requireBot(), { timeoutMs: budget })
      const head = r.ok ? '🎣 上鱼了' : '🎣 没上鱼'
      const tail = r.bobber ? `\n浮标在 (${r.bobber.x}, ${r.bobber.y}, ${r.bobber.z})` : ''
      /* 🔴 2026-10-23 实机：这里返回**裸字符串**，宿主校验 `output` 的 `{type:'object'}` 直接拒掉，
       *    报「tool "mc_fish" returned invalid output: "value" must be an object」——
       *    等于钓鱼整个不可用（连人都没开始钓就被拦）。其它工具返回的是对象，只有这里裸串。
       *    统一成 `{ text }`（`text()` 的 render 会优先取 `value.text`）。 */
      return withOutcome({ text: `${head}：${r.message}${tail}`, ...r })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_give',
    description: '**创造模式直接获取物品**（不走 /give 指令——那是协议级改槽位，非 OP 也能用）。'
      + '给英文物品 id，如 oak_planks / diamond_sword / white_concrete。clearAll=true 清空背包。'
      + '\n· 不传 slot 自动找空位；slot 那格已有别的东西会**拒绝**（要盖加 force:true）。',
    parameters: {
      name: { type: 'string', description: '物品英文 id（如 oak_planks）' },
      count: { type: 'number', description: '数量（默认 1，上限该物品堆叠数）' },
      slot: { type: 'number', description: '指定槽位 9-44（0=合成结果、1-4=合成格、5-8=盔甲；缺省自动找空位）' },
      force: { type: 'boolean', description: 'slot 已有别的东西时 true=确认顶掉（默认拒绝）' },
      clearAll: { type: 'boolean', description: 'true=清空整个背包（忽略 name）' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      /* 🔴 2026-10-23 审计：清空走 `clearInventory`、给物走 `giveItem`，两个分支返回的键**完全不同**
       *    （`{cleared,left,names}` vs `{gave,slot,now}`），而且都没有 text —— 模型只能靠猜键名判成败。 */
      if (args.clearAll) {
        const r = await sess.bot.clearInventory()
        return withOutcome({
          ...r,
          text: r.cleared
            ? '🧹 背包清空了（抽查过：一件不剩）'
            : `🧹 **没清干净**：还剩 ${r.left} 叠（${(r.names ?? []).join('、')}）—— 别当成背包空了`,
          ...(r.cleared ? { done: true } : { ok: false }),
        })
      }
      const g = await sess.bot.giveItem({ name: args.name, count: args.count, slot: args.slot, force: args.force })
      return withOutcome({
        ...g,
        text: g.now
          ? `🎁 已给出 ${g.gave}（第 ${g.slot} 格${g.note ? '，' + g.note : ''}）`
          : `🎁 **没放进去**：${g.gave} —— ${g.note ?? '服务端没认这次 setInventorySlot，别当成拿到了'}`,
        ...(g.now ? { done: true } : { ok: false }),
      })
    },
  }))

  /* 射箭（2026-10-22 用户：「这些拆了」——从 mc_act 独立出来）——
   * 弹道在 `src/shoot.mjs`：换弓回读 → 数箭 → hawkeye 算 yaw/pitch → 拉满 → 再瞄一次 → 放 → 数箭确认。
   * 用户 2026-10-19：「hawkeye 主要是水晶和末影龙」；2026-10-20：「shoot 完显示周围实体，和 attack 一样」。 */
  ctx.tools.register(asTool({
    name: 'mc_shoot',
    description: '**射箭**：自动换弓、算弹道、拉满、放箭，射完报 12 格内身边有谁。\n'
      + '· 射水晶给 `x/y/z`；打龙 `who:"ender_dragon"`（自动瞄 +2.8 格）。\n'
      + '· 落点误差 > 4 格会拒射并说明"太远/角度刁"，不瞎射。'+
      + '· 平射路径上有方块挡着（墙 / 台阶 / 树叶 / 地形）时**自动改高抛**越过去；'+
      + '高抛也不通就**不放箭**，说清是什么方块、挡在哪一格（`force:true` 才硬射）。',
    parameters: {
      who: { type: 'string', description: '目标实体名（如 ender_dragon）' },
      x: { type: 'number', description: '目标 x（整数格，射水晶/坐标用）' },
      y: { type: 'number', description: '目标 y（整数格；不给就按自动瞄点）' },
      z: { type: 'number', description: '目标 z（整数格）' },
      count: { type: 'number', description: '连射几箭（默认 1，≤5）' },
      waitTime: { type: 'number', description: '拉弓多久再放（默认 1200ms）' },
      weapon: { type: 'string', description: '用什么射（默认 bow；可 crossbow/trident）' },
      aim: { type: 'number', description: '瞄点高度（相对脚底格数，负数往下）；不给=自动（龙 +2.8、普通怪瞄头）' },
      maxDist: { type: 'number', description: '只射这么近的目标（格）' },
      lead: { type: 'boolean', description: '移动目标的提前量（默认开）' },
      force: { type: 'boolean', description: '弹道被方块挡着也硬射（默认不射）' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const bot = sess.bot
      return { ...withOutcome({ ...(await bot.shoot({ who: args.who, x: args.x, y: args.y, z: args.z, count: args.count, waitTime: args.waitTime, lead: args.lead, weapon: args.weapon, aim: args.aim, maxDist: args.maxDist, force: args.force })), ...bossBarsField(bot) }), ...aroundOf(sess) }
    },
  }))

  /* 打实体（2026-10-22 用户：「这些拆了」）—— 目标选择/风筝/追击自成一族。 */
  ctx.tools.register(asTool({
    name: 'mc_attack',
    description: '**打实体**：中英文名都认，24 格内会追上去；不给 who 就按 priority 挑。\n'
      + '· `kite:true` 放风筝：近战怪打一下退一步。\n'
      + '· `stand:true` 站桩：一步不挪，只打 4.5 格内（自己搭个 2 格高小平台钻进去打末影人就靠它；够不着就原地等它走近）。\n'
      + '· 血 < 12、身边两只以上怪、或者碰上苦力怕/骷髅/女巫/末影人 —— 先撤，别硬打。\n'
      + '· 打完顺手报 Boss 血条（有 boss 在场时）。',
    parameters: {
      who: { type: 'string', description: '玩家/实体名（中英文都认）' },
      priority: { type: 'string', description: '选目标：threat(默认)/nearest/weakest(血最少)' },
      kite: { type: 'boolean', description: '放风筝：近战怪打一下退一步' },
      stand: { type: 'boolean', description: '站桩：一步不挪，只打 4.5 格内的（默认 false）' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const bot = sess.bot
      return withOutcome({ ...(await bot.attack(args)), ...bossBarsField(bot) })
    },
  }))

  /* 出发前自查（2026-10-22 用户：「这些拆了」）—— 它是**只读**的，跟动手类不是一族。 */
  ctx.tools.register(asTool({
    name: 'mc_prep',
    description: '**出发前自查**：数真状态（装备/附魔/附魔台/书架/青金石/等级/末影之眼…），不靠记忆。\n'
      + '· `for:"nether"`（默认）查下界门槛；`for:"end"` 查末地门槛。',
    parameters: {
      /* ⚠️ `for` 是 JS 保留字，解构时必须写 `args.for`，不能 `const { for } = args` */
      for: { type: 'string', description: '查哪趟：nether（默认）/ end' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      return withOutcome({ ...(prepCheck(sess.bot.requireBot(), { for: args.for })) })
    },
  }))

  /* 附魔台 / 铁砧 / 锻造台（2026-10-22 用户：「这些拆了」）—— 三个都是"对着方块 UI 操作"，
   * 共用"走到方块 → 打开 → 操作 → 确认"的骨架，合成一个工具、用 kind 分。 */
  ctx.tools.register(asTool({
    name: 'mc_station',
    description: '**对着方块 UI 操作**：附魔台 / 铁砧 / 锻造台走同一个骨架。\n'
      + '· `kind:"enchant"`：`option` 选第几项（0/1/2），`item` 哪件（默认手上）。\n'
      + '· `kind:"anvil"`：`action:"combine"`（默认）或 `"rename"`；`name` 是重命名/合并用的名字。\n'
      + '· `kind:"smithing"`：`item` + `name` + `template`（不给模板就自己挑）。\n'
      + '· 给了 x/y/z 就直奔那个方块，不给就近找。',
    parameters: {
      kind: { type: 'string', description: 'enchant / anvil / smithing' },
      item: { type: 'string', description: '哪件物品（默认手上）' },
      name: { type: 'string', description: 'anvil 重命名/合并的名字；smithing 的材料名' },
      option: { type: 'number', description: 'enchant 第几项（0/1/2）' },
      action: { type: 'string', description: 'anvil：combine（默认）/ rename' },
      template: { type: 'string', description: 'smithing 的模板（默认自己挑）' },
      x: { type: 'number', description: '方块坐标 x（整数格，可选，和 y/z 一起给）' },
      y: { type: 'number', description: '方块坐标 y（整数格）' },
      z: { type: 'number', description: '方块坐标 z（整数格）' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const bot = sess.bot
      const kind = String(args.kind ?? 'enchant')
      const at = { x: args.x, y: args.y, z: args.z }
      if (kind === 'enchant') return { kind, ...(await bot.enchantTable({ option: args.option, item: args.item, ...at })) }
      if (kind === 'anvil') return { kind, ...(await bot.anvilTable({ action: args.action, item: args.item, name: args.name, ...at })) }
      if (kind === 'smithing') return { kind, ...(await bot.smithingTable({ item: args.item, name: args.name, template: args.template, ...at })) }
      throw new Error(`未知 kind："${kind}"（可用 enchant / anvil / smithing）`)
    },
  }))

  /* 村民交易（用户 2026-10-23：「1档和2档做一下」—— 一档第一条）。
   * 抄 mindcraft 的 tradeWithVillager / showVillagerTrades（src/agent/library/skills.js:1748-1904），
   * 但把"找谁/买第几条/买几次/买不买得起"做成两个 action：list 先看，buy 再买。
   * 实现在 src/trade.mjs（openVillager 只认村民、count 必须显式给、realPrice 含涨价，都写在那个文件头上）。 */
  ctx.tools.register(asTool({
    name: 'mc_trade',
    description: '**村民交易**（附魔书、钻石工具、食物这些中期最划算的来源）：走同一个工具、两个 action。\n'
      + '· `action:"list"`（默认）：走到村民旁边、开界面、把它卖什么全列出来（序号 / 要什么 / 给什么 / 已换几次 / 材料够换几次）。\n'
      + '· `action:"buy"`：`index` 是上面那个**序号（从 1 开始）**，`count` 换几次（默认 1）。\n'
      + '· `who` 指定哪个村民（最近/图书管理员/盔甲匠…中英文都认），不给就找最近的。\n'
      + '🔴 开不起界面多半是：它睡着了（晚上/下雨）、是宝宝、没职业（傻子），或者你离它超过 4 格。\n'
      + '🔴 附魔书要挑附魔：不对就换一个村民，或者拆了它的工作台重放（刷新交易）。\n'
      + '🔴 换到的次数以它自己报的"已换 N/M"为准（材料可能被别的手顺走，但次数骗不了人）。',
    parameters: {
      action: { type: 'string', description: 'list（默认，看它卖什么）/ buy（买第几条）' },
      who: { type: 'string', description: '哪个村民（职业名中英文都认；默认最近的那个）' },
      index: { type: 'number', description: 'buy：第几条（从 1 开始，就是 list 里的序号）' },
      count: { type: 'number', description: 'buy：换几次（默认 1；材料/剩余次数不够会自己收窄并说明）' },
      radius: { type: 'number', description: '找村民的范围（默认 32，最大 64）' },
      budgetMs: { type: 'number', description: '走过去的时间（默认整轮 10 秒）' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      return tradeVillager(sess.bot, {
        action: args.action, who: args.who, index: args.index, count: args.count,
        radius: args.radius, budgetMs: args.budgetMs,
      })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_sequence',
    description: '**按顺序执行一串世界交互**（替代"写脚本"）：适合"走到这里放几个方块，再走到那里放几个"这类连串动作。\n'
      + 'steps 是数组，每项 op 可为：wait(sec) / move(x,y,z,mode,noDig) / look(x,y,z 或 who) / toward(who) / '
      + 'place(x,y,z,name) / break(x,y,z) / dig(name 或 x,y,z,count) / use(x,y,z 或 who) / useitem(hold) / attack(who) / '
      + 'equip(name) / give(name,count) / toss(name,count) / say(text) / jump / swim(x,y,z 或 hold)。\n'
      + '逐步执行，默认遇错即停。\n'
      + '🔴 **整串只跑 10 秒**（用户要求：单次调用别超过 11 秒）。没跑完会返回 `stoppedAt`（停在第几步，'
      + '从 0 数）+ `remaining` + `hint`——**再叫一次 mc_sequence，steps 从停下的那一步往后发就行**，'
      + '前面已经做完了。所以宁可拆成"一串 3~4 步"叫几次，也别写一大串（一大串跑到 10 秒就断了）。\n'
      + '跑完会顺手报 `around`（12 格内身边有谁：名字/距离/血量，最多 6 个）—— 不用再单独查一遍周围实体。',
    parameters: {
      steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '步骤数组（上限 64；但一次只跑得完 10 秒的量）' },
      stopOnError: { type: 'boolean', description: '出错是否停（默认 true）' },
      budgetMs: { type: 'number', description: '总预算（默认 10000，上限 10000）' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const r = await sess.bot.runSequence(args.steps, {
        stopOnError: args.stopOnError !== false,
        budgetMs: callBudget(args.budgetMs),
      })
      /* 2026-10-18 用户要求：「mc_sequence 用完以后也加上自动用 observer」——指和 `mc_move`
       * 一样，**跑完顺手报一句周围实体**（`around`，12 格内最多 6 个、附近没人就没有这个字段）。
       * 连串动作最怕"做完了但不知道身边来了谁"：一步走完直接撞上僵尸/骷髅。
       * 只读、不加任何等待，代价是每个名字几个字符。 */
      return { ...r, ...aroundOf(sess) }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_build',
    description: '批量搭方块：把 (x1,y1,z1)–(x2,y2,z2) 这个实心长方体用 name 方块搭出来（会自己走近/垫脚，上限 max 个）。'
      + '适合"搭一面墙/一根柱子/一个平台"，比一个个 mc_act{place} 省事。结果带 used/held。\n'
      + '🔴 **一次只放 10 秒的量**（用户要求：单次调用别超过 11 秒）。没放完会返回 `remaining` + `hint`——'
      + '**再叫一次 mc_build、范围原样重发就行**，已经放对的格子会自动跳过（不会报"这格已经有方块"）。\n'
      + '🔴 也能**按图施工**：给 layers（从最底层往上，一层一个字符串，层内用 / 分行）+ legend（字符→方块名，. = 空着不管），'
      + '例如 layers:["BBB/B.B/BBB","BBB/BBB/BBB"] + legend:{"B":"planks"}。会先拆掉挡路的、再自下而上放；'
      + '缺什么料直接报 missing（planks 这类泛名会按你手上那种木材落实成 oak_planks）；dryRun:true 只算不干。\n'
      + '🔴 **层数模式一定要给原点 x/y/z**（不给就用脚下这格）：人被垫高、走开几步之后"脚下这格"就变了，'
      + '重发会盖到别处去。结果里的 origin 就是这次用的原点，重发时原样带上。',
    parameters: {
      x1: { type: 'number', description: '一角 x（整数格）' }, y1: { type: 'number', description: '一角 y（整数格）' }, z1: { type: 'number', description: '一角 z（整数格）' },
      x2: { type: 'number', description: '另一角 x（整数格）' }, y2: { type: 'number', description: '另一角 y（整数格）' }, z2: { type: 'number', description: '另一角 z（整数格）' },
      name: { type: 'string', description: '用哪种方块（缺省背包第一种；**建议显式给**，重发时才认得出哪些已经放对了）' },
      max: { type: 'number', description: '最多放几个（默认 64，防手滑）' },
      layers: {
        type: 'array', items: { type: 'string' },
        description: '按图施工：从最底层往上，一层一个字符串，层内用 / 分行（给了这个就不用给 x1..z2）',
      },
      /* 🔴 2026-10-24 用户实机：层数模式没有锚点 ⇒ 只能"原地起"，人一被垫高原点就漂，
       *    结果在原地又盖一座、整个建筑跟着走。run() 一直支持 x/y/z，只是没暴露。 */
      x: { type: 'number', description: '蓝图原点 x（只对 layers 有效；不给就用脚下这格）' },
      y: { type: 'number', description: '蓝图原点 y（最底层那一层的地面高度；不给就用脚下这格）' },
      z: { type: 'number', description: '蓝图原点 z（只对 layers 有效；不给就用脚下这格）' },
      legend: { type: 'object', additionalProperties: true, description: '蓝图图例：字符→方块名（"."/空格=空着不管）；可以写泛名 planks/log/bed' },
      orientation: { type: 'number', description: '蓝图绕竖轴转几个 90°（0..3，默认 0）' },
      dryRun: { type: 'boolean', description: 'true = 只算"要动几格、缺什么料"，一格都不动' },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      if (args.layers != null) {
        return buildBlueprint(sess.bot, {
          layers: args.layers,
          legend: args.legend ?? {},
          x: args.x1 ?? args.x ?? null,
          y: args.y1 ?? args.y ?? null,
          z: args.z1 ?? args.z ?? null,
          orientation: args.orientation == null ? 0 : numOf(args.orientation, 'orientation'),
          dryRun: args.dryRun === true,
        })
      }
      if (args.x1 === undefined) {
        throw new Error('mc_build 要给范围 (x1,y1,z1)–(x2,y2,z2)；想按图纸搭就给 layers + legend（见工具说明）')
      }
      return sess.bot.build({
        ...boxOf(args),
        name: args.name ? String(args.name) : null,
        max: Math.min(Math.max(args.max == null ? 64 : numOf(args.max, 'max'), 1), 256),
      })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_dig',
    description: '挖方块：给 name 挖最近的，或给 pos 挖指定坐标；count 可连续挖多个（会自己换成对的工具；结果带 held）。\n'
      + '🔴 **一次只挖 10 秒的量**（用户要求：单次调用别超过 11 秒）。没挖完会返回"这一轮的 11 秒用完了"——'
      + '**再叫一次 mc_dig 接着挖**就行（挖到的方块留在背包里，不会白挖）。\n'
      + '🪜 **要挖阶梯就用 `mode:"stair"`**（给 y 目标高度、x/z 朝哪挖）：1 格宽 3 格高，每步升/降 1 格（不留平台），'
      + '挖完永久能上下、不会摔伤。**目标 y 比现在低就是往下挖、高就是往上挖**（上升阶梯也行）。'
      + '**别指望 mc_move 挖竖井 —— 已经禁掉了**（挖脚下直下不再允许）。\n'
      + '🧹 视线被挡着（中间夹着别的方块）会**先把挡路的挖开再挖目标**；挡路的是容器/基岩/液体会停手并说明。',
    parameters: {
      mode: { type: 'string', description: 'block（默认，挖方块）/ stair（挖阶梯：给 y 目标高度，x/z 指定朝哪挖；目标比现在低就是往下、高就是往上）' },
      dir: { type: 'string', description: 'stair 专用：朝哪挖 "x+"/"x-"/"z+"/"z-"（不给就按 x/z 或当前朝向）' },
      maxSteps: { type: 'number', description: 'stair 专用：最多挖几步（默认 64）' },
      name: { type: 'string' },
      x: { type: 'number', description: '要挖的那一块的方块坐标 x（整数格）' },
      y: { type: 'number', description: '要挖的那一块的方块坐标 y（整数格；脚下那块是 y-1）' },
      z: { type: 'number', description: '要挖的那一块的方块坐标 z（整数格）' },
      maxDistance: { type: 'number', description: '搜索半径（**默认 8**；树/矿脉远的话给大一点，上限看场景）' },
      count: { type: 'number', description: '挖几个（默认 1，上限 16；一次挖不完就再叫一次）' },
      allowDangerous: { type: 'boolean', description: '允许挖自己脚下的支撑（默认拦，下面没落脚点就掉下去）' },
      noClear: { type: 'boolean', description: '视线被挡时不自动挖开挡路的方块（默认会自动挖）' },
      digThrough: {
        type: 'boolean',
        description: '允不允许**挖穿挡路的方块**走过去（默认 false = 先只绕路；**绕不过去我会自动改成挖穿再走一遍**）。'
          + '给 true 就直接走挖穿那套、省掉第一遍绕路。',
      },
    },
    output: text(),
    timeoutMs: CALL_MS + 1_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const pos = (args.x !== undefined && args.y !== undefined && args.z !== undefined)
        ? coordOf(args) : null
      const lines = await sess.bot.dig({
        mode: args.mode === 'stair' ? 'stair' : 'block',
        dir: args.dir ? String(args.dir) : null,
        /* 🔴 2026-10-25：stair 的目标高度必须单独传 —— 下面那个 pos 要求 x/y/z 齐全，
         *   而说明里写的是"x/z 可选"，只给 y 时 pos 为 null（实机踩过）。 */
        targetY: Number.isFinite(Number(args.y)) ? Number(args.y) : null,
        maxSteps: args.maxSteps,
        name: args.name ? String(args.name) : null, pos,
        /* 2026-10-23：默认搜索半径 16 → 8。16 格外的矿一律要被走过去，而"走过去"正是
         *   乱挖/垫柱的来源；8 格内的矿基本都在身边，挖起来干脆。远处的先 mc_move 靠近。 */
        maxDistance: args.maxDistance ?? 8, count: args.count,
        noDig: args.digThrough !== true,
        noClear: args.noClear === true,
        /* 🔴 2026-10-20 审计：`allowDangerous` 在上面声明了、`dig()` 也认这个参数，
         *    但这里**从来没传过** —— 于是"带 allowDangerous:true 就能挖脚下"这句
         *    写进报错文案的逃生阀**永远是 false**，AI 照着做也没用。 */
        allowDangerous: args.allowDangerous === true,
      })
      /* 🔴 审计 F1：`dig()` 回的是**字符串数组**，这里必须同时给 `result`（结构化保留）
       * 和 `text`（拼好的正文）。`outcomeOf()` 与任务执行器的"失败分类"都只看
       * `error/reason/note/why/hint/text` —— 只回 `result` 的话它们**一个字都读不到**，
       * 于是"挖成功 / 服务端拒了 / 时间到"三种结局在台账里长得一模一样（每轮记一次失败，
       * 3 轮后任务被误判成 blocked）。`text()` 渲染器优先用 `text`，模型看到的也更清爽。 */
      return { text: lines.join('\n') }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_task',
    description: '长活儿进度台账（挖 4 个以上自动开），存记忆根 tasks.json，掉线重连都还在。\n'
      + '`run` 一轮推进一步；`resume` 复核；`plan`/`step` 记账。',
    parameters: {
      action: { type: 'string', description: 'list（默认）| run | get | resume | note | done | cancel | forget | plan | step' },
      taskId: { type: 'string', description: '任务 id（默认最近一件）' },
      text: { type: 'string', description: 'note 的话 / step 原因' },
      all: { type: 'boolean', description: 'list 含已完成' },
      limit: { type: 'number', description: 'list 条数 / run 步数上限' },
      step: { type: 'string', description: '步骤 id（默认当前）' },
      status: { type: 'string', description: 'done（默认）| running | failed | skipped | pending（放回没做）' },
      /* 🟡 2026-10-15 审计（报告 H 第 8 条）：这里原来写 `items: { type: 'string' }`，
       *    但注入文案与 `src/task-runner.mjs:113 normSteps()` 都认**对象**
       *    （`[{id:"挖木头", op:"mc_dig", args:{name:"oak_log"}}, …]`）⇒ 模型照文案传对象会被
       *    宿主的参数校验直接拒掉。与 `mc_sequence` 的 `steps` 保持同一种写法。 */
      steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '步骤表：[{id:"…", op:"mc_dig", args:{…}}, …]（也认纯字符串 id）' },
      force: { type: 'boolean', description: 'run 强行继续' },
      budgetMs: { type: 'number', description: 'run 每轮预算毫秒（默认 8000）' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const action = String(args.action ?? 'list').toLowerCase()
      const id = args.taskId ? String(args.taskId) : null
      const bot = sess.bot
      const lines = []
      if (action === 'get') {
        const t = bot.taskGet({ taskId: id })
        if (!t) return { text: '📋 没有这个任务（`mc_task {action:"list"}` 看看在做的是哪些）' }
        lines.push(t.line)
        for (const s of t.steps ?? []) lines.push(`  ${s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'running' ? '▶' : s.status === 'skipped' ? '⏭' : '·'} ${s.id}${s.attempts ? `（试过 ${s.attempts} 次）` : ''}`)
        if (t.checkpoint) lines.push(`上次现场：${JSON.stringify(t.checkpoint)}`)
        if (t.lastError) lines.push(`上次卡在：${t.lastError.kind} —— ${t.lastError.reason ?? ''}`)
        if (t.loopDetected) lines.push(`⚠️ 同一个动作连着失败 ${t.loopDetected.count} 次 —— 别再原地重试，换个办法或取消`)
        for (const h of t.history ?? []) lines.push(`  · ${new Date(h.at).toTimeString().slice(0, 8)} ${h.text}`)
        return { text: lines.join('\n') }
      }
      if (action === 'plan') {
        const r = bot.taskPlan({ taskId: id, steps: Array.isArray(args.steps) ? args.steps : null })
        if (!r?.ok) return { text: `📋 ${r?.reason ?? '没做成'}` }
        const t = r.task
        lines.push(`📋 ${t.taskId} · ${t.goal}${r.wrote ? '（步骤表已重写）' : ''}`)
        if (t.step) lines.push(`现在：${t.step}`)
        for (const s of t.steps ?? []) lines.push(`  ${s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'running' ? '▶' : s.status === 'skipped' ? '⏭' : '·'} ${s.id}${s.attempts ? `（试过 ${s.attempts} 次）` : ''}${s.note ? ` · ${s.note}` : ''}`)
        return { text: lines.join('\n') }
      }
      if (action === 'step') {
        const r = bot.taskStep({
          taskId: id,
          step: args.step ? String(args.step) : null,
          status: args.status ? String(args.status) : 'done',
          why: args.text ? String(args.text) : null,
        })
        if (!r?.ok) return { text: `📋 ${r?.reason ?? '没做成'}` }
        const t = r.task
        const tail = r.exhausted
          ? `\n⚠️ 这一步试了 ${r.attempts}/${r.max} 次都没成 —— 任务标成"卡住了"，别再原地重试，换个办法或问玩家`
          : ''
        return { text: `📋 ${t.step}${r.next ? ` ⇒ 下一步 ${r.next}` : ''}${tail}` }
      }
      if (action === 'run') {
        /* 任务执行器（2026-10-14 "任务驱动"第二步）：**一轮只推进一个可验证的步骤**。
         * 预算夹在"本轮还剩多少"以内 —— 宁可少推一步带着进度返回，也不要把这次调用挂住。 */
        const left = Math.max(0, Number(bot.msLeft?.() ?? 0))
        /* 🔴 审计 F7：原来是 `Math.max(1000, Math.min(args.budgetMs || 8000, left - 900))` ——
         * 先 min 再 max ⇒ `left < 1900` 时外层那个 1000 下限又把它**抬回去**，
         * 本轮只剩 0ms 也硬跑 1000ms（注释说的"夹在本轮剩余以内"根本不成立）。
         * 现在：剩余不足 1000ms 就直接如实说没时间了，别硬开一轮。 */
        if (left < 1000) {
          return { text: `⏳ 这一轮没时间了（只剩 ${Math.round(left)}ms）—— 等下一轮再 mc_task {action:"run"}` }
        }
        const budgetMs = Math.min(Math.max(500, Number(args.budgetMs) || 8000), left - 900)
        const r = await bot.taskRun({
          taskId: id,
          budgetMs,
          maxRounds: args.limit ?? null,
          force: Boolean(args.force),
          signal: exec?.signal ?? null,
          call: async (tool, targs) => {
            if (tool === 'mc_task') return { error: '任务执行器不能再调 mc_task' }
            const h = TOOL_HANDLERS.get(tool)
            if (!h) return { error: `没有 ${tool} 这个工具` }
            try {
              return await h(targs, exec)
            } catch (e) {
              return { error: String(e?.message ?? e) }
            }
          },
        })
        return { text: runText(r) }
      }
      if (action === 'resume') {
        const r = bot.taskResume({ taskId: id })
        if (!r?.ok) return { text: `📋 没有可恢复的任务（${r?.reason ?? '现在没有在做的事'}）。要开一件：直接 mc_dig {count:16} 这类"一次干一批"的调用，会自动开工。` }
        const t = r.task
        lines.push(`📋 ${t.taskId} · ${t.kind} · ${t.goal ?? ''} · ${t.status}`)
        if (r.revived) lines.push(`▶️ 从「${r.wasStatus}」拉回「进行中」—— 可以接着做了`)
        if (r.step) lines.push(`步骤：${r.step}${r.stepAttempts ? `（当前这步试过 ${r.stepAttempts} 次）` : ''}`)
        lines.push(`现场复核：${r.verified ? `背包里有 ${r.have} 个，还差 ${r.need} 个` : `复核不了（${r.verifyNote ?? '读不到背包'}）`}`)
        lines.push(`下一步：${r.next} —— ${r.hint}`)
        if (r.action) lines.push(`现在就可以调：\`${r.action.tool}\` ${JSON.stringify(r.action.args)}`)
        if (t.loopDetected) lines.push(`⚠️ 之前同一个动作连着失败 ${t.loopDetected.count} 次 —— 别再用同样的参数重试`)
        return { text: lines.join('\n') }
      }
      if (action === 'note') {
        const t = bot.taskNote({ taskId: id, text: String(args.text ?? '') })
        return { text: t ? `📋 记下了：${t.taskId} · ${t.progress.done}/${t.progress.total ?? '?'}` : '📋 没有活跃任务可记' }
      }
      if (action === 'done') {
        const t = bot.taskDone({ taskId: id, note: args.text ? String(args.text) : null })
        return { text: t ? `📋 收工：${t.taskId}（${t.progress.done}${t.progress.unit ?? '个'}）` : '📋 没有活跃任务' }
      }
      if (action === 'cancel') {
        // 🔴 先让底下那件事停下（停寻路 / 停采集 / 松控制位）再改状态 ——
        //    反过来的话任务说"已取消"，机器人还在挖，下一个动作就会跟它抢控制位。
        const t = await bot.taskRunCancel({ taskId: id, reason: args.text ? String(args.text) : '模型取消' })
        return { text: t ? `📋 取消：${t.taskId}（底下那件事也停了）` : '📋 没有活跃任务' }
      }
      if (action === 'forget') {
        const n = bot.taskForget({ taskId: id })
        return { text: n ? '📋 删掉了' : '📋 没有这个任务' }
      }
      const list = bot.taskList({ limit: args.limit ?? 10, all: Boolean(args.all) })
      if (!list.length) {
        return { text: '📋 现在没有在做的事。要开一件：直接 `mc_dig {count:16}` 这类"一次干一批"的调用，会自动开工并记账。' }
      }
      for (const t of list) lines.push(`· ${t.line}`)
      return { text: lines.join('\n') }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_command',
    description: '以玩家身份执行服务器指令。**白名单可配置**（默认 tp/give/time/weather/say/gamemode/effect/'
      + 'setblock/fill/clone/summon/title/clear/xp）。要放行别的指令，在**普通会话**里用 `mc_admin_config` 改 '
      + '`commandWhitelist`（MC 模式会话改不了）。\n'
      + '· **可以一次给多条**（一行一条）—— 会**逐条**发出去，间隔 120ms，避免被服务端判成刷屏。\n'
      + '· 🔴 一行只放一条指令：把多条塞成一行、或者用换行以外的怪字符，都会被服务端以 '
      + '`illegal_characters` 踢下线（2026-10-19 实机踩过）。\n'
      + '⚠️ 这是**最后手段**：正经动作优先 `mc_act` / `mc_build` / `mc_move`（那些不需要 OP）。',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: '以 / 开头的完整指令；要发多条就一行一条（最多 32 条）',
      },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      /* 🔴 多行 = 多条：逐条发。为什么不能拼成一个包一起发 —— 换行符会让服务端踢人
       *    （`multiplayer.disconnect.illegal_characters`，2026-10-19 实机：10 条 /fill 拼成一个包
       *    发出去，人当场掉线）。拆分与格式校验在 `splitCommands()`（src/commands.mjs，有单测）。 */
      const lines = splitCommands(args.command, { max: MAX_COMMANDS_PER_CALL })
      /* 先把**每一条**都验一遍再发：不然前 20 条已经生效、第 21 条被拒，世界就只改了一半 */
      const names = []
      for (const [i, line] of lines.entries()) {
        const name = commandNameOf(line)
        if (!pluginConfig.commandAllowed(name)) {
          throw new Error(`第 ${i + 1} 条 /${name} 不在白名单里。当前白名单：${JSON.stringify(pluginConfig.get('commandWhitelist'))}`
            + '（要放行请在普通会话里用 mc_admin_config 改 commandWhitelist）')
        }
        names.push(name)
      }
      const sent = []
      for (const [i, line] of lines.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 120))
        sent.push(sess.bot.command(line, { allow: (n) => pluginConfig.commandAllowed(n) }))
      }
      /* 🔴 会挪人的指令（`tp`/`spreadplayers`/`execute`）发完就打断在飞的移动：
       *    真正改变位置的是服务端，占着 `movement` 资源没用（发包只要几微秒），
       *    但**正在跑的 mc_move 并不知道自己被挪走了** —— 它只会继续朝旧目标走，
       *    最后报"走不到"，让模型以为是路不通。推一次移动代次，它就会如实说"被挪走了"。 */
      if (names.some((n) => COMMANDS_THAT_MOVE_ME.has(n))) {
        const how = names.length > 1 ? `服务器指令（${[...new Set(names)].join('/')}）把我挪走了` : `服务器指令 /${names[0]} 把我挪走了`
        try { await sess.bot.interruptMove(how) } catch { /* 没在动就算了 */ }
      }
      if (sent.length === 1) return { sent: sent[0] }
      return { sent: `共 ${sent.length} 条`, commands: sent, count: sent.length }
    },
  }))

  /* ── 图像：SVG 为编辑语言（写/引图/光栅化/保存）──
   * 用户的思路：SVG 是文本，AI 本来就会写——拼网格/画框/加文字（含中文）都在 SVG 里表达，
   * 我们只补它做不到的两件事：**把外部图片塞进 SVG**（embed）和 **SVG→PNG**（render）。
   *
   * 🔴 2026-09-16：**删掉了 mc_kit_share**（以及 mc_map 的 share 参数）。原因：它不是"我们实现的
   *    上传"，而是去调宿主实例里另装的 `dsh-file-host`（`/serve/file-host/api/upload`）——
   *    插件本身没有文件服务器，开源出去别人也没有那个条目，等于提供一个"看着能用、实际 404"的工具。
   *    要"让本地用户看到文件"，DSH 自带的正路是 **`present`**（`deliverables/presented` → Web 的
   *    产出文件卡片：可预览、可打开；正文里写行内代码的文件名也会变成可点链接）。
   *    所以现在只负责**把图落到工作区**，交付交给 `present`。
   * ------------------------------------------------------------------------ */

  /** 把用户给的路径解析到**这个会话的工作区**内（不许越界） */
  const insideWorkspace = (raw, agent) => {
    const root = workspaceRootFor(agent)
    const abs = resolve(root, String(raw ?? '').trim())
    const prefix = root.endsWith(sep) ? root : root + sep
    if (abs !== root && !abs.startsWith(prefix)) {
      throw new Error(`路径必须在工作区内（${root}）`)
    }
    return abs
  }

  ctx.tools.register(asTool({
    name: 'mc_kit_image',
    description: '图像能力。**SVG 是编辑语言**：布局/画矩形框/加文字（含中文）/拼网格，'
      + '都可以直接写 SVG 文本（用 write 存成 .svg），再用这个工具光栅化成 PNG。\n'
      + 'action：\n'
      + '· info    看一张图的尺寸/格式（也能确认文件到底是不是能用的图）\n'
      + '· embed   把图片变成 data URI + 现成的 `<image>` 标签 —— **往 SVG 里引入图片必须这么做**\n'
      + '· render  SVG → PNG（可给 width/height/scale；svg 文本或 svgPath 二选一）\n'
      + '· grid    把多张图按网格拼成**可继续编辑的 SVG 文本**（省掉重复写 N 个 <image> 和算坐标）\n'
      + '· save    把 SVG 文本或 PNG 字节落盘\n'
      + `输出默认落在记忆根下的 ${OUT_DIR}（**不对外**）。要给用户看就把 \`out\` 写成`
      + `\`.dsh-mc-agent/${EXPRESS_DIR}/<子目录>/x.png\`（按**记忆根**解析，不是工作区），再用 \`mc_kit_express\` 取那一行。`,
    parameters: {
      action: { type: 'string', description: 'info / embed / render / grid / save' },
      path: { type: 'string', description: '输入文件（info/embed 用）' },
      out: { type: 'string', description: '输出路径（render/save 用）' },
      svg: { type: 'string', description: 'render：SVG 文本' },
      svgPath: { type: 'string', description: 'render：SVG 文件路径' },
      width: { type: 'number', description: 'render：目标宽' },
      height: { type: 'number', description: 'render：目标高' },
      scale: { type: 'number', description: 'render：倍率（2=两倍清晰度）' },
      paths: { type: 'array', items: { type: 'string' }, description: 'grid：要拼的图片路径（按顺序）' },
      cols: { type: 'number', description: 'grid：列数（默认自动）' },
      cell: { type: 'number', description: 'grid：每格最长边（默认 256）' },
      gap: { type: 'number', description: 'grid：格子间距（默认 8）' },
      labels: { type: 'array', items: { type: 'string' }, description: 'grid：每格标签（可中文）' },
      title: { type: 'string', description: 'grid：整图标题' },
      x: { type: 'number' }, y: { type: 'number' },
    },
    output: text(),
    timeoutMs: 120_000,
    async execute(args, exec) {
      const inWs = (p) => insideWorkspace(p, exec?.agent)
      if (!ImageEngine.available()) {
        throw new Error(`图像引擎不可用：${imageEngineError() ?? 'sharp 未解析到'}`)
      }
      const action = String(args.action ?? '').toLowerCase()
      /**
       * 输出路径。默认落在**记忆夹的 `.out/`**（`.dsh-mc-agent/.out/`，**不对外**）。
       *
       * 🔴 用户 2026-09-16 定的**发布模型**：
       *    · `.out/` = 默认输出，**谁都访问不到**；
       *    · `.express/` = **发布区**，放进去的文件可通过
       *      `GET /api/mc/dsh-mc-agent/<工作区目录名>/<剩余路径>` 访问 —— 要给用户看就显式写进这里，
       *      再用专用工具 `mc_kit_express` 换回那行路径，自己拼 markdown。
       */
      const memRoot = memoryRootFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent))
      const outDir = outRootOf(memRoot)
      /* 🔴 2026-10-19 实机踩到（真 bug）：原来的 `needOut` 恒用 `inWs(args.out)` —— 而发布区在
       * **记忆根**下（`memoryRootFor(...)/.express/`），根本不在工作区里 ⇒ 写
       * `out: ".dsh-mc-agent/.express/x.png"` 会**成功落到工作区**，然后 `mc_kit_express`
       * 说"这个文件不在发布区里"。修法：绝对路径照用；`.dsh-mc-agent/...` 这种老写法按
       * **记忆根**解析（和 `mc_map` / `mc_observe` 的 out 一致）；其余仍走工作区校验。 */
      const MEM_PREFIX = /^\.dsh-mc-agent[\\/]/i
      const needOut = (name) => {
        if (!args.out) return join(outDir, name)
        const raw = String(args.out)
        if (isAbsolute(raw)) return resolve(raw)
        if (MEM_PREFIX.test(raw)) return resolve(memRoot, raw.replace(MEM_PREFIX, ''))
        return inWs(raw)
      }
      /* 🔴 用户 2026-09-16：结果里**不再**塞任何 express 字段（'不要乱给已有工具加'）——取路径统一走 mc_kit_express。 */

      switch (action) {
        case 'info': {
          const p = inWs(args.path)
          return await ImageEngine.info(p)
        }

        case 'embed': {
          const r = await ImageEngine.embed(inWs(args.path), {
            asTag: true, x: args.x ?? 0, y: args.y ?? 0, width: args.width, height: args.height,
          })
          // data URI 很长，别原样刷屏：给长度 + 现成标签 + 用法
          /* 输出瘦身：bytes/dataUriLength 是排查用的，AI 只需要"存哪了、是什么"。 */
          return { file: r.file, mime: r.mime, tag: r.tag, note: r.note }
        }

        case 'render': {
          if (!args.svg && !args.svgPath) throw new Error('render 需要 svg 文本或 svgPath')
          const r = await ImageEngine.render({
            svg: args.svg ?? null,
            svgPath: args.svgPath ? inWs(args.svgPath) : null,
            width: args.width, height: args.height, scale: args.scale,
          })
          const out = needOut('mc-image.png')
          const saved = ImageEngine.save(out, r.png)
          return { rendered: `${r.width}x${r.height}`, ...saved }
        }

        case 'grid': {
          const r = await ImageEngine.grid({
            paths: (args.paths ?? []).map((p) => inWs(p)),
            cols: args.cols, cell: args.cell, gap: args.gap,
            labels: args.labels, title: args.title,
          })
          const out = needOut('mc-grid.svg')
          ImageEngine.save(out, r.svg)
          return {
            svg: `${r.width}x${r.height}`, cells: r.cells, layout: `${r.cols}x${r.rows}`,
            file: out,
            note: '这是**可继续编辑的 SVG 文本**：想加标注就改这个文件（画 <rect stroke>、加 <text>），'
              + '再 mc_kit_image{action:"render"} 光栅化成 PNG。',
          }
        }

        case 'save': {
          if (!args.svg && !args.path) throw new Error('save 需要 svg（文本）或 path（要复制的文件）')
          const out = needOut('mc-image.svg')
          if (args.svg) return { ...ImageEngine.save(out, String(args.svg)), kind: 'svg' }
          const src = inWs(args.path)
          const { readFileSync } = await import('node:fs')
          return { ...ImageEngine.save(out, readFileSync(src)), kind: 'copy', from: src }
        }

        default:
          throw new Error(`未知 action："${action}"（可用 info/embed/render/grid/save）`)
      }
    },
  }))

  /**
   * 发布区取链接：**唯一**的"把文件端给用户"的入口（用户 2026-09-16 定）。
   *
   * 只做一件事：把 `.dsh-mc-agent/.express/` 下的文件换成**给用户用的那一行**，
   * 剩下的 markdown 由 AI 自己拼（`![名](url)` / `[名](url)`）——不再往别的工具返回值里塞字段。
   *
   * 🔴 **回什么由「文件分享」开关决定**（用户 2026-09-17 定、2026-10-04 从模式改为开关，见 config.mjs `expressEnabled`）：
   *   · 关（默认）→ 恒回一句"文件分享已关闭…"，服务也不开（AI 只能把绝对路径告诉用户）；
   *   · 开 → 回 `base + 相对路径` 的**完整 URL**，只有开启时才开服务。
   * 两种状态都仍然**只认发布区**（`.express/`）里的文件。
   */
  ctx.tools.register(asTool({
    name: 'mc_kit_express',
    description: '把**发布区**（**记忆根**下的 `.express/`，不是工作区里的 `.dsh-mc-agent/.express/`）里的文件换成"给用户的东西"。\n'
      + '· 入参：`path` —— 发布区下的文件（相对按**记忆根**解析，`.express/x.png` 与 `.dsh-mc-agent/.express/x.png` 都认；绝对照用）；\n'
      + '· 返回**一行**，看「MC设置 → 文件分享」开没开：\n'
      + '  · 关（默认）：只回"文件分享已关闭…"——把**绝对路径**告诉用户自己打开；\n'
      + '  · 开：回**完整 URL**——图片 `![名](url)`、其它 `[名](url)` 嵌进回复里；\n'
      + '· 链接**原样使用**，别补 `http://…` 或域名。\n'
      + '⚠️ 只有**记忆根/.express/** 可分享；记忆根/.out/ **不对外**。',
    parameters: {
      path: { type: 'string', required: true, description: '发布区（记忆根/.express/）里的文件；相对按记忆根解析' },
    },
    output: {
      schema: { type: 'object', properties: { url: { type: 'string' }, enabled: { type: 'boolean' } }, additionalProperties: true },
      // **只把那一行给模型**（用户："输出纯路径，让 AI 自己拼接 md"）
      render: (_args, value) => [{ type: 'text', text: String(value?.url ?? '') }],
    },
    async execute(args, exec) {
      const cwd = workspaceOf(exec?.agent)
      const memRoot = memoryRootFor(cwd, agentIdOf(exec?.agent))
      const raw = String(args.path ?? '').trim()
      if (!raw) throw new Error('path 不能为空')
      // 解析顺序：绝对路径照用；相对路径先按**记忆根**试（`.express/x.png` 这种写法最常见），
      // 再按"记忆根 + 去掉 `.dsh-mc-agent/` 前缀"试（🔴 2026-10-06 本机补丁：记忆根被
      // `config.memoryDir` 挪出工作区之后，老写法 `.dsh-mc-agent/.express/x.png` 也要能命中），
      // 最后按**工作区**试。都不存在才算文件不存在。
      const memPrefix = /^\.dsh-mc-agent[\\/]/i
      const candidates = isAbsolute(raw)
        ? [resolve(raw)]
        : [resolve(memRoot, raw), resolve(memRoot, raw.replace(memPrefix, '')), resolve(cwd ?? memRoot, raw)]
      const abs = candidates.find((p) => { try { return statSync(p).isFile() } catch { return false } })
      if (!abs) {
        throw new Error(`找不到这个文件：${raw}（试过：${candidates.join(' / ')}）`)
      }
      // 🔴 地址里的"工作区指代"= **工作区 uuid**（`workspaceRegistry` 的 id）。
      //    用户定的兜底是 (a) 拒绝：这个 cwd 在注册表里查不到就直接报错，不退回目录名。
      const wsId = workspaceIdOfCwd(cwd)
      if (!wsId) {
        throw new Error('这个会话的工作区不在 DSH 的工作区注册表里，拿不到分享地址（不退回目录名）。'
          + '请让用户在工作区选择器里选中该目录（或用它新建/打开一个会话）后再试。')
      }
      const ref = expressRefFor(abs, memRoot, wsId)
      if (!ref) {
        throw new Error('这个文件不在发布区里，所以没有可分享的地址。'
          + `\n发布区是：${expressRootOf(memRoot)}`
          + `\n请先把它放到记忆根下的 ${EXPRESS_DIR}/<子目录>/（mc_kit_image / mc_map / mc_observe 的 out 写成`
          + ` ".dsh-mc-agent/${EXPRESS_DIR}/<子目录>/x.png" 会自动落到记忆根下；已有文件用`
          + ' mc_kit_memory {action:"put", path:".express/<子目录>/x.png"} 复制过去），再来取。')
      }
      const enabled = pluginConfig.expressEnabled
      // 关闭（默认）：恒回那一句（**不抛错** —— 让 AI 直接把话转达用户，而不是去试别的歪招）
      if (!enabled) return { enabled: false, url: EXPRESS_OFF_TEXT, rel: ref.rel, abs: abs }
      // 开启：base + 相对路径；base 还没配就把"让用户去设置"这句话交给 AI
      const url = onlineUrlOf(pluginConfig.expressBase, ref.url)
      if (!url) return { enabled: true, url: EXPRESS_NEED_BASE_TEXT, rel: ref.rel }
      return { enabled: true, url, rel: ref.rel }
    },
  }))

  /* ── 长期记忆（游戏外通用能力，所以叫 mc_kit_ 不叫 mc_）──
   * 固定 <工作区>/.dsh-mc-agent/：AI 维护 README.md 索引，按服务器建子文件夹，
   * 任意格式文件可读写（含图片），**不执行任何东西**。
   * ------------------------------------------------------------------------ */

  ctx.tools.register(asTool({
    name: 'mc_kit_memory',
    description: '长期记忆（跨会话、重启后还在），放 `.dsh-mc-agent/`，按服务器建子文件夹（`_global/` 放通用的）。\n'
      + '**索引自己维护** `README.md`（插件每轮注入它的内容 + 目录树，改了记忆顺手更新它）。\n'
      + 'action：`index`（默认）总览 ｜ `kinds` 四类记忆说明 ｜ `search` 跨文件搜关键词 ｜ '
      + '`record` 记一条**带元数据**的（推荐）：kind+key+text+from+version+ok，同 key 再记累加成功/失败，`ok:false` 必须给 `condition` ｜ '
      + '`read` 读文件（path 或 topic+server；读图片会作为附件给你）｜ `append` 追加（同 key 覆盖，只对文本）｜ '
      + '`write` 整文件覆盖 ｜ `put` 把工作区任意文件（图片最常用）复制进记忆 ｜ `delete` 删文件（目录则整目录删）。\n'
      + '路径写法：`path:"mc.example.com/maps/town.png"` 或 `topic:"landmarks"`（server 默认当前服，不传写进 `_global/`）。\n'
      + '⚠️ 只读写文件，不执行任何东西（没有 shell、不跑脚本）。',
    parameters: {
      action: { type: 'string', description: 'index（默认）/ kinds / record / read / append / write / put / delete / search' },
      kind: { type: 'string', description: 'record：world/exp/task/rule（世界事实/操作经验/任务记录/用户规则，后者只读）' },
      key: { type: 'string', description: 'record/append：这条记忆的名字（同 key 累加或覆盖）' },
      text: { type: 'string', description: 'record/append 的内容（一句话）' },
      source: { type: 'string', description: 'put：要存入记忆的文件路径（工作区内；图片最常用）' },
      from: { type: 'string', description: 'record：从哪来的（mc_observe / 用户说的 / 实测）' },
      version: { type: 'string', description: 'record：适用版本（如 1.21.9；跨版本通用就不填）' },
      ok: { type: 'boolean', description: 'record：成功 true / 失败 false；只记事实不填' },
      condition: { type: 'string', description: 'record：**失败必须填**——什么情况下失败（别写"永久不可达"）' },
      path: { type: 'string', description: '相对路径，如 mc.example.com/landmarks.md' },
      topic: { type: 'string', description: '主题名（拼成 <server>/<topic>.md）' },
      server: { type: 'string', description: '服务器文件夹；默认当前服，不传 _global' },
      content: { type: 'string', description: 'write 的完整内容' },
      name: { type: 'string', description: 'put：存进去的名字（缺省用原名）' },
      query: { type: 'string', description: 'search 的关键词' },
      limit: { type: 'number', description: 'search 最多几条（默认 12，上限 100；每条超 160 字截断）；index+group 时最多列几个文件（默认 40）' },
      group: { type: 'string', description: 'index：只看这一组（组名来自默认摘要，如 mc.example.com / (通用)）' },
      verbose: { type: 'boolean', description: 'index：true = 全量文件清单 + README 全文（很费 token，只在真要找东西时用）' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }]
        // read 到图片时把它作为附件带出去 —— 这样模型**能直接看到**存下来的图
        if (value?.attachment) blocks.push({ type: 'image', attachment: value.attachment })
        return blocks
      },
    },
    async execute(args, exec) {
      const mem = memoryFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent))
      const action = String(args.action ?? 'index').toLowerCase()
      if (action === 'index') {
        /* 返回瘦身（用户 2026-10-23）：默认只给分组摘要；group 看一组；verbose 才给全量 */
        return mem.overview({
          brief: args?.verbose !== true,
          group: args?.group ?? null,
          limit: args?.limit ?? 40,
        })
      }
      if (action === 'kinds') return mem.kinds()

      // put：把工作区里的源文件复制进记忆（图片最常用；任何格式都行）
      if (action === 'put') {
        const src = insideWorkspace(args.source, exec?.agent)
        let server = args.server
        if (server === undefined && args.path === undefined) {
          const sess = getSession(exec)
          server = sess.bot.sub ?? null
        }
        return mem.put({ source: src, name: args.name, path: args.path, server })
      }

      // 只在"没显式给 server 且没给 path"时，才用当前所在服兜底
      let server = args.server
      if (server === undefined && args.path === undefined) {
        const sess = getSession(exec)
        server = sess.bot.sub ?? null      // 不在线 → null → 落进 _global
      }

      const sel = { path: args.path, topic: args.topic, server }
      switch (action) {
        case 'read': {
          const r = mem.read(sel)
          // 读的是图片 → 顺手做成附件，render 会把它当 image 块发出去（模型就能看到）
          if (r.kind === 'image') {
            const att = ctx.get('attachments')
            if (att && typeof att.saveImage === 'function') {
              try {
                const { readFileSync } = await import('node:fs')
                r.attachment = await att.saveImage({
                  data: new Uint8Array(readFileSync(r.file)),
                  mediaType: r.mediaType ?? 'image/png',
                  name: r.path.split('/').pop(),
                })
              } catch (e) { r.attachmentError = e.message }
            } else {
              r.attachmentError = '宿主没有 attachments 服务'
            }
          }
          return r
        }
        case 'record': return mem.record({
          kind: args.kind, key: args.key, text: args.text, source: args.from,
          version: args.version, ok: args.ok, condition: args.condition, server,
        })
        case 'append': return mem.append({ ...sel, text: args.text, key: args.key })
        case 'write':  return mem.write({ ...sel, content: args.content })
        case 'delete': return mem.delete(sel)
        case 'search': return mem.search({ query: args.query, limit: args.limit })
        default: throw new Error(`未知 action："${action}"（可用 index/kinds/record/read/append/write/put/delete/search）`)
      }
    },
  }))
  /* ── 提示词注入 / 通知台账 / 记忆根播种 ──
   * 🔴 这一大块（原来就在这儿、约 666 行）2026-10-20 搬去了 `src/inject.mjs`，
   *    调用点在下面"MC 模式判据"之后（那里才拿得到 isMcModeAgent 等依赖）。
   *    这里只留个指路牌，别再往这儿写注入/台账的逻辑。
   * ------------------------------------------------------------------------ */

  const ensureMemoryRoot = (agent) => ensureMemoryRootForCwd(workspaceOf(agent), noteAgent(agent))

  /* ─────────── MC 模式：权限隔离 + 专属指导（用户 2026-09-16 要求）───────────
   * 判定"是不是 MC 模式"：`agentPresets.composedPreset(agent.ctx)` 落在配置的
   * `mcModePresets` 里。然后做三件事：
   *   ① 工具可见性：对这个 agent 挂 `tools.restrict`（隐藏 mc_admin_*，以及配置的白/黑名单）
   *   ② 工具执行：注册**全局 guard** 硬拒 mc_admin_*（即使隐藏失效也调不动）
   *   ③ 提示词：注入 dsh-mc-agent 专属指导（宿主的 AGENTS.md 注入之外，另加这一段）
   * ------------------------------------------------------------------------ */

  /** 自动创建 preset 时的显示名（preset.yml 里的 `name:`） */
  const MC_PRESET_NAME = 'MC模式'
  /**
   * 自动建出来的 preset 的简介。
   * 🔴 用户 2026-09-16 报："MC 模式的简介变成了和极简模式一样"——
   *    因为官方 `copy()` **只改 name、保留源 preset 的 description**（`copyComposition` 里的注释写得很清楚）。
   *    所以复制完必须把**元数据**改回来（`preset.yml` 是显示文本，不是 composition，可以自己写）。
   */
  const MC_PRESET_DESCRIPTION = '可以加入Minecraft Java版服务器，模拟玩家进行交互。'

  /** `~` 开头的 preset 根展开成绝对路径（宿主的 root 配置允许写 `~`） */
  /**
   * 自动建出来的 preset 的**人设**（persona）。
   *
   * 🔴 用户给的**定稿原文**（2026-09-16，一个字都不许改）：
   *    "你在一台真实的 Minecraft Java 版服务器里扮演一名玩家：你的"身体"是一台无头机器人，
   *     能观察世界、移动、挖掘和建造。"
   *
   * 从前那句 "You are a helpful software engineer assistant." 来自我们复制的官方 `minimal`。
   * 这里只写**身份 + 能力**；规矩（称呼/记忆/看门狗/指令/边界）全在 `.dsh-mc-agent/RULES.md`，不重复。
   * 系统提示词**由宿主按这个 preset 自动注入**，插件不再自己往 systemPrompt 里塞（用户要求）。
   */
  const MC_PERSONA_TEXT = '你在一台真实的 Minecraft Java 版服务器里扮演一名玩家：你的"身体"是一台无头机器人，能观察世界、移动、挖掘和建造。'

  /**
   * 「MC+模式」的补充说明（随版本硬编码、无开关；**只投给 MC+ 会话**，见 `reconcileNotices`）。
   *
   * MC+ = MC 模式基础上开放**标准模式全部工具**（用户 2026-10-04 定）。规矩（RULES.md）、
   * 版本提示、记忆索引照常注入；这条只把"这个模式多什么、少什么"讲清楚，免得 AI 以为自己
   * 还在受限模式里（或反过来乱用 mc 工具）。
   */
  const MC_PLUS_NOTICE_TEXT = [
    '【MC+ 模式】本会话在 MC 模式的基础上，开放了**标准模式的全部工具**：',
    '',
    '· 标准工具可用：shell（pwsh/bash）、文件搜索、子代理 / 工作流、计划模式、网络访问、技能等；',
    '· 文件工具（read / write / edit / glob / grep / read_image）可在**整个工作区**内使用，不受 `.dsh-mc-agent/` 限制；',
    '· `mc_*` / `mc_kit_*` 工具与 MC 模式完全一致：记忆仍写入 `.dsh-mc-agent/`，凭据相关路径依旧不可触碰；',
    '· 行事准则（`.dsh-mc-agent/RULES.md`）与看门狗与 MC 模式相同；管理工具 `mc_admin_*` 对本模式可见。',
    '适合"不局限于游戏内"的任务与定制要求——但游戏内的事，仍然优先用 MC 工具与游戏内交流来办。',
  ].join('\n')

  const expandHome = (p) => {
    const s = String(p ?? '')
    return s.startsWith('~') ? join(homedir(), s.slice(1).replace(/^[/\\]+/, '')) : s
  }

  /** 只有**我们建的**那份才修：persona 键名对不对（以"本版本源 preset"为标尺） */
  const repairPersonaKeyIfNeeded = (svc, id, { composition, sourceKey, mine, stillComplete }) => {
    const mineKey = personaTextKeyOf(composition)
    if (!mine || composition === null) return false
    if (!((sourceKey && mineKey !== sourceKey) || stillComplete)) return false
    const fixed = patchMcPresetComposition(svc, id, { key: sourceKey ?? null })
    logLine(fixed
      ? `MC 模式 preset「${id}」persona 键名与本版本不符（${mineKey ?? '认不出'} → ${sourceKey ?? '跟随文件'}${stillComplete ? '，且 complete 还是 true' : ''}）→ 已自动修正`
      : `MC 模式 preset「${id}」persona 键名需要修正，但这次没改成（下次启动再试；必要时手动编辑 agent.cordis.yml）`)
    return fixed
  }

  /**
   * 复制完官方 preset 之后，把**我们自己的几处**覆盖上去：
   *   ① persona（官方那句 "You are a helpful software engineer assistant." + `complete: true` 都不要）
   *   ② 关掉那个持久 shell（MC 模式的指导写着"本模式没有 shell"，两边必须一致）
   *   ③ 补齐 MC 模式需要的工具组（tool-fs / tool-jobs / present）—— 官方 `minimal` 里一个都没有
   * @param {string} id 目标 preset
   * @param {{key?: 'prefix'|'text'|null}} [opts] `key` = **本版本源 preset 用的那个键**（新版 prefix / 老版 text）
   * @returns {boolean} 是否改动过（false = 结构不认识 / 无需改动，日志里说明）
   */
  const patchMcPresetComposition = (svc, id, opts = {}) => {
    try {
      const dir = mcPresetDir(svc, id)
      if (!dir) return false
      const p = join(dir, 'agent.cordis.yml')
      if (!existsSync(p)) return false
      const cur = readFileSync(p, 'utf8')
      const withPersona = patchPersonaInComposition(cur, MC_PERSONA_TEXT, opts)
      if (withPersona === null) { logLine('MC 模式 preset：composition 里没找到可用的 persona 段 → 保持原样（人设还是官方那句）'); return false }
      let finalText = disableShellInComposition(withPersona) ?? withPersona
      finalText = patchToolGroupsIntoComposition(finalText, availableToolGroups()) ?? finalText
      if (finalText === cur) return false
      writeFileSync(p, finalText, 'utf8')
      return true
    } catch (e) { logLine(`改 preset 的 persona/shell/工具组失败（不影响挂载）：${e.message}`); return false }
  }

  /**
   * 这份部署里**能加载哪些** MC 模式需要的工具组？
   *
   * 为什么要探：这些包是按 preset 挂载的，"在不在"取决于 DSH 版本与随附 bundle。
   * 给一份**装不到某个包**的 preset 加组 = 让那份 preset 直接挂不起来（MC 模式整个坏掉）——
   * 比"少一个工具"糟得多。判据很直接：**随附的 preset 里有没有人引用它**
   * （随附 Web 的 standard/ptc/cordis 有 tool-fs/tool-jobs/present/压缩组，minimal 一个都没有）。
   *
   * 🔴 2026-09-24（GitHub issue #1，用户 huohai2 报）：**这里绝对不能用 `agentPresets.list()`**。
   *    宿主那个方法是 **`async list()`**（`agent-presets/src/index.ts`：`async list(): Promise<AgentPreset[]>`），
   *    在同步 `for...of` 里迭代一个 Promise 会抛 `TypeError: ... is not iterable`，
   *    被 `catch` 吞掉 ⇒ `shipped` 恒空 ⇒ **每一组都被判成"本部署没人引用"**，
   *    于是自动建出来的「MC模式」preset 一组工具都补不上（缺 tool-fs/tool-jobs/present
   *    与压缩组），而且**不报错**（只留一行看着很合理的日志）。
   *    这里改用**同步**的 `svc.roots`（宿主是同步 getter）自己扫：
   *    每个根下 `<root>/<presetId>/agent.cordis.yml`。
   */
  let availableGroups = null
  const availableToolGroups = () => {
    if (availableGroups) return availableGroups
    const shipped = []
    let scanned = 0
    try {
      const roots = Array.isArray(agentPresetsSvc?.roots) ? agentPresetsSvc.roots : []
      for (const root of roots) {
        const dir = root?.path ? expandHome(String(root.path)) : ''
        if (!dir) continue
        let entries = []
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }   // 根不存在/不可读：跳过这个根
        for (const ent of entries) {
          if (!ent?.isDirectory?.()) continue
          const p = join(dir, ent.name, 'agent.cordis.yml')
          try {
            if (!existsSync(p)) continue          // 目录占着 id 但组成缺失（宿主也认它是坏的）
            shipped.push(readFileSync(p, 'utf8'))
            scanned++
          } catch { /* 单个 preset 读不了不影响别的 */ }
        }
      }
    } catch (e) {
      // 探针自己坏了必须留痕：静默会让"判据失效"伪装成"确实没有"
      logLine(`探"本部署有哪些 preset 工具包"失败（按没有处理）：${e?.message ?? e}`)
    }
    if (!scanned) logLine('一个随附 preset 的组成都没扫到（roots 为空或不可读）→ 保守起见不往 MC 模式 preset 里加工具组')
    const all = shipped.join('\n')
    availableGroups = MC_PRESET_TOOL_GROUPS.filter((g) => all.includes(g.pkg))
    const missing = MC_PRESET_TOOL_GROUPS.filter((g) => !all.includes(g.pkg)).map((g) => g.pkg)
    if (missing.length) logLine(`这些工具包在本部署的 preset 里没人引用 → 不往 MC 模式 preset 里加：${missing.join(', ')}`)
    return availableGroups
  }

  /**
   * 给**已存在**的 preset 补工具组（用 `leave`/`meta` 分支时用；不动别的行）。
   *
   * 🔴 2026-09-24：这条路会动**用户自己写的** composition（本机那份 `minecraft` 就是用户手写的），
   *    所以：
   *      ① 动之前**留一份原始副本**（`agent.cordis.yml.bak-dsh-mc-agent`，只留第一次那一份，
   *         之后不覆盖 ⇒ 那份永远是"插件碰它之前"的样子，随时能翻回去）；
   *      ② 隔离实例里**一律不写**（`DSH_MC_AGENT_NO_PRESET_WRITE`）—— 隔离实例的 preset 根目录
   *         跟生产是**同一个**（`~/.dsh/.agent-presets`，redirect 不了），写下去就是改生产文件。
   *         2026-09-24 实测踩到：隔离实例第一次跑就把压缩组加进了用户手写的那份。
   */
  const ensureToolGroupsInPreset = (svc, id) => {
    try {
      const groups = availableToolGroups()
      if (!groups.length) return false
      const dir = mcPresetDir(svc, id)
      if (!dir) return false
      const p = join(dir, 'agent.cordis.yml')
      if (!existsSync(p)) return false
      const cur = readFileSync(p, 'utf8')
      const next = patchToolGroupsIntoComposition(cur, groups)
      if (next === null) return false
      if (process.env.DSH_MC_AGENT_NO_PRESET_WRITE) {
        logLine(`隔离模式（DSH_MC_AGENT_NO_PRESET_WRITE）：跳过改 preset「${id}」的 composition（本该补：${groups.filter((g) => !cur.includes(g.pkg)).map((g) => g.pkg).join(', ')}）`)
        return false
      }
      try {
        const bak = join(dir, 'agent.cordis.yml.bak-dsh-mc-agent')
        if (!existsSync(bak)) copyFileSync(p, bak)
      } catch { /* 备份失败不拦着修，但下面日志里会说 */ }
      writeFileSync(p, next, 'utf8')
      logLine(`已给 MC 模式 preset（${id}）补上工具组：${groups.filter((g) => !cur.includes(g.pkg)).map((g) => g.pkg).join(', ')}（原始副本：agent.cordis.yml.bak-dsh-mc-agent）`)
      return true
    } catch (e) { logLine(`补 preset 工具组失败（不影响挂载）：${e.message}`); return false }
  }

  /** preset 目录（用户可写根下那个），拿不到就 null */
  const mcPresetDir = (svc, id) => {
    try {
      const roots = Array.isArray(svc?.roots) ? svc.roots : []
      const userRoot = roots.find((r) => r?.trust === 'user')?.path
      return userRoot ? join(expandHome(userRoot), id) : null
    } catch { return null }
  }

  /** 读组成文本（`list()` 给的行里有 path = composition 文件） */
  const compositionOf = (row) => {
    try {
      const p = row?.path
      return p && existsSync(p) ? readFileSync(p, 'utf8') : null
    } catch { return null }
  }
  const hash16 = (s) => (s == null ? null : createHash('sha256').update(String(s)).digest('hex').slice(0, 16))

  /**
   * 把 `preset.yml`（显示名 / 简介 / 排序）写回去。
   * ⚠️ 只写**元数据**：composition（`agent.cordis.yml`）一根手指都不碰 ——
   *    官方 authoring 只允许"整目录复制"，但显示文本本来就是给人改的。
   */
  const writeMcPresetMetadata = (svc, id) => {
    try {
      const dir = mcPresetDir(svc, id)
      if (!dir || !existsSync(dir)) return false
      const body = [
        `name: ${JSON.stringify(MC_PRESET_NAME)}`,
        `description: ${JSON.stringify(MC_PRESET_DESCRIPTION)}`,
        'order: 5',
        '',
      ].join('\n')
      writeFileSync(join(dir, 'preset.yml'), body, 'utf8')
      return true
    } catch (e) { logLine(`写 preset 简介失败（不影响使用）：${e.message}`); return false }
  }

  /**
   * 我们的"自建标记"：写在 preset 目录里（dot 文件，宿主不认它是 preset 内容）。
   * 作用：**下次启动能认出自建的那份**，从而"检查不对就重建"；用户改过的一律不碰。
   * 文件名故意带 `.json` 与点前缀 —— preset id 规则 `/^[a-z0-9][a-z0-9-]*$/` 不含点，
   * 所以它在 discovery 眼里根本不是 preset 槽位。
   */
  const MC_PRESET_MARKER = '.dsh-mc-agent.json'
  const writeMcPresetMarker = (svc, id, { source, composition }) => {
    try {
      const dir = mcPresetDir(svc, id)
      if (!dir || !existsSync(dir)) return false
      writeFileSync(join(dir, MC_PRESET_MARKER), JSON.stringify({
        createdBy: 'dsh-mc-agent',
        spec: MC_PRESET_SPEC,
        at: new Date().toISOString(),
        source: source ?? null,
        compositionHash: hash16(composition),
        name: MC_PRESET_NAME,
        description: MC_PRESET_DESCRIPTION,
      }, null, 2) + '\n', 'utf8')
      return true
    } catch { return false }
  }
  const readMcPresetMarker = (svc, id) => {
    try {
      const dir = mcPresetDir(svc, id)
      if (!dir) return null
      const p = join(dir, MC_PRESET_MARKER)
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
    } catch { return null }
  }

  /** 宿主 agentPresets 服务（可能晚就绪 → 必须走 inject 等，别用 apply 时的 ctx.get） */
  let agentPresetsSvc = null
  ctx.inject(['agentPresets'], (scope) => {
    agentPresetsSvc = scope.get('agentPresets') ?? null
    // 🔴 同上：preset 自检/自建失败只能记日志，不能让 rejection 漏出去（fail-loud → exit(1)）
    void ensureMcPreset().catch((e) => logLine(`MC 模式 preset 自检失败（不影响启动）：${e?.message ?? e}`))
  })

  /**
   * **MC 模式 preset 的初始化自检**（用户 2026-09-16 定，两次追加要求）：
   *   ① 没有 → 自动建一个（复制官方 preset）
   *   ② 有 → **检查对不对**：显示名/简介/排序、以及"组成是否还等于我们当初复制的那份"
   *      · 我们自己建的 + 用户没改过 + 规格/官方源变了 → **重建**（先备份成 `<id>.bak-<时间>`）
   *      · 我们自己建的但**组成被改过** → **绝不动**（用户改的就是用户的）
   *      · 不是我们建的，只有"简介明显是复制残留"才修显示文本
   *
   * 🔴 **只能用宿主官方接口 `agentPresets.copy/remove`**：官方 authoring 明令
   *    "只允许整目录复制已有 preset，调用方不得提供 composition 文本"
   *    （`agent-presets/src/authoring.ts` 头注释）。
   * 🔴 `ensureMcPreset:false` 可关；没有可写根（`authorable:false`）就跳过并说明。
   */
  let presetEnsureTried = false
  const ensureMcPreset = async () => {
    if (presetEnsureTried) return
    if (pluginConfig.get('ensureMcPreset') !== true) return
    const svc = agentPresetsSvc
    if (!svc || typeof svc.list !== 'function' || typeof svc.copy !== 'function') return
    presetEnsureTried = true
    try {
      if (svc.authorable === false) {
        logLine('MC 模式 preset 需要"用户可写的 preset 根"，但这份部署没有 → 跳过自动创建（请手动建一个）')
        return
      }
      const list = await svc.list()
      const rows = new Map((list ?? []).map((p) => [String(p?.id ?? ''), p]))
      const ids = [...rows.keys()].filter(Boolean)
      const wanted = pluginConfig.mcModePresets
      const existingId = wanted.find((id) => rows.has(id))
      const source = pickPresetSource(ids, svc.defaultId)

      if (existingId) {
        const row = rows.get(existingId)
        const dir = mcPresetDir(svc, existingId)
        const marker = readMcPresetMarker(svc, existingId)
        const composition = compositionOf(row)
        const shippedDescs = PREFERRED_PRESET_SOURCES.map((sid) => rows.get(sid)?.description)
        const plan = planPresetAction({
          exists: true,
          marker,
          compositionHash: hash16(composition),
          // 源变了才重建：拿**我们当初记的源**（marker.source）当前的组成来比
          sourceHash: hash16(compositionOf(rows.get(String(marker?.source ?? source ?? '')))),
          metaOk: String(row?.name ?? '') === MC_PRESET_NAME && String(row?.description ?? '') === MC_PRESET_DESCRIPTION,
          shippedDescriptionMatch: isCopiedPresetDescription(row?.description, shippedDescs),
        })
        if (plan.action === 'leave') {
          logLine(`MC 模式 preset「${existingId}」检查通过，不动它（${plan.reason}）`)
          // 只有一件例外：**补 present 组**（显式文件交付）—— 删掉 mc_kit_share 之后，这是
          // "让本地用户看到产出文件"的唯一正路；只做"没有才加"，不动别的行。
          ensureToolGroupsInPreset(svc, existingId)
          /* 🔴 启动自检之二（用户 2026-09-17）：**persona 的键名必须跟本版本的源 preset 一致** ——
           * 新版 DSH 要 `prefix`、老版要 `text`（我们曾写死 prefix，把老环境的 preset 建坏了：
           * 加载即 `$text missing required value`，MC 模式直接切不进去）。 */
          try {
            const sourceKey = personaTextKeyOf(compositionOf(rows.get(String(marker?.source ?? source ?? ''))))
            repairPersonaKeyIfNeeded(svc, existingId, {
              composition,
              sourceKey,
              mine: marker !== null || isCopiedPresetDescription(row?.description, shippedDescs),
              stillComplete: /^\s{2,}complete\s*:\s*true\s*$/m.test(String(composition ?? '')),
            })
          } catch (e) { logLine(`persona 键名自检失败（不影响启动）：${e?.message ?? e}`) }
          return
        }
        if (plan.action === 'meta') {
          const fixed = writeMcPresetMetadata(svc, existingId)
          // 旧版（没有自建标记）建的那份：**只在组成与某个官方源逐字相同**时才动 persona/shell ——
          // 「简介是复制残留」+「组成没被改过」两条同时成立，才敢认它是我们早期复制出来的。
          let fixedComp = false
          if (marker === null && composition !== null) {
            // 🔴 判据不看"和官方源逐字相同"（DSH 一升级就比不上了），而看**那句官方 persona 还在不在**
            //    —— 这才是真正有害的状态（它带着 complete:true / includeRuntimeContext:false，
            //    会把我们注入的 context 段整个压掉）。用户改过人设的 preset 不会被碰。
            const stillShippedPersona = /You are a helpful software engineer assistant\./.test(composition)
              && /complete:\s*true/.test(composition)
            if (stillShippedPersona) fixedComp = patchMcPresetComposition(svc, existingId, { key: personaTextKeyOf(compositionOf(rows.get(source))) })
          }
          logLine(`MC 模式 preset「${existingId}」${plan.reason} → 已修好显示名/简介`
            + `${fixedComp ? '，并把 persona 换成 MC 的、关掉了 shell' : ''}`
            + `${fixed ? '' : '（⚠️ 写入失败，请手动编辑 preset.yml）'}`)
          // 旧版建的那份没有标记 → 修完补一个（hash 取**修完**之后的组成），下次才算"我们的"
          if (marker === null) {
            writeMcPresetMarker(svc, existingId, {
              source: marker?.source ?? source,
              composition: compositionOf(rows.get(existingId)) ?? composition,
            })
          }
          ensureToolGroupsInPreset(svc, existingId)
          // 同一件事也在这条路上做一遍：显示名/简介要修的那份，persona 键名可能也是坏的
          try {
            repairPersonaKeyIfNeeded(svc, existingId, {
              composition,
              sourceKey: personaTextKeyOf(compositionOf(rows.get(String(marker?.source ?? source ?? '')))),
              mine: marker !== null || isCopiedPresetDescription(row?.description, shippedDescs),
              stillComplete: /^\s{2,}complete\s*:\s*true\s*$/m.test(String(composition ?? '')),
            })
          } catch (e) { logLine(`persona 键名自检失败（不影响启动）：${e?.message ?? e}`) }
          return
        }
        // plan.action === 'rebuild'：先备份整个目录，再用官方接口重新复制一遍
        let backup = null
        try {
          if (dir && existsSync(dir)) {
            backup = `${dir}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
            renameSync(dir, backup)
          }
          await svc.copy(String(marker?.source ?? source), existingId, MC_PRESET_NAME)
          patchMcPresetComposition(svc, existingId, { key: personaTextKeyOf(compositionOf(rows.get(String(marker?.source ?? source)))) })
          writeMcPresetMetadata(svc, existingId)
          writeMcPresetMarker(svc, existingId, { source: marker?.source ?? source, composition: compositionOf(rows.get(String(marker?.source ?? source ?? ''))) })
          logLine(`MC 模式 preset「${existingId}」${plan.reason} → 已重建${backup ? `（旧的备份在 ${backup}）` : ''}`)
        } catch (e) {
          // 重建失败：把备份放回去，别把用户坑在"什么都没有"的状态
          try { if (backup && !existsSync(dir)) renameSync(backup, dir) } catch { /* 尽力而为 */ }
          logLine(`MC 模式 preset 重建失败（已回滚）：${e?.message ?? e}`)
        }
        return
      }

      // preset id 必须是目录名（宿主 `PRESET_ID = /^[a-z0-9][a-z0-9-]*$/`）。
      // 🔴 2026-10-15 审计（报告 E 第 5 条）：这里原来写"`dsh-mc-agent` 带下划线、永远不可能是
      //    preset id"——错的（它是连字符，完全合法）。`pickPresetTarget` 现在会把插件自己的 id 排除掉。
      const target = pickPresetTarget(wanted)
      if (!target) {
        logLine(`没找到 MC 模式 preset，而 mcModePresets 里没有**合法**的 preset id（${wanted.join(' / ')}）→ 跳过`)
        return
      }
      if (!source) {
        logLine(`没找到 MC 模式 preset，且找不到可复制的官方 preset 源（现有：${ids.join(' / ') || '（空）'}）→ 跳过`)
        return
      }
      await svc.copy(source, target, MC_PRESET_NAME)
      // 复制完立刻打我们的补丁：persona 换成 MC 的、关掉那个 shell（否则就是"软件助手"+一个 pwsh）
      const patched = patchMcPresetComposition(svc, target, { key: personaTextKeyOf(compositionOf(rows.get(source))) })
      // copy() 会**保留源 preset 的简介**（官方只改 name）→ 必须把元数据改回来，否则简介跟极简模式一样
      const meta = writeMcPresetMetadata(svc, target)
      // 留个"这是我们建的"标记（含规格版本 + 组成 hash）→ 下次启动才能"检查不对就重建"
      const marked = writeMcPresetMarker(svc, target, {
        source,
        composition: compositionOf((await svc.list())?.find?.((p) => String(p?.id ?? '') === target)),
      })
      logLine(`已自动创建「${MC_PRESET_NAME}」preset：复制官方 ${source} → ${target}`
        + `${meta ? '（简介已改）' : '（⚠️ 简介没改成，请手动编辑 preset.yml）'}`
        + `${patched ? '（persona 已换成 MC 的、shell 已关）' : '（⚠️ persona/shell 没改成，请手动看一眼 agent.cordis.yml）'}`
        + `${marked ? '' : '（⚠️ 没留下自建标记，下次不会自动维护它）'}`
        + `；想改就编辑 ${expandHome(String(svc.roots?.find?.((r) => r?.trust === 'user')?.path ?? '$DSH_HOME/.agent-presets'))}/${target}/`
        + `，想关掉自动创建设 ensureMcPreset=false`)
    } catch (e) {
      logLine(`自动创建 MC 模式 preset 失败（不影响其它功能）：${e?.message ?? e}`)
    }
  }

  /** 诊断用：每个 agent 最近一次看到的 preset id（`/api/mc/mode` 会报出来） */
  const lastPresetSeen = new WeakMap()

  /**
   * 现场问出这个 agent 的 preset id（拿不到 → null）。
   *
   * 🔴 以前只认 inject 抓到的那个引用：一旦它还是 null，判据就永远 false，
   *    表现就是"按钮有、提示词没有、隔离也不生效"（2026-09-16 真机事故的同一家族）——
   *    所以服务可能晚就绪 / `ctx.inject` 没跑到时**现场再拿一次**。
   */
  const mcPresetIdOf = (agent) => {
    if (!agent?.ctx) return null
    try {
      let svc = agentPresetsSvc
      if (!svc) { try { svc = agent.ctx.get('agentPresets') } catch { svc = null } }
      if (!svc) { try { svc = ctx.get('agentPresets') } catch { svc = null } }
      const id = svc?.composedPreset?.(agent.ctx)
      if (typeof id === 'string' && id) { lastPresetSeen.set(agent, id); return id }
      return null
    } catch { return null }
  }

  const isMcModeAgent = (agent) => pluginConfig.isMcModePreset(mcPresetIdOf(agent))

  /** MC+ 变体判据（MC 模式基础上开放标准模式全部工具）；名单与语义见 src/config.mjs isMcPlusPreset */
  const isMcPlusAgent = (agent) => pluginConfig.isMcPlusPreset(mcPresetIdOf(agent))

  /* ── 提示词注入 / 通知台账 / 记忆根播种 ─────────────────────────────────
   * 原来这几摊子就写在这儿（666 行），2026-10-20 搬进了 `src/inject.mjs`：
   * 它和"工具"没关系，讲的是"该不该塞提示词 / 哪些指令发过了 / 新会话播种哪些文件"。
   * 工厂拿的是**这个闭包里的**配置与记忆根，所以状态仍是每插件实例一份。
   * 🔴 调用点必须在这儿：`agentPresetsSvc` / `isMcModeAgent` / `isMcPlusAgent` /
   *    `MC_PLUS_NOTICE_TEXT` 都在上面才声明（早于它们会 TDZ）。
   * ------------------------------------------------------------------ */
  const {
    SESSION_SEED_FILES, ensureMemoryRootForCwd, enterWithNotices,
    memoryIndexText, promptInjectionStatus, reconcileNotices,
    seedSessionRoot, sentNoticeRels, withdrawAgentsMdNotices,
    memLabelOf, ensureAgentsMdFile, rulesPointerText,
  } = createInjector({
        DEFAULT_AGENTS_MD, MC_PLUS_NOTICE_TEXT, PLUGIN_VERSION,
        VERSION_PROMPT_FILE, agentIdOf, agentPresetsSvc,
        agentsMdPath, isMcModeAgent, isMcPlusAgent,
        lastPresetSeen, logDebug, logLine,
        logOnce, mcPresetDir, memoryBaseFor,
        memoryFor, memoryRootFor, migrateLegacyAgentsMd,
        migrateWorkspaceConfig, noteAgent, pluginConfig,
        pluginLoadNote, readAgentsMd, readVersionPrompt,
        syncRulesVersion, syncVersionPrompt, userMessage,
        versionPromptPath, versionPromptSource, versionPromptText,
        versionPromptTitle, workspaceConfigValues, workspaceOf,
        workspaceRootFor, wsCfgValues, wsConfigPath,
  })


  /**
   * 看门狗的**模式闸门**：只有"仍然是 MC 模式"的会话才允许它往会话里注入。
   *
   * 🔴 同类残留（2026-09-17）：狗是**黏**的 —— `armed` 挂在会话实例上，切模式不会自动关它，
   *    于是切回普通模式后它仍会把"有人叫你 / 你被打了一下"注进一个已经不是 MC 模式的会话。
   *    闸门按**现场判据**（preset）开关：切出闭嘴、切回自动恢复（不必重新 arm）。
   * @param sess - McSession（闸门在注入那一刻读 `sess.watchdog.agent`）
   * @returns {() => boolean} 供 `Watchdog#gate` 用的回调
   */
  const watchdogGate = (sess) => () => isMcModeAgent(sess?.watchdog?.agent)

  /** 取某个 agent scope 上的 tools 服务：restrict **必须**用 scoped 服务，否则会被宿主拒绝 */
  const scopedTools = (agentCtx) => {
    const pickers = [() => agentCtx.get('tools'), () => agentCtx.tools]
    for (const pick of pickers) {
      try {
        const t = pick()
        if (t && typeof t.restrict === 'function') return t
      } catch { /* 该 scope 没 inject 时属性访问会抛，换下一种拿法 */ }
    }
    return null
  }

  /* 🔴 2026-09-16：这里原来有一段"麦块模式专属指导"（通过系统提示注入）。
   * 用户要求**删掉显式注入**，而且它的内容（单对话 / 记忆 / 看门狗 / 指令是最后手段 / 别乱挖乱建）
   * 已经全部写在 `.dsh-mc-agent/AGENTS.md`（用户 亲自给的那版）里 —— 留着就是重复。 */

  /**
   * 这个 agent 当前套用的**工具曝光策略**（'mc' / 'mc-plus' / 'other'；没套过 = 不存在）。
   * 由 `applyMcModePolicy` 按现场判据重算；kind 没变就不动（幂等）。
   */
  const mcPolicyKind = new WeakMap()

  /**
   * 工具限制的**撤销手柄**：`tools.restrict()` 返回的 disposer（mc 白名单与 other 的 deny 共用）。
   *
   * 🔴 2026-09-17 修（用户报的"标准模式会话无法执行命令"）：`restrict()` 是**黏**的 ——
   *    它挂在 agent scope 上，**会话不死就不消失**；而我们以前把返回的 disposer 丢掉了，
   *    `agent-preset/selected` 又只"套用"不"撤销" ⇒ 从 MC模式 切回 标准模式 的会话
   *    会一直留着 MC 白名单（没有 pwsh/bash），看起来就像"标准模式坏了"。
   *    真机复现：`session-55d48701`（standard → 04:51 切 minecraft → 06:34 切回 standard，
   *    之后那个"标准模式"会话的工具面仍是 mc_* + read/write/edit/read_image/present）。
   *    现在：套用/撤销都由 `touch()` 按**现场判据**决定；kind 变化必先 `release()`。
   *    （admin/文件边界这些在 **guard** 里，每次调用现场判，切模式立刻自愈，不需要撤销。）
   */
  const mcRestrictRelease = new WeakMap()

  /**
   * 已确认属于 MC 模式的会话 id（给前端 `/api/mc/mode` 兜底用）。
   * 主路径是现场问 `agentPresets`（见 handleMcApi 的 /api/mc/mode），
   * 这里只是"agent 已经不在了 / 拿不到 agentPresets"时的退路。
   */
  const mcModeAgentIds = new Set()
  /** 已确认属于 **MC+** 变体的会话 id（同样的兜底用途；判据见 isMcPlusAgent） */
  const mcPlusAgentIds = new Set()
  /** 因为"没选中工作区"被拒绝进入 MC 模式的会话（`/api/mc/mode` 用它报原因） */
  const noWorkspaceRefused = new Set()

  /**
   * 按**现场判据**给这个 agent 套工具曝光策略（三种去向）：
   *   · `mc`（MC模式）—— 白名单：mc 工具 + 文件工具 + present + allowOtherTools；
   *   · `mc-plus`（MC+模式）—— **不限制工具面**（组成里挂了标准工具全量，mc/mckit 走全局注册直接可见）；
   *   · `other`（其它模式）—— `deny` 掉 mc_*（mc_admin_* 除外）与 mc_kit_* —— 用户 2026-10-04：
   *     "除了 MC模式和 MC+模式，不再给其他模式暴露 mc 和 mckit 工具"。
   *
   * kind 没变 = 幂等返回；kind 变了先撤销旧限制再套新的（`restrict` 是黏的，见 mcRestrictRelease）。
   */
  const applyMcModePolicy = (agent) => {
    if (!agent?.ctx) return
    const id = mcPresetIdOf(agent)
    const isMc = pluginConfig.isMcModePreset(id)
    const isPlus = pluginConfig.isMcPlusPreset(id)
    // 🔴 用户 2026-09-16："如果没有选中工作区，则拒绝发起 MC 模式会话和设置。"
    //    没有工作区 → `.dsh-mc-agent/`（记忆 + 提示词）无处安放 → 不当成 MC 会话：
    //    不套隔离、不注入专属提示词、前端也会隐藏「MC设置」入口（/api/mc/mode 会带 reason）。
    if (isMc && !workspaceOf(agent)) {
      if (agent.id) noWorkspaceRefused.add(String(agent.id))
      logLine(`拒绝启用 MC 模式：这个会话没有选中工作区（.dsh-mc-agent 与提示词要建在工作区里）`)
      return
    }
    if (agent.id) noWorkspaceRefused.delete(String(agent.id))
    const kind = isMc ? (isPlus ? 'mc-plus' : 'mc') : 'other'
    if (mcPolicyKind.get(agent) === kind) return
    // 套新的之前先撤销旧限制（kind 变了；幂等：没套过就没有手柄）
    const prev = mcRestrictRelease.get(agent)
    if (prev) {
      mcRestrictRelease.delete(agent)
      try { prev() } catch (e) { logLine(`撤销上一轮工具限制失败（guard 仍会兜底）：${e?.message ?? e}`) }
    }
    mcPolicyKind.set(agent, kind)

    if (kind === 'other') {
      if (agent.id) { mcModeAgentIds.delete(String(agent.id)); mcPlusAgentIds.delete(String(agent.id)) }
      // 非 MC 模式：mc_* / mc_kit_* 从可见面摘掉；mc_admin_* 例外（它的用途就是在普通会话里管理）
      try {
        const t = scopedTools(agent.ctx)
        /* 🔴 报告 H14（2026-10-13）：`mcPolicyKind` 在 `:4252` 就记下了 —— 如果这里拿不到
         *    scoped tools 就 return，下一次 `applyMcModePolicy` 会在 `:4245` 因为"kind 没变"
         *    直接短路，**永远不再重试**（MC 分支同理 ⇒ 白名单一次没套上就再也不会套，pwsh 一直能用）。
         *    失败路径上把缓存删掉，让下一次调用重试。 */
        if (!t) { mcPolicyKind.delete(agent); logDebug('非 MC 模式：拿不到 scoped tools，跳过 mc 工具隐藏（guard 仍会硬拒，下次再试）'); return }
        const deny = ourToolNames.filter((n) =>
          n.startsWith('mc_kit_') || (n.startsWith('mc_') && !n.startsWith('mc_admin_')))
        if (!deny.length) return
        mcRestrictRelease.set(agent, t.restrict({ deny }))
        logDebug(`非 MC 模式：mc / mc_kit 工具已从可见面摘掉（mc_admin_* 保留）${agent.id ? `（${agent.id}）` : ''}`)
      } catch (e) {
        mcPolicyKind.delete(agent)
        logLine(`非 MC 模式隐藏 mc 工具失败（${String(e?.message).slice(0, 160)}）—— guard 仍会硬拒，下次再试`)
      }
      return
    }

    if (agent.id) {
      mcModeAgentIds.add(String(agent.id))
      if (isPlus) mcPlusAgentIds.add(String(agent.id))
      else mcPlusAgentIds.delete(String(agent.id))
    }
    ensureMemoryRoot(agent)        // ← 首次发起 MC 模式会话 = 建 `.dsh-mc-agent/`（README / RULES.md）的时机
    // 🔴 2026-09-18：**这里不再投提示词**。投递搬到"每个请求组装之前"（`agent/pre-step` → `reconcileNotices`），
    //    因为模式在第一次请求之前还可能被改（宿主允许空白期反复切 preset）。
    //    这条日志只是"模式已生效"的标记；真投出去时 `reconcileNotices` 自己会记一行。
    logLine(`${isPlus ? 'MC+ 模式' : 'MC 模式'}生效（preset=${id ?? '?'}，${agent.id}）提示词将在首次请求组装前投递`)

    if (isPlus) return   // MC+：不套白名单（见上面注释）；guard 对它只保留凭据路径拒绝

    // ② 工具可见性：**白名单**（用户 2026-09-16 真机投诉："这个 agent 怎么还能用 pwsh！不是只暴露我们指定的工具吗！"）
    //
    // 🔴 以前是"allowOtherTools 非空才走白名单"——默认为空 ⇒ 只 deny 了我们自己的管理工具，
    //    宿主那一堆工具（pwsh / subagent / workflow / serve_* / web_* …）**全都还在**。
    //    那不是"隔离"，只是"藏了自家两个工具"。现在**无条件白名单**：
    //      我们自己的非管理工具（mc_* / mc_kit_*）+ **文件工具**（会被 guard 限在 .dsh-mc-agent/ 内）
    //      + 配置里额外允许的其它工具。
    try {
      const t = scopedTools(agent.ctx)
      if (!t) { mcPolicyKind.delete(agent); logLine('MC 模式：拿不到 scoped tools，跳过可见性限制（guard 仍会硬拒，下次再试）'); return }
      const { allowOtherTools, hideAdminTools, allowCompanionTools } = pluginConfig.mcMode
      const adminNames = ourToolNames.filter((n) => n.startsWith('mc_admin_'))
      const wanted = [
        ...ourToolNames.filter((n) => !n.startsWith('mc_admin_')),
        ...(hideAdminTools ? [] : adminNames),
        ...MC_FILE_TOOLS,
        MC_PRESENT_TOOL,
        // 配套插件（ACP / billion-context 那族）默认放行 —— 用户 2026-10-19 要的"装完就能用"
        ...(allowCompanionTools === false ? [] : MC_COMPANION_TOOLS),
        ...allowOtherTools,
      ]
      // 🔴 `tools.restrict()` 对**不认识的工具名是抛错**的（宿主 index.ts:1078 拿 restrictableNames 校验）。
      //    而"哪些文件工具在场"取决于 preset 挂了哪些工具包（本机这份 preset 只挂了 tool-fs，
      //    **没有** tool-fs-search ⇒ `glob`/`grep` 不存在）。要是让一个不存在的名字把整次调用炸掉，
      //    结果就是"白名单没生效、pwsh 照样能用"—— 正是用户投诉的那个症状。
      //    所以：**失败 → 从宿主的报错里读出"它认识的名字"，过滤一次再试**（只重试一次，之后才认输）。
      const applyAllow = (names) => {
        try {
          return { allow: names, release: t.restrict({ allow: names }) }
        } catch (e) {
          const knownPart = /known global tools:\s*([\s\S]*)$/.exec(String(e?.message ?? ''))
          const known = new Set((knownPart?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
          const usable = names.filter((n) => known.has(n))
          if (!known.size || !usable.length) throw e
          const release = t.restrict({ allow: usable })
          logDebug(`MC 模式：白名单里有宿主不认识的名字（${names.filter((n) => !known.has(n)).join(', ')}）→ 已按实际在场的工具过滤`)
          return { allow: usable, release }
        }
      }
      const { allow, release } = applyAllow(wanted)
      // 存下撤销手柄（切出 MC 模式时用；见 mcRestrictRelease 的说明）
      mcRestrictRelease.set(agent, release)
      logDebug(`MC 模式：工具白名单已生效（${agent.id}）：${allow.join(', ')}`)
    } catch (e) {
      /* H14：白名单没套上 ⇒ 别把 kind 留在缓存里（否则 `:4245` 会短路、再不重试） */
      mcPolicyKind.delete(agent)
      logLine(`MC 模式工具白名单**没生效**（${String(e?.message).slice(0, 160)}）—— 管理工具与文件越界仍由 guard 兜底，下次再试`)
    }
  }

  /**
   * 退出 MC 模式（切回普通模式）：**撤回提示行 + 把工具策略换成"非 MC"档**。
   *
   * 🔴 2026-09-17 新增（用户报的"标准模式会话无法执行命令"）：历史上 `applyMcModePolicy` 是
   *    "只套一次"、没有任何地方撤销 —— 从 MC模式 切回 标准模式的会话会永久留在 MC 白名单里。
   *    现在套用/撤销都由 `touch()` 按**现场判据**决定。
   * 🔴 2026-10-04：非 MC 模式**不再等于"无限制"** —— 用户要求"除了 MC和 MC+ 模式，不再给其他
   *    模式暴露 mc 和 mckit 工具"，所以这里委托 `applyMcModePolicy`（它会释放旧限制并套 deny）。
   *    guard 里还有一道"非 MC 拒调 mc/mckit"的硬保证（防 restrict 没套上）。
   *
   * 幂等：重复调用只是重复"撤回提示行"（本身幂等）与一次 kind 比对。
   * @param agent - 宿主 Agent 对象（WeakMap 键，不阻止回收）
   */
  const liftMcModePolicy = (agent) => {
    if (!agent) return
    const was = mcPolicyKind.get(agent)
    // 这个会话已经不是 MC 模式了 → "因没选工作区被拒绝"的旧标记也一起清掉
    if (agent.id) noWorkspaceRefused.delete(String(agent.id))
    // ① 撤回提示行（还没投递的直接删；已经进对话的补一条作废声明）——见 withdrawAgentsMdNotices
    try { withdrawAgentsMdNotices(agent) } catch (e) { logLine(`撤回 MC 提示行失败：${e?.message ?? e}`) }
    // ② 看门狗：armed 挂在会话实例上、切模式不会自动关 → 关掉它的**注入闸门**
    //    （不 disarm：切回 MC 模式时自动恢复，不用重新 arm）
    try {
      const wd = agent.id ? registry.peek(String(agent.id))?.watchdog : null
      if (wd?.armed) logLine(`本会话已退出 MC 模式：看门狗注入已闸掉（仍 armed，切回 MC 模式即恢复）`)
    } catch { /* 只是记一行日志，失败无所谓 */ }
    // ③ 工具策略切到"非 MC"档：释放旧限制 + 套 deny（幂等，见 applyMcModePolicy）
    try { applyMcModePolicy(agent) } catch (e) { logLine(`退出 MC 模式后套用非 MC 工具策略失败：${e?.message ?? e}`) }
    if (was === 'mc' || was === 'mc-plus') {
      logLine(`已退出 MC 模式（preset=${lastPresetSeen.get(agent) ?? '?'}，${agent.id ?? '?'}）：${was === 'mc' ? '工具白名单已撤销' : 'MC+ 工具面已恢复为普通限制'}`)
    }
  }

  // ③ 硬保证（不管可见性怎样）：按模式分档的**调用级兜底**。
  //
  //    · MC 模式：管理工具调不动 + 文件工具只能碰 `<工作区>/.dsh-mc-agent/` + 受保护文件只读；
  //    · MC+ 模式：只保留凭据路径拒绝（文件全工作区、admin 可见——用户 2026-10-04 定）；
  //    · 其它模式：拒调 mc_* / mc_kit_*（mc_admin_* 例外）——"不再给其他模式暴露 mc 和 mckit
  //      工具"的硬保证，与可见性 deny 双保险（restrict 没套上时也调不动）。
  try {
    ctx.tools.guard((exec) => {
      const name = String(exec?.name ?? '')
      const agent = exec?.agent
      // 每次调用都现场判（与 restrict/提示词同一个判据）；preset id 只取一次，省一次服务查询
      const presetId = agent ? mcPresetIdOf(agent) : null
      const isMc = pluginConfig.isMcModePreset(presetId)
      const isPlus = pluginConfig.isMcPlusPreset(presetId)

      // ① 凭据硬拒：两种 MC 模式都保留（"凭据不进模型上下文"是插件不变式）
      if ((isMc || isPlus) && /^(read|edit|write|glob|grep|ls|cat|read_image|mc_kit_memory)$/i.test(name)) {
        const text = JSON.stringify(exec?.arguments ?? {})
        if (/(\.credentials|credentials\.yaml|[/\\]\.dsh[/\\])/i.test(text)) {
          /* 2026-10-20（用户选了 MC+ 却改不了行事准则文件才发现）：记忆根常被 `memoryDir` 挪到
           *    `$DSH_HOME/dsh-mc-agent/memory/` 底下，那条"路径里带宿主目录"的规则会**连记忆一起挡**——
           *    可那里装的是行事准则 / 世界记忆 / 踩坑档案，不是账号凭据。这里放行"插件目录 + memory 段"，
           *    凭据文件与 secrets 备忘目录仍由本判断和下面那条单独的规则挡住。 */
          const memPathOk = /dsh-mc-agent(?:\\\\|\/)+memory(?:\\\\|\/)/i.test(text)
          if (!memPathOk) return 'MC 模式不允许触碰宿主凭据文件；账号密码在「MC设置」里维护，AI 不需要也不应该看到。'
        }
        // 明文凭据备忘（`secrets/` 下用户自己的私密档）：同样不许读
        // （2026-09-16：账户体系上线后，密码只该待在「MC设置 → 账户」里）
        if (/[/\\]secrets[/\\]/i.test(text)) {
          return 'MC 模式不允许读凭据备忘目录（secrets/）；账号密码在「MC设置 → 账户」里维护，AI 不需要也不应该看到。'
        }
      }
      if (isPlus) return undefined   // MC+：其余放行（文件全工作区；admin 可见；受保护文件按宿主默认）

      if (!isMc) {
        // 非 MC 模式：mc_* / mc_kit_* 硬拒（mc_admin_* 例外——它的用途就是在普通会话里管理）
        if (agent && (/^mc_kit_/i.test(name) || (/^mc_/i.test(name) && !/^mc_admin_/i.test(name)))) {
          return '这些工具只在 MC模式 / MC+模式 会话里可用——请切换会话模式后再用。'
        }
        return undefined
      }

      // ── 以下只对 MC 模式生效 ──────────────────────────────────────────────
      // ② 管理工具：MC 模式一律拒绝（隐藏之外再上一道硬锁）
      if (name.startsWith('mc_admin_')) {
        return 'MC 模式会话不能读取或修改 dsh-mc-agent 配置——请在普通会话里用 mc_admin_config 改。'
      }

      if (/^(read|edit|write|ops_replace|glob|grep|ls|cat|read_image|mc_kit_memory)$/i.test(name)) {
        const args = exec?.arguments ?? {}
        // 受保护文件（RULES.md / AGENTS.md / config.json，src/protected.mjs）：**可读不可写**。
        // 宿主文件工具里只有 write|edit 会写；记忆工具按 action 判定（memory.mjs 内还有一道兜底）。
        // 判定 = 路径写法命中（裸名/含 .dsh-mc-agent 段）**或**解析到记忆根后正好是那个文件
        // （记忆根可被 memoryDir 重定向，绝对路径不一定含 `.dsh-mc-agent` 段）。
        const protectedHit = (raw) => {
          const p = String(raw ?? '').trim()
          if (!p) return false
          if (isProtectedPathArg(p)) return true
          const root = memoryRootFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent))
          const abs = resolve(root, p)
          return PROTECTED_FILES.some((f) => abs === join(root, f))
        }
        if (WRITE_FILE_TOOLS.test(name) && protectedHit(fileToolPath(exec))) {
          return rejectionText()
        }
        if (name.toLowerCase() === 'mc_kit_memory'
          && MEMORY_WRITE_ACTIONS.has(String(args.action ?? ''))
          && protectedHit(args.path)) {
          return rejectionText()
        }
      }

      // ③ 🔴 用户 2026-09-16："读写文件都只能在记忆文件夹内！"
      //    文件工具（read/write/edit/read_image/glob/grep）的路径一律解析到
      //    `<工作区>/.dsh-mc-agent/` 之内；**没给路径也算越界**（glob/grep 不给路径 = 扫整个工作区）。
      const raw = fileToolPath(exec)
      if (raw !== null) {
        const root = memoryRootFor(workspaceOf(exec?.agent), agentIdOf(exec?.agent))
        const rel = String(raw ?? '').trim()
        if (!rel) {
          return `MC 模式的文件工具只能在记忆文件夹（${root}）里用——请显式给记忆根内的路径。`
        }
        /* 🔴 2026-10-06（本机补丁）：记忆根被 `config.memoryDir` 挪出工作区之后，
         *    `.dsh-mc-agent/xxx` 这种写法会被**宿主按会话工作区**解析 —— 结果是在工作区里
         *    重新长出一个 `.dsh-mc-agent/`，而 AI 以为自己在写记忆。这里直接拦下并说清该怎么做
         *    （记忆根已经不在工作区里时，`mc_kit_memory` 用的是**记忆根相对**路径）。 */
        const wsRoot = workspaceOf(exec?.agent)
        const legacy = /(^|[\\/])\.dsh-mc-agent([\\/]|$)/i.test(rel)
        if (legacy && wsRoot && !/^mc_kit_memory$/i.test(name)
          && resolve(root) !== resolve(join(wsRoot, '.dsh-mc-agent'))) {
          return `记忆文件夹已经不在工作区里了（现在在 ${root}）。`
            + '文件工具请给**绝对路径**（记忆根内的文件），'
            + '或者改用 `mc_kit_memory`（它的 `path` 是**记忆根相对**的，例如 {action:"read", path:"README.md"}）。'
            + '`.dsh-mc-agent/...` 这种写法会被按工作区解析、在工作区里重新建出一个文件夹，所以这里不认。'
        }
        const abs = resolve(root, rel)
        const prefix = root.endsWith(sep) ? root : root + sep
        if (abs !== root && !abs.startsWith(prefix)) {
          return `MC 模式只能在记忆文件夹（${root}）里读写文件；这个路径在外面：${rel}`
        }
      }

      // ④ `present`：**只能交付本会话工作区内的文件**（`.dsh-mc-agent/` 与 `out/` 都在里面）。
      //    宿主自己也要求"文件已存在且在工作区里"，这里只是把边界说清、给可读的拒绝理由。
      const delivering = presentPaths(exec)
      if (delivering !== null) {
        const wsRoot = workspaceRootFor(exec?.agent)
        const prefix = wsRoot.endsWith(sep) ? wsRoot : wsRoot + sep
        for (const rel of delivering) {
          const abs = resolve(wsRoot, rel)
          if (abs !== wsRoot && !abs.startsWith(prefix)) {
            return `present 只能交付本会话工作区（${wsRoot}）里的文件；这个路径在外面：${rel}`
          }
        }
      }
      return undefined
    })
  } catch (e) { logLine(`注册 MC 模式 guard 失败：${e.message}`) }

  // agent 建立 / 首轮开始 / **模式被选上** 时应用策略。
  // 🔴 2026-09-16 真机事故：只挂 `agent/created` + `agent/session-start` 是不够的 ——
  //    preset 完全可能在 agent 建好之后才选上（在会话里点「MC模式」芯片），宿主为这种情况
  //    专门发 **`agent-preset/selected`**（宿主 emit，两个位置参数 `(sessionId, presetId)`）。
  //    当时没挂它 → 策略与提示词都不会生效。
  //    每个 agent：① 是 MC/MC+ 模式就按档套策略并投提示行（applyMcModePolicy）
  //    ② 不是就**切到"非 MC"档**（liftMcModePolicy —— 释放旧限制 + 把 mc/mckit 摘出可见面）。
  ctx.effect(() => {
    const handlers = []
    const touch = (agent) => {
      if (!agent?.ctx) return
      // ⚠️ 这里**不再**建 `.dsh-mc-agent/` —— 建文件只发生在"首次发起 MC 模式会话"
      //    （applyMcModePolicy 里）和"点开 MC设置"（HTTP 接口里）这两个时机（用户 2026-09-16 定）。
      try {
        // 🔴 2026-09-17：**两个方向都要处理** —— 是 MC 模式（含 MC+）就套用，**不是就切到非 MC 档**。
        //    以前只"套用"，于是 MC模式 → 标准模式 的会话会一直留着 MC 白名单（没有 pwsh），
        //    表现就是"标准模式会话无法执行命令"（用户真机报的，见 mcRestrictRelease 的说明）。
        if (isMcModeAgent(agent)) applyMcModePolicy(agent)
        else liftMcModePolicy(agent)
      } catch (e) { logLine(`MC 模式策略失败：${e.message}`) }
    }
    for (const ev of ['agent/created', 'agent/session-start']) {
      try { handlers.push(ctx.on(ev, ({ agent } = {}) => touch(agent))) } catch { /* 宿主没有这个事件就跳过 */ }
    }
    // 模式被选上/切换：两个位置参数，agent 要自己找回来
    try {
      handlers.push(ctx.on('agent-preset/selected', (sessionId, presetId) => {
        // 🔴 两个方向都记：切到 MC模式（含 MC+）才进兜底名单，切走要**移出去**（否则前端入口判据会残留）
        if (pluginConfig.isMcModePreset(presetId)) mcModeAgentIds.add(String(sessionId))
        else mcModeAgentIds.delete(String(sessionId))
        if (pluginConfig.isMcPlusPreset(presetId)) mcPlusAgentIds.add(String(sessionId))
        else mcPlusAgentIds.delete(String(sessionId))
        touch(safeAgentById(sessionId))
      }))
    } catch { /* 老宿主没有这个事件 */ }

    /* 🔴🔴 2026-09-18 **提示词的挂载点**（用户："应该切换到正确的挂载点……而是在对话开始后设置
     *    工具/注入提示词"）。宿主给的时序是：`agent/created`（setup 完成 = preset 已 mount）
     *    → `agent/session-start` → **首次请求组装**，而 `agent/pre-step` 正是"消息已经被领走、
     *    系统提示词已经装好、这个 step 马上要发给模型"的那条**瀑布**
     *    （`core/agent-loop/src/agent.ts:240-258`；宿主自己的 `agent-instructions` 也挂在这条上同步上下文）。
     *
     *    为什么必须是这里：**模式在第一次请求之前仍然可能改** —— 宿主只禁止"已经跑过一轮"之后切换
     *    （`agent-presets/src/index.ts:709-728`，抛 `agent-preset/locked`），空白期可以反复切
     *    （真机 `session-be2e43d7`：seq3 切 MC、seq4 切回 standard）。在 `agent/created` 入队就会
     *    "按当时的模式投一份、之后模式变了而它已经排上队" —— 那正是"标准模式会话里冒出 MC 提示词"。
     *    挂在这里 ⇒ 投出去的每一份都是"**发起请求那一刻**这个会话真正在用的模式"，串模式从根上不可能。
     *
     *    幂等与去重见 `reconcileNotices`（按 preset 记账 + 会话日志回读 + 队列同名检查）。
     *
     * 🔴🔴 **`agent/pre-step` 是 cordis 的 waterfall 事件，监听器必须 `next()` 交棒。**
     *    0.1.4 首发版本这里写成 `({ agent } = {}) => { reconcileNotices(agent) }` —— 只声明了一个形参、
     *    也没有 `return`，于是 **没有调用 `next()`**。cordis 的语义是
     *    （`@deepseek-ai/cordis` 的 `waterfall()`）："a listener that does not call `next()` **vetoes
     *    the rest of the chain, including the built-in behavior**"，并且 waterfall 的返回值就是那个
     *    监听器的返回值 ⇒ 恒定 `undefined` ⇒ 宿主 `agent-loop` 下一行 `decision.kind` 直接
     *    `TypeError: Cannot read properties of undefined (reading 'kind')`。
     *    **后果是 P0 级**：`turn/start` 之后、`step/start` 之前就抛，**任意会话、任意模式、每一轮**都失败，
     *    装了插件就没法对话（真机 `dsh-mc-agent@0.1.4`，标准模式与 MC 模式一视同仁）。
     *
     *    正确写法（宿主自己的 `agent-instructions` 就是这么写的）：接第二个形参 `next` 并交棒，
     *    然后**用交棒拿回的结果做改写**（见下面 `enterWithNotices`）。
     *    且**无论对账成功与否都必须交棒**：抛错也不能否决整条链。
     * 教训：挂到 waterfall 之前，先读那个 dispatch 模式的契约，别只看事件签名。 */
    try {
      handlers.push(ctx.on('agent/pre-step', ({ agent } = {}, next) => {
        if (typeof next !== 'function') {
          // 万一宿主把这条改成普通 emit（不该发生）：别抛，记一行就走，绝不能带崩这一轮。
          try { reconcileNotices(agent) } catch (e) { logLine(`提示词对账失败（不打断本轮）：${e?.message ?? e}`) }
          return undefined
        }
        const inner = next()
        // 交棒一定发生；拿回内层 decision 后把提示行塞进**本步消息的最前面**（与用户那句同批送出）。
        if (inner && typeof inner.then === 'function') {
          return inner.then((decision) => enterWithNotices(agent, decision))
        }
        return enterWithNotices(agent, inner)
      }))
    } catch { /* 老宿主没有这条瀑布 */ }
    return () => { for (const off of handlers) { try { off?.() } catch {} } }
  }, 'dsh-mc-agent: mc-mode policy')

  /* ── 管理工具：只有**非 MC 模式**会话能用（MC 模式看不见 + 调了被 guard 拒）── */

  ctx.tools.register(asTool({
    name: 'mc_admin_config',
    description: '【管理】读写 dsh-mc-agent 的**全局配置**（指令白名单、MC 模式工具暴露、记忆目录…）。\n'
      + '⚠️ **MC 模式会话调不动它**（在普通会话或 MC+ 模式里改）。\n'
      + 'action：\n'
      + '· get（默认）· set（path+value）· unset · reset · list（默认+生效）\n'
      + '可用键：`commandWhitelist`（数组；"tp" 精确、"/^gi.*/" 正则、"*" 全放行）· '
      + '`mcModePresets`（哪些 preset 算 MC 模式，应含 MC+ 的 id）· `mcPlusPresets`（MC+ 变体：开放全部工具）· '
      + '`mcMode.allowOtherTools`（MC 模式**额外**放行的工具）· `mcMode.allowCompanionTools`（配套插件工具，默认 true）· '
      + '`mcMode.hideAdminTools`（默认 true）· `stopOnDanger`（true = 遇险打断动作；默认 false 只提醒）· '
      + '`chatLog`/`chatLogDays`（聊天记录进记忆 `chat-log.md`，默认开、留 7 天）· '
      + '`expressEnabled`（文件分享开关）· '
      + '`expressBase`（分享 base，如 https://example.com）· `memoryDir`（记忆根目录）· '
      + '`memoryScope`（记忆分法：`world` 按世界 / `session` 按会话 / `shared` 全共用）· '
      + '`localWorldName`（本地存档名，服务器不广播它）· '
      + '`memoryPerSession`（老写法：true = 按会话、false = 全共用）。\n'
      + '改完**立即生效**，落在 `$DSH_HOME/dsh-mc-agent/config.json`。',
    parameters: {
      action: { type: 'string', description: 'get（默认）/ set / unset / reset / list' },
      path: { type: 'string', description: '配置项点号路径，如 commandWhitelist 或 mcMode.allowOtherTools' },
      value: { type: 'json', description: 'set 用的值（数组 / 字符串 / 布尔 / 对象）' },
    },
    output: text(),
    async execute(args) {
      const action = String(args.action ?? 'get').toLowerCase()
      const info = { file: pluginConfig.file, lastError: pluginConfig.lastError ?? null }
      switch (action) {
        case 'get':
          return args.path
            ? { ...info, path: String(args.path), value: pluginConfig.get(args.path) }
            : { ...info, values: pluginConfig.values() }
        case 'set':
          return { ...info, ...pluginConfig.set(args.path, args.value) }
        case 'unset':
          return { ...info, ...pluginConfig.unset(args.path) }
        case 'reset':
          return { ...info, ...pluginConfig.reset() }
        case 'list':
          return { ...info, values: pluginConfig.values(), defaults: DEFAULT_CONFIG, mcModePresets: pluginConfig.mcModePresets }
        default:
          throw new Error(`未知 action："${action}"（可用 get/set/unset/reset/list）`)
      }
    },
  }))

  /* ─────────── 扩展点：其他 Agent 往 extensions/ 丢文件就能加工具 ───────────
   * 需求 6 的另一半："其他 Agent 要保留为它做扩展、写 Agent 的能力"。
   * 任何 .mjs 导出 `apply(api)` 即可；api 里给了 asTool / getSession / registry /
   * memory / ctx / config。这样别的会话可以给它加能力而**不用改这个文件**。
   * 说明文档：dsh-mc-agent/extensions/README.md
   * ------------------------------------------------------------------------ */

  ctx.effect(() => {
    const dir = fileURLToPath(new URL('./extensions/', import.meta.url))
    if (!existsSync(dir)) return
    let files = []
    try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js')) } catch { return }
    if (!files.length) return
    /* 🔴 2026-10-06（日志优化）：扩展的 `xxx 已加载：…` 是**静态字符串**，每个会话都会重打一遍
     *    （实测 mc_auto 那条 27 次）⇒ 按内容在**进程内**只留一条；其余消息原样透传。 */
    const extLogLine = (m) => {
      const s = String(m ?? '')
      if (/已加载：/.test(s)) { logOnce(`ext:${s.slice(0, 80)}`, s); return }
      logLine(s)
    }
    void (async () => {
      for (const f of files) {
        try {
          const mod = await import(new URL(`./extensions/${f}`, import.meta.url).href)
          if (typeof mod.apply === 'function') {
            await mod.apply({ ctx, config, registry, asTool, getSession, ensureWatchdog, memory, memoryFor, workspaceOf, logLine: extLogLine, Watchdog })
            const label = mod.name ?? f
            logDebug(`扩展已加载：${label}`)
            ctx.logger?.info?.(`[dsh-mc-agent] 扩展已加载：${label}`)
          }
        } catch (e) {
          logLine(`扩展 ${f} 加载失败：${e.message}`)
          ctx.logger?.warn?.(`[dsh-mc-agent] 扩展 ${f} 加载失败：${e.message}`)
        }
      }
    })()
  }, 'dsh-mc-agent: extensions')

  /* ── 诊断 ── */

  /* 开着的容器窗口 + 合成格里的东西。
   * 🔴 为什么要有这个：`bot.inventory.items()` 只列背包+快捷栏（`inventoryStart=9`），
   * **不含合成格**（自己背包的 2×2 在 slot 1~4，工作台的 3×3 在 slot 1~9）。
   * 合成被 11 秒预算掐断时材料就留在格子里 —— 于是"背包里 0 根原木，可我明明有"。
   * 这里把窗口和格子里的东西直接摊出来，一眼就能看见，不用再猜。 */
  const windowView = (b) => {
    const out = {}
    const w = b?.currentWindow
    if (w && w !== b.inventory) {
      out.open = { type: String(w.type ?? '').replace(/^minecraft:/, ''), slots: w.slots?.length ?? null }
      const grid = []
      for (let i = 1; i <= 9; i++) { const it = w.slots?.[i]; if (it?.name) grid.push(`${i}:${it.name}×${it.count}`) }
      if (grid.length) out.grid = grid
      const res = w.slots?.[0]
      if (res?.name) out.result = `${res.name}×${res.count}`
    }
    const g2 = []
    for (let i = 1; i <= 4; i++) { const it = b?.inventory?.slots?.[i]; if (it?.name) g2.push(`${i}:${it.name}×${it.count}`) }
    if (g2.length) out.personalGrid = g2
    if (out.grid || out.personalGrid) {
      out.note = '合成格里有东西：它们在合成格里、`bot.inventory` 看不见（所以会报"缺料"）。'
        + '叫一次 mc_craft 会把格子里的东西退回背包。'
    }
    return Object.keys(out).length ? out : null
  }

  /* audit 2026-10-22（用户：全量审计 + 减少 token 消耗）：mc_diag 两处浪费
   *   1) 断线分支完全无视 only，照样塞 perf / terrainCache / workers 和整份 promptInjection
   *      （实测一次约 5 KB），而断线时 AI 只想知道我在不在线；
   *   2) promptInjection 里的 versionPrompt 同时给 text 和 defaultText，两者一模一样时白白翻倍。
   *   现在：断线分支同样按 only 分节；注入段只给 head（前 120 字）+ chars + sameAsDefault，
   *   想要正文让 AI 自己 read 那个文件（提示词里本来就写了以文件为准）。 */
  function diagSlimInjection (inj) {
    if (!inj || typeof inj !== 'object') return inj
    const out = { ...inj }
    const vp = out.versionPrompt
    if (vp && typeof vp === 'object' && ('text' in vp || 'defaultText' in vp)) {
      const text = String(vp.text ?? '')
      const def = String(vp.defaultText ?? '')
      const slim = { ...vp }
      delete slim.text
      delete slim.defaultText
      slim.head = text.slice(0, 120)
      slim.chars = text.length
      slim.sameAsDefault = text === def
      out.versionPrompt = slim
    }
    return out
  }
  function diagOffline (args, sess, b, injection, perf, terrainCache, workers) {
    const asked = String(args?.only ?? '').split(/[,，s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
    const all = asked.includes('all')
    const want = (k) => all || asked.includes(k)
    const out = {
      online: false, ghost: Boolean(b?.entity) && b?._client?.ended === true,
      lastError: sess.bot.lastError, mode: sess.mode,
      hint: '连接已经结束了（bot.entity 只是 mineflayer 的残留）——要回到游戏里请重新 mc_connect',
    }
    if (want('prompt')) out.promptInjection = diagSlimInjection(injection)
    if (want('perf')) out.perf = perf
    if (want('terrain')) out.terrainCache = terrainCache
    if (want('workers')) out.workers = workers
    const known = ['state', 'perf', 'crafting', 'scheduler', 'watching', 'prompt', 'terrain', 'workers', 'connection']
    if (!all && asked.length) out.availableSections = known
    return out
  }
  ctx.tools.register(asTool({
    name: 'mc_diag',
    /* 🔴 2026-10-17（用户实机：`mc_diag` 一次输出几万字符，AI 只想知道其中一节）：
     *    加 `only` 分节。同时把描述压短腾出 token 预算（`check-token-budget` 只剩几十字符余量）。 */
    description: '诊断：机器人内部状态 + 提示词注入 + 性能（`perf`）。**输出很大** —— 默认只给 state+connection，别的节用 `only` 点名。',
    parameters: {
      only: { type: 'string', description: '只取这几节（逗号分隔）：state/perf/crafting/scheduler/watching/prompt/terrain/workers/connection；`all` = 全给' },
      resetPerf: { type: 'boolean', description: '顺手清空性能样本（换场景重测用）' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      if (args?.resetPerf) perfReset()
      const perf = perfSnapshot()
      // 导航缓存（导航 P2）：命中率低了说明"每次都重扫"，可以据此判断缓存到底有没有用
      const terrainCache = terrainCacheStats(sess.bot.bot)
      const workers = workerPoolStats()
      const injection = promptInjectionStatus(exec?.agent)
      const b = sess.bot.bot
      /* 🔴 审计报告 F3：以前只判 `b?.entity`，不看 `_client.ended` —— 断线后 mineflayer 会留下
       *    `bot.entity` 残影（幽灵在线），于是 mc_diag 报 `online:true` + 一堆陈旧物理量，
       *    而 `status()` / `requireBot()` 都判了 ⇒ 两个工具互相打脸，AI 以为"还能动"，
       *    继续调 mc_move/mc_dig（那些抛"机器人不在线"），**唯独不会去 mc_connect**。
       *    现在和 `status()` 同一套判据（`bot.online`）。 */
      if (!sess.bot.online || !b?.entity) {
        return diagOffline(args, sess, b, injection, perf, terrainCache, workers)
      }
      const full = {
        online: true, version: b.version, physicsEnabled: b.physicsEnabled,
        controlState: { forward: b.controlState?.forward, jump: b.controlState?.jump, sneak: b.controlState?.sneak },
        velocity: b.entity.velocity, onGround: b.entity.onGround,
        /* 🔴 `entity.isInWater` 泡在水柱里会读出 undefined（prismarine-physics 入水 AABB 从底部缩了
         *    0.401）⇒ 再补一个"头在水下"的直判据，别让 AI 排查"我怎么在掉血"时被它带偏。 */
        inWater: b.entity.isInWater,
        submerged: (() => {
          try {
            const eye = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0)
            return /water|lava/.test(String(b.blockAt(eye)?.name ?? ''))
          } catch { return null }
        })(),
        position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
        pendingEvents: sess.events.length, mode: sess.mode, stats: sess.bot.stats,
        terrainCache,
        workers,
        connection: sess.bot.connectionView(),
        crafting: windowView(b),
        /* 统一动作调度器（阶段 P0：只记账）：谁在占什么、撞过几次车。
         * 排查"两个动作互相踩"（合成 / 熔炼 / 开箱子抢同一个窗口、走路被挖矿抢控制位）用。 */
        scheduler: sess.bot.actionSnapshot(),
        watching: sess.watchdog?.status() ?? null,
        promptInjection: diagSlimInjection(injection),
        /* 2026-10-15：性能监测 —— `verdict` 里就是"哪个动作该搬 Worker"的中文结论 */
        perf,
      }
      /* 🔴 2026-10-17：`only` 分节。整份输出动辄几万字符，AI 往往只想知道其中一节
       *    （"我到底在不在水里"/"合成窗口开没开"），全量灌进去纯属烧上下文。
       *    规则：
       *      · 不传 ⇒ 原样全给（向后兼容，老调用行为一个字都没变）；
       *      · 传了 ⇒ 只给点名的节 + **永远**带上 `online`/`version`/`position`/`mode`
       *        （少了这四个，任何结论都没法落地 —— 比如"我是不是还在线"）；
       *      · 认不出的名字不静默丢掉，放进 `unknownSections` 让 AI 自己改。 */
      const ONLY_GROUPS = {
        state: ['physicsEnabled', 'controlState', 'velocity', 'onGround', 'inWater', 'submerged', 'pendingEvents', 'stats'],
        perf: ['perf'],
        crafting: ['crafting'],
        scheduler: ['scheduler'],
        watching: ['watching'],
        prompt: ['promptInjection'],
        terrain: ['terrainCache'],
        workers: ['workers'],
        connection: ['connection'],
      }
      const asked = String(args?.only ?? '').split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
      /* 🔴 2026-10-20 审计（用户："减少 token 消耗"）：以前**不传 `only` ⇒ 原样全给**，
       *    可整份输出上万字符，而 AI 十次里有九次只想知道"我在不在线 / 在不在水里"。
       *    现在缺省只给 `state` + `connection`（这两节回答了绝大多数问题），
       *    并把可选的节名列在 `availableSections` 里 —— AI 看得见还差什么，再点名要。
       *    想要老行为（一次全给）就 `only:"all"`。 */
      if (!asked.length || asked.includes('all')) {
        if (asked.includes('all')) return full
        const def = {}
        const keepDef = new Set(['online', 'version', 'position', 'mode', 'connection',
          ...(ONLY_GROUPS.state ?? [])])
        for (const k of Object.keys(full)) if (keepDef.has(k)) def[k] = full[k]
        def.defaultSections = ['state', 'connection']
        def.availableSections = Object.keys(ONLY_GROUPS)
        def.hint = '默认只给 state + connection；别的节用 only 点名（逗号分隔），要全部就 only:"all"'
        return def
      }
      const keep = new Set(['online', 'version', 'position', 'mode'])
      const unknown = []
      for (const name of asked) {
        const keys = ONLY_GROUPS[name]
        if (keys) { for (const k of keys) keep.add(k); continue }
        if (Object.hasOwn(full, name)) { keep.add(name); continue }
        unknown.push(name)
      }
      const picked = {}
      for (const k of Object.keys(full)) if (keep.has(k)) picked[k] = full[k]
      if (unknown.length) picked.unknownSections = unknown
      return picked
    },
  }))
}

export default { name, inject, Config, apply }
