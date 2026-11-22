<template>
    <div class="page">
        <div class="bar">
            <text class="back" @click="close">‹ 返回</text>
            <text class="bar-title">设置</text>
            <text class="bar-right">v{{ version }}</text>
        </div>

        <div class="body">
            <div class="card">
                <text class="card-title">安全</text>
                <div class="item" @click="togglePin">
                    <div class="item-text">
                        <text class="item-name">{{ hasPin ? 'PIN 保护已开启' : '开启 PIN 保护' }}</text>
                        <text class="item-sub">{{ hasPin ? '账号密钥使用 AES-256 加密存储' : '用 PIN 派生密钥加密本地密钥（推荐）' }}</text>
                    </div>
                    <text class="switch" :class="{ 'switch-on': hasPin }">{{ hasPin ? '关闭' : '开启' }}</text>
                </div>
                <div class="item" @click="lockNow">
                    <div class="item-text">
                        <text class="item-name">立即锁定</text>
                        <text class="item-sub">清除内存中的密钥，下次进入需重新输入 PIN</text>
                    </div>
                    <text class="chev">›</text>
                </div>
            </div>

            <div class="card">
                <text class="card-title">备份与 Google 转移</text>
                <div class="item" @click="openMigrationQr">
                    <div class="item-text">
                        <text class="item-name">Google 转移二维码</text>
                        <text class="item-sub">生成转移码，用手机 Google 验证器扫码导入</text>
                    </div>
                    <text class="chev">›</text>
                </div>
                <div class="item" @click="exportBackup">
                    <div class="item-text">
                        <text class="item-name">导出到文件</text>
                        <text class="item-sub">{{ exportHint }}</text>
                    </div>
                    <text class="chev">›</text>
                </div>
                <div class="item" @click="importBackup">
                    <div class="item-text">
                        <text class="item-name">从文件导入</text>
                        <text class="item-sub">{{ importHint }}</text>
                    </div>
                    <text class="chev">›</text>
                </div>
            </div>

            <div class="card">
                <text class="card-title">关于</text>
                <div class="item">
                    <div class="item-text">
                        <text class="item-name">Authenticator for 有道词典笔</text>
                        <text class="item-sub">支持 TOTP/HOTP · Google 2FA 转移 · 本地加密 · 扫码/文件导入</text>
                    </div>
                </div>
            </div>
        </div>

        <div class="qr-mask" v-if="qrModal">
            <div class="qr-box">
                <div class="qr-left">
                    <image v-if="qrImageSrc" class="qr-img" :src="qrImageSrc" resize="contain" />
                </div>
                <div class="qr-right">
                    <text class="qr-flag">Google 验证器转移导出 · 第 {{ qrIndex + 1 }}/{{ qrUris.length }} 张</text>
                    <text class="qr-title">手机打开 Google 验证器 → 转移账号 → 导入账号</text>
                    <text class="qr-sub">本张包含 {{ currentQrChunk.length }} 个账号（共 {{ totalExportCount }} 个）：</text>
                    <scroller class="qr-list" scroll-direction="vertical" show-scrollbar="false">
                        <div class="qr-list-inner">
                            <text v-for="(acc, i) in currentQrChunk" :key="i" class="qr-acc">· {{ acc.issuer || acc.account || '未命名' }}{{ acc.issuer && acc.account ? ' (' + acc.account + ')' : '' }}</text>
                        </div>
                    </scroller>
                    <div class="qr-actions">
                        <text v-if="qrUris.length > 1" class="qr-btn" @click="stepQr(-1)">上一张</text>
                        <text v-if="qrUris.length > 1" class="qr-btn-primary" @click="stepQr(1)">下一张</text>
                        <text class="qr-btn" @click="closeMigrationQr">关闭</text>
                    </div>
                </div>
            </div>
        </div>

        <div class="pin-mask" v-if="pinStage">
            <div class="pin-box">
                <text class="pin-title">{{ pinStage === 'set' ? '设置 6 位数字 PIN' : '再次输入以确认' }}</text>
                <text class="pin-dots">{{ pinDots }}</text>
                <div class="pin-pad">
                    <text v-for="n in 9" :key="n" class="pin-key" @click="pinInput(String(n))">{{ n }}</text>
                    <text class="pin-key" @click="pinInput('del')">←</text>
                    <text class="pin-key" @click="pinInput('0')">0</text>
                    <text class="pin-key" @click="pinStage = ''">取消</text>
                </div>
            </div>
        </div>

        <div v-if="banner" class="banner">{{ banner }}</div>
    </div>
