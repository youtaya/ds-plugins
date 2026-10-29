# dsh-plugin-tool-usage

[English](README.md)

记录智能体每一次工具调用，为每次调用生成确定性的可读解释，并按工具、按会话统计调用次数与耗时。在 Web UI 中还会显示输入框上方的实时活动条、每轮结束后的看板卡片，以及整个会话的调用看板视图页。数据全部留在本机。

| 项目 | 值 |
| --- | --- |
| 插件包 | `dsh-plugin-tool-usage` 0.2.0 —— DSH 组合包插件（Cordis 插件名 `tool-usage`） |
| 模型工具 | `tool_usage`（可通过 `toolName` 改名） |
| 斜杠命令 | `/tool-usage`（可通过 `commandName` 改名） |
| 数据目录 | `$DSH_HOME/tool-usage/`，默认 `~/.dsh/tool-usage/` |
| 运行时导入 | `node:*` 内置模块，加上宿主提供的 `@deepseek-ai/dsh-tools`；包本身不安装任何第三方运行时依赖 |
| 许可证 | MIT —— 版权 2026 youtaya |

插件在 `tools/execute` 上挂一层包装器：每次工具调用开始前计时，结束后记录。它只测量和记录，**不改变**工具结果、`exec.signal` 或调用身份；记录过程中某一类操作失败只写一次警告，不影响正在执行的工具。

## 记录什么

每次 `tools/execute` 产生一条 `CallRecord`，追加到当天的 JSONL 文件。字段如下：

| 字段 | 含义 |
| --- | --- |
| `v` | 记录格式版本，当前为 `1` |
| `seq` | 插件生命周期内单调递增的序号 |
| `at` | 调用开始时间（ISO-8601） |
| `tool` | 工具名，如 `bash`、`read`、`grep` |
| `callId` | 执行调用 id（存在时） |
| `sessionId` | 所属会话 id（`exec.agent?.id`，存在时） |
| `durationMs` | 耗时（毫秒，保留 1 位小数） |
| `status` | `ok` / `error` / `aborted` / `threw` |
| `params` | 脱敏并截断后的调用参数；无法用 JSON 表示的值记为 `"[unserializable]"` |
| `paramsTruncated` | 参数是否被截断（字符串/数组/深度上限或整体参数上限任一触发） |
| `redacted` | 是否至少有一个参数值被替换为 `[REDACTED]` |
| `explanation` | `{ summary, details? }`，见下一节 |
| `error` | `{ message, code? }`，所有非 `ok` 记录都会带上；`message` 与 `code` 都受 `maxStringChars` 限制，且不按键名脱敏 |

`status` 的取值规则：

- `ok`：工具执行成功（`isError` 为 `false`）。
- `error`：工具返回错误结果（`isError` 为 `true`，且错误码不是中断）。
- `aborted`：结果错误码为 `ABORTED` 或 `ABORTED_BEFORE_DISPATCH`（被取消）。
- `threw`：`next()` 直接抛出（协议层异常，原异常会原样继续抛出）。

JSONL 中一行记录的真实形状（为便于阅读，示例做了折行；实际文件每行一条紧凑 JSON）：

```json
{
  "v": 1,
  "seq": 42,
  "at": "2026-10-28T08:31:05.412Z",
  "tool": "bash",
  "callId": "call_7f3a91",
  "sessionId": "ses_01J8ZK",
  "durationMs": 1402.7,
  "status": "ok",
  "params": { "command": "pnpm test", "cwd": "/srv/project" },
  "paramsTruncated": false,
  "redacted": false,
  "explanation": { "summary": "执行 Shell 命令：pnpm test" }
}
```

