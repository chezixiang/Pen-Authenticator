// 二维码解码器自测：用 qrcode 生成模块矩阵 → 渲染成 1-bit 位图 → 解码比对
//
// 运行：node --experimental-default-type=module tools/test_qrdec.mjs
// 依赖：C:/Users/Aquavie/.workbuddy/binaries/node/workspace/node_modules/qrcode
import { createRequire } from 'module'
import { decodeQr, grayToBits } from '../src/lib/qrdec.js'
import { encodeQr } from '../src/lib/qrenc.js'

const require = createRequire(import.meta.url)
let QRCode = null
try {
    QRCode = require(process.env.QRCODE_PATH ||
        'C:/Users/Aquavie/.workbuddy/binaries/node/workspace/node_modules/qrcode')
} catch (e) {
    QRCode = null
}

const EC_LEVELS = ['L', 'M', 'Q', 'H']

// ---------- 把 payload 编成模块矩阵 ----------
function moduleMatrix(text, ecLevel) {
    if (!QRCode) {
        const q = encodeQr(text, ecLevel)
        return { size: q.size, data: q.data }
    }
    const qr = QRCode.create(text, { errorCorrectionLevel: ecLevel })
    const size = qr.modules.size
    const data = qr.modules.data
    const m = new Uint8Array(size * size)
    for (let i = 0; i < data.length; i++) m[i] = data[i] ? 1 : 0
    return { size, data: m }
}

// ---------- 渲染成 1-bit 位图（带旋转/模糊/噪声） ----------
// dark=1，MSB 在前，stride = ceil(w/8)，与 ffmpeg monow 输出一致
function render(matrix, opts) {
    const scale = opts.scale
    const quiet = opts.quiet === undefined ? 4 : opts.quiet
    const angle = (opts.angle || 0) * Math.PI / 180
    const noise = opts.noise || 0
    const blur = opts.blur === undefined ? 0.35 : opts.blur
    const dim = matrix.size
    const span = (dim + quiet * 2) * scale
    // 旋转后画布要放大，否则二维码四角会被裁掉
    const rotSpan = opts.angle ? span * 1.45 : span
    const w = opts.width || Math.ceil(rotSpan / 2) * 2
    const h = opts.height || w
    const stride = (w + 7) >> 3
    const bits = new Uint8Array(stride * h)
    const cx = w / 2
    const cy = h / 2
    const cos = Math.cos(-angle)
    const sin = Math.sin(-angle)
    const halfPx = span / 2

    let seed = 12345
    const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    }

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            // 反向旋转到渲染坐标系
            const dx = x + 0.5 - cx
            const dy = y + 0.5 - cy
            const rx = dx * cos - dy * sin + halfPx
            const ry = dx * sin + dy * cos + halfPx
            // 采样（可选 2x2 均值模拟模糊）
            let lum = 0
            const samples = blur > 0 ? 4 : 1
            for (let s = 0; s < samples; s++) {
                const ox = samples === 1 ? 0 : ((s & 1) - 0.5) * blur
                const oy = samples === 1 ? 0 : (((s >> 1) & 1) - 0.5) * blur
                const sx = rx + ox
                const sy = ry + oy
                const mx = Math.floor(sx / scale) - quiet
                const my = Math.floor(sy / scale) - quiet
                let dark = 0
                if (mx >= 0 && mx < dim && my >= 0 && my < dim) dark = matrix.data[my * dim + mx]
                // 白底 210，黑块 30（模拟屏幕/纸张）
                lum += dark ? 30 : 210
            }
            lum /= samples
            if (noise) lum += (rnd() - 0.5) * noise * 255
            if (lum < 120) bits[y * stride + (x >> 3)] |= 1 << (7 - (x & 7))
        }
    }
    return { data: bits, width: w, height: h, stride: stride, dark: 1 }
}

