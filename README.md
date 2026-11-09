# dsh-context-kit

DeepSeek Harness 的上下文预算压缩和原文召回套件。一个可安装 bundle 包含两个 Cordis 插件：`dsh-context-kit/budgeted` 与 `dsh-context-kit/recall`。

独立开发和版本管理，使用已发布的 Harness API。目前验证目标为 **DSH 0.2.2-rc.1**，需要 Node 24.9 及以上。插件不修改 agent loop 或模型适配器的序列化逻辑。

**当前真实对照没有达到整体节省目标。** 0.1.1 在两个实例的相同审计任务中，两次复测均答对 13/13 项，但完整任务平均输入增加 7.27%、耗时增加 83.70%；只有暖态新问题的输入减少 60.24%。详见[3080/3082 完整对照](docs/ab-3080-3082.zh.md)。请按实际负载评估，不把局部降幅当作整体或账单收益。

另见[现状与方案分析](docs/analysis.zh.md)、[历史验证](docs/validation.md)和[独立分发](docs/distribution.md)。

## 一条命令从 GitHub 安装

本仓库提供已构建的安装包，安装时由 DSH 加载两个插件。当前公开分发渠道为 GitHub；npm 发布与插件市场收录后续处理。

**兼容要求：DSH 0.2.2-rc.1，Node.js ≥24.9。其他 DSH 版本尚未验证。**

```sh
dsh plugin --profile web add https://raw.githubusercontent.com/Bruce7777/dsh-context-kit/main/release-assets/dsh-context-kit-0.1.1.tgz
```

