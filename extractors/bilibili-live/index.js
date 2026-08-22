/**
 * 抓取模块：哔哩哔哩直播。
 *
 * 模块契约（见 extractors/registry.js 顶部注释）里，本模块用到的部分：
 *   fetch(config, ctx) → { groups: [{name, dataList}], meta }
 * 不实现 resolve()——B 站的地址是直链（带 expires token，约 2 小时过期），
 * 靠 defaultRefreshMinutes 的短周期刷新兜住，不需要播放时二次解析。
 */
import { resolveRoom, parseRoomList, mapLimit, RiskControlError, DEFAULT_GROUP } from './api.js'

// 并发上限。B 站对短时间内的大量请求会回 -352，实测 3 路是安全且够快的折中；
// 外部源那边「串行 + 每个之间硬睡 2 秒」的做法在房间数上去之后是分钟级，不抄。
const CONCURRENCY = 3

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
    const refs = parseRoomList(config.rooms)
    if (!refs.length) {
      return {
        groups: [],
        meta: { skipped: [], warnings: ['直播间清单是空的——先在配置里填几个房间号'] },
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
    const warnings = []
    let riskControl = null

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

    // 全部房间都没开播时返回 0 条。这不是失败——是「今天没人播」这个正常状态，
    // extractorManager 只在抓取「失败」时才沿用上一轮缓存，0 条会如实写出。
    return {
      groups: [...byGroup.values()],
      meta: { skipped, warnings, requested: refs.length },
    }
  },
}
