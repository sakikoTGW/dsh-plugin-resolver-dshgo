# 适配过程中发现的问题

2026-10-27，在 dsh-go（Android · arm64 proot）上跑 `dsh-plugin-resolver-dshgo` 的适配与消融时记录。每条都附证据与建议，按“是否影响普通用户”排序。

> 已汇总提交到 dsh-go 仓库：**<https://github.com/ccch1mneyyy/dsh-go/issues/57>**（六合一，App 0.9.2，含侧边栏截图）。

环境：dsh-go App `0.9.2`（内测包，Android 8+ / arm64）· DSH `0.2.1-rc.2` · Node `24.22.1` · pnpm `11.28.5` · `DSH_PERMISSION_MODE=danger-full-access`。

## 1. 一次性 `headless` 运行会污染 App 侧边栏，且无法与真实对话区分

- **现象**：`dsh --profile … headless` 每跑一次就会在 `~/.dsh/sessions/<workspace>/` 落一个会话；App 如实列出，但全部显示为“未命名对话”。这次实验产生 13 个实验会话 + 4 个子代理会话，侧边栏被塞满（见 [screenshots/sidebar-untitled-chats.jpg](screenshots/sidebar-untitled-chats.jpg)）。
- **期望**：agent 拉起的 headless/subagent 会话要么不出现在列表里，要么带来源标记并默认折叠。
- **建议**：会话元数据加 `origin: user | headless | subagent`；App 列表默认折叠非 `user` 来源；CLI 提供 `--no-session`（或 `--ephemeral`）开关。
- **现状**：`ablation/clean-sessions.mjs` 按首条用户消息正则清理（默认 dry-run，`--apply` 才删）。

## 2. 投影缓存不自愈：会话删除后留下“点不开的幽灵会话”

- **现象**：会话文件删掉后，`~/.dsh/storages/session_projcache/sessions/*.json` 仍留着 20 条指向已删会话的条目。若 App 列表读这份缓存，会出现点不开的幽灵会话。
- **期望**：读取/启动时按 session 目录做一次剪枝，或删除会话时级联删缓存。
- **现状**：`clean-sessions.mjs --apply` 手动剪枝（`session_projcache/sessions` 下 session 已不存在的 `.json`）。

## 3. 子代理不能提权：`sandbox_permissions` 在无沙箱后端时被自动拒绝

- **现象**：子代理的 bash 权限固定为 `workspace-write`；本机没有可用的沙箱后端，申请 `danger-full-access` 又被自动拒绝（“approval prompts disabled → rejected automatically”），导致子代理跑不了实验命令，只能主会话跑。
- **期望**：父会话已是 full access 时子代理可继承；或允许显式配置“子代理权限跟随父会话”。
- **建议**：给子代理权限一个继承/覆盖配置；提权失败时在子代理结果里明确写出原因，不要静默降级。

## 4. `dsh --profile X --help` 会完整启动引擎（带重插件约 26 s）

- **现象**：只想看 CLI 参数，却触发 profile 组合与插件加载；带重插件的 profile 约 26 s。`--dump-config` 只要 0.25 s。
- **期望**：`--help` / `--version` 这类纯 CLI 参数应在加载 profile 前返回。
- **证据**：本机计时；同一 profile 下 `--dump-config` 0.25 s vs `--help` 26 s。

## 5. `NODE_COMPILE_CACHE` 对引擎启动没有可测收益

- **现象**：带与不带 `NODE_COMPILE_CACHE`，引擎冷启动都约 4 s，差异在噪声内。
- **期望**：要么有收益，要么在文档里明确“对本场景无效”，避免用户白折腾。
- **建议**：给出官方建议的启动加速方式（或说明瓶颈在组合/插件加载而非 V8 编译）。

## 6. App 缺少会话来源标记

- **现象**：agent 拉起的 headless/subagent 会话与用户对话在列表里外观一致（除标题为空），无法区分。
- **建议**：会话列表项显示来源角标（`headless` / `subagent` / `remote`），并允许按来源过滤。

## 附：本仓库相关的非问题

- `dsh-builtin-browser` 退出时要等约 22 s：去掉它的 bundle 后同样命令 4.0 s 退出，属该插件加载时网络请求等超时，不是 dsh-go 的调度问题。
- pnpm 11 会跳过被拦下的构建脚本且默认只有一行提示：适配版已在 `Ignored build scripts:` 出现时告警，并透传 `pendingBuilds`。
