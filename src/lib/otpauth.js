// otpauth:// 与 Google Authenticator 转移链接 (otpauth-migration://) 解析与生成
import { normalizeSecret, validateSecret, base32Encode, base32Decode } from './base32.js'
import { ALGORITHMS, DEFAULT_DIGITS, DEFAULT_PERIOD } from './totp.js'
import { utf8, utf8Decode, base64ToBytes, bytesToBase64 } from './bytes.js'

function safeDecode(text) {
    try {
        return decodeURIComponent(String(text || '').replace(/\+/g, ' '))
    } catch (e) {
        return String(text || '')
    }
}

function parseQuery(query) {
    const out = {}
    if (!query) return out
    for (const pair of query.split('&')) {
        if (!pair) continue
        const idx = pair.indexOf('=')
        const key = idx < 0 ? pair : pair.slice(0, idx)
        const value = idx < 0 ? '' : pair.slice(idx + 1)
        out[safeDecode(key).toLowerCase()] = safeDecode(value)
    }
    return out
}

/** 判断是否为 Google Authenticator 转移链接 */
export function isMigrationUri(input) {
    return /^otpauth-migration:\/\//i.test(String(input || '').trim())
}

/**
 * 规范化并解码 otpauth-migration 的 data 参数（兼容 URL 编码、URL-safe Base64、+ 被转空格、缺省 = 填充）
 */
function decodeMigrationBase64(rawData) {
    let text = String(rawData || '').trim()
    if (!text) throw new Error('迁移数据为空')
    try {
        if (/%[0-9a-fA-F]{2}/.test(text)) {
            text = decodeURIComponent(text)
        }
    } catch (e) { /* 保留原串 */ }
    text = text
        .trim()
        .replace(/ /g, '+')
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .replace(/[^A-Za-z0-9+/=]/g, '')
        .replace(/=+$/, '')
    if (!text) throw new Error('迁移数据为空')
    const mod = text.length % 4
    if (mod === 1) throw new Error('迁移数据 Base64 长度无效')
    if (mod === 2) text += '=='
    else if (mod === 3) text += '='
    return base64ToBytes(text)
}

/**
 * 读取 Protobuf varint（兼容 32/64 位整数及 10 字节负数 varint，QuickJS 无 BigInt）
 */
function readVarint(bytes, pos, end) {
    let low = 0
    let high = 0
    let i = 0
    while (i < 10) {
        if (pos >= end) throw new Error('迁移数据被截断')
        const b = bytes[pos++]
        if (i < 4) {
            low |= (b & 0x7f) << (i * 7)
        } else if (i === 4) {
            low |= (b & 0x0f) << 28
            high |= (b & 0x7f) >> 4
        } else {
            high |= (b & 0x7f) << ((i - 5) * 7 + 3)
        }
        i++
        if ((b & 0x80) === 0) {
            const ulow = low >>> 0
            const uhigh = high >>> 0
            const uint64 = uhigh * 4294967296 + ulow
            const int64 = (high | 0) < 0
                ? -(((~high >>> 0) * 4294967296) + ((~low >>> 0) + 1))
                : uint64
            return { int32: low | 0, uint32: ulow, uint64, int64, next: pos }
        }
    }
    throw new Error('迁移数据 varint 格式错误')
}

function skipField(bytes, pos, end, wireType) {
    if (wireType === 0) return readVarint(bytes, pos, end).next
    if (wireType === 1) {
        if (pos + 8 > end) throw new Error('迁移数据被截断')
        return pos + 8
    }
    if (wireType === 2) {
        const len = readVarint(bytes, pos, end)
        if (len.uint32 > end - len.next) throw new Error('迁移数据长度越界')
        return len.next + len.uint32
    }
    if (wireType === 5) {
        if (pos + 4 > end) throw new Error('迁移数据被截断')
        return pos + 4
    }
    throw new Error('未知的 Protobuf 字段类型: ' + wireType)
}

/**
 * 解析 Google Authenticator MigrationPayload.OtpParameters 子消息
 */