</template>

<script>
import { vault } from '../../lib/vault.js'
import { buildOtpUri, buildMigrationUris, extractUris, parseOtpInputs } from '../../lib/otpauth.js'
import { qrToPngBase64 } from '../../lib/qrenc.js'
import { decodeQr, grayToBits } from '../../lib/qrdec.js'
import { utf8, bytesToBase64, base64ToBytes } from '../../lib/bytes.js'
import fs from 'fs'
import globalModule from 'global'

const EXPORT_DIR = '/userdisk/Authenticator'
// ydpen-toolkit 约定：/userdisk/Favorite 在 MTP 与文件管理器（8080 文件互传）中直接可见
const FAV_DIR = '/userdisk/Favorite/Authenticator'
const IMPORT_TEXT_CANDIDATES = [
    EXPORT_DIR + '/import.txt',
    FAV_DIR + '/import.txt',
    '/userdisk/Favorite/import.txt'
]
const IMPORT_IMG_CANDIDATES = [
    EXPORT_DIR + '/import.png',
    EXPORT_DIR + '/import.jpg',
    EXPORT_DIR + '/qr.png',
    EXPORT_DIR + '/qr.jpg',
    FAV_DIR + '/import.png',
    FAV_DIR + '/import.jpg',
    FAV_DIR + '/qr.png',
    FAV_DIR + '/qr.jpg'
]
const QR_BATCH_LIMIT = 3

