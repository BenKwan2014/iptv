/** 福建海博TV频道接口，以及福州、厦门广电官网的独立直播线路。 */
import fetch from 'node-fetch'

export const CHANNEL_LIST_URL = 'https://mapi-plus.fjtv.net/api/open/haibo8/tv_channel_list.php'
export const XIAMEN_CHANNEL_URL = 'https://mapi1.kxm.xmtv.cn/api/v1/channel.php'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const FUZHOU_REFERER = 'https://www.zohi.tv/'
const XIAMEN_REFERER = 'https://www.xmtv.cn/'
const XIAMEN_EXPIRY_GUARD_MS = 60 * 1000

const xiamenStreamCache = new Map()
const xiamenPending = new Map()

// 福视悦动官网播放器公开的三路固定 HLS。它们不经过海博 API，因而海博被
// 讯飞 WAF 拦截时仍可独立工作。只接受这张固定表，避免把活动直播混进频道组。
export const FUZHOU_CHANNELS = Object.freeze([
  Object.freeze({ name: '福州综合', url: 'http://live.zohi.tv/video/s10001-fztv-1/index.m3u8' }),
  Object.freeze({ name: '福州生活', url: 'http://live.zohi.tv/video/s10001-fztv-3/index.m3u8' }),
  Object.freeze({ name: '福州少儿', url: 'http://live.zohi.tv/video/s10001-fztv-4/index.m3u8' }),
])

// 看厦门官方频道接口当前提供 3 个值得保留的地面频道。厦门卫视清晰度低且
// 咪咕已有更优来源，与移动电视一起固定排除；第三频道的接口原名是
// 「直播通道3」，对外使用正式频道名。
export const XIAMEN_CHANNELS = Object.freeze([
  Object.freeze({ id: '16', rawNames: Object.freeze(['厦视一套']), name: '厦视一套', path: 'xmtjs1' }),
  Object.freeze({ id: '17', rawNames: Object.freeze(['厦视二套']), name: '厦视二套', path: 'xmtjs2' }),
  Object.freeze({ id: '18', rawNames: Object.freeze(['直播通道3', '厦视三套']), name: '厦视三套', path: 'xmtjs3' }),
])

const XIAMEN_BY_ID = new Map(XIAMEN_CHANNELS.map(channel => [channel.id, channel]))

// sortId 来自海博TV 9.0.3「看电视」频道分类接口。ID + 原始名称双重校验，
// 防止接口混入活动直播，或后台复用频道 ID 后把其它内容静默写进播放列表。
const GROUPS = [
  {
    sortId: '665226484478443521',
    name: '福建电视台',
    channels: [
      { id: '665248990102917120', rawName: '综合频道', name: '福建综合' },
      { id: '665248966136664064', rawName: '东南卫视', name: '东南卫视' },
      { id: '665248914378952704', rawName: '新闻频道', name: '福建新闻' },
      { id: '665248752898248704', rawName: '文旅·体育频道', name: '福建文旅体育' },
      { id: '665248553475870720', rawName: '少儿频道', name: '福建少儿' },
      { id: '665248523855695872', rawName: '海峡卫视', name: '海峡卫视' },
    ],
  },
  {
    sortId: '665226484646215680',
    name: '福建地市台',
    channels: [
      { id: '731087090473676800', rawName: '福州新闻综合频道', name: '福州新闻综合' },
      { id: '727214415649083392', rawName: '漳州新闻综合频道', name: '漳州新闻综合' },
      { id: '727216678547394560', rawName: '三明综合频道', name: '三明综合' },
      { id: '727572738755977216', rawName: '泉州新闻综合频道', name: '泉州新闻综合' },
      { id: '727216450918322176', rawName: '南平综合频道', name: '南平综合' },
      { id: '727212352215093248', rawName: '龙岩综合频道', name: '龙岩综合' },
      { id: '727213694589505536', rawName: '莆田新闻综合频道', name: '莆田新闻综合' },
      { id: '727574414028103680', rawName: '平潭综合频道', name: '平潭综合' },
      { id: '727213159174017024', rawName: '宁德新闻综合频道', name: '宁德新闻综合' },
    ],
  },
]

const GROUP_BY_SORT_ID = new Map(GROUPS.map(group => [group.sortId, group]))

export const EXPECTED_GROUPS = Object.freeze(
  Object.fromEntries(GROUPS.map(group => [
    group.sortId,
    Object.freeze({ name: group.name, channelCount: group.channels.length }),
  ])),
)

function validOfficialUrl(raw, { hls = false } = {}) {
  try {
    const url = new URL(String(raw || '').trim())
    const officialHost = url.hostname === 'fjtv.net' || url.hostname.endsWith('.fjtv.net')
    if (url.protocol !== 'https:' || !officialHost) return ''
    if (hls && !/\.m3u8$/i.test(url.pathname)) return ''
    return url.href
  } catch {
    return ''
  }
}

