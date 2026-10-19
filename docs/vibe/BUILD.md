# 本机三端构建指南（Windows 11）

实测日期：2026-10-19，基于 paseo 0.12.0（分支 `p0/setup`）。三端均已在本机构建成功。

## 环境与版本差异

| 项          | 仓库要求                                     | 本机                                                               | 影响                                                                              |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Node        | `.tool-versions` 为 22.20.0                  | 24.16.0                                                            | daemon/桌面/Web 构建与运行均正常，无影响                                          |
| Java        | `.tool-versions` 为 21                       | 默认 JDK 25（Temurin）                                             | **Android 构建失败**：Gradle 8.14.3 不支持 class file 69（JDK 25）。必须用 JDK 21 |
| Android SDK | `.tool-versions` 为 mise 的 android-sdk 21.0 | `%LOCALAPPDATA%\Android\Sdk`（platforms 34-37、build-tools 34-37） | 可用；Gradle 构建时自动装了 NDK 27.1.12297006                                     |
| Rust        | 1.85.1                                       | 未使用                                                             | 三端均不需要                                                                      |
| 包管理      | npm（`package-lock.json`）                   | npm                                                                | 用 `npm ci`                                                                       |

本机无 JDK 21，已把 Temurin 21 解压（免安装、不改系统环境）到 `D:\devRepoCaches\jdk21\jdk-21.0.12.1+1`，仅在构建 Android 时通过 `JAVA_HOME` 指向它。`ANDROID_HOME` 也需手动指定。

## 0. 安装依赖

```bash
npm ci        # 约 4 分钟，2677 个包；postinstall 会打 patches/ 下的补丁
```

注意 `npm ci` 触发 `prepare` 会安装 lefthook 的 git pre-commit 钩子。

## 1. daemon / server / CLI

```bash
npm run build:server      # highlight/plugin/relay/protocol/client -> server -> cli，约几分钟
```

产物：

- `packages/server/dist/`（daemon，入口 `dist/scripts/supervisor-entrypoint.js`）
- `packages/cli/dist/index.js`（`paseo` 命令，`packages/cli/bin/paseo` 为包装脚本）

启动与停止（用隔离的 home，避免碰到 `~/.paseo` 里正式使用的 daemon）：

```bash
export PASEO_HOME="$TEMP/paseo-build-home"
node packages/cli/dist/index.js --home "$PASEO_HOME" daemon start --timeout 90
node packages/cli/dist/index.js --home "$PASEO_HOME" daemon status
node packages/cli/dist/index.js --home "$PASEO_HOME" daemon stop
```

实测：daemon 启动成功，监听 `127.0.0.1:6767`，日志在 `$PASEO_HOME/daemon.log`，已停止。要点：

- **`PASEO_LISTEN` 环境变量对 `daemon start` 不生效**，仍监听默认的 6767（`npm run dev` 才会把它用于 6768）。若本机已有正式 daemon 占用 6767，需要改 home 下的配置或换端口，不要直接 start。
- 开发模式：`npm run dev:win`（`scripts/dev.ps1`，daemon 6768 + Metro）；`npm run dev` 在 Windows 走 `scripts/dev-daemon.sh`，需 bash。
- `daemon status` 偶尔提示 `DAEMON_REQUEST_TIMEOUT 1500ms`（状态详情超时），但 `connectedDaemon: reachable`，属首次启动较慢，不影响使用。

## 2. 桌面端（Electron）

先出 Web 前端（桌面包会打入 `packages/app/dist`），再打 unpacked 包：

```bash
# 1) Web 前端，必须带 electron 平台标记
cd packages/app && PASEO_WEB_PLATFORM=electron npm run build:web      # 约几分钟，产物 packages/app/dist
# 2) Electron 主进程
cd ../desktop && npm run build:main
# 3) 打 unpacked 包（不签名、不出安装包）
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.yml --win --x64 --dir
```

产物：`packages/desktop/release/win-unpacked/Paseo.exe`（约 235 MB，未签名）。

实测：双击/命令行启动可运行，自带的桌面托管 daemon 随之在 `127.0.0.1:6767` 启动；已关闭。要点：

