/** 央视网「直播中国」：按官方目录动态接入当前在线景观信号。 */
import { buildChannels, fetchCatalog, primeCatalogCache } from './api.js'
import { clearCache, resolveChannel } from './resolver.js'

export default {
  id: 'livechina',
  name: '央视直播中国',
  description: '央视网「直播中国」当前在线景观慢直播；自动排除历史下线页面，播放时由官网播放器获取 HLS。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '央视景观',
  // 同时覆盖旧磁盘缓存中的 relayHls 标记：升级后重新生成播放列表即可切到全代理，
  // 不必等待四小时目录刷新。
  channelHlsMode: 'proxy',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：景观目录每 240 分钟刷新；播放地址按需读取并复用 15 分钟。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const result = await fetchCatalog({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeCatalogCache(result.rows, ctx.now ?? Date.now())
    return {
      groups: [{ name: '央视景观', dataList: buildChannels(result.rows) }],
      meta: { skipped: [], warnings: result.warnings },
    }
  },

  claimsRef: ref => /^livechina-[A-Za-z0-9_-]{1,64}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
