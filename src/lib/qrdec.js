// 二维码解码（面向 QuickJS 的 1-bit 输入实现）
//
// 为什么不用 jsQR：真机实测（X7P / QuickJS）jsQR 约 15µs/像素，
// 224x144 就要 500ms，主线程直接被看门狗记成 "Msg process take too many time"。
// 这里改成吃「1-bit 位图」：定位 finder → 仿射采样 → format info → RS 纠错 → 解析，
// 224x224 全流程约 20-40ms，可以在 5fps 的解码通道上跑而不影响 24fps 预览。
//
// 输入约定：{ data, width, height, stride, dark }，data 按行打包（MSB 在前），
// dark 表示「黑」对应的位值（ffmpeg monow 输出为 1）。

// ---------- GF(256)，本原多项式 0x11D ----------
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

function ginv(a) {
    return GF_EXP[255 - GF_LOG[a]]
}

// ---------- 版本相关常量 ----------
// 每行 8 个数：L(ecPerBlock,blocks) M Q H
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

const EC_LEVELS = ['L', 'M', 'Q', 'H']
// format info 的 2 bit → EC_TABLE 下标（01=L 00=M 11=Q 10=H）
const EC_BY_FORMAT_BITS = [1, 0, 3, 2]

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

// ---------- format info ----------
const FORMAT_MASK = 0x5412
const FORMAT_CODES = (() => {
    const out = []
    for (let data = 0; data < 32; data++) {
        let d = data << 10
        let top = 14
        while (top >= 10) {
            if (d & (1 << top)) d ^= 0x537 << (top - 10)
            top--
        }
        out.push(((data << 10) | d) ^ FORMAT_MASK)
    }
    return out
})()

function popcount15(v) {
    let c = 0
    for (let i = 0; i < 15; i++) if (v & (1 << i)) c++
    return c
}

/** @returns {{ecIndex:number,mask:number,distance:number}|null} */
function decodeFormat(bits) {
    let best = -1
    let bestDist = 99
    for (let i = 0; i < 32; i++) {
        const d = popcount15((bits ^ FORMAT_CODES[i]) & 0x7fff)
        if (d < bestDist) {
            bestDist = d
            best = i
        }
    }
    if (bestDist > 3) return null
    return { ecIndex: EC_BY_FORMAT_BITS[best >> 3], mask: best & 7, distance: bestDist }
}

// ---------- 位图访问 ----------
function makeBitReader(img) {
    const data = img.data
    const stride = img.stride
    const dark = img.dark === undefined ? 1 : img.dark
    return function bit(x, y) {
        const b = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1
        return b === dark ? 1 : 0
    }
}

// ---------- finder 定位 ----------
function isFinderRatio(c0, c1, c2, c3, c4) {
    const total = c0 + c1 + c2 + c3 + c4
    if (total < 7) return false
    const m = total / 7
    const t1 = m * 0.55
    const t3 = m * 1.7
    return Math.abs(c0 - m) < t1 && Math.abs(c1 - m) < t1 && Math.abs(c2 - 3 * m) < t3 &&
        Math.abs(c3 - m) < t1 && Math.abs(c4 - m) < t1
}

/**
 * 沿竖直方向在 (cx, cy) 处交叉校验 1:1:3:1:1，返回中心 y（失败 -1）。
 * 计数顺序与 zxing 一致：c2 是中间那条 3 倍黑，c1/c3 是白，c0/c4 是外侧黑。
 */
function crossCheckVertical(bit, cx, cy, maxCount, h) {
    let y = cy
    let c2 = 0
    while (y >= 0 && bit(cx, y)) { c2++; y-- }
    if (y < 0 || c2 === 0) return -1
    let c1 = 0
    while (y >= 0 && !bit(cx, y) && c1 <= maxCount) { c1++; y-- }
    if (y < 0 || c1 > maxCount || c1 === 0) return -1
    let c0 = 0
    while (y >= 0 && bit(cx, y) && c0 <= maxCount) { c0++; y-- }
    if (c0 === 0 || c0 > maxCount) return -1
    y = cy + 1
    while (y < h && bit(cx, y)) { c2++; y++ }
    if (y >= h) return -1
    let c3 = 0
    while (y < h && !bit(cx, y) && c3 <= maxCount) { c3++; y++ }
    if (y >= h || c3 === 0 || c3 > maxCount) return -1
    let c4 = 0
    while (y < h && bit(cx, y) && c4 <= maxCount) { c4++; y++ }
    if (c4 === 0 || c4 > maxCount) return -1
    if (!isFinderRatio(c0, c1, c2, c3, c4)) return -1
    return y - c4 - c3 - c2 / 2
}

