# 验证器 Authenticator（有道词典笔 X7P）
# 未验证
项目基于https://github.com/chezixiang/Pen-Authenticator 使用ai进行修改，
主要为适配Google的F2A转移功能

给有道词典笔写的两步验证（TOTP/HOTP）小程序：多账号管理、扫码/手动导入、可选 PIN 加密。
基于上级目录 `classic_sdk` 的有道小程序 SDK 构建。

- appid：`8002026102300011`
- 目标机型：X7P（固件 4.9.9 / Falcon 1.6.3 / 936×280 / ARM64 Linux）
- 产物：`8002026102300011.0_1_0.amr`

## 功能

| 模块 | 说明 |
| --- | --- |
| 账号列表 | 左侧列表 + 右侧大号验证码，936×280 横屏布局，列表内直接显示各账号当前码 |
| 验证码 | TOTP（30/60s，6/8 位）与 HOTP，支持 SHA1/SHA256/SHA512；进度条按剩余秒数变色 |
| 添加账号 | 扫码添加 / 手动输入 / 粘贴 `otpauth://` 或 `otpauth-migration://` 链接（自动解析 issuer、算法、位数、周期） |
| Google 2FA 转移 | 完整适配 Google Authenticator「转移账号」(`otpauth-migration://offline?data=`) Protobuf 协议：支持单码多账号批量扫码导入、多张二维码分批连续扫入，以及在设置页直接生成 Google 转移二维码供手机扫码转出 |
| 多账号管理 | 选择、编辑、二次确认删除、HOTP 计数递增、重复密钥检测 |
| 本地加密 | 可选 6 位 PIN：PBKDF2-HMAC-SHA256 派生，AES-256-CBC 加密 + HMAC-SHA256 校验（encrypt-then-MAC） |
| 备份与互传 | 导出 `backup-*.txt` (`otpauth://`) 与 `migration-*.txt` (`otpauth-migration://`) 到 `/userdisk/Authenticator/` 及 `/userdisk/Favorite/Authenticator/`（MTP / 8080 文件互传直接可见）；支持从 `import.txt` 或二维码图片 (`import.png`/`import.jpg`) 批量导入 |
| 输入法 | 自绘全键盘（字母大小写切换、数字符号含 `?`、Base32 大小写自动纠正），不依赖系统输入法 |

## 安装到词典笔

```bash
# 构建
npm install
npm run build:prod          # 产出 8002026102300011.0_1_0.amr

# 有 adb 时（更省事，注意 Windows 下 Git Bash 会把 /userdisk 转成本地路径，加 MSYS_NO_PATHCONV=1）
MSYS_NO_PATHCONV=1 adb -s <序列号> push 8002026102300011.0_1_0.amr /userdisk/Favorite/
adb -s <序列号> shell "miniapp_cli install /userdisk/Favorite/8002026102300011.0_1_0.amr"
adb -s <序列号> shell "miniapp_cli start 8002026102300011 index"

# 或者用 ssh/scp
scp 8002026102300011.0_1_0.amr root@192.168.1.192:/userdisk/Favorite/
ssh root@192.168.1.192 "miniapp_cli install /userdisk/Favorite/8002026102300011.0_1_0.amr"
```

启动参数必须是完整 16 位 appid + 裸页面名（`--page` 会被当成页面名）。

### 真机截图 / 逐页核对

设备没有 `screencap`，也没有 `/dev/fb0`，但系统自带的 `miniapp_cli capture <path>` 可以抓当前画面：

```bash
adb shell "miniapp_cli capture /tmp/s.png"
MSYS_NO_PATHCONV=1 adb pull /tmp/s.png ./s.png     # 936x280，与屏幕 1:1
```

`tools/ui.py` 把这两个动作包了一层：`python tools/ui.py shot 首页` / `start scan` / `run "命令"`。
应用日志在 `/userdata/applog/DictPen_<时间戳>.log`，进程重启会换新文件，所以崩溃前要
`tail -f` 到另一个文件里才留得住现场。

## 扫码：24fps 实时预览 + 自研解码器

早期版本判断"第三方小程序拿不到摄像头"是**错的**——我测错了节点。X7P 上有两条完全不同的通路：

| 节点 | 用途 | 第三方小程序 |
| --- | --- | --- |
| `/dev/video22` | ISP 主路径，被系统扫描管线 YCapture 常年占着 | `EBUSY`，拿不到 |
| **`/dev/video29`** | UYVY 4:2:2，最大 3264x2448，DeepSeek 小程序（`8000000000182376`）就是用它取景+拍照的 | **可用**，能出彩色画面 |

