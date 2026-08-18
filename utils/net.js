import os from "os"
import fetch from 'node-fetch'
import { printRed } from "./colorOut.js";

function getLocalIPv(ver = 4) {
  const ips = []
  const inter = os.networkInterfaces()
  // console.dir(inter, { depth: null })
  for (let net in inter) {

    // console.dir(net, { depth: null })
    // console.log()
    for (let netPort of inter[net]) {
      // netPort = inter[net][netPort]
      // console.dir(netPort, { depth: null })
      if (netPort.family === `IPv${ver}`) {
        // console.dir(netPort, { depth: null })
        ips.push(netPort.address)
      }
    }
  }
  // console.log()
  // console.dir(ips, { depth: null })
  return ips
}

async function fetchUrl(url, opts = {}, timeout = 6000) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort()
  }, timeout);
  // opts["signal"] = controller.signal
  const res = await fetch(url, {
    ...opts,
    signal: controller.signal
  })
    .then(r => {
      clearTimeout(timeoutId);
      return r.json()
    })
    .catch(err => {
      clearTimeout(timeoutId);
      if (timedOut) {
        // 超时只打印警告，不打印错误详情
        // printYellow(`请求超时: ${url.substring(0, 80)}...`)
      } else {
        // 网络类错误打一行摘要即可（ETIMEDOUT/ECONNRESET 等），完整堆栈只会刷屏吓人（用户日志截图反馈）
        printRed(`请求失败 [${err?.code || err?.name || 'ERROR'}]: ${String(url).substring(0, 80)}`)
      }
    })

  return res
}

export {
  getLocalIPv, fetchUrl
}