function decodeOtpParameters(bytes, start, end) {
    let pos = start
    let secretBytes = null
    let rawName = ''
    let rawIssuer = ''
    let algEnum = 0
    let digitsEnum = 0
    let typeEnum = 0
    let counter = 0

    while (pos < end) {
        const tag = readVarint(bytes, pos, end)
        pos = tag.next
        const fieldNo = tag.uint32 >>> 3
        const wireType = tag.uint32 & 7

        if (fieldNo === 1 && wireType === 2) {
            const len = readVarint(bytes, pos, end)
            if (len.uint32 > end - len.next) throw new Error('密钥字段长度越界')
            secretBytes = bytes.subarray(len.next, len.next + len.uint32)
            pos = len.next + len.uint32
        } else if (fieldNo === 2 && wireType === 2) {
            const len = readVarint(bytes, pos, end)
            if (len.uint32 > end - len.next) throw new Error('账号名字段长度越界')
            rawName = utf8Decode(bytes.subarray(len.next, len.next + len.uint32))
            pos = len.next + len.uint32
        } else if (fieldNo === 3 && wireType === 2) {
            const len = readVarint(bytes, pos, end)
            if (len.uint32 > end - len.next) throw new Error('服务名字段长度越界')
            rawIssuer = utf8Decode(bytes.subarray(len.next, len.next + len.uint32))
            pos = len.next + len.uint32
        } else if (fieldNo === 4 && wireType === 0) {
            const v = readVarint(bytes, pos, end)
            algEnum = v.int32
            pos = v.next
        } else if (fieldNo === 5 && wireType === 0) {
            const v = readVarint(bytes, pos, end)
            digitsEnum = v.int32
            pos = v.next
        } else if (fieldNo === 6 && wireType === 0) {
            const v = readVarint(bytes, pos, end)
            typeEnum = v.int32
            pos = v.next
        } else if (fieldNo === 7 && wireType === 0) {
            const v = readVarint(bytes, pos, end)
            counter = v.int64 >= 0 ? v.int64 : 0
            pos = v.next
        } else {
            pos = skipField(bytes, pos, end, wireType)
        }
    }

    if (!secretBytes || !secretBytes.length) {
        throw new Error('迁移账号缺少密钥')
    }
    const secret = normalizeSecret(base32Encode(secretBytes))
    if (!secret) throw new Error('迁移账号密钥无效')

    // Algorithm: 0=UNSPECIFIED(SHA1), 1=SHA1, 2=SHA256, 3=SHA512, 4=MD5
    let algorithm = 'SHA1'
    if (algEnum === 2) algorithm = 'SHA256'
    else if (algEnum === 3) algorithm = 'SHA512'
    else if (algEnum === 4) throw new Error('不支持 MD5 算法的验证器账号')

    // DigitCount: 0=UNSPECIFIED(6), 1=SIX(6), 2=EIGHT(8)；兼容直接写入 6/8
    const digits = (digitsEnum === 2 || digitsEnum === 8) ? 8 : DEFAULT_DIGITS

    // OtpType: 1=HOTP, 0/2=TOTP
    const type = typeEnum === 1 ? 'hotp' : 'totp'

    let issuer = String(rawIssuer || '').trim()
    let account = String(rawName || '').trim()
    const sep = account.indexOf(':')
    if (sep >= 0) {
        const labelIssuer = account.slice(0, sep).trim()
        account = account.slice(sep + 1).trim()
        if (!issuer) issuer = labelIssuer
    }

    return {
        type,
        issuer: issuer.slice(0, 40),
        account: account.slice(0, 60),
        secret,
        algorithm,
        digits,
        period: DEFAULT_PERIOD,
        counter: type === 'hotp' ? counter : 0
    }
}

/**
 * 解码 Google Authenticator MigrationPayload 二进制数据
 */
