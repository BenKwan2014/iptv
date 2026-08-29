/** 广东台荔枝网当前提供的固定电视直播频道。 */

export const CHANNELS = [
  { id: '43', name: '广东卫视' },
  { id: '44', name: '广东珠江' },
  { id: '45', name: '广东新闻' },
  { id: '48', name: '广东民生' },
  { id: '47', name: '广东体育' },
  { id: '51', name: '大湾区卫视' },
  { id: '46', name: '大湾区卫视（海外版）' },
  { id: '53', name: '广东影视' },
  { id: '16', name: '广东4K超高清' },
  { id: '54', name: '广东少儿' },
  { id: '66', name: '嘉佳卡通' },
  // 官网还有 id=42 的南方购物，按项目其它省级模块的规则固定排除。
  { id: '15', name: '岭南戏曲' },
  { id: '74', name: '广东移动' },
  { id: '100', name: '广东台经典剧' },
  { id: '94', name: '广东纪录片' },
  { id: '99', name: '广东健康' },
  { id: '102', name: 'GRTN生活' },
]

export const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))

export function channelPageUrl(channelId) {
  const id = String(channelId || '')
  if (!CHANNEL_BY_ID.has(id)) throw new Error('广东台频道 ID 无效')
  return `https://www.gdtv.cn/tvChannelDetail/${id}`
}

/**
 * 频道编号来自官网固定路由，不把约两分钟过期的播放地址写进频道缓存。
 * 播放时由 resolver.js 通过浏览器会话即时换取地址。
 */
export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: `gdtv-${channel.id}`,
    relayHls: true,
    logo: '',
    opts: ['network-caching=3000'],
  }))
}

export function channelIdFromRef(ref) {
  const match = /^gdtv-(\d{1,8})$/.exec(String(ref || ''))
  return match && CHANNEL_BY_ID.has(match[1]) ? match[1] : ''
}
