/** 央视景观播放解析：目录按官网刷新，VDN 结果短期复用，避免频繁启动播放器。 */
import { cachedCatalog, clearCatalogCache, UPSTREAM_HEADERS } from './api.js'
import { browserSession, isOfficialStreamUrl } from './session.js'

export const STREAM_TTL_MS = 15 * 60 * 1000

export function createResolver({
  getRows = cachedCatalog,
  capture = (row, options) => browserSession.capture(row, options),
  close = () => browserSession.close(),
} = {}) {
  const streamCache = new Map()
  const pending = new Map()
  let generation = 0

  async function resolve(ref, ctx = {}) {
    const match = /^livechina-([A-Za-z0-9_-]{1,64})$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '央视直播中国频道引用格式错误' }
    const channelId = match[1]
    const now = Number(ctx.now ?? Date.now())

    try {
      const rows = await getRows({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
      const row = rows.find(item => item.id === channelId)
      if (!row) return { url: '', desc: `央视景观 ${channelId} 当前不在官网可播放列表中` }

      let entry = streamCache.get(channelId)
      if (!entry || entry.expiresAt <= now) {
        let task = pending.get(channelId)
        if (!task) {
          const startedInGeneration = generation
          task = Promise.resolve(capture(row, { timeoutMs: ctx.timeoutMs }))
            .then(url => {
              if (startedInGeneration !== generation) throw new Error('央视景观解析任务已取消')
              if (!isOfficialStreamUrl(url)) throw new Error('官网没有返回有效的央视景观 HLS')
              const fresh = { url, expiresAt: Number(ctx.now ?? Date.now()) + STREAM_TTL_MS }
              streamCache.set(channelId, fresh)
              return fresh
            })
            .finally(() => {
              if (pending.get(channelId) === task) pending.delete(channelId)
            })
          pending.set(channelId, task)
        }
        entry = await task
      }

      return {
        url: entry.url,
        desc: `${row.region}｜${row.name}播放地址获取成功`,
        relayHls: true,
        upstreamHeaders: UPSTREAM_HEADERS,
      }
    } catch (error) {
      return { url: '', desc: `央视直播中国链接请求失败：${error?.message || String(error)}` }
    }
  }

  function clear() {
    generation++
    streamCache.clear()
    pending.clear()
    clearCatalogCache()
    Promise.resolve(close()).catch(() => {})
  }

  return { resolve, clear, streamCache, pending }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