export function decodeMigrationPayload(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) {
        throw new Error('迁移数据为空')
    }
    let pos = 0
    const end = bytes.length
    const accounts = []
    let version = 1
    let batchSize = 1
    let batchIndex = 0
    let batchId = 0

    while (pos < end) {
        const tag = readVarint(bytes, pos, end)
        pos = tag.next
        const fieldNo = tag.uint32 >>> 3
        const wireType = tag.uint32 & 7

        if (fieldNo === 1 && wireType === 2) {
            const len = readVarint(bytes, pos, end)
            if (len.uint32 > end - len.next) throw new Error('迁移账号条目长度越界')
            const subStart = len.next
            const subEnd = subStart + len.uint32
            accounts.push(decodeOtpParameters(bytes, subStart, subEnd))
            pos = subEnd
        } else if (fieldNo === 2 && wireType === 0) {
            const v = readVarint(bytes, pos, end)
            version = v.int32 || 1
            pos = v.next
        } else if (fieldNo === 3 && wireType === 0) {
            const v = readVarint(bytes, pos, end)
            batchSize = v.int32 > 0 ? v.int32 : 1
            pos = v.next
        } else if (fieldNo === 4 && wireType === 0) {
            const v = readVarint(bytes, pos, end)
            batchIndex = v.int32 >= 0 ? v.int32 : 0
            pos = v.next
        } else if (fieldNo === 5 && wireType === 0) {
            const v = readVarint(bytes, pos, end)
            batchId = v.int32
            pos = v.next
        } else {
            pos = skipField(bytes, pos, end, wireType)
        }
    }

    if (!accounts.length) {
        throw new Error('Google 转移码中未包含有效账号')
    }

    return {
        accounts,
        version,
        batchSize,
        batchIndex,
        batchId
    }
}

/**
 * 解析 otpauth-migration://offline?data=... 链接
 * @returns {{ accounts: Array<object>, version: number, batchSize: number, batchIndex: number, batchId: number }}
 */
export function parseMigrationUri(input) {
    const text = String(input || '').trim()
    const match = /^otpauth-migration:\/\/[^?#]*\?([^#]*)/i.exec(text)
    if (!match) throw new Error('无法识别的 Google 转移链接')
    const query = match[1] || ''
    let rawData = ''
    for (const pair of query.split('&')) {
        if (!pair) continue
        const idx = pair.indexOf('=')
        const key = (idx < 0 ? pair : pair.slice(0, idx)).trim().toLowerCase()
        if (key === 'data') {
            rawData = idx < 0 ? '' : pair.slice(idx + 1)
            break
        }
    }
    if (!rawData) throw new Error('Google 转移链接缺少 data 参数')
    const bytes = decodeMigrationBase64(rawData)
    return decodeMigrationPayload(bytes)
}

function writeVarint(out, val) {
    let v = Math.floor(Number(val) || 0)
    if (v < 0) {
        const low = v | 0
        const high = -1
        for (let i = 0; i < 9; i++) {
            let bits
            if (i < 4) bits = (low >>> (i * 7)) & 0x7f
            else if (i === 4) bits = ((low >>> 28) & 0x0f) | ((high & 0x07) << 4)
            else bits = (high >>> ((i - 5) * 7 + 3)) & 0x7f
            out.push(bits | 0x80)
        }
        out.push(0x01)
        return
    }
    while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80)
        v = Math.floor(v / 128)
    }
    out.push(v & 0x7f)
}

function writeBytesField(out, fieldNo, bytes) {
    writeVarint(out, (fieldNo << 3) | 2)
    writeVarint(out, bytes.length)
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i])
}

function writeVarintField(out, fieldNo, val) {
    writeVarint(out, (fieldNo << 3) | 0)
    writeVarint(out, val)
}

/**
 * 编码账号数组为 Google Authenticator MigrationPayload 二进制
 */