参数在写入前经过脱敏与截断，详见[数据、权限与隐私](#数据权限与隐私)。

## 解释

解释由纯函数生成：没有 I/O、没有时钟、不调用模型，对相同输入永远输出相同文本。`language` 选择中文或英文，`explain` 选择关闭、简要或详细。

中文、`explain: detailed` 时的 `summary` 示例：

```text
执行 Shell 命令：pnpm test
读取文件 /tmp/a.ts（第 1 行起，最多 200 行）
搜索文本：TODO（目录 /srv/project/src）（glob *.ts）
网络搜索：deepseek harness plugin
```

英文、`language: en` 时的对应输出：

```text
Run shell command: pnpm test
Read file /tmp/a.ts (from line 1, up to 200 lines)
Search text: TODO (in /srv/project/src) (glob *.ts)
Search the web: deepseek harness plugin
```

- `brief`：只生成 `summary`。
- `detailed`：额外在 `details` 中给出已注册工具的描述，以及每个已声明参数的一行说明（`Parameter <name>: <description> = <value>`，中文为 `参数 <name>：<说明> = <值>`；未传入的参数显示为 `（未提供）`），随后再列出其余参数键。
- `off`：不生成解释。
- 内置了 `bash`、`read`、`write`、`edit`、`glob`、`grep`、`web_search`、`web_fetch`、`read_image`、`todo_write`、`subagent`、`subagent_fork`、`workflow`、`working_directory`、`ask_user_question`、`job_output`、`job_kill`、`job_list` 等工具的中英文措辞。常见别名（如 `shell` → `bash`、`read_file` → `read`）、连字符写法，以及带命名空间的名称（取 `__`、`.`、`:`、`/`、`\` 分隔的最后一段，例如 `mcp__server__bash`）都会归一到同一套措辞。未知工具会退化为 `调用工具 <name>：<参数摘要>`（英文为 `Call tool <name>: <compact params>`）。
- `summary` 永远是单行：写入前会把空白（包括换行）折叠掉。
- 解释体积有上限，记录不会无限增长：`summary` 最多 2,000 字符，`details` 最多 50 行 / 8,000 字符，已注册工具与参数的说明也按普通值截断；超出的明细行/字符直接丢弃，不加标记。

模型也可以主动查询任一已注册工具的解释：

```json
{ "view": "explain", "tool": "bash" }
```

该视图返回工具的注册描述和参数表。工具名缺失或不存在时返回错误：实现层会抛出，DSH 运行时将其转成正常的工具错误结果，而不会让进程崩溃。

## 统计

插件在内存中维护聚合数据，不对每次查询扫描 JSONL。Web UI 读取同一份内存数据的会话投影，见 [Web UI 看板](#web-ui-看板)。

**按工具聚合**（`tools` 视图的每一行，按调用次数从多到少排列）：`calls`（调用次数）、`errors`（失败数：`error` 与 `threw`；`aborted` 反映调用方取消，不计为失败）、`errorRate`（失败率，保留 4 位小数）、`totalMs`、`avgMs`、`minMs`、`maxMs`、`lastMs`（最近一次耗时）、`lastAt`（最近一次调用时间）、`slowCalls`（慢调用次数）。持久化文件里的聚合还会保存 `statusCounts`（各状态计数）。

**全局总计**：`calls`、`errors`、`totalMs`、`avgMs`、`maxMs`、`slowCalls`、`sessionCount`（`all` 范围下为真实会话数，不含“无会话”桶；会话范围查询在选中范围有记录时为 `1`，否则为 `0`）。

语义说明：

- **范围**：`session` 只统计当前会话（按 `exec.agent?.id` 归属），`all` 统计本插件启动以来记录的全部会话；两者都基于同一份内存聚合，不做磁盘重算。没有会话 id 的调用归入“无会话”桶：`all` 范围包含它，会话范围在调用方自身没有会话 id 时也会选中这个桶。
- **慢调用**：单次耗时 ≥ `slowThresholdMs`（默认 5000ms）即计入 `slowCalls`，快照中对应 `recent[].slow` 字段为 `true`。
- **最近调用**：内存中保留最近 `recentLimit` 条（默认 200，环形缓冲），查询时按新到旧返回，`limit` 限制返回条数（工具调用上限 100）。
- **并行调用会重叠**：耗时是 `performance.now()` 的前后差；`totalMs` 是各次调用耗时之和，因此并行执行时可能大于墙钟经过的时间。`avgMs` 是单次调用平均值，不是吞吐。
- **持久化**：聚合结果写入 `stats.json`，插件重启时在 `restoreStats: true` 且 `persistStats: true` 时恢复（恢复采用加法合并，启动读取期间产生的调用不会被丢弃），因此跨重启的计数保持连续；`recent` 列表只存在内存中，重启后从空开始，历史调用以 JSONL 为准。
- `snapshot` 中的毫秒值统一保留 1 位小数。

## Web UI 看板

在 Web / Desktop profile 中，插件还提供一个浏览器半侧（`client.js`，通过 `dsh.client` 声明 `platform: "web"`），渲染四个界面——其中三个来自宿主注册的同一个会话投影，另有一个优先读取该投影、缺失时回退到 Chat 数据的右侧实时调用流：

- **实时活动条**（输入框上方，`conversation.input.dock`，id `tool-usage-live`，order 15）：本轮进行中时显示正在执行的工具调用、当前 Shell 命令和每次调用的一行解释；没有调用在跑时显示本轮最近完成的调用。没有打开的轮次时不显示。
- **每轮看板**（每轮结束后，`conversation.chat.turnTail`，id `tool-usage-summary`，order 5）：每个执行了工具调用的已完成轮次一张卡片，包含结果状态、调用与失败次数、总耗时与平均耗时、按工具条形图、Shell 命令数，以及可展开的该轮调用明细列表。
- **会话看板**（会话视图页签，`conversation.view`，id `tool-usage-calls`，order 20，标签「调用看板」/ Calls）：整个会话的总计与失败率、按工具表格、轮次时间线和最近调用，支持「全部 / 失败 / Shell」筛选。
- **右侧实时调用流**（右侧栏页签类型 `tool-usage-stream`，实现 id `dsh-plugin-tool-usage-stream`）：可滚动的固定长度列表（最新 50 条，倒序），逐条显示状态、时间、工具名、一行解释、等宽 Shell 命令和耗时；执行中的调用固定在顶部，已用时间每 500 ms 刷新。每次页面加载后，当前会话第一次进入运行状态时自动打开一次（用户手动关闭后不会再次自动打开），也可通过会话头部的「调用流」/ Calls 按钮或右侧栏引导页重新打开。宿主投影不可用时（例如旧 Host 进程或未注册投影的 profile），面板回退到 Chat 数据，仍能实时展示同样的调用行。

宿主以 `toolUsage` 为键注册会话投影，并声明 `wire.summary: false`，因此该值不包含在会话列表摘要里，由 Web 客户端按需读取。每次调用开始/结束、每轮开始/结束时，投影都以整值帧下发。线上载荷只包含派生数据——一行解释摘要、Shell 命令行、状态、耗时与失败文本——不包含已记录的原始参数对象。浏览器半侧有独立的中英文 locale 命名空间，只使用主题 token，跟随宿主主题与浏览器语言；不发起网络请求，投影走既有的本机会话通道。

**统计数字覆盖整个会话日志**（投影从会话起点折叠已提交事件），而**列表是有界窗口**：最近 `uiRecentCalls` 条已结束调用（默认 60）、最近 `uiRecentTurns` 轮（默认 30），按工具表格最多 20 个工具。某一轮的旧调用已被窗口挤出时，该轮卡片会注明；总计仍会统计它们。

语言与解释行为：

- UI 文案跟随 Web UI 语言；调用的解释仍使用插件的 `language` 配置，因为解释是记录时在宿主生成的。
- `explain: off` 时没有摘要，视图退化为显示工具名；`brief` / `detailed` 时显示一行摘要。Shell 命令行只对 `bash` 及其别名的调用存在。
- 设 `uiEnabled: false` 可跳过投影注册，实时活动条、每轮看板与会话看板随之不渲染；右侧调用流仍以 Chat 数据回退模式工作（展示的就是对话界面已经渲染的同一批调用）。记录、统计、`tool_usage` 工具与 `/tool-usage` 命令不受影响。

升级插件后，重启 profile 并刷新一次浏览器页面，让 Web 客户端加载新的客户端 bundle。

## 安装与移除

包内已提交构建产物 `lib/`，安装时不需要执行构建脚本，也不需要额外的构建权限。本包尚未发布到 npm，请从仓库的本地 checkout 安装。

在仓库根目录执行：

```sh
git clone https://github.com/youtaya/dsh-plugins.git
cd dsh-plugins

# 安装到某个 profile（首次使用会自动创建该 profile）
dsh plugin --profile <profile> add "$PWD/plugins/tool-usage"

# 确认该层已生效
dsh --profile <profile> --dump-config    # 输出中应出现 "# == dsh-plugin-tool-usage" 层和 id 为 tool-usage 的行

# 启动该 profile
dsh --profile <profile>
```

已经有一份 checkout 时，直接传该包的绝对路径即可：`dsh plugin --profile <profile> add <指向该仓库的绝对路径>/plugins/tool-usage`。

重启该 profile 后生效（在支持热加载的开发会话中也可依赖 HMR，但以重启为准）。升级插件后，重启 profile 并刷新页面，让浏览器加载新的客户端 bundle。

移除：

```sh
dsh plugin --profile <profile> remove dsh-plugin-tool-usage
```

移除插件不会删除已经写出的调用记录与统计文件；需要时自行清理数据目录。

### 修改配置

组合包自带的 patch 只插入一行、不带 `config`，所有默认值都在插件里。要改配置，在 profile 自己的 `cordis.patch.yml`（或任意更靠后的 patch 层）中按 id `tool-usage` 覆盖：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: tool-usage
  config:
    language: en
    explain: brief
    slowThresholdMs: 10000
    uiRecentCalls: 120
    uiCommandChars: 160
```

补丁按 id **整段替换** `config`，不会逐键合并；但插件会为缺失的键套用默认值，所以只写想改的键即可。需要保留非默认值时，把它们一起写出来。

## 兼容性

- DSH `>=0.2.0-0 <0.3.0`（声明于 `engines.dsh`）；已对 DSH `0.2.2-alpha.2` 验证。
- 构建、测试本仓库需要 Node.js `>=24.9`（`.nvmrc` 固定 `24.19.0`，也是验证所用版本）；安装后的插件运行在 DSH 宿主进程内，不引入独立的 Node 运行时。
- DSH profile 提供的 peer 包：`@deepseek-ai/cordis >=4.0.0-0 <5.0.0`、`@deepseek-ai/dsh-tools >=0.2.0-0 <0.3.0`、`@deepseek-ai/dsh-commands >=0.2.0-0 <0.3.0`。
- 宿主侧运行时导入仅限 `node:*` 内置模块与 `@deepseek-ai/dsh-tools`；浏览器半侧只依赖加载器提供的 `react`。不安装、也不打包其他依赖。
- Web / Desktop profile 会注册 `/tool-usage` 命令并提供 Web UI 看板（包通过 `dsh.client` 声明并提供纯 JavaScript 的 `client.js` bundle）；headless profile 仍会记录调用并提供 `tool_usage` 工具，但不渲染 UI。
- 宿主代码仅支持 Node ESM。本包尚未发布到 npm，请按上面的方式从本地 checkout 安装。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时只写一条 info 日志后退出，不记录、不注册工具与命令。 |
| `outputDir` | `"$DSH_HOME/tool-usage"` | 数据目录，支持开头的 `~` 与 `$DSH_HOME`；相对路径会按工作目录解析。`""` 表示不落盘（两个 persist 开关实际失效）。 |
| `persistCalls` | `true` | 是否把调用记录追加到 `calls-YYYY-MM-DD.jsonl`。 |
| `persistStats` | `true` | 是否把聚合快照写入 `stats.json`。 |
| `restoreStats` | `true` | 启动时是否从 `stats.json` 恢复聚合；需要 `persistStats: true`，否则没有快照可读。 |
| `explain` | `"detailed"` | 解释级别：`off` / `brief` / `detailed`。`off` 时记录中的 `explanation.summary` 为空字符串，渲染时省略。 |
| `language` | `"zh"` | 解释与报告语言：`zh` / `en`。 |
| `maxParamChars` | `500` | 整个参数 JSON 序列化后的字符上限；超出时整体替换为大小不超过该上限的 `{ "_truncated": "前缀…" }` 预览；截断外壳本身需要 18 个字符，因此小于 18 的上限实际会被提升到 18。并置 `paramsTruncated: true`。 |
| `maxStringChars` | `200` | 单个字符串值（以及失败时的 `error.message` 文本）的字符上限；超出时截为 `maxStringChars - 1` 个字符加 `…`。 |
| `redactKeys` | 内置敏感键 + 用户追加 | 敏感键列表；大小写不敏感，键名去掉 `-` / `_` / `.` 与空白后包含任一配置项即脱敏。只能追加，不能删除内置项。 |
| `recentLimit` | `200` | 内存中最近调用的环形缓冲容量。 |
| `slowThresholdMs` | `5000` | 慢调用阈值（毫秒），用于 `slowCalls` 与 `slow` 标记。 |
| `toolName` | `"tool_usage"` | 模型工具名。 |
| `commandName` | `"tool-usage"` | 斜杠命令名，不含 `/`；自动转小写并去掉前缀 `/`，需匹配 `[a-z][a-z0-9_-]*`，否则回退默认值。 |
| `statsWriteDebounceMs` | `2000` | `stats.json` 写盘防抖窗口；退出时会立即落盘。 |
| `includeParamsInReport` | `true` | 工具/命令快照输出中的 `recent[]` 是否附带脱敏后的参数；Markdown 报告本身不展示参数。 |
| `uiEnabled` | `true` | 布尔值。是否注册 `toolUsage` 会话投影并渲染它的三个 Web UI 界面。`false` 时不注册投影，这三个界面不渲染；右侧调用流仍以 Chat 数据回退模式工作。记录、统计、工具与命令不受影响。 |
| `uiRecentCalls` | `60` | 整数，1–500。投影携带并在看板中列出的最近已结束调用条数。更早的调用退出列表，但总计仍包含它们。 |
| `uiRecentTurns` | `30` | 整数，1–200。投影携带的最近轮次数（每轮卡片与看板时间线）。更早的轮次退出列表，但总计仍包含它们。 |
| `uiCommandChars` | `240` | 整数，1–1000。投影携带并在 UI 中展示的单条 Shell 命令行的字符上限；超出部分截断并加 `…`。 |

补充：`$DSH_HOME` 取 `process.env.DSH_HOME`（去掉首尾空白），未设置时用 `~/.dsh`。非法配置值不会让插件加载失败：类型错误、非法枚举值与非法命令名回退到默认值，数值越界夹取到允许区间，并记录一条警告。

## 模型工具 `tool_usage`

注册给所有智能体的只读工具（`isConcurrencySafe: () => true`），不会修改任何状态。

| 参数 | 类型 | 取值 | 说明 |
| --- | --- | --- | --- |
| `view` | string | `summary` / `tools` / `recent` / `explain` | 返回内容。默认 `summary`。 |
| `tool` | string | 工具名 | `view: "explain"` 时必填；其他视图下按工具名精确过滤按工具表格与最近调用。 |
| `scope` | string | `session` / `all` | 统计范围。默认 `session`。 |
| `limit` | integer | `1`–`100` | 最近调用的最大返回条数。默认 `20`；越界值会被夹取到该区间。 |

调用示例：

```json
{ "view": "summary" }
```

```json
{ "view": "recent", "limit": 5, "scope": "all" }
```

```json
{ "view": "explain", "tool": "bash" }
```

工具的**输出值**是规范 JSON 快照；**渲染给模型**的是紧凑 Markdown（`language: zh` 时为中文，`en` 时为英文）。Markdown 输出示例：

```markdown
工具调用统计（范围：当前会话）

总计 12 次调用 / 1 次失败 / 总耗时 3.2s / 平均 267ms / 最慢 1.4s

| 工具 | 次数 | 失败 | 平均 | 最慢 | 最近 |
| --- | --- | --- | --- | --- | --- |
| bash | 8 | 0 | 210ms | 1.4s | 12:31:05 |
| read | 3 | 1 | 400ms | 620ms | 12:30:58 |
| grep | 1 | 0 | 320ms | 320ms | 12:30:41 |

最近调用：
1. [12:31:05] bash — 执行 Shell 命令：pnpm test（1.4s）
2. [12:30:58] read — 读取文件 /tmp/a.ts（第 1 行起，最多 200 行）（620ms，失败）
3. [12:30:41] grep — 搜索文本：TODO（320ms）
```

`scope: "all"` 时首行显示“范围：全部会话”，会话数保存在快照 JSON 的 `totals.sessionCount` 中（Markdown 不展示）。`tools` 视图只保留标题、总计行与按工具表格；`recent` 视图只保留标题、总计行与最近调用列表；`summary` 同时包含表格和最近调用；`explain` 视图返回目标工具的注册描述与参数表。

## 斜杠命令 `/tool-usage`

命令在 Web / Desktop 等具备 `commands` 服务的 profile 中注册；headless profile 没有该服务时不注册，其余功能不受影响。

| 命令 | 行为 |
| --- | --- |
| `/tool-usage` | 当前会话的摘要（总计 + 按工具表格 + 最近调用）。 |
| `/tool-usage all` | 全部会话的摘要。 |
| `/tool-usage recent [N]` | 当前会话最近 `N` 条调用（如 `/tool-usage recent 5`），默认 10；`N` 夹取到 1–100。 |
| `/tool-usage reset` | 清空全部会话的统计并按清空后的状态重写 `stats.json`，重启后不会恢复重置前的计数（已写出的 JSONL 调用日志不受影响）。 |
| 其他参数 | 返回错误和用法说明。 |

命令输出与模型工具使用同一个 Markdown 渲染器。

## 数据、权限与隐私

写入位置（`outputDir` 默认 `$DSH_HOME/tool-usage/`，即 `~/.dsh/tool-usage/`）：

- `calls-YYYY-MM-DD.jsonl`：按本地日期分文件，每行一条调用记录，只追加。
- `stats.json`：聚合快照（总计、按工具、按会话），启动时合并进内存聚合。写入时先写进程内唯一的临时文件（`stats.json.<pid>.<random>.tmp`）再 `rename` 原子替换，失败会清理临时文件；采用最后写入者生效语义。

查看今天的记录：

```sh
tail -n 5 ~/.dsh/tool-usage/calls-$(date +%F).jsonl
```

权限：目录以 `0o700` 创建，文件以 `0o600` 写入，即只有当前用户可读。已存在但权限更宽的当日日志文件（例如旧版本留下的 `0644`）会在本进程首次追加时被重新收紧为 `0o600`。插件不会写 `outputDir` 之外的位置，也不会发起任何网络请求——数据不离开本机。Web UI 投影由宿主侧已提交的会话事件折叠而成；其载荷只包含派生数据——一行解释摘要、（截断后的）Shell 命令行、状态、耗时与失败文本——不包含已记录的原始参数对象。

脱敏与截断（写入记录与解释之前执行）：

- 默认敏感键集合（`SENSITIVE_KEYS`）为 `token`、`password`、`passwd`、`secret`、`apikey`、`authorization`、`cookie`、`credential`、`privatekey`、`accesskey`、`secretkey`、`clientsecret`、`sessiontoken`；匹配不区分大小写，键名去掉 `-` / `_` / `.` 与空白后**包含**任一敏感键即命中，因此 `api.key` 与 `"api key"` 都能匹配 `apikey`。
- 命中的值替换为 `[REDACTED]`，并置 `redacted: true`。
- 超过 `maxStringChars` 的字符串截断并加 `…`；超过 50 项的数组截断并追加 `[… N more items]`；嵌套深度超过 6 层替换为 `[deep]`。
- 非 JSON 值（`undefined`、函数、Symbol、类实例、循环引用、`NaN`/`±Infinity` 等）写成 `"[unserializable]"`；`bigint` 转十进制字符串。
- 整个参数 JSON 超过 `maxParamChars` 时整体替换为不超过该上限的截断预览（最少 18 字符），保证记录始终是合法 JSON。
- 失败时的 `error.message` 与 `error.code` 取自工具结果，受 `maxStringChars` 截断，且**不**按键名脱敏（它们不属于参数对象）。
- 上述任一截断（字符串、数组、深度或整体参数上限）都会置 `paramsTruncated: true`。
- 脱敏键可通过 `redactKeys` 追加（例如 `["sessionToken", "idCard"]`）；内置项不可移除。

需要注意：脱敏基于键名，参数值本身若不慎包含密钥文本（例如命令行里的 `--token=...`），仍可能被记录；结构化的键值对/数组形状也不会被检查——`headers: [["Authorization", "Bearer ..."]]` 与 `env: ["API_KEY=..."]` 的字符串内容只按普通值处理。对敏感项目可追加业务键名、收紧 `maxStringChars` / `maxParamChars`，或设置 `outputDir: ""` / `persistCalls: false` 让记录只留在内存中。

## 性能

- 每次调用只做一次脱敏 + 解释（纯函数，微秒级）、一次内存聚合（O(1)）和一次**异步排队**的 JSONL 追加；追加不阻塞工具返回，磁盘慢只影响日志队列。
- 聚合在内存中完成，`tool_usage` 查询和 `/tool-usage` 命令不会扫描 JSONL。
- `stats.json` 写盘默认防抖 2 秒，退出时强制 flush，写放大被摊薄。
- 记录数据的内存占用有界：聚合按工具/会话计数，最近调用受 `recentLimit`（默认 200）限制，单条记录的每个字段都有上限（参数、字符串、失败信息/错误码、解释摘要/明细）。唯一可能临时无界增长的是磁盘停滞时排队的 JSONL 行：每行仍是一条有上限的记录，写入完成后队列即排空。
- Web UI 投影同样有界：每个会话一个派生视图，最多 `uiRecentCalls` 条已结束调用、`uiRecentTurns` 轮、20 个工具行，只在调用开始/结束或轮次开始/结束时重算。
- 不采样、不联网、不调用模型。

## 禁用

- 想临时停用但保留安装：在 profile 的 `cordis.patch.yml` 中覆盖 `{ id: tool-usage, config: { enabled: false } }`，重启后不记录任何内容。
- 想彻底移除：执行上面的 `dsh plugin --profile <profile> remove dsh-plugin-tool-usage`，并在需要时删除数据目录。

## 设计

**为什么包装 `tools/execute`，而不是监听会话事件。** 工具执行只有一个统一入口：`tools/execute` 能拿到原始 `exec.arguments`、标准化的 `ToolExecutionResult`（含 `isError` 与 `error.info.code`）以及精确的起止时间；内置工具、插件工具、子智能体与 workflow 内部的调用都经过这里。会话事件不保证携带每次调用的参数和耗时，也容易漏掉非会话路径上的调用。包装器只测时与记录，原样返回结果与 `exec.signal`，从记录代码抛出的异常一律吞掉，因此对智能体行为是透明的。

**为什么没有第三方运行时依赖。** 配置校验手写（不引入 Schemastery），解释器是纯函数，日志用 `node:fs`。因此从本地包目录安装时不需要执行任何构建步骤，也不需要授予 build 权限，依赖面小、加载快、供应链风险低。`lib/` 随包提交，`node scripts/build.mjs` 只在开发时使用。

**每次调用的成本。** 一个包装函数、一次微秒级的纯函数解释、一次哈希表聚合，加上一条排入后台队列的 JSONL 追加；不等待磁盘、不发网络请求、不复制工具结果。统计快照定期落盘，查询永不触发全量扫描。开销与工具本身耗时相比可以忽略，且失败时静默降级，不影响工具调用。

## 局限

- Web UI 是**会话内、向前看**的：它只渲染本会话从插件加载起的在内存调用，不回放历史 JSONL 记录。插件重启后投影从空开始；JSONL 日志仍保留历史，但 UI 不读取它。
- 看板列表是有界窗口（`uiRecentCalls` 条已结束调用、`uiRecentTurns` 轮、按工具表格最多 20 个工具）。总计覆盖整个会话，但更早的个别调用不会列出。
- Web UI 只在 Web / Desktop profile 中存在；headless profile 没有看板。
- 升级插件后，浏览器会保留之前加载的客户端 bundle，直到刷新页面。
- 不导出 Prometheus / OTLP，不做采样，不做基于 LLM 的解释。
- JSONL 按日期分文件但**不自动清理**：没有保留期或轮转策略，长期使用需要自行归档或删除旧文件。
- `stats.json` 是单个聚合快照、最后写入者生效，因此假定每个 `$DSH_HOME` 只有一个 DSH 进程；只追加的 JSONL 日志在并发写入下仍然安全。
- `recent` 列表只在内存中，插件重启后为空；跨重启的历史调用需读 JSONL。
- 并行调用的耗时相互重叠，`totalMs` 可能大于实际经过的墙钟时间；统计不区分并发度。
- 统计按 `exec.agent?.id` 归属会话；没有会话 id 的调用进入“无会话”桶，不归属任何具体会话。
- 记录是尽力而为：写盘失败只记录一次警告并继续在内存中统计，不会为补数据阻塞或重试工具调用。输出目录创建失败会在后续写入时重试，而不是让持久化在整个插件生命周期内失效。
- 脱敏只匹配键名，不扫描值内的敏感文本，也不检查结构化键值对/数组形状（如 `headers: [["Authorization", "Bearer ..."]]`、`env: ["API_KEY=..."]`）。
- `tool_usage` 的 `explain` 依赖工具已注册；查询不存在或未注册的工具会返回工具错误结果。
- 失败信息会被记录（有长度上限，但不按键名脱敏）；请避免让工具在错误文本中输出密钥。

## 仓库、许可与文档

- 仓库：<https://github.com/youtaya/dsh-plugins> —— 本包位于 `plugins/tool-usage`。
- 许可证：MIT，版权 2026 youtaya——见 [LICENSE](LICENSE)。
- 插件详情文档（随包发布）：[docs/DETAIL.zh.md](docs/DETAIL.zh.md)。
- 设计契约：[docs/DESIGN.md](https://github.com/youtaya/dsh-plugins/blob/main/docs/DESIGN.md)（仓库内相对路径 `docs/DESIGN.md`）。
- 安全策略：[SECURITY.md](https://github.com/youtaya/dsh-plugins/blob/main/SECURITY.md)。
