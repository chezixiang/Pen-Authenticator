#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ydpen_deploy.py —— 基于 ydpen-toolkit 的词典笔部署、fs 插件注入与 Google 2FA 转移辅助脚本

支持能力（适配 YDPX6-2 / X6 Pro 4.3.5、YDPX7-1 / X7 Pro 4.8.7、X7P 4.9.9）：
  1) parse <uri_or_file> [--push]
     在 PC 侧解析 Google Authenticator 转移链接 (otpauth-migration://offline?data=...)，
     输出标准 otpauth:// 列表；加 --push 时自动通过 ADB 推送到词典笔的
     /userdisk/Favorite/Authenticator/import.txt 与 /userdisk/Authenticator/import.txt。
  2) inject-fs <in.amr> [out.amr]
     按 ydpen-toolkit 重打包规范，向 .amr 注入 libjsapi_fs_1000000001.so
     （覆盖 arm64 / arm64-orange / arm64-cherry3566），并同步更新 manifest.json 的 cert (size+md5)。
  3) install <amr> [--serial <ip:5555>] [--password ydpen2026]
     自动完成 ADB shell auth 认证 → uninstall → install → 活跃槽位补装 fs 插件 → 同步 sideload-keeper。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import urllib.parse
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APPID = "8002026102300011"
DEFAULT_SO = os.path.join(HERE, "libjsapi_fs_1000000001.so")
ABIS = ("arm64", "arm64-orange", "arm64-cherry3566")
PKG_ROOTS = (
    "/userdisk/miniapp/data/mini_app/pkg",
    "/userdisk/secondary/miniapp/data/mini_app/pkg",
    "/userdata/miniapp/data/mini_app/pkg",
)