/** 水平方向交叉校验，返回中心 x（失败 -1） */
function crossCheckHorizontal(bit, cx, cy, maxCount, w) {
    let x = cx
    let c2 = 0
    while (x >= 0 && bit(x, cy)) { c2++; x-- }
    if (x < 0 || c2 === 0) return -1
    let c1 = 0
    while (x >= 0 && !bit(x, cy) && c1 <= maxCount) { c1++; x-- }
    if (x < 0 || c1 > maxCount || c1 === 0) return -1
    let c0 = 0
    while (x >= 0 && bit(x, cy) && c0 <= maxCount) { c0++; x-- }
    if (c0 === 0 || c0 > maxCount) return -1
    x = cx + 1
    while (x < w && bit(x, cy)) { c2++; x++ }
    if (x >= w) return -1
    let c3 = 0
    while (x < w && !bit(x, cy) && c3 <= maxCount) { c3++; x++ }
    if (x >= w || c3 === 0 || c3 > maxCount) return -1
    let c4 = 0
    while (x < w && bit(x, cy) && c4 <= maxCount) { c4++; x++ }
    if (c4 === 0 || c4 > maxCount) return -1
    if (!isFinderRatio(c0, c1, c2, c3, c4)) return -1
    return x - c4 - c3 - c2 / 2
}

function addCandidate(list, x, y, module) {
    for (let i = 0; i < list.length; i++) {
        const c = list[i]
        if (Math.abs(c[0] - x) <= module * 2 && Math.abs(c[1] - y) <= module * 2) {
            c[0] = (c[0] * c[3] + x) / (c[3] + 1)
            c[1] = (c[1] * c[3] + y) / (c[3] + 1)
            c[2] = (c[2] * c[3] + module) / (c[3] + 1)
            c[3]++
            return
        }
    }
    list.push([x, y, module, 1])
}

function checkFinderRuns(list, rl, rc, idx, x, y, bit, w, h) {
    // 最近 5 段：B W B W B，第 5 段刚在 x 处结束
    const i0 = (idx - 5) % 5
    const i1 = (idx - 4) % 5
    const i2 = (idx - 3) % 5
    const i3 = (idx - 2) % 5
    const i4 = (idx - 1) % 5
    if (!(rc[i0] === 1 && rc[i1] === 0 && rc[i2] === 1 && rc[i3] === 0 && rc[i4] === 1)) return
    if (!isFinderRatio(rl[i0], rl[i1], rl[i2], rl[i3], rl[i4])) return
    const module = (rl[i0] + rl[i1] + rl[i2] + rl[i3] + rl[i4]) / 7
    const cx0 = Math.round(x - rl[i4] - rl[i3] - rl[i2] / 2)
    if (cx0 < 0 || cx0 >= w) return
    const maxCount = Math.round(module * 3)
    const cy = crossCheckVertical(bit, cx0, y, maxCount, h)
    if (cy < 0) return
    const cx = crossCheckHorizontal(bit, cx0, Math.round(cy), maxCount, w)
    if (cx >= 0) addCandidate(list, cx, cy, module)
}

/**
 * 行扫描找 finder。
 * 内层按字节解包（一次 8 个像素），比逐像素调用闭包快 3-4 倍：
 * 288x288 的图从 ~40ms 降到 ~12ms，解码通道才敢跑 5fps。
 */
