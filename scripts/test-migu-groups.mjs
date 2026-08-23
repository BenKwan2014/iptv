#!/usr/bin/env node
/**
 * 咪咕分组归一测试。
 *
 * 咪咕按自己的分类给同一个频道打多个标签：CCTV1 同时在 央视/影视/新闻/纪实，
 * 四份完全一样（同名、同 tvg-id、同地址），只有 group-title 不同。实测代价：
 * 645 个条目对应 593 个真实频道，47 个频道跨分组重复；播放器按名聚合成「源1/源2」
 * 后，CCTV1 显示成有 4 个源而它们指向同一个地址；「我的频道」的配置键带原始分组名，
 * 隐藏一次只隐藏一份。
 *
 * 这是条纯数据整形规则，改错了**不会报错** —— 频道只是悄悄跑到别的分组、
 * 或者又开始到处重复。所以把它钉在这里。
 *
 * 运行： node scripts/test-migu-groups.mjs   （或 npm test）
 */
import assert from 'node:assert/strict'
// 经 registry 入口导入：直接 import 模块文件会撞上既有的循环依赖（migu →
// systemConfigAPI → updateData → extractorManager → registry → migu）的 TDZ。
import '../extractors/registry.js'
const { orderAndDedupe } = await import('../extractors/migu/index.js')

let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`  ✅ ${name}`) }

const g = (name, ...pids) => ({ name, dataList: pids.map(p => ({ pID: String(p), name: 'ch' + p })) })
const shape = (groups) => groups.map(x => [x.name, x.dataList.map(c => c.pID)])

console.log('咪咕分组归一测试')

check('分组顺序：央视 → 卫视 → 体育 → 地方，其余按名字', () => {
  const out = orderAndDedupe([g('影视', 1), g('地方', 2), g('央视', 3), g('新闻', 4), g('体育', 5), g('卫视', 6)])
  assert.deepEqual(out.map(x => x.name), ['央视', '卫视', '体育', '地方', '新闻', '影视'],
    '表内四个按固定顺序，表外的按中文排序（新闻 xin < 影视 ying）')
})

check('★ 同一个 pID 只留在最靠前的分组里', () => {
  // CCTV1(pid=1) 咪咕给了四个分组
  const out = orderAndDedupe([g('影视', 1), g('新闻', 1), g('纪实', 1), g('央视', 1, 2)])
  assert.deepEqual(shape(out), [['央视', ['1', '2']]],
    'CCTV1 应只留在央视，其余三组被去空后不再输出')
})

check('去空的分组不出现在结果里（免得播放列表挂空分组）', () => {
  const out = orderAndDedupe([g('央视', 1), g('新闻', 1)])
  assert.deepEqual(out.map(x => x.name), ['央视'])
})

check('不跨分组误删：不同 pID 同名也各自保留', () => {
  // 「梨园频道」在咪咕和外部源各有一份是合法的多源，但那发生在模块之外；
  // 模块内部只按 pID 去重，同名不同 pID 必须都留着
  const out = orderAndDedupe([g('央视', 1), g('地方', 2)])
  assert.deepEqual(shape(out), [['央视', ['1']], ['地方', ['2']]])
})

check('优先级表外的分组之间不因去重乱序', () => {
  const out = orderAndDedupe([g('综艺', 9), g('纪实', 8), g('教育', 7)])
  // ICU 的中文排序是**逐字**比拼音、不是整串比：纪(jì) vs 教(jiào)，"ji" 是 "jiao"
  // 的前缀所以纪在前。第一版这里按整串拼音写成了 教育 < 纪实，被测试当场拦下。
  assert.deepEqual(out.map(x => x.name), ['纪实', '教育', '综艺'])
})

check('空输入 / 空分组不炸', () => {
  assert.deepEqual(orderAndDedupe([]), [])
  assert.deepEqual(orderAndDedupe([{ name: '央视', dataList: [] }]), [])
})

console.log(`全部通过：${passed} ✅`)
