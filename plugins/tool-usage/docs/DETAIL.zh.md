# 工具调用统计

`dsh-plugin-tool-usage` 为智能体的每一次工具调用留下可读的记录：调用了什么、参数是什么（脱敏后）、花了多久、成功还是失败、属于哪个会话；同时按工具汇总调用次数与耗时。所有数据只写在本机。

## 功能

- **记录**：包装 `tools/execute`，记录工具名、脱敏并截断后的参数、开始时间、耗时、结果状态（`ok` / `error` / `aborted` / `threw`）、所属会话与调用 id；每次调用一条 JSONL。
- **解释**：为每次调用生成确定性的中英文摘要，例如“执行 Shell 命令：pnpm test”“读取文件 /tmp/a.ts（第 1 行起，最多 200 行）”；不给模型看参数也能知道这行记录在做什么。
- **统计**：按工具、按会话统计调用次数、失败数、总耗时、平均/最小/最大/最近耗时、慢调用数；内存中聚合，查询不扫描日志。
- **Web UI 看板**：在 Web / Desktop profile 中，每轮结束后追加一张看板卡片；会话视图页签「调用看板」/ Calls 汇总整个会话的总计、按工具条形图、轮次时间线与最近调用；右侧栏「调用流」/ Calls stream 实时列出 Shell 命令与工具调用。浏览器半侧是通过 `dsh.client` 声明的纯 JavaScript bundle，读取宿主会话投影，无需构建步骤。
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
- 宿主侧运行时导入仅限 `node:*` 内置模块与 `@deepseek-ai/dsh-tools`；浏览器半侧只依赖加载器提供的 `react`，因此不安装、也不打包第三方运行时依赖。
- Web / Desktop profile 会注册斜杠命令；headless profile 仍会记录调用并提供 `tool_usage` 工具。
- Web / Desktop profile 还会加载浏览器半侧（`dsh.client` + `client.js`）。升级插件后，重启 profile 并刷新一次页面，让浏览器加载新的客户端 bundle；headless profile 不渲染 UI。

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

## Web UI 看板

包为 Web / Desktop profile 提供浏览器半侧：`client.js` 是手写的纯 JavaScript 模块（无 JSX、无 TypeScript、无构建步骤），在 `package.json` 中声明为 `dsh.client: { platform: "web", immediately: true, inject: [...] }`，由 DSH Web 客户端模块系统提供。它在宿主侧记录与统计之外注册三个条目。

| 条目 | 槽位 | id | order | 渲染内容 |
| --- | --- | --- | --- | --- |
| 每轮看板 | `conversation.chat.turnTail` | `tool-usage-summary` | 5 | 每个执行了工具调用的已完成轮次一张卡片：结果状态、次数、耗时、按工具条形图、可展开的调用列表。 |
| 会话看板 | `conversation.view` | `tool-usage-calls` | 20 | 标签为「调用看板」/ Calls 的会话视图页：整个会话的总计、按工具表格、轮次时间线、最近调用。 |
| 右侧实时调用流 | `sidebar.right.pane.tab`（页签类型 `tool-usage-stream`） | `dsh-plugin-tool-usage-stream` | — | 右侧栏页签：固定长度（最新 50 条、倒序）的工具调用与 Shell 命令流，执行中的调用固定在顶部。 |

### 渲染位置

