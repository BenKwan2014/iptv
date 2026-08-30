#!/usr/bin/env node
import assert from 'node:assert/strict'

import { parseChannelPage, UPSTREAM_HEADERS } from '../extractors/hbtv/api.js'
import { buildChannels, CHANNELS, channelIdFromRef } from '../extractors/hbtv/channels.js'
import { createResolver } from '../extractors/hbtv/resolver.js'
import { isOfficialResolvedUrl } from '../extractors/hbtv/session.js'
import { inlineResolvedManifest } from '../utils/appUtils.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('湖北长江云模块测试')

const now = 1_780_000_000_000
const expiry = Math.floor(now / 1000) + 1800
const auth = id => `${expiry}-${id.padEnd(32, 'a')}-0-${id.padEnd(32, 'b')}`
const html = CHANNELS.map(channel => `{
  id: ${channel.id},
  name: "${channel.rawName}",
  stream: "https://live21-cjy.hbtv.com.cn/new-hbtv/${channel.streamPath}.m3u8?auth_key=${auth(channel.id)}"
}`).join(',')

check('官网页严格解析固定六套 ID、名称、路径与到期时间', () => {
  const rows = parseChannelPage(html, now)
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map(row => row.id), ['431', '432', '433', '435', '437', '438'])
  assert.ok(rows.every(row => row.expiresAt === expiry * 1000))
  assert.equal(parseChannelPage(html.replace('new-hbjy.m3u8', 'other.m3u8'), now).length, 5)
})

check('频道输出固定全代理，引用白名单不误认其它直播', () => {
  const channels = buildChannels()
  assert.equal(channels.length, 6)
  assert.ok(channels.every(channel => channel.proxyHls === true))
  assert.equal(channelIdFromRef('hbtv-431'), '431')
  assert.equal(channelIdFromRef('hbtv-434'), '')
})

check('只接受带三段防盗链参数的湖北官方 CDN 清单', () => {
  assert.equal(isOfficialResolvedUrl(
    'https://live21-cjy.hbtv.com.cn/new-hbtv/new-hbws.m3u8?auth_key=a&extrakey=b&aalook=c',
  ), true)
  assert.equal(isOfficialResolvedUrl('https://evil.example/new-hbtv/new-hbws.m3u8?auth_key=a&extrakey=b&aalook=c'), false)
})

await checkAsync('解析器把浏览器清单与防盗链请求头交给全代理层', async () => {
  const rows = parseChannelPage(html, now)
  let captured = ''
  const resolver = createResolver({
    getRows: async () => rows,
    capture: async url => {
      captured = url
      return {
        url: 'https://live21-cjy.hbtv.com.cn/new-hbtv/new-hbws.m3u8?auth_key=a&extrakey=b&aalook=c',
        text: '#EXTM3U\n#EXTINF:5,\nseg.ts?auth_key=a',
      }
    },
    close: async () => {},
  })
  const out = await resolver.resolve('hbtv-431', { now })
  assert.match(captured, /new-hbws\.m3u8/)
  assert.equal(out.manifestText.startsWith('#EXTM3U'), true)
  assert.deepEqual(out.upstreamHeaders, UPSTREAM_HEADERS)
  assert.equal(out.relayHls, true)
})

check('内联浏览器清单仍按真实 CDN 基址改写相对分片', () => {
  const out = inlineResolvedManifest({
    playURL: 'https://unused.example/a.m3u8',
    manifestUrl: 'https://live21-cjy.hbtv.com.cn/new-hbtv/new-hbws.m3u8?auth_key=a&extrakey=b&aalook=c',
    manifestText: '#EXTM3U\n#EXTINF:5,\nseg.ts?auth_key=a',
  })
  assert.ok(out.includes('https://live21-cjy.hbtv.com.cn/new-hbtv/seg.ts?auth_key=a'))
  assert.equal(inlineResolvedManifest({ manifestText: '<html>403</html>', manifestUrl: 'https://x.test/a' }), null)
})

console.log(`\n全部通过：${passed}/5 ✅`)
