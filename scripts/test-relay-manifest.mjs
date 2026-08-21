#!/usr/bin/env node
/**
 * 清单直出（兼容模式）改写回归测试（issue #98）
 *
 * 核心不变量：HLS 清单里的相对路径（URI 行与标签内 URI="…" 属性）改写为
 * 以最终响应地址为基准的绝对地址；绝对地址与注释行原样保留。
 *
 * 运行： node scripts/test-relay-manifest.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { rewriteManifest, firstVariantUrl } from '../utils/appUtils.js'

let passed = 0
const check = (n, fn) => { fn(); passed++; console.log('  ✅ ' + n) }

console.log('清单直出改写回归测试 (issue #98)')

const BASE = 'http://hlszte.example.com:8080/migu/kailu/cctv1/50/index.m3u8?msisdn=abc&x=1'

// 1) master 清单：相对子清单（带 query）改写为绝对地址——咪咕真实结构
check('master 清单相对子清单 → 绝对地址（咪咕真实结构）', () => {
  const src = '#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2084544\n01.m3u8?msisdn=abc&t=2'
  const out = rewriteManifest(src, BASE)
  const lines = out.split('\n')
  assert.equal(lines[0], '#EXTM3U')
  assert.equal(lines[2], 'http://hlszte.example.com:8080/migu/kailu/cctv1/50/01.m3u8?msisdn=abc&t=2')
})

// 2) media 清单：相对分片 + EXT-X-KEY 的 URI 属性都改写；绝对地址不动
check('media 清单分片与 KEY URI 改写；绝对地址原样', () => {
  const src = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.php?id=1",IV=0x1234',
    '#EXTINF:6.0,',
    'seg/0001.ts',
    '#EXTINF:6.0,',
    'https://cdn.other.com/abs/0002.ts',
  ].join('\n')
  const out = rewriteManifest(src, BASE)
  assert.ok(out.includes('URI="http://hlszte.example.com:8080/migu/kailu/cctv1/50/key.php?id=1"'))
  assert.ok(out.includes('http://hlszte.example.com:8080/migu/kailu/cctv1/50/seg/0001.ts'))
  assert.ok(out.includes('https://cdn.other.com/abs/0002.ts'))   // 绝对地址不被改写
})

// 3) 根相对路径（/ 开头）按主机根解析
check('根相对路径按主机根解析', () => {
  const out = rewriteManifest('#EXTM3U\n/live/ch1/index.m3u8', BASE)
  assert.ok(out.includes('http://hlszte.example.com:8080/live/ch1/index.m3u8'))
})

// 4) 空行与纯注释行原样保留，不因改写丢失
check('空行/注释行原样保留', () => {
  const src = '#EXTM3U\n\n#EXT-X-VERSION:3\n01.m3u8'
  const out = rewriteManifest(src, BASE)
  assert.equal(out.split('\n').length, 4)
  assert.ok(out.includes('#EXT-X-VERSION:3'))
})

// 5) master 拍平：定位第一条子清单地址（兼容模式多走一跳，直接给播放器媒体清单）
check('master 清单定位首条子清单地址（相对/绝对/多码率/非 master）', () => {
  // 咪咕真实结构：相对子清单
  assert.equal(
    firstVariantUrl('#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2084544\n01.m3u8?msisdn=abc', BASE),
    'http://hlszte.example.com:8080/migu/kailu/cctv1/50/01.m3u8?msisdn=abc'
  )
  // 绝对子清单原样取用
  assert.equal(
    firstVariantUrl('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nhttps://cdn.x.com/a/hi.m3u8', BASE),
    'https://cdn.x.com/a/hi.m3u8'
  )
  // 多码率取第一条；标签与地址之间夹注释行也能跳过
  assert.equal(
    firstVariantUrl('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n#comment\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8', BASE),
    'http://hlszte.example.com:8080/migu/kailu/cctv1/50/low.m3u8'
  )
  // 已经是媒体清单（无 STREAM-INF）：返回 null，按原样改写直出
  assert.equal(firstVariantUrl('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n0001.ts', BASE), null)
})

console.log(`\n全部通过：${passed}/5 ✅`)