export function encodeMigrationPayload(items, meta = {}) {
    if (!Array.isArray(items) || !items.length) {
        throw new Error('没有可导出的账号')
    }
    const out = []
    for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const sub = []
        const secretBytes = base32Decode(normalizeSecret(item.secret))
        writeBytesField(sub, 1, secretBytes)

        const issuer = String(item.issuer || '').trim()
        const account = String(item.account || '').trim()
        const name = issuer
            ? (account ? issuer + ':' + account : issuer)
            : (account || 'account')
        writeBytesField(sub, 2, utf8(name))
        if (issuer) writeBytesField(sub, 3, utf8(issuer))

        const alg = String(item.algorithm || 'SHA1').toUpperCase()
        const algEnum = alg === 'SHA256' ? 2 : alg === 'SHA512' ? 3 : 1
        writeVarintField(sub, 4, algEnum)

        const digitsEnum = Number(item.digits) === 8 ? 2 : 1
        writeVarintField(sub, 5, digitsEnum)

        const isHotp = item.type === 'hotp'
        writeVarintField(sub, 6, isHotp ? 1 : 2)
        if (isHotp) {
            writeVarintField(sub, 7, Math.max(0, Number(item.counter) || 0))
        }

        writeBytesField(out, 1, new Uint8Array(sub))
    }

    const version = Number(meta.version) > 0 ? Number(meta.version) : 1
    const batchSize = Number(meta.batchSize) > 0 ? Number(meta.batchSize) : 1
    const batchIndex = Number(meta.batchIndex) >= 0 ? Number(meta.batchIndex) : 0
    const batchId = meta.batchId !== undefined ? (Number(meta.batchId) | 0) : ((Date.now() & 0x7fffffff) || 1)

    writeVarintField(out, 2, version)
    writeVarintField(out, 3, batchSize)
    writeVarintField(out, 4, batchIndex)
    writeVarintField(out, 5, batchId)

    return new Uint8Array(out)
}

/**
 * 生成单条 Google Authenticator 转移链接 (otpauth-migration://offline?data=...)
 */
export function buildMigrationUri(items, meta = {}) {
    const list = Array.isArray(items) ? items : [items]
    const payload = encodeMigrationPayload(list, meta)
    const b64 = bytesToBase64(payload)
    return 'otpauth-migration://offline?data=' + encodeURIComponent(b64)
}

/**
 * 按批次拆分账号并生成一组 Google Authenticator 转移链接（每张二维码默认最多 batchLimit 个账号）
 */
export function buildMigrationUris(items, batchLimit = 4, customBatchId) {
    if (!Array.isArray(items) || !items.length) return []
    const limit = Math.max(1, Number(batchLimit) || 4)
    const chunks = []
    for (let i = 0; i < items.length; i += limit) {
        chunks.push(items.slice(i, i + limit))
    }
    const batchSize = chunks.length
    const batchId = customBatchId !== undefined ? (Number(customBatchId) | 0) : ((Date.now() & 0x7fffffff) || 1)
    return chunks.map((chunk, idx) => buildMigrationUri(chunk, {
        version: 1,
        batchSize,
        batchIndex: idx,
        batchId
    }))
}

