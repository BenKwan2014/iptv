import puppeteer from "puppeteer"
import { existsSync } from "node:fs"
import { printBlue, printGreen, printRed } from "./colorOut.js"

// 各平台系统已安装的 Chrome / Chromium / Edge 常见可执行路径（按优先级）
const SYSTEM_CHROME_PATHS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
}

// 探测系统已安装的浏览器可执行文件，找到第一个存在的返回，否则 null
function findSystemChrome() {
  for (const p of (SYSTEM_CHROME_PATHS[process.platform] || [])) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 启动 Chromium / Chrome，按以下顺序尽量找到可用浏览器，降低「Could not find Chrome」的踩坑概率：
 *   1) 环境变量 PUPPETEER_EXECUTABLE_PATH / mchromePath 显式指定（最高优先；Docker 镜像即指向 /usr/bin/chromium）
 *   2) 系统已安装的 Google Chrome / Chromium / Edge（裸跑首选，避开 puppeteer 自带 Chrome
 *      在部分机器上下载失败 / 被安全软件删库的坑，无需任何环境变量即可开箱即用）
 *   3) puppeteer 自带、用 `npx puppeteer browsers install chrome` 下载的 Chrome
 *   4) 最后兜底 channel: 'chrome'（再让 puppeteer 自己找系统 Chrome）
 * @param {boolean} headless
 */
async function launchBrowser(headless) {
  // --disable-blink-features=AutomationControlled：部分站点（如 vtvgo.vn，邮件反馈）检测到
  // 自动化特征后直接不渲染页面（白屏），关掉该特征让无头抓取与真实浏览器行为一致；
  // --autoplay-policy：允许播放器免手势自动起播（多数直播页要起播才发起 m3u8 请求）
  const baseArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required']

  // 1) 显式指定
  //
  // 必须包 try：这里若直接 return，显式路径不可用时后面三级回退一级都不会走。
  // 真实会踩到的两种情况：
  //   - arm/v6 镜像里 Alpine 没有 chromium 包（apk 那行有 `|| echo` 静默跳过），
  //     而 Dockerfile 仍设了 PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
  //   - 用户自己把 mchromePath 填错
  // 两种都会让抓取型的源彻底不可用，而报的是 puppeteer 的 ENOENT，看不懂。
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.mchromePath
  if (explicit) {
    try {
      return await puppeteer.launch({ headless, args: baseArgs, executablePath: explicit })
    } catch (err) {
      printRed(`指定的浏览器不可用(${explicit})，改用系统/自带浏览器: ${(err?.message || err).split('\n')[0]}`)
    }
  }

  // 2) 系统已安装的浏览器
  const systemChrome = findSystemChrome()
  if (systemChrome) {
    try {
      const browser = await puppeteer.launch({ headless, args: baseArgs, executablePath: systemChrome })
      printBlue(`使用系统浏览器: ${systemChrome}`)
      return browser
    } catch (err) {
      printRed(`系统浏览器启动失败(${systemChrome})，改用 puppeteer 自带: ${(err?.message || err).split('\n')[0]}`)
    }
  }

  // 3) puppeteer 自带；4) 失败再兜底 channel: 'chrome'
  try {
    return await puppeteer.launch({ headless, args: baseArgs })
  } catch (err) {
    if (/Could not find Chrome|Browser was not found|Failed to launch|Could not find expected browser/i.test(err?.message || '')) {
      printRed('puppeteer 自带 Chrome 不可用，尝试 channel: chrome…')
      try {
        return await puppeteer.launch({ headless, args: baseArgs, channel: 'chrome' })
      } catch (lastErr) {
        // 四级都试过了。报一句人能看懂的话——原始错误是 puppeteer 的 ENOENT，
        // 用户从中看不出「这台机器/这个架构根本没有浏览器」。
        throw new Error(
          '找不到可用的 Chrome/Chromium，网页抓取型的源无法工作。'
          + '容器部署请确认镜像内 /usr/bin/chromium 存在（部分架构如 arm/v6 的 Alpine 没有该包）；'
          + '裸跑请安装 Chrome，或用 mchromePath 指定路径。'
          + `原始错误: ${(lastErr?.message || lastErr).split('\n')[0]}`
        )
      }
    }
    throw err
  }
}