所以扫码页是真取景。但"能出帧"到"不卡"之间踩了一连串坑，最终架构是**单进程 gst 双分支 + shell 转码 + 纯 JS 解码**：

```
v4l2src 640x360@30 ─┬─ queue(leaky) → jpegenc q50 → p_%06d.jpg（448x248，预览 24fps）
                    └─ queue(leaky) → GRAY8 → 中心裁 288x288 → g_%06d.gray（3fps，解码用）
shell 循环：g_*.gray → ffmpeg normalize+monow → q.b64 → mv 成 q.seq 握手
JS 侧：预览循环只 fs.exists 探帧号、改 image 的 src；解码循环读 q.b64 → 自写解码器
```

为什么长这样，全是实测约束：

- **`execShell` 是同步阻塞的**。单次调用（里面跑一次 ffmpeg）能让 JS 主线程卡 4.4 秒，
  连续几帧就是 15~25 秒，直接触发系统看门狗 `Msg process take too many time`，
  进程被杀 → 表现成"添加 2FA 后软件自己退出还弹一次更新"（宿主发现进程消失会走一遍
  `YAppUpdaterModule` 更新检查，看起来就像假更新）。**所以任何循环里都不能再调 execShell**：
  转码全在 shell 侧做，JS 只 `fs.readFile` / `fs.exists` / `fs.readdir`。
- **jsQR 太慢**：QuickJS 上约 15µs/像素，288x288 一帧要 500ms+，取景线程全被它拖死。
  换成了自写的 `src/lib/qrdec.js`（1-bit 输入）：finder 定位 → 单应采样 → format info →
  RS 纠错（GF(2^8) 查表）→ 模式解析，实测 **~50ms/帧**，够跟 3fps 解码通道。
  用 Node + `qrcode` 库生成旋转/透视/模糊/低分辨率测试集交叉验证（`tools/test_qrdec.mjs`，
  147 用例）。**分辨率边界**：≥3px/模块可靠（288px 裁剪框对应到 v10 的 otpauth 码仍有
  5px/模块，是设计目标）；2.5px/模块以下或 7% 以上透视会定位失败——那种情况下用户本就看不清，
  页面会提示改用手动输入。 finder 的垂直交叉校验是关键过滤器，试过放宽容差/跳过校验都会让
  误报挤掉真候选（129→125→106），所以维持严格 1:1:3:1:1。
- **原生 `qrcode` 模块的 `decodeImage` 在这版固件上是坏的**（对合法 PNG/JPEG 一律
  `{"code":-1,"text":""}`），所以只能纯 JS 解。
- **帧文件必须用递增文件名 + 倒数第二帧**：image 组件按路径缓存，同名文件不会刷新；
  `max-files` 又会把最旧的删掉，等固定的 `p_000001.jpg` 会永远等不到。
  取倒数第二帧是因为最新一帧可能还在写。

真机实测（X7P，936x280 竖屏方向）：预览 **25fps**、解码 **53ms/帧**、连续运行无看门狗告警。
解码帧只取取景框中心 288x288（约 QR 版本 6 以内），对"笔头离屏幕 5-10cm"的 otpauth 链接够用；
更大的码可以用「从文件导入」。

几个真机上踩出来的坑，写在这里省得再踩：

- **尺寸必须是 8 的倍数**。`960x540` 会让 gst 直接 `not-negotiated (-4)`（540/8 不是整数），`960x544` 才通。
- **不要用 `( nohup sh x.sh & )` 这种括号子 shell 起脚本**：同样的命令在 adb shell 里没事，经 `execShell`
  下发时整条不执行（连 `echo > file` 都不落盘）。拆成「写脚本 / chmod / `nohup sh x.sh &` 三行三次调用」就正常。
- `miniapp_cli` 的 `pkill -f 'gst-launch.*video29'` 会匹配到**你自己这条 adb 命令行**，把 shell 一起杀掉，
  表现得像"命令没输出"。pkill 的模式里加字符类（`video[2]9`）或换关键词。
- 帧循环里 `$BASE_$n.jpg` 会被解析成变量 `BASE_`，必须写成 `${B}_$n.jpg`。
- **页面生命周期回调要写在 `methods` 里**：框架是直接 `this.$root.onShow()` 调的，
  写成 Vue3 顶层选项不会挂到实例上，回调永远不触发（表现为"添加后首页列表不刷新"）。
