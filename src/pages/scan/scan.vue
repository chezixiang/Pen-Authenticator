<template>
    <div class="page">
        <div class="bar">
            <text class="back" @click="close">‹ 返回</text>
            <text class="bar-title">扫码添加</text>
            <text class="bar-right">{{ statusShort }}</text>
        </div>

        <div class="body">
            <div class="cam">
                <image v-if="frame" class="cam-img" :src="frame" resize="cover" />
                <div v-else class="cam-wait">
                    <text class="cam-wait-text">{{ camHint }}</text>
                </div>
                <div v-if="frame && !parsed" class="guide">
                    <div class="guide-corner guide-tl"></div>
                    <div class="guide-corner guide-tr"></div>
                    <div class="guide-corner guide-bl"></div>
                    <div class="guide-corner guide-br"></div>
                </div>
            </div>

            <div class="side">
                <div v-if="parsedList.length > 1" class="result">
                    <text class="result-flag">{{ resultFlagText }}</text>
                    <text class="result-batch-title">共 {{ parsedList.length }} 个账号（可新增 {{ newCount }} 个{{ dupCount ? ' · 已存在 ' + dupCount + ' 个' : '' }}）</text>
                    <scroller class="mig-list" scroll-direction="vertical" show-scrollbar="false">
                        <div class="mig-list-inner">
                            <div v-for="(item, idx) in parsedList" :key="idx" class="mig-row">
                                <text class="mig-name">{{ itemTitle(item) }}</text>
                                <text class="mig-tag" :class="{ 'mig-tag-dup': isDup(item) }">{{ isDup(item) ? '已存在' : (item.type === 'hotp' ? 'HOTP' : item.digits + '位') }}</text>
                            </div>
                        </div>
                    </scroller>
                    <div class="actions">
                        <text v-if="hasMoreBatches" class="btn-primary" @click="confirmAdd(true)">添加并扫下一张</text>
                        <text class="btn-primary" v-else @click="confirmAdd(false)">{{ newCount > 0 ? '全部添加 (' + newCount + ')' : '全部已存在' }}</text>
                        <text v-if="hasMoreBatches" class="btn-ghost" @click="confirmAdd(false)">添加并完成</text>
                        <text class="btn-ghost" @click="rescan">重扫</text>
                    </div>
                </div>

                <div v-else-if="parsed" class="result">
                    <text class="result-flag">{{ resultFlagText }}</text>
                    <text class="result-name">{{ parsed.issuer || parsed.account || '未命名' }}</text>
                    <text class="result-sub">{{ parsed.account || '（无账号名）' }} · {{ parsed.algorithm }} · {{ parsed.digits }} 位 · {{ parsed.type === 'hotp' ? 'HOTP' : parsed.period + 's' }}</text>
                    <text class="result-secret">密钥 {{ masked }}</text>
                    <div class="actions">
                        <text v-if="hasMoreBatches" class="btn-primary" @click="confirmAdd(true)">添加并扫下一张</text>
                        <text v-else class="btn-primary" @click="confirmAdd(false)">添加到验证器</text>
                        <text v-if="hasMoreBatches" class="btn-ghost" @click="confirmAdd(false)">添加并完成</text>
                        <text class="btn-ghost" @click="rescan">重新扫描</text>
                    </div>
                </div>

                <div v-else class="tips">
                    <text class="tip-title">{{ statusTitle }}</text>
                    <text class="tip">{{ statusSub }}</text>
                    <text class="tip-sub">支持普通 2FA 二维码与 Google 验证器「转移账号」二维码（多账号转移建议每次选 1-4 个导出）</text>
                    <div class="actions">
                        <text v-if="camFailed || timedOut" class="btn-primary" @click="retryCamera">重试</text>
                        <text class="btn-ghost" @click="goManual">手动输入</text>
                        <text class="btn-ghost" @click="goImport">从文件导入</text>
                    </div>
                </div>
            </div>
        </div>

        <div v-if="banner" class="banner">{{ banner }}</div>
    </div>
</template>

<script>
import fs from 'fs'
import globalModule from 'global'
import { vault } from '../../lib/vault.js'
import { parseOtpInputs, extractUris } from '../../lib/otpauth.js'
import { bytesToBase64, base64ToBytesAsync, utf8 } from '../../lib/bytes.js'
import { decodeQr, grayToBitsAsync } from '../../lib/qrdec.js'
import {
    CAM_DIR, DECODE_W, DECODE_H, feedScriptBody, feedScriptPath, stopFeedCmd, pad6
} from '../../lib/camera.js'

