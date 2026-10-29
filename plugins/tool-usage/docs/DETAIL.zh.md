# 工具调用统计

`dsh-plugin-tool-usage` 为智能体的每一次工具调用留下可读的记录：调用了什么、参数是什么（脱敏后）、花了多久、成功还是失败、属于哪个会话；同时按工具汇总调用次数与耗时。所有数据只写在本机。

## 功能

- **记录**：包装 `tools/execute`，记录工具名、脱敏并截断后的参数、开始时间、耗时、结果状态（`ok` / `error` / `aborted` / `threw`）、所属会话与调用 id；每次调用一条 JSONL。
- **解释**：为每次调用生成确定性的中英文摘要，例如“执行 Shell 命令：pnpm test”“读取文件 /tmp/a.ts（第 1 行起，最多 200 行）”；不给模型看参数也能知道这行记录在做什么。
- **统计**：按工具、按会话统计调用次数、失败数、总耗时、平均/最小/最大/最近耗时、慢调用数；内存中聚合，查询不扫描日志。
- **两个入口**：模型可调用的只读工具 `tool_usage`（`summary` / `tools` / `recent` / `explain` 四种视图），以及人类使用的 `/tool-usage` 斜杠命令。
- **持久化**：调用记录按天写入 `calls-YYYY-MM-DD.jsonl`，聚合快照写入 `stats.json` 并在重启后恢复。

插件只测量和记录，不改变工具结果、`exec.signal` 或调用身份；某一类记录操作失败只写一次警告，不影响正在执行的工具。

## 快速开始

本包尚未发布到 npm，请从仓库的本地 checkout 安装。

```sh
git clone https://github.com/youtaya/dsh-plugins.git
cd dsh-plugins

# 安装到 profile（首次使用会自动创建）
dsh plugin --profile <profile> add "$PWD/plugins/tool-usage"

# 确认层已生效：应出现 "# == dsh-plugin-tool-usage" 和 id 为 tool-usage 的行
dsh --profile <profile> --dump-config

# 启动
dsh --profile <profile>
```

已经有一份 checkout 时，直接传该包的绝对路径即可：`dsh plugin --profile <profile> add <指向该仓库的绝对路径>/plugins/tool-usage`。重启该 profile 后生效。包内已提交 `lib/` 构建产物，安装不需要执行构建脚本或授予额外权限。

移除：

```sh
dsh plugin --profile <profile> remove dsh-plugin-tool-usage
```

移除不会删除已经写出的记录与统计，需要时自行清理数据目录（默认 `~/.dsh/tool-usage/`）。

## 兼容性

- DSH `>=0.2.0-0 <0.3.0`（声明于 `engines.dsh`）；已对 DSH `0.2.2-alpha.2` 验证。
- 构建、测试本仓库需要 Node.js `>=24.9`（`.nvmrc` 固定 `24.19.0`，也是验证所用版本）；安装后的插件运行在 DSH 宿主进程内。
- DSH profile 提供的 peer 包：`@deepseek-ai/cordis >=4.0.0-0 <5.0.0`、`@deepseek-ai/dsh-tools >=0.2.0-0 <0.3.0`、`@deepseek-ai/dsh-commands >=0.2.0-0 <0.3.0`。
- 运行时导入仅限 `node:*` 内置模块与 `@deepseek-ai/dsh-tools`；不安装、也不打包第三方运行时依赖。
- Web / Desktop profile 会注册斜杠命令；headless profile 仍会记录调用并提供 `tool_usage` 工具。

## 记录什么

每次工具调用写一行 JSON：

```json
{"v":1,"seq":42,"at":"2026-10-28T08:31:05.412Z","tool":"bash","callId":"call_7f3a91","sessionId":"ses_01J8ZK","durationMs":1402.7,"status":"ok","params":{"command":"pnpm test"},"paramsTruncated":false,"redacted":false,"explanation":{"summary":"执行 Shell 命令：pnpm test"}}
```

