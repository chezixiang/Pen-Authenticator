<template>
    <div class="page">
        <div class="header">
            <div class="brand">
                <text class="logo">A</text>
                <div class="brand-text">
                    <text class="title">验证器</text>
                    <text class="subtitle">{{ subtitle }}</text>
                </div>
            </div>
            <div class="header-actions">
                <text class="action" @click="goScan">扫码添加</text>
                <text class="action" @click="goEdit">手动添加</text>
                <text class="action-ghost" @click="goSettings">设置</text>
            </div>
        </div>

        <div class="body">
            <div class="list-panel">
                <scroller class="list" scroll-direction="vertical" show-scrollbar="false">
                    <div class="list-inner">
                        <div
                            v-for="item in accounts"
                            :key="item.id"
                            class="row"
                            :class="{ 'row-active': item.id === activeId }"
                            @click="select(item.id)"
                        >
                            <text class="row-badge" :style="{ backgroundColor: colorOf(item) }">{{ initialOf(item) }}</text>
                            <div class="row-text">
                                <text class="row-title">{{ titleOf(item) }}</text>
                                <text class="row-sub">{{ item.account || '（无账号名）' }}</text>
                            </div>
                            <text class="row-code">{{ codeOf(item) }}</text>
                        </div>
                        <div v-if="!accounts.length" class="empty">
                            <text class="empty-title">还没有账号</text>
                            <text class="empty-sub">扫描网站安全设置里的二维码即可添加</text>
                        </div>
                    </div>
                </scroller>
            </div>

            <div class="detail-panel">
                <div v-if="current" class="detail">
                    <div class="detail-head">
                        <div class="detail-names">
                            <text class="detail-title">{{ titleOf(current) }}</text>
                            <text class="detail-sub">{{ current.account || '未填写账号名' }} · {{ metaOf(current) }}</text>
                        </div>
                        <div class="detail-actions">
                            <text class="mini-btn" @click="goEdit(current.id)">编辑</text>
                            <text class="mini-danger" @click="confirmDelete">删除</text>
                        </div>
                    </div>

                    <div class="code-area">
                        <text class="code">{{ displayCode }}</text>
                    </div>

                    <div class="progress-track">
                        <div class="progress-fill" :style="{ width: progressPercent + '%', backgroundColor: progressColor }"></div>
                    </div>
                    <div class="foot">
                        <text class="foot-text">{{ current.type === 'hotp' ? 'HOTP：每次生成后需递增计数' : remaining + ' 秒后刷新' }}</text>
                        <text v-if="current.type === 'hotp'" class="mini-btn" @click="nextHotp">下一个</text>
                        <text v-else class="foot-dim">{{ progressPercent }}%</text>
                    </div>
                </div>

                <div v-else class="welcome">
                    <text class="welcome-title">双因素验证器</text>
                    <text class="welcome-line">· 支持 TOTP / HOTP，SHA1 / SHA256 / SHA512</text>
                    <text class="welcome-line">· 支持扫码/导入 otpauth 与 Google 验证器转移码</text>
                    <text class="welcome-line">· 可在设置里开启 PIN 加密保护或导出转移码</text>
                    <div class="welcome-actions">
                        <text class="primary" @click="goScan">扫描二维码</text>
                        <text class="secondary" @click="goEdit">手动输入</text>
                    </div>
                </div>
            </div>
        </div>

        <div v-if="banner" class="banner">{{ banner }}</div>
    </div>
</template>

<script>
import { vault } from '../../lib/vault.js'
import { totpFromSecret, formatCode, hotp } from '../../lib/totp.js'
import { base32Decode } from '../../lib/base32.js'

const REFRESH_MS = 250