const SCAN_TIMEOUT = 60000
// 33ms 一轮（≈30Hz）：比 24fps 快一档，扣掉渲染开销后仍稳定在 24fps 以上；
// 用绝对时间排程（_nextTick 栅格），避免每轮误差累积导致掉到 20fps 以下
const PREVIEW_TICK = 33
const DECODE_TICK = 60

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/** 分块计算之间的让出：把主线程还给预览循环（24fps 的关键） */
function yieldNow() {
    return sleep(1)
}

function num6(name, prefix) {
    // p_000123.jpg → 123
    return parseInt(name.slice(prefix.length, prefix.length + 6), 10) || 0
}

export default {
    name: 'scan',
    data() {
        return {
            frame: '',
            camHint: '相机启动中…',
            statusTitle: '把二维码放进取景框',
            statusSub: '笔头离屏幕 5-10cm，二维码占满取景框',
            statusShort: '识别中',
            parsed: null,
            parsedList: [],
            isMigration: false,
            batchSize: 1,
            batchIndex: 0,
            batchId: 0,
            scannedBatches: {},
            banner: '',
            camFailed: false,
            timedOut: false
        }
    },
    computed: {
        masked() {
            const secret = (this.parsed && this.parsed.secret) || ''
            if (secret.length <= 8) return secret
            return secret.slice(0, 4) + ' ···· ' + secret.slice(-4)
        },
        resultFlagText() {
            if (!this.isMigration) return '识别成功'
            if (this.batchSize > 1) {
                return `Google 转移码 · 第 ${this.batchIndex + 1}/${this.batchSize} 张`
            }
            return 'Google 转移码 · 识别成功'
        },
        newCount() {
            let count = 0
            const seen = {}
            for (let i = 0; i < this.parsedList.length; i++) {
                const s = this.parsedList[i].secret
                if (!seen[s] && !vault.hasDuplicate(s)) {
                    seen[s] = true
                    count++
                }
            }
            return count
        },
        dupCount() {
            return Math.max(0, this.parsedList.length - this.newCount)
        },
        hasMoreBatches() {
            if (!this.isMigration || this.batchSize <= 1) return false
            const doneCount = Object.keys(this.scannedBatches).length
            const already = !!this.scannedBatches[this.batchIndex]
            return (doneCount + (already ? 0 : 1)) < this.batchSize
        }
    },
    mounted() {
        this._alive = true
        this._loopId = 0
        this._lastPreview = 0
        this._scanIndex = 0
        this._lastSeq = 0
        this.g = new globalModule.Global()
        this.boot()
    },
    beforeUnmount() {
        this.teardown()
    },
    destroyed() {
        this.teardown()
    },
    methods: {
        isDup(item) {
            return !!(item && vault.hasDuplicate(item.secret))
        },
        itemTitle(item) {
            const issuer = item.issuer || ''
            const account = item.account || ''
            if (issuer && account) return issuer + ' (' + account + ')'
            return issuer || account || '未命名'
        },
        async boot() {
            this.camFailed = false
            this.timedOut = false
            try {
                await vault.init()
                await this.startFeed()
            } catch (e) {
                const msg = (e && e.message) || String(e)
                this.camFailed = true
                this.camHint = '相机启动失败：' + msg
                this.statusTitle = '相机启动失败'
                this.statusSub = msg
                return
            }
            this.camHint = ''
            this.startLoops()
        },
        async retryCamera() {
            this.timedOut = false
            this._loopId++
            this.stopCamera()
            await sleep(400)
            this.frame = ''
            this._lastPreview = 0
            this._scanIndex = 0
            this._lastSeq = 0
            this.camHint = '相机启动中…'
            this.statusTitle = '把二维码放进取景框'
            this.statusSub = '笔头离屏幕 5-10cm，二维码占满取景框'
            return this.boot()
        },
        async startFeed() {
            const body = feedScriptBody(CAM_DIR)
            const b64 = bytesToBase64(utf8(body))
            const path = feedScriptPath()
            // execShell 是同步阻塞的，这里只用三次短命令（脚本 ~2KB，几十毫秒）
            this.g.execShell("echo '" + b64 + "' | base64 -d > " + path)
            this.g.execShell('chmod 755 ' + path)
            this.g.execShell('rm -f ' + CAM_DIR + '.stop; nohup sh ' + path + ' </dev/null >/dev/null 2>&1 &')
            const deadline = Date.now() + 9000
            while (Date.now() < deadline) {
                await sleep(120)
                // 不能等固定的 p_000001.jpg：max-files=16 时它 570ms 就被删了
                if (await this.hasPreview()) {
                    // 管道确认出帧后再放行循环（失败则保持 _feedStopped，预览循环不会空转）
                    this._feedStopped = false
                    return
                }
            }
            throw new Error('取景管道没有出帧（相机可能被占用）')
        },
        async hasPreview() {
            try {
                const names = await fs.readdir(CAM_DIR)
                for (let i = 0; i < names.length; i++) {
                    if (names[i].charCodeAt(0) === 112 && names[i].charCodeAt(1) === 95) return true
                }
            } catch (e) { /* 忽略 */ }
            return false
        },
        startLoops() {
            // 每轮循环带一个 id：重新拉起时旧循环会自己退出，避免出现两条预览循环
            const id = ++this._loopId
            this.previewLoop(id)
            this.decodeLoop(id)
        },
        /** 24fps 预览：只做 exists/readdir + 改 image 的 src，不碰 execShell */
        async previewLoop(id) {
            let missTicks = 0
            this._nextTick = Date.now()
            // _feedStopped：识别成功/超时会停掉取景，循环跟着退出，
            // 不然会一直空探已删除的帧文件、白烧 CPU（实测 top 里 miniapp 22%）
            while (this._alive && id === this._loopId && !this._feedStopped) {
                // 用 exists 试探后续帧号：每次 ~0.3ms，比 readdir（~2ms）便宜得多
                let known = this._scanIndex || this._lastPreview
                for (let k = 0; k < 4; k++) {
                    if (await fs.exists(CAM_DIR + '/p_' + pad6(known + 1) + '.jpg')) known++
                    else break
                }
                if (known === this._scanIndex) {
                    // 长时间没进展（管道重启、帧号从头开始）就退回 readdir 重新同步
                    if (++missTicks > 30) {
                        missTicks = 0
                        const sync = await this.latestPreview()
                        if (sync > 0) {
                            this._scanIndex = sync
                            known = sync
                        }
                    }
                } else {
                    missTicks = 0
                    this._scanIndex = known
                }
                // 取倒数第二帧：最新的一帧可能还在写
                const show = known - 1
                if (show > this._lastPreview) {
                    this._lastPreview = show
                    this.frame = 'file://' + CAM_DIR + '/p_' + pad6(show) + '.jpg'
                }
                // 绝对时间排程：每帧对齐 PREVIEW_TICK 的栅格，避免误差累积
                this._nextTick += PREVIEW_TICK
                const tail = Date.now()
                if (this._nextTick < tail) this._nextTick = tail
                const wait = this._nextTick - tail
                await sleep(wait > 1 ? wait : 1)
            }
        },
        async latestPreview() {
            let maxN = 0
            try {
                const names = await fs.readdir(CAM_DIR)
                for (let i = 0; i < names.length; i++) {
                    const nm = names[i]
                    if (nm.charCodeAt(0) !== 112 || nm.charCodeAt(1) !== 95) continue
                    const n = num6(nm, 'p_')
                    if (n > maxN) maxN = n
                }
            } catch (e) { /* 忽略 */ }
            return maxN
        },
        /** 解码通道：读 shell 转好的 1-bit base64，纯 JS 解码 */
        async decodeLoop(id) {
            const deadline = Date.now() + SCAN_TIMEOUT
            while (this._alive && id === this._loopId && !this.parsed) {
                if (Date.now() > deadline) {
                    this.statusTitle = '没有识别到二维码'
                    this.statusSub = '换个角度、离屏幕近一点，或直接手动输入密钥'
                    this.statusShort = '已超时'
                    this.timedOut = true
                    // 超时后释放相机，省电（点「重试」会重新拉起）
                    this.stopCamera()
                    return
                }
                let seq = 0
                try {
                    seq = parseInt(String((await fs.readFile(CAM_DIR + '/q.seq')) || '').trim(), 10) || 0
                } catch (e) {
                    seq = 0
                }
                if (!seq || seq === this._lastSeq) {
                    await sleep(DECODE_TICK)
                    continue
                }
                this._lastSeq = seq
                let text = ''
                try {
                    const b64 = String((await fs.readFile(CAM_DIR + '/q.b64')) || '')
                    // q.b64 是 raw 灰度帧（288x288 = 82944 字节 → base64 约 110K 字符）。
                    // 二值化在 JS 侧做：这个固件的 ffmpeg 单次调用要 3.5 秒，放进循环会把系统拖死。
                    // 全程分块让出（yield = sleep(1)），否则 180ms 的同步计算会把预览循环饿到 14fps。
                    if (b64.length > 4096) {
                        const gray = await base64ToBytesAsync(b64, yieldNow)
                        if (gray.length >= DECODE_W * DECODE_H) {
                            const bits = await grayToBitsAsync(gray, DECODE_W, DECODE_H, yieldNow)
                            const r = decodeQr(bits)
                            if (r) text = r.text
                        }
                    }
                } catch (e) {
                    text = ''
                }
                if (text) {
                    this.onResult(text)
                    return
                }
                await sleep(DECODE_TICK)
            }
        },
        onResult(text) {
            const uris = extractUris(text)
            const hasOtpScheme = uris.length > 0 || /^otpauth(?:-migration)?:\/\//i.test(String(text || '').trim())
            if (!hasOtpScheme) {
                // 扫到别的二维码（网址、名片…）时提示一下，继续扫
                this.statusTitle = '识别到内容，但不是验证器二维码'
                this.statusSub = String(text).slice(0, 60)
                return
            }
            try {
                const res = parseOtpInputs(text)
                if (res.isMigration && this.batchId && res.batchId && res.batchId !== this.batchId) {
                    this.scannedBatches = {}
                }
                this.parsedList = res.accounts
                this.parsed = res.accounts[0] || null
                this.isMigration = !!res.isMigration
                this.batchSize = res.batchSize || 1
                this.batchIndex = res.batchIndex || 0
                this.batchId = res.batchId || 0
                this.statusShort = '已识别'
                this.statusTitle = res.isMigration ? 'Google 转移码识别成功' : '识别成功'
                this.statusSub = '确认后添加到验证器'
                // 识别成功就不再占相机，省电；点「重新扫描」会重新拉起
                this.stopCamera()
            } catch (e) {
                this.statusTitle = '二维码内容无法解析'
                this.statusSub = e.message
            }
        },
        async rescan() {
            this.parsed = null
            this.parsedList = []
            this.statusTitle = '把二维码放进取景框'
            this.statusSub = '笔头离屏幕 5-10cm，二维码占满取景框'
            this.statusShort = '识别中'
            this._lastSeq = 0
            this._lastPreview = 0
            this._scanIndex = 0
            this.frame = ''
            this.timedOut = false
            if (this._feedStopped) {
                try {
                    await this.startFeed()
                } catch (e) {
                    this.camFailed = true
                    this.camHint = '相机启动失败：' + e.message
                    this.statusTitle = '相机启动失败'
                    this.statusSub = e.message
                    return
                }
                this.startLoops()
            }
        },
        stopCamera() {
            this._feedStopped = true
            try {
                this.g.execShell(stopFeedCmd(CAM_DIR))
            } catch (e) { /* 忽略 */ }
        },
        async confirmAdd(continueNext = false) {
            if (!this.parsedList.length && !this.parsed) return
            const list = this.parsedList.length ? this.parsedList : [this.parsed]
            try {
                if (list.length === 1) {
                    const item = list[0]
                    if (vault.hasDuplicate(item.secret)) {
                        if (continueNext) {
                            this.scannedBatches = Object.assign({}, this.scannedBatches, { [this.batchIndex]: true })
                            this.setBanner('该账号已存在，请继续扫描下一张')
                            await this.rescan()
                            return
                        }
                        this.setBanner('该密钥已存在')
                        return
                    }
                    await vault.add(item)
                    if (continueNext) {
                        this.scannedBatches = Object.assign({}, this.scannedBatches, { [this.batchIndex]: true })
                        const done = Object.keys(this.scannedBatches).length
                        this.setBanner(`已添加 1 个账号（批次 ${done}/${this.batchSize}），请扫下一张`, 2400)
                        await this.rescan()
                        return
                    }
                    this.parsed = null
                    this.parsedList = []
                    this.setBanner('已添加', 1200)
                    setTimeout(() => this.close(), 600)
                } else {
                    const { added, skipped } = await vault.addMany(list)
                    if (added === 0 && !continueNext) {
                        this.setBanner(`全部 ${skipped} 个账号均已存在`)
                        return
                    }
                    if (continueNext) {
                        this.scannedBatches = Object.assign({}, this.scannedBatches, { [this.batchIndex]: true })
                        const done = Object.keys(this.scannedBatches).length
                        this.setBanner(`已添加 ${added} 个（跳过 ${skipped} 个），批次 ${done}/${this.batchSize}，请扫下一张`, 2600)
                        await this.rescan()
                        return
                    }
                    this.parsed = null
                    this.parsedList = []
                    this.setBanner(`已添加 ${added} 个账号` + (skipped ? `（跳过重复 ${skipped} 个）` : ''), 1400)
                    setTimeout(() => this.close(), 700)
                }
            } catch (e) {
                this.setBanner('添加失败：' + e.message)
            }
        },
        goManual() {
            this.close()
            $falcon.navTo('edit')
        },
        goImport() {
            this.close()
            $falcon.navTo('settings')
        },
        setBanner(text, delay = 2400) {
            this.banner = text
            if (this._bannerTimer) clearTimeout(this._bannerTimer)
            this._bannerTimer = setTimeout(() => { this.banner = '' }, delay)
        },
        teardown() {
            if (!this._alive && this._stopped) return
            this._alive = false
            this._stopped = true
            try {
                if (this.g) this.g.execShell(stopFeedCmd(CAM_DIR))
            } catch (e) { /* 忽略 */ }
        },
        close() {
            this.teardown()
            try {
                this.$page.finish()
            } catch (e) {
                $falcon.closePageByName('scan')
            }
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
    height: 40px;
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
    padding: 6px;
}

.cam {
    width: 444px;
    height: 250px;
    background-color: #101418;
    border-radius: 10px;
    margin-right: 6px;
    align-items: center;
    justify-content: center;
}

.cam-img {
    width: 444px;
    height: 250px;
    border-radius: 10px;
}

.cam-wait {
    flex: 1;
    align-items: center;
    justify-content: center;
}

.cam-wait-text {
    font-size: 13px;
    color: #6b7683;
}

/* 取景框 = 解码裁剪区（640x360 中间的 288x288）在 444x250 预览里的投影 */
.guide {
    position: absolute;
    left: 122px;
    top: 25px;
    width: 200px;
    height: 200px;
}

.guide-corner {
    position: absolute;
    width: 26px;
    height: 26px;
    border-color: #1a73e8;
}

.guide-tl {
    left: 0;
    top: 0;
    border-left-width: 3px;
    border-top-width: 3px;
}

.guide-tr {
    right: 0;
    top: 0;
    border-right-width: 3px;
    border-top-width: 3px;
}

.guide-bl {
    left: 0;
    bottom: 0;
    border-left-width: 3px;
    border-bottom-width: 3px;
}

.guide-br {
    right: 0;
    bottom: 0;
    border-right-width: 3px;
    border-bottom-width: 3px;
}

.side {
    flex: 1;
    background-color: #ffffff;
    border-radius: 10px;
    padding: 8px 12px;
}

.tips {
    flex: 1;
    flex-direction: column;
}

.tip-title {
    font-size: 15px;
    color: #1b1c1e;
    font-weight: bold;
}

.tip {
    font-size: 12px;
    color: #5f6368;
    margin-top: 5px;
}

.tip-sub {
    font-size: 11px;
    color: #8a8f98;
    margin-top: 6px;
}

.result {
    flex: 1;
    flex-direction: column;
}

.result-flag {
    font-size: 11px;
    color: #0f9d58;
}

.result-name {
    font-size: 18px;
    color: #1b1c1e;
    font-weight: bold;
    margin-top: 2px;
}

.result-batch-title {
    font-size: 14px;
    color: #1b1c1e;
    font-weight: bold;
    margin-top: 2px;
}

.result-sub {
    font-size: 11px;
    color: #8a8f98;
    margin-top: 3px;
}

.result-secret {
    font-size: 12px;
    color: #5f6368;
    font-family: monospace;
    margin-top: 6px;
}

.mig-list {
    flex: 1;
    margin-top: 4px;
    margin-bottom: 4px;
    background-color: #f8f9fa;
    border-radius: 6px;
}

.mig-list-inner {
    flex-direction: column;
    padding: 4px 6px;
}

.mig-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 3px 2px;
}

.mig-name {
    flex: 1;
    font-size: 12px;
    color: #1b1c1e;
}

.mig-tag {
    font-size: 10px;
    color: #1a73e8;
    background-color: #eaf1fd;
    padding: 1px 6px;
    border-radius: 8px;
    margin-left: 6px;
}

.mig-tag-dup {
    color: #8a8f98;
    background-color: #e8eaed;
}

.actions {
    flex-direction: row;
    margin-top: auto;
}

.btn-primary {
    font-size: 13px;
    color: #ffffff;
    background-color: #1a73e8;
    padding: 7px 14px;
    border-radius: 16px;
    margin-right: 6px;
}

.btn-ghost {
    font-size: 13px;
    color: #5f6368;
    background-color: #f1f3f4;
    padding: 7px 12px;
    border-radius: 16px;
    margin-right: 6px;
}

.banner {
    position: absolute;
    left: 24px;
    right: 24px;
    bottom: 8px;
    font-size: 12px;
    color: #ffffff;
    background-color: rgba(32, 33, 36, 0.86);
    padding: 7px 12px;
    border-radius: 16px;
    text-align: center;
}
</style>
