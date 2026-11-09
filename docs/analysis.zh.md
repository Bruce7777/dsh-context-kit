# Harness 上下文成本分析

本次分析基于上游 `fcc0ad4621` 与已发布的 DSH `0.2.2-rc.1`。实现放在独立仓库和 npm 包中，未修改 Harness 主仓的生产代码。

## 现有机制

`compaction-basic` 在步骤之间检查压力，在切换模型前检查目标窗口，并在 provider 确认超窗时尝试恢复。默认阈值为模型窗口的 80%，还要扣除实际输出预留和 65536 tokens 的 headroom。默认保留最近原文的比例为可用消息预算的 16%；摘要生成上限默认继承 headroom。百万上下文模型因此可能长期携带几十万 tokens，在每个工具步骤重复发送。

摘要通过追加式 Session 事务提交，替换当前 surface 的一段历史，原事件仍在日志内。摘要调用重用会话的 system、tools 和选中历史前缀，再追加摘要指令。已有工具结果 pruner 面向窗口压力和超窗恢复；单纯把阈值调低，无法解决模型找不到被省略事实的问题。

来源：[Basic 配置](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad4621/packages/compaction/compaction-basic/src/config.ts)、[自动触发与恢复](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad4621/packages/compaction/compaction-basic/src/index.ts)、[摘要请求](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad4621/packages/compaction/compaction-basic/src/summarizer.ts)。

## 两个插件各自解决的问题

`budgeted` 增加与模型最大窗口分离的活跃上下文预算，默认 131072 tokens，默认保留最近 24576 tokens 原文，给摘要正文 4096 tokens 的长度指导。沿用宿主的日志事务、工具配对与超窗恢复，增加取消后的提交保护。部署者可以调节这些值；受保护内容或不可拆分内容占主导时，预算仍是软目标。

可选的工具输出裁剪只处理符合条件的成功文本结果。它保护最近步骤、错误、富内容和大 metadata，小 metadata 原样保留。每次必须积累足够回收量才批量替换。这个功能默认关闭：在缓存很便宜且已有高命中的会话里，积极改写中部历史可能使费用上升。

`recall` 提供受预算限制的 `context_search` 与 `context_read`，按当前 Session 的原始事件检索和无损续页。预览和摘要的原文引用由代码生成，避免模型编造位置。工具不暴露其他会话、当前步骤、推理块或系统消息。召回可恢复保留在日志内的精确信息；是否主动调用仍取决于模型，不能把它当成无损语义压缩的保证。

## 缓存为什么必须单独测

缓存命中依赖相同的前缀。首次安装工具会改变工具目录，摘要或裁剪也会改变后续历史前缀；发生变化的部分无法承诺继续命中。插件没有为每个请求动态重排 schema 或修改 system 头部，摘要指导追加在原历史之后，实际模型输入变化也写入 Session。

DeepSeek 当前缓存还依赖前缀单元的持久化和完整匹配，不能把字符串公共前缀直接当作真实命中 tokens。性能脚本的 prefix 字符统计仅作诊断；真实命中采用 provider 返回的 usage。当前 Flash 的命中单价是未命中的 2%，因此少发 tokens 不一定省钱。[缓存规则](https://api-docs.deepseek.com/guides/kv_cache/)、[官方定价](https://api-docs.deepseek.com/quick_start/pricing/)。

应分别记录首次安装和压缩的冷启动、压缩后持续工作、摘要及召回的额外请求、缓存命中和未命中输入、输出及耗时。短任务可能只有新增工具的固定开销。完整数据与已知限制见[验证报告](validation.md)，独立发布和市场使用方式见[分发说明](distribution.md)。