- **每轮看板。** 一轮完成且该轮确实产生过工具调用后，追加到对话流：轮次标题、结果状态标签、本轮总耗时、指标块（调用次数、失败次数、总耗时/平均耗时、工具种类）、该轮调用最多的前五个工具的横向条形图（含次数与失败数）、Shell 命令数，以及默认折叠的该轮已结束调用列表（状态、工具、摘要、命令、耗时）。当有界窗口挤掉了该轮的更早调用时，卡片会提示 `更早的调用已省略`；底部提示指向会话看板页签，查看整个会话的数字。
- **右侧实时调用流。** 每次页面加载后，当前会话第一次进入运行状态时自动打开的右侧栏页签（通过 ref 守卫，用户关闭后不会再次自动打开），也可从会话头部的「调用流」/ Calls 按钮或右侧栏引导页重新打开。主体是占满高度的两段布局：页头显示实时/空闲状态、`共 N 次调用` 与当前轮次；下方是可滚动的固定长度列表（最多 50 条、倒序），逐条显示状态点、`HH:MM:SS`、工具徽标、一行解释、等宽 Shell 命令、耗时与轮次。执行中的调用固定在顶部，已用时间每 500 ms 刷新。宿主投影不可用时（旧 Host 进程或未注册该单元的 profile），该页签回退到 Chat 数据，从 `useChat` 的执行中列表与已结束的 tool-result 节点推导同样的行，仍然实时更新。
- **会话看板。** 可滚动的会话页面：页头（标题、副标题与投影的 `generatedAt` 时间）、响应式指标卡网格（调用次数、失败次数与失败率、总耗时、平均耗时、最慢耗时、工具种类、Shell 命令数、轮次数）、按工具表格（工具 / 次数 / 失败 / 平均 / 最慢 / 占比条，按调用次数降序，最多 20 个工具）、轮次时间线（新到旧：轮次、状态、调用、失败、耗时、开始时间；进行中的轮次高亮），以及支持「全部 / 失败 / Shell」筛选的最近调用列表。没有投影或还没有调用时，页签显示空状态而不是空白表格。

### 读取的数据

宿主注册一个键为 `toolUsage` 的会话投影，并以整值 JSON 帧下发（视图 `v: 1`）：`generatedAt`、`language`、`totals`、`byTool`、`turns`、`calls`、`running`。该单元声明 `wire.summary: false`，因此该值不进入会话列表摘要；客户端通过框架的 `useProjection` 属性按需读取，并在每次工具调用开始/结束或轮次开始/结束时收到新对象。更旧的宿主没有该单元（或宿主设置了 `uiEnabled: false`）时读到 `undefined`：两个依赖投影的条目都不渲染，会话页签显示空状态而不是报错；右侧调用流则回退到后文所述的 Chat 数据。

列表是固定、有界的形状：

- `calls` 只含已结束的调用，按结束时间升序，最多 `uiRecentCalls` 条（默认 60）；正在执行的调用不在此列表。
- `turns` 含最近的轮次，升序，最多 `uiRecentTurns` 轮（默认 30）；`totals.turns` 统计所有观察到的轮次，可能多于列出的行数。
- `byTool` 按调用次数降序排列，最多 20 个工具行。
- `running` 按开始顺序列出正在执行的调用，本身不带耗时；右侧调用流在客户端根据 `startTime` 计算已用时间。

右侧栏页签优先读取同一个投影；回退模式只读取框架已向 session 作用域条目提供的标准 `useChat` 数据。浏览器半侧不调用 Remote 端点、不发起 fetch、不读取其他插件的 DOM，只通过自己的 effect 持有的元素与样式表写入 DOM。它不引入额外存储：视图只存在于 Web 页面针对当前会话的内存中。

### 数字含义

- **总计**覆盖整个会话日志（投影从会话起点折叠已提交事件）：`calls`（已开始的调用，含已结束与执行中）、`settled`、`errors`、`running`、`totalMs`（已结束调用的耗时之和）、`avgMs`（`totalMs / settled`，没有已结束调用时为 `0`）、`maxMs`（最慢的已结束调用）、`tools`（不同工具名数）、`turns`（所有观察到的轮次，包括其调用已滑出窗口的轮次）。
- **轮次行**带 `turn`、`startTime`、`endTime`（进行中为 `null`）、`calls`、`errors`、`totalMs`，以及 `outcome`：`open`、`completed`、`aborted`、`blocked`、`error`、`max-tokens`、`interrupted`、`forked`。卡片的标签与时间线的状态列都使用该结果。
- **调用行**带 `tool`、`summary`、`command`、`turn`、`step`、`startTime`、`endTime`、`durationMs`、`status`、`error`。`status` 为 `ok`（工具成功）、`error`（工具返回错误结果或在协议层失败）、`aborted`（调用方取消）。失败用错误色显示，`aborted` 显示为已取消。
- **轮次分组。** 每个 `tool/call` 都带轮次与步骤编号，因此调用按轮次分组。轮次行在 `turn/start` 时打开、在 `turn/end` 时关闭；其 `calls`、`errors`、`totalMs` 随该轮调用结束而累加。结果始终没有到达的调用会在轮次关闭时按 `aborted` 结束，因此看板不会留下永远转圈的行。
- **计时。** 看板耗时由已提交会话事件的时间戳（`startTime` / `endTime`）计算并保留 1 位小数；记录器自身的日志耗时使用 `performance.now()` 前后差。并行调用会重叠，因此 `totalMs` 是各次耗时之和，可能大于墙钟时间；`avgMs` 是单次调用平均值，不是吞吐。一轮的 `totalMs` 是其已结束调用耗时之和，而 `endTime - startTime` 是墙钟跨度，并行时两者可以不相等。
- **状态与错误文本。** 失败调用的 `error` 信息会随线上载荷传到浏览器，按 `maxStringChars` 截断、不按键名脱敏（它来自工具结果），并在调用列表中显示；浏览器不会重试或重新计算任何内容。
- **窗口与总计。** 会话看板的总计与失败率反映整个会话，但调用列表、轮次时间线与按工具表格来自有界的投影列表。更早的调用仍被计数，只是不被列出；某轮的调用列表被裁剪时，该轮卡片会给出提示。

