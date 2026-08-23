#!/usr/bin/env node
/**
 * 抓取模块注册表 + 哔哩哔哩直播模块 测试。
 *
 * 覆盖的不变量：
 *  - 注册表：id 白名单、sourceId 命名空间（它会写进 EXTINF 属性，是注入面）；
 *  - 配置校验：类型/边界/默认值；secret 字段空串=保持原值（否则后台每次保存
 *    都会把用户看不见的凭据抹掉），显式 null 才是清空；
 *  - secret 不回传明文（默认部署下后台是无鉴权的）；
 *  - 环境变量兜底（docker 用户没有别的路子注入凭据）；
 *  - 选流偏好：HLS 优先、AVC 优先，以及地址必须是裸字符串拼接——一旦过
 *    new URL() 就会丢掉 extra 里那段 expires token，地址直接失效；
 *  - 抓取失败时沿用上一轮频道，不让频道静默从播放列表消失；
 *  - 两级开关都要挡住输出。
 *
 * 运行： node scripts/test-extractors.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listModules, getModule, sourceIdOf, resolverFor, validateModule, MODULE_ID_RE } from '../extractors/registry.js'
import { clearUrlCache } from '../utils/appUtils.js'
import { selectFromPlayurl, parseRoomList, normalizeRoom, mapLimit, RoomError } from '../extractors/bilibili-live/api.js'
import { shouldFailRound } from '../extractors/bilibili-live/index.js'
import {
  ExtractorManager, validateConfig, redactConfig, resolveConfig, normalizeGroups, emptyHealth,
} from '../utils/extractorManager.js'

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✅ ${name}`) }

console.log('抓取模块注册表测试')

const bili = getModule('bilibili-live')

// ---- 注册表 ----

check('注册表枚举出模块，且每个 id 都过白名单', () => {
  const modules = listModules()
  assert.ok(modules.length >= 1)
  for (const module of modules) {
    assert.ok(MODULE_ID_RE.test(module.id), `${module.id} 不合法`)
    assert.equal(typeof module.fetch, 'function')
  }
})

check('sourceId 用 xt: 命名空间，与外部源 ext: / 内置源 bi: 不撞', () => {
  assert.equal(sourceIdOf('bilibili-live'), 'xt:bilibili-live')
  // app.js 的 sourceId 白名单正则要求这个形状
  assert.ok(/^xt:[\w.-]{1,64}$/.test(sourceIdOf('bilibili-live')))
})

check('id 白名单挡住会破坏 EXTINF 属性的字符', () => {
  for (const bad of ['A-Upper', '带中文', 'has space', 'quote"inside', '-leading', '']) {
    assert.equal(MODULE_ID_RE.test(bad), false, `${bad} 不该通过`)
  }
})

// ---- 配置校验 ----

check('int 字段：边界外拒绝并回退，不落坏值', () => {
  const bad = validateConfig(bili, { cachingMs: 999999 }, { cachingMs: 3000 })
  assert.equal(bad.ok, false)
  assert.equal(bad.config.cachingMs, 3000, '越界时保持原值')
  assert.match(bad.errors[0].message, /不能大于/)

  const good = validateConfig(bili, { cachingMs: '5000' }, {})
  assert.equal(good.ok, true)
  assert.equal(good.config.cachingMs, 5000, '字符串数字要被转成数字')
})

check('职责分离：validateConfig 只产出要落盘的，默认值由 resolveConfig 补', () => {
  // 未提交的字段：已存的保留，没存过的不写（稀疏）
  assert.equal(validateConfig(bili, {}, { cachingMs: 1234 }).config.cachingMs, 1234)
  assert.deepEqual(validateConfig(bili, {}, {}).config, {}, '空提交 + 空存储 = 什么都不落盘')

  // 默认值在取值层，不在存储层
  const effective = resolveConfig(bili, {})
  assert.equal(effective.cachingMs, 3000)
  assert.equal(effective.preferHls, true)
  assert.equal(resolveConfig(bili, { cachingMs: 1234 }).cachingMs, 1234, '已存值压过默认')
})

check('secret 字段：空串 = 保持原值（后台看不见它，不能因保存而抹掉）', () => {
  const { config } = validateConfig(bili, { sessdata: '' }, { sessdata: 'SECRET' })
  assert.equal(config.sessdata, 'SECRET')
})

check('secret 字段：显式 null 才是清空，且清空后回落到 env', () => {
  // 稀疏存储下「清空」= 键不存在，而不是存一个空串。语义相同，但表达方式让
  // resolveConfig 能正确回落到 env / 默认——存空串是做不到的。
  const { config } = validateConfig(bili, { sessdata: null }, { sessdata: 'SECRET' })
  assert.equal('sessdata' in config, false)

  const saved = process.env.mbiliSessdata
  try {
    process.env.mbiliSessdata = 'FROM_ENV'
    assert.equal(resolveConfig(bili, config).sessdata, 'FROM_ENV', '清空后该由 env 接手')
  } finally {
    if (saved === undefined) delete process.env.mbiliSessdata
    else process.env.mbiliSessdata = saved
  }
})

check('未知字段被丢弃，不会混进配置', () => {
  const { config } = validateConfig(bili, { 一个不存在的字段: 'x', rooms: '13' }, {})
  assert.equal('一个不存在的字段' in config, false)
  assert.equal(config.rooms, '13')
})

check('redactConfig 不回传 secret 明文，只回传有没有值', () => {
  const { config, secretsSet } = redactConfig(bili, { sessdata: 'SECRET', rooms: '13' })
  assert.equal(config.sessdata, '', '绝不能把凭据回传给前端')
  assert.equal(secretsSet.sessdata, true)
  assert.equal(config.rooms, '13', '非 secret 字段照常回传')

  const empty = redactConfig(bili, { sessdata: '' })
  assert.equal(empty.secretsSet.sessdata, false)
})

check('取值分层：已存 → 环境变量 → schema 默认', () => {
  const key = 'mbiliSessdata'
  const saved = process.env[key]
  try {
    process.env[key] = 'FROM_ENV'
    assert.equal(resolveConfig(bili, {}).sessdata, 'FROM_ENV', '没配过 → 用 env')
    assert.equal(resolveConfig(bili, { sessdata: 'FROM_UI' }).sessdata, 'FROM_UI', '配过 → 已存值优先')
    delete process.env[key]
    assert.equal(resolveConfig(bili, {}).sessdata, '', '都没有 → schema 默认')
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

check('稀疏存储：显式设成 false 的布尔字段能压过 env（原先做不到）', () => {
  // 原实现存的是补齐默认值后的全量 key，default:true 的布尔恒为真值 → 直接跳过 env，
  // env 永远读不到；而 default:false 的会被赋成字符串 "false"（真值），
  // 「显式关掉」反而变成「强制打开」。稀疏存储让「没配过」成为明确状态才解开这一条。
  const schema = [{ key: 'flag', type: 'boolean', env: 'mTestFlag', default: true, label: '开关' }]
  const mod = { id: 'probe', configSchema: schema }
  const saved = process.env.mTestFlag
  try {
    process.env.mTestFlag = 'false'
    assert.equal(resolveConfig(mod, {}).flag, false, '没配过 → env 说关就关')
    assert.equal(resolveConfig(mod, { flag: true }).flag, true, '配过 true → 压过 env')
    process.env.mTestFlag = 'true'
    assert.equal(resolveConfig(mod, { flag: false }).flag, false, '配过 false → 同样压过 env')
  } finally {
    if (saved === undefined) delete process.env.mTestFlag
    else process.env.mTestFlag = saved
  }
})

check('稀疏存储：只落盘用户显式设过的字段', () => {
  const { config } = validateConfig(bili, { rooms: '13' }, {})
  assert.deepEqual(Object.keys(config), ['rooms'], '没提交的字段不该被补进存储')
  const again = validateConfig(bili, { preferHls: false }, config)
  assert.deepEqual(Object.keys(again.config).sort(), ['preferHls', 'rooms'], '已存的保留，新提交的加入')
  assert.equal(again.config.preferHls, false, 'false 也算「配过」')
})

check('清空 = 回到「没配过」，而不是存一个空值', () => {
  const stored = { rooms: '13', sessdata: 'SECRET' }
  const cleared = validateConfig(bili, { rooms: '' }, stored)
  assert.equal('rooms' in cleared.config, false, '文本清空后不该留在存储里')
  assert.equal(cleared.config.sessdata, 'SECRET', '没提交的 secret 保持不变')
  const wiped = validateConfig(bili, { sessdata: null }, stored)
  assert.equal('sessdata' in wiped.config, false, 'secret 显式 null 才清空')
})

check('保存别的字段不会顺手把 secret 写成空串（稀疏存储的直接收益）', () => {
  // 原先 validateConfig 对每个 key 都建自有属性，存过一次配置后磁盘上全是自有属性，
  // 于是「用户配过没有」无从判断，env 兜底也就没法按 key 存在与否来做。
  const { config } = validateConfig(bili, { rooms: '13' }, {})
  assert.equal('sessdata' in config, false, '没提交的 secret 不该被补成空串落盘')
})

check('select 字段：只接受 options 里的值，且保留声明的原始类型', () => {
  const mod = { id: 'probe', configSchema: [{
    key: 'rate', type: 'select', label: '画质',
    options: [{ value: 3, label: '高清' }, { value: 9, label: '4K' }], default: 3,
  }] }
  assert.equal(validateConfig(mod, { rate: '9' }, {}).config.rate, 9, '下拉提交的字符串要还原成数字')
  const bad = validateConfig(mod, { rate: '5' }, {})
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0].message, /不是可选值/)
})

check('select 没有 options 会在启动期被拒绝', () => {
  const withField = (field) => ({ id: 'probe', name: 'probe', fetch: async () => ({}), configSchema: [field] })
  assert.throws(() => validateModule(withField({ key: 'x', type: 'select', label: 'x' })), /没有 options/)
  validateModule(withField({ key: 'x', type: 'select', label: 'x', options: [{ value: 1, label: 'a' }] }))
})

check('normalizeGroups 挡住畸形返回，不让一个坏模块搞崩整轮合并', () => {
  assert.deepEqual(normalizeGroups(null), [])
  assert.deepEqual(normalizeGroups('nope'), [])
  assert.deepEqual(normalizeGroups([{ name: '', dataList: [] }]), [])
  assert.deepEqual(normalizeGroups([{ name: 'A', dataList: 'nope' }]), [])
  assert.deepEqual(
    normalizeGroups([{ name: 'A', dataList: [{ name: 'x' }, null, 'bad'] }]),
    [{ name: 'A', dataList: [{ name: 'x' }] }],
  )
})

// ---- 选流 ----

const playurl = (streams) => ({ playurl_info: { playurl: { stream: streams } } })
const codecOf = (name, base, host, extra) => ({
  codec_name: name, base_url: base, current_qn: 10000,
  url_info: [{ host, extra }],
})

check('选流：HLS 优先于 FLV，即便 FLV 排在前面', () => {
  const data = playurl([
    { protocol_name: 'http_stream', format: [{ codec: [codecOf('avc', '/flv', 'https://f', '?t=1')] }] },
    { protocol_name: 'http_hls', format: [{ codec: [codecOf('avc', '/hls', 'https://h', '?t=2')] }] },
  ])
  assert.equal(selectFromPlayurl(data, { preferHls: true }).url, 'https://h/hls?t=2')
  assert.equal(selectFromPlayurl(data, { preferHls: false }).url, 'https://f/flv?t=1')
})

check('选流：AVC 优先于 HEVC（老盒子解不了 HEVC），可反转', () => {
  const data = playurl([
    { protocol_name: 'http_hls', format: [{ codec: [
      codecOf('hevc', '/h265', 'https://a', ''),
      codecOf('avc', '/h264', 'https://a', ''),
    ] }] },
  ])
  assert.equal(selectFromPlayurl(data, {}).url, 'https://a/h264')
  assert.equal(selectFromPlayurl(data, { preferAvc: false }).url, 'https://a/h265')
})

check('选流：地址是裸字符串拼接，expires token 原样保留', () => {
  const extra = '?expires=1787000000&len=0&oi=123&pt=web&sign=abc&trid=xyz'
  const data = playurl([
    { protocol_name: 'http_hls', format: [{ codec: [
      codecOf('avc', '/live-bvc/1/live_1_2.m3u8', 'https://cn-gotcha104.bilivideo.com', extra),
    ] }] },
  ])
  const { url, qn } = selectFromPlayurl(data, {})
  assert.equal(url, `https://cn-gotcha104.bilivideo.com/live-bvc/1/live_1_2.m3u8${extra}`)
  assert.ok(url.includes('sign=abc'), '签名不能在拼接中丢失')
  assert.equal(qn, 10000)
})

check('选流：没有 stream 时报「未开播或地区限制」而不是崩', () => {
  assert.throws(() => selectFromPlayurl(playurl([]), {}), RoomError)
  assert.throws(() => selectFromPlayurl({}, {}), RoomError)
})

check('选流：有 stream 但没有可用 host/base 时报明确错误', () => {
  const data = playurl([{ protocol_name: 'http_hls', format: [{ codec: [
    { codec_name: 'avc', base_url: '', url_info: [{ host: '', extra: '' }] },
  ] }] }])
  assert.throws(() => selectFromPlayurl(data, {}), /没有可用的 host/)
})

// ---- 房间清单解析 ----

check('房间清单：注释行、行尾注释、空行都被正确处理', () => {
  assert.deepEqual(parseRoomList([
    '# 整行注释',
    '',
    '13   # 这是备注',
    '  1022  ',
  ].join('\n')), ['13', '1022'])
})

check('房间清单：URL 的 fragment 不被当成注释截断', () => {
  // Python 版无条件按 # 切，会把带 fragment 的地址截坏
  assert.deepEqual(
    parseRoomList('https://live.bilibili.com/13?spm=1#anchor'),
    ['https://live.bilibili.com/13?spm=1#anchor'],
  )
})

check('房间清单：URL 后跟注释按空白切，地址完整保留', () => {
  assert.deepEqual(
    parseRoomList('https://live.bilibili.com/13?a=1   # TI 主舞台'),
    ['https://live.bilibili.com/13?a=1'],
  )
})

await checkAsync('房间号归一：纯数字 / 路径数字 / h5 路径，都不联网', async () => {
  assert.equal(await normalizeRoom('13'), '13')
  assert.equal(await normalizeRoom('https://live.bilibili.com/1022?live_from=86001'), '1022')
  assert.equal(await normalizeRoom('https://live.bilibili.com/h5/1022'), '1022')
})

await checkAsync('房间号归一：全角数字被归一，不再变成一个必然失败的请求', async () => {
  assert.equal(await normalizeRoom('１３'), '13')
})

await checkAsync('房间号归一：认不出的输入报错而不是静默丢弃', async () => {
  await assert.rejects(() => normalizeRoom('随便写点什么'), RoomError)
  await assert.rejects(() => normalizeRoom(''), RoomError)
})

await checkAsync('mapLimit：保持顺序，且并发不超过上限', async () => {
  let running = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++
    peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 5))
    running--
    return n * 2
  })
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12], '结果必须按输入顺序')
  assert.ok(peak <= 2, `并发峰值 ${peak} 超过上限`)
})

check('全网失败判失败、全体没开播判成功——决定要不要清空用户的频道', () => {
  // 两者都产出 0 个频道。断网时若被记成「成功抓到 0 个」，上一轮缓存会被空结果
  // 覆盖，用户的频道消失且不退避重试。
  assert.equal(shouldFailRound(0, 3), true, '一条没成功且有真错误 → 判失败，保留上一轮缓存')
  assert.equal(shouldFailRound(0, 0), false, '全部没开播 → 正常的 0 条，如实写出')
  assert.equal(shouldFailRound(2, 5), false, '有成功的就不算整轮失败，失败的那几间进 skipped')
})

check('播放路由：裸数字归咪咕，认不出的 ref 无人认领', () => {
  // ⚠️ 「裸数字 → 咪咕」这条兜底不能去掉：体育赛事在 updateData 里直接写
  // ${replace}/<pID> 追加进播放列表，完全绕开 extractorManager；老订阅里缓存的
  // 历史地址同理。改成「只认 fetch() 产出过的 ref」会让这些地址全部 404。
  assert.equal(resolverFor('608807420')?.id, 'migu')
  assert.equal(resolverFor('abc'), null)
})

check('claimsRef 保持 isNaN 语义，不许收紧成 /^\\d+$/', () => {
  // 现网 isNaN("") / isNaN("1e3") / isNaN("0x10") 都是 false，都会被放行走到
  // 咪咕接口。收紧会改掉「地址格式错误」的边界——那是可观察行为变更。
  const migu = getModule('migu')
  for (const pass of ['608807420', '', '1e3', '0x10', 'Infinity', ' 12 ']) {
    assert.equal(migu.claimsRef(pass), true, `${JSON.stringify(pass)} 应当被放行（与收编前一致）`)
  }
  for (const reject of ['abc', '12a', '中文']) {
    assert.equal(migu.claimsRef(reject), false, `${JSON.stringify(reject)} 应当被拒`)
  }
})

check('声明了 resolve 能力的模块必须实现 resolve 与 claimsRef', () => {
  for (const module of listModules()) {
    if (!module.capabilities?.resolve) continue
    assert.equal(typeof module.resolve, 'function', `${module.id} 缺 resolve`)
    assert.equal(typeof module.claimsRef, 'function', `${module.id} 缺 claimsRef`)
  }
})

check('clearUrlCache 会委托到各模块的 clearResolveCache', () => {
  // 画质/编码改动后不清缓存，三小时内会继续下发旧编码的流（issue #60）。
  // 调用点在 systemConfigAPI 与 configBackupAPI，改名要同步两处。
  let called = 0
  const migu = getModule('migu')
  const original = migu.clearResolveCache
  migu.clearResolveCache = () => { called++ }
  try { clearUrlCache() } finally { migu.clearResolveCache = original }
  assert.equal(called, 1)
})

check('咪咕已收编成模块，且三条 wire format 保持不变', () => {
  const migu = getModule('migu')
  assert.ok(migu, '咪咕应当在注册表里')
  assert.equal(migu.sourceId, 'migu', 'source-ids 必须保持字面量，老用户「按档禁用源」存的就是它')
  assert.equal(typeof migu.enabledGetter, 'function', '开关要代理到 config.js 的 enableMigu')
  assert.equal(migu.capabilities.cache, 'memory', '175 个频道带全部原始字段，不该落盘')
})


// ---- 管理器 ----

const tmp = mkdtempSync(join(tmpdir(), 'iptv-extractors-test-'))
// 每个用例一份独立的配置/缓存文件：共用一份的话，前一个用例存下的开关状态
// 会污染后一个（setEnabled(false) 会让后续 updateAll 直接早退）
let caseSeq = 0
const newManager = (legacy) => {
  const seq = ++caseSeq
  const manager = new ExtractorManager()
  manager.configPath = join(tmp, `extractors-${seq}.json`)
  manager.cachePath = join(tmp, `extractor-cache-${seq}.json`)
  // 指向测试自己的旧配置，避免读到仓库根目录里用户的真实 system-config.json
  manager.legacyConfigPath = join(tmp, `system-config-${seq}.json`)
  if (legacy !== undefined) writeFileSync(manager.legacyConfigPath, JSON.stringify(legacy))
  return manager.load()
}
const seed = (manager, groups, health = {}) => {
  manager.cache.modules['bilibili-live'] = {
    groups,
    health: { status: 'ok', lastSuccessAt: Date.now(), consecutiveFailures: 0, ...health },
  }
}
const oneGroup = [{
  name: '赛事', dataList: [{ name: '[原画] 主播', url: 'https://cdn/a.m3u8', opts: ['http-referrer=https://live.bilibili.com/'] }],
}]

try {
  check('迁移：把系统配置里真有的画质搬进模块，幂等，且不覆盖已配过的', () => {
    const manager = newManager({ rateType: 9, enableHDR: false, enableH265: false, port: '1905' })
    const cfg = manager.effectiveConfig(getModule('migu'))
    assert.equal(cfg.rateType, 9)
    assert.equal(cfg.enableHDR, false)
    assert.equal(cfg.enableH265, false)
    assert.equal(manager.config.migrated?.migu, true, '要打迁移标记')
    // 只搬 legacySystemConfigKeys 声明的键，port 是全局配置不该被卷进来
    assert.equal('port' in manager.config.modules.migu.config, false)

    // 幂等：把值改掉并落盘，再 load 一次，迁移不该把它冲回 9
    // （注意要先落盘——load() 会重新读磁盘，只改内存的话是被重读覆盖，测不到迁移）
    manager.updateModuleConfig('migu', { rateType: 4 })
    manager.load()
    assert.equal(manager.effectiveConfig(getModule('migu')).rateType, 4, '标记在就不该再搬')
  })

  check('迁移：凭据不写进日志（docker 日志常被贴进 issue）', () => {
    const lines = []
    const orig = console.log
    console.log = (...a) => lines.push(a.join(' '))
    try {
      newManager({ userId: '12345678', token: 'SECRET_TOKEN_VALUE', rateType: 4 })
    } finally { console.log = orig }
    const all = lines.join('\n')
    assert.ok(all.includes('迁入模块'), '应当有迁移日志')
    assert.equal(all.includes('SECRET_TOKEN_VALUE'), false, 'token 明文不该出现在日志里')
    assert.ok(all.includes('token=<已迁移>'), '应当只报「已迁移」')
    assert.ok(all.includes('12345678'), 'userId 不是 secret，照常打出来便于排查')
  })

  check('迁移：系统配置里没有的键一个都不写，env 继续 live 生效', () => {
    // 这是关键——搬过来等于把 mrateType=4 固化成文件值，用户改 compose 就再也不生效。
    const manager = newManager({ port: '1905' })   // 完全没有画质字段
    assert.deepEqual(manager.config.modules.migu?.config ?? {}, {}, '不该凭空写入')
    const saved = process.env.mrateType
    try {
      process.env.mrateType = '4'
      assert.equal(manager.effectiveConfig(getModule('migu')).rateType, 4, 'env 仍然生效')
    } finally {
      if (saved === undefined) delete process.env.mrateType
      else process.env.mrateType = saved
    }
  })

  check('迁移：旧配置文件损坏时不打标记，下次启动重试', () => {
    const manager = new ExtractorManager()
    const seq = ++caseSeq
    manager.configPath = join(tmp, `extractors-bad-${seq}.json`)
    manager.cachePath = join(tmp, `extractor-cache-bad-${seq}.json`)
    manager.legacyConfigPath = join(tmp, `system-config-bad-${seq}.json`)
    writeFileSync(manager.legacyConfigPath, '{ 这不是合法 JSON')
    manager.load()
    assert.equal(manager.config.migrated?.migu, undefined, '读失败绝不能当成「迁过了」')
  })

  check('代理开关的模块不受抓取子系统总开关约束', () => {
    // config.js 明写「可 mblank=true + menableMigu=true 单独留咪咕」。
    // 咪咕若被 enableExtractors / 文件级开关一起管掉，这个既有组合就废了。
    const manager = newManager()
    manager.setEnabled(false)
    assert.equal(manager.isModuleEnabled(getModule('migu')), true, '咪咕只听 enableMigu')
    assert.equal(manager.isModuleEnabled(getModule('bilibili-live')), false, '普通模块受总开关约束')
  })

  check('代理开关的模块不能从「源模块」页改开关，要指明去哪改', () => {
    const manager = newManager()
    assert.throws(() => manager.setModuleEnabled('migu', false), /系统配置/)
  })

  check('输出：频道被盖上 source=extractor 与 xt: 命名空间的 sourceId', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    const [group] = manager.getValidChannels()
    assert.equal(group.name, '赛事')
    const [channel] = group.dataList
    assert.equal(channel.source, 'extractor', '不能靠「有没有 url」被推断成外部源')
    assert.equal(channel.sourceId, 'xt:bilibili-live')
    assert.equal(channel.groupTitle, '赛事')
    assert.deepEqual(channel.opts, ['http-referrer=https://live.bilibili.com/'])
  })

  check('输出：opts 过消毒，白名单外的键进不了播放列表', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, [{ name: 'G', dataList: [{ name: 'A', url: 'u', opts: ['program=/bin/sh', 'http-referrer=https://x/'] }] }])
    const [channel] = manager.getValidChannels()[0].dataList
    assert.deepEqual(channel.opts, ['http-referrer=https://x/'])
  })

  check('抓取失败时沿用上一轮频道——频道不能静默从播放列表消失', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup, { status: 'failed', consecutiveFailures: 3, lastError: '风控' })
    const groups = manager.getValidChannels()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].dataList.length, 1, '全局的 0 频道守卫只看总数，护不住单个模块')
  })

  check('两级开关都挡住输出：模块级关 / 文件级关', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    assert.equal(manager.getValidChannels().length, 1)

    manager.setModuleEnabled('bilibili-live', false)
    assert.deepEqual(manager.getValidChannels(), [], '模块级开关关掉后不该出频道')

    manager.setModuleEnabled('bilibili-live', true)
    manager.setEnabled(false)
    assert.deepEqual(manager.getValidChannels(), [], '文件级总开关关掉后不该出频道')
  })

  // 以下用例一律带 onlyId：注册表里还有咪咕，不限定的话 updateAll 会去抓真实的
  // 咪咕接口——测试不该联网，也不该受它成败影响。
  await checkAsync('总开关在抓取入口也要挡——关掉后不联网', async () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    manager.setEnabled(false)
    const result = await manager.updateAll({ forceAll: true, onlyId: 'bilibili-live' })
    assert.equal(result.updated, false)
    assert.match(result.message, /整体关闭/)
  })

  await checkAsync('禁用的模块不参与抓取', async () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', false)
    const result = await manager.updateAll({ forceAll: true, onlyId: 'bilibili-live' })
    assert.deepEqual(result.results, [])
  })

  await checkAsync('空房间清单：成功但 0 频道，且不联网', async () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    manager.updateModuleConfig('bilibili-live', { rooms: '' })
    const result = await manager.updateAll({ forceAll: true, onlyId: 'bilibili-live' })
    assert.equal(result.results[0].success, true)
    const state = manager.getState()
    const module = state.modules.find(m => m.id === 'bilibili-live')
    assert.equal(module.health.status, 'empty', '0 频道是「没人播」不是「失败」')
    assert.ok(module.health.warnings.some(w => w.includes('清单')))
  })

  check('配置损坏时拒绝写盘，不把用户配置覆盖成空', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'iptv-extractors-corrupt-'))
    const badPath = join(badDir, 'extractors.json')
    writeFileSync(badPath, '{ 这不是合法 JSON')
    const manager = new ExtractorManager()
    manager.configPath = badPath
    manager.cachePath = join(badDir, 'extractor-cache.json')
    manager.load()

    assert.ok(manager.corrupt, '应当置位损坏标记')
    assert.ok(existsSync(`${badPath}.corrupt`), '应当另存一份原文件')
    assert.throws(() => manager.setEnabled(false), /损坏/)
    assert.ok(readFileSync(badPath, 'utf-8').includes('这不是合法 JSON'), '原文件必须原样保留')
    rmSync(badDir, { recursive: true, force: true })
  })

  check('改配置后立刻到期重抓，而不是等到原定刷新点', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    manager.updateModuleConfig('bilibili-live', { rooms: '13' })
    const module = manager.getState().modules.find(m => m.id === 'bilibili-live')
    assert.equal(module.health.lastSuccessAt, null, '配置变了，上一轮结果不再代表当前配置')
  })

  check('向后兼容：老版本写的「全量 key」配置里，空串不该挡住 env 兜底', () => {
    // 改稀疏存储之前，磁盘上存的是 sessdata:"" 这种「配过但是空」的条目。
    // 老代码 env 兜底用真值判断（空串回落 env），新代码用「键存不存在」——
    // 不归一的话，设了 mbiliSessdata 又存过一次配置的用户 env 会突然失效。
    const manager = newManager()
    manager.config.modules['bilibili-live'] = {
      enabled: true,
      config: { rooms: '13', sessdata: '', preferHls: true, preferAvc: true, cachingMs: 3000 },
    }
    const saved = process.env.mbiliSessdata
    try {
      process.env.mbiliSessdata = 'FROM_ENV'
      const cfg = manager.effectiveConfig(getModule('bilibili-live'))
      assert.equal(cfg.sessdata, 'FROM_ENV', '老配置里的空串要被归一掉，让 env 接手')
      assert.equal(cfg.rooms, '13', '有值的字段保持不变')
      assert.equal(cfg.cachingMs, 3000, 'int 不做归一，保留成「配过」')
    } finally {
      if (saved === undefined) delete process.env.mbiliSessdata
      else process.env.mbiliSessdata = saved
    }
  })

  check('deferredRef 原样透传，供写盘落成 ${replace}/<ref>', () => {
    // 延迟解析模块（咪咕将来就是这个形态）产出 ref 而不是 url。
    // ref 必须保持单个路径段：buildChannelId 用 /^\$\{replace\}\/([^/?#]+)/ 取
    // 频道主键，多段会失配、让老用户的「我的频道」配置一次性作废。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, [{ name: 'G', dataList: [{ name: 'CCTV1', deferredRef: 608807420 }] }])
    const [channel] = manager.getValidChannels()[0].dataList
    assert.equal(channel.deferredRef, '608807420', '数字要归一成字符串')
    assert.ok(!channel.deferredRef.includes('/'), 'ref 不能含斜杠')
  })

  check('cache:disk 的模块：结果与健康状态都落盘', () => {
    // cache:'memory' 的分支目前没有模块声明（咪咕收编时才会用到），故此处未覆盖。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    seed(manager, oneGroup)
    manager.updateModuleConfig('bilibili-live', { rooms: '13' })   // 这条会写缓存
    const onDisk = JSON.parse(readFileSync(manager.cachePath, 'utf-8'))
    // bilibili-live 声明的是 cache:'disk'，所以这里应当落盘
    assert.ok(onDisk.modules['bilibili-live'].groups.length > 0, 'disk 模块的结果要落盘')
    assert.ok(onDisk.modules['bilibili-live'].health, '健康状态要落盘')
  })

  await checkAsync('冷缓存兜底看「本进程抓过没」，不看「历史上成功过没」', async () => {
    // 回归：曾用 !health.lastSuccessAt 做判据。而 cache:'memory' 的模块 groups 不落盘、
    // health 落盘，重启后就是「groups 空 + lastSuccessAt 有值」，那个判据会把真正需要
    // 兜底的场景整个挡掉——实测设了 updateOnStartup=false 的用户重启后一次重生成，
    // 175 条咪咕频道整批从播放列表消失。
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    manager.updateModuleConfig('bilibili-live', { rooms: '' })   // 空清单 = 不联网
    // 模拟「上次成功过、但本进程 groups 是空的」
    manager.cache.modules['bilibili-live'] = {
      groups: [], health: { ...emptyHealth(), status: 'ok', lastSuccessAt: Date.now() },
    }
    const first = await manager.ensureWarm()
    assert.ok(first.results.some(r => r.id === 'bilibili-live'), '有过成功记录也要兜底抓一次')

    // 抓过之后即便结果是 0 条（房间全没开播是合法的空），不该反复重抓
    const second = await manager.ensureWarm()
    assert.deepEqual(second.results, [], '本进程已抓过就不再重复兜底')
  })

  check('critical 模块一条频道都没有时会被报出来，供写盘守卫拦截', () => {
    // 回归：收编前咪咕现抓失败会让 getAllChannels 返回空 → 全局 0 频道守卫触发 →
    // 一个字节都不写。收编后失败被吞在模块内，而外部源几十条就能把总数撑起来，
    // 守卫失效 → 播放列表被重写成没有咪咕的版本（实测 484 条 → 0 条）。
    // 那份保护本来是靠「咪咕失败 = 全局 0 条」的巧合得来的，现在改成显式声明。
    const manager = newManager()
    assert.deepEqual(manager.criticalShortfall(), ['咪咕视频'], '缓存为空时必须报出来')

    // 有频道了就不该再报
    manager.cache.modules['migu'] = {
      groups: [{ name: '央视', dataList: [{ name: 'CCTV1', deferredRef: '1' }] }],
      health: { ...emptyHealth(), status: 'ok', lastSuccessAt: Date.now() },
    }
    assert.deepEqual(manager.criticalShortfall(), [])
  })

  check('非 critical 模块拿不到频道不触发守卫（房间全没开播是合法的空）', () => {
    const manager = newManager()
    manager.setModuleEnabled('bilibili-live', true)
    manager.cache.modules['migu'] = {
      groups: [{ name: '央视', dataList: [{ name: 'CCTV1', deferredRef: '1' }] }],
      health: { ...emptyHealth(), status: 'ok', lastSuccessAt: Date.now() },
    }
    // bilibili-live 没有 critical，0 条频道不该让整份播放列表停止生成
    assert.deepEqual(manager.criticalShortfall(), [])
  })

  check('刷新间隔默认取模块声明值，且远小于 B 站地址的 2 小时有效期', () => {
    const manager = newManager()
    const module = manager.getState().modules.find(m => m.id === 'bilibili-live')
    assert.equal(module.refreshMinutes, 45)
    assert.ok(module.refreshMinutes * 60 * 1000 < 2 * 60 * 60 * 1000)
  })

  check('刷新间隔越界被拒绝', () => {
    const manager = newManager()
    assert.throws(() => manager.updateModuleConfig('bilibili-live', {}, { refreshMinutes: 0 }), /1~1440/)
    assert.throws(() => manager.updateModuleConfig('bilibili-live', {}, { refreshMinutes: 9999 }), /1~1440/)
  })

  check('未知模块 id 被拒绝', () => {
    const manager = newManager()
    assert.throws(() => manager.setModuleEnabled('不存在', true), /未知的抓取模块/)
    assert.throws(() => manager.updateModuleConfig('不存在', {}), /未知的抓取模块/)
  })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n全部通过：${passed}/59 ✅`)
