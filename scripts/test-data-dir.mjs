#!/usr/bin/env node
/**
 * 数据目录旧路径回落的回归测试
 *
 * 不变量：镜像默认数据目录从 /migu/data 改名 /iptv/data 后，老部署零操作升级不丢配置——
 * 仅当「解析结果是新默认路径 && 新路径无数据 && 旧路径有数据」才回落旧路径；
 * 显式指定的 mdataDir、两边都有数据、全新部署等场景一律不回落。
 *
 * 运行： node scripts/test-data-dir.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { pickDataDir } from '../utils/paths.js'

const DEF = '/iptv/data'
const LEG = '/migu/data'
// data: {目录: 是否有数据}，未列出的目录视为不存在（无数据）
const pick = (envDir, data) =>
  pickDataDir(envDir, { defaultDir: DEF, legacyDir: LEG, hasData: (d) => !!data[d] })

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('数据目录旧路径回落测试')

check('★ 老部署升级：新路径空、旧路径有数据 → 沿用 /migu/data', () => {
  const r = pick(DEF, { [LEG]: true })
  assert.equal(r.dir, LEG)
  assert.equal(r.usedLegacy, true)
})

check('全新部署：两边都空 → 用新默认路径', () => {
  const r = pick(DEF, {})
  assert.equal(r.dir, DEF)
  assert.equal(r.usedLegacy, false)
})

check('已在新路径运行过：新路径有数据 → 用新路径（旧残留卷不干扰）', () => {
  const r = pick(DEF, { [DEF]: true, [LEG]: true })
  assert.equal(r.dir, DEF)
  assert.equal(r.usedLegacy, false)
})

check('显式 mdataDir=/migu/data（老 compose 写死）→ 直取，不经回落逻辑', () => {
  const r = pick(LEG, { [LEG]: true })
  assert.equal(r.dir, LEG)
  assert.equal(r.usedLegacy, false)
})

check('显式自定义目录 → 原样使用，旧路径有数据也不劫持', () => {
  const r = pick('/srv/iptv-data', { [LEG]: true })
  assert.equal(r.dir, '/srv/iptv-data')
  assert.equal(r.usedLegacy, false)
})

check('裸跑（cwd 兜底）→ 与容器路径无关，不回落', () => {
  const r = pick(process.cwd(), { [LEG]: true })
  assert.equal(r.dir, process.cwd())
  assert.equal(r.usedLegacy, false)
})

check('真实 hasData：不存在的目录 → 判为无数据，不抛', () => {
  const r = pickDataDir(DEF, { defaultDir: '/nonexistent-dir-for-test-a', legacyDir: '/nonexistent-dir-for-test-b' })
  assert.equal(r.dir, DEF)
  assert.equal(r.usedLegacy, false)
})

console.log(`全部通过：${passed}/${passed} ✅`)