### 语言与解释行为

- UI 文案来自浏览器半侧的 locale 命名空间（`tool-usage-ui`，注册了中英文字典），由 Web UI 语言选择，不取自插件的 `language` 配置。
- 调用摘要在记录时由宿主使用插件的 `language`（`zh` / `en`）与 `explain`（`off` / `brief` / `detailed`）配置生成。看板显示已存储的一行 `summary`，不翻译、也不重新生成。
- `explain: off` 时摘要为空，各视图退化为显示工具名，但调用仍会被计数和列出；`details` 明细只写入记录，不会发送到浏览器。
- Shell 命令行只存在于 `bash` 及其别名的调用，并按 `uiCommandChars` 字符（默认 240）截断加 `…`；其他工具没有命令行。
- 体积与时间在浏览器内格式化：小于 1000 ms 的耗时显示为 `123ms`，否则为 `1.2s`；时间戳显示为本地 `HH:MM:SS`。
- `uiEnabled: false` 会跳过投影注册，每轮看板与会话看板随之不渲染；右侧调用流仍以 Chat 数据回退模式工作（展示的就是对话界面已经渲染的同一批调用）。记录、统计、模型工具与斜杠命令不受影响。

### 隐私

会话投影在宿主侧由已提交的会话事件折叠而成，通过既有本机 Web 会话通道传输；它不新增文件、不发网络请求、不做遥测。线上载荷只包含派生数据——一行解释摘要、截断后的 Shell 命令行、状态、耗时、计数与失败文本——绝不包含已记录的原始参数对象。底层脱敏与截断规则仍决定摘要或命令可能暴露的内容：脱敏基于键名，而命令行本身是参数对象里的字符串值，其中内嵌的密钥不会被键名脱敏，只受 `uiCommandChars` 截断限制；可追加 `redactKeys`、收紧上限，或设 `uiEnabled: false` 停止宿主投影（此时右侧调用流只镜像对话界面已渲染的数据）。

### 局限

- 看板是**会话内、向前看**的：只渲染本会话从插件加载起的在内存调用，不回放 JSONL 历史，插件重启后从空开始。
- 列表受 `uiRecentCalls` / `uiRecentTurns` 限制，按工具表格最多 20 行；总计覆盖整个会话，但更早的个别调用不会被列出。
- 每轮卡片无法以程序方式切换会话视图（客户端 API 不提供跨插件视图切换），只能提示用户前往「调用看板」页签。
- 右侧调用流的已用时间在客户端计时，因此是近似值；列表固定为最多 50 条、倒序。
- headless profile 没有 UI；Web 页面在刷新前会保留之前加载的客户端 bundle，因此升级需要重启加刷新页面。
- UI 跟随宿主主题与浏览器语言，不引入自己的主题、字体或图标包。

## 配置

在 profile 的 `cordis.patch.yml` 中按 id `tool-usage` 覆盖（补丁整段替换 `config`，插件为缺失键套默认值，因此只写要改的键）：

