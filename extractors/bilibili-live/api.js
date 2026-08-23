/**
 * 哔哩哔哩直播的平台知识层：房间号归一、三个 API 调用、选流、组频道对象。
 *
 * 这一层刻意只做「输入 → 频道对象」，不碰磁盘、不读全局配置、不写播放列表，
 * 所以可以整层单测。调度、缓存、健康记账都在 utils/extractorManager.js。
 *
 * 移植自 bili-live-m3u（Python），几处刻意不照抄，理由都写在各自函数上。
 */
import fetch from 'node-fetch'

const API = 'https://api.live.bilibili.com'
export const REFERER = 'https://live.bilibili.com/'
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 画质档位。高清以上要登录态，顶档还要大会员——服务端不会拒绝请求，而是
// 静默降档，所以实际给到哪一档值得报出来（也是判断 cookie 有没有生效的信号）。
const QN_NAMES = {
  30000: '杜比', 20000: '4K', 10000: '原画',
  400: '蓝光', 250: '超清', 150: '高清', 80: '流畅',
}

const DEFAULT_GROUP = '哔哩哔哩直播'

/** 一间房失败。其余房间照常，不影响整张播放列表。 */
export class RoomError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RoomError'
  }
}

/**
 * 房间没在播。
 *
 * 与其它 RoomError 分开：全部房间都没开播是「今天没人播」这个正常状态，
 * 而全部房间都报网络错是「这一轮失败了」。两者都表现为 0 个频道，但前者应当
 * 如实写出空结果，后者必须保留上一轮缓存——不区分就会在断网时把用户的频道清空。
 */
export class RoomOfflineError extends RoomError {
  constructor(message) {
    super(message)
    this.name = 'RoomOfflineError'
  }
}

/**
 * 触发了 B 站风控（code -352）。
 *
 * 必须与 RoomError 区分开：风控不是「这一间房失败」而是「所有房间同时失败」，
 * 但表现出来是一串 skipped，和「所有主播都下播了」长得一模一样。不单独识别的话，
 * 用户看到的是「频道全没了」而没有任何线索。
 */
export class RiskControlError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RiskControlError'
  }
}

/**
 * 私有的 HTTP 取数。刻意不复用 utils/net.js 的 fetchUrl——它恒调 .json()、
 * 失败返回 undefined 而不抛、还会 printRed 刷屏；而这里需要读 HTTP 状态码、
 * 需要按 code 分辨风控、需要把错误结构化交给 health() 展示。
 */