export default {
    name: 'index',
    data() {
        return {
            accounts: [],
            activeId: '',
            now: Date.now(),
            codes: {},
            banner: '',
            unlocked: false
        }
    },
    computed: {
        current() {
            return this.accounts.find(a => a.id === this.activeId) || null
        },
        displayCode() {
            if (!this.current) return ''
            return formatCode(this.codes[this.current.id] || '······')
        },
        remaining() {
            if (!this.current) return 0
            const period = Number(this.current.period) || 30
            const seconds = Math.floor(this.now / 1000)
            return period - (seconds % period)
        },
        progressPercent() {
            if (!this.current) return 0
            const period = Number(this.current.period) || 30
            return Math.max(0, Math.min(100, Math.round((this.remaining / period) * 100)))
        },
        progressColor() {
            const p = this.progressPercent
            if (p <= 20) return '#e8710a'
            if (p <= 45) return '#1a73e8'
            return '#0f9d58'
        },
        subtitle() {
            if (!this.accounts.length) return '暂无账号'
            return this.accounts.length + ' 个账号'
        }
    },
    mounted() {
        this.boot()
    },
    beforeUnmount() {
        this.stopTimer()
    },
    destroyed() {
        this.stopTimer()
    },
    methods: {
        // 从编辑/扫码/设置页返回时刷新列表（页面实例还在栈里，不会重新 mounted）。
        // 注意：框架是直接调用 `this.$root.onShow()`，所以必须放在 methods 里，
        // 写成顶层选项 Vue3 不会挂到实例上，回调永远不会触发。
        onShow() {
            if (!this.unlocked) {
                if (vault.unlocked && vault.hasPin) {
                    this.unlocked = true
                    this.loadAccounts()
                    this.startTimer()
                }
                return
            }
            this.loadAccounts()
        },
        async boot() {
            try {
                await vault.init()
            } catch (e) {
                this.banner = '本地数据读取失败：' + e.message
            }
            if (vault.hasPin && !vault.unlocked) {
                $falcon.navTo('unlock')
                return
            }
            this.unlocked = true
            this.loadAccounts()
            this.startTimer()
        },
        loadAccounts() {
            this.accounts = vault.list()
            if (!this.accounts.length) {
                this.activeId = ''
            } else if (!this.accounts.some(a => a.id === this.activeId)) {
                this.activeId = this.accounts[0].id
            }
            this.now = Date.now()
            this.refreshCodes(true)
        },
        startTimer() {
            if (this._timer) return
            this._timer = setInterval(() => {
                this.now = Date.now()
                this.refreshCodes(false)
            }, REFRESH_MS)
        },
        stopTimer() {
            if (this._timer) {
                clearInterval(this._timer)
                this._timer = null
            }
        },
        refreshCodes(force) {
            const next = Object.assign({}, this.codes)
            const seconds = Math.floor(this.now / 1000)
            for (const item of this.accounts) {
                const period = Number(item.period) || 30
                const slot = Math.floor(seconds / period)
                if (!force && next['slot_' + item.id] === slot && next[item.id]) continue
                try {
                    if (item.type === 'hotp') {
                        next[item.id] = hotp(base32Decode(item.secret), Number(item.counter) || 0, Number(item.digits) || 6, item.algorithm || 'SHA1')
                    } else {
                        next[item.id] = totpFromSecret(item.secret, item, this.now).code
                    }
                } catch (e) {
                    next[item.id] = '错误'
                }
                next['slot_' + item.id] = slot
            }
            this.codes = next
        },
        codeOf(item) {
            return this.codes[item.id] || '······'
        },
        titleOf(item) {
            return item.issuer || item.account || '未命名'
        },
        initialOf(item) {
            return String(this.titleOf(item) || '?').slice(0, 1).toUpperCase()
        },
        metaOf(item) {
            const algorithm = item.algorithm || 'SHA1'
            const digits = Number(item.digits) || 6
            const period = Number(item.period) || 30
            return item.type === 'hotp' ? `${algorithm} · ${digits} 位 · HOTP` : `${algorithm} · ${digits} 位 · ${period}s`
        },
        colorOf(item) {
            const palette = ['#1a73e8', '#0f9d58', '#e8710a', '#9334e6', '#d93025', '#00838f']
            let sum = 0
            const text = String(item.issuer || item.account || item.id)
            for (let i = 0; i < text.length; i++) sum += text.charCodeAt(i)
            return palette[sum % palette.length]
        },
        select(id) {
            this.activeId = id
        },
        goScan() {
            if (!this.unlocked) return
            $falcon.navTo('scan')
        },
        goEdit(id) {
            if (!this.unlocked) return
            $falcon.navTo('edit', id ? { id } : {})
        },
        goSettings() {
            if (!this.unlocked) return
            $falcon.navTo('settings')
        },
        async nextHotp() {
            const item = this.current
            if (!item) return
            await vault.update(item.id, { counter: (Number(item.counter) || 0) + 1 })
            this.loadAccounts()
        },
        async confirmDelete() {
            const item = this.current
            if (!item) return
            if (this._pendingDelete === item.id) {
                await vault.remove(item.id)
                this._pendingDelete = ''
                this.banner = '已删除 ' + this.titleOf(item)
                this.loadAccounts()
                this.setBanner('', 1500)
                return
            }
            this._pendingDelete = item.id
            this.banner = '再点一次"删除"确认删除 ' + this.titleOf(item)
            this.setBanner('', 3500)
        },
        setBanner(text, delay) {
            if (this._bannerTimer) clearTimeout(this._bannerTimer)
            this.banner = text
            if (delay) {
                this._bannerTimer = setTimeout(() => { this.banner = '' }, delay)
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

.header {
    height: 46px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    background-color: #ffffff;
    border-bottom-width: 1px;
    border-bottom-color: #e6e8eb;
}

.brand {
    flex-direction: row;
    align-items: center;
}

.logo {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background-color: #1a73e8;
    color: #ffffff;
    font-size: 16px;
    text-align: center;
    line-height: 26px;
    margin-right: 8px;
}

.brand-text {
    flex-direction: column;
}

.title {
    font-size: 16px;
    color: #1b1c1e;
    font-weight: bold;
}

.subtitle {
    font-size: 11px;
    color: #8a8f98;
}

.header-actions {
    flex-direction: row;
    align-items: center;
}

.action {
    font-size: 13px;
    color: #1a73e8;
    padding: 6px 10px;
    margin-left: 6px;
    border-radius: 14px;
    background-color: #eaf1fd;
}

.action-ghost {
    font-size: 13px;
    color: #5f6368;
    background-color: #f1f3f4;
    padding: 6px 10px;
    margin-left: 6px;
    border-radius: 14px;
}

.body {
    flex: 1;
    flex-direction: row;
    padding: 8px;
}

.list-panel {
    width: 336px;
    background-color: #ffffff;
    border-radius: 10px;
    margin-right: 8px;
    overflow: hidden;
}

.list {
    flex: 1;
}

.list-inner {
    flex-direction: column;
    padding: 4px;
}

.row {
    flex-direction: row;
    align-items: center;
    padding: 7px 8px;
    border-radius: 8px;
    margin-bottom: 2px;
}

.row-active {
    background-color: #eaf1fd;
}

.row-badge {
    width: 26px;
    height: 26px;
    border-radius: 13px;
    color: #ffffff;
    font-size: 13px;
    text-align: center;
    line-height: 26px;
    margin-right: 8px;
}

.row-text {
    flex: 1;
    flex-direction: column;
}

.row-title {
    font-size: 14px;
    color: #1b1c1e;
}

.row-sub {
    font-size: 11px;
    color: #8a8f98;
    margin-top: 1px;
}

.row-code {
    font-size: 15px;
    color: #5f6368;
    font-family: monospace;
}

.empty {
    flex-direction: column;
    align-items: center;
    padding: 40px 12px;
}

.empty-title {
    font-size: 15px;
    color: #5f6368;
}

.empty-sub {
    font-size: 11px;
    color: #9aa0a6;
    margin-top: 6px;
    text-align: center;
}

.detail-panel {
    flex: 1;
    background-color: #ffffff;
    border-radius: 10px;
    padding: 12px 16px;
}

.detail {
    flex: 1;
    flex-direction: column;
}

.detail-head {
    flex-direction: row;
    align-items: flex-start;
    justify-content: space-between;
}

.detail-names {
    flex-direction: column;
    flex: 1;
}

.detail-title {
    font-size: 17px;
    color: #1b1c1e;
    font-weight: bold;
}

.detail-sub {
    font-size: 11px;
    color: #8a8f98;
    margin-top: 2px;
}

.detail-actions {
    flex-direction: row;
}

.mini-btn {
    font-size: 12px;
    color: #5f6368;
    background-color: #f1f3f4;
    padding: 5px 10px;
    border-radius: 12px;
    margin-left: 6px;
}

.mini-danger {
    font-size: 12px;
    color: #d93025;
    background-color: #fce8e6;
    padding: 5px 10px;
    border-radius: 12px;
    margin-left: 6px;
}

.code-area {
    flex: 1;
    align-items: center;
    justify-content: center;
}

.code {
    font-size: 62px;
    color: #1b1c1e;
    font-family: monospace;
    letter-spacing: 4px;
}

.progress-track {
    height: 6px;
    border-radius: 3px;
    background-color: #eceff1;
    overflow: hidden;
}

.progress-fill {
    height: 6px;
    border-radius: 3px;
}

.foot {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
}

.foot-text {
    font-size: 11px;
    color: #5f6368;
}

.foot-dim {
    font-size: 11px;
    color: #9aa0a6;
}

.welcome {
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}

.welcome-title {
    font-size: 20px;
    color: #1b1c1e;
    font-weight: bold;
    margin-bottom: 8px;
}

.welcome-line {
    font-size: 12px;
    color: #5f6368;
    margin-bottom: 3px;
}

.welcome-actions {
    flex-direction: row;
    margin-top: 12px;
}

.primary {
    font-size: 14px;
    color: #ffffff;
    background-color: #1a73e8;
    padding: 8px 20px;
    border-radius: 18px;
    margin-right: 10px;
}

.secondary {
    font-size: 14px;
    color: #1a73e8;
    background-color: #eaf1fd;
    padding: 8px 20px;
    border-radius: 18px;
}

.banner {
    position: absolute;
    left: 20px;
    right: 20px;
    bottom: 10px;
    font-size: 12px;
    color: #ffffff;
    background-color: rgba(32, 33, 36, 0.86);
    padding: 7px 12px;
    border-radius: 16px;
    text-align: center;
}
</style>
