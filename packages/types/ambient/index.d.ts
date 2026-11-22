declare const $falcon: {
    env: {
        deviceModel: string
        deviceWidth: number
        deviceHeight: number
        [key: string]: any
    }
    navTo(page: string, options?: Record<string, any>): void
    closePageByName(page: string): void
    on(event: string, cb: (...args: any[]) => void): any
    off(event: string, cbOrToken?: any): void
    trigger(event: string, payload?: any): void
    [key: string]: any
}
declare const $dataDir: string
declare const $workspace: string
declare const $appid: string

declare module '@dictpen/core' {
    export const EVENT_SOFT_KEYBOARD: string
    export function openSoftKeyboard(
        getData: () => string,
        onConfirm: (value: string) => void,
        validate?: (value: string) => string,
        extraOptions?: Record<string, any>
    ): void
    export class ResourcePage {}
    export class BasePage extends ResourcePage {}
    export function createApp(config?: Record<string, any>): any
}

declare module 'fs' {
    export interface Dirent {
        name: string
        isDirectory(): boolean
        isFile(): boolean
    }
    export interface StatResult {
        size: number
        mode?: number
        mtimeMs?: number
        atimeMs?: number
        birthtimeMs?: number
    }
    const fs: {
        readdir(path: string, options?: { withFileTypes?: false }): Promise<string[]>
        readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
        stat(path: string): Promise<StatResult>
        mkdir(path: string): Promise<any>
        readFile(path: string): Promise<string>
        writeFile?(path: string, content: string): Promise<void>
        rm(path: string): Promise<any>
        exists(path: string): Promise<boolean>
        [key: string]: any
    }
    export default fs
}

declare module 'storage' {
    const storage: {
        setStorage(key: string, val: string): Promise<void>
        getStorage(key: string): Promise<string | null>
        getStorageKeys(): Promise<string[]>
        removeStorage(key: string): Promise<void>
        clearStorage(): Promise<void>
    }
    export default storage
}

declare module 'sqlite3' {
    export class Statement {
        bind(params: any[]): Promise<void>
        run(): Promise<void>
        all(): Promise<any[]>
        finalize(): Promise<void>
    }
    export class Database {
        path: string
        open(path: string): Promise<void>
        exec(sql: string): Promise<void>
        prepare(sql: string): Promise<Statement>
        close(): Promise<void>
    }
    const sqlite3: {
        Database: typeof Database
    }
    export default sqlite3
}

declare module 'crypto' {
    export class Hash {
        constructor(algorithm: string)
        hashFile(path: string): Promise<string>
    }
    const crypto: {
        Hash: typeof Hash
        base64Encode(buf: ArrayBufferLike): string
        [key: string]: any
    }
    export default crypto
}

declare module 'zip' {
    export class ZipFile {
        constructor(path: string)
        extractall(dest: string): Promise<void>
    }
    const zip: {
        ZipFile: typeof ZipFile
    }
    export default zip
}

declare module '$am' {
    const am: {
        getTopApp(): string
        moveToBack(): void
        hide(): void
        hasWindowFocus(): boolean
        isAttachedToWindow(): boolean
    }
    export default am
}

declare module 'am' {
    const am: {
        getTopApp(): string
        moveToBack(): void
        hide(): void
        hasWindowFocus(): boolean
        isAttachedToWindow(): boolean
    }
    export default am
}

declare module 'pm' {
    const pm: {
        SUCCESS: number
        getInstalledPackages(): any[]
        getPackageInfo(appid: string): any
        installPackage(path: string, cb: (r: { res: number }) => void): void
    }
    export default pm
}

declare module 'updater' {
    const updater: {
        ST_HAS_NEW_VERSION: number
        EVT_DOWNLOAD_PERCENT_CHANGE: number
        isReady(): boolean
        getUpdateInfo(appid: string, cb: (info: any) => void): void
        on(event: string, cb: (payload: { event: number; info: any }) => void): void
    }
    export default updater
}

declare module 'global' {
    export class Global {
        textEditFinished: {
            on(cb: (...args: any[]) => void): void
            off(cb: (...args: any[]) => void): void
        }
        startTextEdit(inputType: string): string
        closeTextEdit(uuid: string): void
        isAsrLocalEnabled(): boolean
        execShell(cmd: string): any
    }
    const globalModule: {
        Global: typeof Global
    }
    export default globalModule
}

declare module 'langningchen' {
    export const AI: {
        initialize(): void
        addUserMessage(msg: string): Promise<void>
        generateResponse(): Promise<void>
        on(event: string, cb: (delta: string) => void): void
    }
    export const IME: {
        getCandidates(pinyin: string): Array<{ hanZi: string }>
    }
    export const ScanInput: {
        on(event: string, cb: (data: string) => void): void
    }
    export const Shell: {
        initialize(): void
        exec(cmd: string): Promise<string>
    }
    export const Update: {
        setRepo(opts: { owner: string; repo: string }): void
    }
}
