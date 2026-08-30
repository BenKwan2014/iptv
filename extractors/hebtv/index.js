/** 河北广播电视台「冀时」：官网动态频道表，播放时生成两小时 HLS 签名。 */
import { buildChannels, clearCache, fetchChannelList, primeChannelCache, resolveChannel } from './api.js'

export default {
  id: 'hebtv',
  name: '河北',
  description: '河北广播电视台当前六套非购物电视频道直播，含河北卫视及五个地面频道。播放时自动续签。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '河北',
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放地址在请求时生成约两小时有效的官网签名。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelList({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeChannelCache(rows, ctx.now ?? Date.now())
    const channels = buildChannels(rows).map(channel => ({
      ...channel,
      opts: ['network-caching=3000'],
    }))
    if (!channels.length) throw new Error('河北冀时接口成功，但没有找到可用频道（接口可能已改版）')
    return { groups: [{ name: '河北电视台', dataList: channels }], meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^hebtv-\d{1,12}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
