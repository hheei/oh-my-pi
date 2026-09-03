# 发布检查清单

本文件记录本 fork 的 npm 发布边界、版本来源和可重复执行的发布步骤。它不是变更日志；每次发布前按对应包的清单核对。

## 发布边界

- **只发布 `@hheei/*` fork 包。** `@oh-my-pi/*` 是上游命名空间；除非明确维护上游发布流程，绝不改其版本或向 npm 发布。
- fork 的 `main` 追踪 `origin/main`；同步上游前先 `git fetch upstream --prune`，随后按仓库规则 rebase/fast-forward。
- 每一个 `package.json` 版本改动都必须同步 `bun.lock`。发布 workflow 使用 `bun install --frozen-lockfile`；lockfile 不一致会在安装步骤失败。
- 不混合本地 WIP 与发布提交。发布前使用 `git status --short --branch` 和 `git diff --check`；只暂存本次发布涉及的 manifest、lockfile、源码、测试与文档。

## 当前包与版本来源

| npm 包 | 当前发布版本 | manifest / 版本字段 | CI 发布方式 | 自动触发路径 |
| --- | --- | --- | --- | --- |
| `@hheei/oh-my-pi` | `1.0.2` | `packages/coding-agent/package.json` 的 `fork.npmName` / `fork.npmVersion` | `.github/workflows/oh-my-pi-publish.yml` 打包后发布 | 仅 `packages/coding-agent/package.json` |
| `@hheei/omp-optimizer` | `0.1.2` | `packages/hepi/omp-optimizer/package.json` 的 `name` / `version` | `.github/workflows/omp-optimizer-publish.yml` | package manifest 或该 workflow |
| `@hheei/omp-enhance` | `0.1.0` | `packages/hepi/omp-enhance/package.json` 的 `name` / `version` | `.github/workflows/omp-enhance-publish.yml` | package manifest 或该 workflow |
| `@hheei/omp-mctx` | `0.1.0` | `packages/hepi/omp-mctx/package.json` 的 `name` / `version` | **没有 CI publish workflow**；它有 `publishConfig.access: public`，但不应默认发布 | 无 |

发布 workflow 均先查询 npm；同名同版本已经存在时会跳过 publish。因此发布版本必须是新的、尚未存在的 semver 版本。

## Oh My Pi：上游同步与 fork 发布版本

`packages/coding-agent/package.json` 同时保存两个彼此独立的版本轴：

- `version`：内部 workspace / 上游源码版本。**必须**跟随当前已同步的上游版本，本次为 `18.1.6`。
- `fork.upstreamVersion`：记录最近同步的上游版本。**必须**与 `version` 保持相同，本次为 `18.1.6`。
- `fork.npmName`：fork 的公开 npm 名称，当前为 `@hheei/oh-my-pi`。
- `fork.npmVersion`：fork 的公开 npm 发布版本，当前为 `1.0.2`；它不需要也不应与上游版本相同。

`oh-my-pi-publish.yml` 在 `bun pm pack` 前临时将 npm manifest 改为 `fork.npmName` 和 `fork.npmVersion`，随后发布 tarball；源码 manifest 的 `name`、`version` 和 workspace lockfile 不应为了 fork npm 版本而改写。

## 每次发布前

1. 确认基线和 WIP：
   ```bash
   git status --short --branch
   git diff --check
   git fetch upstream --prune
   ```
2. 仅更新目标包的版本字段：
   - `oh-my-pi`：只更新 `fork.npmVersion`；同步上游时更新 `version` 和 `fork.upstreamVersion` 到同一个上游版本。
   - hepi 扩展：更新自己的 `version`，同时更新 changelog（若该包维护 changelog）。
3. 在仓库根目录执行 `bun install`，审阅并暂存正确的 `bun.lock` 更新；再确认：
   ```bash
   bun install --frozen-lockfile
   git diff --check
   ```
4. 运行最窄的相关验证：
   - `oh-my-pi`：`bun --cwd=packages/coding-agent run check`，以及变更覆盖的测试。
   - `omp-optimizer` / `omp-enhance`：在包目录运行 `bun run check && bun test src`。
   - `omp-mctx`：在包目录运行 `bun run check` 和该包的 `bun test`。
5. 确认 npm 版本尚未发布：
   ```bash
   npm view <package-name>@<version> version --registry=https://registry.npmjs.org
   ```
   预期新版本返回 404；若已存在，不要覆盖或重新使用该版本号。

## 提交、推送与触发 CI

1. 将发布改动作为独立提交推送到 `origin/main`。若上游 rebase 重写过 fork 历史，使用 `git push --force-with-lease origin main`，不要使用无保护的 `--force`。
2. 自动触发只监听 manifest；**源码、测试或 lockfile 修复不会自动重新发布**。需要在修复后手动 dispatch：
   ```bash
   gh workflow run oh-my-pi-publish.yml --repo hheei/oh-my-pi --ref main
   gh workflow run omp-optimizer-publish.yml --repo hheei/oh-my-pi --ref main
   gh workflow run omp-enhance-publish.yml --repo hheei/oh-my-pi --ref main
   ```
3. 观察实际发布结果：
   ```bash
   gh run list --repo hheei/oh-my-pi --branch main --limit 10
   gh run view <run-id> --repo hheei/oh-my-pi --log-failed
   npm view <package-name>@<version> version --registry=https://registry.npmjs.org
   ```
4. `omp-mctx` 在添加专用 trusted-publishing workflow 前，不执行 npm 发布；需要发布时先新增并审查对应 CI workflow。

## 常见失败处理

| 症状 | 原因与处理 |
| --- | --- |
| `lockfile had changes, but lockfile is frozen` | 在干净的目标 commit 上运行 `bun install`，提交生成的 `bun.lock`；不要把无关 WIP 的 lockfile 变化带入发布提交。 |
| `Check coding agent` 的 formatter/lint 失败 | 在 `packages/coding-agent` 修复后运行其 `bun run check`；源码修复后用 `workflow_dispatch` 重跑发布。 |
| `gh api` 经 `127.0.0.1:7890` 报 `connection reset by peer` | 这是本地代理瞬时断连。先重试；持续发生时检查/重启代理。认证和 npm publish 权限不是该错误的根因。 |
| npm 中仍查不到版本 | 确认 workflow 已成功完成；发布前和发布后都用 `npm view` 查询精确包名与版本。 |
