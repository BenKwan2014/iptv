/**
 * 抓取模块：哔哩哔哩直播。
 *
 * 模块契约（见 extractors/registry.js 顶部注释）里，本模块用到的部分：
 *   fetch(config, ctx) → { groups: [{name, dataList}], meta }
 * 不实现 resolve()——B 站的地址是直链（带 expires token，约 2 小时过期），
 * 靠 defaultRefreshMinutes 的短周期刷新兜住，不需要播放时二次解析。
 */
import { resolveRoom, parseRoomList, mapLimit, areaList, topRoomsOfArea, qrLoginStart, qrLoginPoll, RiskControlError, RoomOfflineError, DEFAULT_GROUP } from './api.js'

// 并发上限。B 站对短时间内的大量请求会回 -352，实测 3 路是安全且够快的折中；
// 外部源那边「串行 + 每个之间硬睡 2 秒」的做法在房间数上去之后是分钟级，不抄。
const CONCURRENCY = 3

/**
 * 这一轮算不算失败。
 *
 * 一条都没解析出来、且至少有一间房是真出错（不是没开播）→ 判失败，交给
 * extractorManager 保留上一轮缓存并退避重试，而不是把用户的频道清空。
 * 反之，全部房间都没开播时如实返回 0 条：那是「今天没人播」这个正常状态。
 *
 * 抽成纯函数是为了能单测——否则要真断网才走得到这条路径。
 */
export function shouldFailRound(groupCount, hardErrors) {
  return groupCount === 0 && hardErrors > 0
}

/**
 * 「自动加入热门直播间的分区」那个多行文本框 → 分区名数组。
 * 与 parseRoomList 同款约定：一行一个、去首尾空白、忽略空行与 # 开头的注释。
 */
export function parseAreaNames(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
}

/**
 * 手填清单 + 热门榜 → 去重后的抓取清单。
 *
 * 手填的排前面：那是用户明确指定的主播，热门榜只是「顺便给点内容」；顺序还决定了
 * 同名频道在播放器「源1 / 源2」里的先后。
 * 去重按房间号的字符串形式——热门榜里可能正好有用户已经手填过的那个房间，
 * 不去重的话同一个直播间会在播放列表里出现两次（同名、同地址，纯噪音）。
 */
