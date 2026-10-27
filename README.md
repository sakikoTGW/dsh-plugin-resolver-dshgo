# dsh-plugin-resolver-dshgo

> [dsh-plugin-resolver](https://github.com/sakikoTGW/dsh-plugin-resolver) 的 **dsh-go 手机 harness 适配版**：工具名、参数、版本选择规则、安装路径全部沿用上游；改动只针对“在手机上跑”和“在 dsh-go 里看”。

- 包名：`dsh-plugin-resolver-dshgo` · 版本：`0.1.3-go.1` · License：MIT（上游 sakikoTGW，本仓库为适配分支）
- 上游基线：[dsh-plugin-resolver@0.1.3](https://github.com/sakikoTGW/dsh-plugin-resolver)（`engines.dsh >=0.2.0-rc.2 <0.3.0`，Node >=20）
- 本机验证环境：dsh-go（Android · arm64 proot）· DSH `0.2.1-rc.2` · Node `24.22.1` · pnpm `11.28.5`

## 安装

**GitHub 源（推荐，锁 commit）**

```sh
# 本仓库首个发布提交（v0.1.3-go.1）
dsh plugin --profile web add github:sakikoTGW/dsh-plugin-resolver-dshgo#838f74751e697bdf91e995bbbb2ddaa0c7558b65
```

**本地开发（装的是指向 `plugin/` 的链接，别删这个目录）**

```sh
git clone https://github.com/sakikoTGW/dsh-plugin-resolver-dshgo
dsh plugin --profile web add /path/to/dsh-plugin-resolver-dshgo/plugin
```

**卸载**

```sh
dsh plugin --profile web remove dsh-plugin-resolver-dshgo
```

装完在 dsh-go 引擎页重启一次引擎，四个工具（`plugin_search` / `plugin_resolve` / `plugin_install` / `plugin_status`）就上线了；之后改 `logic/` 下一次工具调用即生效，改 `host/register.js` 或 `index.js` 需重启引擎。

**可选配置**（profile 的 `cordis.patch.yml`）

```yaml
- id: plugin-resolver
  config:
    registry: https://registry.npmmirror.com
    githubProxy: https://gh-proxy.com
    catalogTtlMs: 43200000
```

环境变量：`DSH_GITHUB_PROXY`（GitHub 下载前缀）、`DSH_GO=1`（在非 dsh-app 主机上强制按手机处理）、`DSH_PNPM_PATH`（源码构建用的 pnpm）。

## 相对上游改了什么

| 上游行为 | 手机上的问题 | 适配版 |
|---|---|---|
| 输出只有纯文本 | 手机上长报告难读 | 四个工具都带 `presentationMeta` → `dsh-go/view` 卡片：搜索是列表、解析是计划卡、安装是步骤条、状态是清单。文字版原样保留，桌面端不受影响 |
| 安装后提示 `restart DSH fully` / `Ctrl+R` | 这两个操作在 App 里不存在 | 检测到 dsh-go 时改成「在 App 的引擎页重启引擎」「下拉刷新会话」 |
| GitHub 只直连 codeload，代理只能写 profile patch | 手机网络经常连不上 | 支持 `DSH_GITHUB_PROXY`；直连失败自动换 `gh-proxy.com` / `ghfast.top`；成功的下载方式记 7 天，下次先走它 |
| registry 缺省回落 npmjs.org | 手机上容易 90 秒超时 | dsh-go 上缺省回落 `registry.npmmirror.com` |
| profile 推断按 desktop → web | 手机只有 web，顺序反了会读错 | dsh-go 上按 web → desktop |
| `pnpm install` 跳过被 pnpm 11 拦下的构建脚本却不吭声 | 会出现“构建成功但产物坏” | 解析 `Ignored build scripts:`，在文字和卡片里告警；`plugin_install` 的 `pendingBuilds` 也一并提示 |
| 构建超时 20 分钟、下载 5 分钟 | 手机后台易被冻结 | dsh-go 上构建 10 分钟、单次下载 90 秒，失败快速换镜像 |
| 源码构建无沙箱、以 root 执行 | 风险不透明 | 计划卡和安装卡上直接写明，只构建可信仓库 |
| `plugin_status` 把绝对路径加载的 entry 当第三方 | dsh-app 的桥接会混进列表 | 过滤绝对路径 / `cordis:` / `file:` / `node:` |
| `resolvePnpm()` 只认 `DSH_PNPM_PATH` 和 PATH | 部分宿主的 pnpm 不在 PATH | 追加 `/usr/local/bin/pnpm`、`/usr/bin/pnpm`、`/opt/pnpm/bin/pnpm` |
| 模型侧输出约 1.8 KB | 每步都要重读 | 约 270 B（卡片信息不变），版本文档缓存 10 分钟 |
| 安装后校验只能读 loader | headless 没有 HMR，看不到 entry | 新增 `verify: "quick" \| "deep"`；deep 会 `--dump-config` + 真启动一次 profile |

细节与卡片示意见 [plugin/README.dsh-go.md](plugin/README.dsh-go.md)。

## 效果（同一模型、同一任务、全新 profile）

**第一轮**（headless 两臂，无插件 vs 有插件）

| | 无插件 | 有插件 |
|---|---|---|
| 耗时 | 337 / 215 s | 116 / 125 s |
| step | 37 / 42 | 19 / 18 |
| 输入+输出 token | 72.7k / 60.2k | 15.2k / 15.2k |

**第二轮**（优化后三臂：无插件 / 插件 quick / 插件 deep）

| 臂 | 墙钟 | step | 工具调用 | 输入+输出 token |
|---|---|---|---|---|
| 无插件 | 187.0 s | 21 | 33 | 29,423 |
| 插件 + quick | 54.6 s | 15 | 14 | 14,245 |
| 插件 + deep | **48.4 s** | **2** | **1** | **1,927** |

deep 的 48.4 s 里有 26.7 s 是它自己启动一次 profile 验所有 entry——即使这样仍最快，因为全程只有 1 次工具调用。结论：贵的不是校验，是模型为自证多走的十几步。

口径：第二轮 quick/deep 的提示词点名了校验方式；基线历史波动 187–337 s；单次数据看方向。完整方法、原始事件流与复现命令见 [ablation/RESULTS.md](ablation/RESULTS.md)、[ablation/runs/](ablation/runs/)。

## 时间花在哪（一次 121 s 的插件运行）

- 模型往返 43.1 s（18 步 × 2.4 s）
- 两次“起新引擎验证” 52.0 s（每次 26 s：4 s 启动 + 2 s 回答 + **22 s 退出等待**）
- pnpm 安装 8.9 s（热缓存 3.7 s）
- 解析 2.8 s + 状态 2.4 s
- 引擎开销 8.9 s；主进程启动 4.7 s（不在会话跨度内）

那 22 s 退出等待是 `dsh-builtin-browser` 自己造成的：把它的 bundle 从 profile 去掉，同样命令 4.0 s 就退出（这个网络下它加载时的请求要等超时）。

## 发现的问题

这次适配过程中记录到 6 个 dsh-go / harness 侧的问题（会话污染、投影缓存、子代理权限、`--help` 启动、编译缓存、会话来源标记），详情与复现步骤见 [FINDINGS.md](FINDINGS.md)。

## 复现

```sh
# 1) 干净 profile（headless 模板 + 账号与模型 patch，见 RESULTS.md）
dsh --profile abx-plain --from-default-profile headless

# 2) 需要插件的臂
dsh plugin --profile abx-quick add /path/to/plugin

# 3) 跑（脚本自带 flock 串行、输出 summary JSON）
./ablation/bench.sh abx-quick quick-a "在当前 profile 里安装插件 dsh-builtin-browser（npm 包），装好后确认它真的安装成功、能加载。"
```

## 已知限制

- 已装插件重复安装会被管理器拒绝（先 remove 再换版本）；
- GitHub 源码构建仍在手机上以 root 执行、最长 10 分钟；
- 宣传图（`plugin/assets/banner.*`）上的名字是旧命名 `dsh-plugin-solve-go`，包名与安装命令以 `dsh-plugin-resolver-dshgo` 为准，改名需重绘 banner 并同步 `package.json` / `cordis.patch.yml` / 安装命令；
- 上游同名消歧、兼容性判定、重启判定等限制照旧。

## 许可与致谢

- 上游 [sakikoTGW/dsh-plugin-resolver](https://github.com/sakikoTGW/dsh-plugin-resolver)（MIT）· 本适配版同样以 MIT 发布，见 [LICENSE](LICENSE)。
- 适配与实验在 [dsh-go](https://github.com/ccch1mneyyy/dsh-go)（非官方 Android 客户端）上完成；dsh-go 与 DeepSeek 无关联。
