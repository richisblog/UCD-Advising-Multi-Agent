---
description: "Pathfinder UCD Advising Lab — single-agent vs institution-scoped multi-agent academic advising for DeepSeek Harness, with official UC Davis evidence, simulated students, blind grading and paired analysis."
kind: "plugin-bundle"
---

# Pathfinder UCD · Advising Lab（dsh-plugin-pathfinder-lab）

[English summary below](#english-summary)

## Summary

DeepSeek Harness 插件（Host + Web Client 双半，Cordis 生命周期）。用 UC Davis **计算机（ECS）、心理学（PSC）、语言学（LIN）、数学（MAT）** 的官方政策证据，比较两种咨询架构：

- **A · 单 Agent**：一个 ReAct 式 Advisor，全库检索。
- **B · 多 Agent**：Personal Agent + 7 个按学校职责划分的专家（University、L&S、CoE、ECS、PSC、LIN、MAT），专家只能检索自己层级的文档，交接经串行控制器并记录。

两组共享同一模型、证据、报告格式和一个严格对齐的预算账本。实验设计、评分与统计方法见 [experiment/DESIGN.md](experiment/DESIGN.md)。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

需要 Node.js 24+ 与已登录 DeepSeek 的 DeepSeek Harness 0.2.2-rc.1。

```sh
npm ci
npm run build
npm test
```

**临时加载（不改任何 profile）**：`npm run overlay` 生成本机专用的 `cordis.local.yml`（指向本目录、使用 DeepSeek 账号与 deepseek-flash，不提交到 git），然后：

```sh
npm run overlay
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile web --patch "$PWD/cordis.local.yml"
```

**装进桌面版**：在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 加入 `dsh-plugin-pathfinder-lab`，并在 `dependencies` 加 `"dsh-plugin-pathfinder-lab": "link:<本目录绝对路径>"`，然后在该目录执行 `pnpm install`（可用 Harness 自带的 pnpm：`node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install --offline`），重启 Harness。之后改代码只需 `npm run build` 再重启。包的 `dsh.bundle.patch` 指向 [cordis.patch.yml](cordis.patch.yml)，显示名与图标来自 `locale/*.json` 和 `icon.svg`。

打开右侧栏「开始」→ **咨询实验室**（或会话顶部的 **咨询实验室** 按钮）：

| 标签 | 用途 |
|---|---|
| 咨询 | 输入问题，选 A、B 或 A+B 并排；Agent 追问时直接在卡片里回答；查看流程图、总结、可点开的证据原文、执行轨迹与预算条 |
| 实验 | 选案例（dev 4 / 留出 20）、重复次数、种子、学生模式（脚本模拟 / 研究员手动）、预算；运行并逐条查看；手动模式显示隐藏档案供勾选 |
| 结果 | 评分未评运行；配对指标表（B−A、95% CI、p、dz）、按类别/案例的条形图；导出盲评包与完整轨迹；导入人工评分并计算 κ |
| 案例与数据 | 浏览语料统计、每个案例的隐藏档案、清单和参考要点 |

每次运行的 **查询过程** 页把 AI 找答案的全过程画出来，所有视图共用一个回放进度：

- **指标条**：信息清单完成度（圆环）、已查阅文件数、学生回答数、tokens / 调用占预算比例、用时。
- **大字说明**：当前这一步用一句话讲清楚“谁做了什么”，附上它此前的思路。
- **交互图**：学生、个人顾问 / 单 Agent 顾问、7 个专家、按 校级 / 学院 / 系 分列的证据区（显示文件标题）。蓝=追问学生，橙=委派，紫=专家交接，绿=回传结论，黄=检索；新查到的文件会弹出、命中的会高亮。
- **信息清单**：Agent 列出的“必须弄清的问题”，实时显示 待查 / 部分 / 已解答 / 需顾问，附证据标题或学生原话；控制器驳回的标记也会显示。
- **时间线**：每个参与者一行、每一步一个标记，下方绿色带是清单完成度随时间的变化；点击任意标记跳转。
- **逐步过程**：每一步一张卡片，用自然语言叙述，文件用标题而非 id，可展开原文摘录并打开官网。

播放、单步、拖动、0.5×–4× 速度、实时跟随；**⛶ 演示** 全屏。**建议总结** 页把回复、可选路径、所依据的规则（带核验结果）、仍需确认的事项和带去问顾问的问题分区展示；A+B 并排咨询时顶部有一览对比。

界面支持 **中文 / English**：右上角选择「跟随 Harness」「English」「中文」，偏好保存在本机浏览器。Agent 的回答语言跟随学生提问的语言；案例里的隐藏档案与评分清单是实验材料，保持原文。

实验中断或遇到网络错误时，模型调用会自动重试；连续网络失败会暂停实验，在「结果」页点 **续跑失败或缺失的运行** 按原种子补齐。

数据保存在 `$DSH_HOME/pathfinder-lab/experiments/<id>/`（默认 `~/.dsh/...`）：`meta.json`、`runs/*.json`、`human.json`。

### 无界面批量运行（同一套核心代码）

CLI 直接调用 DeepSeek API，需要你自己的 `DEEPSEEK_API_KEY`（可写在本目录 `.env`，已被 git 忽略）：

```sh
npm run experiment -- --split dev --repeats 1 --grade --name dev
npm run experiment -- --split heldout --repeats 2 --seed 2026 --grade --name main
npm run analyze -- --id <experimentId> --blind
npm run analyze -- --id <experimentId> --human scores-rater1.json
```

结果写到 `results/experiments/<id>/`，`report.md` 是配对分析报告，`blind-review.json` 是盲评包。

### 开发集结果

4 个开发案例 × 2 次 × 2 组（2026-11-18，deepseek-flash）：清单满足率 A 69.6% / B 82.1%（B−A +12.4，95% CI −3.8 ~ 24.1，p = 0.25，n = 4，不显著），B 约 1.6 倍 tokens、2.7 倍耗时。完整报告见 [experiment/results/dev-2026-11-18.md](experiment/results/dev-2026-11-18.md)。正式留出集评测尚未运行。

### 更新语料

```sh
npm run scrape     # 重新抓取 corpus/sources.json 中的官方页面并重建 corpus.json
npm run corpus     # 只重建（例如换了 SQLite 数据）
```

`build_corpus.py --db-dir DIR` 可指定 SQLite 目录（默认 `~/Documents/RMP咨询APP/RMPdemo/data/sqlite`）。更新语料会改变 `corpus.version`，正式评测期间不要改。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Source map — click to expand</summary>

| 文件 | 作用 |
|---|---|
| [src/host.ts](src/host.ts) | Cordis Host 插件：把 `ctx.llm` 适配成中立的 `Model`，在 `/api/pathfinder-lab/*` 注册 RPC |
| [src/client.tsx](src/client.tsx) | 面板外壳与四个页面（咨询、实验、结果、案例），右侧栏与会话头部入口 |
| [src/ui/](src/ui) | `Process`（查询过程总视图）、`Flow`（交互图）、`Checklist`、`Timeline`、`Story`、`Run`（运行卡片/总结/评分）、`replay`（统一回放状态）、`i18n` |
| [src/core/checklist.ts](src/core/checklist.ts) | 信息清单：创建、带凭据校验的状态更新、多余动作计数、状态板 |
| [src/contract.ts](src/contract.ts) / [src/schemas.ts](src/schemas.ts) | RPC 路由与类型 / Host 端 zod 校验 |
| [src/core/single.ts](src/core/single.ts) | 条件 A |
| [src/core/multi.ts](src/core/multi.ts) | 条件 B：Personal、委派、专家循环、交接、共享记录 |
| [src/core/runtime.ts](src/core/runtime.ts) | 共享工具（检索/课程/追问）、轨迹事件、报告归一化 |
| [src/core/llm.ts](src/core/llm.ts) | 单一预算账本 `Ledger`、JSON 解析与一次修复 |
| [src/core/retrieval.ts](src/core/retrieval.ts) | BM25 + 职责范围过滤、课程号规范化、中文检索词表 |
| [src/core/prompts.ts](src/core/prompts.ts) | 所有提示词与角色职责（`PROMPT_VERSION`） |
| [src/core/student.ts](src/core/student.ts) | 脚本化模拟学生 |
| [src/core/grader.ts](src/core/grader.ts) | 自动项 + 盲评 Judge + 引用有效性 + 空洞谨慎规则 |
| [src/core/analysis.ts](src/core/analysis.ts) | 配对分析、bootstrap、置换检验、κ |
| [src/core/lab.ts](src/core/lab.ts) | 咨询/实验编排、等待学生回答、导出与导入 |
| [cli/](cli) | 无界面运行、评分、分析 |
| [scripts/](scripts) | 抓取官网与构建语料 |

</details>

<a id="model-experience"></a>
## Model Experience

本插件不向 Harness 的编码 Agent 注入工具或系统提示；它自己的模型调用只发生在实验室面板内。每次调用的系统提示与消息完整记录在运行文件的 `trace`/`calls` 中。

#### KV Cache effect

两组的系统提示在一次运行内保持不变、消息只追加，便于提供商前缀缓存；B 组的专家每次委派是新上下文，缓存复用较少——这本身也体现在 token 指标里。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- 只用于准备顾问面谈，不做官方资格认定、不做完整学位审核或实时选课。
- 语料是 2026-11-18 快照；课程记录来自 2025-08 本地库；数学系宣布门槛只有旧记录。
- Judge 默认与被测模型同源，需人工盲评校验。
- 一次只跑一个实验；咨询可同时跑 A、B 两条。

<a id="english-summary"></a>
### English summary

A DeepSeek Harness plugin (Host + Web client) comparing **(A)** one ReAct advisor with **(B)** a Personal Agent plus seven institution-scoped specialists (University, L&S, Engineering, CS, Psychology, Linguistics, Math) on 24 fictional UC Davis advising cases, using 42 official pages scraped on 2026-11-18 plus local catalog data. Both conditions share one model, one evidence set, one report schema and one budget ledger. Scoring combines auto-scored checklist items (fact elicitation, valid citations), a blind LLM judge, an empty-caution rule and human blind review with κ; analysis is paired by scenario (B − A, bootstrap CI, sign-flip permutation test). See `experiment/DESIGN.md`.
