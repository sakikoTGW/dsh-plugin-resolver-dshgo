# 消融测试：装插件时，有无 dsh-plugin-resolver-dshgo

2026-10-27，本机 dsh-go（DSH 0.2.1-rc.2 / Node 24.22.1 / pnpm 11.28.5 / arm64 proot）。

## 方法

- 模型相同：`deepseek-account` / `deepseek-flash` / `reasoningEffort: high`，同一账号。
- 环境相同：4 个全新 headless profile，组合都是 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`，
  凭据与 `agent-default-model` 的 patch 相同，`DSH_PERMISSION_MODE=danger-full-access`。
- 唯一差别：`ablate-reso*` 多装一个 `dsh-plugin-resolver-dshgo`（link 到工作区）。
- 每个 profile 只跑一次（目标插件事先都没装）。
- 任务提示词（逐字相同）：

  > 在当前 profile 里安装插件 dsh-builtin-browser（npm 包），装好后确认它真的安装成功、能加载。不要问我任何问题，直接做完，最后用三句话汇报结果。

- 指标来自 `dsh --profile <p> headless --json` 的事件流：`steps` 数 `step_start`，工具调用数
  `tool_call`，token 取每个 step 的 `usage` 累加；墙钟时间围绕进程测量。
  `base-1` 的墙钟是会话事件跨度（当时没记录外层计时）。

## 结果

| 指标 | 无插件（plain / plain2） | 有插件（reso / reso2） | 变化 |
|---|---|---|---|
| 墙钟耗时 | 337 s\* / 215.1 s（均值 276 s） | 116 s / 125.3 s（均值 121 s） | **−56%** |
| step 数 | 37 / 42（39.5） | 19 / 18（18.5） | **−53%** |
| 工具调用 | 43 / 55（49.0） | 21 / 20（20.5） | **−58%** |
| 输入 token | 56,688 / 42,265（49.5k） | 9,487 / 8,940（9.2k） | **−81%** |
| 输出 token | 16,014 / 17,918（17.0k） | 5,713 / 6,295（6.0k） | **−65%** |
| 输入+输出 | 72,702 / 60,183（66.4k） | 15,200 / 15,235（15.2k） | **−77%** |
| 缓存读 | 1.49M / 1.55M（1.52M） | 241k / 252k（247k） | **−84%** |

\* base-1 的 337 s 来自会话事件首尾时间差，未含进程启动。

两次有插件的运行几乎重合（15.2k token、116–125 s），基线两次波动较大（215–337 s）。
方向一致：**有插件稳定快 2–3 倍、token 少 4–5 倍**。

## 工具构成

- 无插件：49 次调用全是 `bash`（`npm view`、读文档、`dsh plugin add`、再起一个 headless 引擎看
  34 个 `dsh_browser_*` 工具、grep 日志），base-1 另用 1 次 `skill`。
- 有插件：每轮 4–5 次 `plugin_*`（1 次 resolve、1 次 install、2–3 次 status）+ 15 次 `bash`
  （外部核验：`--dump-config`、起一次 headless 引擎确认挂载）。
  这两轮没有调 `plugin_search`，因为模型已经知道确切包名，直接 resolve → install。

## 读这组数字时注意

- 每个臂只有 2 次，模型本身有随机性；基线波动比插件臂大。
- 基线“验证能加载”时又起了 1–3 个嵌套 headless 引擎，那些模型调用的 token **没有**计入上表，
  所以基线真实成本比表里更高。
- headless 没有 HMR：两边装完都看不到 loader entry，都得重启一次引擎才能确认，所以有插件侧
  也用了 15 次 bash 做外部核验。在 web profile（有 HMR）里 resolver 能就地校验，次数还会更少。
- 目标插件 `dsh-builtin-browser@0.4.15` 的 latest 本来就与内核兼容，这次没考到“latest 不兼容时的
  降级选择”；同名消歧也没考到。
- 原始事件流在本目录 `runs/` 下：`run-*.jsonl` 与 `summary-*.json`。

## 复现

```sh
dsh --profile plain --from-default-profile headless
# 写入与 ablate-plain 相同的 cordis.patch.yml（credentials/authorization/deepseek-account/
# llm-deepseek-account + agent-default-model），需要时再 add 本插件
DSH_PERMISSION_MODE=danger-full-access dsh --profile plain headless --json "<同一句任务>"
```

---

# 第二轮：优化后（2026-10-27 晚）

改动：`plugin_install` 的模型侧输出 1.8 KB → 271 B；registry 版本文档缓存 10 分钟；新增
`verify: "quick" | "deep"`（deep 会真启动一次 profile 验证每个 entry 激活）；装完不再建议起嵌套引擎。

三臂，同一模型 / 同一目标插件 / 全新 profile，单次运行：

| 臂 | 墙钟 | step | 工具调用 | 输入+输出 token | 缓存读 |
|---|---|---|---|---|---|
| 无插件 | 187.0 s | 21 | 33（bash 32 + read 1） | 29,423 | 432k |
| 插件 + quick | 54.6 s | 15 | 14（resolver 3 + bash 11） | 14,245 | 149k |
| 插件 + deep | **48.4 s** | **2** | **1**（plugin_install verify=deep） | **1,927** | 14k |

- deep 臂的 48.4 s 里有 26.7 s 是它自己启动一次 profile 做校验；即使这样仍是最快的，因为全程只有 1 次工具调用、2 个 model step。
- quick 臂 54.6 s，但模型仍用 11 次 bash 自己核验（dump-config、pnpm 日志），说明“quick 没给我确定性，我就自己查”。
- 与基线相比：quick −71% 耗时、−52% token；deep −74% 耗时、−93% token。

口径提醒：三条提示词不完全一样——基线是原始任务句；quick 明确“用默认 quick，不要 verify=deep”；
deep 明确“用 verify=deep”。所以 deep 的低步数有一部分来自提示词直接点名策略。
单次运行，基线历史波动 187–337 s，结论看方向不看小数点。