function findFinderCenters(bit, data, stride, w, h, inv) {
    const list = []
    const rl = [0, 0, 0, 0, 0]
    const rc = [0, 0, 0, 0, 0]

    for (let y = 0; y < h; y += 2) {
        const base = y * stride
        let prev = -1
        let len = 0
        let idx = 0
        let x = 0
        for (let bi = 0; bi < stride; bi++) {
            const b = data[base + bi]
            for (let k = 7; k >= 0; k--, x++) {
                const v = ((b >> k) & 1) ^ inv
                if (v === prev) {
                    len++
                    continue
                }
                if (prev >= 0) {
                    rl[idx % 5] = len
                    rc[idx % 5] = prev
                    idx++
                    if (idx >= 5) checkFinderRuns(list, rl, rc, idx, x, y, bit, w, h)
                }
                prev = v
                len = 1
            }
        }
        if (prev >= 0) {
            rl[idx % 5] = len
            rc[idx % 5] = prev
            idx++
            if (idx >= 5) checkFinderRuns(list, rl, rc, idx, x, y, bit, w, h)
        }
    }

    const res = []
    for (let i = 0; i < list.length; i++) {
        if (list[i][3] >= 2) res.push({ x: list[i][0], y: list[i][1], module: list[i][2], count: list[i][3] })
    }
    res.sort((a, b) => b.count - a.count)
    return res
}

// ---------- 采样 ----------
function affineParams(tl, tr, bl, dim) {
    const span = dim - 7
    const a = (tr.x - tl.x) / span
    const b = (bl.x - tl.x) / span
    const c = tl.x - a * 3.5 - b * 3.5
    const d = (tr.y - tl.y) / span
    const e = (bl.y - tl.y) / span
    const f = tl.y - d * 3.5 - e * 3.5
    return { a: a, b: b, c: c, d: d, e: e, f: f }
}

function sampleMatrix(bit, tl, tr, bl, dim, imgW, imgH) {
    const m = affineParams(tl, tr, bl, dim)
    const out = new Uint8Array(dim * dim)
    let k = 0
    for (let row = 0; row < dim; row++) {
        const v = row + 0.5
        const bx = m.b * v + m.c
        const by = m.e * v + m.f
        for (let col = 0; col < dim; col++) {
            const u = col + 0.5
            const x = (m.a * u + bx + 0.5) | 0
            const y = (m.d * u + by + 0.5) | 0
            out[k++] = (x >= 0 && x < imgW && y >= 0 && y < imgH) ? bit(x, y) : 0
        }
    }
    return out
}

/** 4 点单应：模块坐标 → 图像坐标。返回 [h0..h7] */
function solveHomography(us, vs, xs, ys) {
    // 未知量 h0..h7：x = (h0 u + h1 v + h2)/(h6 u + h7 v + 1)
    const A = []
    for (let i = 0; i < 4; i++) {
        const u = us[i]
        const v = vs[i]
        const x = xs[i]
        const y = ys[i]
        A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x])
        A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y])
    }
    for (let c = 0; c < 8; c++) {
        let piv = c
        for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
        if (Math.abs(A[piv][c]) < 1e-9) return null
        const t = A[c]; A[c] = A[piv]; A[piv] = t
        const div = A[c][c]
        for (let k = c; k < 9; k++) A[c][k] /= div
        for (let r = 0; r < 8; r++) {
            if (r === c) continue
            const fac = A[r][c]
            if (!fac) continue
            for (let k = c; k < 9; k++) A[r][k] -= fac * A[c][k]
        }
    }
    return [A[0][8], A[1][8], A[2][8], A[3][8], A[4][8], A[5][8], A[6][8], A[7][8]]
}

function sampleMatrixH(bit, H, dim, imgW, imgH) {
    const out = new Uint8Array(dim * dim)
    let k = 0
    for (let row = 0; row < dim; row++) {
        const v = row + 0.5
        for (let col = 0; col < dim; col++) {
            const u = col + 0.5
            const den = H[6] * u + H[7] * v + 1
            const x = (H[0] * u + H[1] * v + H[2]) / den
            const y = (H[3] * u + H[4] * v + H[5]) / den
            const xi = (x + 0.5) | 0
            const yi = (y + 0.5) | 0
            out[k++] = (xi >= 0 && xi < imgW && yi >= 0 && yi < imgH) ? bit(xi, yi) : 0
        }
    }
    return out
}