async function apiGet(path, params, { cookie, timeoutMs = 10000 } = {}) {
  const url = `${API}${path}?${new URLSearchParams(params)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let payload
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new RoomError(`HTTP ${response.status} from ${path}`)
    payload = await response.json()
  } catch (error) {
    if (error instanceof RoomError) throw error
    // AbortError 的 message 是 'The operation was aborted'，对用户没有信息量
    const reason = error.name === 'AbortError' ? `超时 ${timeoutMs}ms` : error.message
    throw new RoomError(`${path} 请求失败: ${reason}`)
  } finally {
    clearTimeout(timer)
  }

  if (payload?.code !== 0) {
    const message = payload?.message || payload?.code
    if (payload?.code === -352) throw new RiskControlError(`B 站风控 (-352): ${message}`)
    throw new RoomError(`${path}: ${message}`)
  }
  return payload.data || {}
}

/**
 * 房间号归一：纯数字 / 房间 URL / b23.tv 短链 三种写法都认。
 *
 * 与 Python 版的两处差异：
 * 1. 先做全角→半角。Python 的 str.isdigit() 是 Unicode 感知的，「１３」会被当成
 *    房间号发出去（必然失败）；JS 的 /^\d+$/ 只匹配 ASCII，会直接报「不是房间号」。
 *    两种都不好，归一之后两种输入都能用。
 * 2. 短链跟随显式限制跳数并把最终地址写进错误信息，避免跳转环。
 */
/**
 * 热门榜的人气下限。低于这个数的房间一律不进播放列表。
 *
 * 刻意**不做成配置项**：用户不该为「垃圾从第几名开始」操心，那是我们该替他判断的。
 * 而且光有「取前 N 名」调不好——比赛多的时候 N 不够，没比赛的时候 N 个全是垃圾；
 * 加了下限之后是自适应的：有 TI 决赛就给满，平常日子可能只给两三个。
 *
 * 1 万这个值来自实测的分布断层（赛事区当前 40 个在播）：
 *   1~6   名 300万~3700万   真·大型赛事
 *   7~9   名  15万~ 55万    守望先锋世界杯、PGS 吃鸡赛事这类
 *   10~12 名   1万~  9万    羽毛球世锦赛、K甲，还算真赛事
 *   13+   名      <1万      噪音，且有一堆「王者荣耀赛事第一视角7/9/3…」——
 *                            同一场比赛的不同机位，拉进来就是同一内容重复七八条
 *
 * 注意：B 站的「人气」不是真实观看人数，历史上做过量级调整。哪天这个门槛显得
 * 不合理了（大量真赛事被挡掉、或垃圾又漏进来），照上面的方法重新量一次分布再定。
 */
const MIN_ONLINE = 10000

/**
 * 扫码登录：生成二维码。
 *
 * 为什么要有它：SESSDATA 是 **HttpOnly** cookie，咪咕那种「书签读 document.cookie」
 * 的招在这里读不到。剩下的路只有让用户去 F12 → Application → Cookies 里翻，
 * 对家用 IPTV 的普通用户是道硬门槛。扫码登录把它变成「用 B 站 App 扫一下」。
 *
 * 用 passport 域名，不是 api.live —— 所以不能复用 apiGet（那个写死了 API 常量）。
 *
 * @returns {Promise<{url: string, key: string}>} url 是要编成二维码的内容
 */
export async function qrLoginStart({ timeoutMs = 10000 } = {}) {
  const payload = await passportGet('/x/passport-login/web/qrcode/generate', {}, timeoutMs)
  const url = payload?.url
  const key = payload?.qrcode_key
  if (!url || !key) throw new RoomError('二维码生成失败：B 站返回的数据里没有 url/qrcode_key')
  return { url, key }
}

/**
 * 扫码登录：轮询扫码状态。
 *
 * 成功时 SESSDATA **直接在返回的 url 查询参数里**（形如
 * https://passport.biligame.com/crossDomain?DedeUserID=…&SESSDATA=…&bili_jct=…），
 * 不用去解 Set-Cookie —— 省掉一整套 cookie jar 的处理。
 *
 * B 站的状态码：0=成功 / 86101=未扫码 / 86090=已扫码待确认 / 86038=二维码已失效。
 *
 * @returns {Promise<{status:'pending'|'scanned'|'expired'|'ok', message:string, sessdata?:string}>}
 */
export async function qrLoginPoll(key, { timeoutMs = 10000 } = {}) {
  const payload = await passportGet('/x/passport-login/web/qrcode/poll', { qrcode_key: key }, timeoutMs)
  const code = Number(payload?.code)
  const message = String(payload?.message || '')

  if (code === 86101) return { status: 'pending', message: message || '未扫码' }
  if (code === 86090) return { status: 'scanned', message: message || '已扫码，请在手机上确认' }
  if (code === 86038) return { status: 'expired', message: message || '二维码已失效，请重新获取' }
  if (code !== 0) return { status: 'expired', message: message || `未知状态 ${code}` }

  let sessdata = ''
  try {
    sessdata = new URL(String(payload?.url || '')).searchParams.get('SESSDATA') || ''
  } catch { /* url 形状变了就当没拿到，下面统一报错 */ }
  if (!sessdata) throw new RoomError('登录成功但没能从返回地址里取到 SESSDATA —— B 站可能改了返回格式')
  return { status: 'ok', message: '登录成功', sessdata }
}

/** passport 域名的取数。与 apiGet 同款错误处理，只是 base 不同。 */
async function passportGet(path, params, timeoutMs) {
  const url = `https://passport.bilibili.com${path}?${new URLSearchParams(params)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new RoomError(`HTTP ${response.status} from ${path}`)
    const body = await response.json()
    if (body?.code !== 0) throw new RoomError(`${path}: ${body?.message || body?.code}`)
    return body.data || {}
  } catch (error) {
    if (error instanceof RoomError) throw error
    const reason = error.name === 'AbortError' ? `超时 ${timeoutMs}ms` : error.message
    throw new RoomError(`${path} 请求失败: ${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * B 站的直播大区清单（网游 / 手游 / 单机游戏 / 娱乐 / 电台 / 虚拟主播 / 聊天室 / 生活）。
 *
 * 动态拉而不是把 8 个 id 写死：B 站增删过大区，写死的话表现是「用户填的分区名突然
 * 匹配不上、热门榜静默变空」。一次抓取只多一个请求，不值得为此冒僵化的风险。
 *
 * @returns {Promise<Array<{id:number,name:string}>>}
 */
export async function areaList(options) {
  const data = await apiGet('/room/v1/Area/getList', {}, options)
  const list = Array.isArray(data) ? data : []
  return list
    .filter(area => area && area.id != null && area.name)
    .map(area => ({ id: Number(area.id), name: String(area.name).trim() }))
}

/**
 * 某个大区按人气排的前 N 个直播间。
 *
 * 用**老接口** /room/v1/Area/getRoomList：新版的
 * /xlive/web-interface/v1/second/getList 需要 WBI 签名（不签就回 -352），
 * 那意味着要实现并长期维护 B 站一套没文档、会变的签名算法——对这个项目太重了。
 * 老接口同样按 sort_type=online 排序，够用。
 *
 * 大型赛事天然排在最前：实测网游大区前 5 里 4 个是赛事直播（TI 决赛、CS2、无畏契约
 * 总决赛），因为百万级人气碾压普通主播。所以不需要专门的赛事接口。
 *
 * 人气低于 MIN_ONLINE 的一律不要，见那个常量的注释。
 *
 * @returns {Promise<number[]>} 房间号，按人气从高到低
 */
export async function topRoomsOfArea(parentAreaId, count, options) {
  const data = await apiGet('/room/v1/Area/getRoomList', {
    platform: 'web',
    parent_area_id: parentAreaId,
    area_id: 0,
    sort_type: 'online',
    page: 1,
    // 多要一些再截断：未开播/异常的房间在后面 resolveRoom 时会被跳过，
    // 只要正好 count 个的话，跳掉几个就不够数了
    page_size: Math.min(count * 2, 50),
  }, options)
  return selectTopRooms(data, count)
}

/**
 * 热门榜原始条目 → 房间号数组。滤掉人气低于 MIN_ONLINE 的，再截到 count 个。
 *
 * 抽成纯函数是为了能被测试直接打：过滤那一行删掉之后**不会有任何东西变红**，
 * 只是播放列表里悄悄多出一堆「王者荣耀赛事第一视角7」这种同场比赛的小号机位。
 *
 * @param {Array} rawList 接口返回的 data
 * @param {number} count  上限（不是保证——够格的不足这么多就给这么多）
 */
export function selectTopRooms(rawList, count) {
  const list = Array.isArray(rawList) ? rawList : []
  return list
    .filter(room => Number(room?.online) >= MIN_ONLINE)
    .map(room => Number(room?.roomid))
    .filter(id => Number.isInteger(id) && id > 0)
    .slice(0, Math.max(0, Number(count) || 0))
}

export async function normalizeRoom(rawToken, { timeoutMs = 10000 } = {}) {
  const token = toHalfWidth(String(rawToken || '').trim())
  if (!token) throw new RoomError('空的房间标识')

  if (/^\d+$/.test(token)) return token

  const direct = token.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/)
  if (direct) return direct[1]

  if (token.includes('b23.tv/') || token.includes('bili2233.cn/')) {
    const url = token.startsWith('http') ? token : `https://${token}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let finalUrl
    try {
      // follow=默认跟随；node-fetch 的 res.url 给出最终地址，等价于 Python 的 geturl()
      const response = await fetch(url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        follow: 5,
        signal: controller.signal,
      })
      finalUrl = response.url
    } catch (error) {
      throw new RoomError(`短链跟随失败 ${token}: ${error.message}`)
    } finally {
      clearTimeout(timer)
    }
    const resolved = String(finalUrl || '').match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/)
    if (resolved) return resolved[1]
    throw new RoomError(`${token} 不指向直播间 (-> ${finalUrl})`)
  }

  throw new RoomError(`不是房间号或直播间地址: ${token}`)
}