// ---------- 透视渲染（模拟笔身倾斜） ----------
function renderPerspective(matrix, opts) {
    const scale = opts.scale
    const quiet = 4
    const dim = matrix.size
    const span = (dim + quiet * 2) * scale
    const w = Math.ceil(span / 2) * 2
    const h = w
    const stride = (w + 7) >> 3
    const bits = new Uint8Array(stride * h)
    // 目标四边形四角相对整图的偏移（归一化）
    const k = opts.k
    const dst = [
        [k[0] * span, k[1] * span],
        [span - k[2] * span, k[3] * span],
        [span - k[4] * span, span - k[5] * span],
        [k[6] * span, span - k[7] * span]
    ]
    const src = [[0, 0], [span, 0], [span, span], [0, span]]
    // 求解 8 参数单应（dst → src）
    const H = homography(dst, src)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const den = H[6] * x + H[7] * y + 1
            const u = (H[0] * x + H[1] * y + H[2]) / den
            const v = (H[3] * x + H[4] * y + H[5]) / den
            if (u < 0 || v < 0 || u >= span || v >= span) continue
            const mx = Math.floor(u / scale) - quiet
            const my = Math.floor(v / scale) - quiet
            if (mx < 0 || mx >= dim || my < 0 || my >= dim) continue
            if (matrix.data[my * dim + mx]) bits[y * stride + (x >> 3)] |= 1 << (7 - (x & 7))
        }
    }
    return { data: bits, width: w, height: h, stride: stride, dark: 1 }
}

function homography(from, to) {
    // 8x8 线性方程，高斯消元
    const A = []
    for (let i = 0; i < 4; i++) {
        const [x, y] = from[i]
        const [u, v] = to[i]
        A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
        A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
    }
    for (let c = 0; c < 8; c++) {
        let piv = c
        for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
        const t = A[c]; A[c] = A[piv]; A[piv] = t
        const d = A[c][c] || 1e-9
        for (let k = c; k < 9; k++) A[c][k] /= d
        for (let r = 0; r < 8; r++) {
            if (r === c) continue
            const f = A[r][c]
            for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]
        }
    }
    return A.map(row => row[8])
}

// ---------- 测试集 ----------
const PAYLOADS = [
    'otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30',
    'otpauth://totp/Google:someuser@gmail.com?secret=KRSXG5CTMVRXEZLU&issuer=Google',
    'otpauth://totp/ACME%20Co:john.doe@email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60',
    'otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTAC',
    'https://example.com/short',
    'HELLO WORLD 123'
]

let pass = 0
let fail = 0
const failures = []

function check(name, img, expect) {
    const r = decodeQr(img)
    if (r && r.text === expect) {
        pass++
        return true
    }
    fail++
    if (failures.length < 25) {
        failures.push(name + ' -> ' + (r ? 'wrong:"' + String(r.text).slice(0, 40) + '"' : 'null'))
    }
    return false
}

console.log('--- 1. 各版本 / 纠错级别（无损、无旋转） ---')
for (const ec of EC_LEVELS) {
    for (const p of PAYLOADS) {
        const m = moduleMatrix(p, ec)
        const img = render(m, { scale: 4 })
        const v = (m.size - 17) / 4
        check(`ec=${ec} v=${v} scale=4 len=${p.length}`, img, p)
    }
}

console.log('--- 2. 不同像素/模块（2.5 / 3 / 4 / 5） ---')
for (const scale of [2.5, 3, 4, 5]) {
    for (const p of PAYLOADS) {
        const m = moduleMatrix(p, 'M')
        check(`scale=${scale} v=${(m.size - 17) / 4}`, render(m, { scale, blur: 0.5 }), p)
    }
}

console.log('--- 3. 旋转 0..350 度（步长 10） ---')
for (let angle = 0; angle < 360; angle += 10) {
    for (const p of [PAYLOADS[0], PAYLOADS[2]]) {
        const m = moduleMatrix(p, 'M')
        check(`angle=${angle} v=${(m.size - 17) / 4}`, render(m, { scale: 4, angle }), p)
    }
}

console.log('--- 4. 噪声 ---')
for (const noise of [0.2, 0.35, 0.5]) {
    for (const p of [PAYLOADS[0], PAYLOADS[1]]) {
        const m = moduleMatrix(p, 'M')
        check(`noise=${noise} v=${(m.size - 17) / 4}`, render(m, { scale: 4, noise }), p)
    }
}

console.log('--- 5. 小尺寸（72 / 96 / 120 / 144 / 168 / 224） ---')
for (const side of [72, 96, 120, 144, 168, 224]) {
    for (const p of [PAYLOADS[0], PAYLOADS[1]]) {
        const m = moduleMatrix(p, 'M')
        const total = m.size + 8
        const scale = side / total
        const img = render(m, { scale, width: side, height: side, blur: 0.6 })
        check(`side=${side} v=${(m.size - 17) / 4}`, img, p)
    }
}

