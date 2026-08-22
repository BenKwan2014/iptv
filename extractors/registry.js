/**
 * 抓取模块注册表。
 *
 * 每个平台的抓取逻辑是 extractors/<id>/index.js 里的一个模块，分发平台
 * （合并 / 分组 / EPG / 令牌 / 播放列表生成）不含任何平台知识。想下掉一个
 * 平台，删掉它的目录 + 从下面的 MODULES 里去掉一行即可，不牵连其它任何东西。
 *
 * 用静态 import 而不是扫目录：ESM 的动态 import 在 Docker 打包后路径行为
 * 不好预期，而模块数量是个位数，静态列表更可控也更好审。
 *
 * ---------------------------------------------------------------------------
 * 模块契约
 * ---------------------------------------------------------------------------
 *
 *   id                    string  唯一，且必须过 MODULE_ID_RE——它会进 sourceId
 *                                 (`xt:<id>`) 并最终写进 EXTINF 的属性值里
 *   name                  string  后台显示名
 *   description           string  后台一句话说明
 *   capabilities          object  { cache: 'disk'|'memory'|'none',
 *                                   resolve: boolean, epg: boolean }
 *   defaultRefreshMinutes number  默认刷新间隔
 *   configSchema          array   字段描述，后台据此渲染表单、后端据此校验
 *
 *   async fetch(config, ctx) → { groups: [{ name, dataList }], meta }
 *       必需。返回**分组树**而不是扁平频道数组——channelMerger 的合并算法是
 *       「按 group.name 找同名分组再 push dataList」，扁平数组等于把
 *       groupTitle→分组 的映射重新发明一遍。
 *       一个模块可以返回多个分组（咪咕将来的「体育赛事」就是同一模块的第二批
 *       分组，不是另一个源）。
 *
 *   async resolve(ref, ctx) → { url, ttlMs, headers? }
 *       可选，capabilities.resolve 为真时必需。用于「播放时才算地址」的模块：
 *       fetch() 里频道给 deferredRef，写盘时落成 ${replace}/<ref>，播放请求
 *       到达时才调 resolve。咪咕现在就是这么工作的（utils/appUtils.js 那套
 *       pid → 签名 → 302），收编它时靠这个槽位。B 站不需要——它是直链。
 *
 *   async epg(channels, ctx) → XMLTV 片段
 *       可选，capabilities.epg 为真时必需。槽位先留着，本轮无人实现。
 *
 * 频道对象（dataList 的元素）字段：
 *   name       必需，显示名，也是去重键的一半
 *   url        直链模块必需
 *   deferredRef  延迟解析模块必需（与 url 二选一）
 *   logo       台标，空串即可
 *   groupTitle 装饰用；真正的分组来自所在 group.name
 *   opts       string[]，#EXTVLCOPT 的 key=value，交给 utils/channelOpts.js 渲染
 *   catchup    可选 { mode, source }，槽位先留着（咪咕的回看将来用）
 *
 * sourceId / source 由 extractorManager 统一盖章，模块不用自己填——
 * `xt:` 这个前缀格式是注册表层的事，模块不该知道。
 */
import bilibiliLive from './bilibili-live/index.js'
import migu from './migu/index.js'

// 模块 id 会进 sourceId 并写进 EXTINF 属性值，不消毒就是注入面。
// 与 utils/configBackupAPI.js 的文件名白名单同款约束。
export const MODULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

const MODULES = [
  // 顺序即后台展示顺序，也是 channelMerger 的合并顺序（先到的分组优先保留）
  migu,
  bilibiliLive,
]

// 启动即校验，把「模块写错了」变成启动失败而不是运行期的诡异行为
const registry = new Map()
for (const module of MODULES) {
  if (!module || !MODULE_ID_RE.test(module.id || '')) {
    throw new Error(`抓取模块 id 非法: ${JSON.stringify(module?.id)}`)
  }
  if (registry.has(module.id)) {
    throw new Error(`抓取模块 id 重复: ${module.id}`)
  }
  if (typeof module.fetch !== 'function') {
    throw new Error(`抓取模块 ${module.id} 没有实现 fetch()`)
  }
  if (module.capabilities?.resolve && typeof module.resolve !== 'function') {
    throw new Error(`抓取模块 ${module.id} 声明了 resolve 能力但没实现 resolve()`)
  }
  registry.set(module.id, module)
}

/** 全部模块，顺序即后台展示顺序。 */
export function listModules() {
  return [...registry.values()]
}

/** 按 id 取模块；不存在返回 undefined（调用方自己决定是报错还是跳过）。 */
export function getModule(id) {
  return registry.get(String(id || ''))
}

/** 该 id 是否是本版本认识的模块。 */
export function hasModule(id) {
  return registry.has(String(id || ''))
}

/** 频道归属标记。改这里要同步 app.js 的 sourceId 正则白名单与源枚举。 */
export function sourceIdOf(moduleId) {
  return `xt:${moduleId}`
}
