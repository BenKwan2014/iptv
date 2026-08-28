import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { printDebug, printRed } from "./colorOut.js";

/**
 * 全代理模式（issue #98 续）：清单里的地址全部改写成「本机同源相对地址」，分片由服务器转发。
 *
 * 为什么还需要这一档：兼容版（/relay/，清单直出）已经替播放器走完了 302 与 master→媒体清单
 * 两跳，服务端实测返回的就是一份合法媒体清单（200 + application/vnd.apple.mpegurl +
 * #EXTINF + .ts 列表），但极空间「极影视」仍播不了；而同一条 CDN 地址**直接**填进播放器却能播。
 * 两次兼容版尝试（master 里一条绝对子清单 / 媒体清单里一串绝对分片）都失败，唯一共同点是：
 * 清单由本机下发、里面的地址是**绝对且跨主机**的。CDN 自己下发的清单里是相对地址（与清单同源），
 * 那份能播。所以剩下的唯一变量就是「清单里的地址是否与清单同源」。
 *
 * 全代理模式把这个变量消掉：下发的清单里只有相对地址（`<key>.ts`），播放器不需要理解绝对地址、
 * 不跨主机、不跨端口、也没有超长查询串；分片请求回到本机后再由服务器取回 CDN 内容转发。
 * 代价是视频流经服务器（家庭 NAS 与电视同网，多花的是一段内网带宽，外网下行量不变）。
 *
 * 地址表：清单每次刷新都会重新登记（同一条 CDN 地址恒定映射到同一 key），带 TTL 与条数上限，
 * 避免直播长跑把内存吃满。
 */

const TTL_MS = 10 * 60 * 1000     // 分片地址带时效签名，10 分钟足够覆盖播放器的重试窗口
const MAX_ENTRIES = 5000          // 一个直播频道 10 分钟约 100 条，这个上限够几十路同放，超出按最早登记淘汰

const registry = new Map()        // key -> { url, pid, expires }

// 已知的媒体后缀：保留原后缀，按后缀识别流格式的播放器（极影视）才认得出分片
const KNOWN_EXT = new Set(['ts', 'm3u8', 'aac', 'mp3', 'mp4', 'm4s', 'm4a', 'vtt', 'key'])

function extOf(url, fallback) {
  try {
    const name = new URL(url).pathname.split('/').pop() || ''
    const dot = name.lastIndexOf('.')
    const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
    return KNOWN_EXT.has(ext) ? ext : fallback
  } catch {
    return fallback
  }
}

function sweep() {
  const now = Date.now()
  for (const [key, entry] of registry) {
    if (entry.expires <= now) registry.delete(key)
  }
  // 扫完仍超上限：Map 迭代序即插入序，从最早的开始丢
  while (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next()
    if (oldest.done) break
    registry.delete(oldest.value)
  }
}

/**
 * 登记一条上游地址，返回稳定的短 key（同一地址永远同一 key，清单每 6 秒刷新一次也不会撑爆表）。
 * key 前缀固定为 s：让分片路径 /proxy/s<hex>.ts 与频道清单路径 /proxy/<纯数字频道号>.m3u8
 * 在词法上永不相交，两条路由怎么排都不会互相误吃。
 */
function register(url, pid = '') {
  const key = 's' + createHash('md5').update(url).digest('hex').slice(0, 16)
  registry.set(key, { url, pid, expires: Date.now() + TTL_MS })
  if (registry.size > MAX_ENTRIES) sweep()
  return key
}

/** 取回登记项 { url, pid }；未登记或已过期返回 null */
function lookup(key) {
  const entry = registry.get(key)
  if (!entry) return null
  if (entry.expires <= Date.now()) {
    registry.delete(key)
    return null
  }
  return { url: entry.url, pid: entry.pid }
}

/** 仅供测试与自检：当前登记条数 */
function registrySize() {
  return registry.size
}