```yaml
- id: tool-usage
  config:
    language: en
    explain: brief
    slowThresholdMs: 10000
    uiRecentCalls: 120
    uiCommandChars: 160
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
| `uiEnabled` | `true` | 是否注册 `toolUsage` 会话投影并渲染它的两个 Web UI 条目；`false` 不影响记录与统计（右侧调用流回退到 Chat 数据） |
| `uiRecentCalls` | `60` | 整数 1–500；投影与看板列表中最多的最近已结束调用条数 |
| `uiRecentTurns` | `30` | 整数 1–200；投影与看板时间线中最多的最近轮次数 |
| `uiCommandChars` | `240` | 整数 1–1000；单条 Shell 命令行进入 UI 的字符上限（超出截断并加 `…`） |

## 数据与隐私

- 位置：`$DSH_HOME/tool-usage/calls-YYYY-MM-DD.jsonl`（按本地日期分文件）与 `$DSH_HOME/tool-usage/stats.json`；`$DSH_HOME` 默认 `~/.dsh`。
- 权限：目录 `0o700`，文件 `0o600`；已存在但权限更宽的当日日志文件会在本进程首次追加时被重新收紧为 `0o600`。`stats.json` 以进程内唯一临时文件（`stats.json.<pid>.<random>.tmp`）+ `rename` 原子替换；它采用最后写入者生效语义，因此假定每个 `$DSH_HOME` 只有一个 DSH 进程（JSONL 追加在并发写入下仍然安全）。
- 只写 `outputDir`，不联网，数据不离开本机。
- 脱敏在参数进入记录和解释之前完成；但脱敏基于键名，值内嵌的密钥文本（例如命令行里的 `--token=...`）仍可能被记录，结构化的键值对/数组形状（`headers: [["Authorization", "Bearer ..."]]`、`env: ["API_KEY=..."]`）也不会被检查。可追加 `redactKeys`、收紧 `maxStringChars` / `maxParamChars`，或用 `outputDir: ""`、`persistCalls: false` 只保留内存记录。

## 性能与局限

- 每次调用增加：一次微秒级纯函数解释、一次 O(1) 内存聚合、一条排队异步 JSONL 追加；不等待磁盘，不阻塞工具返回。
- Web UI 投影为每个会话增加一个有界派生视图，只在调用开始/结束或轮次开始/结束时重算；载荷受 `uiRecentCalls`、`uiRecentTurns` 与 20 行工具表限制，因此与会话长度无关。
- 聚合在内存中，统计查询不扫描 JSONL；`stats.json` 写盘默认防抖 2 秒，退出时强制落盘。
- 记录数据的内存占用有界：聚合按工具/会话计数，最近调用受 `recentLimit` 限制，单条记录的每个字段都有上限（参数、字符串、失败信息、解释摘要/明细）。唯一可能临时无界增长的是磁盘停滞时排队的 JSONL 行；每行仍是一条有上限的记录，写入完成后队列即排空。
- 并行调用的耗时相互重叠，`totalMs` 可能大于实际经过时间。
- `recent` 列表只在内存中，重启后为空；跨重启历史以 JSONL 为准。
- JSONL 按日期分文件但不自动清理，没有保留期或轮转策略。
- 看板只在会话内有界，且不读取 JSONL 历史；它自身的局限见 [Web UI 看板](#web-ui-看板)。
- 不导出 Prometheus / OTLP，不做采样，不使用 LLM 生成解释。
- 写入失败只记录一次警告并在内存中继续统计，不会阻塞工具调用；输出目录创建失败会在后续写入时重试，不会让持久化在整个插件生命周期内失效。

## 仓库与许可

- 仓库：<https://github.com/youtaya/dsh-plugins> —— 本包位于 `plugins/tool-usage`。
- 许可证：MIT，版权 2026 youtaya——见 [LICENSE](../LICENSE)。
- README：[README.zh.md](https://github.com/youtaya/dsh-plugins/blob/main/plugins/tool-usage/README.zh.md) · 设计契约：[docs/DESIGN.md](https://github.com/youtaya/dsh-plugins/blob/main/docs/DESIGN.md) · 安全策略：[SECURITY.md](https://github.com/youtaya/dsh-plugins/blob/main/SECURITY.md)。
