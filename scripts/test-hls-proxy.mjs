#!/usr/bin/env node
/**
 * 全代理模式回归测试（issue #98 续）
 *
 * 核心不变量：
 *   1) 下发的清单里**没有任何绝对地址**——只有「同目录、不含斜杠」的相对地址（CDN 自己下发、
 *      且极影视实测能播的那种形态），相对解析后正好落回本机分片路由；
 *   2) 分片后缀保留（.ts / .m3u8 / .key），按后缀识别流格式的播放器才认；
 *   3) 同一条上游地址反复登记得到同一 key——直播清单每 6 秒刷新一次，key 变动会把地址表撑爆；
 *   4) 端到端：播放器按清单里的相对地址请求本机，拿到的字节与 CDN 原分片一致。
 *
 * 运行： node scripts/test-hls-proxy.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 数据目录必须在 import 之前定好：paths.js 在模块加载时就读 mdataDir
const DATA_DIR = mkdtempSync(join(tmpdir(), 'iptv-proxy-test-'))
process.env.mdataDir = DATA_DIR

const { toProxyManifest, lookup, register, pipeUpstream } = await import('../utils/hlsProxy.js')
const { fetchManifestDirect, interfaceStr } = await import('../utils/appUtils.js')

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }
const checkAsync = async (n, fn) => { await fn(); passed++; console.log('  ✅ ' + n) }

console.log('全代理模式回归测试 (issue #98)')

// ---------- 1. 清单改写 ----------
check('绝对分片地址 → 同目录相对地址（不含斜杠），后缀保留', () => {
  const src = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.000000,',
    'http://cdn.example.com:8080/live/a-1.ts?token=abc&x=1',
  ].join('\n')
  const out = toProxyManifest(src, '608807420').split('\n')
  assert.equal(out[0], '#EXTM3U')
  assert.equal(out[1], '#EXT-X-TARGETDURATION:6')
  assert.match(out[3], /^s[0-9a-f]{16}\.ts$/)
  assert.ok(!out.some(l => l.includes('http://')), '清单里不允许残留任何绝对地址')
})

check('EXT-X-KEY 的 URI 属性同样代理（默认 .key 后缀）', () => {
  const src = '#EXT-X-KEY:METHOD=AES-128,URI="http://cdn.example.com/k.php?id=1",IV=0x12\n'
  const out = toProxyManifest(src, '1')
  assert.match(out, /URI="s[0-9a-f]{16}\.key"/)
  assert.ok(!out.includes('http://'))
})

check('master 清单里的子清单保留 .m3u8 后缀（拍平失败时的回退形态）', () => {
  const src = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nhttp://cdn.example.com/live/01.m3u8?t=1'
  const out = toProxyManifest(src, '7').split('\n')
  assert.match(out[2], /^s[0-9a-f]{16}\.m3u8$/)
})

check('顶层清单与嵌套子清单的分片地址落到同一条路由（同目录，无需按层区分）', () => {
  const seg = 'http://cdn.example.com/live/a-1.ts'
  const top = toProxyManifest(seg, '608807420').trim()
  const nested = toProxyManifest(seg, '608807420').trim()
  assert.equal(new URL(top, 'http://nas:1905/proxy/608807420.m3u8').pathname,
               new URL(nested, 'http://nas:1905/proxy/sabcdef0123456789.m3u8').pathname)
})

check('分片 key 带 s 前缀：与数字/命名空间频道引用的清单路由不相交', () => {
  const key = register('http://cdn.example.com/live/x.ts')
  assert.match(key, /^s[0-9a-f]{16}$/)
  assert.ok(!/^\d+$/.test(key))
})

check('同一上游地址登记结果稳定；非绝对地址原样保留', () => {
  const url = 'http://cdn.example.com/live/a-9.ts?token=zzz'
  assert.equal(register(url, '608807420'), register(url, '608807420'))
  assert.deepEqual(lookup(register(url, '608807420')), { url, pid: '608807420' })
  assert.equal(lookup('sffffffffffffffff'), null)
  assert.equal(toProxyManifest('a-1.ts', '1').trim(), 'a-1.ts')   // 改写漏网的相对地址不该被弄坏
})

// ---------- 2. 订阅输出 ----------
check('?relay=2 订阅频道地址输出 /proxy/<pid>.m3u8（relay=1 仍是 /relay/）', () => {
  writeFileSync(join(DATA_DIR, 'interface.txt'), [
    '#EXTM3U x-tvg-url="${replace}/playback.xml"',
    '#EXTINF:-1 tvg-id="CCTV1综合" group-title="央视",CCTV1综合',
    '${replace}/608807420',
    '',
  ].join('\n'))
  const headers = { host: '192.168.3.37:1905' }
  const proxied = interfaceStr('/interface.m3u', headers, '', '', '', '', '2').content.toString()
  assert.ok(proxied.includes('http://192.168.3.37:1905/proxy/608807420.m3u8'), proxied)
  const relayed = interfaceStr('/interface.m3u', headers, '', '', '', '', '1').content.toString()
  assert.ok(relayed.includes('http://192.168.3.37:1905/relay/608807420.m3u8'), relayed)
  const plain = interfaceStr('/interface.m3u', headers, '', '', '', '', '').content.toString()
  assert.ok(plain.includes('http://192.168.3.37:1905/608807420') && !plain.includes('/proxy/'), plain)
})

check('模块可直接写入命名空间全代理地址，replace 后保持单段安全 ref', () => {
  writeFileSync(join(DATA_DIR, 'interface.txt'), [
    '#EXTM3U x-tvg-url="${replace}/playback.xml"',
    '#EXTINF:-1 tvg-id="广西卫视" group-title="广西电视台",广西卫视',
    '${replace}/proxy/gxtv-gxws.m3u8',
    '',
  ].join('\n'))
  const out = interfaceStr('/interface.m3u', { host: '192.168.3.37:1905' }, '', '', '', '', '').content.toString()
  assert.ok(out.includes('http://192.168.3.37:1905/proxy/gxtv-gxws.m3u8'), out)
})

// ---------- 3. 端到端：假 CDN → 本机全代理 → 播放器 ----------
const SEG_BODY = Buffer.from('FAKE-TS-PAYLOAD-0123456789', 'utf-8')

const cdn = http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path === '/live/index.m3u8') {
    // 咪咕真实形态：master 里一条**相对**子清单
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2084544\n01.m3u8?token=abc\n')
    return
  }
  if (path === '/live/01.m3u8') {
    // 媒体清单：**相对**分片名（带各自的查询串）
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6.000000,\nseg-100.ts?token=abc\n')
    return
  }
  if (path === '/live/seg-100.ts') {
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEG_BODY.length })
    res.end(SEG_BODY)
    return
  }
  res.writeHead(404); res.end()
})

// 本机：清单路由 /proxy/<pid>.m3u8 与分片路由 /proxy/<pid>/<key>.<ext>（与 app.js 同构）
const nas = http.createServer(async (req, res) => {
  const seg = req.url.match(/^\/proxy\/(s[0-9a-f]{16})\.[a-z0-9]{1,8}$/)
  if (seg) {
    const target = lookup(seg[1])
    if (!target) { res.writeHead(404); res.end('分片地址已过期'); return }
    await pipeUpstream(target.url, req, res, target.transform)
    return
  }
  const man = req.url.match(/^\/proxy\/([a-z0-9][a-z0-9_-]{0,63})\.m3u8$/i)
  if (man) {
    const abs = await fetchManifestDirect(`http://127.0.0.1:${cdn.address().port}/live/index.m3u8?token=abc`)
    const body = Buffer.from(toProxyManifest(abs, man[1]), 'utf-8')
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': body.length })
    res.end(body)
    return
  }
  res.writeHead(404); res.end()
})

await new Promise(r => cdn.listen(0, '127.0.0.1', r))
await new Promise(r => nas.listen(0, '127.0.0.1', r))
const nasBase = `http://127.0.0.1:${nas.address().port}`

await checkAsync('端到端：清单直出后播放器按相对地址取分片，字节与 CDN 一致', async () => {
  const manifestUrl = `${nasBase}/proxy/gxtv-gxws.m3u8`
  const resp = await fetch(manifestUrl)
  assert.equal(resp.status, 200)
  assert.equal(resp.headers.get('content-type'), 'application/vnd.apple.mpegurl')
  const text = await resp.text()

  // 拍平：不该再有嵌套子清单；且全篇没有绝对地址
  assert.ok(!text.includes('#EXT-X-STREAM-INF'), '应已拍平为媒体清单：\n' + text)
  assert.ok(!text.includes('http://'), '清单里不允许出现绝对地址：\n' + text)
  assert.ok(text.includes('#EXTINF:6.000000,'), text)

  const segRef = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'))
  assert.match(segRef, /^s[0-9a-f]{16}\.ts$/, '分片地址应为同目录相对地址、不含斜杠')

  // 播放器的解析方式：相对于清单地址解析
  const segUrl = new URL(segRef, manifestUrl).href
  assert.equal(segUrl, `${nasBase}/proxy/${segRef}`)
  const segResp = await fetch(segUrl)
  assert.equal(segResp.status, 200)
  assert.equal(segResp.headers.get('content-type'), 'video/mp2t')
  assert.deepEqual(Buffer.from(await segResp.arrayBuffer()), SEG_BODY)
})

await checkAsync('分片变换函数随清单地址登记，并在回给播放器前执行', async () => {
  const transform = body => Buffer.from(body.toString('utf8').toUpperCase())
  const url = `http://127.0.0.1:${cdn.address().port}/live/seg-100.ts`
  const key = register(url, 'gxtv-test', transform)
  assert.equal(lookup(key).transform, transform)
  const resp = await fetch(`${nasBase}/proxy/${key}.ts`)
  assert.equal(resp.status, 200)
  assert.equal(await resp.text(), SEG_BODY.toString('utf8').toUpperCase())
})

await checkAsync('未登记 / 已过期的分片地址回 404，播放器会重新拉清单', async () => {
  const resp = await fetch(`${nasBase}/proxy/s00112233445566ff.ts`)
  assert.equal(resp.status, 404)
})

await new Promise(r => cdn.close(r))
await new Promise(r => nas.close(r))

console.log(`\n全部通过：${passed} 项`)
