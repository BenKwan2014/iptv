/** 广东台官网浏览器取票会话：复用一个 Chromium 页面，避免每次清单轮询都启动浏览器。 */
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer'

import { printBlue, printRed } from '../../utils/colorOut.js'
import { channelPageUrl } from './channels.js'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const IDLE_CLOSE_MS = 5 * 60 * 1000
const DEFAULT_CAPTURE_TIMEOUT_MS = 20 * 1000

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

export function isOfficialStreamUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim())
    return url.protocol === 'https:'
      && url.hostname === 'tcdn.itouchtv.cn'
      && url.pathname.startsWith('/live/')
      && /\.m3u8$/i.test(url.pathname)
      && !!url.searchParams.get('t_token')
  } catch {
    return false
  }
}

function systemChromePath() {
  return (SYSTEM_CHROME_PATHS[process.platform] || []).find(path => existsSync(path)) || ''
}

async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
  ]
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.mchromePath
  const candidates = [
    explicit ? { executablePath: explicit } : null,
    systemChromePath() ? { executablePath: systemChromePath() } : null,
    {},
    { channel: 'chrome' },
  ].filter(Boolean)

  let lastError
  for (const candidate of candidates) {
    try {
      return await puppeteer.launch({ headless: true, args, ...candidate })
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    '找不到可用的 Chrome/Chromium，广东台播放地址无法自动续签。'
    + '请安装 Chrome，或用 mchromePath / PUPPETEER_EXECUTABLE_PATH 指定浏览器。'
    + `原始错误: ${(lastError?.message || lastError || '未知错误').split('\n')[0]}`
  )
}

async function closeBrowser(browser) {
  if (!browser) return
  const proc = browser.process()
  let timer
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser.close() 超时')), 5000)
      }),
    ])
  } catch (error) {
    printRed(`广东台浏览器会话关闭异常，强制结束 Chromium: ${error?.message || error}`)
    if (proc?.pid) {
      try { process.kill(-proc.pid, 'SIGKILL') } catch {
        try { proc.kill('SIGKILL') } catch { /* 进程可能已经退出 */ }
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

export class GdtvBrowserSession {
  constructor({ idleCloseMs = IDLE_CLOSE_MS } = {}) {
    this.idleCloseMs = idleCloseMs
    this.browser = null
    this.page = null
    this.opening = null
    this.queue = Promise.resolve()
    this.idleTimer = null
  }

  async #ensurePage() {
    if (this.page && !this.page.isClosed() && this.browser?.connected) return this.page
    if (!this.opening) {
      this.opening = (async () => {
        const browser = await launchBrowser()
        browser.once('disconnected', () => {
          if (this.browser === browser) {
            this.browser = null
            this.page = null
          }
        })
        const page = await browser.newPage()
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        })
        await page.setUserAgent(USER_AGENT)
        await page.setRequestInterception(true)
        page.on('request', request => {
          if (['image', 'font'].includes(request.resourceType())) request.abort().catch(() => {})
          else request.continue().catch(() => {})
        })
        this.browser = browser
        this.page = page
        printBlue('广东台续签浏览器会话已启动')
        return page
      })().finally(() => { this.opening = null })
    }
    return this.opening
  }

  #armIdleClose() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { void this.close() }, this.idleCloseMs)
    this.idleTimer.unref?.()
  }

  async #capture(channelId, timeoutMs) {
    const page = await this.#ensurePage()
    const target = channelPageUrl(channelId)
    let timer
    let onResponse
    const captured = new Promise((resolve, reject) => {
      onResponse = response => {
        const url = response.url()
        if (isOfficialStreamUrl(url)) resolve(url)
      }
      page.on('response', onResponse)
      timer = setTimeout(() => reject(new Error(`等待官网播放地址超时 ${timeoutMs}ms`)), timeoutMs)
    })

    let navigationError = null
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 15000) })
    } catch (error) {
      navigationError = error
    }

    // 官网通常自动起播；浏览器策略或页面改版导致没起播时再补一次用户动作。
    await page.evaluate(() => {
      const video = document.querySelector('video')
      if (video) {
        video.muted = true
        const playing = video.play()
        if (playing?.catch) playing.catch(() => {})
      }
      const button = document.querySelector('.vjs-big-play-button, [class*="play-btn"], [class*="btn-play"]')
      if (button) button.click()
    }).catch(() => {})

    try {
      return await captured
    } catch (error) {
      if (navigationError) {
        throw new Error(`官网页面加载失败：${navigationError?.message || navigationError}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (onResponse) page.off('response', onResponse)
      this.#armIdleClose()
    }
  }

  /** 同一个 page 不能并行导航；所有频道取票在模块内部排队。 */
  capture(channelId, options = {}) {
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || DEFAULT_CAPTURE_TIMEOUT_MS))
    const task = () => this.#capture(channelId, timeoutMs)
    const pending = this.queue.then(task, task)
    this.queue = pending.catch(() => {})
    return pending
  }

  async close() {
    clearTimeout(this.idleTimer)
    this.idleTimer = null
    // clearResolveCache 可能正好撞在首次启动 Chromium 的窗口；等启动动作落地后再
    // 取 browser 引用，避免「关闭时还是 null，下一拍却冒出一个无人管理的进程」。
    if (this.opening) await this.opening.catch(() => {})
    const browser = this.browser
    this.browser = null
    this.page = null
    if (browser) await closeBrowser(browser)
  }
}

export const browserSession = new GdtvBrowserSession()
