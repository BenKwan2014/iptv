/** 福建海博TV：省级频道与九市一区主频道均由官方接口返回可直连 HLS。 */
import { buildChannelGroups, EXPECTED_GROUPS, fetchChannelGroups } from './api.js'

export default {
  id: 'fjtv',
  name: '海博TV福建电视台',
  description: '福建省级频道及九市一区主频道官方直播。严格选择官方 HLS 并自动排除活动直播。',
  capabilities: { cache: 'disk', resolve: false, epg: false },
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：官方频道表与播放地址每 360 分钟刷新；失败时标记异常并沿用上次成功缓存。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const rows = await fetchChannelGroups({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl })
    const groups = buildChannelGroups(rows)
    for (const groupRows of rows) {
      const expected = EXPECTED_GROUPS[groupRows.sortId]
      const definition = groups.find(group => group.name === expected?.name)
      const actual = definition?.dataList?.length || 0
      if (!expected || actual !== expected.channelCount) {
        throw new Error(`海博TV频道分类 ${groupRows.sortId} 只找到 ${actual}/${expected?.channelCount || 0} 个正式频道（官网可能已改版）`)
      }
    }
    return { groups, meta: { skipped: [], warnings: [] } }
  },
}
