/** 福建官方直播：海博省市频道 + 不依赖海博的福州、厦门广电线路。 */
import {
  buildChannelGroups,
  clearXiamenCache,
  EXPECTED_GROUPS,
  fetchChannelGroups,
  fetchFuzhouChannels,
  fetchXiamenChannels,
  resolveXiamenChannel,
} from './api.js'

const CITY_GROUP = '福建地市台'
const OLD_FUZHOU_NAMES = new Set(['福州新闻综合', '福州综合', '福州生活', '福州少儿'])
const OLD_XIAMEN_NAMES = new Set(['厦门卫视', '厦视一套', '厦视二套', '厦视三套'])

/** 排除海博的低清厦门卫视，插入厦门官网三个地面频道，不增加新的分组。 */
export function mergeXiamenChannels(groups, xiamenChannels) {
  const output = (Array.isArray(groups) ? groups : []).map(group => ({
    ...group,
    dataList: [...(group.dataList || [])],
  }))
  if (!xiamenChannels?.length) return output

  let city = output.find(group => group.name === CITY_GROUP)
  if (!city) {
    city = { name: CITY_GROUP, dataList: [] }
    output.push(city)
  }
  const original = city.dataList
  const replacementAt = original.findIndex(channel => OLD_XIAMEN_NAMES.has(channel.name))
  city.dataList = original.filter(channel => !OLD_XIAMEN_NAMES.has(channel.name))
  city.dataList.splice(replacementAt >= 0 ? replacementAt : 0, 0, ...xiamenChannels)
  return output
}

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
  let lastXiamen = -1
  city.dataList.forEach((channel, index) => {
    if (OLD_XIAMEN_NAMES.has(channel.name)) lastXiamen = index
  })
  const insertAt = replacementAt >= 0 ? Math.min(replacementAt, city.dataList.length) : lastXiamen + 1
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
  description: '福建省级频道与重点城市官方直播；福州、厦门线路独立于海博接口，自动探测后并入现有福建分组。',
  capabilities: { cache: 'disk', resolve: true, epg: false },
  defaultRefreshMinutes: 360,
  refreshConfigurable: false,
  refreshDescription: '自动管理：每 360 分钟刷新海博频道表及福州、厦门官方 HLS；单个平台失败时保留其它平台的可用频道。',

  configSchema: [],

  async fetch(_config, ctx = {}) {
    const options = { timeoutMs: ctx.timeoutMs, fetchImpl: ctx.fetchImpl }
    const warnings = []
    let groups = []
    let haiboError = null
    let fuzhouError = null
    let xiamenError = null

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
      const xiamen = await fetchXiamenChannels(options)
      groups = mergeXiamenChannels(groups, xiamen.channels)
      warnings.push(...xiamen.warnings)
    } catch (error) {
      xiamenError = error
      warnings.push(error?.message || String(error))
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
      const reasons = [haiboError?.message, xiamenError?.message, fuzhouError?.message].filter(Boolean).join('；')
      throw new Error(`福建官方直播本轮全部抓取失败：${reasons || '没有可用频道'}`)
    }
    return { groups, meta: { skipped: [], warnings } }
  },

  claimsRef: ref => /^fjtv-xiamen-(?:16|17|18)$/.test(String(ref || '')),
  resolve: resolveXiamenChannel,
  clearResolveCache: clearXiamenCache,
}
