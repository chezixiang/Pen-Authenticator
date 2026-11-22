<template>
    <div class="kb">
        <div class="kb-preview">
            <text class="kb-label">{{ title }}</text>
            <scroller class="kb-value-box" scroll-direction="horizontal" show-scrollbar="false">
                <text class="kb-value">{{ displayValue }}</text>
            </scroller>
            <text class="kb-count">{{ value.length }}</text>
        </div>

        <div class="kb-rows">
            <div class="kb-row" v-for="(row, ri) in rows" :key="ri">
                <text
                    v-for="key in row"
                    :key="key"
                    class="kb-key"
                    :class="{ 'kb-accent': key === '完成', 'kb-wide': key === '空格' || key === '完成' || key === '←' || key === '123' || key === 'ABC' || key === '大写' || key === '小写' }"
                    @click="press(key)"
                >{{ key }}</text>
            </div>
        </div>
    </div>
</template>

<script>
import { EVENT_SOFT_KEYBOARD } from '@dictpen/core'

const LETTER_ROWS = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '@'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '-', '_']
]

const NUM_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '_', '.', '@', '/', ':', '?', '=', '+', '%'],
    ['(', ')', '[', ']', '{', '}', '"', "'", '#', '&']
]

export default {
    name: 'softKeyboard',
    data() {
        return {
            value: '',
            title: '编辑',
            mode: 'text',
            numeric: false,
            upper: false,
            sessionId: null,
            sessionSettled: true
        }
    },
    computed: {
        rows() {
            let base = this.numeric ? NUM_ROWS : LETTER_ROWS
            if (!this.numeric && (this.upper || this.mode === 'secret')) {
                base = LETTER_ROWS.map(row => row.map(ch => /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch))
            }
            const control = this.numeric
                ? ['ABC', '空格', '←', '完成']
                : ['123', (this.upper || this.mode === 'secret') ? '小写' : '大写', '空格', '←', '完成']
            return base.concat([control])
        },
        displayValue() {
            const text = this.value || ''
            return text.length ? text + '|' : '输入内容…'
        }
    },
    mounted() {
        this.startSession()
    },
    beforeDestroy() {
        this.cancel()
    },
    beforeUnmount() {
        this.cancel()
    },
    methods: {
        onShow() {
            this.startSession()
        },
        onNewOptions() {
            this.startSession()
        },
        onUnload() {
            this.cancel()
        },
        startSession() {
            const options = this.$page.newOptions || this.$page.loadOptions || {}
            const sessionId = options.sessionId == null ? undefined : options.sessionId
            if (this.sessionId === sessionId) return
            this.cancel()
            this.sessionId = sessionId
            this.sessionSettled = false
            this.title = options.title || (options.mode === 'secret' ? 'Base32 密钥' : options.mode === 'digits' ? '数字' : '编辑')
            this.mode = options.mode || 'text'
            this.numeric = this.mode === 'digits'
            this.upper = this.mode === 'secret'
            this.value = options.data || ''
        },
        cancel() {
            if (this.sessionSettled) return
            this.sessionSettled = true
            if (this.sessionId != null) {
                $falcon.trigger(EVENT_SOFT_KEYBOARD, { sessionId: this.sessionId, cancelled: true })
            }
        },
        press(key) {
            if (key === '完成') {
                this.close()
                return
            }
            if (key === '←') {
                this.value = this.value.slice(0, -1)
            } else if (key === '空格') {
                this.value = this.value + ' '
            } else if (key === '123') {
                this.numeric = true
            } else if (key === 'ABC') {
                this.numeric = false
            } else if (key === '大写') {
                this.upper = true
            } else if (key === '小写') {
                this.upper = false
            } else {
                let text = key
                if (this.mode === 'secret' || this.upper) text = text.toUpperCase()
                if (this.mode === 'digits' && !/^[0-9]$/.test(key)) return
                this.value = this.value + text
            }
            this.$forceUpdate()
        },
        close() {
            if (this.sessionSettled) return
            const sessionId = this.sessionId
            let value = this.value
            if (this.mode === 'secret') value = value.toUpperCase().replace(/[^A-Z2-7]/g, '')
            this.sessionSettled = true
            try {
                this.$page.finish()
            } catch (error) {
                if (sessionId != null) {
                    $falcon.trigger(EVENT_SOFT_KEYBOARD, { sessionId, cancelled: true })
                }
                throw error
            }
            $falcon.trigger(EVENT_SOFT_KEYBOARD, sessionId == null ? value : { sessionId, value })
        }
    }
}
</script>

<style lang="less" scoped>
.kb {
    flex: 1;
    flex-direction: column;
    background-color: #f2f4f7;
    padding: 6px 8px 10px 8px;
}

.kb-preview {
    height: 40px;
    flex-direction: row;
    align-items: center;
    background-color: #ffffff;
    border-radius: 8px;
    padding: 0 12px;
    margin-bottom: 6px;
}

.kb-label {
    font-size: 12px;
    color: #8a8f98;
    margin-right: 10px;
}

.kb-value-box {
    flex: 1;
    height: 40px;
}

.kb-value {
    font-size: 18px;
    color: #1b1c1e;
    line-height: 40px;
    font-family: monospace;
}

.kb-count {
    font-size: 12px;
    color: #9aa0a6;
}

.kb-rows {
    flex: 1;
    flex-direction: column;
}

.kb-row {
    flex: 1;
    flex-direction: row;
    align-items: stretch;
}

.kb-key {
    flex: 1;
    font-size: 17px;
    color: #1b1c1e;
    background-color: #ffffff;
    text-align: center;
    line-height: 40px;
    margin: 2px;
    border-radius: 7px;
}

.kb-wide {
    flex: 1.5;
    font-size: 14px;
}

.kb-accent {
    background-color: #1a73e8;
    color: #ffffff;
}
</style>
