/** 福建官方直播：海博省市频道 + 不依赖海博的福州广电固定 HLS。 */
import {
  buildChannelGroups,
  EXPECTED_GROUPS,
  fetchChannelGroups,
  fetchFuzhouChannels,
} from './api.js'

const CITY_GROUP = '福建地市台'
const OLD_FUZHOU_NAMES = new Set(['福州新闻综合', '福州综合', '福州生活', '福州少儿'])

/** 用福州官网三路替换海博里的单路福州台，不增加新的分组。 */
export function mergeFuzhouChannels(groups, fuzhouChannels) {
  const output = (Array.isArray(groups) ? groups : []).map(group => ({
    ...group,
    dataList: [...(group.dataList || [])],
  }))
  if (!fuzhouChannels?.length) return output

  let city = output.find(group => group.name === CITY_GROUP)
  if (!city) {
    city = { name: CITY_GROUP, dataList: [] }
    output.push(city)
  }

  const original = city.dataList
  const replacementAt = original.findIndex(channel => OLD_FUZHOU_NAMES.has(channel.name))
  city.dataList = original.filter(channel => !OLD_FUZHOU_NAMES.has(channel.name))
  const insertAt = replacementAt >= 0
    ? Math.min(replacementAt, city.dataList.length)
    : (city.dataList[0]?.name === '厦门卫视' ? 1 : 0)
  city.dataList.splice(insertAt, 0, ...fuzhouChannels)
  return output
}

function validateHaiboGroups(rows, groups) {
  for (const groupRows of rows) {
    const expected = EXPECTED_GROUPS[groupRows.sortId]
    const definition = groups.find(group => group.name === expected?.name)
    const actual = definition?.dataList?.length || 0
    if (!expected || actual !== expected.channelCount) {
      throw new Error(`海博TV频道分类 ${groupRows.sortId} 只找到 ${actual}/${expected?.channelCount || 0} 个正式频道（官网可能已改版）`)
    }
  }
}

export default {
  id: 'fjtv',
  name: '福建电视台',
  description: '福建省级频道与重点城市官方直播；福州线路独立于海博接口，自动探测后并入现有福建分组。',
  capabilities: { cache: 'disk', resolve: false, epg: false },
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 360 分钟刷新海博频道表并探测福州官方 HLS；单个平台失败时保留另一平台的可用频道。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const options = { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl }
    const warnings = []
    let groups = []
    let haiboError = null
    let fuzhouError = null

    try {
      const rows = await fetchChannelGroups(options)
      groups = buildChannelGroups(rows)
      validateHaiboGroups(rows, groups)
    } catch (error) {
      haiboError = error
      warnings.push(`海博TV本轮不可用：${error?.message || error}`)
      groups = []
    }

    try {
      const fuzhou = await fetchFuzhouChannels(options)
      groups = mergeFuzhouChannels(groups, fuzhou.channels)
      warnings.push(...fuzhou.warnings)
    } catch (error) {
      fuzhouError = error
      warnings.push(error?.message || String(error))
    }

    const count = groups.reduce((sum, group) => sum + (group.dataList?.length || 0), 0)
    if (!count) {
      const reasons = [haiboError?.message, fuzhouError?.message].filter(Boolean).join('；')
      throw new Error(`福建官方直播本轮全部抓取失败：${reasons || '没有可用频道'}`)
    }
    return { groups, meta: { skipped: [], warnings } }
  },
}
