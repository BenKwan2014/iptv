/**
 * 频道级播放选项（#EXTVLCOPT）的统一契约。
 *
 * 有些直播源不是拿到地址就能播——B 站、虎牙一类带防盗链，播放器不发 Referer
 * 直接 403。这类信息没法塞进 EXTINF 属性，标准做法是在 EXTINF 和播放地址之间
 * 插 #EXTVLCOPT 行，由播放器转成请求头。
 *
 * 频道对象上以 `opts: string[]` 承载（元素形如 `http-referrer=https://...`），
 * 解析、回读、生成三处都走这里，避免各写一套。
 *
 * 注意：opts 可能来自用户添加的第三方订阅（不可信输入）。渲染进播放列表等于
 * 把内容写进一个换行敏感的格式里，因此这里做两层限制——键名白名单 + 含换行/
 * 控制字符者整条拒收，防止一条 opt 撑开成任意 M3U 指令（与 EXTINF 属性消毒同理）。
 */

const OPT_PREFIX = '#EXTVLCOPT:'

// 只放行播放必需、且无副作用的键。http-cookie 之类可能携带凭据的一律不收，
// 需要鉴权的源应当在抓取侧换成带 token 的地址，而不是把凭据发给播放器。
const ALLOWED_KEYS = new Set([
  'http-referrer',
  'http-user-agent',
  'http-origin',
  'network-caching',
])

/**
 * 判断一行是否 #EXTVLCOPT 指令。
 */
export function isOptLine(line) {
  return typeof line === 'string' && line.trimStart().startsWith(OPT_PREFIX)
}

/**
 * 把一行 #EXTVLCOPT 解析成 `key=value`，不合法或不在白名单内返回 null。
 */
export function parseOptLine(line) {
  if (!isOptLine(line)) return null
  return sanitizeOpt(line.trim().slice(OPT_PREFIX.length))
}

// 单条 opt 的长度上限。正常 UA 不过两百字符，留足余量即可，
// 免得畸形订阅把超长串灌进每一行播放列表。
const MAX_OPT_LENGTH = 1024

/**
 * 清洗单条 `key=value`：白名单校验 + 拒收含换行/控制字符者。不合法返回 null。
 *
 * 含换行的一律整条丢弃，而不是把换行剔掉后留用——后者会把注入内容粘成一条
 * 语法合法、值却是垃圾的 opt（Referer 变成 `http://a/#EXTINF...`），播放器照发不误，
 * 结果是静默播不了。宁可丢掉这条 opt，让频道以「没有请求头」的确定状态失败。
 */
export function sanitizeOpt(raw) {
  if (typeof raw !== 'string') return null
  if (raw.length > MAX_OPT_LENGTH) return null
  // 换行会撑出额外的 M3U 指令；其余 C0 控制字符进请求头同样无意义
  if (/[\r\n\u0000-\u001f\u007f]/.test(raw)) return null

  const trimmed = raw.trim()
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null

  const key = trimmed.slice(0, eq).trim().toLowerCase()
  const value = trimmed.slice(eq + 1).trim()
  if (!ALLOWED_KEYS.has(key) || !value) return null

  return `${key}=${value}`
}

/**
 * 清洗一组 opts：逐条过白名单、去重、保序。恒返回数组。
 */
export function sanitizeOpts(opts) {
  if (!Array.isArray(opts)) return []
  const seen = new Set()
  const out = []
  for (const item of opts) {
    const clean = sanitizeOpt(item)
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/**
 * 从 EXTINF 行之后收集连续的 #EXTVLCOPT，直到遇到播放地址。
 *
 * @param {string[]} lines 已按行切分的播放列表
 * @param {number} start   EXTINF 所在下标
 * @returns {{opts: string[], urlIndex: number}} urlIndex 为播放地址下标，-1 表示没找到
 */
export function collectOptsUntilUrl(lines, start) {
  const opts = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] || '').trim()
    if (!line) continue
    if (line.startsWith('#')) {
      // 只认 EXTVLCOPT，其余注释/指令（含下一条 EXTINF）按原有行为跳过
      const opt = parseOptLine(line)
      if (opt) opts.push(opt)
      continue
    }
    return { opts, urlIndex: i }
  }
  return { opts, urlIndex: -1 }
}

/**
 * 渲染成播放列表片段（含结尾换行）；无 opts 时返回空串,输出与改动前逐字节一致。
 */
export function renderOpts(opts) {
  return sanitizeOpts(opts).map(opt => `${OPT_PREFIX}${opt}\n`).join('')
}

/**
 * 该频道是否依赖自定义请求头才能播。
 *
 * TXT（diyp / TVBox）格式只有「频道名,地址」两列，没有承载请求头的位置——
 * 这类频道写进 txt 会稳定 403。缺一个台好过一个死台，故在 txt 侧整条跳过。
 */
export function needsOpts(channel) {
  return sanitizeOpts(channel && channel.opts).length > 0
}
