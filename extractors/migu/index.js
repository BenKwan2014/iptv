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
import { setSystemFlagAPI } from "../../utils/systemConfigAPI.js"

/**
 * 跨分组去重：同一个 pID 只留在**最先出现**的那个分组里。
 *
 * 咪咕按自己的分类给同一个频道打多个标签：CCTV1 同时出现在 央视/影视/新闻/纪实，
 * 四份**完全一样**——同名、同 tvg-id、同地址，只有 group-title 不同。代价都是实的：
 *
 *   · 播放器按名把同名频道聚合成「源1 / 源2…」（本项目自己的设计），于是 CCTV1 显示成
 *     「有 4 个源」，而那 4 个源指向同一个地址 —— 挂了一起挂，是噪音不是冗余；
 *   · 「我的频道」的配置键是 `原始分组::频道ID`（playlistConfig），隐藏 CCTV1 要操作
 *     4 次，而界面上没有任何地方提示还有另外 3 份；
 *   · 频道数虚高：实测 645 个条目对应 593 个真实频道，47 个频道跨分组重复。
 *
 * 顺序**不在这里定义**，原样沿用 fetchList.cateList() 拿到的咪咕分类顺序
 *（当前 体育/央视/卫视/地方/影视/新闻/教育/熊猫/综艺/少儿/纪实）。所以「先出现者胜」
 * 等价于「按咪咕自己的分类优先级归属」：CCTV5 落在体育、其余 CCTV 落在央视。
 * 刻意不另立一张优先级表——两处各自定义顺序必然走偏。
 *
 * 去重只在**咪咕模块内部**按 pID 做，绝不跨源：「咪咕的 CCTV1 + 精选频道的 CCTV1」
 * 是两个不同的地址，正是「源1 / 源2」要的那种真冗余，删掉就没了备用地址。
 *
 * 导出是为了能被测试直接打 —— 这是条纯数据整形规则，改错了不报错，
 * 只是频道悄悄跑到别的分组、或者又开始到处重复。
 */
