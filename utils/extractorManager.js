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
import { enableExtractors } from "../config.js"

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
/**
 * 校验用户提交的配置，产出**要落盘的稀疏配置**。
 *
 * 「稀疏」是关键：只保存用户显式设过的字段，没设过的一律不写。
 * 原先存的是补齐默认值后的全量 key，于是「这个字段用户配过没有」这个状态在存储里
 * 表达不出来——导致 env 兜底对布尔字段永远失效（default:true 恒为真值就跳过 env），
 * 也导致判据没法用 hasOwnProperty（存过一次配置后每个 key 都在）。
 * 稀疏之后取值分三层：已存 → 环境变量 → schema 默认（见 resolveConfig）。
 *
 * @param stored 已落盘的稀疏配置。secret 字段收到空串表示「不修改」而非「清空」——
 *               后台看不见凭据，不能因为保存表单就把它抹掉；显式传 null 才是清空。
 * @returns {{ok: boolean, config: object, errors: Array}} config 是要落盘的稀疏配置
 */
export function validateConfig(module, input, stored = {}) {
  const errors = []
  const config = {}
  const source = isPlainObject(input) ? input : {}

  for (const field of module.configSchema || []) {
    const key = field.key
    const has = Object.prototype.hasOwnProperty.call(source, key)
    const raw = has ? source[key] : undefined
    const kept = stored[key]              // 已存的值；undefined 表示「没配过」

    // 没提交这个字段：保持原样（存过就留着，没存过就仍然不存）
    if (!has) {
      if (kept !== undefined) config[key] = kept
      continue
    }

    if (field.type === 'boolean') {
      // 布尔显式提交就存，true / false 都算「配过」——这正是稀疏存储换来的能力
      config[key] = !!raw
      continue
    }

    if (field.type === 'select') {
      const allowed = (field.options || []).map(o => String(o.value))
      const text = raw == null ? '' : String(raw)
      if (text === '') {
        if (kept !== undefined) config[key] = kept
        continue
      }
      if (!allowed.includes(text)) {
        errors.push({ key, message: `${field.label}：不是可选值之一` })
        if (kept !== undefined) config[key] = kept
        continue
      }
      config[key] = coerceSelect(field, text)
      continue
    }

    if (field.type === 'int') {
      if (raw === '' || raw === null) {
        // 清空 = 回到「没配过」，交给 env / 默认值
        continue
      }
      const parsed = parseInt(raw, 10)
      const keepOrDrop = () => { if (kept !== undefined) config[key] = kept }
      if (Number.isNaN(parsed)) {
        errors.push({ key, message: `${field.label}：要填数字` })
        keepOrDrop(); continue
      }
      if (field.min !== undefined && parsed < field.min) {
        errors.push({ key, message: `${field.label}：不能小于 ${field.min}` })
        keepOrDrop(); continue
      }
      if (field.max !== undefined && parsed > field.max) {
        errors.push({ key, message: `${field.label}：不能大于 ${field.max}` })
        keepOrDrop(); continue
      }
      config[key] = parsed
      continue
    }

    // type: 'text'
    const text = typeof raw === 'string' ? raw : (raw != null ? String(raw) : '')
    if (field.secret) {
      // 顺序要紧：null 必须先判。它会被上面的 text 计算折成空串，
      // 放在空串分支后面就永远走不到，「显式清空」这条路等于不存在。
      if (raw === null) continue                       // 清空 = 回到没配过
      if (text === '') { if (kept !== undefined) config[key] = kept; continue }
      config[key] = text.trim()
      continue
    }
    if (text === '') {
      // 文本清空 = 回到没配过（与 config.js 里字符串项用 `||` 回落 env 的语义一致）
      continue
    }
    config[key] = text
  }

  return { ok: errors.length === 0, config, errors }
}

/** select 的值按 options 声明的原始类型还原（下拉提交上来的都是字符串）。 */
function coerceSelect(field, text) {
  const hit = (field.options || []).find(o => String(o.value) === text)
  return hit ? hit.value : text
}