/** 对齐图案（5x5）评分，返回 0..25 */
function scoreAlign(bit, cx, cy, ux, uy, vx, vy, w, h) {
    let score = 0
    for (let dv = -2; dv <= 2; dv++) {
        for (let du = -2; du <= 2; du++) {
            const x = (cx + du * ux + dv * vx + 0.5) | 0
            const y = (cy + du * uy + dv * vy + 0.5) | 0
            if (x < 0 || x >= w || y < 0 || y >= h) continue
            const ring = Math.max(Math.abs(du), Math.abs(dv))
            const expectDark = (ring === 0 || ring === 2) ? 1 : 0
            if (bit(x, y) === expectDark) score++
        }
    }
    return score
}

/**
 * 在仿射预测位置附近找对齐图案，返回图像坐标 {x,y} 或 null。
 * 有了第 4 个点就能解单应，透视/大版本下比仿射稳得多。
 */
function findAlignment(bit, m, dim, w, h) {
    const u0 = dim - 6.5
    const v0 = dim - 6.5
    const px = m.a * u0 + m.b * v0 + m.c
    const py = m.d * u0 + m.e * v0 + m.f
    let best = null
    let bestScore = 0
    for (let iu = -1.5; iu <= 1.5001; iu += 0.5) {
        for (let iv = -1.5; iv <= 1.5001; iv += 0.5) {
            const cx = px + iu * m.a + iv * m.b
            const cy = py + iu * m.d + iv * m.e
            const s = scoreAlign(bit, cx, cy, m.a, m.d, m.b, m.e, w, h)
            if (s > bestScore) {
                bestScore = s
                best = { x: cx, y: cy }
            }
        }
    }
    return bestScore >= 22 ? best : null
}

// ---------- 功能图形 ----------
function functionPattern(version, dim) {
    const m = new Uint8Array(dim * dim)
    const mark = (x0, y0, w, h) => {
        for (let y = y0; y < y0 + h; y++) {
            if (y < 0 || y >= dim) continue
            const base = y * dim
            for (let x = x0; x < x0 + w; x++) {
                if (x < 0 || x >= dim) continue
                m[base + x] = 1
            }
        }
    }
    mark(0, 0, 9, 9)
    mark(dim - 8, 0, 8, 9)
    mark(0, dim - 8, 9, 8)
    mark(6, 9, 1, dim - 17)
    mark(9, 6, dim - 17, 1)
    const align = alignmentPositions(version)
    const last = align.length - 1
    for (let i = 0; i <= last; i++) {
        for (let j = 0; j <= last; j++) {
            const x = align[j]
            const y = align[i]
            if ((x === 6 && y === 6) || (x === 6 && y === align[last]) || (y === 6 && x === align[last])) continue
            mark(x - 2, y - 2, 5, 5)
        }
    }
    if (version >= 7) {
        mark(dim - 11, 0, 3, 6)
        mark(0, dim - 11, 6, 3)
    }
    return m
}

// ---------- 掩码 ----------
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

function readCodewords(matrix, dim, version, mask) {
    const fn = functionPattern(version, dim)
    const bytes = []
    let cur = 0
    let bits = 0
    let readingUp = true
    for (let col = dim - 1; col > 0; col -= 2) {
        if (col === 6) col--
        for (let i = 0; i < dim; i++) {
            const row = readingUp ? dim - 1 - i : i
            for (let c = 0; c < 2; c++) {
                const x = col - c
                if (fn[row * dim + x]) continue
                let v = matrix[row * dim + x]
                if (maskBit(mask, row, x)) v ^= 1
                cur = (cur << 1) | v
                bits++
                if (bits === 8) {
                    bytes.push(cur)
                    cur = 0
                    bits = 0
                }
            }
        }
        readingUp = !readingUp
    }
    return bytes
}

// ---------- Reed-Solomon 纠错 ----------
function polyEval(coef, n, x) {
    let r = 0
    for (let i = 0; i < n; i++) r = gmul(r, x) ^ coef[i]
    return r
}

function gpow(x, p) {
    if (p === 0) return 1
    if (x === 0) return 0
    return GF_EXP[(GF_LOG[x] * p) % 255]
}