console.log('--- 6. 最大版本（长 payload，足够分辨率） ---')
for (const len of [300, 800, 1500]) {
    const p = 'otpauth://totp/Test:' + 'x'.repeat(len) + '@example.com?secret=JBSWY3DPEHPK3PXP'
    const m = moduleMatrix(p, 'M')
    const scale = 3
    const side = Math.ceil((m.size + 8) * scale / 2) * 2
    const img = render(m, { scale, width: side, height: side })
    check(`len=${len} v=${(m.size - 17) / 4} side=${side}`, img, p)
}

console.log('--- 7. 透视（笔身倾斜 4% / 7% / 10%） ---')
for (const amp of [0.04, 0.07, 0.1]) {
    for (const p of [PAYLOADS[0], PAYLOADS[2]]) {
        const m = moduleMatrix(p, 'M')
        const img = renderPerspective(m, { scale: 4, k: [amp, 0, 0, amp, 0, 0, amp, 0] })
        check(`persp=${amp} v=${(m.size - 17) / 4}`, img, p)
    }
}

console.log('--- 8. 低分辨率 + 旋转组合（224px 画布，二维码占 70%） ---')
for (const angle of [0, 15, 30, 45]) {
    for (const p of [PAYLOADS[0], PAYLOADS[1]]) {
        const m = moduleMatrix(p, 'Q')
        const side = 224
        const scale = side / (m.size + 8) * 0.7
        const img = render(m, { scale, width: side, height: side, angle, blur: 0.6 })
        check(`224+angle=${angle} v=${(m.size - 17) / 4}`, img, p)
    }
}

// ---------- 渲染成 8 位灰度（模拟相机灰度帧，走 JS 侧 Otsu） ----------
function renderGray(matrix, opts) {
    const scale = opts.scale
    const quiet = opts.quiet === undefined ? 4 : opts.quiet
    const dim = matrix.size
    const span = (dim + quiet * 2) * scale
    const rotSpan = opts.angle ? span * 1.45 : span
    const w = opts.width || Math.ceil(rotSpan / 2) * 2
    const h = opts.height || w
    const gray = new Uint8Array(w * h).fill(210)
    const cx = w / 2, cy = h / 2
    const angle = (opts.angle || 0) * Math.PI / 180
    const cos = Math.cos(-angle), sin = Math.sin(-angle)
    const halfPx = span / 2
    let seed = 999
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy
            const rx = dx * cos - dy * sin + halfPx
            const ry = dx * sin + dy * cos + halfPx
            const mx = Math.floor(rx / scale) - quiet
            const my = Math.floor(ry / scale) - quiet
            let dark = 0
            if (mx >= 0 && mx < dim && my >= 0 && my < dim) dark = matrix.data[my * dim + mx]
            let lum = dark ? 30 : 210
            if (opts.noise) lum += (rnd() - 0.5) * opts.noise * 255
            if (opts.uneven) lum *= 0.75 + 0.25 * ((x + y) / (w + h))   // 模拟光照不均
            gray[y * w + x] = lum < 0 ? 0 : lum > 255 ? 255 : lum
        }
    }
    return { gray, width: w, height: h }
}

console.log('--- 9. 灰度帧 + JS Otsu 二值化（新解码通道） ---')
for (const [scale, opts] of [
    [4, {}], [3, {}], [2.5, {}], [4, { noise: 0.3 }], [3, { noise: 0.3 }],
    [4, { uneven: true }], [3, { uneven: true }], [4, { angle: 20 }], [3, { angle: 35 }]
]) {
    for (const p of [PAYLOADS[0], PAYLOADS[1], PAYLOADS[2]]) {
        const m = moduleMatrix(p, 'M')
        const g = renderGray(m, { scale, ...opts })
        const img = grayToBits(g.gray, g.width, g.height)
        check(`gray scale=${scale} ${JSON.stringify(opts)} v=${(m.size - 17) / 4}`, img, p)
    }
}

console.log('')
console.log('pass=' + pass + ' fail=' + fail)
if (failures.length) {
    console.log('failures:')
    for (const f of failures) console.log('  ' + f)
}
process.exit(fail ? 1 : 0)