/**
 * 只读取 topic_camera[].streams[].hls。接口的 extra.play_stream_url 曾在福建综合
 * 行里指向无关频道，不能当作回落地址；FLV 与推流地址同样不进入播放列表。
 */
export function hlsOf(row) {
  for (const camera of Array.isArray(row?.topic_camera) ? row.topic_camera : []) {
    for (const stream of Array.isArray(camera?.streams) ? camera.streams : []) {
      const url = validOfficialUrl(stream?.hls, { hls: true })
      if (url) return url
    }
  }
  return ''
}

function logoOf(row) {
  return validOfficialUrl(row?.index_pic?.file_url || row?.indexpic)
}

/** 按固定频道顺序构建两个分组；未知行、错名行与非官方 HLS 全部忽略。 */
export function buildChannelGroups(groupRows) {
  const rowsBySort = new Map(
    (Array.isArray(groupRows) ? groupRows : []).map(item => [String(item?.sortId || ''), item?.rows]),
  )

  return GROUPS.map(group => {
    const definitions = new Map(group.channels.map(channel => [channel.id, channel]))
    const found = new Map()
    for (const row of Array.isArray(rowsBySort.get(group.sortId)) ? rowsBySort.get(group.sortId) : []) {
      const id = String(row?.id || '').trim()
      const definition = definitions.get(id)
      if (!definition || found.has(id)) continue
      if (String(row?.sort_id || '') !== group.sortId) continue
      if (String(row?.title || '').trim() !== definition.rawName) continue
      const url = hlsOf(row)
      if (!url) continue
      found.set(id, {
        name: definition.name,
        url,
        logo: logoOf(row),
      })
    }
    return {
      name: group.name,
      dataList: group.channels.flatMap(channel => found.has(channel.id) ? [found.get(channel.id)] : []),
    }
  }).filter(group => group.dataList.length)
}

