#!/usr/bin/env node
/**
 * 咪咕 token 刷新时机测试。
 *
 * 为什么值得单独一个测试文件：refreshToken() 打的是咪咕的登录续期接口
 * （migu-app-umnb.miguvideo.com/login/token_refresh_migu_plus，带 userId + userToken），
 * config.js 原注释说这可能是导致封号的原因。判据是一个小布尔表达式，改错了**不报错**，
 * 只是悄悄开始高频请求、或者悄悄再也不刷。两个方向的失败都是静默的，所以把完整
 * 真值表钉在这里。
 *
 * 原实现是 `enableMigu && !(hours % 720)`，hours 是进程内计数器
 * （app.js 的 `var hours = 0`，只在定时任务里 += updateInterval）。两个方向都错：
 *
 *   · 恒真侧：0 % 720 === 0 —— 每次容器启动、启动后头 updateInterval 小时内的
 *     每次重新生成、以及后台 8 处 update(0, { regenerateOnly: true })
 *     （保存配置 / 导入配置 / 上传或删除台标 / 复制频道）都会各刷一次。
 *   · 恒假侧：hours 只落在 updateInterval 的整数倍上。默认 8 能整除 720，
 *     但设成 7 / 11 / 13 / 14 时永远碰不到 720 的倍数，月度刷新从此不再发生。
 *
 * 运行： node scripts/test-token-refresh.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 状态文件落在数据目录，必须在 import 之前把 mdataDir 指到临时目录，
// 否则测试会往用户真实的数据目录里写。
const TMP = mkdtempSync(join(tmpdir(), 'iptv-token-test-'))
process.env.mdataDir = TMP

const { shouldRefreshMiguToken: should } = await import('../utils/updateData.js')
const {
  readMiguTokenState, markMiguTokenRefreshed, __resetMiguTokenStateCache,
  MIGU_TOKEN_REFRESH_INTERVAL_MS: MONTH,
} = await import('../utils/miguTokenState.js')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('咪咕 token 刷新时机测试')

// 固定的**过去**时间戳（2023-11-14）。不能取未来值：readMiguTokenState 会把未来
// 时间当作「没有记录」（防 NAS 掉电后 RTC 不准），持久化那几条断言会因此读回 null。
const NOW = 1_700_000_000_000
const base = {
  now: NOW,
  lastRefreshAt: NOW - MONTH,          // 恰好满一个月
  regenerateOnly: false,
  startupMode: false,
  enableMigu: true,
}

// ---- 周期本身 ----
check('距上次刷新满 30 天 → 刷', () => {
  assert.equal(should(base), true)
  assert.equal(should({ ...base, lastRefreshAt: NOW - MONTH - 1 }), true)
})

check('差一毫秒都不刷', () => {
  assert.equal(should({ ...base, lastRefreshAt: NOW - MONTH + 1 }), false)
})

check('刚刷过 / 半个月前刷过 → 不刷', () => {
  assert.equal(should({ ...base, lastRefreshAt: NOW }), false)
  assert.equal(should({ ...base, lastRefreshAt: NOW - MONTH / 2 }), false)
})

// ---- 这次修复的本体：与「更新间隔能否整除 720」彻底脱钩 ----
check('★ 更新间隔取任何值都不影响 —— 原实现在 7/11/13/14 小时下永不刷新', () => {
  // 旧实现：hours 只落在 updateInterval 的整数倍上，判 hours % 720 === 0
  const oldImpl = (hours) => hours > 0 && hours % 720 === 0
  for (const interval of [7, 11, 13, 14]) {
    // 模拟跑满 3 个月（约 2160 小时）的所有刻度，旧实现一次都不会命中
    let hit = false
    for (let h = interval; h <= 2160; h += interval) if (oldImpl(h)) hit = true
    assert.equal(hit, false, `旧实现在 interval=${interval} 下本应永不刷新，前提变了？`)
  }
  // 能整除的（8）旧实现能命中，作为对照 —— 说明上面不是测试写错了
  let hit8 = false
  for (let h = 8; h <= 2160; h += 8) if (oldImpl(h)) hit8 = true
  assert.equal(hit8, true)

  // 新实现只看墙钟时间，与 interval 无关
  assert.equal(should(base), true)
})

// ---- 两道纵深防御闸 ----
check('闸一：regenerateOnly —— 用缓存重生成播放列表绝不联网做账号操作', () => {
  // 覆盖后台 8 处 update(0, { regenerateOnly: true })
  assert.equal(should({ ...base, regenerateOnly: true }), false)
  // 即使已经过了三个月也不在这条路径上刷
  assert.equal(should({ ...base, lastRefreshAt: NOW - 3 * MONTH, regenerateOnly: true }), false)
})

check('闸二：startupMode —— 容器启动不刷（NAS 重启 / compose 更新 / 崩溃拉起）', () => {
  assert.equal(should({ ...base, startupMode: true }), false)
  assert.equal(should({ ...base, lastRefreshAt: NOW - 3 * MONTH, startupMode: true }), false)
})

check('没有记录（lastRefreshAt 为 null / 0）→ 不刷，本轮只开始计时', () => {
  assert.equal(should({ ...base, lastRefreshAt: null }), false)
  assert.equal(should({ ...base, lastRefreshAt: 0 }), false)
  assert.equal(should({ ...base, lastRefreshAt: undefined }), false)
})

check('enableMigu=false → 一律不刷', () => {
  assert.equal(should({ ...base, enableMigu: false }), false)
  assert.equal(should({ ...base, lastRefreshAt: NOW - 3 * MONTH, enableMigu: false }), false)
})

// ---- 回归哨兵：旧实现在这三个场景下都会误刷 ----
check('哨兵：旧实现在启动 / 保存配置 / 重新生成时都会误刷，新实现不会', () => {
  const oldImpl = ({ hours, enableMigu }) => !!enableMigu && !(hours % 720)
  const 误刷场景 = [
    { name: '容器启动',          startupMode: true,  regenerateOnly: false },
    { name: '后台保存系统配置',   startupMode: false, regenerateOnly: true },
    { name: '启动后源刷新重生成', startupMode: false, regenerateOnly: true },
  ]
  for (const s of 误刷场景) {
    assert.equal(oldImpl({ hours: 0, enableMigu: true }), true, `旧实现本应在「${s.name}」误刷`)
    assert.equal(should({ ...base, ...s }), false, `新实现不该在「${s.name}」刷`)
  }
})

// ---- 状态持久化 ----
check('时间戳能落盘并读回', () => {
  __resetMiguTokenStateCache()
  assert.equal(readMiguTokenState().lastRefreshAt, null)   // 干净目录
  markMiguTokenRefreshed(NOW)
  __resetMiguTokenStateCache()                              // 绕过进程内兜底，真的读文件
  assert.equal(readMiguTokenState().lastRefreshAt, NOW)
  assert.ok(existsSync(join(TMP, 'migu-token-state.json')))
})

check('文件损坏 → 当作没有记录，不抛（损坏不该让整轮更新崩掉）', () => {
  writeFileSync(join(TMP, 'migu-token-state.json'), '{ 这不是 JSON')
  __resetMiguTokenStateCache()
  assert.equal(readMiguTokenState().lastRefreshAt, null)
})

check('时间戳在未来 → 当作没有记录（NAS 掉电后 RTC 不准，否则刷新被无限推迟）', () => {
  writeFileSync(join(TMP, 'migu-token-state.json'), JSON.stringify({ lastRefreshAt: Date.now() + 86400_000 }))
  __resetMiguTokenStateCache()
  assert.equal(readMiguTokenState().lastRefreshAt, null)
})

check('非法值（负数 / 字符串 / 缺字段）→ 当作没有记录', () => {
  for (const bad of [{ lastRefreshAt: -1 }, { lastRefreshAt: 'x' }, {}, { lastRefreshAt: null }]) {
    writeFileSync(join(TMP, 'migu-token-state.json'), JSON.stringify(bad))
    __resetMiguTokenStateCache()
    assert.equal(readMiguTokenState().lastRefreshAt, null, JSON.stringify(bad))
  }
})

rmSync(TMP, { recursive: true, force: true })
console.log(`全部通过：${passed}/${passed} ✅`)
