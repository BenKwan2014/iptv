/** 广西网络台：官方 HLS 的 PES 负载需平台密钥解码，因此固定经本机全代理播放。 */
import {
  buildChannelGroups,
  clearStreamCache,
  fetchChannelRows,
  primeStreamCache,
  resolveChannel,
} from './api.js'

export default {
  id: 'gxtv',
  name: '广西网络台直播',
  description: '广西卫视及地面频道官方直播。只收录官网正式频道，自动排除测试流和矩阵号。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  defaultRefreshMinutes: 30,
  refreshConfigurable: false,
  refreshDescription: '自动管理：频道与播放参数每 30 分钟刷新；失败后 1 分钟重试，并沿用上次可用数据。',

  configSchema: [
    {
      key: 'includeSpecialty',
      section: '频道范围',
      label: '包括乐思购、广西移动',
      type: 'boolean',
      default: true,
      hint: '关闭后只保留广西卫视及综艺旅游、都市、影视、新闻、国际频道。',
    },
    {
      key: 'includeCetv',
      section: '频道范围',
      label: '包括官网转播的 CETV1/2/4',
      type: 'boolean',
      default: false,
      hint: '这些是广西网络台页面上的合作转播，默认不加入，避免与其它来源重复。',
    },
  ],

  async fetch(config, ctx = {}) {
    const rows = await fetchChannelRows({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    primeStreamCache(rows)
    const groups = buildChannelGroups(rows, config)
    const count = groups.reduce((sum, group) => sum + group.dataList.length, 0)
    if (!count) throw new Error('广西网络台接口成功，但没有找到正式频道的可播 HLS（接口可能已改版）')
    return { groups, meta: { skipped: [], warnings: [] } }
  },

  claimsRef: ref => /^gxtv-[a-z0-9]{1,16}$/.test(String(ref || '')),
  resolve: resolveChannel,
  clearResolveCache: clearStreamCache,
}
