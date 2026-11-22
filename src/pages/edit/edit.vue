<template>
    <div class="page">
        <div class="bar">
            <text class="back" @click="close">‹ 返回</text>
            <text class="bar-title">{{ isEdit ? '编辑账号' : (migrationBatch.length > 1 ? '批量导入 (' + migrationBatch.length + ')' : '添加账号') }}</text>
            <div class="bar-actions">
                <text class="ghost-btn" @click="close">取消</text>
                <text class="primary-btn" @click="save">{{ migrationBatch.length > 1 ? '批量保存' : '保存' }}</text>
            </div>
        </div>

        <div class="body">
            <div class="form">
                <div class="field" @click="editField('issuer')">
                    <text class="field-label">服务名</text>
                    <text class="field-value">{{ form.issuer || '如 GitHub' }}</text>
                </div>
                <div class="field" @click="editField('account')">
                    <text class="field-label">账号</text>
                    <text class="field-value">{{ form.account || '如 alice@example.com' }}</text>
                </div>
                <div class="field" @click="editField('secret')">
                    <text class="field-label">密钥</text>
                    <text class="field-secret">{{ maskedSecret }}</text>
                </div>
                <div class="field" @click="editUri">
                    <text class="field-label">链接</text>
                    <text class="field-uri">{{ uriHint }}</text>
                </div>
            </div>

            <div class="options">
                <div class="opt-row">
                    <text class="opt-label">类型</text>
                    <div class="opt-group">
                        <text class="opt" :class="{ 'opt-on': form.type === 'totp' }" @click="setType('totp')">TOTP</text>
                        <text class="opt" :class="{ 'opt-on': form.type === 'hotp' }" @click="setType('hotp')">HOTP</text>
                    </div>
                </div>
                <div class="opt-row">
                    <text class="opt-label">算法</text>
                    <div class="opt-group">
                        <text v-for="alg in algorithms" :key="alg" class="opt" :class="{ 'opt-on': form.algorithm === alg }" @click="form.algorithm = alg">{{ alg }}</text>
                    </div>
                </div>
                <div class="opt-row">
                    <text class="opt-label">位数</text>
                    <div class="opt-group">
                        <text class="opt" :class="{ 'opt-on': form.digits === 6 }" @click="form.digits = 6">6 位</text>
                        <text class="opt" :class="{ 'opt-on': form.digits === 8 }" @click="form.digits = 8">8 位</text>
                    </div>
                </div>
                <div class="opt-row">
                    <text class="opt-label">周期</text>
                    <div class="opt-group">
                        <text class="opt" :class="{ 'opt-on': form.period === 30 }" @click="form.period = 30">30 秒</text>
                        <text class="opt" :class="{ 'opt-on': form.period === 60 }" @click="form.period = 60">60 秒</text>
                    </div>
                </div>
                <div class="preview">
                    <text class="preview-label">当前验证码</text>
                    <text class="preview-code">{{ previewCode }}</text>
                </div>
            </div>
        </div>

        <div v-if="banner" class="banner">{{ banner }}</div>
    </div>
</template>

<script>
import { vault } from '../../lib/vault.js'
import { openSoftKeyboard } from '@dictpen/core'
import { parseOtpInputs, buildOtpUri } from '../../lib/otpauth.js'
import { validateSecret, normalizeSecret } from '../../lib/base32.js'
import { totpFromSecret, formatCode } from '../../lib/totp.js'