2026-11-09 已从上述公开 URL 验证安装、启动和卸载恢复，见[发布验收记录](docs/test-results.zh.md#github-发布验收2026-11-09)。需要固定 Git 版本时，可将 URL 中的 `main` 换成 `v0.1.1`。

安装到其他 profile 时，将 `web` 替换为实际名称。使用独立 `DSH_HOME` 的实例需指定同一数据目录；Desktop 通过应用自己的插件管理入口安装该 URL。安装完成后，确认 `context-budget` 和 `context-recall` 已启用、`compaction-basic` 已禁用；未实时生效时重启对应实例。

安装范围由 `DSH_HOME + profile` 决定。原始 Session 记录保留；首次启用及后续压缩可能产生冷缓存开销。详见[安装与配置教程](docs/installation.zh.md)。

若实际 Agent preset 自带独立压缩组，还需关闭该组 Basic 的自动压缩；仅替换顶层行不能保证预设中只有一个自动提供者，配置说明见安装教程。

## 已执行测试与收益

2026-11-09，0.1.1 的 **74 项测试通过**，行覆盖率 **98.28%**、分支覆盖率 **86.82%**。类型检查、构建及已发布 headless profile 的日志录制/重放通过。新增大块搜索、直接定位、多个命中分页与摘要推理强度继承/隔离/清理的负控。

以下保留 **0.1.0 的历史样本**，其估算或单次核查降幅不能替代上面的 0.1.1 完整任务实测：

| 场景 | 无插件输入 | 默认插件输入 | 变化 |
|---|---:|---:|---:|
| 8 步合成会话 | 42,032 | 43,760 | +4.11% |
| 96 步合成会话 | 4,630,382 | 4,649,006 | +0.40% |
| 512 步合成会话 | 130,050,259 | 37,479,646 | **−71.18%** |
| 真实会话首次核查 | 1,371,971 | 773,636 | **−43.61%** |

合成数据使用宿主 token 估算，真实会话使用 provider usage；两者均包含摘要输入。短任务未触发压缩，会增加工具 schema 的固定开销。真实短核查的首次费用和暖缓存复测费用均高于原来的热缓存基线；首次启用存在冷填充，不能将输入降幅当作账单降幅。

真实 read/bash 测试中，默认策略本地耗时差异分别为 +0.11% / −0.85%；96 步纯合成会话对无插件耗时 +6.33%。这些有限样本不能承诺所有任务零回归。详见[中文测试结果](docs/test-results.zh.md)、[完整验证报告](docs/validation.md)和[数值汇总](docs/measurements.json)。

## 预算压缩

压缩后端在模型窗口压力限制之外增加绝对活跃上下文预算，复用宿主现有的摘要事务和工具调用配对检查。可选的提前裁剪会批量缩减符合条件的旧工具结果，保护最近完整步骤、错误结果、富内容和大型元数据；小型结果元数据与预览一同原样保留。

原始事件保留在追加式 Session 中。短预览和摘要包含由代码生成的 `context_read` 引用；不知道遗漏事实的位置时，可使用 `context_search`。

| 配置 | 默认值 | 用途 |
|---|---:|---|
| `pruneToolResults` | false | 显式开启提前裁剪；默认关闭，避免频繁改写已命中的历史前缀。 |
| `maxContextTokens` | 131072 | 活跃上下文软目标，模型自身更小的安全上限仍然有效。 |
| `toolHistoryTokens` | 32768 | 触发批处理的累计工具结果预算。 |
| `toolHistoryTargetRatio` | 0.75 | 工具历史批处理后的目标比例。 |
| `protectedSteps` | 2 | 保护最近的完整步骤。 |
| `minSavingsTokens` | 1024 | 最少需要回收的估算 token 数。 |
| `toolHeadChars` | 1024 | 符合裁剪条件的结果保留的头部 Unicode 码点数。 |
| `toolTailChars` | 512 | 保留的尾部 Unicode 码点数。 |
| `toolMetaMaxChars` | 4096 | 与预览一同保留的完整 JSON 元数据字符上限。 |
| `summaryTargetTokens` | 4096 | 请求的摘要正文长度目标。 |

同时支持 Basic 原有配置。默认保留最近原文 24576 token，摘要生成上限为 16384 token；输出上限涉及 provider 的输出口径，不表示每次摘要都能达到正文目标。截断或失败沿用宿主的失败处理。

## 召回工具

- `context_search` 在当前 Agent 会话的早期事件中进行区分大小写的字面量搜索。省略事件范围即可搜索全部早期文本；命中返回片段、可直接传给 `context_read` 的 `read` 参数、扫描覆盖范围及续页游标。
- `context_read` 读取包含两端的原始事件范围，或用搜索返回的 `part`、`offset` 直接定位一个事件中的原文。位置按可见文本块和 UTF-16 码元计算，必须处于完整 Unicode 字符之间；超长单条记录也可续页。

工具不返回当前步骤、其他会话、推理块、系统/开发者消息及非文本内容。游标绑定当前会话和原请求。搜索可返回同一文本块中多个分离的命中片段；部分扫描没有命中，不代表整个历史不存在该内容。默认每页最多扫描 1,048,576 个 UTF-16 码元与 256 个事件，每个片段最多 2048 码元，完整输出仍限制为 2048 个估算 tokens 和 8192 个 UTF-8 字节。超限保留续页位置，不设置每轮累计召回硬配额。

当前宿主的显式召回会先物化一次完整 Session 快照，再限制扫描和返回内容。扫描上限不等于底层读取或内存上限。召回不在后台调用模型，也不在每个步骤加载历史。已经由其他工具移到 spill 文件而未保留在 Session 内的原文，仍受对应文件可用性限制。

## 缓存与成本

未发生替换的请求沿用宿主的顺序和序列化。首次安装召回工具会改变一次工具列表，可能需要冷缓存填充，之后 schema 保持稳定。可选批处理只有达到完整批次的最低回收量才替换历史；摘要调用先复用宿主会话前缀再追加指导。发生真实替换时，从首个变化的历史 token 起需要重新填充缓存；provider 的缓存保留、过期和路由不由本插件控制。

评估需要计入摘要、召回和冷缓存恢复的全部成本。上下文变短不直接等于账单下降。已执行的验证及限制见 [验证报告](docs/validation.md)。

## 开发验证

```sh
pnpm run typecheck
pnpm test
pnpm run test:coverage
pnpm run test:e2e
pnpm run build
```

真实模型用例在没有 `DEEPSEEK_API_KEY` 时跳过。它们通过独立预期值检查原始事实、用户约束和错误证据，并记录每次调用的未缓存输入、缓存读取/写入及输出。性能诊断使用固定合成数据，私人会话不会成为测试夹具。

## 源码构建与分发

本仓库采用 MIT 许可证，源码、测试和 GitHub 安装包独立维护。[English](README.en.md) · [安装教程](docs/installation.zh.md) · [分发维护](docs/distribution.md)。开发者可从源码构建：

```sh
git clone https://github.com/Bruce7777/dsh-context-kit.git
cd dsh-context-kit
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:coverage
pnpm pack --pack-destination .artifacts/package
```

`pnpm pack` 会先构建 ESM 和类型声明。公开安装包位于 `release-assets/`，不包含私人会话、凭据或本机控制脚本。源码版本与已发布归档的维护流程见分发文档。

## 限制

语义摘要会丢失信息；召回让保留的原文可达，但不能保证模型总能发现遗漏。近期受保护内容或不可拆分内容占主导时，活跃预算是软目标。切换模型时，宿主先用自己的窗口安全限制处理首次请求；插件的绝对预算在后续普通压力检查时生效。首版支持已验证的 Harness 版本，其他版本需要兼容性验证。节省比例和模型耗时取决于任务、模型及缓存状态。