/** 纠正单个块；失败返回 null */
function rsCorrect(block, ecLen) {
    const n = block.length
    const synd = new Uint8Array(ecLen)
    let hasError = false
    for (let i = 0; i < ecLen; i++) {
        const s = polyEval(block, n, GF_EXP[i])
        synd[i] = s
        if (s !== 0) hasError = true
    }
    if (!hasError) return block

    // Berlekamp-Massey
    const C = new Uint8Array(ecLen + 1)
    const B = new Uint8Array(ecLen + 1)
    C[0] = 1
    B[0] = 1
    let L = 0
    let m = 1
    let b = 1
    for (let k = 0; k < ecLen; k++) {
        let d = synd[k]
        for (let i = 1; i <= L; i++) d ^= gmul(C[i], synd[k - i])
        if (d === 0) {
            m++
            continue
        }
        const coef = gmul(d, ginv(b))
        const T = C.slice()
        for (let i = 0; i + m <= ecLen; i++) C[i + m] ^= gmul(coef, B[i])
        if (2 * L <= k) {
            L = k + 1 - L
            B.set(T)
            b = d
            m = 1
        } else {
            m++
        }
    }
    if (L === 0 || L * 2 > ecLen) return null

    // Chien search
    const errDeg = []
    for (let t = 0; t < n; t++) {
        const x = GF_EXP[(255 - (t % 255)) % 255]
        let v = 0
        for (let i = L; i >= 0; i--) v = gmul(v, x) ^ C[i]
        if (v === 0) errDeg.push(t)
    }
    if (errDeg.length !== L) return null

    // Ω(x) = S(x)C(x) mod x^ec
    const omega = new Uint8Array(ecLen)
    for (let i = 0; i < ecLen; i++) {
        let v = 0
        for (let j = 0; j <= i && j <= L; j++) v ^= gmul(synd[i - j], C[j])
        omega[i] = v
    }

    const out = block.slice()
    for (let i = 0; i < errDeg.length; i++) {
        const t = errDeg[i]
        const idx = n - 1 - t
        const X = GF_EXP[t % 255]
        const Xinv = ginv(X)
        let om = 0
        for (let j = ecLen - 1; j >= 0; j--) om = gmul(om, Xinv) ^ omega[j]
        let dl = 0
        for (let j = 1; j <= L; j += 2) dl ^= gmul(C[j], gpow(Xinv, j - 1))
        if (dl === 0) return null
        const e = gmul(gmul(X, om), ginv(dl))
        out[idx] ^= e
    }
    for (let i = 0; i < ecLen; i++) {
        if (polyEval(out, n, GF_EXP[i]) !== 0) return null
    }
    return out
}

// ---------- 数据段解析 ----------
function utf8Decode(bytes, start, end) {
    let out = ''
    let i = start
    while (i < end) {
        const b = bytes[i++]
        if (b < 0x80) out += String.fromCharCode(b)
        else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f))
        else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f))
        else {
            const cp = ((b & 7) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
            const v = cp - 0x10000
            out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
        }
    }
    return out
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