`status` 取值：`ok`（成功）、`error`（工具返回错误）、`aborted`（结果码为 `ABORTED` 或 `ABORTED_BEFORE_DISPATCH`）、`threw`（执行协议层抛出，原异常继续抛出）。统计中的 `errors` 只计 `error` 与 `threw`，`aborted` 不算失败，各状态数量保存在聚合的 `statusCounts` 中。

参数在写入前脱敏：敏感键（如 token、password、apiKey、authorization、cookie）的值变成 `[REDACTED]`；超长字符串截断；整体参数超过 `maxParamChars` 时替换为不超过该上限的预览（最少 18 字符）。任一字符串、数组、深度或整体参数上限的截断都会置 `paramsTruncated: true`；命中脱敏时置 `redacted: true`。失败时的 `error.message`/`error.code` 取自工具结果，受 `maxStringChars` 截断，且不按键名脱敏。

解释文本同样有上限：单行 `summary` 最多 2,000 字符，`details` 最多 50 行 / 8,000 字符；已注册工具与参数的说明也按普通值截断。

## 查看统计

### 模型工具 `tool_usage`

| 参数 | 类型 | 取值 | 说明 |
| --- | --- | --- | --- |
| `view` | string | `summary` / `tools` / `recent` / `explain` | 返回内容，默认 `summary` |
| `tool` | string | 工具名 | `view: "explain"` 时必填；其他视图下按工具名精确过滤按工具表格与最近调用 |
| `scope` | string | `session` / `all` | 统计范围，默认 `session` |
| `limit` | integer | `1`–`100` | 最近调用的最大返回条数，默认 `20` |

示例：

```json
{ "view": "summary" }
{ "view": "recent", "limit": 5 }
{ "view": "explain", "tool": "bash" }
```

工具的输出值是规范 JSON 快照，渲染给模型的是紧凑 Markdown：

```markdown
工具调用统计（范围：当前会话）

总计 12 次调用 / 1 次失败 / 总耗时 3.2s / 平均 267ms / 最慢 1.4s

| 工具 | 次数 | 失败 | 平均 | 最慢 | 最近 |
| --- | --- | --- | --- | --- | --- |
| bash | 8 | 0 | 210ms | 1.4s | 12:31:05 |
| read | 3 | 1 | 400ms | 620ms | 12:30:58 |

最近调用：
1. [12:31:05] bash — 执行 Shell 命令：pnpm test（1.4s）
2. [12:30:58] read — 读取文件 /tmp/a.ts（第 1 行起，最多 200 行）（620ms，失败）
```

`explain` 视图返回目标工具的注册描述和参数表，便于模型理解其他工具；工具缺失或未注册时返回工具错误结果。

### 斜杠命令 `/tool-usage`

| 命令 | 行为 |
| --- | --- |
| `/tool-usage` | 当前会话摘要 |
| `/tool-usage all` | 全部会话摘要 |
| `/tool-usage recent [N]` | 当前会话最近 N 条调用（如 `/tool-usage recent 5`），默认 10 |
| `/tool-usage reset` | 清空全部会话的统计并按清空后的状态重写 `stats.json`，重启后不会恢复重置前的计数（已写出的 JSONL 不受影响） |

命令只在提供 `commands` 服务的 profile（Web / Desktop）中注册；headless profile 中只有工具和记录。

## 配置

在 profile 的 `cordis.patch.yml` 中按 id `tool-usage` 覆盖（补丁整段替换 `config`，插件为缺失键套默认值，因此只写要改的键）：

