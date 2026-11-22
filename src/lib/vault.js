// 本地保险库：账号数据持久化（可选 PIN + AES-256-CBC 加密）
import storage from 'storage'
import globalModule from 'global'
import { sha256, hmac, pbkdf2 } from './hash.js'
import { aesCbcEncrypt, aesCbcDecrypt } from './aes.js'
import { randomBytes, randomId } from './random.js'
import {
    utf8, utf8Decode, bytesToBase64, base64ToBytes, concatBytes, timingSafeEqual, wipe
} from './bytes.js'

const KEY_VAULT = 'auth_vault_v1'

// 全新安装（尤其 uninstall 后重装）时 pkg/<appid>/data/ 下的子目录会被删掉，框架的
// setStorage 直接失败（报 `setStorage failed key: ...`）且不会自己建目录。
// 真机实测（2026-10-23）：jsapi storage 的后端是 **data/storage/**（preferences.json），
// 不是 sharedpreferences——只建后者依然失败。两个都建，保险。
let storageDirReady = false

function dataDirCandidates() {
    const out = []
    try {
        if (typeof $dataDir !== 'undefined' && $dataDir) out.push(String($dataDir))
    } catch (e) { /* 老固件没有 $dataDir */ }
    try {
        if (typeof $workspace !== 'undefined' && $workspace) out.push(String($workspace) + '/../data')
    } catch (e) { /* 忽略 */ }
    return out
}

function ensureStorageDir(force) {
    if (storageDirReady && !force) return
    storageDirReady = true
    const dirs = dataDirCandidates()
    if (!dirs.length) return
    try {
        const g = new globalModule.Global()
        for (let i = 0; i < dirs.length; i++) {
            g.execShell('mkdir -p "' + dirs[i] + '/storage" "' + dirs[i] + '/sharedpreferences"')
        }
    } catch (e) { /* 失败就让它继续报原错 */ }
}

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// 真机实测：QuickJS 上 PBKDF2 约 3.4ms/次迭代，12000 次会让主线程卡死 40s；300 次约 1s，
// 是可接受的解锁延迟（6 位 PIN 的强度本就受限，见 README）。
const ITERATIONS = 150
const VERIFIER_TEXT = 'dictpen-authenticator-v1'

/** 从 PIN 派生 enc/mac 两把密钥 */
function deriveKeys(pin, saltB64, iterations) {
    const salt = base64ToBytes(saltB64)
    // 只做一次 32 字节 PBKDF2（64 字节要算两个块，真机上直接翻倍），
    // 校验密钥再用 HMAC 派生，避免解锁时多等一倍时间。
    const encKey = pbkdf2(utf8(pin), salt, iterations || ITERATIONS, 32, 'SHA256')
    const macKey = hmac('SHA256', encKey, utf8('mac-key')).slice(0, 32)
    return { encKey, macKey }
}

function tagFor(macKey, iv, ct) {
    return hmac('SHA256', macKey, concatBytes(iv, ct)).slice(0, 16)
}

