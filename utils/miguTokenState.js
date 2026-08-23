/**
 * 咪咕 token「上次刷新时间」的持久化。
 *
 * 为什么需要单独存一个时间戳，而不能继续用 updateData 里那个 hours 计数器：
 *
 * hours 是**进程内**的累计运行小时数（app.js 的 `var hours = 0`，只在定时任务里
 * `+= updateInterval`）。原判据 `hours % 720 === 0` 因此有两个方向都错：
 *
 *   · 恒真那一侧：hours 启动时是 0，而 0 % 720 === 0 —— 每次容器启动、启动后头
 *     updateInterval 小时内的每次重新生成、以及后台 8 处 update(0, …) 都会刷。
 *     （已由 shouldRefreshMiguToken 的两道闸挡住。）
 *   · 恒假那一侧：hours 只会落在 updateInterval 的整数倍上。默认 8 能整除 720
 *     （720/8 = 90），但设成 7 / 11 / 13 / 14 这类值时，hours 走
 *     7,14,…,714,721,… 永远碰不到 720 的倍数 —— 月度刷新**从此不再发生**，
 *     token 慢慢过期，VIP 画质静默降档，且没有任何日志提示。
 *
 * 换成墙钟时间戳后两侧都不成立：判据只问「距上次刷新是不是真的过了 30 天」，
 * 与更新间隔取什么值、进程重启过几次都无关。
 *
 * 存成独立的小文件而不是塞进 extractor-cache.json：那份缓存对 memory 型模块
 * （咪咕正是）只持久化 { groups: [], health, memoryOnly }，其余字段会被
 * #saveCache 静默丢掉，想加字段得先改它的序列化，牵动面大得多。
 * 也不塞 system-config.json —— 那是用户配置，不该混进运行时状态。
 *
 * 刻意**不**加入 configBackupAPI 的 FIXED_FILES 白名单：它是派生的运行时状态，
 * 与 extractor-cache.json 同类。换机恢复备份后从零重新计时，代价只是多等一个
 * 周期，不会多打任何请求；反过来，把它带进备份会让「导入一份旧备份」直接
 * 触发一次刷新。
 */
import { existsSync, readFileSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { printYellow } from "./colorOut.js"

const STATE_PATH = dataPath('migu-token-state.json')

/** 刷新周期：30 天。原实现写的是 720 小时，同一个数。 */
export const MIGU_TOKEN_REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 落盘失败时的进程内兜底。
 *
 * 数据目录只读、磁盘满、权限不对时 writeJsonFileSync 会抛。若不兜住，每一轮
 * 定时更新都会读到「没有记录」→ 重新计时 → 永远刷不到；更糟的是如果哪天把
 * 「没有记录就刷一次」作为默认，会退化成每轮都刷。用进程内变量至少保证
 * 单个进程生命周期内的行为是对的，并把写失败**明确打出来**——静默失败正是
 * 这类问题最难查的地方。
 */
let memoryState = null

/**
 * 读取状态。文件不存在 / 损坏 / 读不动都返回 { lastRefreshAt: null }，
 * 由调用方决定「没有记录」时怎么办（当前策略是开始计时、本轮不刷）。
 *
 * @returns {{ lastRefreshAt: number|null }}
 */
export function readMiguTokenState() {
  if (memoryState) return memoryState
  try {
    if (!existsSync(STATE_PATH)) return { lastRefreshAt: null }
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    const at = Number(raw?.lastRefreshAt)
    // 未来时间同样按「无记录」处理：系统时钟被拨回去过（NAS 掉电后 RTC 不准很常见），
    // 留着一个未来的时间戳会让刷新被无限期推迟。
    if (!Number.isFinite(at) || at <= 0 || at > Date.now()) return { lastRefreshAt: null }
    return { lastRefreshAt: at }
  } catch {
    return { lastRefreshAt: null }
  }
}

/**
 * 记下「刚刚刷过」或「从现在开始计时」。
 *
 * @param {number} at 时间戳（毫秒）
 */
export function markMiguTokenRefreshed(at) {
  const state = { lastRefreshAt: at }
  memoryState = state
  try {
    writeJsonFileSync(STATE_PATH, state)
  } catch (error) {
    printYellow(`咪咕 token 刷新时间写盘失败（${error.message}），本次仅记在内存里；重启后会重新计时`)
  }
  return state
}

/** 仅供测试：清掉进程内兜底，让下一次 read 真的去读文件。 */
export function __resetMiguTokenStateCache() {
  memoryState = null
}
