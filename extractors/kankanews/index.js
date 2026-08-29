/** 看看新闻（SMG）：上海电视台官方频道，播放时解出与出口 IP / UA 绑定的地址。 */
import { buildChannels, clearCache, fetchChannelList, resolveChannel } from './api.js'

export default {
  id: 'kankanews',
  name: '看看新闻上海电视台',
  description: '东方卫视、新闻综合、第一财经、五星体育等 SMG 官方直播。播放时自动验签取流并全代理防盗链请求。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放地址约每 150 秒重新获取，失败后 1 分钟重试。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const channels = buildChannels(rows).map(channel => ({
      ...channel,
      opts: ['network-caching=3000'],
    }))
    if (!channels.length) throw new Error('看看新闻接口成功，但没有找到可用上海频道（接口可能已改版）')
    return {
      groups: [{ name: '上海电视台', dataList: channels }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef: ref => /^kankanews-(?:1|2|4|5|9|10|11|12)$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
