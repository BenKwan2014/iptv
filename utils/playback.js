import { getDateString, getDateTimeString } from "./time.js"
import { appendFileSync } from "./fileUtil.js"
import { cntvNames } from "./datas.js"
import { fetchUrl } from "./net.js"


async function getPlaybackData(programId, timeout = 6000, githubAnd8) {
  const date = new Date(Date.now() + githubAnd8)
  const today = getDateString(date)
  const resp = await fetchUrl(`https://program-sc.miguvideo.com/live/v2/tv-programs-data/${programId}/${today}`, {}, timeout)
  // fetchUrl 失败时返回 undefined 而不抛（utils/net.js），而 `resp.body?.` 里的 `?.`
  // 只保护 .body 之后、保护不了 resp 自己——原写法在这里直接 TypeError。
  //
  // 但也不能简单地 `resp?.` 一路可选下去：那会把「接口挂了」和「今天这个频道确实
  // 没节目」混成同一个空值，一百多个频道的节目单全没抓到而日志里一个字都没有。
  // 前者抛出去让调用方计数并在收尾报一次，后者返回空即可。
  if (!resp) throw new Error(`节目单接口无响应 (pid ${programId})`)
  return resp.body?.program?.[0]?.content
}

async function updatePlaybackDataByMigu(program, filePath, timeout = 6000, githubAnd8 = 0) {
  // 今日节目数据
  const playbackData = await getPlaybackData(program.pID, timeout, githubAnd8)
  if (!playbackData) {
    return false
  }
  // 写入频道信息
  appendFileSync(filePath,
    `    <channel id="${program.name}">\n` +
    `        <display-name lang="zh">${program.name}</display-name>\n` +
    `    </channel>\n`
  )

  // 写入节目信息
  for (let i = 0; i < playbackData.length; i++) {
    // 特殊字符转义
    const contName = playbackData[i].contName.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");

    appendFileSync(filePath,
      `    <programme channel="${program.name}" start="${getDateTimeString(new Date(playbackData[i].startTime + githubAnd8))} +0800" stop="${getDateTimeString(new Date(playbackData[i].endTime + githubAnd8))} +0800">\n` +
      `        <title lang="zh">${contName}</title>\n` +
      `    </programme>\n`
    )
  }
  return true
}

async function updatePlaybackDataByCntv(program, filePath, timeout = 6000, githubAnd8 = 0) {
  // 今日节目数据
  const date = new Date(Date.now() + githubAnd8)
  const today = getDateString(date)
  const cntvName = cntvNames[program.name]
  const resp = await fetchUrl(`https://api.cntv.cn/epg/epginfo3?serviceId=shiyi&d=${today}&c=${cntvName}`, {}, timeout)

  // 同上：接口无响应要抛出去被计数，而不是与「没节目」混为一谈
  if (!resp) throw new Error(`CNTV 节目单接口无响应 (${cntvName})`)
  const playbackData = resp[cntvName]?.program
  if (!playbackData) {
    return false
  }
  // 写入频道信息
  appendFileSync(filePath,
    `    <channel id="${program.name}">\n` +
    `        <display-name lang="zh">${program.name}</display-name>\n` +
    `    </channel>\n`
  )

  // 写入节目信息
  for (let i = 0; i < playbackData.length; i++) {
    // 特殊字符转义
    const contName = playbackData[i].t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");

    appendFileSync(filePath,
      `    <programme channel="${program.name}" start="${getDateTimeString(new Date(playbackData[i].st * 1000 + githubAnd8))} +0800" stop="${getDateTimeString(new Date(playbackData[i].et * 1000 + githubAnd8))} +0800">\n` +
      `        <title lang="zh">${contName}</title>\n` +
      `    </programme>\n`
    )
  }
  return true
}

async function updatePlaybackData(program, filePath, timeout = 6000, githubAnd8 = 0) {
  if (cntvNames[program.name]) {
    return updatePlaybackDataByCntv(program, filePath, timeout, githubAnd8)
  }
  return updatePlaybackDataByMigu(program, filePath, timeout, githubAnd8)

}
export { updatePlaybackData }