async function requestGroup(sortId, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!GROUP_BY_SORT_ID.has(String(sortId))) throw new Error(`未知频道分类：${sortId}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const url = new URL(CHANNEL_LIST_URL)
  url.searchParams.set('sort_id', String(sortId))
  try {
    const response = await fetchImpl(url.href, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.fjtv.net/',
        Accept: 'application/json, text/plain, */*',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    if (!Array.isArray(payload)) throw new Error('返回结构不符合预期')
    return { sortId: String(sortId), rows: payload }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`海博TV频道分类 ${sortId} 请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 两个分类必须同时成功，避免一次局部接口抖动把另一半缓存覆盖掉。 */
export async function fetchChannelGroups(options = {}) {
  const result = []
  for (const group of GROUPS) result.push(await requestGroup(group.sortId, options))
  return result
}

function isExpectedFuzhouUrl(raw) {
  try {
    const url = new URL(String(raw || ''))
    return url.protocol === 'http:'
      && url.hostname === 'live.zohi.tv'
      && /^\/video\/s10001-fztv-[134]\/index\.m3u8$/.test(url.pathname)
  } catch {
    return false
  }
}

async function probeFuzhouChannel(channel, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  if (!isExpectedFuzhouUrl(channel?.url)) throw new Error(`${channel?.name || '未知频道'}地址不在官方白名单`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(channel.url, {
      headers: {
        'User-Agent': UA,
        Referer: FUZHOU_REFERER,
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const manifest = await response.text()
    if (!/^\s*#EXTM3U(?:\r?\n|$)/.test(manifest)) throw new Error('返回内容不是 HLS 清单')
    return { name: channel.name, url: channel.url, logo: '' }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`${channel.name}探测失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 并行探测福州三路固定官方 HLS。单路异常只跳过该路；三路全挂才抛错，
 * 让调用方决定是沿用海博结果，还是把整轮记为失败以保留旧缓存。
 */
export async function fetchFuzhouChannels(options = {}) {
  const settled = await Promise.allSettled(
    FUZHOU_CHANNELS.map(channel => probeFuzhouChannel(channel, options)),
  )
  const channels = []
  const warnings = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') channels.push(result.value)
    else warnings.push(result.reason?.message || `${FUZHOU_CHANNELS[index].name}探测失败`)
  })
  if (!channels.length) throw new Error(`福州广电三路直播全部不可用：${warnings.join('；')}`)
  return { channels, warnings }
}

function xiamenHeaders({ manifest = false } = {}) {
  return {
    'User-Agent': UA,
    Referer: XIAMEN_REFERER,
    Accept: manifest
      ? 'application/vnd.apple.mpegurl, application/x-mpegURL, */*'
      : 'application/json, text/plain, */*',
  }
}

function validXiamenStream(raw, definition) {
  try {
    const url = new URL(String(raw || '').trim())
    if (url.protocol !== 'https:' || !/^live\d+\.kxm\.xmtv\.cn$/.test(url.hostname)) return null
    if (!url.pathname.startsWith(`/${definition.path}/`) || !/\/(?:live|playlist)\.m3u8$/.test(url.pathname)) return null
    const token = url.searchParams.get('_upt') || ''
    const match = /([0-9]{10})$/.exec(token)
    if (!/^[0-9a-f]+[0-9]{10}$/i.test(token) || !match) return null
    return { url: url.href, expiresAt: Number(match[1]) * 1000 }
  } catch {
    return null
  }
}

function xiamenLogo(row) {
  const logo = row?.logo?.square_1 || row?.logo?.square || row?.snap
  try {
    const url = new URL(String(logo?.filename || ''), String(logo?.host || ''))
    return url.protocol === 'https:' && url.hostname.endsWith('.kxm.xmtv.cn') ? url.href : ''
  } catch {
    return ''
  }
}

async function requestXiamenChannel(definition, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const url = new URL(XIAMEN_CHANNEL_URL)
  url.searchParams.set('channel_id', definition.id)
  try {
    const response = await fetchImpl(url.href, {
      headers: xiamenHeaders(),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    const row = Array.isArray(payload) ? payload[0] : null
    if (!row || String(row.id) !== definition.id || !definition.rawNames.includes(String(row.name || '').trim())) {
      throw new Error('频道身份与官方白名单不一致')
    }
    const streams = Array.isArray(row.channel_stream) ? row.channel_stream : []
    const candidates = [
      ...streams.filter(stream => Number(stream?.is_main) === 1).map(stream => stream?.m3u8 || stream?.url),
      ...streams.map(stream => stream?.m3u8 || stream?.url),
      row.m3u8,
    ]
    const stream = candidates.map(raw => validXiamenStream(raw, definition)).find(Boolean)
    if (!stream) throw new Error('没有找到官方短效 HLS')
    return { ...stream, logo: xiamenLogo(row) }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`${definition.name}接口请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

async function probeXiamenManifest(definition, stream, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(stream.url, {
      headers: xiamenHeaders({ manifest: true }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const manifest = await response.text()
    if (!/^\s*#EXTM3U(?:\r?\n|$)/.test(manifest)) throw new Error('返回内容不是 HLS 清单')
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error?.message || String(error))
    throw new Error(`${definition.name}探测失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 厦门三路独立探测；单路异常只跳过该路，全部失败才让调用方决定是否保缓存。 */
export async function fetchXiamenChannels(options = {}) {
  const settled = await Promise.allSettled(XIAMEN_CHANNELS.map(async definition => {
    const stream = await requestXiamenChannel(definition, options)
    await probeXiamenManifest(definition, stream, options)
    xiamenStreamCache.set(definition.id, stream)
    return {
      name: definition.name,
      deferredRef: `fjtv-xiamen-${definition.id}`,
      proxyHls: true,
      logo: stream.logo,
    }
  }))
  const channels = []
  const warnings = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') channels.push(result.value)
    else warnings.push(result.reason?.message || `${XIAMEN_CHANNELS[index].name}抓取失败`)
  })
  if (!channels.length) throw new Error(`厦门广电三路直播全部不可用：${warnings.join('；')}`)
  return { channels, warnings }
}

async function cachedXiamenStream(channelId, options = {}) {
  const definition = XIAMEN_BY_ID.get(String(channelId || ''))
  if (!definition) throw new Error('厦门频道 ID 无效')
  const now = Number(options.now ?? Date.now())
  const cached = xiamenStreamCache.get(definition.id)
  if (cached && cached.expiresAt > now + XIAMEN_EXPIRY_GUARD_MS) return cached

  let pending = xiamenPending.get(definition.id)
  if (!pending) {
    pending = requestXiamenChannel(definition, options)
      .then(stream => {
        xiamenStreamCache.set(definition.id, stream)
        return stream
      })
      .finally(() => {
        if (xiamenPending.get(definition.id) === pending) xiamenPending.delete(definition.id)
      })
    xiamenPending.set(definition.id, pending)
  }
  try {
    return await pending
  } catch (error) {
    if (cached && cached.expiresAt > now) return cached
    throw error
  }
}

export async function resolveXiamenChannel(ref, ctx = {}) {
  try {
    const match = /^fjtv-xiamen-(16|17|18)$/.exec(String(ref || ''))
    if (!match) return { url: '', desc: '厦门广电频道引用格式错误' }
    const stream = await cachedXiamenStream(match[1], {
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      now: ctx.now,
    })
    const definition = XIAMEN_BY_ID.get(match[1])
    return {
      url: stream.url,
      desc: `${definition.name}官方地址获取成功`,
      proxyHls: true,
      upstreamHeaders: xiamenHeaders({ manifest: true }),
    }
  } catch (error) {
    return { url: '', desc: `厦门广电链接请求失败：${error?.message || String(error)}` }
  }
}

export function clearXiamenCache() {
  xiamenStreamCache.clear()
  xiamenPending.clear()
}
