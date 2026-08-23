#!/usr/bin/env node
/**
 * 咪咕 token 刷新时机测试。
 *
 * 为什么值得单独一个测试文件：refreshToken() 打的是咪咕的登录续期接口
 * （migu-app-umnb.miguvideo.com/login/token_refresh_migu_plus，带 userId + userToken），
 * config.js 原注释说这可能是导致封号的原因。判据是一行布尔表达式，改错了**不报错**，
 * 只是悄悄开始高频请求。所以把「什么时候该刷」的完整真值表钉死在这里。
 *
 * 原实现只判 `!(hours % 720)`。hours 是进程内计数器（app.js 的 `var hours = 0`），
 * 而 0 % 720 === 0 恒真 —— 于是每次容器启动、启动后头 8 小时内的每次重新生成、
 * 以及后台 8 处 update(0, { regenerateOnly: true })（保存配置 / 导入配置 /
 * 上传或删除台标 / 复制频道）都会各刷一次。
 *
 * 运行： node scripts/test-token-refresh.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { shouldRefreshMiguToken as should } from '../utils/updateData.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('咪咕 token 刷新时机测试')

const base = { hours: 720, regenerateOnly: false, startupMode: false, enableMigu: true }

// ---- 唯一应该刷的场景：定时的完整更新，且真的走到了整月刻度 ----
check('定时完整更新走到 720 小时 → 刷', () => {
  assert.equal(should(base), true)
})

check('720 的整数倍继续刷（1440 / 2160）', () => {
  assert.equal(should({ ...base, hours: 1440 }), true)
  assert.equal(should({ ...base, hours: 2160 }), true)
})

check('没到整月刻度不刷', () => {
  for (const hours of [8, 16, 719, 721, 1439]) {
    assert.equal(should({ ...base, hours }), false, `hours=${hours} 不该刷`)
  }
})

// ---- 三道闸，逐条锁死。任何一条被去掉，对应这里就会红 ----
check('闸一：regenerateOnly —— 用缓存重生成播放列表绝不联网做账号操作', () => {
  // 覆盖后台 8 处 update(0, { regenerateOnly: true })：保存系统配置 / 导入配置 /
  // 上传台标 / 删除台标 / 复制频道 / adminAPI 另两处 / app.js 的源刷新后重生成。
  assert.equal(should({ ...base, hours: 0, regenerateOnly: true }), false)
  // 也要挡住「hours 恰好是 720 的倍数时的重新生成」——这条闸与 hours 无关
  assert.equal(should({ ...base, hours: 720, regenerateOnly: true }), false)
  assert.equal(should({ ...base, hours: 1440, regenerateOnly: true }), false)
})

check('闸二：startupMode —— 容器启动不刷（NAS 重启 / compose 更新 / 崩溃拉起）', () => {
  assert.equal(should({ ...base, hours: 0, startupMode: true }), false)
  assert.equal(should({ ...base, hours: 720, startupMode: true }), false)
})

check('闸三：hours > 0 —— 兜底，hours 还没走动时的任何完整更新都不刷', () => {
  // 这正是原实现最致命的一格：0 % 720 === 0 恒真
  assert.equal(should({ ...base, hours: 0 }), false)
  assert.equal(should({ hours: 0, regenerateOnly: false, startupMode: false, enableMigu: true }), false)
})

// ---- 咪咕关掉时任何情况都不刷 ----
check('enableMigu=false → 一律不刷', () => {
  for (const hours of [0, 720, 1440]) {
    assert.equal(should({ ...base, hours, enableMigu: false }), false, `hours=${hours}`)
  }
})

// ---- 回归哨兵：把改动前的实现跑一遍同样的场景，证明它确实会误刷 ----
check('哨兵：旧实现 !(hours % 720) 在这些场景下都会误刷，新实现不会', () => {
  const oldImpl = ({ hours, enableMigu }) => !!enableMigu && !(hours % 720)
  const 误刷场景 = [
    { name: '容器启动',            hours: 0, startupMode: true,     regenerateOnly: false },
    { name: '后台保存系统配置',     hours: 0, startupMode: false,    regenerateOnly: true  },
    { name: '启动后源刷新重生成',   hours: 0, startupMode: false,    regenerateOnly: true  },
  ]
  for (const s of 误刷场景) {
    const args = { ...s, enableMigu: true }
    assert.equal(oldImpl(args), true,  `旧实现本应在「${s.name}」误刷，前提变了？`)
    assert.equal(should(args),  false, `新实现不该在「${s.name}」刷`)
  }
})

console.log(`全部通过：${passed}/${passed} ✅`)
