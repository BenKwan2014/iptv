/** 浙江新蓝网：公开频道表，播放时按频道 ID 取流并生成短期 auth_key。 */
import { buildChannels, clearPlayInfoCache, fetchChannelList, resolveChannel } from './api.js'

export default {
  id: 'cztv',
  name: '浙江新蓝网直播',
  description: '浙江卫视及地面频道官方直播。播放时即时选择码率并生成有效地址。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  defaultRefreshMinutes: 240,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道列表每 240 分钟刷新；播放签名约 5 分钟更新，CDN 节点约 15 秒重新评估，失败后 1 分钟重试。',

  configSchema: [
    {
      key: 'quality',
      section: '播放偏好',
      label: '优先画质',
      type: 'select',
      default: '1080P',
      options: [
        { value: '1080P', label: '1080P 超清' },
        { value: '720P', label: '720P 高清（省带宽）' },
      ],
      hint: '目标画质暂时不可用时会自动回落到其它视频档，不会误选纯音频。',
    },
    {
      key: 'includeShopping',
      section: '频道范围',
      label: '包括好易购',
      type: 'boolean',
      default: true,
      hint: '关闭后不在播放列表中加入购物频道。',
    },
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
    const channels = buildChannels(rows, config).map(channel => ({
      ...channel,
      opts: Number(config.cachingMs) > 0 ? [`network-caching=${Number(config.cachingMs)}`] : [],
    }))
    if (!channels.length) throw new Error('浙江新蓝网接口成功，但没有找到可用频道（接口可能已改版）')
    return {
      groups: [{ name: '浙江电视台', dataList: channels }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef: ref => /^cztv-\d{1,8}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearPlayInfoCache,
}