function parseData(bytes, version) {
    let bitPos = 0
    const total = bytes.length * 8
    const readBits = (cnt) => {
        let v = 0
        for (let i = 0; i < cnt; i++) {
            if (bitPos >= total) return -1
            const b = (bytes[bitPos >> 3] >> (7 - (bitPos & 7))) & 1
            v = (v << 1) | b
            bitPos++
        }
        return v
    }
    const countBits = (mode) => {
        const idx = version <= 9 ? 0 : version <= 26 ? 1 : 2
        if (mode === 1) return [10, 12, 14][idx]
        if (mode === 2) return [9, 11, 13][idx]
        if (mode === 4) return [8, 16, 16][idx]
        if (mode === 8) return [8, 10, 12][idx]
        return 0
    }
    let out = ''
    while (bitPos + 4 <= total) {
        const mode = readBits(4)
        if (mode <= 0) break
        if (mode === 7) {
            const first = readBits(8)
            if (first < 0) break
            if ((first & 0x80) === 0) continue
            if ((first & 0xc0) === 0x80) { readBits(8); continue }
            if ((first & 0xe0) === 0xc0) { readBits(16); continue }
            break
        }
        const cnt = readBits(countBits(mode))
        if (cnt < 0) break
        if (mode === 1) {
            let i = 0
            while (i + 3 <= cnt) {
                const v = readBits(10)
                if (v < 0) return out
                out += ('00' + v).slice(-3)
                i += 3
            }
            if (cnt - i === 2) {
                const v = readBits(7)
                if (v < 0) return out
                out += ('0' + v).slice(-2)
            } else if (cnt - i === 1) {
                const v = readBits(4)
                if (v < 0) return out
                out += String(v)
            }
        } else if (mode === 2) {
            let i = 0
            while (i + 2 <= cnt) {
                const v = readBits(11)
                if (v < 0) return out
                out += ALNUM.charAt(Math.floor(v / 45)) + ALNUM.charAt(v % 45)
                i += 2
            }
            if (cnt - i === 1) {
                const v = readBits(6)
                if (v < 0) return out
                out += ALNUM.charAt(v)
            }
        } else if (mode === 4) {
            // 注意：byte 段起点不保证字节对齐（4bit mode + 8/16bit 长度），必须逐字节读位
            const buf = new Uint8Array(cnt)
            for (let i = 0; i < cnt; i++) {
                const v = readBits(8)
                if (v < 0) { out += utf8Decode(buf, 0, i); return out }
                buf[i] = v
            }
            out += utf8Decode(buf, 0, cnt)
        } else if (mode === 8) {
            for (let i = 0; i < cnt; i++) {
                const v = readBits(13)
                if (v < 0) return out
                const sjis = Math.floor(v / 0xc0) * 0x100 + (v % 0xc0)
                out += String.fromCharCode(sjis)
            }
        } else {
            break
        }
    }
    return out
}

// ---------- 单次尝试 ----------
function tryMatrix(matrix, dim) {
    const version = Math.floor((dim - 17) / 4)
    if (version < 1 || version > 40) return null

    // format info：先读左上，再读左下+右上
    let f1 = 0
    for (let i = 0; i < 6; i++) f1 = (f1 << 1) | matrix[8 * dim + i]
    f1 = (f1 << 1) | matrix[8 * dim + 7]
    f1 = (f1 << 1) | matrix[8 * dim + 8]
    f1 = (f1 << 1) | matrix[7 * dim + 8]
    for (let j = 5; j >= 0; j--) f1 = (f1 << 1) | matrix[j * dim + 8]
    let fmt = decodeFormat(f1)
    if (!fmt) {
        let f2 = 0
        for (let j = dim - 1; j >= dim - 7; j--) f2 = (f2 << 1) | matrix[j * dim + 8]
        for (let i = dim - 8; i < dim; i++) f2 = (f2 << 1) | matrix[8 * dim + i]
        fmt = decodeFormat(f2)
    }
    if (!fmt) return null

    const codewords = readCodewords(matrix, dim, version, fmt.mask)
    const total = rawDataModules(version) >> 3
    if (codewords.length < total) return null

    const pair = ecBlocks(version, fmt.ecIndex)
    const ecPerBlock = pair[0]
    const numBlocks = pair[1]
    const totalEc = ecPerBlock * numBlocks
    const totalData = total - totalEc
    if (totalData <= 0 || numBlocks <= 0) return null

    const shortLen = Math.floor(totalData / numBlocks)
    const numLong = totalData % numBlocks
    const dataLens = []
    for (let i = 0; i < numBlocks; i++) dataLens.push(shortLen + (i >= numBlocks - numLong ? 1 : 0))

    const blocks = []
    for (let i = 0; i < numBlocks; i++) blocks.push(new Uint8Array(dataLens[i] + ecPerBlock))
    let off = 0
    const maxData = shortLen + (numLong ? 1 : 0)
    for (let j = 0; j < maxData; j++) {
        for (let i = 0; i < numBlocks; i++) {
            if (j < dataLens[i]) blocks[i][j] = codewords[off++]
        }
    }
    for (let j = 0; j < ecPerBlock; j++) {
        for (let i = 0; i < numBlocks; i++) {
            blocks[i][dataLens[i] + j] = codewords[off++]
        }
    }

    const data = []
    for (let i = 0; i < numBlocks; i++) {
        const fixed = rsCorrect(blocks[i], ecPerBlock)
        if (!fixed) return null
        for (let j = 0; j < dataLens[i]; j++) data.push(fixed[j])
    }
    const text = parseData(data, version)
    if (!text) return null
    return { text: text, version: version, ec: EC_LEVELS[fmt.ecIndex], mask: fmt.mask }
}

