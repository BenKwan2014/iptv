/** 河北广播电视台「冀时」官网频道表与 HLS 到期签名。 */
import { createHash } from 'node:crypto'
import fetch from 'node-fetch'

export const CHANNEL_LIST_URL = 'https://api.cmc.hebrts.cn/cmsback/api/com/article/getArticleList?catalogId=32557&siteId=1'
export const STREAM_HOST = 'tv.pull.hebtv.com'

const CHANNEL_TTL_MS = 4 * 60 * 60 * 1000
const CHANNEL_RETRY_MS = 60 * 1000
const STREAM_TTL_SECONDS = 2 * 60 * 60
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const UPSTREAM_HEADERS = {
  Referer: 'https://www.hebrts.cn/19/19js/st/xdszb/index.shtml',
  Origin: 'https://www.hebrts.cn',
  'User-Agent': UA,
}

// 只接官网当前电视直播栏目中的正式新闻/综合频道；购物及未知稿件固定排除。
const NAME_OVERRIDES = {
  河北卫视: '河北卫视',
  经济生活: '河北经济生活',
  河北都市: '河北都市',
  文旅体育: '河北文旅体育',
  少儿科教: '河北少儿科教',
  三农频道: '河北三农',
}

let channelCache = null
let channelPending = null

const md5 = value => createHash('md5').update(value).digest('hex')

function movieParams(row) {
  return row?.appCustomParams?.movie || row?.appCustomParams1?.movie || {}
}

function streamUrlOf(row) {
  for (const device of Array.isArray(row?.liveVideo) ? row.liveVideo : []) {
    for (const format of Array.isArray(device?.formats) ? device.formats : []) {
      const value = String(format?.url || format?.liveStream || '').trim()
      if (value) return value
    }
  }
  return ''
}

/** 把 CMS 的直播稿件收窄成播放解析所需字段。 */
export function normalizeRows(payload) {
  const rows = []
  const seen = new Set()
  for (const item of Array.isArray(payload) ? payload : []) {
    const id = String(item?.id || item?.articleId || '').trim()
    const name = NAME_OVERRIDES[String(item?.title || '').trim()]
    const params = movieParams(item)
    const liveUri = String(params?.liveUri || '').trim()
    const liveKey = String(params?.liveKey || '').trim()
    const rawUrl = streamUrlOf(item)
    let stream
    try { stream = new URL(rawUrl) } catch { continue }
    if (!/^\d{1,12}$/.test(id) || !name || seen.has(id)
      || !/^\/[A-Za-z0-9][A-Za-z0-9/_.-]*\.m3u8$/i.test(liveUri)
      || !/^[A-Za-z0-9]{3,64}$/.test(liveKey)
      || stream.protocol !== 'https:' || stream.hostname !== STREAM_HOST
      || stream.pathname !== liveUri) continue
    seen.add(id)
    rows.push({
      id,
      name,
      liveUri,
      liveKey,
      url: stream.href,
      logo: String(item?.logo || '').trim().replace(/^http:\/\//i, 'https://'),
    })
  }
  return rows
}

async function requestWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs || 10000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await (options.fetchImpl || fetch)(url, {
      method: 'POST',
      headers: { ...UPSTREAM_HEADERS, Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(reason)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelList(options = {}) {
  const response = await requestWithTimeout(CHANNEL_LIST_URL, options)
  if (!response.ok) throw new Error(`频道接口 HTTP ${response.status}`)
  const payload = await response.json()
  const rows = normalizeRows(payload?.returnData?.news)
  if (payload?.returnCode !== '0000' || !rows.length) {
    throw new Error(`频道接口返回异常：${payload?.returnDesc || payload?.message || '没有可用频道'}`)
  }
  return rows
}

async function cachedChannelList(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (channelCache?.expiresAt > now || channelCache?.retryAt > now) return channelCache.rows
  if (!channelPending) {
    channelPending = fetchChannelList(options)
      .then(rows => {
        channelCache = { rows, expiresAt: now + CHANNEL_TTL_MS, retryAt: 0 }
        return rows
      })
      .finally(() => { channelPending = null })
  }
  try {
    return await channelPending
  } catch (error) {
    if (!channelCache) throw error
    channelCache.retryAt = now + CHANNEL_RETRY_MS
    return channelCache.rows
  }
}

export function primeChannelCache(rows, now = Date.now()) {
  if (!Array.isArray(rows) || !rows.length) return
  channelCache = { rows, expiresAt: Number(now) + CHANNEL_TTL_MS, retryAt: 0 }
}

export function buildChannels(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    name: row.name,
    deferredRef: `hebtv-${row.id}`,
    // 顶层清单持续续签，清单内带独立参数的 TS 分片仍由播放器直连 CDN。
    relayHls: true,
    logo: row.logo || '',
  }))
}

/** 官网播放器算法：k = MD5(liveUri + liveKey + t)，t 为当前秒 + 2 小时。 */
export function signStreamUrl(rawUrl, liveUri, liveKey, now = Date.now()) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.hostname !== STREAM_HOST || url.pathname !== liveUri
    || !/^\/[A-Za-z0-9][A-Za-z0-9/_.-]*\.m3u8$/i.test(liveUri)
    || !/^[A-Za-z0-9]{3,64}$/.test(String(liveKey || ''))) {
    throw new Error('播放地址不是河北广电 HTTPS 直播路径')
  }
  const seconds = Math.floor(Number(now) / 1000)
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('签名时间无效')
  const expires = seconds + STREAM_TTL_SECONDS
  url.searchParams.set('t', String(expires))
  url.searchParams.set('k', md5(`${liveUri}${liveKey}${expires}`))
  return url.href
}

export async function resolveChannel(ref, ctx = {}) {
  try {
    const match = /^hebtv-(\d{1,12})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '河北冀时频道引用格式错误' }
    const rows = await cachedChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    const row = rows.find(item => item.id === match[1])
    if (!row) return { url: '', desc: `河北冀时频道 ${match[1]} 当前不在官网列表中` }
    return {
      url: signStreamUrl(row.url, row.liveUri, row.liveKey, ctx.now ?? Date.now()),
      desc: `${row.name}短效播放地址生成成功`,
      relayHls: true,
      upstreamHeaders: UPSTREAM_HEADERS,
    }
  } catch (error) {
    return { url: '', desc: `河北冀时链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearCache() {
  channelCache = null
  channelPending = null
}
