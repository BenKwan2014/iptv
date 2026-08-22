import externalSourceManager from "./externalSources.js"
import builtInSourceManager from "./builtInSources.js"
import { getExtractorManager } from "./extractorManager.js"
import { enableExtractors } from "../config.js"
import { printBlue, printGreen, printYellow, printRed } from "./colorOut.js"

// 频道的「主来源」标识（issue #29/#68 按档过滤源）：
// 外部/内置/抓取模块的频道在 getValidChannels 里带上 sourceId（ext:<id> / bi:<id> / xt:<id>），
// 咪咕频道无 sourceId、以 pID 隐式识别。
function primarySourceId(ch) {
  return ch.sourceId || (ch.pID != null ? 'migu' : '')
}

// 分组内去重（纯函数，供测试）：name + 播放地址 完全相同只留第一个；
// 命中重复时把归属并入保留者的 sourceIds 并集——同一频道多个源提供时，按档禁用其一不误删（issue #29/#68）。
function dedupeAllChannels(allChannels) {
  let removed = 0
  for (const group of allChannels) {
    const seen = new Map()
    const kept = []
    for (const ch of group.dataList) {
      const urlKey = ch.url || ch.playURL || (ch.pID != null ? `migu:${ch.pID}` : '')
      const key = `${(ch.name || '').trim().toLowerCase()} ${urlKey}`
      const prev = seen.get(key)
      if (prev) {
        removed++
        const sid = primarySourceId(ch)
        if (sid) {
          if (!Array.isArray(prev.sourceIds)) {
            const own = primarySourceId(prev)
            prev.sourceIds = own ? [own] : []
          }
          if (!prev.sourceIds.includes(sid)) prev.sourceIds.push(sid)
          for (const extra of (ch.sourceIds || [])) {
            if (!prev.sourceIds.includes(extra)) prev.sourceIds.push(extra)
          }
        }
        continue
      }
      seen.set(key, ch)
      kept.push(ch)
    }
    group.dataList = kept
  }
  return removed
}

/**
 * 获取所有频道数据（咪咕 + 外部源）
 * @param {Object} options - 选项
 * @param {boolean} options.skipMigu - 跳过咪咕数据获取
 * @param {boolean} options.useCachedMigu - 使用缓存的咪咕数据（用于仅更新外部源时）
 */
async function getAllChannels() {
  try {
    // 抓取模块（咪咕也在其中）。读的是模块缓存而非现抓——抓取失败时沿用上一轮
    // 结果，否则频道会静默从播放列表消失（全局的 0 频道守卫只看总数，护不住
    // 单个模块）。缓存冷时 ensureWarm 现抓一次：cache:'memory' 的模块重启后
    // 缓存是空的，而 regenerateOnly 那轮不触发抓取。
    const extractorManager = getExtractorManager()
    await extractorManager.ensureWarm()
    const extractorChannels = extractorManager.getValidChannels()

    // 获取外部源频道
    const externalChannels = externalSourceManager.getValidChannels()
    
    // 获取内置源频道
    const builtInChannels = builtInSourceManager.getValidChannels()

    // 合并数据：抓取模块（咪咕居首）+ 内置源 + 外部源
    // 组内去重保留先入者，所以打底的顺序即优先级——咪咕在注册表 MODULES 里
    // 排第一，其频道的优先级与收编前一致。
    const allChannels = extractorChannels.map(group => ({
      ...group,
      dataList: [...group.dataList]
    }))
    
    // 先合并内置源
    // 注意：内置源频道用 playURL 字段，不能在此补 url —
    // 下游 updateData.js 用 `!!channelItem.url` 判定外部源，补 url 会让内置源被误判为外部源。
    const tagBuiltIn = channel => ({
      ...channel,
      source: 'built-in'
    })
    builtInChannels.forEach(builtInGroup => {
      const existingGroup = allChannels.find(group => group.name === builtInGroup.name)

      if (existingGroup) {
        existingGroup.dataList.push(...builtInGroup.dataList.map(tagBuiltIn))
      } else {
        allChannels.push({
          ...builtInGroup,
          source: 'built-in',
          dataList: builtInGroup.dataList.map(tagBuiltIn)
        })
      }
    })
    
    // 再合并外部源
    externalChannels.forEach(externalGroup => {
      const existingGroup = allChannels.find(group => group.name === externalGroup.name)
      
      if (existingGroup) {
        existingGroup.dataList.push(...externalGroup.dataList.map(channel => ({
          ...channel,
          source: 'external'
        })))
      } else {
        allChannels.push({
          ...externalGroup,
          source: 'external',
          dataList: externalGroup.dataList.map(channel => ({
            ...channel,
            source: 'external'
          }))
        })
      }
    })
    
    // 频道级去重：同一分组内，name + 播放地址 完全相同的频道只保留第一个
    // （合并顺序为 咪咕 > 内置 > 外部 > 抓取模块，因此优先保留更高优先级的来源）
    // 只移除完全重复的条目，名称相同但地址不同的频道予以保留
    const dedupRemoved = dedupeAllChannels(allChannels)
    if (dedupRemoved > 0) {
      printYellow(`频道去重：移除 ${dedupRemoved} 个分组内完全重复的频道`)
    }

    const externalCount = externalChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    const builtInCount = builtInChannels.reduce((sum, group) => sum + group.dataList.length, 0)
    // 咪咕现在是抓取模块之一，按归属拆开统计，日志格式与收编前保持一致
    let miguCount = 0
    let extractorCount = 0
    for (const group of extractorChannels) {
      for (const channel of group.dataList) {
        if (channel.sourceId === 'migu') miguCount++
        else extractorCount++
      }
    }

    printGreen(`频道数据获取完成: 咪咕 ${miguCount} 个，内置源 ${builtInCount} 个，外部源 ${externalCount} 个，抓取模块 ${extractorCount} 个`)

    return allChannels
    
  } catch (error) {
    printRed(`获取频道数据失败: ${error.message}`)
    // 合并环节出错时至少返回抓取模块的缓存（咪咕在其中）。
    // 注意不能直接返回 fetchList 的裸数据——那份没有 deferredRef，写盘会变成
    // ${replace}/undefined，比少几个频道糟糕得多。
    try {
      return getExtractorManager().getValidChannels()
    } catch (fallbackError) {
      printRed(`抓取模块缓存也不可用: ${fallbackError.message}`)
      return []
    }
  }
}

