/**
 * 挖方块审计（只记录，不改行为）。
 *
 * 为什么要有它：2026-11-05 用户反复报「allowdig 中途改挖阶梯 / 换个方向挖」，
 * 而我们能挖的入口有 **8 处以上**（`climbUp` 的斜上两格与头顶、`carveStepAhead`、
 * 脱困阶梯的 `breakAhead`/`clearHead`/`detour`、`mc_dig` 的 digStair 主挖……），
 * 外加 **vendor A\* 自己的 `toBreak`**（`allowDig:true` 时 `canDig` 是开的，它会在
 * 规划出的路径上自己挖）—— 那一处我们**没有任何日志**。
 * 于是"这一格是谁挖的"永远只能猜。
 *
 * 这个模块把 `bot.dig` 包一层：记下「谁（文件:行）挖了哪一格、什么方块」。
 * 结果里透出 `digLog`，一次实机就能定位到具体那条路径。
 *
 * 绑定方式：`bot.__mcDigAuditCtl` 单例（重复调用只 reset，不重复包装）。
 */

export const DIG_LOG_MAX = 40

export function startDigAudit (bot) {
  try {
    const prev = bot?.__mcDigAuditCtl
    if (prev) { prev.reset(); return prev }
    const orig = bot?.dig
    if (typeof orig !== 'function') return null
    const log = []
    const callerOf = () => {
      try {
        const st = String(new Error().stack ?? '').split('\n')
        for (let i = 2; i < st.length && i < 8; i++) {
          const m = /([\w.\-\\/]+\.(?:mjs|js)):(\d+):(\d+)/.exec(st[i])
          if (!m) continue
          const f = m[1].split(/[\\/]/).pop()
          /* 跳过包装层自己 */
          if (f === 'dig-audit.mjs') continue
          return `${f}:${m[2]}`
        }
      } catch {}
      return 'unknown'
    }
    const wrapped = function (blk, ...rest) {
      try {
        if (log.length < DIG_LOG_MAX) {
          const p = blk?.position
          log.push({
            by: callerOf(),
            cell: p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?',
            name: String(blk?.name ?? '?'),
          })
        }
      } catch {}
      return orig.call(this, blk, ...rest)
    }
    wrapped.__mcDigAudit = true
    bot.dig = wrapped
    const ctl = {
      reset () { log.length = 0 },
      peek: () => log.slice(),
      /** 汇总：按调用者聚合，`vendor:index.js:551` 一条就说明是 A* 自己挖的 */
      summary: () => {
        const by = {}
        for (const r of log) by[r.by] = (by[r.by] ?? 0) + 1
        return { n: log.length, by, rows: log.slice(-12) }
      },
      stop () {
        try { if (bot.dig === wrapped) { bot.dig = orig; delete bot.__mcDigAuditCtl } } catch {}
      },
    }
    bot.__mcDigAuditCtl = ctl
    return ctl
  } catch {
    return null
  }
}