/** 全角数字/字母 → 半角。用户从手机复制过来常带全角。 */
function toHalfWidth(text) {
  return text.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/**
 * 房间基本信息。room_id 统一转成字符串——API 返回的是数字，而归一出来的是
 * 字符串，混用会让后面拿它当 Map key 或做 === 比较时踩到类型不一致。
 */
export async function roomInfo(roomId, options) {
  const data = await apiGet('/room/v1/Room/get_info', { room_id: roomId }, options)
  return {
    // 短号会解析到真实房间号，一律以 API 返回的为准
    roomId: String(data.room_id || roomId),
    uid: data.uid,
    title: (data.title || '').trim(),
    live: data.live_status === 1,
    area: (data.parent_area_name || data.area_name || '').trim(),
  }
}

/** 主播名与头像。纯装饰，失败不能连累整间房。 */
export async function anchorInfo(uid, options) {
  try {
    const data = await apiGet('/live_user/v1/Master/info', { uid }, options)
    const info = data.info || {}
    return { name: (info.uname || '').trim(), avatar: (info.face || '').trim() }
  } catch (error) {
    // 风控要往上抛：它不是「这条装饰信息拿不到」，而是整轮都会失败的信号
    if (error instanceof RiskControlError) throw error
    return { name: '', avatar: '', warning: `主播信息获取失败: ${error.message}` }
  }
}

/**
 * 从 protocol/format/codec 三层矩阵里挑一条能播的地址。
 *
 * 与 Python 版的差异：codec 层加了 avc 优先。请求里带的是 codec="0,1"，
 * 返回顺序由 B 站决定，Python 版直接取第一个，于是可能拿到一条部分播放器
 * （尤其电视盒子）解不了的 HEVC 流，而且取到哪个取决于当天的返回顺序——
 * 是不确定的行为。这里显式排序，默认 avc。
 */
export async function pickStream(roomId, { preferHls = true, preferAvc = true, ...options } = {}) {
  const data = await apiGet('/xlive/web-room/v2/index/getRoomPlayInfo', {
    room_id: roomId,
    protocol: '0,1',   // 0 = http_stream (flv), 1 = http_hls
    format: '0,1,2',   // flv / ts / fmp4
    codec: '0,1',      // avc / hevc
    qn: 10000,         // 原画；房间自己会封顶
    platform: 'web',
    ptype: 8,
  }, options)

  return selectFromPlayurl(data, { preferHls, preferAvc })
}

/**
 * 从 getRoomPlayInfo 的返回里挑地址。纯函数——抽出来是为了能单测选流偏好，
 * 这是整个模块里最容易静默选错、又最难在真实环境复现的一段。
 */
export function selectFromPlayurl(data, { preferHls = true, preferAvc = true } = {}) {
  const streams = data?.playurl_info?.playurl?.stream || []
  if (!streams.length) throw new RoomError('playurl 里没有 stream（未开播或地区限制）')

  const wantProtocol = preferHls ? 'http_hls' : 'http_stream'
  const wantCodec = preferAvc ? 'avc' : 'hevc'
  const byName = (want) => (a, b) =>
    (a === want ? 0 : 1) - (b === want ? 0 : 1)

  const sortedStreams = [...streams].sort((a, b) =>
    byName(wantProtocol)(a.protocol_name, b.protocol_name))

  for (const stream of sortedStreams) {
    for (const format of stream.format || []) {
      const codecs = [...(format.codec || [])].sort((a, b) =>
        byName(wantCodec)(a.codec_name, b.codec_name))
      for (const codec of codecs) {
        const base = codec.base_url || ''
        for (const hostInfo of codec.url_info || []) {
          const host = hostInfo.host || ''
          const extra = hostInfo.extra || ''
          // 必须是裸字符串相加：extra 里那段带 expires token 的 query
          // 一旦经过 new URL() 或 url.resolve() 就会被丢掉或重新编码，地址直接失效
          if (host && base) return { url: `${host}${base}${extra}`, qn: codec.current_qn }
        }
      }
    }
  }

  throw new RoomError('playurl 里没有可用的 host/base_url')
}

/**
 * 解析一间房 → 一个频道对象。
 *
 * 返回的对象形状必须与 externalSources/builtInSources 的 getValidChannels()
 * 同构，才能被 channelMerger 原样吞下（见 utils/channelMerger.js 的合并逻辑）。
 */
export async function resolveRoom(roomRef, options = {}) {
  const { cookie, preferHls = true, preferAvc = true, cachingMs = 3000, timeoutMs } = options
  const netOptions = { cookie, timeoutMs }

  const roomId = await normalizeRoom(roomRef, netOptions)
  const info = await roomInfo(roomId, netOptions)
  if (!info.live) throw new RoomOfflineError('未开播')

  const { url, qn } = await pickStream(info.roomId, { preferHls, preferAvc, ...netOptions })
  const anchor = info.uid
    ? await anchorInfo(info.uid, netOptions)
    : { name: '', avatar: '' }

  const displayName = anchor.name || `房间 ${info.roomId}`
  const tier = QN_NAMES[qn] || (qn ? String(qn) : '?')
  const name = `[${tier}] ` + (info.title ? `${displayName} · ${info.title}` : displayName)

  // 请求头交给 utils/channelOpts.js 渲染，这里只产出结构化的 key=value；
  // 不要自己做 M3U 转义，否则会与生成侧的消毒重复转义。
  //
  // 实测卡的是 UA 不是 Referer（裸请求 403 / 只给 Referer 仍 403 / 只给 UA 就 200），
  // 但两条都发：校验口径 B 站随时可能调，多一个头没有代价。
  const opts = [
    `http-referrer=${REFERER}`,
    `http-user-agent=${UA}`,
    ...(cachingMs ? [`network-caching=${cachingMs}`] : []),
  ]

  return {
    channel: {
      name: sanitizeText(name),
      logo: anchor.avatar || '',
      url,
      opts,
      groupTitle: sanitizeText(info.area || DEFAULT_GROUP),
    },
    group: sanitizeText(info.area || DEFAULT_GROUP),
    warning: anchor.warning,
  }
}

/**
 * 频道名/分组名去掉换行与引号。
 *
 * 引号换成单引号是因为 EXTINF 的属性值是双引号包裹的（见 updateData.js 的
 * tvg-id="${channelItem.name}"）——一个裸双引号会把整行语法撑坏，
 * 这与 utils/externalSources.js:11-18 处理 issue #84 时的顾虑是同一个。
 */
function sanitizeText(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim()
}

/**
 * 解析房间清单文本：一行一个，`#` 之后是注释。
 *
 * 与 Python 版差异：只有当这一行不像 URL 时才按 `#` 剥注释。Python 版无条件
 * 按 `#` 切，会把带 fragment 的地址截断；而 B 站分享链接确实可能带 `#`。
 */
export function parseRoomList(text) {
  const rooms = []
  for (const raw of String(text || '').split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // 形如 `13   # 备注`：URL 之外的写法才剥行尾注释
    if (!/^https?:\/\//i.test(line)) {
      line = line.split('#')[0].trim()
    } else {
      // URL 后面跟注释的写法：`https://... # 备注`——按空白切，fragment 得以保留
      line = line.split(/\s+/)[0]
    }
    if (line) rooms.push(line)
  }
  return rooms
}

/**
 * 有上限的并发映射。
 *
 * 不用 Promise.all 全量并发：B 站对短时间大量请求会回 -352 风控，而外部源那边
 * 「串行 + 每个之间硬睡 2 秒」又太慢（房间一多就是分钟级）。折中成小并发。
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export { QN_NAMES, DEFAULT_GROUP }