/**
 * 把（已改写为绝对地址的）HLS 清单里的每条地址换成本机同源相对地址。
 *
 * 刻意生成**不含斜杠的同目录相对地址**（`s<key>.ts`）——这正是 CDN 自己下发、
 * 且极影视实测能播的那种形态：清单在 /proxy/<pid>.m3u8，分片就在 /proxy/s<key>.ts，
 * 播放器只要会「同目录取下一个文件」就够用，不必理解绝对地址，也不必跨目录解析。
 * 嵌套子清单（/proxy/s<key>.m3u8）同在这一层目录，两层共用同一套相对地址，无需按层区分。
 *
 * 纯字符串处理（除登记地址表外无副作用），便于单测。
 */
function toProxyManifest(text, pid = '') {
  const toRef = (uri, fallbackExt) => {
    if (!/^https?:\/\//i.test(uri)) return null   // 非绝对地址说明上一步改写没覆盖到，保持原样别弄坏
    return `${register(uri, pid)}.${extOf(uri, fallbackExt)}`
  }
  return text.split('\n').map(line => {
    const t = line.trim()
    if (!t) return line
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (whole, uri) => {
        const ref = toRef(uri, 'key')
        return ref ? `URI="${ref}"` : whole
      })
    }
    return toRef(t, 'ts') || line
  }).join('\n')
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 上游 → 客户端要原样带过去的响应头（其余一律不带，避免上游的 CORS / 缓存策略干扰播放器）
const PASS_THROUGH = ['content-type', 'content-length', 'accept-ranges', 'content-range']

/**
 * 把上游分片流式转发给客户端。
 *
 * 不缓冲整片：分片几百 KB 到几 MB，直播长跑时缓冲会顶着内存跑；直接 pipe 过去。
 * 客户端切台 / 关闭连接时中止上游请求，否则一次切台会留下一串还在下载的孤儿请求。
 */
async function pipeUpstream(url, req, res) {
  const ctrl = new AbortController()
  const onClose = () => ctrl.abort()
  res.on('close', onClose)
  // 只给「拿到响应头」设超时，拿到之后是流式传输，不能再掐
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const headers = { 'User-Agent': UA }
    if (req.headers.range) headers.range = req.headers.range   // 播放器可能按 Range 取分片
    const upstream = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers })
    clearTimeout(timer)

    const out = { 'Access-Control-Allow-Origin': '*' }
    for (const name of PASS_THROUGH) {
      const value = upstream.headers.get(name)
      if (value != null) out[name] = value
    }
    if (!out['content-type']) out['content-type'] = 'video/mp2t'
    res.writeHead(upstream.status, out)

    if (!upstream.body) { res.end(); return }
    await new Promise((resolve, reject) => {
      const src = Readable.fromWeb(upstream.body)
      src.on('error', reject)
      res.on('error', reject)
      res.on('close', () => src.destroy())
      src.pipe(res).on('finish', resolve).on('close', resolve)
    })
  } catch (error) {
    clearTimeout(timer)
    // 客户端自己断开（切台 / 关闭播放器）是常态，不当错误刷屏
    if (ctrl.signal.aborted && res.destroyed) return
    printDebug(`分片转发失败: ${error?.message || error}`)
    if (!res.headersSent) {
      try { res.writeHead(502, { 'Content-Type': 'text/plain;charset=UTF-8' }); res.end('上游分片获取失败') } catch { /* 连接可能已断 */ }
    } else {
      try { res.end() } catch { /* 连接可能已断 */ }
    }
  } finally {
    res.off('close', onClose)
  }
}

/** 取回一份嵌套子清单（全代理模式下清单里再出现 .m3u8 时用），返回 { text, finalUrl } 或 null */
async function fetchNested(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } })
    if (!resp.ok) return null
    const text = await resp.text()
    if (!text.trimStart().startsWith('#EXTM3U')) return null
    return { text, finalUrl: resp.url || url }
  } catch (error) {
    printRed(`子清单代理获取失败: ${error?.message || error}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

export { toProxyManifest, register, lookup, registrySize, pipeUpstream, fetchNested }