/**
 * 取生效配置：已存 → 环境变量 → schema 默认，逐字段分层。
 *
 * 这是稀疏存储换来的东西——「没配过」现在是个明确状态，所以 env 兜底对布尔和
 * 整数也能正确工作了（原先 default:true 的布尔恒为真值，env 永远读不到）。
 */
export function resolveConfig(module, stored = {}) {
  const effective = {}
  for (const field of module.configSchema || []) {
    const key = field.key
    if (stored[key] !== undefined) { effective[key] = stored[key]; continue }
    if (field.env) {
      const fromEnv = process.env[field.env]
      if (fromEnv !== undefined && fromEnv !== '') {
        effective[key] = coerceEnvValue(field, fromEnv)
        continue
      }
    }
    effective[key] = field.default
  }
  return effective
}


/**
 * env 字符串按字段类型归一。
 *
 * 目前只有 text/secret 能声明 env，所以走到的永远是最后一行；boolean/int 那两个分支
 * 是兜底——万一将来放开限制，也绝不能像原来那样把字符串 "false"（真值！）直接塞进
 * 布尔字段，那会让「显式关掉」变成「强制打开」。
 */
function coerceEnvValue(field, raw) {
  const text = String(raw).trim()
  if (field.type === 'boolean') {
    // 与 config.js 的 parseBool 同款语义：只有明确的 false/0/no 才算假
    return !/^(false|0|no|off)$/i.test(text)
  }
  if (field.type === 'int') {
    const parsed = parseInt(text, 10)
    return Number.isNaN(parsed) ? field.default : parsed
  }
  if (field.type === 'select') {
    const hit = (field.options || []).find(o => String(o.value) === text)
    return hit ? hit.value : field.default
  }
  return text
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
    // 迁移的来源。做成实例字段是为了能被测试覆盖——否则测试会去读真实的
    // system-config.json（dataPath 默认是 cwd，跑测试时就是仓库根目录）。
    this.legacyConfigPath = dataPath('system-config.json')
    // 配置文件损坏时置位。置位期间拒绝任何写盘——否则一次后台操作就会把
    // 损坏（被降级成空）的配置覆盖回去，用户的模块配置全没了。
    this.corrupt = null
    this.inFlight = false
    this.config = defaultConfig()
    this.cache = defaultCache()
    this.loaded = false
    // 本进程内已经尝试抓过的模块。ensureWarm 的判据必须是「这个进程还没抓过」，
    // 不能是「历史上没成功过」——cache:'memory' 的模块 groups 不落盘、health 落盘，
    // 重启后就是「groups 空 + lastSuccessAt 有值」，用后者判会把真正需要兜底的
    // 场景整个挡掉（实测：设了 updateOnStartup=false 的用户重启后一次重生成，
    // 175 条咪咕频道整批从播放列表消失）。
    this.attempted = new Set()
  }

  // ---- 持久化 ----

  load() {
    this.config = this.#readJson(this.configPath, defaultConfig(), true)
    this.cache = this.#readJson(this.cachePath, defaultCache(), false)
    if (!isPlainObject(this.config.modules)) this.config.modules = {}
    if (!isPlainObject(this.cache.modules)) this.cache.modules = {}
    if (typeof this.config.enabled !== 'boolean') this.config.enabled = true
    this.loaded = true
    // 放在 load() 而不是启动流程里：配置导入会调 reload()，用户导入一份「搬家之前
    // 导出的备份」时，包里 extractors.json 没有这些字段、system-config.json 有，
    // 那时也必须搬一次，否则导入完就是当场降档。
    this.#migrateLegacyConfig()
    return this
  }

  /**
   * 把模块声明的 legacySystemConfigKeys 从 system-config.json 一次性搬进
   * extractors.json。幂等（靠 config.migrated 标记）、只搬文件里真有的键。
   *
   * 刻意直接读 system-config.json 原文而不是 config.js 的导出值——后者已经把
   * 环境变量合并进去了，搬过来等于把 mrateType=4 固化成文件值，用户改 compose
   * 就再也不生效。只搬文件里真有的，纯 env 部署什么都不写，env 继续 live 生效。
   */
  #migrateLegacyConfig() {
    if (this.corrupt) return
    const migrated = isPlainObject(this.config.migrated) ? this.config.migrated : {}
    const pending = listModules().filter(m =>
      (m.legacySystemConfigKeys || []).length && !migrated[m.id])
    if (!pending.length) return

    let legacy = null
    try {
      legacy = existsSync(this.legacyConfigPath)
        ? JSON.parse(readFileSync(this.legacyConfigPath, 'utf-8'))
        : {}
    } catch (error) {
      // 读不动就这轮不迁，不打标记——下次启动再试，绝不因为读失败就当作「迁过了」
      printYellow(`旧配置读取失败，本轮跳过迁移（下次启动重试）：${error.message}`)
      return
    }
    if (!isPlainObject(legacy)) legacy = {}

    let changed = false
    for (const module of pending) {
      const entry = this.#entry(module.id)
      const moved = []
      for (const key of module.legacySystemConfigKeys) {
        // 只搬「旧文件里真有」且「模块这边还没配过」的
        if (legacy[key] === undefined) continue
        if (entry.config[key] !== undefined) continue
        entry.config[key] = legacy[key]
        moved.push(`${key}=${JSON.stringify(legacy[key])}`)
      }
      migrated[module.id] = true
      changed = true
      if (moved.length) {
        printGreen(`${module.name} 的配置已从系统配置迁入模块：${moved.join('、')}`)
      }
    }
    if (!changed) return
    this.config.migrated = migrated
    try {
      this.#saveConfig()
    } catch (error) {
      // 写不动就回滚标记，下次再试——绝不留下「标记已迁但实际没落盘」的状态
      delete this.config.migrated
      printRed(`迁移结果写盘失败，下次启动重试：${error.message}`)
    }
  }

  /** configBackupAPI 导入配置后要调它，否则运行态与磁盘分叉。 */
  reload() {
    this.corrupt = null
    // 配置可能整套换了（配置导入），本进程的抓取记账要作废，让 ensureWarm 重新兜底
    this.attempted.clear()
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
    if (typeof module.enabledGetter === 'function') {
      // 代理开关的模块**不受**抓取子系统的两级总开关约束，只听自己那一个。
      // 咪咕的开关一直是 config.js 的 enableMigu，config.js 里明写着
      // 「可 mblank=true + menableMigu=true 单独留咪咕」——被 enableExtractors
      // 一起管掉的话，这个既有组合就废了，是对存量用户的破坏性变更。
      return !!module.enabledGetter()
    }
    if (!enableExtractors) return false
    if (this.config.enabled === false) return false
    return this.#entry(module.id).enabled
  }

  #setModuleEnabledValue(module, on) {
    if (typeof module.enabledSetter === 'function') {
      module.enabledSetter(!!on)
      return
    }
    if (typeof module.enabledGetter === 'function') {
      // 开关读的是别处（如咪咕读 config.js 的 enableMigu），写到 extractors.json
      // 不会有任何效果。与其静默无效，不如告诉用户该去哪改。
      throw new Error(`${module.name} 的开关在「系统配置」页，不在这里`)
    }
    this.#entry(module.id).enabled = !!on
  }

  #entry(id) {
    if (!this.config.modules[id]) this.config.modules[id] = { enabled: false, config: {} }
    const entry = this.config.modules[id]
    if (typeof entry.enabled !== 'boolean') entry.enabled = false
    if (!isPlainObject(entry.config)) entry.config = {}
    normalizeLegacyConfig(getModule(id), entry.config)
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
    return resolveConfig(module, this.#entry(module.id).config)
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
        // 稀疏存储后「没配过」= 该 key 不存在，不用再靠真值判断（布尔 false 会被误判）
        if (field.env && entry.config[field.key] === undefined && process.env[field.env]) {
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
    // 配置可能影响播放地址的解析结果（画质、编码等），不清缓存的话三小时内
    // 继续下发旧参数的流——issue #60 就是这么来的。后台「源模块」页保存走的
    // 正是这条路，而 clearUrlCache 的另外两个调用点都覆盖不到它。
    if (typeof module.clearResolveCache === 'function') module.clearResolveCache()
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
   * 冷缓存兜底：启用了但一条缓存都没有的模块，现抓一次。
   *
   * cache:'memory' 的模块（咪咕）重启后缓存是空的，而 regenerateOnly 那轮不会
   * 触发抓取——不兜底的话，重启后第一次「仅重新生成播放列表」会把它的频道全丢了。
   * 这与收编前 channelMerger 里「缓存未初始化，执行完整更新」的降级是同一语义。
   */
  async ensureWarm() {
    if (!this.loaded) this.load()
    const cold = listModules().filter(module =>
      this.isModuleEnabled(module)
        && this.#cacheEntry(module.id).groups.length === 0
        // 本进程没抓过才兜底。抓过之后即便结果是 0 条（比如 B 站房间全没开播），
        // 也不再反复重抓——那是合法的空，不是冷缓存。
        && !this.attempted.has(module.id))
    if (!cold.length) return { updated: false, results: [] }
    printYellow(`抓取模块缓存未初始化，现抓一次：${cold.map(m => m.name).join('、')}`)
    const results = []
    for (const module of cold) results.push(await this.#runOne(module))
    this.#saveCache()
    return { updated: results.some(r => r.success), results }
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

    // 总开关在抓取入口也要判（外部源那边只在输出处判，后台按钮绕过了守卫，
    // 功能被全局关掉时照样会联网）——但判定在 isModuleEnabled 里，因为代理
    // 开关的模块要绕过它。全部模块都被挡住时给一句明确的说明。
    const targets = listModules().filter(module => {
      if (onlyId && module.id !== onlyId) return false
      if (!this.isModuleEnabled(module)) return false
      if (forceAll || onlyId) return true
      if (autoOnly) return this.#needsRefresh(module, Date.now())
      return true
    })

    if (!targets.length) {
      const allGated = !enableExtractors || this.config.enabled === false
      return allGated
        ? { updated: false, results: [], message: '抓取模块已整体关闭' }
        : { updated: false, results: [] }
    }

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
    this.attempted.add(module.id)
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
    // 总开关的判定下沉到 isModuleEnabled——代理开关的模块（咪咕）要绕过它
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

  /**
   * 声明了 critical、已启用、但本轮一条频道都没有的模块。
   *
   * 用于 updateData 的写盘守卫：这类模块拿不到频道时，宁可保留上一份播放列表
   * 也不要覆盖。全局的「总频道数为 0」守卫护不住它——外部源随便几十条就能把
   * 总数撑起来，而用户会看到咪咕频道整批消失且日志里只有一行「咪咕 0 个」。
   */
  criticalShortfall() {
    if (!this.loaded) this.load()
    const groups = this.getValidChannels()
    return listModules()
      .filter(module => module.capabilities?.critical && this.isModuleEnabled(module))
      .filter(module => {
        const sourceId = module.sourceId || sourceIdOf(module.id)
        return !groups.some(group => group.dataList.some(ch => ch.sourceId === sourceId))
      })
      .map(module => module.name)
  }

  /** 后台「按配置档禁用源」矩阵要枚举的源。 */
  listSourceIds() {
    return listModules()
      .filter(module => this.isModuleEnabled(module))
      .map(module => ({ id: module.sourceId || sourceIdOf(module.id), name: module.name, type: 'extractor' }))
  }
}

/**
 * 把老版本写下的「全量 key」配置就地归一成稀疏形态。
 *
 * 改成稀疏存储之前，validateConfig 会给 schema 里每个 key 都补上值，于是磁盘上
 * 存着 `sessdata: ""` 这种「配过但是空」的条目。老代码的 env 兜底用真值判断，
 * 空串会正常回落到 env；新代码用「键存不存在」判断，空串会被当成「配过」——
 * 设了 mbiliSessdata 又在后台存过一次配置的用户，env 会突然失效。
 *
 * 这里只丢掉 text/secret 的空串：新 writer 从不写空串，所以空串必定来自老版本，
 * 丢掉它精确还原了老行为。boolean/int 不动——它们在老版本里本来就没有可用的
 * env 兜底，保留成「配过」正是维持现状。
 */
function normalizeLegacyConfig(module, config) {
  if (!module) return
  for (const field of module.configSchema || []) {
    const type = field.type || 'text'
    if (type !== 'text' && type !== 'select') continue
    if (config[field.key] === '') delete config[field.key]
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