```yaml
- id: tool-usage
  config:
    language: en
    explain: brief
    slowThresholdMs: 10000
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时什么都不记录 |
| `outputDir` | `"$DSH_HOME/tool-usage"` | 数据目录；支持 `~` / `$DSH_HOME`，相对路径按工作目录解析；`""` 表示不落盘 |
| `persistCalls` | `true` | 写 JSONL 调用日志 |
| `persistStats` | `true` | 写 `stats.json` 聚合快照 |
| `restoreStats` | `true` | 启动时恢复聚合（需 `persistStats`） |
| `explain` | `"detailed"` | `off` / `brief` / `detailed` |
| `language` | `"zh"` | `zh` / `en` |
| `maxParamChars` | `500` | 整个参数 JSON 的字符上限；截断预览不超过该上限（截断外壳最少 18 字符） |
| `maxStringChars` | `200` | 单个字符串值以及失败 `error.message` 文本的字符上限 |
| `redactKeys` | 内置敏感键 + 追加 | 敏感键列表；匹配时去掉 `-`/`_`/`.`/空白；只能追加 |
| `recentLimit` | `200` | 最近调用环形缓冲容量 |
| `slowThresholdMs` | `5000` | 慢调用阈值（毫秒） |
| `toolName` | `"tool_usage"` | 模型工具名 |
| `commandName` | `"tool-usage"` | 斜杠命令名 |
| `statsWriteDebounceMs` | `2000` | `stats.json` 写盘防抖 |
| `includeParamsInReport` | `true` | 快照输出中的 `recent[]` 是否附带脱敏参数（Markdown 报告本身不展示参数） |

## 数据与隐私

- 位置：`$DSH_HOME/tool-usage/calls-YYYY-MM-DD.jsonl`（按本地日期分文件）与 `$DSH_HOME/tool-usage/stats.json`；`$DSH_HOME` 默认 `~/.dsh`。
- 权限：目录 `0o700`，文件 `0o600`；已存在但权限更宽的当日日志文件会在本进程首次追加时被重新收紧为 `0o600`。`stats.json` 以进程内唯一临时文件（`stats.json.<pid>.<random>.tmp`）+ `rename` 原子替换；它采用最后写入者生效语义，因此假定每个 `$DSH_HOME` 只有一个 DSH 进程（JSONL 追加在并发写入下仍然安全）。
- 只写 `outputDir`，不联网，数据不离开本机。
- 脱敏在参数进入记录和解释之前完成；但脱敏基于键名，值内嵌的密钥文本（例如命令行里的 `--token=...`）仍可能被记录，结构化的键值对/数组形状（`headers: [["Authorization", "Bearer ..."]]`、`env: ["API_KEY=..."]`）也不会被检查。可追加 `redactKeys`、收紧 `maxStringChars` / `maxParamChars`，或用 `outputDir: ""`、`persistCalls: false` 只保留内存记录。

## 性能与局限

- 每次调用增加：一次微秒级纯函数解释、一次 O(1) 内存聚合、一条排队异步 JSONL 追加；不等待磁盘，不阻塞工具返回。
- 聚合在内存中，统计查询不扫描 JSONL；`stats.json` 写盘默认防抖 2 秒，退出时强制落盘。
- 记录数据的内存占用有界：聚合按工具/会话计数，最近调用受 `recentLimit` 限制，单条记录的每个字段都有上限（参数、字符串、失败信息、解释摘要/明细）。唯一可能临时无界增长的是磁盘停滞时排队的 JSONL 行；每行仍是一条有上限的记录，写入完成后队列即排空。
- 并行调用的耗时相互重叠，`totalMs` 可能大于实际经过时间。
- `recent` 列表只在内存中，重启后为空；跨重启历史以 JSONL 为准。
- JSONL 按日期分文件但不自动清理，没有保留期或轮转策略。
- v1 不提供浏览器统计页面，不导出 Prometheus / OTLP，不做采样，不使用 LLM 生成解释。
- 写入失败只记录一次警告并在内存中继续统计，不会阻塞工具调用；输出目录创建失败会在后续写入时重试，不会让持久化在整个插件生命周期内失效。

## 仓库与许可

- 仓库：<https://github.com/youtaya/dsh-plugins> —— 本包位于 `plugins/tool-usage`。
- 许可证：MIT，版权 2026 youtaya——见 [LICENSE](../LICENSE)。
- README：[README.zh.md](https://github.com/youtaya/dsh-plugins/blob/main/plugins/tool-usage/README.zh.md) · 设计契约：[docs/DESIGN.md](https://github.com/youtaya/dsh-plugins/blob/main/docs/DESIGN.md) · 安全策略：[SECURITY.md](https://github.com/youtaya/dsh-plugins/blob/main/SECURITY.md)。
