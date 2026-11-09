# 长篇小说用量审计

真实测试使用两个隔离的 DeepSeek Harness 实例，以同一份《潮骨》创作简报和相同逐轮消息独立策划、写作、审读与修改。候选使用套件 0.1.1，对照使用原生 Basic；不是向模型导入一次超长文本。文学质量按原文匿名评读，姓名复现率不作为质量指标。测试结果和限制见[长篇报告](../../docs/novel-long-ab.zh.md)。

## 离线核对已公布费用

需要 Node.js ≥24.9；不需要安装依赖、API key 或连接 Harness。

```sh
git clone https://github.com/Bruce7777/dsh-context-kit.git
cd dsh-context-kit
node benchmarks/novel/verify-report.mjs --report benchmarks/novel/results/20261109-through052/accounting-report.json
node --test benchmarks/novel/usage-accounting.test.mjs benchmarks/novel/verify-report.test.mjs
```

`verified: true` 表示公布的数值、摘要生命周期、调用范围及逐次价格与公布的计费字段投影一致，不是向提供商核验账户实扣。投影不包含小说、推理、提示词、工具参数、文件路径、会话 ID 或凭据；它**仅用于费用审计，不是可重放的 Session 日志**。每个原事件的 seq、type、time 保留，压缩 ID 按各侧出现次序匿名化，其他内容按白名单省略。无法凭投影还原原始内容，也无法独立证明提供商账单。

第52轮是双方首次传输错误之前的完整核算截止点。第53轮两边出现没有返回 usage 的传输失败/重试，不能将其后“已知 usage 合计”称为完整费用，也不能将未知部分按零计费。核验器拒绝含 `assistant/attempt` 的投影和未完成的 turn；不为延长测试放宽这个限制。

## 计算口径

`usage-accounting.mjs` 从连续的原始 seq 前缀或对应计费字段投影中分别收集 `assistant/message` 与 `compaction/summary`。输入的 `inputTokens` 是未缓存部分，`cacheReadTokens` 单独计价；`outputTokens` 已包含提供商计入的推理，不再叠加 `reasoningTokens`。摘要后的首次主请求也在账内，缓存重建不能扣除。

费用采用十进制字符串与 BigInt 进行精确运算，不逐次四舍五入。每次调用必须有明确价格时段。缺失 usage、缓存计数、摘要或生命周期配对、非零且没有价格的缓存写入、错误的 provider 总数、序号缺口及未完成轮次均拒绝计算。原生 Basic 的多个摘要也按同一事件协议计入，不依赖本插件的专用政策事件。

`verify-report.mjs` 另核对价格记录、模型路由、调用逐项费用、主生成/摘要、峰/谷时段及全部合计，并验证投影 hash。官方跨时段结算规则未明确的调用保留开始/结束时段上下界；这一不确定性与缺失 usage 分开处理。

## 导出自己的私有测试

`export-accounting.mjs` 面向本测试的归档格式，不是通用 Harness 导出命令。它读取私有目录的 `progress.json`、两份原始 `events-PORT.jsonl` 与 `cost-through-NNN.json`，先按白名单重建字段，再由独立核验器复算；全部通过才写出公开投影。不要直接上传原始目录。

```sh
node benchmarks/novel/export-accounting.mjs --run-dir PRIVATE_RUN_DIRECTORY --through 52 --out PUBLIC_REVIEW_DIRECTORY
node benchmarks/novel/verify-report.mjs --report PUBLIC_REVIEW_DIRECTORY/accounting-report.json
```

`progress.turns` 需要每侧从1至截止轮的唯一连续记录及 `throughSeq`；原始 JSONL 必须从 seq 0 连续。费用文件为每条主生成/摘要列出原 seq、type、round、实际 usage、明确的 peak/off-peak、开始/结束时间及分项费用。导出器针对本次的 `deepseek-official/deepseek-flash` 和已记录官方价格，其他模型或价格不能直接套用。导出后仍需检查公开文件；成功核算不是公开私人内容的授权。

已公布代码和数据可用于复算计费和测试漏计保护；没有公布的作者工作区及私人写作指导不属于可公开重放夹具。重新生成小说会因模型、缓存状态、时段和工具选择不同而改变结果。