export const vault = {
    /** @type {{ pin: boolean, salt: string, iterations: number, data: object|null }} */
    meta: null,
    accounts: [],
    encKey: null,
    macKey: null,
    failedAttempts: 0,
    lockUntil: 0,

    get hasPin() {
        return !!(this.meta && this.meta.pin)
    },

    get unlocked() {
        return !this.hasPin || !!this.encKey
    },

    async init() {
        ensureStorageDir(false)
        await sleepMs(120)
        try {
            const raw = await storage.getStorage(KEY_VAULT)
            if (raw) this.meta = JSON.parse(raw)
        } catch (e) {
            this.meta = null
        }
        if (!this.meta || typeof this.meta !== 'object') {
            this.meta = { pin: false, salt: '', iterations: ITERATIONS, accounts: [] }
            this.accounts = []
            await this.persist()
            return
        }
        if (!this.hasPin) {
            this.accounts = Array.isArray(this.meta.accounts) ? this.meta.accounts : []
        } else {
            this.accounts = []
        }
    },

    /** 校验 PIN 并解密 */
    async unlock(pin) {
        if (!this.hasPin) return true
        const now = Date.now()
        if (this.lockUntil > now) {
            const wait = Math.ceil((this.lockUntil - now) / 1000)
            throw new Error(`尝试次数过多，请等待 ${wait} 秒`)
        }
        const { encKey, macKey } = deriveKeys(pin, this.meta.salt, this.meta.iterations)
        const blob = this.meta.blob
        if (!blob || !blob.iv || !blob.ct || !blob.tag) throw new Error('保险库数据损坏')
        const iv = base64ToBytes(blob.iv)
        const ct = base64ToBytes(blob.ct)
        const tag = tagFor(macKey, iv, ct)
        if (!timingSafeEqual(tag, base64ToBytes(blob.tag))) {
            wipe(encKey)
            wipe(macKey)
            this.failedAttempts++
            if (this.failedAttempts >= 5) {
                this.lockUntil = Date.now() + 30000
                this.failedAttempts = 0
                throw new Error('密码错误次数过多，已锁定 30 秒')
            }
            throw new Error('密码错误')
        }
        let json
        try {
            json = utf8Decode(aesCbcDecrypt(encKey, iv, ct))
        } catch (e) {
            wipe(encKey)
            wipe(macKey)
            throw new Error('无法解密，密码或数据不匹配')
        }
        const parsed = JSON.parse(json)
        this.accounts = Array.isArray(parsed) ? parsed : []
        this.encKey = encKey
        this.macKey = macKey
        this.failedAttempts = 0
        return true
    },

    async setPin(pin, oldPin) {
        if (this.hasPin && !this.encKey) throw new Error('请先解锁')
        const salt = bytesToBase64(randomBytes(16))
        this.meta.salt = salt
        this.meta.iterations = ITERATIONS
        this.meta.pin = true
        const { encKey, macKey } = deriveKeys(pin, salt, ITERATIONS)
        this.encKey = encKey
        this.macKey = macKey
        await this.persist()
    },

    async clearPin() {
        if (!this.unlocked) throw new Error('请先解锁')
        this.meta.pin = false
        this.meta.salt = ''
        this.meta.blob = null
        wipe(this.encKey)
        wipe(this.macKey)
        this.encKey = null
        this.macKey = null
        await this.persist()
    },

    /** 写回存储；有 PIN 时加密 */
    async persist() {
        const accounts = this.accounts || []
        if (this.hasPin) {
            if (!this.encKey) throw new Error('请先解锁')
            const iv = randomBytes(16)
            const ct = aesCbcEncrypt(this.encKey, iv, utf8(JSON.stringify(accounts)))
            this.meta.blob = {
                iv: bytesToBase64(iv),
                ct: bytesToBase64(ct),
                tag: bytesToBase64(tagFor(this.macKey, iv, ct))
            }
            this.meta.accounts = []
        } else {
            this.meta.accounts = accounts
            this.meta.blob = null
        }
        this.meta.updatedAt = Date.now()
        this.meta.verifier = hmac('SHA256', utf8(VERIFIER_TEXT), utf8(this.meta.salt || '')).slice(0, 8).map(b => b.toString(16)).join('')
        try {
            await storage.setStorage(KEY_VAULT, JSON.stringify(this.meta))
        } catch (e) {
            // 目录缺失时第一次写会失败：补建目录后再试一次
            ensureStorageDir(true)
            await sleepMs(200)
            await storage.setStorage(KEY_VAULT, JSON.stringify(this.meta))
        }
    },

    list() {
        return this.accounts.slice()
    },

    find(id) {
        return this.accounts.find(a => a.id === id) || null
    },

    async add(item) {
        const account = {
            id: randomId(),
            issuer: item.issuer || '',
            account: item.account || '',
            secret: item.secret,
            type: item.type === 'hotp' ? 'hotp' : 'totp',
            algorithm: item.algorithm || 'SHA1',
            digits: Number(item.digits) || 6,
            period: Number(item.period) || 30,
            counter: Number(item.counter) || 0,
            note: item.note || '',
            createdAt: Date.now()
        }
        this.accounts.push(account)
        await this.persist()
        return account
    },

    /** 批量添加账号（自动跳过重复密钥，仅执行一次持久化写入） */
    async addMany(items) {
        if (!Array.isArray(items) || !items.length) {
            return { added: 0, skipped: 0, accounts: [] }
        }
        let added = 0
        let skipped = 0
        const created = []
        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            if (!item || !item.secret || this.hasDuplicate(item.secret)) {
                skipped++
                continue
            }
            const account = {
                id: randomId() + '_' + i,
                issuer: item.issuer || '',
                account: item.account || '',
                secret: item.secret,
                type: item.type === 'hotp' ? 'hotp' : 'totp',
                algorithm: item.algorithm || 'SHA1',
                digits: Number(item.digits) || 6,
                period: Number(item.period) || 30,
                counter: Number(item.counter) || 0,
                note: item.note || '',
                createdAt: Date.now()
            }
            this.accounts.push(account)
            created.push(account)
            added++
        }
        if (added > 0) {
            await this.persist()
        }
        return { added, skipped, accounts: created }
    },

    async update(id, patch) {
        const idx = this.accounts.findIndex(a => a.id === id)
        if (idx < 0) throw new Error('账号不存在')
        this.accounts[idx] = Object.assign({}, this.accounts[idx], patch)
        await this.persist()
        return this.accounts[idx]
    },

    async remove(id) {
        this.accounts = this.accounts.filter(a => a.id !== id)
        await this.persist()
    },

    async move(id, delta) {
        const idx = this.accounts.findIndex(a => a.id === id)
        const next = idx + delta
        if (idx < 0 || next < 0 || next >= this.accounts.length) return
        const [item] = this.accounts.splice(idx, 1)
        this.accounts.splice(next, 0, item)
        await this.persist()
    },

    /** 是否存在重复密钥（同一 secret 视为同一账号） */
    hasDuplicate(secret) {
        return this.accounts.some(a => a.secret === secret)
    },

    /** 清除内存中的密钥与账号明文 */
    lock() {
        wipe(this.encKey)
        wipe(this.macKey)
        this.encKey = null
        this.macKey = null
        this.accounts = []
    },

    /** 全量替换（导入备份） */
    async replaceAll(items) {
        this.accounts = items.slice()
        await this.persist()
    }
}

export { KEY_VAULT }