export function mergeRoomRefs(manual, auto) {
  const seen = new Set()
  const out = []
  for (const ref of [...(manual || []), ...(auto || [])]) {
    const key = String(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

/**
 * 按配置的分区名，取各分区人气前 N 的直播间。
 *
 * 存在的理由：不这么做的话，用户想用 B 站直播就得自己去网页上一个个找房间号——
 * 那是这个模块最劝退的一步。默认填「赛事」，开箱就是当前正在打的比赛。
 *
 * **不硬编码房间号**：主播会退播、赛事会结束，写死的清单必然烂掉。每轮抓取现查，
 * 拿到的永远是此刻真在播的。
 *
 * 失败不抛，但要**分账记**：「分区名写错」是配置问题，只记 warning；「分区清单 /
 * 热门榜接口获取失败」是网络层问题，除记 warning 外还计入 fetchFailures——
 * 外层 fetch() 把它并进 hardErrors 交给 shouldFailRound 判整轮成败。不分账的话，
 * 默认配置（纯热门榜、不手填）下一次断网 / 接口 5xx 会被当成「正常抓到 0 个
 * 直播间」，上一轮的频道被覆盖成空且不退避重试；这里抛的话，一个写错的分区名
 * 又会让整个模块报失败。两头都不对，所以记账、让外层按「还有没有别的收成」裁决。
 *
 * @returns {Promise<{rooms: number[], warnings: string[], fetchFailures: number, failureMessages: string[]}>}
 */
async function collectTopRooms(config, ctx) {
  const perArea = Number(config.topPerArea)
  const names = parseAreaNames(config.topAreas)
  if (!(perArea > 0) || !names.length) return { rooms: [], warnings: [], fetchFailures: 0, failureMessages: [] }

  const options = { timeoutMs: ctx.timeoutMs || 10000 }
  const warnings = []
  // 网络层失败的原话单独记一份：整轮判失败时错误消息要引用**这里**的原因，
  // 不能拿 warnings[0]——那可能是「分区名不存在」这类配置提示，归因会张冠李戴。
  const failureMessages = []

  let areas
  try {
    areas = await areaList(options)
  } catch (error) {
    // 风控要往上抛：让 health() 报「被风控」而不是一条不起眼的 warning
    if (error instanceof RiskControlError) throw error
    const message = `分区清单获取失败，本轮不自动加入热门直播间：${error.message}`
    return { rooms: [], warnings: [message], fetchFailures: 1, failureMessages: [message] }
  }

  const byName = new Map(areas.map(area => [area.name, area.id]))
  const rooms = []
  for (const name of names) {
    const id = byName.get(name)
    if (id == null) {
      warnings.push(`分区「${name}」在 B 站不存在，已跳过（当前可用：${areas.map(a => a.name).join(' / ')}）`)
      continue
    }
    try {
      // topRoomsOfArea 内部已经滤过人气下限并截到 perArea 个（见 selectTopRooms）
      rooms.push(...await topRoomsOfArea(id, perArea, options))
    } catch (error) {
      // 风控要往上抛：让 health() 报「被风控」而不是一条不起眼的 warning
      if (error instanceof RiskControlError) throw error
      const message = `分区「${name}」热门榜获取失败，已跳过：${error.message}`
      failureMessages.push(message)
      warnings.push(message)
    }
  }
  return { rooms, warnings, fetchFailures: failureMessages.length, failureMessages }
}

export default {
  id: 'bilibili-live',
  name: '哔哩哔哩直播',
  description: '把 B 站直播间变成频道。地址带防盗链，靠 #EXTVLCOPT 传请求头才能播。',

  // 直链模块：结果小（一个房间一条），可以落盘缓存，失败时用它兜底。
  capabilities: { cache: 'disk', resolve: false, epg: false },

  // 流地址约 2 小时过期，留出 1~2 轮重试余量。
  // 注意别照抄外部源的 240 分钟默认值（utils/externalSources.js 的 refreshInterval），
  // 那对 2 小时过期的源是致命的。
  defaultRefreshMinutes: 45,
  minRefreshMinutes: 45,
  maxRefreshMinutes: 90,

  // 后台在这个模块的卡片里额外渲染一块助手 UI（markup 在 admin.html，与咪咕的
  // migu-bookmarklet 同款约定：具体长相属于前端，模块只声明「我要哪一块」）。
  helper: 'bilibili-login',
  // 挂在「登录态」那一段的开头，而不是整个表单最上面
  helperSection: '登录态（选填）',

  // 扫码登录。声明成通用的 loginFlow 而不是在 API 层写死 B 站：将来别的模块
  // （比如咪咕）想加扫码/授权流程，声明同样的两个函数即可，不用动框架。
  //   start()      → { url, key }   url 是要编成二维码的内容
  //   poll(key, {cookie}) → { status, message, sessdata? }  status: pending|scanned|expired|failed|ok
  //   start() 返回的 cookie 是这次登录的设备标识，由 API 层与 key 绑定后在 poll 时回传
  //   configKey    → 登录成功后把凭据写进哪个配置字段
  loginFlow: {
    configKey: 'sessdata',
    start: qrLoginStart,
    poll: qrLoginPoll,
  },

  configSchema: [
    // 「频道从哪来」有两条路，而且可以同时用。原先它们平铺成兄弟项、手填的还排在
    // 前面，用户第一眼看不出该用哪个。现在自动的排前面（那是默认路径、开箱即用），
    // 手填的排后面并写明「可留空」，再靠 section 归到同一段里。
    {
      key: 'topAreas',
      section: '频道从哪来 —— 两种可以同时用，结果取并集（重复的直播间只出现一次，手填的排在前面）',
      group: '① 自动：按分区加入热门直播间',
      label: '分区（一行一个）',
      type: 'text',
      multiline: true,
      placeholder: '一行一个分区名\n赛事\n网游\n# 井号开头是注释',
      // 默认「赛事」：那是 B 站的官方赛事转播区，人气比普通直播区高一个数量级
      //（实测 3921 万 vs 254 万），内容全是正在打的比赛、不会混进普通主播，
      // 是「不用自己找房间号也能开箱即用」这件事最合适的默认值。
      default: '赛事',
      // 注意别写「留空＝关闭」：文本清空保存＝回到没配过（稀疏存储约定），会
      // 回落默认「赛事」而不是关闭——真想关自动加入的口子是 topPerArea 填 0。
      hint: '推荐用这个，不用自己找房间号。默认「赛事」＝当前正在打的比赛（英雄联盟 / 王者 / DOTA2 等官方赛事转播）。可填：赛事 / 网游 / 手游 / 单机游戏 / 娱乐 / 电台 / 虚拟主播 / 聊天室 / 生活 / 知识 / 互动玩法 / 购物；写错会在上面的健康状态里提示。频道在播放列表里按分区名归组（默认即「赛事」组），组名不合口味可在「我的频道」用该分组的「重命名」改，按配置档各自生效。清空保存会回到默认「赛事」；想只用右边手填的，把下面「每个分区取前几名」填 0。',
    },
    {
      key: 'topPerArea',
      section: '频道从哪来 —— 两种可以同时用，结果取并集（重复的直播间只出现一次，手填的排在前面）',
      group: '① 自动：按分区加入热门直播间',
      label: '每个分区取前几名',
      type: 'int',
      min: 0,
      max: 20,
      // 8 而不是 5：实测赛事区人气在第 6~7 名之间有 82% 的断崖，取 5 会漏掉
      // 「第五人格 IVL 夏季赛总决赛」这种 300 万人在看的比赛。8 正好覆盖到断崖处。
      default: 8,
      hint: '按人气从高到低，是上限不是保证。人气过低的会被自动滤掉（免得把同一场比赛的多机位小号也拉进来），所以清闲时段实际条数会少于这个值。填 0 ＝ 只关掉左边这一列，右边手填的照常生效。',
    },
    {
      key: 'rooms',
      section: '频道从哪来 —— 两种可以同时用，结果取并集（重复的直播间只出现一次，手填的排在前面）',
      group: '② 手动：指定直播间',
      label: '房间号 / 直播间地址（一行一个，可留空）',
      type: 'text',
      multiline: true,
      placeholder: '一行一个：房间号 / 直播间地址 / b23.tv 短链\n13\nhttps://live.bilibili.com/1022\n# 井号开头是注释',
      hint: '想固定看某个主播时才填，不填也能用。房间号是地址路径里的数字，不是 live_from= 那种参数，直接粘完整地址最稳。未开播的房间会自动跳过。这里填的排在热门榜之前。',
      default: '',
    },
    {
      key: 'sessdata',
      section: '登录态（选填）',
      label: 'SESSDATA（登录态）',
      type: 'text',
      secret: true,
      // 没有 env 兜底的话，docker 用户没法在 compose 里注入凭据。这里让 schema
      // 自己声明环境变量名，由 extractorManager 统一兜底——比给每个模块往
      // config.js 里加一个全局字段更能扩展（每加一个模块就要动 5 个文件）。
      env: 'mbiliSessdata',
      hint: '不填也能用，但画质会被限制在「超清」。填了才有「原画」。等同登录态，别外传。',
      default: '',
    },
    {
      key: 'preferHls',
      section: '播放偏好',
      label: '优先 HLS',
      type: 'boolean',
      hint: '关掉则优先 FLV。HLS 是分段的，中途卡顿后播放器更容易自己恢复。',
      default: true,
    },
    {
      key: 'preferAvc',
      section: '播放偏好',
      label: '优先 H.264',
      type: 'boolean',
      hint: '关掉则优先 HEVC（H.265）。老电视盒子多数解不了 HEVC，默认开着更稳。',
      default: true,
    },
    {
      key: 'cachingMs',
      section: '播放偏好',
      label: '播放缓冲 (ms)',
      type: 'int',
      min: 0,
      max: 60000,
      hint: '写进 #EXTVLCOPT:network-caching。家宽上直播流缓冲小了容易卡，0 表示不写。',
      default: 3000,
    },
  ],

  /**
   * @param {object} config 已由 extractorManager 按 configSchema 校验并补齐默认值
   * @param {object} ctx    { timeoutMs, signal }
   */
  async fetch(config, ctx = {}) {
    const manualRefs = parseRoomList(config.rooms)
    const autoResult = await collectTopRooms(config, ctx)

    const refs = mergeRoomRefs(manualRefs, autoResult.rooms)

    if (!refs.length) {
      // 一间房都没有，且热门榜是「获取失败」而非「没配 / 没人播」——这一轮就是
      // 失败，必须抛：返回空的话会被记成「成功抓到 0 频道」，上一轮缓存被覆盖成
      // 空、consecutiveFailures 归零，既不退避也要等满刷新周期才重试。默认配置
      // 正是纯热门榜，一次瞬时网络故障就会清空全部 B 站频道。
      if (autoResult.fetchFailures > 0) {
        throw new Error(autoResult.failureMessages[0] || '热门榜获取失败，本轮没有可抓的直播间')
      }
      return {
        groups: [],
        meta: {
          skipped: [],
          warnings: [...autoResult.warnings, '没有可抓的直播间——填几个房间号，或在「自动加入热门直播间的分区」里填个分区名'],
        },
      }
    }

    const options = {
      cookie: config.sessdata ? `SESSDATA=${config.sessdata}` : '',
      preferHls: config.preferHls !== false,
      preferAvc: config.preferAvc !== false,
      cachingMs: Number(config.cachingMs) || 0,
      timeoutMs: ctx.timeoutMs || 10000,
    }

    const skipped = []
    const warnings = [...autoResult.warnings]
    let riskControl = null
    // 第一条「真出错」（非未开播）的原话，供整轮失败时归因——skipped[0] 靠不住，
    // 它多半是「未开播」这个被明确定义为正常状态的原因。
    let firstHardReason = null
    // 「没开播」与「出错了」要分开计：两者都产出 0 个频道，但前者是正常状态、
    // 后者是这一轮失败了。混在一起的话，断网时会被记成「成功抓到 0 个频道」，
    // 把上一轮的缓存覆盖成空——用户的频道就此消失且不退避重试。
    // 热门榜的网络层失败也计进来：手填的房间恰好都没开播 + 热门榜挂了，同样
    // 该判整轮失败保缓存，而不是「成功 0 频道」。
    let hardErrors = autoResult.fetchFailures

    const results = await mapLimit(refs, CONCURRENCY, async (ref) => {
      try {
        return await resolveRoom(ref, options)
      } catch (error) {
        // 风控是全局性的：记下来，等这一轮跑完统一往上抛，让 health() 报
        // 「被风控」而不是一串「未开播」——后者会让用户以为主播都下播了。
        if (error instanceof RiskControlError) {
          riskControl = riskControl || error
          return null
        }
        if (!(error instanceof RoomOfflineError)) {
          hardErrors++
          firstHardReason = firstHardReason || error.message
        }
        skipped.push({ ref: String(ref), reason: error.message })
        return null
      }
    })

    if (riskControl) throw riskControl

    // 按 B 站分区归组，与咪咕/外部源的 [{name, dataList}] 同构。
    // mergeRoomRefs 只按用户填的字面量去重，URL / 短号 / 短链写法各异时同一间房
    // 会漏网（rooms 字段还推荐「直接粘完整地址」）——这里按归一后的真实房间号
    // 再去一次重。refs 手填在前、mapLimit 按下标写结果，保留首个即保留手填优先序。
    const byGroup = new Map()
    const seenRooms = new Set()
    for (const result of results) {
      if (!result) continue
      if (result.roomId) {
        if (seenRooms.has(result.roomId)) continue
        seenRooms.add(result.roomId)
      }
      if (result.warning) warnings.push(result.warning)
      const groupName = result.group || DEFAULT_GROUP
      if (!byGroup.has(groupName)) byGroup.set(groupName, { name: groupName, dataList: [] })
      byGroup.get(groupName).dataList.push(result.channel)
    }

    const groups = [...byGroup.values()]

    if (shouldFailRound(groups.length, hardErrors)) {
      // 归因要分账：热门榜接口失败与直播间获取失败是两码事，混着算分子会把
      // 「热门榜挂了 + 手填的都没开播」报成「N/M 个直播间获取失败：未开播」。
      const roomErrors = hardErrors - autoResult.fetchFailures
      const parts = []
      if (autoResult.fetchFailures > 0) parts.push(autoResult.failureMessages[0])
      if (roomErrors > 0) parts.push(`${roomErrors}/${refs.length} 个直播间获取失败：${firstHardReason || '未知原因'}`)
      throw new Error(`${parts.join('；')}（本轮无一成功，沿用上一轮结果）`)
    }

    return {
      groups,
      meta: { skipped, warnings, requested: refs.length, hardErrors },
    }
  },
}