function dist(a, b) {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return Math.sqrt(dx * dx + dy * dy)
}

function tryTriple(bit, p1, p2, p3, w, h) {
    const d01 = dist(p1, p2)
    const d02 = dist(p1, p3)
    const d12 = dist(p2, p3)
    let tl, q1, q2
    if (d12 >= d01 && d12 >= d02) { tl = p1; q1 = p2; q2 = p3 }
    else if (d02 >= d01 && d02 >= d12) { tl = p2; q1 = p1; q2 = p3 }
    else { tl = p3; q1 = p1; q2 = p2 }

    const cross = (q1.x - tl.x) * (q2.y - tl.y) - (q1.y - tl.y) * (q2.x - tl.x)
    if (Math.abs(cross) < 1) return null
    const tr = cross > 0 ? q1 : q2
    const bl = cross > 0 ? q2 : q1

    const module = (tl.module + tr.module + bl.module) / 3
    if (module < 1) return null
    // 三个 finder 的模块尺寸必须接近，能挡掉大部分「乱凑成三角形」的误报
    const mMin = Math.min(tl.module, tr.module, bl.module)
    const mMax = Math.max(tl.module, tr.module, bl.module)
    if (mMax > mMin * 1.5) return null
    const spanH = dist(tl, tr)
    const spanV = dist(tl, bl)
    if (spanH < module * 10 || spanV < module * 10) return null
    if (spanV > spanH * 1.6 || spanH > spanV * 1.6) return null

    const est = ((spanH + spanV) / 2) / module + 7
    const vEst = Math.round((est - 17) / 4)
    const counts = tl.count + tr.count + bl.count

    let best = null
    for (let dv = 0; dv <= 1; dv++) {
        const deltas = dv === 0 ? [0, -1, 1] : [-2, 2]
        for (let k = 0; k < deltas.length; k++) {
            const v = vEst + deltas[k]
            if (v < 1 || v > 40) continue
            const dim = 17 + 4 * v
            // 先仿射（快），失败再上对齐图案 + 单应（抗透视）
            const matrix = sampleMatrix(bit, tl, tr, bl, dim, w, h)
            let r = tryMatrix(matrix, dim)
            if (!r) {
                const m = affineParams(tl, tr, bl, dim)
                const al = findAlignment(bit, m, dim, w, h)
                if (al) {
                    const H = solveHomography(
                        [3.5, dim - 3.5, 3.5, dim - 6.5],
                        [3.5, 3.5, dim - 3.5, dim - 6.5],
                        [tl.x, tr.x, bl.x, al.x],
                        [tl.y, tr.y, bl.y, al.y]
                    )
                    if (H) {
                        r = tryMatrix(sampleMatrixH(bit, H, dim, w, h), dim)
                    }
                }
            }
            if (r) {
                best = { score: counts * 10 - Math.abs(deltas[k]), result: r }
                return best
            }
        }
    }
    return best
}

/**
 * 解码 1-bit 位图。
 * @param {{data:Uint8Array,width:number,height:number,stride:number,dark?:number}} img
 * @returns {{text:string,version:number,ec:string,mask:number}|null}
 */
export function decodeQr(img) {
    const w = img.width
    const h = img.height
    const bit = makeBitReader(img)
    const inv = (img.dark === undefined || img.dark === 1) ? 0 : 1
    const cands = findFinderCenters(bit, img.data, img.stride, w, h, inv)
    if (cands.length < 3) return null

    const top = cands.slice(0, 6)
    let best = null
    for (let a = 0; a < top.length - 2; a++) {
        for (let b = a + 1; b < top.length - 1; b++) {
            for (let c = b + 1; c < top.length; c++) {
                const r = tryTriple(bit, top[a], top[b], top[c], w, h)
                if (r) return r.result
            }
        }
    }
    return best ? best.result : null
}

