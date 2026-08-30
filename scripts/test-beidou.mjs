#!/usr/bin/env node
import assert from 'node:assert/strict'
import beidou from '../extractors/beidou/index.js'
import {
  buildChannelGroups,
  normalizePrograms,
  playableStreamOf,
  signStreamUrl,
} from '../extractors/beidou/api.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('辽宁北斗融媒模块测试')

check('模块固定抓辽宁省台与沈阳台，不暴露地区配置', () => {
  assert.deepEqual(beidou.configSchema, [])
})

check('只解析 type=22 的正式白名单频道', () => {
  const payload = { data: [
    { type: 22, config: JSON.stringify({ programs: [
      { id: 'c077b260424404846285cba1e1759280', title: '辽宁卫视', cover: 'http://img/logo.jpg' },
      { id: 'ffffffffffffffffffffffffffffffff', title: '专题直播' },
    ] }) },
    { type: 11, config: JSON.stringify({ programs: [{ id: '10d3de0d03c62e85a1a281bbde8b6952' }] }) },
  ] }
  assert.deepEqual(normalizePrograms(payload, 'liaoning'), [{
    id: 'c077b260424404846285cba1e1759280', tenantId: 'liaoning', name: '辽宁卫视', logo: 'https://img/logo.jpg',
  }])
})

check('只接受 live 类型及对应租户 CDN 地址', () => {
  const good = { code: 200, data: { playableType: 'live', playableUrl: JSON.stringify({ m3u8: 'https://bdrmtvzb.lnyun.com.cn/bdrm/lntv.m3u8' }) } }
  const replay = { code: 200, data: { playableType: 'replay', programName: '说天下', playableUrl: 'https://bdrmtvzb.lnyun.com.cn/bdrm/lntv.m3u8?replay=1' } }
  const badHost = { code: 200, data: { playableType: 'live', playableUrl: JSON.stringify({ m3u8: 'https://evil.example/live.m3u8' }) } }
  assert.equal(playableStreamOf(good, 'liaoning').url, 'https://bdrmtvzb.lnyun.com.cn/bdrm/lntv.m3u8')
  assert.deepEqual(playableStreamOf(replay, 'liaoning'), { url: '', type: 'replay', programName: '说天下' })
  assert.equal(playableStreamOf(badHost, 'liaoning').url, '')
})

check('短签名格式、过期时间和摘要稳定', () => {
  const signed = new URL(signStreamUrl('https://bdrmtvzb.lnyun.com.cn/bdrm/lntv.m3u8', 'liaoning', 1_700_000_000_000))
  assert.equal(signed.searchParams.get('auth_key'), '1700001800-0-0-ea4f729bf6e2aeaa256e68a420c5bf6c')
  assert.throws(() => signStreamUrl('https://evil.example/live.m3u8', 'liaoning', 1_700_000_000_000), /不是该北斗融媒租户/)
})

check('省台与沈阳台合并进辽宁频道，并固定走全代理', () => {
  const groups = buildChannelGroups([
    { id: 'c077b260424404846285cba1e1759280', tenantId: 'liaoning', name: '辽宁卫视', url: 'x', logo: '' },
    { id: 'd447fcc472f14c7f14872d4e26b12d8f', tenantId: 'shenyang', name: '沈阳新闻综合', url: 'y', logo: '' },
  ])
  assert.deepEqual(groups.map(group => group.name), ['辽宁频道'])
  assert.deepEqual(groups[0].dataList.map(channel => channel.name), ['辽宁卫视', '沈阳新闻综合'])
  assert.ok(groups.every(group => group.dataList.every(channel => channel.proxyHls === true)))
})

check('模块认领范围不接受路径注入', () => {
  assert.equal(beidou.claimsRef('beidou-liaoning-c077b260424404846285cba1e1759280'), true)
  assert.equal(beidou.claimsRef('beidou-fushun-b2326b3d482e30a9d95d63e09fc3f460'), false)
  assert.equal(beidou.claimsRef('beidou-liaoning-../../secret'), false)
})

console.log(`\n${passed} 项测试全部通过`)
