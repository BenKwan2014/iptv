/** 上海松江区融媒体中心官方慢直播。 */
import { buildChannels, clearCache, fetchScene, primeSceneCache, resolveChannel } from './api.js'

export default {
  id: 'songjiang',
  name: '上海松江',
  description: '上海松江客户端「松江融媒慢直播」，官方多机位画面按节目编排滚动切换。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  outputGroupName: '上海景观',
  defaultRefreshMinutes: 10,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 10 分钟读取官方场景清单并更新慢直播地址；仅中转 HLS 清单。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const row = await fetchScene({ timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl, now: ctx.now })
    primeSceneCache(row, ctx.now ?? Date.now())
    return {
      groups: [{ name: '上海景观', dataList: buildChannels(row) }],
      meta: { skipped: [], warnings: [] },
    }
  },

  claimsRef: ref => String(ref || '') === 'songjiang-slow-live',
  resolve: resolveChannel,
  clearResolveCache: clearCache,
}