/**
 * 灰度帧 → 1-bit 位图（Otsu 自适应阈值）。
 * 相机灰度帧直接从 shell 的 base64 解出来（不走 ffmpeg——那个固件的 ffmpeg 单次调用要 3.5 秒），
 * 二值化放这里做。屏幕上的二维码是双峰分布（暗模块/亮底），Otsu 很稳；
 * 遇到全黑/全白（阈值退化）时退回 128，解码器找不到 finder 自然返回 null。
 *
 * @param {Uint8Array} gray 灰度数据，长度 = w*h
 * @param {number} w
 * @param {number} h
 * @returns {{data:Uint8Array,width:number,height:number,stride:number,dark:number}}
 */
export function grayToBits(gray, w, h) {
    const n = w * h
    // 1. 直方图
    const hist = new Uint32Array(256)
    for (let i = 0; i < n; i++) hist[gray[i]]++
    // 2. Otsu：最大化类间方差
    let sum = 0
    for (let t = 0; t < 256; t++) sum += t * hist[t]
    let sumB = 0
    let wB = 0
    let bestVar = -1
    let threshold = 128
    for (let t = 0; t < 256; t++) {
        wB += hist[t]
        if (wB === 0) continue
        const wF = n - wB
        if (wF === 0) break
        sumB += t * hist[t]
        const mB = sumB / wB
        const mF = (sum - sumB) / wF
        const between = wB * wF * (mB - mF) * (mB - mF)
        if (between > bestVar) {
            bestVar = between
            threshold = t
        }
    }
    // 3. 二值化 + 按位打包（MSB 在前，stride = ceil(w/8)）
    const stride = (w + 7) >> 3
    const bits = new Uint8Array(stride * h)
    let k = 0
    for (let y = 0; y < h; y++) {
        const base = y * stride
        for (let x = 0; x < w; x++) {
            if (gray[k++] <= threshold) bits[base + (x >> 3)] |= 1 << (7 - (x & 7))
        }
    }
    return { data: bits, width: w, height: h, stride: stride, dark: 1 }
}

/**
 * grayToBits 的分块让出版本：直方图与二值化都按行分块，块间 await yieldFn()。
 * 288x288 的两遍扫描同步要做 ~60ms，和 base64 解码叠加后预览循环会被饿到 14fps；
 * 分块后预览循环能在块间插空，稳定在 24fps 以上。
 */
export async function grayToBitsAsync(gray, w, h, yieldFn) {
    const n = w * h
    const hist = new Uint32Array(256)
    const HCHUNK = 40960
    for (let i = 0; i < n; i += HCHUNK) {
        const end = i + HCHUNK < n ? i + HCHUNK : n
        for (let k = i; k < end; k++) hist[gray[k]]++
        if (end < n && yieldFn) await yieldFn()
    }
    let sum = 0
    for (let t = 0; t < 256; t++) sum += t * hist[t]
    let sumB = 0
    let wB = 0
    let bestVar = -1
    let threshold = 128
    for (let t = 0; t < 256; t++) {
        wB += hist[t]
        if (wB === 0) continue
        const wF = n - wB
        if (wF === 0) break
        sumB += t * hist[t]
        const mB = sumB / wB
        const mF = (sum - sumB) / wF
        const between = wB * wF * (mB - mF) * (mB - mF)
        if (between > bestVar) {
            bestVar = between
            threshold = t
        }
    }
    const stride = (w + 7) >> 3
    const bits = new Uint8Array(stride * h)
    const ROWS = 96
    for (let y0 = 0; y0 < h; y0 += ROWS) {
        const y1 = y0 + ROWS < h ? y0 + ROWS : h
        for (let y = y0; y < y1; y++) {
            const base = y * stride
            const gbase = y * w
            for (let x = 0; x < w; x++) {
                if (gray[gbase + x] <= threshold) bits[base + (x >> 3)] |= 1 << (7 - (x & 7))
            }
        }
        if (y1 < h && yieldFn) await yieldFn()
    }
    return { data: bits, width: w, height: h, stride: stride, dark: 1 }
}
