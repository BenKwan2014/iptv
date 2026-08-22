/**
 * 抓取模块的状态管理：配置持久化、调度、健康记账、频道输出。
 *
 * 平台知识全在 extractors/<id>/，这里只负责「什么时候调 fetch、结果放哪、
 * 失败了怎么办、后台看到什么」。
 *
 * 三层开关，任一层关掉都是「不联网、不出现在播放列表、磁盘数据原样保留、
 * 开回来即恢复」（与 EPG 聚合的三级开关同语义）：
 *   部署级 config.js:enableExtractors  >  文件级 enabled  >  单模块 enabled
 *
 * 两份文件，刻意分开：
 *   extractors.json        用户配置。小、少变、进配置备份白名单。
 *   extractor-cache.json   抓取结果与健康状态。大、每轮都变、不进备份。
 * 外部源那边把 parsedChannels 塞进配置文件，实测两个源就 116KB、每次抓取全量
 * 重写——那是要避开的做法，不是要抄的。
 */
import { existsSync, readFileSync, copyFileSync } from "node:fs"
import { writeJsonFileSync } from "./fileUtil.js"
import { dataPath } from "./paths.js"
import { sanitizeOpts } from "./channelOpts.js"
import { listModules, getModule, sourceIdOf } from "../extractors/registry.js"
import { printBlue, printGreen, printRed, printYellow } from "./colorOut.js"

const CONFIG_FILE = 'extractors.json'
const CACHE_FILE = 'extractor-cache.json'

// 单个模块一轮的墙钟上限。模块内部也该自己设超时，这层是兜底——外部源那边
// 整轮没有任何时间上限，一个慢源能把后面全拖住。
const MODULE_TIMEOUT_MS = 90 * 1000
// 同时跑几个模块。模块自己内部还有并发，这里不需要开大。
const MODULE_CONCURRENCY = 2
// 失败退避上限。外部源那边是 360 分钟，对 2 小时就过期的直播源等于 4 小时纯播不了。
const MAX_BACKOFF_MS = 15 * 60 * 1000
const BASE_BACKOFF_MS = 60 * 1000

function defaultConfig() {
  return { enabled: true, modules: {} }
}

function defaultCache() {
  return { modules: {} }
}