- 官方 `npm run build` 会先 `build:server:clean` 再出安装包（nsis/zip），这里改用 `--dir`，所以不用 `npm run build`。
- electron-builder 日志出现 `cannot move downloaded into final location ... Access is denied`（winCodeSign 缓存并发解压）和 `signing with signtool.exe` 字样，但最终退出码 0，exe 状态 `NotSigned`，可忽略。
- 启动时报 `app-update.yml` 不存在（自动更新检查失败），因为是 `--dir` 产物，可忽略。
- 打包后的 exe 把命令行参数当作 CLI 子命令，**不能传 `--user-data-dir`**；用 `PASEO_HOME` 环境变量隔离数据目录。
- 桌面开发模式（热更新）：`npm run dev:desktop`（Windows 对应 `packages/desktop/scripts/dev.ps1`），本次未跑。

## 3. Android debug APK

```bash
cd packages/app
export JAVA_HOME='D:\devRepoCaches\jdk21\jdk-21.0.12.1+1'
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export APP_VARIANT=development
(cd ../.. && npm run build:client)
npx expo prebuild --platform android --clean --non-interactive     # 生成 packages/app/android（已被 gitignore）
# 先修 enriched-markdown 的 tree-sitter 语法（见下文问题 2），在 PowerShell 中执行：
#   cd packages/app/node_modules/react-native-enriched-markdown ; node postinstall.mjs
cd android && ./gradlew.bat assembleDebug --no-daemon              # 首次约 19 分钟
```

官方的 `npm run android:development` 等价于 prebuild + `expo run:android --variant=debug`，后者会直接装到设备/模拟器，所以这里只用 `assembleDebug` 出包，不安装。

产物：`packages/app/android/app/build/outputs/apk/debug/app-debug.apk`（485 MB，含全部 ABI；包名 `sh.paseo.debug`，应用名 `Paseo Debug`，versionCode 12000，versionName 0.12.0）。签名为 Expo 模板自带的 debug keystore（`android/app/debug.keystore`，随 prebuild 生成，不入库）。

未安装到任何设备。`adb devices` 当前列出 2 台模拟器（`emulator-5558`、`emulator-5590`，构建期间曾有第三台 `emulator-5620`），**没有真机**。装机命令（需要时自行执行）：`adb -s <serial> install -r packages/app/android/app/build/outputs/apk/debug/app-debug.apk`。

## 遇到的问题与解决

1. **JDK 25 导致 Gradle 报 `Unsupported class file major version 69`**：改用 JDK 21（Temurin 解压到 `D:\devRepoCaches\jdk21`），通过 `JAVA_HOME` 指定。`.tool-versions` 要求的就是 java 21。
2. **`react-native-enriched-markdown` 报 tree-sitter 语法未安装**（紧随其后还有一条连带的 `does not specify compileSdk`）：该包 postinstall 需要下载并解压 tarball，`npm ci` 时没成功拿到语法。直接在 Git Bash 里重跑会因 GNU tar 把 `C:\...` 当成远程主机而失败；在 **PowerShell**（用系统自带 bsdtar）下运行 `node postinstall.mjs` 即成功。末尾的 RaTeX（仅 iOS 数学渲染）下载仍失败，Android 不受影响。语法文件落在 `node_modules` 内，重新 `npm ci` 后需再跑一次。
3. **Gradle 自动安装 NDK 27.1.12297006** 到 `%LOCALAPPDATA%\Android\Sdk\ndk`，属于对 SDK 目录的新增，无需处理。
4. 构建期间 `packages/cli/bin/paseo` 在 `git status` 中显示为已修改，是 `core.autocrlf=true` 带来的行尾差异（`i/lf w/mixed`），内容无实质改动，未提交。

## 未解决 / 待办

- 未提交上游源码改动；三端构建均未改动 `packages/` 下任何文件。
- 桌面端只验证了 unpacked 包能启动并拉起 daemon，未验证窗口内 UI 与连接流程；未出 nsis 安装包。
- `daemon start` 不尊重 `PASEO_LISTEN`，若要在本机与正式 daemon 并存，需要另行确认配置项（P0 后续再查）。
- debug APK 体积 485 MB（全 ABI + debug 符号），真机安装可考虑只构建 arm64（`-PreactNativeArchitectures=arm64-v8a`），本次未试。
- 每次都要手动设 `JAVA_HOME` 与 `ANDROID_HOME`；如需固化，可在 `packages/app/android/gradle.properties`（被 gitignore）里加 `org.gradle.java.home`。