export function dedupeAcrossGroups(groups) {
  const seen = new Set()
  const out = []
  for (const group of groups) {
    const dataList = group.dataList.filter(item => {
      const key = String(item.pID)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    // 整组被去空的不再输出，免得播放列表里挂空分组
    if (dataList.length > 0) out.push({ ...group, dataList })
  }
  return out
}

export default {
  id: 'migu',
  name: '咪咕视频',
  description: '央视 / 卫视 / 地方等 300+ 频道，含体育赛事与节目单。',

  // 归属标识保持字面量 'migu'，不用注册表默认的 'xt:migu'（见文件头约束 2）
  sourceId: 'migu',

  // 结果大、每轮都变、带着咪咕返回的全部原始字段，落盘纯属浪费
  // critical: 这个模块拿不到频道时，宁可保留上一份播放列表也不要覆盖。
  // 收编前咪咕是现抓，失败会让 getAllChannels 返回空、0 频道守卫触发、一个字节都不写；
  // 收编后失败被吞在模块内，而外部源撑着总数不为 0，守卫就失效了——那份保护是靠
  // 「咪咕失败 = 全局 0 条」这个巧合得来的，收编后必须显式声明才能保住。
  capabilities: { cache: 'memory', resolve: true, epg: true, critical: true },

  // 与 app.js 的整点更新同频；咪咕地址是播放时才解析的，不存在过期问题
  defaultRefreshMinutes: 360,

  // 画质参数。这些是纯咪咕的东西，原先和端口、访问密码一起摆在「系统配置」页，
  // 现在归位到模块自己名下。存量用户的 system-config.json 由 extractorManager
  // 的加载期迁移自动搬过来（一次性、幂等、带标记），原字段保留不删以便回滚。
  // 文案沿用原来的——用户认得它们。
  configSchema: [
    {
      key: 'userId',
      label: '咪咕账号 ID',
      type: 'text',
      env: 'muserId',
      default: '',
      hint: '填咪咕账号可解锁更高画质：免费账号即到 720p；游客不填最高 540p，1080p+ 需 VIP。',
    },
    {
      // 标成 secret：后台只回传「有没有值」不回传明文。原先它在 /api/system-config
      // 里是明文返回的，而未设访问密码的部署后台是无鉴权的——凭据不该那样暴露。
      key: 'token',
      label: '咪咕 Token',
      type: 'text',
      secret: true,
      env: 'mtoken',
      default: '',
      hint: '留空为游客模式。等同登录态，别外传。',
    },
    {
      key: 'rateType',
      label: '画质',
      type: 'select',
      env: 'mrateType',
      default: 3,
      options: [
        { value: 2, label: '标清 (480p)' },
        { value: 3, label: '高清 (720p)' },
        { value: 4, label: '蓝光 (1080p · 需VIP)' },
        { value: 7, label: '原画 (1080p+ · 需VIP)' },
        { value: 9, label: '4K (2160p · 需VIP)' },
      ],
      hint: '实际画质受咪咕账号档位限制：游客（不填账号）最高 540p；填免费咪咕账号可到 720p；蓝光 1080p / 原画 / 4K 需 VIP',
    },
    {
      key: 'enableH265',
      label: '启用 H.265 原画（可能存在兼容性问题）',
      type: 'boolean',
      env: 'menableH265',
      default: true,
      hint: '若部分频道只有声音、没有画面，多是播放器/设备不支持 H.265(HEVC) 编码——关闭本项即可回落到兼容性最好的 H.264。',
    },
    {
      key: 'enableClientDispatch',
      label: '客户端就近取流（跨运营商观看时开启）',
      type: 'boolean',
      env: 'menableClientDispatch',
      default: false,
      hint: '服务器和观看设备不在同一运营商网络时（如服务器接移动宽带、电视用联通），咪咕频道加载慢 / 播不了。开启后由播放器所在网络就近选 CDN 节点。同网部署无需开启。',
    },
    {
      // 原「系统配置」页里这一项就是 display:none 隐藏的，没有任何说明文案。
      // 保持隐藏——让它突然出现在界面上，对「零变化」同样是变化。仍可用
      // menableHDR 环境变量控制，与今天一致。
      key: 'enableHDR',
      label: '启用 HDR',
      type: 'boolean',
      env: 'menableHDR',
      default: true,
      hidden: true,
    },
  ],

  // 这些配置在模块化之前存在 system-config.json 里（由「系统配置」页管理）。
  // extractorManager 在加载期把它们一次性搬进 extractors.json——只搬**文件里真有的**，
  // 纯环境变量部署的用户什么都不写，env 继续 live 生效（否则 mrateType=4 会被固化，
  // 用户改 compose 就不生效了）。两边键名相同，故直接列键名。
  // 后台在这个模块的卡片里额外渲染一个助手（「获取咪咕账号」书签工具）。
  // 只声明 key，具体markup 留在 admin.html——那边有配套的 CSS、引导弹窗和
  // bookmarklet 代码，拆开反而更碎。
  helper: 'migu-bookmarklet',

  legacySystemConfigKeys: ['userId', 'token', 'rateType', 'enableHDR', 'enableH265', 'enableClientDispatch'],

  // 开关代理到 config.js 的 enableMigu：它被 updateData / channelMerger / app.js 等
  // 六处直接 import，还带着 menableMigu 环境变量与 mblank 空白模式语义，
  // 不能在 extractors.json 里另开一份。这里只是把读写入口挪到模块名下。
  enabledGetter: () => enableMigu,
  enabledEnv: 'menableMigu',
  enabledSetter: (on) => {
    const result = setSystemFlagAPI('enableMigu', on)
    if (!result.success) throw new Error(result.message)
  },

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

    const deduped = dedupeAcrossGroups(groups)
    const count = deduped.reduce((sum, g) => sum + g.dataList.length, 0)
    return {
      groups: deduped,
      meta: { skipped: [], warnings: [], requested: count },
    }
  },
}