export default {
    name: 'settings',
    data() {
        return {
            hasPin: false,
            version: '1.1.0',
            banner: '',
            exportHint: '生成 otpauth 与 Google 转移文件（MTP/SSH 可取）',
            importHint: '支持 import.txt (含 Google 转移链接) 或二维码图片',
            pinStage: '',
            pinBuffer: '',
            pinFirst: '',
            qrModal: false,
            qrUris: [],
            qrChunks: [],
            qrIndex: 0,
            qrImageSrc: '',
            totalExportCount: 0
        }
    },
    computed: {
        pinDots() {
            let text = ''
            for (let i = 0; i < 6; i++) text += i < this.pinBuffer.length ? '● ' : '○ '
            return text
        },
        currentQrChunk() {
            return this.qrChunks[this.qrIndex] || []
        }
    },
    mounted() {
        this.boot()
    },
    methods: {
        async boot() {
            await vault.init()
            this.hasPin = vault.hasPin
        },
        close() {
            try {
                this.$page.finish()
            } catch (e) {
                $falcon.closePageByName('settings')
            }
        },
        setBanner(text, delay = 2600) {
            this.banner = text
            if (this._bannerTimer) clearTimeout(this._bannerTimer)
            this._bannerTimer = setTimeout(() => { this.banner = '' }, delay)
        },
        toast(text) {
            this.setBanner(text, 2200)
        },
        async togglePin() {
            if (!vault.unlocked) {
                this.toast('请先解锁')
                return
            }
            if (this.hasPin) {
                await vault.clearPin()
                this.hasPin = false
                this.toast('已关闭 PIN 保护，密钥以明文保存在本机')
            } else {
                this.pinStage = 'set'
                this.pinBuffer = ''
                this.pinFirst = ''
            }
        },
        pinInput(key) {
            if (key === 'del') {
                this.pinBuffer = this.pinBuffer.slice(0, -1)
                this.$forceUpdate()
                return
            }
            if (this.pinBuffer.length >= 6) return
            this.pinBuffer += key
            this.$forceUpdate()
            if (this.pinBuffer.length === 6) {
                const pin = this.pinBuffer
                this.pinBuffer = ''
                if (!this.pinFirst) {
                    this.pinFirst = pin
                    this.pinStage = 'confirm'
                    this.$forceUpdate()
                } else if (this.pinFirst === pin) {
                    this.pinStage = ''
                    vault.setPin(pin).then(() => {
                        this.hasPin = true
                        this.toast('PIN 已开启，请牢记；忘记将无法恢复密钥')
                    }).catch(e => this.toast('设置失败：' + e.message))
                } else {
                    this.pinFirst = ''
                    this.pinStage = ''
                    this.toast('两次输入不一致，请重试')
                }
            }
        },
        async lockNow() {
            if (!vault.hasPin) {
                this.toast('未开启 PIN 保护')
                return
            }
            vault.lock()
            $falcon.navTo('unlock')
        },
        async openMigrationQr() {
            const items = vault.list()
            if (!items.length) {
                this.toast('没有可导出的账号')
                return
            }
            try {
                const chunks = []
                for (let i = 0; i < items.length; i += QR_BATCH_LIMIT) {
                    chunks.push(items.slice(i, i + QR_BATCH_LIMIT))
                }
                const uris = buildMigrationUris(items, QR_BATCH_LIMIT)
                this.qrChunks = chunks
                this.qrUris = uris
                this.qrIndex = 0
                this.totalExportCount = items.length
                this.qrModal = true
                await this.renderCurrentQr()
            } catch (e) {
                this.toast('生成转移二维码失败：' + e.message)
            }
        },
        async stepQr(delta) {
            if (!this.qrUris.length) return
            const len = this.qrUris.length
            this.qrIndex = (this.qrIndex + delta + len) % len
            await this.renderCurrentQr()
        },
        async renderCurrentQr() {
            const uri = this.qrUris[this.qrIndex]
            if (!uri) return
            const b64 = qrToPngBase64(uri, { targetSize: 192, ecLevel: 'M' })
            // 每次使用带时间戳的新文件名，绕开 Falcon 框架的图片 URL 缓存（见 ydpen-toolkit 07 §6）
            const tmpPath = `/tmp/auth_mig_${Date.now()}_${this.qrIndex}.png`
            try {
                const g = new globalModule.Global()
                g.execShell(`echo '${b64}' | base64 -d > ${tmpPath}`)
                await new Promise(r => setTimeout(r, 120))
                if (await fs.exists(tmpPath)) {
                    this.qrImageSrc = 'file://' + tmpPath
                    return
                }
            } catch (e) { /* 浏览器预览环境回退到 data URI */ }
            this.qrImageSrc = 'data:image/png;base64,' + b64
        },
        closeMigrationQr() {
            this.qrModal = false
            this.qrImageSrc = ''
            try {
                const g = new globalModule.Global()
                g.execShell('rm -f /tmp/auth_mig_*.png')
            } catch (e) { /* 忽略 */ }
        },
        async writeTextFile(path, text) {
            // 优先支持 ydpen-toolkit 自研 fs 插件的 writeFile，同时保留 execShell 写盘与浏览器 mock
            if (typeof fs.writeFile === 'function') {
                try {
                    const dir = path.slice(0, path.lastIndexOf('/'))
                    if (dir && typeof fs.mkdir === 'function') await fs.mkdir(dir)
                    await fs.writeFile(path, text)
                    if (await fs.exists(path)) return true
                } catch (e) { /* 回退到 execShell */ }
            }
            if (typeof fs._writeFile === 'function') {
                try {
                    await fs._writeFile(path, text)
                    if (await fs.exists(path)) return true
                } catch (e) { /* 忽略 */ }
            }
            const b64 = bytesToBase64(utf8(text))
            const dir = path.slice(0, path.lastIndexOf('/'))
            const g = new globalModule.Global()
            g.execShell(`mkdir -p "${dir}" && echo '${b64}' | base64 -d > "${path}"`)
            return true
        },
        async exportBackup() {
            const items = vault.list()
            if (!items.length) {
                this.toast('没有可导出的账号')
                return
            }
            const otpLines = items.map(buildOtpUri).join('\n') + '\n'
            const migLines = buildMigrationUris(items, 10).join('\n') + '\n'
            const stamp = this.stamp()
            const mainPath = `${EXPORT_DIR}/backup-${stamp}.txt`
            const migPath = `${EXPORT_DIR}/migration-${stamp}.txt`
            const favBackupPath = `${FAV_DIR}/backup-${stamp}.txt`
            const favMigPath = `${FAV_DIR}/migration-${stamp}.txt`
            try {
                await this.writeTextFile(mainPath, otpLines)
                await this.writeTextFile(migPath, migLines)
                await this.writeTextFile(favBackupPath, otpLines)
                await this.writeTextFile(favMigPath, migLines)
                await new Promise(r => setTimeout(r, 500))
                const exists = (await fs.exists(mainPath)) || (await fs.exists(favBackupPath))
                if (exists) {
                    this.exportHint = `已导出 ${items.length} 个账号（含 Google 转移链接）`
                    this.toast(`已导出到 ${FAV_DIR} 与 ${EXPORT_DIR}`)
                } else {
                    this.toast('导出命令已提交，请到 ' + FAV_DIR + ' 查看')
                }
            } catch (e) {
                this.toast('导出失败：' + e.message)
            }
        },
        async importFromImage(imgPath) {
            const side = 360
            const grayPath = '/tmp/auth_imp.gray'
            const b64Path = '/tmp/auth_imp.b64'
            const g = new globalModule.Global()
            g.execShell(
                `rm -f ${grayPath} ${b64Path}; ` +
                `ffmpeg -y -i "${imgPath}" -vf "scale=${side}:${side}:force_original_aspect_ratio=decrease,pad=${side}:${side}:(ow-iw)/2:(oh-ih)/2:white" -vframes 1 -f rawvideo -pix_fmt gray ${grayPath} >/dev/null 2>&1 && ` +
                `base64 -w0 ${grayPath} > ${b64Path}`
            )
            const deadline = Date.now() + 6500
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 250))
                if (await fs.exists(b64Path)) {
                    const b64 = String((await fs.readFile(b64Path)) || '').trim()
                    if (b64.length > 4096) {
                        const gray = base64ToBytes(b64)
                        if (gray.length >= side * side) {
                            const bits = grayToBits(gray, side, side)
                            const r = decodeQr(bits)
                            if (r && r.text) return r.text
                        }
                    }
                    break
                }
            }
            throw new Error('未能从图片中识别出二维码')
        },
        async importBackup() {
            try {
                let foundPath = ''
                for (let i = 0; i < IMPORT_TEXT_CANDIDATES.length; i++) {
                    if (await fs.exists(IMPORT_TEXT_CANDIDATES[i])) {
                        foundPath = IMPORT_TEXT_CANDIDATES[i]
                        break
                    }
                }
                let rawText = ''
                if (foundPath) {
                    rawText = await fs.readFile(foundPath)
                } else {
                    let imgPath = ''
                    for (let i = 0; i < IMPORT_IMG_CANDIDATES.length; i++) {
                        if (await fs.exists(IMPORT_IMG_CANDIDATES[i])) {
                            imgPath = IMPORT_IMG_CANDIDATES[i]
                            break
                        }
                    }
                    if (!imgPath) {
                        this.toast(`未找到 import.txt，请放入 ${FAV_DIR}/import.txt 或 ${EXPORT_DIR}/import.txt`)
                        return
                    }
                    this.toast('正在解析二维码图片…')
                    rawText = await this.importFromImage(imgPath)
                }

                const uris = extractUris(rawText)
                if (!uris.length && !/^otpauth(?:-migration)?:\/\//i.test(String(rawText || '').trim())) {
                    this.toast('文件里没有 otpauth 或 Google 转移链接')
                    return
                }
                const candidate = uris.length ? uris.join('\n') : String(rawText || '').trim()
                const parsed = parseOtpInputs(candidate)
                const { added, skipped } = await vault.addMany(parsed.accounts)
                this.importHint = `导入 ${added} 个，跳过 ${skipped} 个`
                this.toast(`导入完成：新增 ${added} 个，跳过 ${skipped} 个`)
            } catch (e) {
                this.toast('导入失败：' + e.message)
            }
        },
        stamp() {
            const d = new Date()
            const p = n => (n < 10 ? '0' + n : '' + n)
            return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
        }
    }
}
</script>

