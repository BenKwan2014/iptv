/**
 * 抓取模块：咪咕视频。
 *
 * 这是把既有内核收编成模块的第一例，所以处处以「对老用户零变化」为准绳。
 * 三条 wire format 一个都不能动，每一条被违反都是静默摧毁存量配置：
 *
 * 1. 写盘地址保持 `${replace}/<裸数字pID>` 单段 —— playlistConfig.buildChannelId
 *    用它当频道主键，改了老用户「我的频道」的隐藏/重命名/归类/排序全部作废。
 *    所以 deferredRef 直接就是 pID，不加任何前缀。
 * 2. source-ids 保持字面量 'migu' —— 老用户「按配置档禁用源」里存的就是它。
 *    所以声明 sourceId: 'migu' 覆盖注册表默认的 'xt:<id>'。
 * 3. 节目单照常抓 —— 频道上打 wantsPlayback，让 updateData 按能力而不是按源类型
 *    决定要不要抓，否则会被 `!isExtractor` 那条守卫掐断。
 *
 * 开关继续是 config.js 的 enableMigu：它被 updateData / channelMerger / app.js
 * 等多处直接 import，在 extractors.json 里另开一份会两个开关打架。
 *
 * 已收编：频道列表抓取（fetch）、播放时解析（resolve，见 ./resolve.js）。
 *
 * 刻意**不**收编、且不是「以后有空再说」的两块：
 *   - 体育赛事（utils/updateData.js 的 updatePE）。模块 fetch() 有 90 秒墙钟上限，
 *     而它要串行打 141+ 次赛事接口，塞进来必超时 → 记为模块失败 → 冷启动时
 *     0 频道守卫触发 → 整份播放列表停止生成。且两者失败语义相反：频道列表失败
 *     要沿用旧数据，赛事失败宁可没有也不要分发过期 pID。
 *   - 画质参数（config.js 的 rateType / enableHDR / enableH265 / enableClientDispatch）。
 *     归属上确实该在这里，但现有 configSchema 机制接不住：withEnvFallback 只兜
 *     字符串真值，menableHDR=false / mrateType=4 会静默失效；且存量
 *     system-config.json 里的值无接管方，设了蓝光/4K 的用户会当场降档到 720p。
 *     前置条件是先扩 withEnvFallback（用 hasOwnProperty + parseBool 语义）、
 *     加 type:'select'、updateModuleConfig 补 clearResolveCache、做双读兼容迁移。
 */
import { dataList } from "../../utils/fetchList.js"
import { resolve, clearCache } from "./resolve.js"
import { enableMigu } from "../../config.js"

export default {
  id: 'migu',
  name: '咪咕视频',
  description: '央视 / 卫视 / 地方等 300+ 频道。开关在「系统配置 → 启用咪咕源」。',

  // 归属标识保持字面量 'migu'，不用注册表默认的 'xt:migu'（见文件头约束 2）
  sourceId: 'migu',

  // 结果大、每轮都变、带着咪咕返回的全部原始字段，落盘纯属浪费
  capabilities: { cache: 'memory', resolve: true, epg: true },

  // 与 app.js 的整点更新同频；咪咕地址是播放时才解析的，不存在过期问题
  defaultRefreshMinutes: 360,

  // 咪咕的画质参数（rateType / enableHDR / enableH265）目前仍在 config.js，
  // 由「系统配置」页管理。搬进这里是下一步的事，本轮不动以免影响存量用户。
  configSchema: [],

  // 开关代理到 config.js：那是全项目认的那一个，不另开一份
  enabledGetter: () => enableMigu,

  /**
   * 这个 ref 是不是咪咕的。
   *
   * 保持 isNaN 语义，**不要**收紧成 /^\d+$/——现网 isNaN("") / isNaN("1e3") /
   * isNaN("0x10") 都是 false，都会被放行走到咪咕接口。收紧会改掉
   * 「地址格式错误」的边界，属于可观察行为变更。
   */
  claimsRef: (ref) => !isNaN(ref),

  /**
   * 播放时解析。注意**不判 enableMigu**：收编前的 channel() 也从不判，
   * 加守卫会让「关掉咪咕源但订阅里仍有咪咕地址」的用户从能播变不能播。
   */
  resolve,

  clearResolveCache: clearCache,

  async fetch() {
    const cates = await dataList()

    // 咪咕接口返回的就是 [{name, dataList}] 形状，与注册表契约天然同构，
    // 这里只补三个字段，其余原样透传（EPG 要 pID，台标要 pics）。
    const groups = (cates || [])
      .filter(cate => cate && cate.name && Array.isArray(cate.dataList))
      .map(cate => ({
        name: cate.name,
        dataList: cate.dataList
          .filter(item => item && item.name && item.pID != null)
          .map(item => ({
            ...item,
            deferredRef: item.pID,   // → ${replace}/<pID>，必须是裸数字单段
            wantsPlayback: true,     // 要抓节目单
          })),
      }))

    const count = groups.reduce((sum, g) => sum + g.dataList.length, 0)
    return {
      groups,
      meta: { skipped: [], warnings: [], requested: count },
    }
  },
}