/** 每个模块的健康记录。lastSuccessAt 只表示「上次成功」，永远不许被回拨。 */
function emptyHealth() {
  return {
    status: 'idle',          // idle | ok | empty | failed | risk
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: '',
    consecutiveFailures: 0,
    nextRetryAt: null,
    channelCount: 0,
    skippedCount: 0,
    warnings: [],
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 按 configSchema 校验并归一一份配置。
 *
 * 与外部源那边「整份对象直接写盘、全程无校验」不同：既然模块自带 schema，
 * 就在保存前用它挡住畸形输入，不合法直接拒绝并返回字段级错误，绝不落盘。
 *
 * @param existing 已存的配置。secret 字段收到空串表示「不修改」，而不是「清空」——
 *                 否则后台每次保存表单都会把用户看不见的凭据抹掉。
 */
export function validateConfig(module, input, existing = {}) {
  const errors = []
  const config = {}
  const source = isPlainObject(input) ? input : {}

  for (const field of module.configSchema || []) {
    const key = field.key
    const has = Object.prototype.hasOwnProperty.call(source, key)
    const raw = has ? source[key] : undefined
    const prev = existing[key]

    if (field.type === 'boolean') {
      config[key] = has ? !!raw : (prev !== undefined ? !!prev : !!field.default)
      continue
    }

    if (field.type === 'int') {
      const fallback = prev !== undefined ? prev : field.default
      if (!has || raw === '' || raw === null) { config[key] = fallback; continue }
      const parsed = parseInt(raw, 10)
      if (Number.isNaN(parsed)) {
        errors.push({ key, message: `${field.label}：要填数字` })
        config[key] = fallback
        continue
      }
      if (field.min !== undefined && parsed < field.min) {
        errors.push({ key, message: `${field.label}：不能小于 ${field.min}` })
        config[key] = fallback
        continue
      }
      if (field.max !== undefined && parsed > field.max) {
        errors.push({ key, message: `${field.label}：不能大于 ${field.max}` })
        config[key] = fallback
        continue
      }
      config[key] = parsed
      continue
    }

    // type: 'text'
    const text = typeof raw === 'string' ? raw : (has && raw != null ? String(raw) : '')
    if (field.secret) {
      // 顺序要紧：null 必须先判。它会被上面的 text 计算折成空串，
      // 放在空串分支后面就永远走不到，「显式清空」这条路等于不存在。
      if (raw === null) config[key] = ''
      // 空串 = 保持原值——后台看不见凭据，不能因为保存表单就把它抹掉
      else if (!has || text === '') config[key] = typeof prev === 'string' ? prev : ''
      else config[key] = text.trim()
      continue
    }
    config[key] = has ? text : (typeof prev === 'string' ? prev : (field.default || ''))
  }

  return { ok: errors.length === 0, config, errors }
}

/**
 * 把 schema 里声明了 env 的字段做环境变量兜底。
 *
 * 没有这层的话，docker 用户没法在 compose 里注入凭据（extractors.json 在挂载卷里，
 * 首次部署时还不存在）。让 schema 自己声明变量名，比给每个模块往 config.js 里
 * 加一个全局字段更能扩展——后者每加一个模块就要动五个文件。
 */
export function withEnvFallback(module, config) {
  const merged = { ...config }
  for (const field of module.configSchema || []) {
    if (!field.env) continue
    if (merged[field.key]) continue
    const fromEnv = process.env[field.env]
    if (fromEnv) merged[field.key] = String(fromEnv).trim()
  }
  return merged
}

/**
 * 给后台看的配置：secret 字段一律不回传明文，只回传「有没有值」。
 *
 * 现有的 /api/system-config 是直接明文吐咪咕 token 和访问密码的，而未设访问
 * 密码的部署（默认状态）后台是无鉴权的。新增的凭据不该再走那条路。
 */
export function redactConfig(module, config) {
  const safe = {}
  const secretsSet = {}
  for (const field of module.configSchema || []) {
    if (field.secret) {
      safe[field.key] = ''
      secretsSet[field.key] = !!config[field.key]
      continue
    }
    safe[field.key] = config[field.key]
  }
  return { config: safe, secretsSet }
}

class ExtractorManager {
  constructor() {
    this.configPath = dataPath(CONFIG_FILE)
    this.cachePath = dataPath(CACHE_FILE)
    // 配置文件损坏时置位。置位期间拒绝任何写盘——否则一次后台操作就会把
    // 损坏（被降级成空）的配置覆盖回去，用户的模块配置全没了。
    this.corrupt = null
    this.inFlight = false
    this.config = defaultConfig()
    this.cache = defaultCache()
    this.loaded = false
  }

  // ---- 持久化 ----

  load() {
    this.config = this.#readJson(this.configPath, defaultConfig(), true)
    this.cache = this.#readJson(this.cachePath, defaultCache(), false)
    if (!isPlainObject(this.config.modules)) this.config.modules = {}
    if (!isPlainObject(this.cache.modules)) this.cache.modules = {}
    if (typeof this.config.enabled !== 'boolean') this.config.enabled = true
    this.loaded = true
    return this
  }

  /** configBackupAPI 导入配置后要调它，否则运行态与磁盘分叉。 */
  reload() {
    this.corrupt = null
    return this.load()
  }

  #readJson(filePath, fallback, isConfig) {
    if (!existsSync(filePath)) return fallback
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
      return isPlainObject(parsed) ? parsed : fallback
    } catch (error) {
      if (isConfig) {
        // 保留原文件、另存一份 .corrupt，并把错误暴露到后台。绝不静默降级成
        // 空配置——那样下一次保存就把用户的配置永久覆盖了。
        this.corrupt = { message: error.message, at: Date.now(), path: filePath }
        try { copyFileSync(filePath, `${filePath}.corrupt`) } catch { /* 尽力而为 */ }
        printRed(`抓取模块配置损坏，已保留原文件并另存 ${filePath}.corrupt：${error.message}`)
      } else {
        printYellow(`抓取模块缓存损坏，按空缓存处理：${error.message}`)
      }
      return fallback
    }
  }

  #saveConfig() {
    if (this.corrupt) {
      throw new Error(`配置文件损坏（${this.corrupt.message}），已拒绝写入以免覆盖原数据。请修复或删除 ${this.configPath} 后重试`)
    }
    writeJsonFileSync(this.configPath, this.config)
  }

  /**
   * 写缓存文件。声明 cache:'memory' 的模块只把 groups 留在内存——咪咕那种
   * 「结果大、每轮都变、原始字段全带着」的模块落盘纯属浪费（外部源那边把
   * parsedChannels 塞进配置文件，实测两个源就 116KB）。健康状态仍然落盘，
   * 否则重启后后台就看不到上次抓取结果了。
   */
  #saveCache() {
    const persisted = { modules: {} }
    for (const [id, entry] of Object.entries(this.cache.modules)) {
      const module = getModule(id)
      const memoryOnly = module?.capabilities?.cache === 'memory'
      persisted.modules[id] = memoryOnly
        ? { groups: [], health: entry.health, memoryOnly: true }
        : entry
    }
    writeJsonFileSync(this.cachePath, persisted)
  }

  // ---- 模块状态 ----

  /**
   * 模块是否启用。
   *
   * 模块可以声明 enabledGetter/enabledSetter 把开关代理到别处——收编既有源时
   * 必须这样：咪咕的开关是 config.js 的 enableMigu，被 updateData / channelMerger /
   * app.js 等多处直接 import，不能在 extractors.json 里另开一份，否则两个开关打架。
   */
  isModuleEnabled(module) {
    if (typeof module.enabledGetter === 'function') return !!module.enabledGetter()
    return this.#entry(module.id).enabled
  }

  #setModuleEnabledValue(module, on) {
    if (typeof module.enabledSetter === 'function') {
      module.enabledSetter(!!on)
      return
    }
    this.#entry(module.id).enabled = !!on
  }

  #entry(id) {
    if (!this.config.modules[id]) this.config.modules[id] = { enabled: false, config: {} }
    const entry = this.config.modules[id]
    if (typeof entry.enabled !== 'boolean') entry.enabled = false
    if (!isPlainObject(entry.config)) entry.config = {}
    return entry
  }

  #cacheEntry(id) {
    if (!this.cache.modules[id]) this.cache.modules[id] = { groups: [], health: emptyHealth() }
    const entry = this.cache.modules[id]
    if (!Array.isArray(entry.groups)) entry.groups = []
    if (!isPlainObject(entry.health)) entry.health = emptyHealth()
    return entry
  }

  /** 生效配置：已存的 → 按 schema 补默认 → 环境变量兜底。 */
  effectiveConfig(module) {
    const entry = this.#entry(module.id)
    const { config } = validateConfig(module, entry.config, entry.config)
    return withEnvFallback(module, config)
  }

  refreshMinutesOf(module) {
    const entry = this.#entry(module.id)
    const value = parseInt(entry.refreshMinutes, 10)
    if (Number.isNaN(value) || value < 1) return module.defaultRefreshMinutes || 60
    return value
  }

  // ---- 后台读写 ----

  getState() {
    const modules = listModules().map(module => {
      const entry = this.#entry(module.id)
      const cacheEntry = this.#cacheEntry(module.id)
      const effective = this.effectiveConfig(module)
      const enabled = this.isModuleEnabled(module)
      const { config, secretsSet } = redactConfig(module, effective)
      // 值来自环境变量而非后台时要让用户知道，否则会遇到「后台看着是空的、
      // 但确实在生效」这种没有任何线索的状态
      const envProvided = {}
      for (const field of module.configSchema || []) {
        if (field.env && !entry.config[field.key] && process.env[field.env]) {
          envProvided[field.key] = field.env
        }
      }
      return {
        id: module.id,
        name: module.name,
        description: module.description || '',
        enabled,
        // 开关代理到别处（如咪咕代理到 config.js 的 enableMigu）时告诉前端，
        // 否则用户会在两个地方看到同一个开关而不知道改哪个。
        enabledProxied: typeof module.enabledGetter === 'function',
        configSchema: module.configSchema || [],
        config,
        secretsSet,
        envProvided,
        refreshMinutes: this.refreshMinutesOf(module),
        defaultRefreshMinutes: module.defaultRefreshMinutes || 60,
        health: cacheEntry.health,
      }
    })
    return {
      enabled: this.config.enabled !== false,
      corrupt: this.corrupt,
      modules,
    }
  }

  setEnabled(on) {
    this.config.enabled = !!on
    this.#saveConfig()
    return this.getState()
  }

  setModuleEnabled(id, on) {
    const module = getModule(id)
    if (!module) throw new Error(`未知的抓取模块: ${id}`)
    this.#setModuleEnabledValue(module, on)
    this.#saveConfig()
    return this.getState()
  }

  updateModuleConfig(id, fields, { refreshMinutes } = {}) {
    const module = getModule(id)
    if (!module) throw new Error(`未知的抓取模块: ${id}`)
    const entry = this.#entry(id)
    const { ok, config, errors } = validateConfig(module, fields, entry.config)
    if (!ok) {
      const error = new Error(errors.map(e => e.message).join('；'))
      error.fieldErrors = errors
      throw error
    }
    entry.config = config
    if (refreshMinutes !== undefined) {
      const value = parseInt(refreshMinutes, 10)
      if (Number.isNaN(value) || value < 1 || value > 1440) {
        throw new Error('刷新间隔要在 1~1440 分钟之间')
      }
      entry.refreshMinutes = value
    }
    this.#saveConfig()
    // 配置变了，上一轮的结果不再代表当前配置——清掉「已成功过」的时间戳，
    // 让下一轮 tick 立刻重抓，而不是等到原定的刷新点。
    const cacheEntry = this.#cacheEntry(id)
    cacheEntry.health.lastSuccessAt = null
    cacheEntry.health.nextRetryAt = null
    cacheEntry.health.consecutiveFailures = 0
    this.#saveCache()
    return this.getState()
  }

  // ---- 抓取 ----

  #needsRefresh(module, now) {
    const health = this.#cacheEntry(module.id).health
    if (health.consecutiveFailures > 0 && health.nextRetryAt) return now >= health.nextRetryAt
    if (!health.lastSuccessAt) return true
    return now - health.lastSuccessAt >= this.refreshMinutesOf(module) * 60 * 1000
  }

  /**
   * 记账。健康状态是显式结构，不靠把 lastUpdated 往回拨来编码退避——
   * 那样 UI 上的「上次更新」既不是上次成功也不是上次尝试，谁也看不懂。
   */
  #recordSuccess(id, groups, meta) {
    const entry = this.#cacheEntry(id)
    const count = groups.reduce((sum, group) => sum + (group.dataList?.length || 0), 0)
    entry.groups = groups
    entry.fetchedAt = Date.now()
    entry.health = {
      ...emptyHealth(),
      status: count > 0 ? 'ok' : 'empty',
      lastAttemptAt: entry.fetchedAt,
      lastSuccessAt: entry.fetchedAt,
      channelCount: count,
      skippedCount: meta?.skipped?.length || 0,
      warnings: (meta?.warnings || []).slice(0, 5),
    }
  }

  #recordFailure(id, error) {
    const entry = this.#cacheEntry(id)
    const health = entry.health
    const failures = (health.consecutiveFailures || 0) + 1
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1))
    const now = Date.now()
    entry.health = {
      ...health,
      status: error?.name === 'RiskControlError' ? 'risk' : 'failed',
      lastAttemptAt: now,
      // lastSuccessAt 保持不动——它只表示上次成功
      lastError: String(error?.message || error).slice(0, 300),
      consecutiveFailures: failures,
      nextRetryAt: now + backoff,
    }
    // groups 保留上一轮的结果：抓取失败不该让频道从播放列表里消失。
    // 全局的 0 频道守卫只看总数，咪咕正常时它不会为「某个模块挂了」触发。
  }

  /**
   * 跑一轮。
   * @param {object} options
   *   autoOnly    只跑到点该刷新的（周期 tick 用）
   *   forceAll    忽略节流全跑（后台「立即刷新」用）
   *   onlyId      只跑某一个模块
   * @returns {{updated: boolean, results: Array}}
   */
  async updateAll({ autoOnly = false, forceAll = false, onlyId = null } = {}) {
    if (!this.loaded) this.load()

    // 总开关在抓取入口也要判——外部源那边只在输出处判，后台的「全部更新」
    // 按钮直连 manager 绕过了守卫，功能被全局关掉时照样会联网。
    if (this.config.enabled === false) {
      return { updated: false, results: [], message: '抓取模块已在设置里整体关闭' }
    }

    const targets = listModules().filter(module => {
      if (onlyId && module.id !== onlyId) return false
      if (!this.isModuleEnabled(module)) return false
      if (forceAll || onlyId) return true
      if (autoOnly) return this.#needsRefresh(module, Date.now())
      return true
    })

    if (!targets.length) return { updated: false, results: [] }

    const results = []
    let updated = false

    let cursor = 0
    const runners = Array.from({ length: Math.min(MODULE_CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) {
        const module = targets[cursor++]
        const outcome = await this.#runOne(module)
        if (outcome.success) updated = true
        results.push(outcome)
      }
    })
    await Promise.all(runners)

    this.#saveCache()
    return { updated, results }
  }

  async #runOne(module) {
    const config = this.effectiveConfig(module)
    printBlue(`抓取模块 ${module.name} 更新中...`)
    try {
      const payload = await withTimeout(
        module.fetch(config, { timeoutMs: 10000 }),
        MODULE_TIMEOUT_MS,
        `${module.name} 超过 ${MODULE_TIMEOUT_MS / 1000}s 未返回`,
      )
      const groups = normalizeGroups(payload?.groups)
      this.#recordSuccess(module.id, groups, payload?.meta)
      const health = this.#cacheEntry(module.id).health
      const note = health.skippedCount ? `，跳过 ${health.skippedCount}` : ''
      printGreen(`抓取模块 ${module.name}：${health.channelCount} 个频道${note}`)
      return { id: module.id, name: module.name, success: true, message: `${health.channelCount} 个频道${note}` }
    } catch (error) {
      this.#recordFailure(module.id, error)
      const kept = this.#cacheEntry(module.id).groups.length
      printRed(`抓取模块 ${module.name} 失败：${error.message}${kept ? '（沿用上一轮结果）' : ''}`)
      return { id: module.id, name: module.name, success: false, message: error.message }
    }
  }

  // ---- 输出 ----

  /**
   * 供 channelMerger 合并的频道分组。形状与 externalSources / builtInSources
   * 的 getValidChannels() 同构。
   *
   * 注意读的是缓存而不是现抓：抓取失败时要沿用上一轮结果，否则频道会静默
   * 从播放列表里消失，而全局的 0 频道守卫只看总数、护不住单个模块。
   */
  getValidChannels() {
    if (!this.loaded) this.load()
    if (this.config.enabled === false) return []

    const groupMap = new Map()
    for (const module of listModules()) {
      if (!this.isModuleEnabled(module)) continue
      // 模块可以自己声明 sourceId。收编既有源时必须这样——比如咪咕的归属在
      // 老用户的「按配置档禁用源」配置里存的是字面量 'migu'，改成 'xt:migu'
      // 会让那些设置一次性失配。
      const sourceId = module.sourceId || sourceIdOf(module.id)
      for (const group of this.#cacheEntry(module.id).groups) {
        const name = group?.name || module.name
        if (!groupMap.has(name)) groupMap.set(name, { name, dataList: [] })
        for (const channel of group?.dataList || []) {
          if (!channel?.name) continue
          groupMap.get(name).dataList.push({
            ...channel,
            groupTitle: name,
            opts: sanitizeOpts(channel.opts),
            sourceId,
            // 延迟解析模块（capabilities.resolve）产出 deferredRef 而不是 url，
            // 写盘时落成 ${replace}/<ref>、播放请求到达时才算真实地址。
            // ref 必须是**单个路径段**：buildChannelId 用 /^\$\{replace\}\/([^/?#]+)/
            // 取频道主键，多段会正则失配、让老用户的「我的频道」配置全部作废。
            ...(channel.deferredRef != null ? { deferredRef: String(channel.deferredRef) } : {}),
            // updateData 靠 source 判定写盘分支；模块频道必须有自己的类别，
            // 不能靠「有没有 url」被推断成外部源——那样会被外部源的
            // includeInPlaylists 开关连坐，用户会以为模块坏了。
            source: 'extractor',
          })
        }
      }
    }
    return [...groupMap.values()]
  }

  /** 后台「按配置档禁用源」矩阵要枚举的源。 */
  listSourceIds() {
    return listModules()
      .filter(module => this.isModuleEnabled(module))
      .map(module => ({ id: module.sourceId || sourceIdOf(module.id), name: module.name, type: 'extractor' }))
  }
}

/** 分组结构兜底：模块返回畸形数据不能把整轮合并搞崩。 */
function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return []
  return groups
    .filter(group => isPlainObject(group) && group.name && Array.isArray(group.dataList))
    .map(group => ({ name: String(group.name), dataList: group.dataList.filter(isPlainObject) }))
}

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
  ])
}

// 懒初始化：import 时不碰磁盘，测试可以自己 new 一个不落盘的实例。
// 外部源那个单例在 import 阶段就同步读写磁盘，任何 import 它的测试都会碰盘。
let singleton = null

export function getExtractorManager() {
  if (!singleton) singleton = new ExtractorManager().load()
  return singleton
}

export { ExtractorManager, emptyHealth, normalizeGroups, CONFIG_FILE, CACHE_FILE }
