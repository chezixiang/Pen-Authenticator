// 纯 JS 二维码编码器 + PNG 渲染器（用于生成 Google Authenticator 转移二维码 otpauth-migration://）
//
// 参考 ydpen-toolkit (reference/07-miniapp-dev-toolchain.md §6)：
// 词典笔页面通过生成 PNG 并绑定到 <image src="file://..."> 显示图形（每次使用新文件名规避 URL 缓存）。

import { utf8, bytesToBase64 } from './bytes.js'

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Int16Array(256)
;(function initGf() {
    let x = 1
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x
        GF_LOG[x] = i
        x <<= 1
        if (x & 0x100) x ^= 0x11d
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

function gmul(a, b) {
    if (a === 0 || b === 0) return 0
    return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

// 与 qrdec.js 保持一致的版本纠错表：每行 L(ecPerBlock,blocks) M Q H
const EC_TABLE = [
    '7,1,10,1,13,1,17,1', '10,1,16,1,22,1,28,1', '15,1,26,1,18,2,22,2', '20,1,18,2,26,2,16,4',
    '26,1,24,2,18,4,22,4', '18,2,16,4,24,4,28,4', '20,2,18,4,18,6,26,5', '24,2,22,4,22,6,26,6',
    '30,2,22,5,20,8,24,8', '18,4,26,5,24,8,28,8', '20,4,30,5,28,8,24,11', '24,4,22,8,26,10,28,11',
    '26,4,22,9,24,12,22,16', '30,4,24,9,20,16,24,16', '22,6,24,10,30,12,24,18', '24,6,28,10,24,17,30,16',
    '28,6,28,11,28,16,28,19', '30,6,26,13,28,18,28,21', '28,7,26,14,26,21,26,25', '28,8,26,16,30,20,28,25',
    '28,8,26,17,28,23,30,25', '28,9,28,17,30,23,24,34', '30,9,28,18,30,25,30,30', '30,10,28,20,30,27,30,32',
    '26,12,28,21,30,29,30,35', '28,12,28,23,28,34,30,37', '30,12,28,25,30,34,30,40', '30,13,28,26,30,35,30,42',
    '30,14,28,28,30,38,30,45', '30,15,28,29,30,40,30,48', '30,16,28,31,30,43,30,51', '30,17,28,33,30,45,30,54',
    '30,18,28,35,30,48,30,57', '30,19,28,37,30,51,30,60', '30,19,28,38,30,53,30,63', '30,20,28,40,30,56,30,66',
    '30,21,28,43,30,59,30,70', '30,22,28,45,30,62,30,74', '30,24,28,47,30,65,30,77', '30,25,28,49,30,68,30,81'
]

const EC_INDEX_BY_NAME = { L: 0, M: 1, Q: 2, H: 3 }
// EC_TABLE 下标 (0=L,1=M,2=Q,3=H) → format info 2-bit 值 (01=L, 00=M, 11=Q, 10=H)
const FORMAT_BITS_BY_EC = [1, 0, 3, 2]

function ecBlocks(version, ecIndex) {
    const f = EC_TABLE[version - 1].split(',')
    return [Number(f[ecIndex * 2]), Number(f[ecIndex * 2 + 1])]
}

function rawDataModules(version) {
    let result = (16 * version + 128) * version + 64
    if (version >= 2) {
        const numAlign = Math.floor(version / 7) + 2
        result -= (25 * numAlign - 10) * numAlign - 55
        if (version >= 7) result -= 36
    }
    return result
}

function alignmentPositions(version) {
    if (version === 1) return []
    const numAlign = Math.floor(version / 7) + 2
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2
    const out = [6]
    let pos = version * 4 + 10
    while (out.length < numAlign) {
        out.splice(1, 0, pos)
        pos -= step
    }
    return out
}

const FORMAT_MASK = 0x5412
function formatBits(ecIndex, mask) {
    const data = (FORMAT_BITS_BY_EC[ecIndex] << 3) | (mask & 7)
    let d = data << 10
    for (let top = 14; top >= 10; top--) {
        if (d & (1 << top)) d ^= 0x537 << (top - 10)
    }
    return ((data << 10) | d) ^ FORMAT_MASK
}

function versionBits(version) {
    let d = version << 12
    for (let top = 17; top >= 12; top--) {
        if (d & (1 << top)) d ^= 0x1f25 << (top - 12)
    }
    return (version << 12) | d
}

function rsGeneratorPoly(degree) {
    let poly = new Uint8Array([1])
    for (let i = 0; i < degree; i++) {
        const next = new Uint8Array(poly.length + 1)
        const root = GF_EXP[i]
        for (let j = 0; j < poly.length; j++) {
            next[j] ^= poly[j]
            next[j + 1] ^= gmul(poly[j], root)
        }
        poly = next
    }
    return poly
}

function rsEncode(data, ecLen) {
    const gen = rsGeneratorPoly(ecLen)
    const rem = new Uint8Array(ecLen)
    for (let i = 0; i < data.length; i++) {
        const factor = data[i] ^ rem[0]
        for (let j = 0; j < ecLen - 1; j++) {
            rem[j] = rem[j + 1] ^ gmul(gen[j + 1], factor)
        }
        rem[ecLen - 1] = gmul(gen[ecLen], factor)
    }
    return rem
}

function maskBit(mask, row, col) {
    switch (mask) {
        case 0: return ((row + col) & 1) === 0
        case 1: return (row & 1) === 0
        case 2: return col % 3 === 0
        case 3: return (row + col) % 3 === 0
        case 4: return ((Math.floor(row / 2) + Math.floor(col / 3)) & 1) === 0
        case 5: return ((row * col) % 2 + (row * col) % 3) === 0
        case 6: return (((row * col) % 2 + (row * col) % 3) & 1) === 0
        default: return (((row + col) % 2 + (row * col) % 3) & 1) === 0
    }
}

function writeFormatModules(matrix, dim, ecIndex, mask) {
    const code = formatBits(ecIndex, mask)
    // 左上角 f1：bit 14..0 与 qrdec.js 的读取顺序严格对应
    const f1Coords = [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
        [8, 7], [8, 8], [7, 8],
        [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ]
    for (let i = 0; i < 15; i++) {
        const bit = (code >>> (14 - i)) & 1
        const [r, c] = f1Coords[i]
        matrix[r * dim + c] = bit
    }
    // 左下 + 右上 f2
    const f2Coords = []
    for (let j = dim - 1; j >= dim - 7; j--) f2Coords.push([j, 8])
    for (let i = dim - 8; i < dim; i++) f2Coords.push([8, i])
    for (let i = 0; i < 15; i++) {
        const bit = (code >>> (14 - i)) & 1
        const [r, c] = f2Coords[i]
        matrix[r * dim + c] = bit
    }
    // 固定暗模块
    matrix[(dim - 8) * dim + 8] = 1
}

function penaltyScore(matrix, dim) {
    let score = 0
    // 规则 1：同行/同列连续 5 个以上同色模块
    for (let r = 0; r < dim; r++) {
        let runColor = -1
        let runLen = 0
        for (let c = 0; c < dim; c++) {
            const v = matrix[r * dim + c]
            if (v === runColor) {
                runLen++
                if (runLen === 5) score += 3
                else if (runLen > 5) score += 1
            } else {
                runColor = v
                runLen = 1
            }
        }
    }
    for (let c = 0; c < dim; c++) {
        let runColor = -1
        let runLen = 0
        for (let r = 0; r < dim; r++) {
            const v = matrix[r * dim + c]
            if (v === runColor) {
                runLen++
                if (runLen === 5) score += 3
                else if (runLen > 5) score += 1
            } else {
                runColor = v
                runLen = 1
            }
        }
    }
    // 规则 2：2x2 同色块
    for (let r = 0; r < dim - 1; r++) {
        for (let c = 0; c < dim - 1; c++) {
            const v = matrix[r * dim + c]
            if (v === matrix[r * dim + c + 1] &&
                v === matrix[(r + 1) * dim + c] &&
                v === matrix[(r + 1) * dim + c + 1]) {
                score += 3
            }
        }
    }
    return score
}

/**
 * 将文本或字节编码为二维码模块矩阵
 * @param {string|Uint8Array} input
 * @param {'L'|'M'|'Q'|'H'} [ecLevel='M']
 * @returns {{ size: number, version: number, data: Uint8Array }}
 */
export function encodeQr(input, ecLevel = 'M') {
    const payload = input instanceof Uint8Array ? input : utf8(String(input || ''))
    const ecIndex = EC_INDEX_BY_NAME[String(ecLevel || 'M').toUpperCase()] !== undefined
        ? EC_INDEX_BY_NAME[String(ecLevel || 'M').toUpperCase()]
        : 1

    let version = 0
    let totalData = 0
    let ecPerBlock = 0
    let numBlocks = 0
    for (let v = 1; v <= 40; v++) {
        const countBits = v <= 9 ? 8 : 16
        const totalCw = rawDataModules(v) >> 3
        const [ecLen, blocks] = ecBlocks(v, ecIndex)
        const dataCw = totalCw - ecLen * blocks
        const neededBits = 4 + countBits + payload.length * 8
        if (dataCw * 8 >= neededBits) {
            version = v
            totalData = dataCw
            ecPerBlock = ecLen
            numBlocks = blocks
            break
        }
    }
    if (!version) throw new Error('二维码内容过长')

    // 1. 组装数据位流（Byte 模式 = 0100）
    const countBits = version <= 9 ? 8 : 16
    const bits = []
    const pushBits = (val, len) => {
        for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
    }
    pushBits(4, 4)
    pushBits(payload.length, countBits)
    for (let i = 0; i < payload.length; i++) pushBits(payload[i], 8)

    const maxBits = totalData * 8
    for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0)
    while (bits.length & 7) bits.push(0)

    const dataBytes = new Uint8Array(totalData)
    const filledBytes = bits.length >> 3
    for (let i = 0; i < filledBytes; i++) {
        let b = 0
        for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k]
        dataBytes[i] = b
    }
    for (let i = filledBytes; i < totalData; i++) {
        dataBytes[i] = ((i - filledBytes) & 1) === 0 ? 0xec : 0x11
    }

    // 2. 分块与 RS 纠错码生成
    const shortLen = Math.floor(totalData / numBlocks)
    const numLong = totalData % numBlocks
    const dataBlocks = []
    const ecBlocksList = []
    let off = 0
    for (let i = 0; i < numBlocks; i++) {
        const dLen = shortLen + (i >= numBlocks - numLong ? 1 : 0)
        const dBlock = dataBytes.subarray(off, off + dLen)
        off += dLen
        dataBlocks.push(dBlock)
        ecBlocksList.push(rsEncode(dBlock, ecPerBlock))
    }

    const codewords = []
    const maxDataLen = shortLen + (numLong ? 1 : 0)
    for (let j = 0; j < maxDataLen; j++) {
        for (let i = 0; i < numBlocks; i++) {
            if (j < dataBlocks[i].length) codewords.push(dataBlocks[i][j])
        }
    }
    for (let j = 0; j < ecPerBlock; j++) {
        for (let i = 0; i < numBlocks; i++) {
            codewords.push(ecBlocksList[i][j])
        }
    }

    // 3. 绘制功能图案并标记掩码禁区
    const dim = 17 + 4 * version
    const baseMatrix = new Uint8Array(dim * dim)
    const fnMask = new Uint8Array(dim * dim)

    const setFn = (x, y, dark) => {
        if (x < 0 || x >= dim || y < 0 || y >= dim) return
        fnMask[y * dim + x] = 1
        baseMatrix[y * dim + x] = dark ? 1 : 0
    }

    const drawFinder = (x0, y0) => {
        for (let dy = -1; dy <= 7; dy++) {
            for (let dx = -1; dx <= 7; dx++) {
                const x = x0 + dx
                const y = y0 + dy
                if (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6) {
                    const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
                    setFn(x, y, ring !== 2)
                } else {
                    setFn(x, y, false)
                }
            }
        }
    }

    drawFinder(0, 0)
    drawFinder(dim - 7, 0)
    drawFinder(0, dim - 7)

    // 定时线
    for (let i = 8; i < dim - 8; i++) {
        setFn(i, 6, (i & 1) === 0)
        setFn(6, i, (i & 1) === 0)
    }

    // 对齐图案
    const align = alignmentPositions(version)
    const last = align.length - 1
    for (let i = 0; i <= last; i++) {
        for (let j = 0; j <= last; j++) {
            const cx = align[j]
            const cy = align[i]
            if ((cx === 6 && cy === 6) || (cx === 6 && cy === align[last]) || (cy === 6 && cx === align[last])) {
                continue
            }
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const ring = Math.max(Math.abs(dx), Math.abs(dy))
                    setFn(cx + dx, cy + dy, ring === 0 || ring === 2)
                }
            }
        }
    }

    // 预留 format info 区域
    for (let i = 0; i < 9; i++) {
        fnMask[8 * dim + i] = 1
        fnMask[i * dim + 8] = 1
    }
    for (let i = 0; i < 8; i++) {
        fnMask[8 * dim + (dim - 1 - i)] = 1
        fnMask[(dim - 1 - i) * dim + 8] = 1
    }

    // 版本信息（version >= 7）
    if (version >= 7) {
        const vCode = versionBits(version)
        let bitIdx = 0
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 3; j++) {
                const bit = (vCode >>> bitIdx++) & 1
                setFn(dim - 11 + j, i, bit === 1)
                setFn(i, dim - 11 + j, bit === 1)
            }
        }
    }

    // 4. 填充数据与纠错码字
    let bitPos = 0
    const totalBits = codewords.length * 8
    let readingUp = true
    for (let col = dim - 1; col > 0; col -= 2) {
        if (col === 6) col--
        for (let i = 0; i < dim; i++) {
            const row = readingUp ? dim - 1 - i : i
            for (let c = 0; c < 2; c++) {
                const x = col - c
                if (fnMask[row * dim + x]) continue
                let v = 0
                if (bitPos < totalBits) {
                    v = (codewords[bitPos >> 3] >>> (7 - (bitPos & 7))) & 1
                    bitPos++
                }
                baseMatrix[row * dim + x] = v
            }
        }
        readingUp = !readingUp
    }

    // 5. 选择惩罚分最低的掩码（0..7）
    let bestMatrix = null
    let bestScore = 0x7fffffff
    let bestMask = 0
    for (let mask = 0; mask < 8; mask++) {
        const candidate = baseMatrix.slice()
        for (let r = 0; r < dim; r++) {
            for (let c = 0; c < dim; c++) {
                if (!fnMask[r * dim + c] && maskBit(mask, r, c)) {
                    candidate[r * dim + c] ^= 1
                }
            }
        }
        writeFormatModules(candidate, dim, ecIndex, mask)
        const s = penaltyScore(candidate, dim)
        if (s < bestScore) {
            bestScore = s
            bestMatrix = candidate
            bestMask = mask
        }
    }

    return {
        size: dim,
        version,
        mask: bestMask,
        data: bestMatrix
    }
}