/** 解析 otpauth://、otpauth-migration:// 或裸 Base32 密钥，返回单个账号草稿（若为迁移链接则返回首个账号） */
export function parseOtpInput(input) {
    const text = String(input || '').trim()
    if (!text) throw new Error('内容为空')

    if (isMigrationUri(text)) {
        return parseMigrationUri(text).accounts[0]
    }

    if (!/^otpauth:\/\//i.test(text)) {
        const secret = normalizeSecret(text)
        const err = validateSecret(secret)
        if (err) throw new Error(err)
        return { type: 'totp', issuer: '', account: '', secret, algorithm: 'SHA1', digits: DEFAULT_DIGITS, period: DEFAULT_PERIOD, counter: 0 }
    }

    const match = /^otpauth:\/\/(totp|hotp)\/([^?#]*)(?:\?([^#]*))?/i.exec(text)
    if (!match) throw new Error('无法识别的 otpauth 链接')
    const type = match[1].toLowerCase()
    const label = safeDecode(match[2] || '')
    const params = parseQuery(match[3] || '')

    let issuer = params.issuer || ''
    let account = label
    const sep = label.indexOf(':')
    if (sep >= 0) {
        const labelIssuer = label.slice(0, sep).trim()
        account = label.slice(sep + 1).trim()
        if (!issuer) issuer = labelIssuer
    }

    const secret = normalizeSecret(params.secret || '')
    const err = validateSecret(secret)
    if (err) throw new Error(err)

    const algorithm = ALGORITHMS.indexOf(String(params.algorithm || '').toUpperCase()) >= 0
        ? String(params.algorithm).toUpperCase()
        : 'SHA1'
    const digits = Number(params.digits) === 8 ? 8 : DEFAULT_DIGITS
    const period = Number(params.period) > 0 ? Number(params.period) : DEFAULT_PERIOD
    const counter = Number(params.counter) >= 0 ? Number(params.counter) : 0

    return {
        type,
        issuer: issuer.slice(0, 40),
        account: account.slice(0, 60),
        secret,
        algorithm,
        digits,
        period,
        counter
    }
}

/**
 * 解析输入（支持单条 otpauth://、Google 转移 otpauth-migration://、多行混合文本或裸 Base32），
 * 返回统一的批量解析结果
 */
export function parseOtpInputs(input) {
    const text = String(input || '').trim()
    if (!text) throw new Error('内容为空')

    if (isMigrationUri(text)) {
        const res = parseMigrationUri(text)
        return {
            accounts: res.accounts,
            isMigration: true,
            version: res.version,
            batchSize: res.batchSize,
            batchIndex: res.batchIndex,
            batchId: res.batchId
        }
    }

    const uris = extractUris(text)
    if (uris.length > 1 || (uris.length === 1 && isMigrationUri(uris[0]))) {
        const accounts = []
        let isMigration = false
        let batchSize = 1
        let batchIndex = 0
        let batchId = 0
        let lastErr = null
        for (let i = 0; i < uris.length; i++) {
            const u = uris[i]
            try {
                if (isMigrationUri(u)) {
                    const m = parseMigrationUri(u)
                    isMigration = true
                    batchSize = m.batchSize
                    batchIndex = m.batchIndex
                    batchId = m.batchId
                    for (let j = 0; j < m.accounts.length; j++) accounts.push(m.accounts[j])
                } else {
                    accounts.push(parseOtpInput(u))
                }
            } catch (e) {
                lastErr = e
            }
        }
        if (!accounts.length) throw (lastErr || new Error('未解析到有效账号'))
        return { accounts, isMigration, version: 1, batchSize, batchIndex, batchId }
    }

    const candidate = uris.length === 1 ? uris[0] : text
    return {
        accounts: [parseOtpInput(candidate)],
        isMigration: false,
        version: 1,
        batchSize: 1,
        batchIndex: 0,
        batchId: 0
    }
}

export function buildOtpUri(item) {
    const issuer = String(item.issuer || '').trim()
    const account = String(item.account || '').trim()
    const label = encodeURIComponent((issuer ? issuer + ':' : '') + (account || 'account')).replace(/%3A/g, ':')
    const params = ['secret=' + normalizeSecret(item.secret)]
    if (issuer) params.push('issuer=' + encodeURIComponent(issuer))
    if (item.algorithm && item.algorithm !== 'SHA1') params.push('algorithm=' + item.algorithm)
    if (Number(item.digits) && Number(item.digits) !== DEFAULT_DIGITS) params.push('digits=' + item.digits)
    if (Number(item.period) && Number(item.period) !== DEFAULT_PERIOD) params.push('period=' + item.period)
    if (item.type === 'hotp') params.push('counter=' + (item.counter || 0))
    return `otpauth://${item.type === 'hotp' ? 'hotp' : 'totp'}/${label}?${params.join('&')}`
}

/** 从文本中提取所有 otpauth:// 与 otpauth-migration:// 链接 */
export function extractUris(text) {
    const found = []
    const re = /otpauth(?:-migration)?:\/\/[^\s"'<>]+/gi
    let m
    while ((m = re.exec(String(text || '')))) found.push(m[0])
    return found
}
