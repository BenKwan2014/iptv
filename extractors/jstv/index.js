/** 江苏网络台（荔枝网）：播放时生成 3 分钟签名，并全代理必须的防盗链请求头。 */
import { buildChannels, clearCache, fetchChannelList, primeChannelCache, resolveChannel } from './api.js'

export default {
  id: 'jstv',
  name: '江苏网络台直播',
  description: '江苏卫视及地面频道官方直播。播放时自动生成短效签名并代理官网防盗链请求头。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；每次播放及清单更新都会重新生成约 3 分钟有效的地址。',

  configSchema: [
    {
      key: 'cachingMs',
      section: '播放偏好',
      label: '播放缓冲 (ms)',
      type: 'int',
      min: 0,
      max: 60000,
      default: 3000,
      hint: '写入 #EXTVLCOPT:network-caching；填 0 则不写。',
    },
  ],

  async fetch(config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeChannelCache(rows)
    const channels = buildChannels(rows).map(channel => ({
      ...channel,
      opts: Number(config.cachingMs) > 0 ? [`network-caching=${Number(config.cachingMs)}`] : [],
    }))
    if (!channels.length) throw new Error('江苏网络台接口成功，但没有找到可用频道（接口可能已改版）')
    return { groups: [{ name: '江苏电视台', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^jstv-\d{1,8}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
