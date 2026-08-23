/**
 * 抓取模块：哔哩哔哩直播。
 *
 * 模块契约（见 extractors/registry.js 顶部注释）里，本模块用到的部分：
 *   fetch(config, ctx) → { groups: [{name, dataList}], meta }
 * 不实现 resolve()——B 站的地址是直链（带 expires token，约 2 小时过期），
 * 靠 defaultRefreshMinutes 的短周期刷新兜住，不需要播放时二次解析。
 */
import { resolveRoom, parseRoomList, mapLimit, areaList, topRoomsOfArea, RiskControlError, RoomOfflineError, DEFAULT_GROUP } from './api.js'

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
 * 失败不抛：分区名写错、某个分区接口抽风，都只记一条 warning 让健康状态显示出来，
 * 手填的清单照常抓。整轮成败由外层的 shouldFailRound 判定——这里抛的话，
 * 一个写错的分区名就会让整个模块报失败、把上一轮的频道覆盖没。
 *
 * @returns {Promise<{rooms: number[], warnings: string[]}>}
 */
async function collectTopRooms(config, ctx) {
  const perArea = Number(config.topPerArea)
  const names = parseAreaNames(config.topAreas)
  if (!(perArea > 0) || !names.length) return { rooms: [], warnings: [] }

  const options = { timeoutMs: ctx.timeoutMs || 10000 }
  const warnings = []

  let areas
  try {
    areas = await areaList(options)
  } catch (error) {
    return { rooms: [], warnings: [`分区清单获取失败，本轮不自动加入热门直播间：${error.message}`] }
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
      warnings.push(`分区「${name}」热门榜获取失败，已跳过：${error.message}`)
    }
  }
  return { rooms, warnings }
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

  configSchema: [
    {
      key: 'rooms',
      label: '直播间清单',
      type: 'text',
      multiline: true,
      placeholder: '一行一个：房间号 / 直播间地址 / b23.tv 短链\n13\nhttps://live.bilibili.com/1022\n# 井号开头是注释',
      hint: '房间号是地址路径里的数字，不是 live_from= 那种参数。直接粘完整地址最稳。未开播的房间会自动跳过。',
      default: '',
    },
    {
      key: 'topAreas',
      label: '自动加入热门直播间的分区',
      type: 'text',
      multiline: true,
      placeholder: '一行一个分区名\n赛事\n网游\n# 井号开头是注释',
      // 默认「赛事」：那是 B 站的官方赛事转播区，人气比普通直播区高一个数量级
      //（实测 3921 万 vs 254 万），内容全是正在打的比赛、不会混进普通主播，
      // 是「不用自己找房间号也能开箱即用」这件事最合适的默认值。
      default: '赛事',
      hint: '省去自己找房间号。当前可填：赛事 / 网游 / 手游 / 单机游戏 / 娱乐 / 电台 / 虚拟主播 / 聊天室 / 生活 / 知识 / 互动玩法 / 购物。分区名以 B 站为准（写错会在下面的健康状态里提示）。留空则只用上面手填的清单。',
    },
    {
      key: 'topPerArea',
      label: '每个分区取前几名',
      type: 'int',
      min: 0,
      max: 20,
      // 8 而不是 5：实测赛事区人气在第 6~7 名之间有 82% 的断崖，取 5 会漏掉
      // 「第五人格 IVL 夏季赛总决赛」这种 300 万人在看的比赛。8 正好覆盖到断崖处。
      default: 8,
      hint: '按人气从高到低，是上限不是保证。人气过低的直播间会被自动滤掉（避免把同一场比赛的多机位小号也拉进来），所以清闲时段实际条数会少于这个值。填 0 关掉本功能。',
    },
    {
      key: 'sessdata',
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
      label: '优先 HLS',
      type: 'boolean',
      hint: '关掉则优先 FLV。HLS 是分段的，中途卡顿后播放器更容易自己恢复。',
      default: true,
    },
    {
      key: 'preferAvc',
      label: '优先 H.264',
      type: 'boolean',
      hint: '关掉则优先 HEVC（H.265）。老电视盒子多数解不了 HEVC，默认开着更稳。',
      default: true,
    },
    {
      key: 'cachingMs',
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
    // 「没开播」与「出错了」要分开计：两者都产出 0 个频道，但前者是正常状态、
    // 后者是这一轮失败了。混在一起的话，断网时会被记成「成功抓到 0 个频道」，
    // 把上一轮的缓存覆盖成空——用户的频道就此消失且不退避重试。
    let hardErrors = 0

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
        if (!(error instanceof RoomOfflineError)) hardErrors++
        skipped.push({ ref: String(ref), reason: error.message })
        return null
      }
    })

    if (riskControl) throw riskControl

    // 按 B 站分区归组，与咪咕/外部源的 [{name, dataList}] 同构
    const byGroup = new Map()
    for (const result of results) {
      if (!result) continue
      if (result.warning) warnings.push(result.warning)
      const groupName = result.group || DEFAULT_GROUP
      if (!byGroup.has(groupName)) byGroup.set(groupName, { name: groupName, dataList: [] })
      byGroup.get(groupName).dataList.push(result.channel)
    }

    const groups = [...byGroup.values()]

    if (shouldFailRound(groups.length, hardErrors)) {
      throw new Error(`${hardErrors}/${refs.length} 个直播间获取失败，无一成功：${skipped[0]?.reason || '未知原因'}`)
    }

    return {
      groups,
      meta: { skipped, warnings, requested: refs.length, hardErrors },
    }
  },
}
