# 真实实例对照任务

此任务用于比较安装套件与原生压缩器的实际模型用量及答案。资料均为合成数据，不依赖私人会话。生成器固定 seed，生成 14 份 JSONL、9 条用户输入及位于模型工作区外的独立答案。先读取约 698 KB 的审计记录，再核验早期精确标识、已批准更正、账目计算与只读要求。

## 生成与验证

```sh
python3 benchmarks/audit/generate.py /tmp/context-audit-design
python3 benchmarks/audit/verify-design.py /tmp/context-audit-design
```

第二条命令从原始记录独立重算答案，执行两个正向与五个负向评分控制。把 `/tmp/context-audit-design/model-workspace/` 单独复制到新的公共工作目录，两个实例都使用这个目录；不要把整个 design 目录交给模型。`private/oracle.json`、提示和评分脚本应留在模型工作区之外。

## 执行相同任务

1. 两边新建会话，统一 DSH 版本、模型接口、推理强度、输出上限、工作目录和工具配置。专用 preset 使用相同 persona 与文件工具，不包含自己的压缩器。候选侧只启用一个 Budgeted 自动压缩器及 recall，基线只启用一个 Basic。两边保持相同的 pruner 设置，记录其它可见工具的差异。
2. 按 `turns.json` 的数组顺序发送原样消息，等待每一轮以 completed 结束，再发送下一轮。7 轮读取各要求 2 次完整文件读取；随后是冷态和暖态两组新问题。任何 402、错误结束、等待人工输入或缺失读结果都应使该对照无效，不能以空答案和零用量当作节省。
3. 导出两个会话的本轮事件。保存未经修复的最终答案，检查全部 14 份文件实际完整读到尾标，核验没有重读或写操作。先冻结完整结果，再调整配置或实现；保留失败或较慢的样本。
4. 分别评分两边的 cold、warm 答案。例如：

```sh
python3 benchmarks/audit/score.py --design /tmp/context-audit-design \
  --stage cold --response /tmp/candidate-cold.txt --workspace /tmp/context-audit-workspace
python3 benchmarks/audit/score.py --design /tmp/context-audit-design \
  --stage warm --response /tmp/candidate-warm.txt --workspace /tmp/context-audit-workspace
```

评分要求 7 + 6 个字段的值和类型均匹配，拒绝额外字段，并检查原始文件 hash 和未授权新建文件。最终 hash 不足以证明从未尝试写入，因此还要审计工具调用。

## 用量与时间口径

`assistant/message.data.usage` 是主模型用量；`compaction/summary.data.usage` 是辅助摘要用量，两者必须相加。当前已验证 provider 的 `inputTokens` 为未命中输入，`cacheReadTokens` 为缓存读取；总输入是两者之和。输出包括该 provider 计入 usage 的推理输出。缺失的 usage 不能记作零。完整结果应报告总输入、未命中输入、缓存读取、输出、摘要/主调用数、召回调用和错误数。

分别记录资料摄入、首次答题和暖态新问题的耗时。各轮耗时之和应包含摘要与召回，不包含等待另一实验组的空闲时间。服务端缓存不能视为已清空；“冷态”指首次答题，不保证 provider 无缓存。重复试验应公开运行顺序及全部样本。

本任务验证一个特定负载，不构成所有任务准确率相同、费用更低或延迟不增加的保证。宿主 TokenMeter 估算、缓存前缀结构检查和 provider 实际 usage 应分开报告。
