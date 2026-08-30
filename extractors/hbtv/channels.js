/** 长江云官网当前公开展示的六套湖北省级电视直播。 */

export const CHANNELS = Object.freeze([
  Object.freeze({ id: '431', rawName: '湖北卫视', name: '湖北卫视', streamPath: 'new-hbws' }),
  Object.freeze({ id: '432', rawName: '湖北经视', name: '湖北经视', streamPath: 'new-hbjs' }),
  Object.freeze({ id: '433', rawName: '湖北综合', name: '湖北综合', streamPath: 'new-hbzh' }),
  Object.freeze({ id: '435', rawName: '湖北影视', name: '湖北影视', streamPath: 'new-hbys' }),
  Object.freeze({ id: '437', rawName: '湖北教育', name: '湖北教育', streamPath: 'new-hbjy' }),
  Object.freeze({ id: '438', rawName: '垄上频道', name: '湖北垄上', streamPath: 'new-hbls' }),
])

export const CHANNEL_BY_ID = new Map(CHANNELS.map(channel => [channel.id, channel]))

export function channelIdFromRef(ref) {
  const match = /^hbtv-(\d{3})$/.exec(String(ref || ''))
  return match && CHANNEL_BY_ID.has(match[1]) ? match[1] : ''
}

export function buildChannels() {
  return CHANNELS.map(channel => ({
    name: channel.name,
    deferredRef: `hbtv-${channel.id}`,
    // CDN 清单有浏览器指纹校验，分片又要求官网 Referer；两者都在服务端完成，
    // 不把匿名 client-id、短效票或请求头暴露给播放器。
    proxyHls: true,
    logo: '',
    opts: ['network-caching=3000'],
  }))
}
