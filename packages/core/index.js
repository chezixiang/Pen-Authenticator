export const EVENT_SOFT_KEYBOARD = 'softKeyboard'

let nextSessionId = 1

export function openSoftKeyboard(getData, onConfirm, validate, extraOptions) {
    const sessionId = 'kb_' + (nextSessionId++) + '_' + Date.now()
    const initial = typeof getData === 'function' ? (getData() || '') : String(getData || '')
    const opts = Object.assign({}, extraOptions || {}, {
        sessionId,
        data: initial
    })
    const handler = payload => {
        const isObj = payload && typeof payload === 'object'
        if (isObj && payload.sessionId != null && payload.sessionId !== sessionId) return
        try {
            $falcon.off(EVENT_SOFT_KEYBOARD, handler)
        } catch (e) { /* 忽略 */ }
        if (isObj && payload.cancelled) return
        const val = isObj ? payload.value : payload
        if (typeof validate === 'function') {
            const err = validate(val)
            if (err) return
        }
        if (typeof onConfirm === 'function') {
            onConfirm(val)
        }
    }
    $falcon.on(EVENT_SOFT_KEYBOARD, handler)
    $falcon.navTo('softKeyboard', opts)
}

export class ResourcePage extends $falcon.Page {
    constructor() {
        super()
        this.falconOnTokens = []
        this.timeoutTokens = new Set()
        this.intervalTokens = new Set()
    }

    on(name, callback) {
        const token = $falcon.on(name, callback)
        this.falconOnTokens.push([token, name])
        return token
    }

    off(name, callbackOrToken) {
        $falcon.off(name, callbackOrToken)
        this.falconOnTokens = this.falconOnTokens.filter(item => item[0] !== callbackOrToken)
    }

    setTimeout(callback, delay) {
        const token = setTimeout(() => {
            this.timeoutTokens.delete(token)
            callback()
        }, delay)
        this.timeoutTokens.add(token)
        return token
    }

    clearTimeout(token) {
        clearTimeout(token)
        this.timeoutTokens.delete(token)
    }

    setInterval(callback, delay) {
        const token = setInterval(callback, delay)
        this.intervalTokens.add(token)
        return token
    }

    clearInterval(token) {
        clearInterval(token)
        this.intervalTokens.delete(token)
    }

    sleep(delay) {
        return new Promise(resolve => this.setTimeout(resolve, delay))
    }

    release() {
        this.falconOnTokens.forEach(item => $falcon.off(item[1], item[0]))
        this.falconOnTokens = []
        this.timeoutTokens.forEach(token => clearTimeout(token))
        this.intervalTokens.forEach(token => clearInterval(token))
        this.timeoutTokens.clear()
        this.intervalTokens.clear()
    }
}

export class BasePage extends ResourcePage {
    onLoad(options) {
        super.onLoad(options)
        this.options = options || {}
    }

    onNewOptions(options) {
        if (super.onNewOptions) super.onNewOptions(options)
        this.options = options || {}
        if (this.$root && this.$root.onNewOptions) this.$root.onNewOptions(options)
    }

    onShow() {
        super.onShow()
        if (this.$root && this.$root.onShow) this.$root.onShow()
    }

    onHide() {
        if (super.onHide) super.onHide()
        if (this.$root && this.$root.onHide) this.$root.onHide()
    }

    onUnload() {
        try {
            if (super.onUnload) super.onUnload()
            if (this.$root && this.$root.onUnload) this.$root.onUnload()
        } finally {
            this.release()
        }
    }

    beforeVueInstantiate(Vue) {
        if (super.beforeVueInstantiate) super.beforeVueInstantiate(Vue)
        Vue.prototype.$workspace = globalThis.$workspace
        Vue.prototype.$appid = globalThis.$appid
    }
}

export function createApp(config = {}) {
    return class App extends $falcon.App {
        constructor() {
            super()
        }

        onLaunch(options) {
            super.onLaunch(options)
            if (config.setViewPort) {
                this.setViewPort(config.setViewPort)
            }
            $falcon.useDefaultBasePageClass(config.BasePage || BasePage)
            if (typeof config.onLaunch === 'function') {
                config.onLaunch.call(this, options)
            }
        }

        onShow(options) {
            if (super.onShow) super.onShow(options)
            if (typeof config.onShow === 'function') {
                config.onShow.call(this, options)
            }
        }

        onHide(options) {
            if (super.onHide) super.onHide(options)
            if (typeof config.onHide === 'function') {
                config.onHide.call(this, options)
            }
        }

        onDestroy(options) {
            if (super.onDestroy) super.onDestroy(options)
            if (typeof config.onDestroy === 'function') {
                config.onDestroy.call(this, options)
            }
        }
    }
}
