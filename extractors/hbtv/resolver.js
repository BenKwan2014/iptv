/** 长江云六套省台：刷新网页短签名，再由浏览器取回受指纹保护的媒体清单。 */
import { cachedChannelPage, clearPageCache, UPSTREAM_HEADERS } from './api.js'
import { CHANNEL_BY_ID, channelIdFromRef } from './channels.js'
import { browserSession } from './session.js'

export function createResolver({
  getRows = cachedChannelPage,
  capture = (url, options) => browserSession.capture(url, options),
  close = () => browserSession.close(),
} = {}) {
  async function resolve(ref, ctx = {}) {
    const channelId = channelIdFromRef(ref)
    if (!channelId) return { url: '', desc: '湖北台频道引用格式错误' }
    const definition = CHANNEL_BY_ID.get(channelId)
    try {
      const rows = await getRows({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
      const row = rows.find(item => item.id === channelId)
      if (!row) return { url: '', desc: `${definition.name}当前不在长江云公开频道列表中` }
      const manifest = await capture(row.url, { timeoutMs: ctx.timeoutMs })
      return {
        url: manifest.url,
        manifestText: manifest.text,
        manifestUrl: manifest.url,
        upstreamHeaders: UPSTREAM_HEADERS,
        // 兼容历史上手写的无 /proxy/ 地址；新生成的播放列表固定走全代理。
        relayHls: true,
        desc: `${definition.name}防盗链清单获取成功`,
      }
    } catch (error) {
      return { url: '', desc: `湖北台链接请求失败：${error?.message || String(error)}` }
    }
  }

  function clear() {
    clearPageCache()
    Promise.resolve(close()).catch(() => {})
  }

  return { resolve, clear }
}

const resolver = createResolver()

export const resolveChannel = resolver.resolve
export const clearCache = resolver.clear
