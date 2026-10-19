# Fork 工作流：与上游 paseo 保持同步

myVibeBoard 是 `getpaseo/paseo` 的 fork。自研内容尽量放 `plugins/`，对 `packages/` 的核心改动要小、独立、可定位。本文规定远端、合并节奏、提交约定和 GitHub Actions 处理。

## 1. 远端约定

| 远端       | 地址                                       | 用途                        |
| ---------- | ------------------------------------------ | --------------------------- |
| `origin`   | `git@github.com:ferencyim/myVibeBoard.git` | 自己的 fork，唯一 push 目标 |
| `upstream` | `https://github.com/getpaseo/paseo.git`    | 官方上游，只 fetch，不 push |

- **绝不把上游 tag 推到 origin。** 上游 tag（`v*`、`desktop-v*` 等）一旦出现在 fork，会触发发布类工作流。推送时只推分支：`git push origin main`，不要 `--tags`、不要 `--mirror`。
- 本地 `git fetch upstream --tags` 会把上游 tag 拉到本地，这是预期的（用于合并 release），只要不 push 即可。

## 2. 每两周合并一次上游 release

只合并上游**稳定 release tag**（`vX.Y.Z`，不含 `-beta`/`-rc`），不合 upstream/main 的任意提交。

1. 确保 `main` 干净且与 `origin/main` 对齐。
2. `git fetch upstream --tags`，确定最新稳定 tag：`git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1`。
3. 先演练：`pwsh scripts/vibe/upstream-merge-rehearsal.ps1`（见第 5 节），了解冲突范围。
4. 在新分支（如 `sync/upstream-v0.12.1`）上 `git merge <tag>`，解决冲突。冲突若落在 `[core]` 提交改过的文件上，逐个对照该 `[core]` 提交的意图重做，不要整体取一边。
5. 验证顺序：先跑 **plugins 的测试**（自研代码，最可能被上游接口变化打破），再跑**全量**测试与 typecheck。插件声明的 Paseo 版本范围若不再满足，同步更新（见第 4 节）。
6. 验证通过后合入 `main` 并 push `origin main`（只推分支）。

频率：每两周一次，不积压；上游出现安全修复时可提前。

## 3. `[core]` 提交约定

- 凡是修改 `packages/`（以及其他上游拥有的核心文件）的提交，**单独成提交，提交信息以 `[core]` 开头**，例如 `[core] Expose offline data hook in server session`。
- 一个 `[core]` 提交只做一件事，不混入 `plugins/`、文档或格式化改动，以便合并冲突时快速定位、也便于日后摘出来向上游提 PR。
- 对上游文件的非代码小改动（如 `CLAUDE.md` 末尾的 fork 约定）不必加 `[core]`，但保持极小。
- 定位全部核心改动：`git log --grep='^\[core\]' --oneline`。

## 4. 插件声明支持的 Paseo 版本

每个自研插件在自己的 manifest/README 中写明已验证的 Paseo 版本范围（如 `paseo >=0.12.0 <0.13.0`）。每次合并上游 release 并通过测试后，更新这个范围。版本范围不满足时，插件应拒绝加载或给出明确提示，而不是静默失效。

## 5. 合并演练脚本

`scripts/vibe/upstream-merge-rehearsal.ps1`：

- 要求工作区干净；fetch `upstream --tags`；选最新稳定 tag（或 `-Tag` 指定）。
- 若该 tag 已是当前 HEAD 的祖先，直接报告"已合并"。
- 否则建临时分支 `rehearsal/<tag>-<时间戳>`，`git merge --no-commit --no-ff`，收集冲突文件，与 `[core]` 提交涉及的文件求交集并列出，随后 `merge --abort`、切回原分支并删除该临时分支。
- 不 push，不改其他分支。

### 首次演练记录（2026-10-19）

- 本地 `git fetch upstream --tags` 后，最新稳定 tag 为 `v0.12.0`，已是当前基线的祖先，脚本报告 "已合并，无需操作"。
- 用 `-Tag FETCH_HEAD`（`git fetch upstream main` 之后）演练 upstream/main 合并路径：upstream/main 为 `19749baee`，相对基线无新提交，结果 "clean merge"，冲突 0，与 `[core]` 提交重叠 0；脚本正常切回原分支并删除临时分支。
- 目前仓库内尚无 `[core]` 提交。下次有新 release 时再跑一次。