<style lang="less" scoped>
.page {
    flex: 1;
    flex-direction: column;
    background-color: #f2f4f7;
}

.bar {
    height: 44px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    background-color: #ffffff;
    border-bottom-width: 1px;
    border-bottom-color: #e6e8eb;
}

.back {
    font-size: 14px;
    color: #1a73e8;
    width: 70px;
}

.bar-title {
    font-size: 15px;
    color: #1b1c1e;
    font-weight: bold;
}

.bar-right {
    font-size: 11px;
    color: #9aa0a6;
    width: 70px;
    text-align: right;
}

.body {
    flex: 1;
    flex-direction: row;
    padding: 8px;
}

.card {
    flex: 1;
    flex-direction: column;
    background-color: #ffffff;
    border-radius: 10px;
    padding: 8px 10px;
    margin-right: 8px;
}

.card-title {
    font-size: 12px;
    color: #8a8f98;
    margin-bottom: 4px;
}

.item {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 5px 2px;
}

.item-text {
    flex: 1;
    flex-direction: column;
}

.item-name {
    font-size: 13px;
    color: #1b1c1e;
}

.item-sub {
    font-size: 11px;
    color: #9aa0a6;
    margin-top: 1px;
}

.switch {
    font-size: 11px;
    color: #ffffff;
    background-color: #1a73e8;
    padding: 5px 10px;
    border-radius: 11px;
}

