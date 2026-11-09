# 从 GitHub 安装与配置

本套件由一个包提供 `budgeted`（预算压缩）和 `recall`（原文召回）两个插件。当前安装入口是 GitHub 托管的预构建 `.tgz`，npm 与市场收录后续处理。

## 1. 检查兼容版本

```sh
node --version
dsh --version
```

本版要求 Node.js ≥24.9，声明兼容并已验证的 DSH 版本为 **0.2.2-rc.1**。其他版本需要兼容性验证；不要为了绕过检查强行允许未知版本。

## 2. 安装到实际使用的 profile

Web 默认 profile：

```sh
dsh plugin --profile web add https://raw.githubusercontent.com/Bruce7777/dsh-context-kit/main/release-assets/dsh-context-kit-0.1.0.tgz
```

Headless：

```sh
dsh plugin --profile headless add https://raw.githubusercontent.com/Bruce7777/dsh-context-kit/main/release-assets/dsh-context-kit-0.1.0.tgz
```

独立数据目录的实例，使用该实例已有的 `DSH_HOME`。以下路径为占位示例：

```sh
DSH_HOME=/path/to/dsh-home dsh plugin --profile web add https://raw.githubusercontent.com/Bruce7777/dsh-context-kit/main/release-assets/dsh-context-kit-0.1.0.tgz
```

安装位置由 `DSH_HOME + profile` 决定，端口不决定安装位置。Desktop 使用应用自己的插件管理入口，安装源填写上面的 GitHub `.tgz` URL；给 `web` 安装不会自动给 Desktop 安装。

本教程支持的是预构建归档 URL。`github:Bruce7777/dsh-context-kit` 属于源码 Git 安装，可能触发包管理器的构建审批，不作为本版的一条命令安装入口。

## 3. 网络受限时下载后安装

打开仓库的 [release-assets](../release-assets/) 目录，下载 `dsh-context-kit-0.1.0.tgz` 及对应 `.sha256` 文件。macOS/Linux 可在下载目录校验后安装：

```sh
cd ~/Downloads
shasum -a 256 -c dsh-context-kit-0.1.0.tgz.sha256
dsh plugin --profile web add ./dsh-context-kit-0.1.0.tgz
```

Windows 可用 `Get-FileHash` 核对 SHA-256，再把本地绝对路径传给同一个 `dsh plugin` 命令。校验文件用于比对发布文件是否完整，不代替对仓库来源的信任判断。

## 4. 确认生效

在没有正在运行的任务时安装和重启更容易核对结果。安装后检查插件页：

| 插件行 | 预期状态 |
|---|---|
| `context-budget` / `dsh-context-kit/budgeted` | 启用 |
| `context-recall` / `dsh-context-kit/recall` | 启用 |
| `compaction-basic` | 禁用 |

支持的 HMR 会实时应用组合；未生效时重启对应 DSH 实例。命令行也可查看合成配置：

```sh
dsh --profile web --dump-config
```

不要将包含个人配置的完整输出发到公开 issue。CLI 安装可能提示部分 DSH peer 未在 profile 内单独安装；标准 profile 由安装目录提供这些宿主包。以版本检查、实际加载状态和错误信息为准；缺失服务或不兼容版本应先解决。

## 5. 使用默认配置或调整预算

默认启用摘要预算，**主动裁剪旧工具输出保持关闭**。摘要调用复用当前已配置模型；召回工具直接查询当前 Session，不额外调用模型。

默认数据目录下，在 `~/.dsh/profiles/web/cordis.patch.yml` 合并以下条目；自定义 `DSH_HOME` 使用其对应文件，已有相同 `id` 时修改原条目：

```yaml
- id: context-budget
  config:
    maxContextTokens: 131072
    retainTokens: 24576
    protectedSteps: 2
    summaryTargetTokens: 4096
    maxTokens: 16384
    pruneToolResults: false

- id: context-recall
  config:
    maxOutputTokens: 2048
    maxOutputBytes: 8192
    maxScanEvents: 256
    maxScanCharacters: 65536
```

这里的 `maxTokens` 控制摘要生成上限，`summaryTargetTokens` 是摘要正文长度指导。原文仍保留在 Session 日志，活跃预算是软目标；大块近期受保护内容可能使其超出。

首次安装改变工具目录，摘要和裁剪也会改变历史前缀，均可能造成冷缓存填充。短任务未触发压缩时，新增工具 schema 反而增加输入。请比较摘要、召回、未命中输入、缓存输入和输出的完整成本，见[测试结果](test-results.zh.md)。

## 6. 停止预算压缩但保留原文召回

保持包安装，合并：

```yaml
- id: context-budget
  disabled: true

- id: compaction-basic
  disabled: false
```

`context-recall` 继续启用，旧摘要中的原文引用仍可调用。

## 7. 完整卸载

```sh
dsh plugin --profile web remove dsh-context-kit
```

移除该 bundle 后，下层 Basic 配置恢复，除非另有用户或插件覆盖。原始日志保留，已经写入的摘要也保留；卸载不会自动恢复为完整活跃历史。旧摘要里的 `context_read` 引用需要保留或重新启用召回插件才能使用。

## 开发者复验安装

在源码仓库安装开发依赖后，可以用独立临时 `DSH_HOME` 检查归档的安装、启动与卸载，不访问正在使用的 profile：

```sh
pnpm install --frozen-lockfile
pnpm run verify:install ./release-assets/dsh-context-kit-0.1.0.tgz
pnpm run verify:install https://raw.githubusercontent.com/Bruce7777/dsh-context-kit/main/release-assets/dsh-context-kit-0.1.0.tgz
```

公开发布验收记录见[测试结果](test-results.zh.md)。