- **扫码页作为根页面启动时 `finish()` 会退出整个应用**（真实路径 index → scan → finish 才是返回）。

### 顺带修掉的另一个坑：全新安装写不了本地存储

`miniapp_cli uninstall` 之后重装，框架不会重建 `pkg/<appid>/data/sharedpreferences`，导致所有
`setStorage` 直接失败（`setStorage failed key: auth_vault_v1`），整个 app 一进来就卡在"加载"。
`vault.init()` 里现在会先 `mkdir -p` 这个目录（用 `$dataDir` / `$workspace` 推导），写失败还会补建后重试一次。

### 手动与文件导入仍然保留

不想用相机时：全键盘输入 Base32 密钥、整段粘贴 `otpauth://` 链接自动拆字段、或者从
`/userdisk/Authenticator/import.txt` 批量导入。

## 真机实测的性能与取舍

在 X7P 上用 `timing` 页量到（QuickJS，纯 JS 实现）：

| 操作 | 耗时 |
| --- | --- |
| SHA-256 ×1 | ≈0.45 ms |
| SHA-512 ×1 | ≈1.6 ms |
| TOTP 计算 | ≈1 ms |
| AES-256 单块（加密或解密） | 优化前 ≈2 ms，改用查表法后约 1/10 |
| PBKDF2-HMAC-SHA256 | ≈3.4 ms / 次迭代 |

因此 PBKDF2 迭代次数定为 **300**（解锁约 1 秒）。最初用 12000 次时，真机上同步计算卡住主线程 40 秒，
被系统看门狗记为 `Msg process take too many time`，所以这个值是实测约束下的折中，不是随手写的。

**安全边界要说清楚**：6 位 PIN 只有 10^6 空间，PIN+PBKDF2 只能挡住"拿到存储文件但没有设备"的随手翻看，
挡不住拿到 root 的定向攻击。真要高安全，请用导入/导出配合密码管理器，并自行保管备份文件。

## 数据与安全

- 无 PIN：账号 JSON 明文存在应用 KV（`auth_vault_v1`）。
- 有 PIN：只存 `{salt, iv, ciphertext, tag}`；PIN 连续错 5 次锁 30 秒。
- 忘记 PIN 无法解密（`unlock` 页提供"清除全部账号重新开始"）。
- 导出文件是**明文** otpauth 链接，注意保管；用完可删。
- SHA1/SHA256/SHA512、HMAC、PBKDF2、AES-256 都是纯 JS 实现（QuickJS 没有 WebCrypto），
  已用 Node `crypto` 与 RFC 6238 测试向量交叉验证（`tools/test_crypto.mjs`，93 项断言全部通过）。

## 目录

```
src/lib/hash.js      SHA1/SHA256/SHA512 + HMAC + PBKDF2（SHA-512 用 32 位双字模拟，无 BigInt）
src/lib/aes.js       AES-256-CBC + PKCS#7（S 盒运行时由 GF(2^8) 逆元生成）
src/lib/totp.js      HOTP/TOTP、验证码分组显示
src/lib/base32.js    Base32（RFC 4648）编解码与校验
src/lib/otpauth.js   otpauth:// 与 Google 转移 (otpauth-migration://) Protobuf 解析/生成、批量提取
src/lib/qrenc.js     纯 JS 二维码编码器 + 1-bit PNG 生成器（用于设置页屏幕显示 Google 转移二维码）
src/lib/vault.js     账号存储 + PIN 加密 + 增删改查 + 批量原子导入 (addMany)
src/lib/random.js    盐/IV 随机源（时间+计数器+Math.random 混入 SHA-256 池）
src/lib/qrdec.js     二维码解码器（1-bit 输入：finder/单应采样/RS 纠错/模式解析）
src/lib/camera.js    取景管线（gst 双分支脚本模板 + 常量）
src/lib/bytes.js     base64/UTF-8 编解码（QuickJS 上查表实现，逐字符 indexOf 会秒级卡顿）
src/pages/*          首页/扫码/编辑/设置/解锁/键盘
tools/               设备调试脚本、ydpen-toolkit 部署与 fs 插件注入 (ydpen_deploy.py)、密码学/解码器自测
```

## 自测

```bash
node tools/test_crypto.mjs
node tools/test_qrdec.mjs
```

## 许可证

[MIT](LICENSE)