.switch-on {
    background-color: #d93025;
}

.chev {
    font-size: 16px;
    color: #c4c7cc;
}

.qr-mask {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
    background-color: rgba(22, 24, 28, 0.65);
    align-items: center;
    justify-content: center;
}

.qr-box {
    width: 680px;
    height: 230px;
    background-color: #ffffff;
    border-radius: 14px;
    padding: 12px;
    flex-direction: row;
}

.qr-left {
    width: 206px;
    height: 206px;
    background-color: #ffffff;
    border-width: 1px;
    border-color: #e6e8eb;
    border-radius: 8px;
    align-items: center;
    justify-content: center;
    margin-right: 14px;
}

.qr-img {
    width: 196px;
    height: 196px;
}

.qr-right {
    flex: 1;
    flex-direction: column;
}

.qr-flag {
    font-size: 11px;
    color: #0f9d58;
}

.qr-title {
    font-size: 14px;
    color: #1b1c1e;
    font-weight: bold;
    margin-top: 2px;
}

.qr-sub {
    font-size: 11px;
    color: #5f6368;
    margin-top: 4px;
}

.qr-list {
    flex: 1;
    margin-top: 4px;
    margin-bottom: 6px;
    background-color: #f8f9fa;
    border-radius: 6px;
}

.qr-list-inner {
    flex-direction: column;
    padding: 4px 8px;
}

.qr-acc {
    font-size: 12px;
    color: #1b1c1e;
    margin-bottom: 2px;
}

.qr-actions {
    flex-direction: row;
    justify-content: flex-end;
}

.qr-btn {
    font-size: 12px;
    color: #5f6368;
    background-color: #f1f3f4;
    padding: 6px 14px;
    border-radius: 14px;
    margin-left: 8px;
}

.qr-btn-primary {
    font-size: 12px;
    color: #ffffff;
    background-color: #1a73e8;
    padding: 6px 14px;
    border-radius: 14px;
    margin-left: 8px;
}

.pin-mask {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
    background-color: rgba(22, 24, 28, 0.55);
    align-items: center;
    justify-content: center;
}

.pin-box {
    width: 300px;
    background-color: #ffffff;
    border-radius: 14px;
    padding: 12px;
    flex-direction: column;
    align-items: center;
}

.pin-title {
    font-size: 13px;
    color: #1b1c1e;
}

.pin-dots {
    font-size: 20px;
    color: #1a73e8;
    margin: 8px 0;
    letter-spacing: 2px;
}

.pin-pad {
    flex-direction: row;
    flex-wrap: wrap;
    width: 270px;
}

.pin-key {
    width: 84px;
    height: 34px;
    font-size: 15px;
    color: #1b1c1e;
    background-color: #f1f3f4;
    text-align: center;
    line-height: 34px;
    margin: 3px;
    border-radius: 8px;
}

.banner {
    position: absolute;
    left: 24px;
    right: 24px;
    bottom: 10px;
    font-size: 12px;
    color: #ffffff;
    background-color: rgba(32, 33, 36, 0.86);
    padding: 7px 12px;
    border-radius: 16px;
    text-align: center;
}
</style>
