import { fetchUrl } from "./net.js"
import { printYellow } from "./colorOut.js"

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

// 获取分组集合
async function cateList() {
  const resp = await fetchUrl("https://program-sc.miguvideo.com/live/v2/tv-data/1ff892f2b5ab4a79be6e25b69d2f5d05")
  // fetchUrl 失败时返回 undefined 而不抛（utils/net.js），不判的话下一行会是
  // 「Cannot read properties of undefined」——那条报错传到后台「源模块」的健康
  // 状态里，用户完全看不出是接口挂了。
  if (!resp?.body?.liveList) throw new Error("咪咕分类接口无响应")
  let liveList = resp.body.liveList
  // 热门内容重复
  liveList = liveList.filter(item => {
    return item.name != "热门"
  })

  // 央视作为首个分组
  liveList.sort((a, b) => {
    if (a.name === "央视") return -1;
    if (b.name === "央视") return 1
    return 0
  })

  return liveList
}

// 所有数据
async function dataList() {
  let cates = await cateList()

  // 单个分类抓失败不该连累其余分类，但也不能像原来那样完全静默——11 个分类挂掉
  // 一个就少二三十个频道，而模块那边照样报「成功」。逐个打会刷屏，收尾统一报一次。
  const failed = []
  for (let cate in cates) {
    try {
      const resp = await fetchUrl("https://program-sc.miguvideo.com/live/v2/tv-data/" + cates[cate].vomsID)
      if (!resp?.body?.dataList) throw new Error("接口无响应")
      cates[cate].dataList = resp.body.dataList
    } catch (error) {
      cates[cate].dataList = [];
      failed.push(cates[cate].name || cates[cate].vomsID)
    }
  }
  if (failed.length) {
    printYellow(`咪咕有 ${failed.length} 个分类本轮抓取失败，这些分类本轮没有频道：${failed.join('、')}`)
  }

  // 去除重复节目
  cates = uniqueData(cates)
  // console.dir(cates, { depth: null })
  // console.log(cates)
  return cates
}

// 对data的dataList去重（分类内去重，不同分类允许同一频道同时存在）
function uniqueData(liveList) {
  liveList.forEach(category => {
    const seen = new Set()
    category.dataList = category.dataList.filter(program => {
      if (seen.has(program.name)) return false
      seen.add(program.name)
      return true
    })
  })
  return liveList
}

export { cateList, dataList, delay }