/**
 * 更新外部源
 * @param {Object} options - 更新选项
 * @param {boolean} options.autoOnly - 仅更新设置了自动刷新的源（默认true）
 * @param {boolean} options.forceAll - 强制更新所有源
 * @param {boolean} options.startupMode - 启动模式，仅更新设置了updateOnStartup的源
 */
async function updateExternalSources(options = {}) {
  const { autoOnly = true, forceAll = false, startupMode = false } = options
  
  if (!externalSourceManager.sources.enabled) {
    return { success: true, message: "外部源已禁用" }
  }

  if (!externalSourceManager.sources.sources || externalSourceManager.sources.sources.length === 0) {
    return { success: true, message: "未配置外部源" }
  }
  
  const results = await externalSourceManager.updateAllSources({ autoOnly, forceAll, startupMode })
  
  const successful = results.filter(r => r.success).length
  const total = results.length
  
  if (results.length === 0) {
    return { success: true, message: "无需更新" }
  }
  
  if (successful === total) {
    return { success: true, results }
  } else if (successful > 0) {
    return { success: true, results, partial: true }
  } else {
    return { success: false, results }
  }
}

/**
 * 更新内置源（需要抓取的）
 * @param {Object} options - 更新选项
 * @param {boolean} options.startupMode - 启动模式，仅更新updateOnStartup=true的源
 * @param {boolean} options.forceAll - 强制更新所有抓取源
 */
async function updateBuiltInSources(options = {}) {
  return await builtInSourceManager.updateFetchSources(options)
}

/**
 * 更新抓取模块
 *
 * 返回值形状与 updateExternalSources 一致（success / results / partial），
 * 好让 app.js 的定时器和后台按钮用同一套归类逻辑。
 * @param {Object} options - { autoOnly, forceAll, onlyId }
 */
async function updateExtractors(options = {}) {
  // 这里刻意不判 enableExtractors：判定在 extractorManager.isModuleEnabled 里，
  // 因为代理开关的模块（咪咕听 enableMigu）要绕过子系统总开关。
  const { updated, results, message } = await getExtractorManager().updateAll(options)
  if (message) return { success: true, message }
  if (!results.length) return { success: true, message: "无需更新" }

  const successful = results.filter(r => r.success).length
  if (successful === results.length) return { success: true, results, updated }
  if (successful > 0) return { success: true, results, partial: true, updated }
  return { success: false, results, updated }
}

/**
 * 获取外部源统计信息
 */
function getExternalSourceStats() {
  return externalSourceManager.getConfig()
}

export {
  getAllChannels,
  updateExternalSources,
  updateBuiltInSources,
  updateExtractors,
  getExternalSourceStats,
  externalSourceManager,
  builtInSourceManager,
  dedupeAllChannels,
  primarySourceId
}