def md5_hex(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


# ---------- Protobuf 解析 (Google Authenticator MigrationPayload) ----------

def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ValueError("迁移数据 varint 被截断")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift >= 70:
            raise ValueError("迁移数据 varint 溢出")


def _decode_otp_param(buf: bytes) -> dict:
    pos = 0
    secret = b""
    name = ""
    issuer = ""
    alg = 1
    digits = 1
    otp_type = 2
    counter = 0
    while pos < len(buf):
        tag, pos = _read_varint(buf, pos)
        field_no = tag >> 3
        wire_type = tag & 7
        if wire_type == 0:
            val, pos = _read_varint(buf, pos)
            if field_no == 4:
                alg = val & 0xFFFFFFFF
            elif field_no == 5:
                digits = val & 0xFFFFFFFF
            elif field_no == 6:
                otp_type = val & 0xFFFFFFFF
            elif field_no == 7:
                counter = val
        elif wire_type == 2:
            ln, pos = _read_varint(buf, pos)
            sub = buf[pos:pos + ln]
            pos += ln
            if field_no == 1:
                secret = sub
            elif field_no == 2:
                name = sub.decode("utf-8", "replace")
            elif field_no == 3:
                issuer = sub.decode("utf-8", "replace")
        elif wire_type == 1:
            pos += 8
        elif wire_type == 5:
            pos += 4
        else:
            raise ValueError(f"未知的 Protobuf wire_type: {wire_type}")

    b32_secret = base64.b32encode(secret).decode("ascii").rstrip("=")
    alg_map = {0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512"}
    alg_name = alg_map.get(alg, "SHA1")
    digit_cnt = 8 if digits in (2, 8) else 6
    type_name = "hotp" if otp_type == 1 else "totp"

    issuer = issuer.strip()
    account = name.strip()
    if ":" in account:
        prefix, rest = account.split(":", 1)
        account = rest.strip()
        if not issuer:
            issuer = prefix.strip()

    label = urllib.parse.quote(f"{issuer}:{account}" if issuer else (account or "account"), safe=":")
    params = [f"secret={b32_secret}"]
    if issuer:
        params.append(f"issuer={urllib.parse.quote(issuer, safe='')}")
    if alg_name != "SHA1":
        params.append(f"algorithm={alg_name}")
    if digit_cnt != 6:
        params.append(f"digits={digit_cnt}")
    if type_name == "hotp":
        params.append(f"counter={counter}")
    uri = f"otpauth://{type_name}/{label}?{'&'.join(params)}"
    return {
        "issuer": issuer,
        "account": account,
        "secret": b32_secret,
        "algorithm": alg_name,
        "digits": digit_cnt,
        "type": type_name,
        "counter": counter,
        "uri": uri,
    }


def parse_migration_uri(uri: str) -> list[dict]:
    uri = uri.strip()
    parsed = urllib.parse.urlsplit(uri)
    raw_data = ""
    for part in parsed.query.split("&"):
        if part.lower().startswith("data="):
            raw_data = part[5:]
            break
    if not raw_data:
        raise ValueError("缺少 data 参数")
    raw_data = urllib.parse.unquote(raw_data).strip().replace(" ", "+").replace("-", "+").replace("_", "/")
    pad = (-len(raw_data)) % 4
    if pad:
        raw_data += "=" * pad
    payload = base64.b64decode(raw_data)

    pos = 0
    accounts = []
    while pos < len(payload):
        tag, pos = _read_varint(payload, pos)
        field_no = tag >> 3
        wire_type = tag & 7
        if field_no == 1 and wire_type == 2:
            ln, pos = _read_varint(payload, pos)
            accounts.append(_decode_otp_param(payload[pos:pos + ln]))
            pos += ln
        elif wire_type == 0:
            _, pos = _read_varint(payload, pos)
        elif wire_type == 2:
            ln, pos = _read_varint(payload, pos)
            pos += ln
        elif wire_type == 1:
            pos += 8
        elif wire_type == 5:
            pos += 4
    return accounts


# ---------- .amr 注入 fs 插件（ydpen-toolkit 规范） ----------

def inject_fs_plugin(in_amr: str, out_amr: str, so_path: str = DEFAULT_SO) -> int:
    if not os.path.isfile(in_amr):
        print(f"[!] 找不到输入包: {in_amr}")
        return 1
    if not os.path.isfile(so_path):
        print(f"[!] 找不到 fs 插件: {so_path}")
        return 2

    so_bytes = open(so_path, "rb").read()
    so_name = os.path.basename(so_path)

    with zipfile.ZipFile(in_amr, "r") as zin:
        entries = {name: zin.read(name) for name in zin.namelist()}

    if "manifest.json" not in entries:
        print("[!] .amr 缺少 manifest.json")
        return 3

    manifest = json.loads(entries["manifest.json"].decode("utf-8"))
    cert = manifest.get("cert") or {}

    for abi in ABIS:
        rel = f"libs/{abi}/{so_name}"
        entries[rel] = so_bytes
        cert[rel] = {"size": len(so_bytes), "md5": md5_hex(so_bytes)}

    # 校验并补齐除 manifest.json 与 icon 以外所有文件的 cert
    icon_name = manifest.get("icon", "app_icon.png")
    for rel, data in entries.items():
        if rel in ("manifest.json", icon_name):
            continue
        cert[rel] = {"size": len(data), "md5": md5_hex(data)}

    manifest["cert"] = cert
    entries["manifest.json"] = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    os.makedirs(os.path.dirname(os.path.abspath(out_amr)), exist_ok=True)
    order = ["manifest.json"] + sorted(k for k in entries if k != "manifest.json")
    with zipfile.ZipFile(out_amr, "w", zipfile.ZIP_DEFLATED) as zout:
        for rel in order:
            zout.writestr(rel, entries[rel])

    print(f"[+] 已生成带 fs 插件的包: {out_amr} ({os.path.getsize(out_amr):,} 字节)")
    return 0


# ---------- ADB 部署与认证（兼容 ydpen-toolkit） ----------

def run_adb(adb_bin: str, serial: str | None, args: list[str], input_text: str | None = None) -> str:
    cmd = [adb_bin] + (["-s", serial] if serial else []) + args
    p = subprocess.run(
        cmd,
        input=input_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    return (p.stdout or "") + (p.stderr or "")


def ensure_adb_auth(adb_bin: str, serial: str | None, password: str) -> bool:
    out = run_adb(adb_bin, serial, ["shell", "id"])
    if "uid=0" in out:
        return True
    run_adb(adb_bin, serial, ["shell", "auth"], input_text=password + "\n")
    out2 = run_adb(adb_bin, serial, ["shell", "id"])
    return "uid=0" in out2


def install_to_pen(amr_path: str, adb_bin: str, serial: str | None, password: str, so_path: str) -> int:
    if not ensure_adb_auth(adb_bin, serial, password):
        print("[!] ADB 未获得 root 权限，请检查设备连接与 shell auth 密码")
        return 1

    remote_amr = "/userdisk/Favorite/Authenticator.amr"
    run_adb(adb_bin, serial, ["shell", "mkdir -p /userdisk/Favorite/Authenticator /userdisk/Authenticator"])
    print("[*] 推送安装包:", remote_amr)
    run_adb(adb_bin, serial, ["push", amr_path, remote_amr])
    run_adb(adb_bin, serial, ["shell", f"miniapp_cli uninstall {APPID} >/dev/null 2>&1"])
    res = run_adb(adb_bin, serial, ["shell", f"miniapp_cli install {remote_amr}"])
    print("[*] miniapp_cli install:", res.strip())

    # 兼容 PenOS 4.3.5 / 4.8.7：将 fs 插件同时推入活跃槽位 libs/
    if os.path.isfile(so_path):
        for root in PKG_ROOTS:
            for slot in ("a", "b"):
                check = run_adb(adb_bin, serial, ["shell", f"[ -d {root}/{APPID}/{slot} ] && echo YES"]).strip()
                if "YES" in check:
                    target = f"{root}/{APPID}/{slot}/libs"
                    run_adb(adb_bin, serial, ["shell", f"mkdir -p {target}"])
                    run_adb(adb_bin, serial, ["push", so_path, target + "/"])
                    print(f"[*] 已补装 fs 插件 -> {target}/")

    # 若启用了 ydpen-toolkit 的 sideload-keeper，同步保活包
    keeper_check = run_adb(adb_bin, serial, ["shell", "[ -d /userdisk/skip_re/amr ] && echo YES"]).strip()
    if "YES" in keeper_check:
        run_adb(adb_bin, serial, ["push", amr_path, "/userdisk/skip_re/amr/Authenticator.amr"])
        print("[*] 已同步 sideload-keeper 保活包: /userdisk/skip_re/amr/Authenticator.amr")

    run_adb(adb_bin, serial, ["shell", f"miniapp_cli start {APPID} index"])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Pen-Authenticator x ydpen-toolkit 部署与 Google 转移工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_parse = sub.add_parser("parse", help="解析 Google 转移链接并可选推送到词典笔 import.txt")
    p_parse.add_argument("input", help="otpauth-migration:// 链接或包含该链接的文本文件")
    p_parse.add_argument("--push", action="store_true", help="直接通过 ADB 推送到词典笔 import.txt")
    p_parse.add_argument("--adb", default="adb")
    p_parse.add_argument("--serial", default=None)
    p_parse.add_argument("--password", default="ydpen2026")

    p_inj = sub.add_parser("inject-fs", help="向 .amr 注入 ydpen-toolkit 的 fs 原生插件")
    p_inj.add_argument("in_amr")
    p_inj.add_argument("out_amr", nargs="?", default=None)
    p_inj.add_argument("--so", default=DEFAULT_SO)

    p_inst = sub.add_parser("install", help="通过 ADB 认证并安装 .amr（自动补装 fs 插件并同步保活）")
    p_inst.add_argument("amr")
    p_inst.add_argument("--adb", default="adb")
    p_inst.add_argument("--serial", default=None)
    p_inst.add_argument("--password", default="ydpen2026")
    p_inst.add_argument("--so", default=DEFAULT_SO)

    args = ap.parse_args()

    if args.cmd == "parse":
        raw = open(args.input, "r", encoding="utf-8").read() if os.path.isfile(args.input) else args.input
        lines = []
        for token in raw.split():
            if token.lower().startswith("otpauth-migration://"):
                for acc in parse_migration_uri(token):
                    lines.append(acc["uri"])
                    print(f"[+] {acc['issuer'] or '（无服务名）'} | {acc['account']} | {acc['algorithm']} {acc['digits']}位")
                    print(f"    {acc['uri']}")
            elif token.lower().startswith("otpauth://"):
                lines.append(token)
        if not lines:
            print("[!] 未找到有效的 otpauth-migration:// 或 otpauth:// 链接")
            return 1
        if args.push:
            if not ensure_adb_auth(args.adb, args.serial, args.password):
                print("[!] ADB 未认证，无法推送")
                return 2
            tmp_file = os.path.join(HERE, "_tmp_import.txt")
            with open(tmp_file, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(lines) + "\n")
            run_adb(args.adb, args.serial, ["shell", "mkdir -p /userdisk/Favorite/Authenticator /userdisk/Authenticator"])
            run_adb(args.adb, args.serial, ["push", tmp_file, "/userdisk/Favorite/Authenticator/import.txt"])
            run_adb(args.adb, args.serial, ["push", tmp_file, "/userdisk/Authenticator/import.txt"])
            os.remove(tmp_file)
            print(f"[✓] 已推送 {len(lines)} 条账号到词典笔 import.txt，可在设置页点击「从文件导入」")
        return 0

    if args.cmd == "inject-fs":
        out = args.out_amr or args.in_amr.replace(".amr", "-fs.amr")
        return inject_fs_plugin(args.in_amr, out, args.so)

    if args.cmd == "install":
        return install_to_pen(args.amr, args.adb, args.serial, args.password, args.so)

    return 0


if __name__ == "__main__":
    sys.exit(main())
