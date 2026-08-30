import path from "node:path"
import { mkdirSync, readdirSync } from "node:fs"

/**
 * 数据目录：所有运行时配置 / 缓存 / 生成文件的存放位置。
 * - 默认当前工作目录（向后兼容，旧部署无需改动）
 * - 通过环境变量 mdataDir / DATA_DIR 指向挂载卷，可让容器重建（升级镜像）后配置不丢失
 *
 * 注意：只能用环境变量指定——system-config.json 等配置本身就在该目录内，
 * 无法从配置文件里读取此路径（鸡生蛋问题）。
 */

// Dockerfile 里 ENV mdataDir 的值；旧镜像（≤ v4.1.0）用的是 /migu/data。
const DOCKER_DEFAULT_DIR = "/iptv/data"
const DOCKER_LEGACY_DIR = "/migu/data"

/**
 * 选定数据目录。镜像默认路径从 /migu/data 改名为 /iptv/data 后，
 * 老部署（compose 挂的是 ./data:/migu/data，或没挂卷、数据在旧路径的匿名卷里）
 * 拉新镜像必须零操作不丢配置：只有「新默认路径还没有数据、旧路径已有数据」才回落旧路径。
 * 显式设了 mdataDir=/migu/data 的老 compose 不经过此逻辑（env 直取）；
 * 两边都有数据时以新路径为准，绝不猜。
 *
 * @param {string} envDir - 环境变量解析出的目录（mdataDir / DATA_DIR / cwd 兜底）
 * @param {{defaultDir?: string, legacyDir?: string, hasData?: (dir: string) => boolean}} [opts] - 测试注入用
 * @returns {{dir: string, usedLegacy: boolean}}
 */
function pickDataDir(envDir, opts = {}) {
  const defaultDir = opts.defaultDir ?? DOCKER_DEFAULT_DIR
  const legacyDir = opts.legacyDir ?? DOCKER_LEGACY_DIR
  const hasData = opts.hasData ?? ((dir) => {
    try { return readdirSync(dir).length > 0 } catch { return false }
  })
  if (envDir === defaultDir && !hasData(defaultDir) && hasData(legacyDir)) {
    return { dir: legacyDir, usedLegacy: true }
  }
  return { dir: envDir, usedLegacy: false }
}

const picked = pickDataDir(process.env.mdataDir || process.env.DATA_DIR || process.cwd())
if (picked.usedLegacy) {
  console.warn(`[数据目录] 检测到旧版数据目录 ${DOCKER_LEGACY_DIR} 已有数据，继续沿用（升级无需任何操作）；` +
    `如想换用新路径，把 compose 里的挂载改为 ./data:${DOCKER_DEFAULT_DIR} 即可`)
}
const DATA_DIR = picked.dir

// 确保数据目录存在（首次挂载空卷时）
try {
  mkdirSync(DATA_DIR, { recursive: true })
} catch (error) {
  // 已存在或无法创建；无法创建时后续读写会自然报错
}

/**
 * 拼接数据目录下的文件路径
 * @param {string} name - 文件名（如 'system-config.json'）
 * @returns {string}
 */
function dataPath(name) {
  return path.join(DATA_DIR, name)
}

export { DATA_DIR, dataPath, pickDataDir }
