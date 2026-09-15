---
name: "electron-release"
description: "Release this Electron app: bump version, build Windows portable exe locally (mirror/PATH fixes), push v* tag to build macOS dmgs via GitHub Actions, verify. Invoke on 发版/发布/打tag/构建新版本."
---

# Electron 日程侧边栏发版 SOP

本技能固化本工作区（Electron 44 日程侧边栏）的完整发版链路与本机踩坑。触发词：用户说"发版 / 发布新版本 / 打 tag / 构建新版本 / 出 Win 版 + 云端 mac 版"。

产物约定：
- **Windows**：本地 `electron-builder --win portable` → `dist\日程侧边栏-<version>-便携版.exe`（中文文件名保留，本地正常）。
- **macOS**：云端 GitHub Actions 出 arm64/x64 双 dmg → `TimetableSidebar-<version>-mac-<arch>.dmg`（**必须 ASCII**，曾因中文前缀被云端清洗成 `-x.x.x-mac-arm64.dmg`）。
- **没有也不支持 iOS**；CI 仅 macOS。用户若说"ios 版"，要澄清这是 macOS dmg。

## 0. 铁律
- 任何远端变更（commit/push/tag）前先盘点并冻结范围；只提交发版必需文件，不夹带。
- 版本号（package.json）与 git tag 必须一致；先发普通提交升版本，再打 tag。
- 结论必须基于命令真实输出：push 成功看 `旧sha..新sha  main -> main`，不要把 PowerShell 的 `NativeCommandError` 误判为失败（git 进度走 stderr 被包装）。
- `dist/`、`node_modules/` 已 gitignore，产物不入库。
- 普通向 main 的 push **不触发**构建；工作流只认 `workflow_dispatch` 与 `push.tags: v*`。

## 1. 发版前核查与版本冻结
1. 读 `package.json` 的 `version`；`git tag --list` 看已有标签，确定新版本号（语义化，如 0.2.1）。
2. 确认 `git status -sb` 干净、本地与 `origin/main` 同步（必要时先同步）。
3. 同步版本号三处：`package.json` 1 处、`package-lock.json` 2 处（顶层 version 与 `packages[""].version`）。
4. 用 node 校验 JSON：`& "C:\Program Files\nodejs\node.exe" -e "console.log(require('./package.json').version)"`。

## 2. 提交版本号并推送 main（不触发构建）
PowerShell 用分号串联，不要用 `&&`。多行 message 用 `git commit -F <临时文件>`，单行可 `-m`：
```powershell
git add package.json package-lock.json
git commit -m "发布 vX.Y.Z：版本号提升至 X.Y.Z"
git push origin main 2>&1 | Out-String
```
看到 `旧sha..新sha  main -> main` 即成功，再用 `git status -sb` 复核无 ahead/behind。

## 3. Windows 本地打包（关键环境修正，必做）
本机 node 装在 `C:\Program Files\nodejs`（node v24、npm 11），但 PATH 里的 nodejs 段曾被截断成无效的 `ram Files\nodejs\`，导致 electron-builder 内部 `npm ls --json` 找不到 npm、输出"命令无法识别"非 JSON，报 **`No JSON content found in output`**。所以每次构建都要：
1. 前置正确 nodejs 到 PATH，并设国内镜像 + 关闭证书自动发现：
```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
(Get-Command npm).Source   # 必须能解析到 C:\Program Files\nodejs\npm.* 再继续
```
   - 镜像用于解决从 github 拉 electron/winCodeSign/nsis 时 `ETIMEDOUT 20.205.243.166:443`。
2. 打包（直接用 node 跑 builder，避免 npm 包装层）：
```powershell
& "C:\Program Files\nodejs\node.exe" "node_modules\electron-builder\out\cli\cli.js" --win portable 2>&1 | Out-String
```
   - 日志最后应出现 `building target=portable file=dist\日程侧边栏-X.Y.Z-便携版.exe`，无 `⨯`、退出码 0。
   - 若 `git add` 偶发 `.git/objects ... Permission denied`（杀软瞬时占用）：确认无 `index.lock`、无残留 git 进程后直接重试即可（git 对象写入幂等）。

## 4. 打 tag 推送触发云端 macOS 构建
版本提交在远端后：
```powershell
git tag --list vX.Y.Z                       # 确认不存在
git tag -a vX.Y.Z -m "vX.Y.Z <简述>"
git push origin vX.Y.Z 2>&1 | Out-String    # 看到 * [new tag] vX.Y.Z -> vX.Y.Z
```
工作流：`.github/workflows/build-mac.yml`，两个 job（arm64 macos-14 原生；x64 同机经 Rosetta 跑 x64 Node），约 1–3 分钟；tag 触发还会创建 Release 并附加 dmg。

## 5. 轮询并核验云端结果（无需 gh，用公开 REST API）
`gh` 未安装；公开仓库匿名可调 GitHub API（限额 60/小时，节制轮询），所有请求带头 `User-Agent` 与 `Accept: application/vnd.github+json`。
- 列最近运行：`GET /repos/AkerArchi-coding/time-table-sidebar/actions/runs?per_page=5`
  - tag 触发的运行 `head_branch` 显示为标签名（如 `vX.Y.Z`）、`event=push`；按此过滤拿 `id`。
- 每 20s 轮询 `GET .../actions/runs/<id>` 直到 `status=completed`，读 `conclusion`（success/failure）。
- jobs：`GET .../actions/runs/<id>/jobs`，核对两个 job 均 success，失败则列出非 success 的 step。
- Release：`GET .../releases/tags/vX.Y.Z`，确认 `draft=false`、assets 为
  `TimetableSidebar-X.Y.Z-mac-arm64.dmg`、`TimetableSidebar-X.Y.Z-mac-x64.dmg` 及大小。
- PowerShell 注意：字符串里 `"$id:"` 会被当成驱动器引用报错，用 `${id}` 包裹变量。
- Run/Release 页面：`https://github.com/AkerArchi-coding/time-table-sidebar/actions/runs/<id>` 与 `/releases/tag/vX.Y.Z`。

## 6. Windows 产物核验 + 冒烟
- 存在性与版本：
```powershell
$f = Get-Item -LiteralPath "dist\日程侧边栏-X.Y.Z-便携版.exe"
$f.Length/1MB; $f.VersionInfo.ProductVersion   # 期望 ~96MB、X.Y.Z
```
- 原生模块随包：`dist\win-unpacked\resources\app.asar.unpacked\node_modules\koffi` 应存在；`app.asar` 存在。
- 冒烟启动（无单实例锁；端口避开被迅雷占用的 9222/9229，用 19xxx）：
  启动 `dist\win-unpacked\日程侧边栏.exe --remote-debugging-port=19391`，
  轮询 `http://127.0.0.1:19391/json` 找 `type=page` 且 url 以 `file://` 开头、title 为"桌面日程表"，
  随后 `taskkill /PID <pid> /T /F` 结束测试进程树（不影响用户正在运行的源码实例）。

## 7. 汇报
分别给出：Win 产物绝对路径/大小/版本/冒烟结果；mac 两个 dmg 的 Release 链接与大小；run 结论。
说明过程中仅环境修正（PATH/镜像）未产生代码提交；如改了 `build.artifactName` 等配置则属真实提交，需单独说明。
