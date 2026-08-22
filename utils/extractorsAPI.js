/**
 * 抓取模块管理 API —— 后台「源模块」板块的读写。
 *
 * 形态照 utils/epgSourcesAPI.js：每个操作都返回 { success, data: 整份最新状态 }，
 * 前端拿到就整体重渲染，不做增量补丁——省掉「前端副本已过期、整份 POST 把
 * 服务端新数据回滚成打开页面时的旧值」那类问题（外部源那边为此打过补丁）。
 *
 * 凭据不回传明文：getState() 里 secret 字段只回 hasValue。未设访问密码的部署
 * 后台是无鉴权的，别把新增的凭据也做成明文可读。
 */
import { getExtractorManager } from "./extractorManager.js"
import { updateExtractors } from "./channelMerger.js"
import update from "./updateData.js"
import { printRed } from "./colorOut.js"

/**
 * 触发一次播放列表重新生成，让开关即时反映到 /m3u。
 *
 * /m3u 吐的是预生成的 interface.txt，光改内存态不重生成的话，关掉的模块的频道
 * 还会留在播放列表里，直到下一轮定时更新——与「关掉即不出现在播放列表」不符。
 *
 * hours 传 1 而不是 0：updateTV 里 `if (enableMigu && !(hours % 720))` 会顺带打
 * 一次咪咕 token 刷新，而 0 % 720 === 0 恒真。那本该是每月一次的动作
 * （config.js 原注释：可能是导致封号的原因），不该被一次点开关带出来。
 * regenerateOnly 的早退在这段之前，护不住它。
 *
 * fire-and-forget：不阻塞响应；update() 内部有串行队列，并发安全。
 */
function regeneratePlaylist() {
  update(1, { regenerateOnly: true })
    .catch(error => printRed(`抓取模块变更后重新生成播放列表失败: ${error.message}`))
}

function ok(manager) {
  return { success: true, data: manager.getState() }
}

function fail(error) {
  const result = { success: false, message: error?.message || String(error) }
  if (error?.fieldErrors) result.fieldErrors = error.fieldErrors
  return result
}

/** 整份状态：模块清单 + 各自的开关/配置/健康。 */
export function getExtractorsAPI() {
  try {
    return ok(getExtractorManager())
  } catch (error) {
    return fail(error)
  }
}

/** 文件级总开关（部署级的 enableExtractors 在系统设置里，是更外面一层）。 */
export function setExtractorsEnabledAPI(enabled) {
  try {
    const manager = getExtractorManager()
    manager.setEnabled(enabled)
    regeneratePlaylist()
    return ok(manager)
  } catch (error) {
    return fail(error)
  }
}

/** 单模块开关。 */
export function setExtractorEnabledAPI(id, enabled) {
  try {
    const manager = getExtractorManager()
    manager.setModuleEnabled(id, enabled)
    // 开关改变的是「已抓到的频道要不要出现」，用缓存重生成即可，不必重抓
    regeneratePlaylist()
    return ok(manager)
  } catch (error) {
    return fail(error)
  }
}

/** 保存单模块配置。校验不过直接拒绝并返回字段级错误，不落盘。 */
export function updateExtractorConfigAPI(id, config, refreshMinutes) {
  try {
    const manager = getExtractorManager()
    manager.updateModuleConfig(id, config, { refreshMinutes })
    return ok(manager)
  } catch (error) {
    return fail(error)
  }
}

/**
 * 立即抓一次。
 *
 * 抓取可能是数十秒（模块级墙钟上限 90s），HTTP 请求不等它——立即返回，
 * 前端靠轮询 GET 看 health 变化。否则后台按钮会转很久，用户以为卡死。
 */
export function runExtractorNowAPI(id) {
  const manager = getExtractorManager()
  try {
    if (!manager.getState().modules.some(m => m.id === id)) {
      return { success: false, message: `未知的抓取模块: ${id}` }
    }
  } catch (error) {
    return fail(error)
  }

  // fire-and-forget。这里刻意不 await，也不能让它的异常冒泡成未处理拒绝。
  // 抓完要重生成播放列表，否则新地址要等到下一轮定时更新才写进 /m3u。
  updateExtractors({ onlyId: id, forceAll: true })
    .then(() => regeneratePlaylist())
    .catch(error => printRed(`抓取模块 ${id} 手动刷新失败: ${error.message}`))

  return { success: true, data: manager.getState(), message: '已开始刷新，稍后刷新页面查看结果' }
}
