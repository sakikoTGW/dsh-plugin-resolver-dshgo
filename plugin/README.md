# dsh-plugin-resolver-dshgo

[dsh-plugin-resolver](https://github.com/sakikoTGW/dsh-plugin-resolver) 的 **dsh-go 手机 harness 适配版**（`0.1.3-go.1`）：工具名、参数、版本选择规则、安装路径全部沿用上游；改动只针对“在手机上跑”和“在 dsh-go 里看”。

- 源码 / 消融数据 / 问题记录：<https://github.com/sakikoTGW/dsh-plugin-resolver-dshgo>
- 上游基线：`dsh-plugin-resolver@0.1.3`（MIT，sakikoTGW）
- 适用：dsh-go（Android · arm64 proot）· DSH `>=0.2.0-rc.2 <0.3.0` · Node `>=20`

## 安装

```sh
# npm
dsh plugin --profile web add dsh-plugin-resolver-dshgo

# 或锁 GitHub commit（更稳）
dsh plugin --profile web add github:sakikoTGW/dsh-plugin-resolver-dshgo#<40位commit>
```

装完在 dsh-go 引擎页重启一次引擎，四个工具上线：`plugin_search` / `plugin_resolve` / `plugin_install` / `plugin_status`。每个工具结果都带 `dsh-go/view` 原生卡片，文字版保持不变。

## 相对上游的主要改动

| 上游行为 | 手机上的问题 | 适配版 |
|---|---|---|
| 输出只有纯文本 | 手机上长报告难读 | 四个工具都带 `presentationMeta` → `dsh-go/view` 卡片 |
| 提示 `restart DSH fully` / `Ctrl+R` | App 里不存在这两个操作 | 改成「引擎页重启引擎」「下拉刷新会话」 |
| GitHub 只直连 codeload | 手机网络经常连不上 | `DSH_GITHUB_PROXY` + gh-proxy / ghfast 回退，成功线路记忆 7 天 |
| registry 缺省回落 npmjs | 容易 90 s 超时 | dsh-go 上缺省回落 `registry.npmmirror.com` |
| profile 推断 desktop → web | 手机只有 web | dsh-go 上按 web → desktop |
| pnpm 11 静默跳过构建脚本 | “构建成功但产物坏” | 解析 `Ignored build scripts:` 并告警，透传 `pendingBuilds` |
| 校验只读 loader | headless 无 HMR | 新增 `verify: "quick" \| "deep"`（deep 会 `--dump-config` + 真启动一次 profile） |
| 模型侧输出约 1.8 KB | 每步重读 | 约 270 B（卡片信息不变），版本文档缓存 10 分钟 |

完整对照表、消融数据（无插件 187 s → 插件 deep 48.4 s / 1 次工具调用 / 1,927 token）见仓库 README 与 `ablation/RESULTS.md`。

## 配置（profile 的 `cordis.patch.yml`，可选）

```yaml
- id: plugin-resolver
  config:
    registry: https://registry.npmmirror.com
    githubProxy: https://gh-proxy.com
    catalogTtlMs: 43200000
```

环境变量：`DSH_GITHUB_PROXY`、`DSH_GO=1`（非 dsh-app 主机上强制按手机处理）、`DSH_PNPM_PATH`。

## 已知限制

- 已装插件重复安装会被管理器拒绝（先 remove 再换版本）；
- GitHub 源码构建在手机上以 root 执行，最长 10 分钟，请只装可信仓库；
- 同名消歧、兼容性判定、重启判定等上游限制照旧。

## 许可

MIT（上游 sakikoTGW）· 本适配版同样以 MIT 发布，见 LICENSE。
