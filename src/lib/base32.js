// Base32（RFC 4648）编解码，用于 TOTP 密钥
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Decode(input) {
    const clean = String(input || '').toUpperCase().replace(/[\s\-=]/g, '')
    if (!clean) throw new Error('密钥为空')
    let bits = 0
    let value = 0
    const out = []
    for (let i = 0; i < clean.length; i++) {
        const idx = ALPHABET.indexOf(clean[i])
        if (idx < 0) throw new Error('密钥包含非法字符: ' + clean[i])
        value = (value << 5) | idx
        bits += 5
        if (bits >= 8) {
            bits -= 8
            out.push((value >>> bits) & 0xff)
        }
    }
    if (!out.length) throw new Error('密钥长度不足')
    return new Uint8Array(out)
}

export function base32Encode(bytes) {
    let bits = 0
    let value = 0
    let out = ''
    for (let i = 0; i < bytes.length; i++) {
        value = (value << 8) | bytes[i]
        bits += 8
        while (bits >= 5) {
            bits -= 5
            out += ALPHABET[(value >>> bits) & 31]
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
    return out
}

/** 规范化：去掉空格/短横线/填充，统一大写 */
export function normalizeSecret(input) {
    return String(input || '').toUpperCase().replace(/[\s\-=]/g, '')
}

/** 粗略校验密钥格式与长度 */
export function validateSecret(input) {
    const clean = normalizeSecret(input)
    if (!clean) return '密钥不能为空'
    if (!/^[A-Z2-7]+$/.test(clean)) return '密钥只能包含 A-Z 与 2-7'
    if (clean.length < 8) return '密钥至少 8 位（建议 16 或 32 位）'
    try {
        base32Decode(clean)
    } catch (e) {
        return e.message
    }
    return ''
}