export default {
    name: 'edit',
    data() {
        return {
            id: '',
            form: {
                issuer: '',
                account: '',
                secret: '',
                type: 'totp',
                algorithm: 'SHA1',
                digits: 6,
                period: 30,
                counter: 0
            },
            migrationBatch: [],
            algorithms: ['SHA1', 'SHA256', 'SHA512'],
            banner: '',
            previewCode: '······'
        }
    },
    computed: {
        isEdit() {
            return !!this.id
        },
        maskedSecret() {
            const secret = this.form.secret || ''
            if (!secret) return '点击输入 Base32 密钥'
            if (secret.length <= 8) return secret
            return secret.slice(0, 4) + ' ···· ' + secret.slice(-4)
        },
        uriHint() {
            if (this.migrationBatch.length > 1) {
                return `Google 转移链接（共 ${this.migrationBatch.length} 个账号）`
            }
            if (this.form.secret) return buildOtpUri(this.form).slice(0, 44) + '…'
            return '粘贴 otpauth:// 或 Google 转移链接'
        }
    },
    mounted() {
        this.boot()
    },
    beforeUnmount() {
        this.stopPreview()
    },
    methods: {
        async boot() {
            await vault.init()
            const options = this.$page.loadOptions || {}
            if (options.id) {
                const item = vault.find(options.id)
                if (item) {
                    this.id = item.id
                    this.form = {
                        issuer: item.issuer,
                        account: item.account,
                        secret: item.secret,
                        type: item.type,
                        algorithm: item.algorithm,
                        digits: item.digits,
                        period: item.period,
                        counter: item.counter || 0
                    }
                }
            }
            this.startPreview()
        },
        startPreview() {
            if (this._timer) return
            this._timer = setInterval(() => this.refreshPreview(), 500)
            this.refreshPreview()
        },
        stopPreview() {
            if (this._timer) {
                clearInterval(this._timer)
                this._timer = null
            }
        },
        refreshPreview() {
            if (!this.form.secret) {
                this.previewCode = '······'
                return
            }
            try {
                this.previewCode = formatCode(totpFromSecret(this.form.secret, this.form, Date.now()).code)
            } catch (e) {
                this.previewCode = '密钥无效'
            }
        },
        editField(name) {
            openSoftKeyboard(
                () => this.form[name],
                value => {
                    this.form[name] = name === 'secret' ? normalizeSecret(value) : value
                    if (name === 'secret') this.migrationBatch = []
                    else if (this.migrationBatch.length > 0) this.migrationBatch[0][name] = value
                    this.refreshPreview()
                }
            )
        },
        editUri() {
            openSoftKeyboard(
                () => this.form.secret ? buildOtpUri(this.form) : '',
                value => this.applyUri(value),
                value => {
                    if (!value) return ''
                    try {
                        parseOtpInputs(value)
                        return ''
                    } catch (e) {
                        return '链接无法解析：' + e.message
                    }
                }
            )
        },
        applyUri(value) {
            if (!value) return
            try {
                const res = parseOtpInputs(value)
                const first = res.accounts[0]
                this.form = Object.assign({}, this.form, first)
                this.refreshPreview()
                if (!this.isEdit && res.accounts.length > 1) {
                    this.migrationBatch = res.accounts
                    this.setBanner(`已解析 Google 转移链接（共 ${res.accounts.length} 个账号），点「批量保存」全部导入`)
                } else {
                    this.migrationBatch = []
                    const prefix = res.isMigration ? '已从 Google 转移链接解析：' : '已从链接解析：'
                    this.setBanner(prefix + (first.issuer || first.account || '未知服务'))
                }
            } catch (e) {
                this.setBanner('解析失败：' + e.message)
                return
            }
        },
        setType(type) {
            this.form.type = type
            if (type === 'hotp' && this.form.algorithm === 'SHA512') this.form.algorithm = 'SHA1'
        },
        async save() {
            if (!this.isEdit && this.migrationBatch.length > 1) {
                try {
                    const { added, skipped } = await vault.addMany(this.migrationBatch)
                    if (added === 0) {
                        this.setBanner(`转移链接中的 ${skipped} 个账号均已存在`)
                        return
                    }
                    this.close()
                    return
                } catch (e) {
                    this.setBanner('批量保存失败：' + e.message)
                    return
                }
            }
            const secret = normalizeSecret(this.form.secret)
            const err = validateSecret(secret)
            if (err) {
                this.setBanner(err)
                return
            }
            const payload = {
                issuer: (this.form.issuer || '').trim(),
                account: (this.form.account || '').trim(),
                secret,
                type: this.form.type,
                algorithm: this.form.algorithm,
                digits: this.form.digits,
                period: this.form.period,
                counter: this.form.counter || 0
            }
            try {
                if (this.isEdit) {
                    const current = vault.find(this.id)
                    if (current && current.secret !== secret && vault.hasDuplicate(secret)) {
                        this.setBanner('该密钥已存在于其它账号')
                        return
                    }
                    await vault.update(this.id, payload)
                } else {
                    if (vault.hasDuplicate(secret)) {
                        this.setBanner('该密钥已存在，已跳过重复添加')
                        return
                    }
                    await vault.add(payload)
                }
                this.close()
            } catch (e) {
                this.setBanner('保存失败：' + e.message)
            }
        },
        setBanner(text) {
            this.banner = text
            if (this._bannerTimer) clearTimeout(this._bannerTimer)
            this._bannerTimer = setTimeout(() => { this.banner = '' }, 2600)
        },
        close() {
            this.stopPreview()
            try {
                this.$page.finish()
            } catch (e) {
                $falcon.closePageByName('edit')
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

.bar-actions {
    flex-direction: row;
    width: 150px;
    justify-content: flex-end;
}

.ghost-btn {
    font-size: 13px;
    color: #5f6368;
    background-color: #f1f3f4;
    padding: 6px 12px;
    border-radius: 14px;
    margin-right: 8px;
}

.primary-btn {
    font-size: 13px;
    color: #ffffff;
    background-color: #1a73e8;
    padding: 6px 14px;
    border-radius: 14px;
}

.body {
    flex: 1;
    flex-direction: row;
    padding: 8px;
}

.form {
    width: 430px;
    flex-direction: column;
    margin-right: 8px;
}

.field {
    flex: 1;
    flex-direction: row;
    align-items: center;
    background-color: #ffffff;
    border-radius: 8px;
    padding: 0 12px;
    margin-bottom: 6px;
}

.field-label {
    font-size: 12px;
    color: #8a8f98;
    width: 52px;
}

.field-value {
    flex: 1;
    font-size: 14px;
    color: #1b1c1e;
}

.field-secret {
    flex: 1;
    font-size: 14px;
    color: #1b1c1e;
    font-family: monospace;
    letter-spacing: 1px;
}

.field-uri {
    flex: 1;
    font-size: 11px;
    color: #1a73e8;
}

.options {
    flex: 1;
    flex-direction: column;
    background-color: #ffffff;
    border-radius: 8px;
    padding: 8px 12px;
}

.opt-row {
    flex-direction: row;
    align-items: center;
    margin-bottom: 6px;
}

.opt-label {
    font-size: 12px;
    color: #8a8f98;
    width: 44px;
}

.opt-group {
    flex-direction: row;
    flex: 1;
}

.opt {
    font-size: 12px;
    color: #5f6368;
    background-color: #f1f3f4;
    padding: 5px 12px;
    border-radius: 12px;
    margin-right: 6px;
}

.opt-on {
    color: #ffffff;
    background-color: #1a73e8;
}

.preview {
    flex: 1;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    border-top-width: 1px;
    border-top-color: #f1f3f4;
    padding-top: 6px;
}

.preview-label {
    font-size: 12px;
    color: #8a8f98;
}

.preview-code {
    font-size: 26px;
    color: #1b1c1e;
    font-family: monospace;
    letter-spacing: 2px;
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
