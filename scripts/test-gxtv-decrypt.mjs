#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'

import { decryptGxtvTs } from '../extractors/gxtv/decrypt.js'

const CUSTOM_ID = '1f892e84b6'
const CONTENT_ID = '9c4f3585a8444b9fa8a42d70c6dc493c'

function sumCodes(text) {
  return [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0)
}

// 生成官方 v2 解码过程的逆变换，只用于构造一个稳定、无网络依赖的回归样本。
function encryptPayloadV2(plain) {
  const encrypted = Buffer.from(plain)
  const blocks = Math.max((sumCodes(CUSTOM_ID) + sumCodes(CONTENT_ID)) % 32, 4)
  const blockLength = Math.trunc(encrypted.length / blocks)

  const beforeSwap = Buffer.from(encrypted)
  encrypted.subarray(2 * blockLength, blocks * blockLength).copy(beforeSwap, blockLength)
  encrypted.subarray(blockLength, 2 * blockLength).copy(beforeSwap, (blocks - 1) * blockLength)

  const offset = Math.trunc(blockLength / 2)
  const length = Math.trunc((beforeSwap.length - offset - 1) / 16) * 16
  const cipher = createCipheriv(
    'aes-128-ecb',
    createHash('md5').update('01234568' + CUSTOM_ID).digest(),
    null,
  )
  cipher.setAutoPadding(false)
  const ciphertext = Buffer.concat([cipher.update(beforeSwap.subarray(offset, offset + length)), cipher.final()])
  ciphertext.copy(beforeSwap, offset)
  return beforeSwap
}

function encryptedTsFixture() {
  const plain = Buffer.alloc(153)
  for (let i = 0; i < plain.length; i++) plain[i] = (i * 37 + 11) & 0xff

  const pes = Buffer.alloc(31 + plain.length)
  pes.set([0x00, 0x00, 0x01, 0xe0], 0)
  pes.writeUInt16BE(pes.length - 6, 4)
  pes[6] = 0x80
  pes[7] = 0x81
  pes[8] = 22
  pes[14] = 0x80
  pes[24] = 0xc2 // audio + video 标记，算法版本 2
  encryptPayloadV2(plain).copy(pes, 31)

  const ts = Buffer.alloc(188, 0xff)
  ts.set([0x47, 0x50, 0x11, 0x10], 0) // PUSI + PID 0x1011 + 仅 payload
  pes.copy(ts, 4)
  return { ts, plain }
}

const { ts, plain } = encryptedTsFixture()
assert.notDeepEqual(ts.subarray(35), plain)
assert.equal(decryptGxtvTs(ts, CUSTOM_ID, CONTENT_ID), 1)
assert.deepEqual(ts.subarray(35), plain)

const untouched = Buffer.from(ts)
assert.equal(decryptGxtvTs(untouched, '', ''), 0)
assert.deepEqual(untouched, ts)

console.log('广西 PES 解密回归测试：全部通过（2 项）')
