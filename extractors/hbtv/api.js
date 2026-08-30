/** 长江云电视页解析与短效裸流缓存。 */
import fetch from 'node-fetch'

import { CHANNELS } from './channels.js'

export const CHANNEL_PAGE_URL = 'https://news.hbtv.com.cn/app/tv/431'
export const UPSTREAM_HEADERS = Object.freeze({ Referer: 'https://news.hbtv.com.cn/' })

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const EXPIRY_GUARD_MS = 2 * 60 * 1000
const PAGE_CACHE_MS = 10 * 60 * 1000
const RETRY_MS = 30 * 1000

let pageCache = null
let pagePending = null

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function officialStream(raw, definition, now) {
  try {
    const url = new URL(String(raw || '').replaceAll('\\/', '/').trim())
    if (url.protocol !== 'https:' || url.hostname !== 'live21-cjy.hbtv.com.cn') return null
    if (url.pathname !== `/new-hbtv/${definition.streamPath}.m3u8`) return null
    const auth = url.searchParams.get('auth_key') || ''
    const match = /^(\d{10})-[0-9a-f]{32}-\d+-[0-9a-f]{32}$/i.exec(auth)
    const expiresAt = Number(match?.[1] || 0) * 1000
    if (!match || expiresAt <= Number(now) + EXPIRY_GUARD_MS) return null
    return { id: definition.id, name: definition.name, url: url.href, expiresAt }
  } catch {
    return null
  }
}

/** 只接受固定六套频道的 ID、官网原名与固定 HLS 路径。 */
export function parseChannelPage(html, now = Date.now()) {
  const source = String(html || '')
  const rows = []
  for (const definition of CHANNELS) {
    const pattern = new RegExp(
      `id\\s*:\\s*${definition.id}\\s*,[\\s\\S]{0,160}?name\\s*:\\s*"${escapeRegExp(definition.rawName)}"[\\s\\S]{0,200}?stream\\s*:\\s*"([^"]+)"`,
    )
    const row = officialStream(pattern.exec(source)?.[1], definition, now)
    if (row) rows.push(row)
  }
  return rows
}

async function requestChannelPage({ timeoutMs = 10000, fetchImpl = fetch, now = Date.now() } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(CHANNEL_PAGE_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const rows = parseChannelPage(await response.text(), now)
    if (rows.length !== CHANNELS.length) {
      throw new Error(`只找到 ${rows.length}/${CHANNELS.length} 套正式省级频道`)
    }
    return rows
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`长江云电视页请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchChannelPage(options = {}) {
  return requestChannelPage(options)
}

export function primePageCache(rows, now = Date.now()) {
  if (!Array.isArray(rows) || rows.length !== CHANNELS.length) return
  const expiresAt = Math.min(...rows.map(row => Number(row.expiresAt || 0)))
  pageCache = {
    rows,
    refreshAt: Math.min(Number(now) + PAGE_CACHE_MS, expiresAt - EXPIRY_GUARD_MS),
    retryAt: 0,
  }
}

export async function cachedChannelPage(options = {}) {
  const now = Number(options.now ?? Date.now())
  if (pageCache?.refreshAt > now || (pageCache?.retryAt > now && pageCache?.rows?.length)) return pageCache.rows
  if (!pagePending) {
    pagePending = requestChannelPage(options)
      .then(rows => {
        primePageCache(rows, now)
        return pageCache.rows
      })
      .finally(() => { pagePending = null })
  }
  try {
    return await pagePending
  } catch (error) {
    const stillValid = pageCache?.rows?.every(row => row.expiresAt > now + EXPIRY_GUARD_MS)
    if (!stillValid) throw error
    pageCache.retryAt = now + RETRY_MS
    return pageCache.rows
  }
}

export function clearPageCache() {
  pageCache = null
  pagePending = null
}
