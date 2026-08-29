import { createDecipheriv, createHash } from 'node:crypto'

const TS_PACKET_SIZE = 188
const KEY_SALT = '01234568'

function charCodeSum(text) {
  let total = 0
  for (const char of String(text || '')) total += char.charCodeAt(0)
  return total
}

/**
 * 广西网络台当前直播使用的第二版负载加密。
 *
 * 它不是标准 HLS 的 EXT-X-KEY：TS 包、PAT/PMT 和 PES 头都保持明文，只对每个
 * PES 的 elementary-stream payload 做 AES-128-ECB，再交换若干等长块。因此普通
 * 播放器能识别出 H.264/AAC，却会在真正解码时报告大量损坏帧。
 */
export function decryptPayloadV2(payload, customId, contentId) {
  if (!Buffer.isBuffer(payload)) throw new TypeError('广西负载必须是 Buffer')
  if (!customId || !contentId || payload.length === 0) return false

  const key = createHash('md5').update(KEY_SALT + customId).digest()
  const blocks = Math.max((charCodeSum(customId) + charCodeSum(contentId)) % 32, 4)
  const blockLength = Math.trunc(payload.length / blocks)
  const encryptedOffset = Math.trunc(blockLength / 2)
  const encryptedLength = Math.trunc((payload.length - encryptedOffset - 1) / 16) * 16

  if (encryptedLength > 0) {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    decipher.setAutoPadding(false)
    const plain = Buffer.concat([
      decipher.update(payload.subarray(encryptedOffset, encryptedOffset + encryptedLength)),
      decipher.final(),
    ])
    plain.copy(payload, encryptedOffset)
  }

  // 官方编码器把末块塞到第二块位置；解码时把中间块整体后移，再还原末块。
  if (blockLength > 0) {
    const lastBlock = Buffer.from(payload.subarray((blocks - 1) * blockLength, blocks * blockLength))
    const middle = Buffer.from(payload.subarray(blockLength, (blocks - 1) * blockLength))
    middle.copy(payload, 2 * blockLength)
    lastBlock.copy(payload, blockLength)
  }
  return true
}

function encryptionMarker(pes) {
  if (pes.length < 25 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return null
  const flags = pes[7]
  if (!(flags & 0x01)) return null

  const ptsDtsFlags = flags >>> 6
  const extensionOffset = ptsDtsFlags === 2 ? 5
    : ptsDtsFlags === 3 ? 10
      : flags & 0x20 ? 6
        : flags & 0x10 ? 3
          : flags & 0x08 ? 1
            : flags & 0x04 ? 1
              : flags & 0x02 ? 2
                : 0

  const extensionFlagsAt = 9 + extensionOffset
  const markerAt = 19 + extensionOffset
  if (markerAt >= pes.length || !(pes[extensionFlagsAt] & 0x80)) return null
  const marker = pes[markerAt]
  return { algorithm: marker & 0x3f, audio: !!(marker & 0x80), video: !!(marker & 0x40) }
}

/**
 * 原地解密一整个 MPEG-TS 分片，返回实际处理的 PES 数量。
 *
 * 必须先按 PID 拼回完整 PES 再解密：AES 区间和块交换长度都是以完整 PES payload
 * 为基准，逐个 188 字节 TS 包处理会得到错误边界。
 */
export function decryptGxtvTs(input, customId, contentId) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const active = new Map()
  let decrypted = 0

  const flush = state => {
    if (!state?.slices?.length) return
    const pes = Buffer.concat(state.slices.map(({ start, end }) => buffer.subarray(start, end)))
    const marker = encryptionMarker(pes)
    const payloadAt = 9 + Number(pes[8] || 0)
    if (!marker || marker.algorithm !== 2 || payloadAt >= pes.length) return
    if (!decryptPayloadV2(pes.subarray(payloadAt), customId, contentId)) return

    let offset = 0
    for (const { start, end } of state.slices) {
      const length = end - start
      pes.copy(buffer, start, offset, offset + length)
      offset += length
    }
    decrypted++
  }

  for (let packetAt = 0; packetAt + TS_PACKET_SIZE <= buffer.length; packetAt += TS_PACKET_SIZE) {
    if (buffer[packetAt] !== 0x47) continue
    const payloadUnitStart = !!(buffer[packetAt + 1] & 0x40)
    const pid = ((buffer[packetAt + 1] & 0x1f) << 8) | buffer[packetAt + 2]
    const adaptationControl = (buffer[packetAt + 3] >>> 4) & 0x03
    if (adaptationControl === 0 || adaptationControl === 2) continue

    let payloadAt = packetAt + 4
    if (adaptationControl === 3) payloadAt += 1 + buffer[payloadAt]
    const packetEnd = packetAt + TS_PACKET_SIZE
    if (payloadAt >= packetEnd) continue

    if (payloadUnitStart) {
      flush(active.get(pid))
      active.delete(pid)
      if (payloadAt + 3 <= packetEnd
        && buffer[payloadAt] === 0
        && buffer[payloadAt + 1] === 0
        && buffer[payloadAt + 2] === 1) {
        active.set(pid, { slices: [{ start: payloadAt, end: packetEnd }] })
      }
    } else {
      active.get(pid)?.slices.push({ start: payloadAt, end: packetEnd })
    }
  }

  for (const state of active.values()) flush(state)
  return decrypted
}