## 6. GitHub Actions 处理

目标：fork 上**只跑 `ci.yml`**；发布、部署、推镜像、依赖上游 secrets 的工作流一律禁用。这些工作流里没有 `github.repository == 'getpaseo/paseo'` 之类守卫，加守卫要改上游文件、每次合并都冲突，所以采用**在 GitHub 上逐个禁用**（`gh workflow disable`），不改任何 workflow 文件。

禁用状态存在 GitHub 仓库设置里，不在代码里，合并上游不会受影响。上游新增工作流时，合并后需检查 `.github/workflows/` 是否有新文件并补禁用（合并步骤第 4 步顺带检查：`git diff --stat HEAD~ -- .github/workflows`）。

### 逐个结论

| 工作流                    | 触发                                        | 在 fork 上的风险                                                                                                                                 | 结论                                                                 |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `ci.yml`                  | push/PR main、merge_group、手动             | 纯 CI。部分测试用 `CLAUDE_CODE_OAUTH_TOKEN`、`OPENAI_API_KEY`、`OPENROUTER_API_KEY`，fork 无这些 secrets，对应的真实 provider 用例会失败或被跳过 | **保留**；provider 用例失败属预期，需要时再在 fork 配 secrets 或调整 |
| `desktop-packages.yml`    | push main、桌面相关 PR                      | 仅打包冒烟（`contents: read`），无发布，但耗时长、占分钟数                                                                                       | 禁用（需要验证桌面打包时再启用）                                     |
| `nix.yml`                 | push main                                   | 仅构建 nix 包，无发布，但会因上游 hash 与 fork lockfile 不一致而红                                                                               | 禁用                                                                 |
| `nix-update-hash.yml`     | push main（相关路径）                       | 需上游 GitHub App secrets（`PASEO_BOT_APP_ID/PRIVATE_KEY`），并向 main 自动 push                                                                 | **禁用**                                                             |
| `release-notes-sync.yml`  | push `v*` tag、main 的 CHANGELOG 变更、手动 | 建/改 GitHub Release                                                                                                                             | **禁用**                                                             |
| `android-apk-release.yml` | push `v*`/`android-v*` tag、手动            | 建 Release、上传 APK，需 `EXPO_TOKEN`                                                                                                            | **禁用**                                                             |
| `desktop-release.yml`     | push `v*`/`desktop-*` tag、手动             | 签名公证（Apple 证书类 secrets）、发布 Release                                                                                                   | **禁用**                                                             |
| `desktop-rollout.yml`     | 仅手动                                      | 改写 Release 更新元数据                                                                                                                          | **禁用**（防误触发）                                                 |
| `docker.yml`              | push main、`v*` tag、手动                   | 推镜像到 ghcr.io，镜像名为 `ghcr.io/getpaseo/paseo`                                                                                              | **禁用**                                                             |
| `deploy-app.yml`          | push `v*`/`app-v*` tag、手动                | 部署 Cloudflare，需 `CLOUDFLARE_API_TOKEN`                                                                                                       | **禁用**                                                             |
| `deploy-website.yml`      | push main（部分路径）、release、手动        | 部署 Cloudflare                                                                                                                                  | **禁用**                                                             |
| `deploy-relay.yml`        | 仅手动                                      | 部署 relay Worker                                                                                                                                | **禁用**（防误触发）                                                 |

### 需要执行的 gh 命令（由主代理征得用户同意后执行）

先确认仓库已启用 Actions（fork 默认首次需在 Actions 页点同意启用；这是用户决定，不在本文范围）。启用后逐个禁用：

```bash
R=ferencyim/myVibeBoard
for w in desktop-packages nix nix-update-hash release-notes-sync android-apk-release \
         desktop-release desktop-rollout docker deploy-app deploy-website deploy-relay; do
  gh workflow disable "$w.yml" --repo "$R"
done
gh workflow list --all --repo "$R"   # 核对：只有 CI 为 active
```

回滚：`gh workflow enable <name>.yml --repo ferencyim/myVibeBoard`。

另：fork 的 Actions 设置里保持"不向 fork PR 暴露 secrets"的默认值，并且不要在 fork 配置 `CLOUDFLARE_API_TOKEN`、Apple 证书、`EXPO_TOKEN` 等发布类 secrets。