// U+00A0–U+00FF 每个字符对应的 HTML 遗留命名实体名（按码点顺序排列）。整段 Latin-1
// 补充区恰好都是「不带分号也会被解码」的旧式实体：Chromium 解析网页文本时会把
// "&timestamp=" 里的 "&times" 解成 ×、"&notin=" 里的 "&not" 解成 ¬ 等，导致从
// innerText 提取的 m3u8 地址被写坏（issue #84 同源问题）。合法 URL 里不会出现这些
// 未编码的原始字符，故提取结果中凡命中此区间的字符都可安全还原回 "&实体名"。
const LEGACY_ENTITY_NAMES = [
  'nbsp', 'iexcl', 'cent', 'pound', 'curren', 'yen', 'brvbar', 'sect',
  'uml', 'copy', 'ordf', 'laquo', 'not', 'shy', 'reg', 'macr',
  'deg', 'plusmn', 'sup2', 'sup3', 'acute', 'micro', 'para', 'middot',
  'cedil', 'sup1', 'ordm', 'raquo', 'frac14', 'frac12', 'frac34', 'iquest',
  'Agrave', 'Aacute', 'Acirc', 'Atilde', 'Auml', 'Aring', 'AElig', 'Ccedil',
  'Egrave', 'Eacute', 'Ecirc', 'Euml', 'Igrave', 'Iacute', 'Icirc', 'Iuml',
  'ETH', 'Ntilde', 'Ograve', 'Oacute', 'Ocirc', 'Otilde', 'Ouml', 'times',
  'Oslash', 'Ugrave', 'Uacute', 'Ucirc', 'Uuml', 'Yacute', 'THORN', 'szlig',
  'agrave', 'aacute', 'acirc', 'atilde', 'auml', 'aring', 'aelig', 'ccedil',
  'egrave', 'eacute', 'ecirc', 'euml', 'igrave', 'iacute', 'icirc', 'iuml',
  'eth', 'ntilde', 'ograve', 'oacute', 'ocirc', 'otilde', 'ouml', 'divide',
  'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute', 'thorn', 'yuml',
]

/**
 * 还原从 innerText 提取的地址里被浏览器误解码的旧式命名实体（见上）。整段
 * U+00A0–U+00FF 都按码点还原回 "&实体名"。纯字符串处理，放在 Node 侧便于单测。
 */
function restoreLegacyEntities(url) {
  return url.replace(/[ -ÿ]/g, ch => '&' + LEGACY_ENTITY_NAMES[ch.charCodeAt(0) - 0xA0])
}

/**
 * 从网页中提取 m3u8 直播链接
 * @param {string} url - 网页地址
 * @param {object} options - 配置选项
 * @param {string} options.playButtonSelector - 播放按钮选择器
 * @param {number} options.waitTime - 等待时间（毫秒）
 * @param {boolean} options.headless - 是否无头模式
 * @returns {Promise<string>} m3u8 链接
 */
async function extractM3u8FromWeb(url, options = {}) {
  const {
    playButtonSelector = null, // 播放按钮选择器，如：'.play-btn', '#play-button'
    waitTime = 5000,           // 等待时间
    headless = true,           // 无头模式
    timeout = 30000,          // 页面超时
    returnAll = false         // 是否返回全部链接
  } = options

  let browser = null
  
  try {
    printBlue(`开始提取: ${url}`)
    
    // 启动浏览器（自带 Chrome 找不到时回退系统 Google Chrome）
    browser = await launchBrowser(headless)
    
    const page = await browser.newPage()

    // 隐藏 webdriver 指纹 + 使用完整版 Chrome UA：navigator.webdriver=true 和
    // 裸 UA（没有 Chrome/xx 版本号）是站点识别无头爬虫的两大特征，命中后有的站直接白屏（vtvgo.vn 实测）
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    
    // 监听网络请求，捕获 m3u8 链接
    const m3u8Links = []
    
    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('.m3u8')) {
        m3u8Links.push(url)
        printGreen(`发现 m3u8: ${url}`)
      }
    })
    
    // 访问页面
    printBlue(`访问页面: ${url}`)
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout 
    })
    
    // 等待页面加载
    printBlue(`等待页面加载...`)
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // 如果指定了播放按钮，则点击
    if (playButtonSelector) {
      try {
        printBlue(`查找播放按钮: ${playButtonSelector}`)
        await page.waitForSelector(playButtonSelector, { timeout: 10000 })
        await page.click(playButtonSelector)
        printGreen(`播放按钮已点击`)
      } catch (error) {
        printRed(`播放按钮点击失败: ${error.message}`)
      }
    }
    
    // 等待 m3u8 链接出现
    printBlue(`等待 m3u8 链接...`)
    await new Promise(resolve => setTimeout(resolve, waitTime))

    // 仍没嗅探到 m3u8：多数直播页要一次「播放」动作才开始拉流。未配置播放按钮选择器时，
    // 兜底尝试常见播放器的播放按钮，或直接对 video 元素静音起播，再多等几秒
    if (m3u8Links.length === 0 && !playButtonSelector) {
      const triggered = await page.evaluate(() => {
        const selectors = ['.vjs-big-play-button', '.jw-display-icon-display', '.dplayer-play-icon', '[class*="btn-play"]', '[class*="play-btn"]', '[class*="play_btn"]']
        for (const s of selectors) {
          const el = document.querySelector(s)
          if (el) { el.click(); return s }
        }
        const v = document.querySelector('video')
        if (v) {
          v.muted = true
          const p = v.play()
          if (p && p.catch) p.catch(() => {})
          return 'video.play()'
        }
        return null
      }).catch(() => null)
      if (triggered) {
        printBlue(`尝试触发播放: ${triggered}`)
        await new Promise(resolve => setTimeout(resolve, 4000))
      }
    }

    // 也可以尝试查找页面中的 m3u8 链接。URL 里不可能出现原始的 "<>\"'" 字符，用它们
    // 作为边界，避免把地址后面的引号/标签一起吞进来。
    const { videoSrcLinks, textLinks } = await page.evaluate(() => {
      const videoSrcLinks = []
      // video.src 是解析后的 URL 属性，不受 HTML 文本实体解码影响，直接采用
      document.querySelectorAll('video').forEach(video => {
        if (video.src && video.src.includes('.m3u8')) videoSrcLinks.push(video.src)
      })
      const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g
      const textLinks = document.body.innerText.match(m3u8Regex) || []
      return { videoSrcLinks, textLinks }
    })
    // innerText 是解析后文本，裸写的 "&timestamp=" 会被误解码成 "×tamp="，需在 Node 侧还原（issue #84）
    const pageM3u8Links = [...videoSrcLinks, ...textLinks.map(restoreLegacyEntities)]
    
    // 合并所有找到的链接
    const allLinks = [...new Set([...m3u8Links, ...pageM3u8Links])]
    
    if (allLinks.length > 0) {
      printGreen(`提取成功! 找到 ${allLinks.length} 个链接:`)
      allLinks.forEach((link, index) => {
        printGreen(`${index + 1}: ${link}`)
      })
      return returnAll ? allLinks : allLinks[0]
    } else {
      printRed(`未找到 m3u8 链接`)
      return null
    }
    
  } catch (error) {
    printRed(`提取失败: ${error.message}`)
    return null
  } finally {
    await closeBrowser(browser)
  }
}