// ---------- 纯 JS 1-bit PNG 编码器（无依赖，几毫秒生成） ----------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
        }
        t[n] = c >>> 0
    }
    return t
})()

function crc32(bytes, start, end) {
    let c = 0xffffffff
    for (let i = start; i < end; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes) {
    let s1 = 1
    let s2 = 0
    const len = bytes.length
    let i = 0
    while (i < len) {
        const end = Math.min(i + 5552, len)
        while (i < end) {
            s1 += bytes[i++]
            s2 += s1
        }
        s1 %= 65521
        s2 %= 65521
    }
    return ((s2 << 16) | s1) >>> 0
}

function writeU32BE(out, v) {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
}

function writeChunk(out, typeStr, payload) {
    writeU32BE(out, payload.length)
    const crcStart = out.length
    for (let i = 0; i < 4; i++) out.push(typeStr.charCodeAt(i) & 0xff)
    for (let i = 0; i < payload.length; i++) out.push(payload[i])
    const crc = crc32(out, crcStart, out.length)
    writeU32BE(out, crc)
}

/**
 * 将二维码模块矩阵渲染为 1-bit 黑白 PNG 字节流
 * @param {{ size: number, data: Uint8Array }} matrix
 * @param {{ scale?: number, quiet?: number, targetSize?: number }} [opts]
 * @returns {Uint8Array}
 */
export function matrixToPngBytes(matrix, opts = {}) {
    const quiet = opts.quiet !== undefined ? opts.quiet : 4
    const totalModules = matrix.size + quiet * 2
    const scale = opts.scale || Math.max(2, Math.floor((opts.targetSize || 200) / totalModules))
    const width = totalModules * scale
    const height = width
    const rowBytes = (width + 7) >> 3
    const stride = 1 + rowBytes
    const raw = new Uint8Array(height * stride)

    // 1-bit Grayscale PNG: 1 = 白，0 = 黑
    for (let y = 0; y < height; y++) {
        const rowOff = y * stride
        raw[rowOff] = 0 // Filter: None
        const my = Math.floor(y / scale) - quiet
        for (let x = 0; x < width; x++) {
            const mx = Math.floor(x / scale) - quiet
            const dark = (mx >= 0 && mx < matrix.size && my >= 0 && my < matrix.size)
                ? matrix.data[my * matrix.size + mx]
                : 0
            if (!dark) {
                raw[rowOff + 1 + (x >> 3)] |= 1 << (7 - (x & 7))
            }
        }
    }

    // 组装 zlib 无压缩块 (BTYPE=00)
    const z = [0x78, 0x01]
    let pos = 0
    while (pos < raw.length) {
        const chunkLen = Math.min(65535, raw.length - pos)
        const isLast = (pos + chunkLen) >= raw.length ? 1 : 0
        z.push(isLast)
        z.push(chunkLen & 0xff, (chunkLen >>> 8) & 0xff)
        const nlen = (~chunkLen) & 0xffff
        z.push(nlen & 0xff, (nlen >>> 8) & 0xff)
        for (let i = 0; i < chunkLen; i++) z.push(raw[pos + i])
        pos += chunkLen
    }
    writeU32BE(z, adler32(raw))

    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const ihdr = []
    writeU32BE(ihdr, width)
    writeU32BE(ihdr, height)
    ihdr.push(1, 0, 0, 0, 0) // bit_depth=1, color_type=0 (grayscale)
    writeChunk(png, 'IHDR', ihdr)
    writeChunk(png, 'IDAT', z)
    writeChunk(png, 'IEND', [])
    return new Uint8Array(png)
}

/**
 * 将文本编码为二维码 PNG 的 Base64 字符串
 */
export function qrToPngBase64(text, opts = {}) {
    const matrix = encodeQr(text, opts.ecLevel || 'M')
    const png = matrixToPngBytes(matrix, opts)
    return bytesToBase64(png)
}
