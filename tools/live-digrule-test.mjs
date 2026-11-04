// -*- coding: utf-8 -*-
/** 临时验证：walkDigDetourMax 把"绕 vs 挖"分在哪（用完即删） */
import { createRequire } from 'node:module'
import { McBot, DEFAULTS } from '../src/core.mjs'
import { sleep } from '../src/async-util.mjs'

const arg = (k, d = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const PER = Number(arg('per', '16'))
const ONLY = arg('only', '')
const NAME = arg('user', 'DeepSeekLive777')
const req = createRequire('C:/Users/BLUE/.dsh/profiles/desktop/vendor/mc-deps/node_modules/')
const Vec3 = req('vec3')

const MC = new McBot({ ...DEFAULTS, walkDigDetourMax: PER, instanceId: 'detour', logFile: 'tmp-detour.log' })
const say = (c) => { try { MC.bot?.chat(c) } catch {} }
const fill = (x1, y1, z1, x2, y2, z2, blk) => say(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${blk}`)
const posOf = () => MC.bot.entity.position.floored()
const xyz = (p) => `${p.x},${p.y},${p.z}`

const C = { x: 3100, y: 120, z: 3100 }
const START = { x: C.x + 0.5, y: C.y, z: C.z + 0.5 }
const TGT = new Vec3(C.x + 12, C.y, C.z)
const WALL_X = C.x + 6
let WALL_T = 1
let dug = 0
let dugList = []

function hookDig () {
  MC.bot.on('blockUpdate', (oldB, newB) => {
    try {
      const wasSolid = oldB && oldB.boundingBox === 'block'
      const isAir = newB && (newB.name === 'air' || newB.name === 'cave_air')
      if (!wasSolid || !isAir) return
      const p = oldB.position
      const inWall = p.x >= WALL_X - 1 && p.x <= WALL_X + WALL_T && p.y >= C.y - 1 && p.y <= C.y + 4 && p.z >= C.z - 31 && p.z <= C.z + 31
      if (!inWall) return
      dug++
      if (dugList.length < 12) dugList.push(`${oldB.name}@${p.x},${p.y},${p.z}`)
    } catch {}
  })
}

async function clearArena () {
  fill(C.x - 2, C.y, C.z - 30, C.x + 18, C.y + 6, C.z + 30, 'air')
  await sleep(450)
  fill(C.x - 2, C.y - 1, C.z - 30, C.x + 18, C.y - 1, C.z + 30, 'stone')
  await sleep(800)
}
async function buildWall (thick, d) {
  WALL_T = thick
  fill(WALL_X, C.y, C.z - d, WALL_X + thick - 1, C.y + 3, C.z + d, 'stone')
  await sleep(800)
}
async function backToStart () {
  say(`/tp ${NAME} ${START.x} ${START.y} ${START.z}`)
  await sleep(1000)
}

const CASES = [
  { name: 'thin-short', thick: 1, d: 4, note: '细墙(挖2格)、绕~10' },
  { name: 'thick-short', thick: 3, d: 5, note: '三格厚(挖6格)、绕~14' },
  { name: 'thin-mid', thick: 1, d: 8, note: '细墙(挖2格)、绕~18' },
  { name: 'thick-mid', thick: 2, d: 8, note: '两格厚(挖4格)、绕~18' },
  { name: 'thin-long', thick: 1, d: 19, note: '细墙、绕~40' },
  { name: 'thick-long', thick: 2, d: 19, note: '两格厚、绕~40' }
]

async function main () {
  await MC.connect({ host: '192.168.1.101', port: 25565, auth: { mode: 'offline', name: NAME } })
  for (let i = 0; i < 40 && !MC.bot?.entity; i++) await sleep(500)
  if (!MC.bot?.entity) throw new Error('连不上服务器')
  await sleep(1500)
  say('/gamerule sendCommandFeedback false')
  say('/clear')
  say(`/give ${NAME} minecraft:netherite_pickaxe`)
  await sleep(800)
  hookDig()
  await clearArena()
  await backToStart()
  console.log(`perBlock=${PER} 起点 ${xyz(START)} 目标 ${xyz(TGT)}`)
  for (const c of CASES) {
    if (ONLY && !ONLY.split(',').includes(c.name)) continue
    await clearArena()
    await buildWall(c.thick, c.d)
    await backToStart()
    dug = 0; dugList = []
    const t1 = Date.now()
    let res = null
    try { res = await MC.walkTo(TGT, { budget: 10500, arrive: 1.0, intent: 'stand', allowDig: true, noTower: true }) } catch (e) { console.log(`  ${c.name} 抛错：${e?.message ?? e}`) }
    const ms = Date.now() - t1
    const end = posOf()
    const dist = Math.hypot(end.x - TGT.x, end.z - TGT.z)
    const verdict = dug === 0 ? '绕过墙(没挖)' : `挖穿(墙里挖了 ${dug} 格)`
    console.log(`\n■ ${c.name}(${c.note}) ${ms}ms 到=${res?.arrived === true} 距目标 ${dist.toFixed(1)} => ${verdict}`)
    if (dugList.length) console.log(`   挖了：${dugList.join('  ')}`)
    try { console.log('   RES=' + JSON.stringify(res).slice(0, 1200)) } catch {}
    try { const V = Vec3; const names = [] ; for (const y of [C.y, C.y+1, C.y+2, C.y+3]) names.push(`y${y}=` + (MC.bot.blockAt(new V(WALL_X, y, C.z))?.name ?? 'null')); console.log('   墙当前：' + names.join(' ')) } catch (e) { console.log('   墙读取失败', e.message) }
    console.log(`   [detour] safeOrBreak 调用=${globalThis.__safeCalls || 0} 真挖=${globalThis.__safeReal || 0} 加价次数=${globalThis.__detourHits || 0} 累计=${globalThis.__detourAdd || 0}`)
  }
  try { await MC.disconnect?.('验证结束') } catch {}
  await sleep(300)
  process.exit(0)
}
main().catch((e) => { console.error('DETOUR FAIL', e); process.exit(1) })