/**
 * 健壮地关闭 Puppeteer 浏览器，避免 Chromium 进程泄漏 / 僵尸进程。
 * - 给 browser.close() 设超时：无响应的 Chromium 不会卡死整个更新流程
 *   （update() 已串行化，一次卡死会阻塞后续所有更新）
 * - 超时或关闭异常时强杀 Chromium 进程组（POSIX 下 puppeteer 以 detached 方式
 *   启动 chromium，其 pid 即进程组组长），连同 renderer/zygote 子进程一并清理
 * @param {import('puppeteer').Browser|null} browser
 */
async function closeBrowser(browser) {
  if (!browser) return
  const proc = browser.process()
  let timer
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser.close() 超时')), 10000)
      })
    ])
  } catch (error) {
    printRed(`关闭浏览器异常，强制结束 Chromium 进程: ${error.message}`)
    if (proc && proc.pid) {
      try {
        // 优先杀整个进程组，回收 renderer/zygote 等子进程
        process.kill(-proc.pid, 'SIGKILL')
      } catch (groupErr) {
        try { proc.kill('SIGKILL') } catch (_) { /* 进程可能已退出 */ }
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量提取多个网页的 m3u8 链接
 * @param {Array} sources - 源配置数组
 * @returns {Promise<Array>} 提取结果
 */
async function batchExtractM3u8(sources) {
  const results = []
  
  for (const source of sources) {
    const result = await extractM3u8FromWeb(source.url, source.options)
    results.push({
      name: source.name,
      url: source.url,
      m3u8: result,
      success: !!result
    })
  }
  
  return results
}

/**
 * 验证 m3u8 链接是否有效
 * @param {string} m3u8Url - m3u8 链接
 * @returns {Promise<boolean>} 是否有效
 */
async function validateM3u8(m3u8Url, options = {}) {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, application/octet-stream, */*',
      'Range': 'bytes=0-2048'
    }

    if (options.referer) {
      headers.Referer = options.referer
      try {
        headers.Origin = new URL(options.referer).origin
      } catch (error) {
        // Ignore invalid referer
      }
    }

    const response = await fetch(m3u8Url, { headers })
    if (!response.ok) {
      return false
    }

    const contentType = response.headers.get('content-type') || ''
    const normalizedType = contentType.toLowerCase()
    if (
      normalizedType.includes('mpegurl') ||
      normalizedType.includes('application') ||
      normalizedType.includes('octet-stream') ||
      normalizedType.includes('text/plain')
    ) {
      return true
    }

    const body = await response.text()
    return body.includes('#EXTM3U')
  } catch (error) {
    return false
  }
}

export {
  extractM3u8FromWeb,
  batchExtractM3u8,
  validateM3u8,
  restoreLegacyEntities
}