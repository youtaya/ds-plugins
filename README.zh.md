# dsh-plugins

[![CI](https://github.com/youtaya/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/youtaya/dsh-plugins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.9-3c873a.svg)](package.json)

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的树外 bundle 插件集合。`plugins/` 下的每个包都是标准的可安装 DSH bundle：自带 `cordis.patch.yml` 层、提交构建产物 `lib/`，可通过 `dsh plugin add` 安装到任意 profile。这些插件由社区维护，不属于 DSH 主仓库。

## 插件列表

| 包 | 版本 | 说明 | 文档 |
| --- | --- | --- | --- |
| [`dsh-plugin-tool-usage`](plugins/tool-usage) | 0.1.0 | 记录每次 agent 工具调用（参数脱敏）并生成可读解释，按工具统计调用次数、失败数与耗时。 | [English](plugins/tool-usage/README.md) · [中文](plugins/tool-usage/README.zh.md) |

每个包有自己的 README，完整说明行为、配置与隐私；本文件只介绍整个仓库。

## 环境要求

- **DSH** `>=0.2.0-0 <0.3.0` —— 版本范围写在每个包的 `engines.dsh` 中，由 DSH 在安装与启动时校验。本仓库的验证基于 DSH `0.2.2-alpha.2`。
- **Node.js** `>=24.9`（`.nvmrc` 固定 `24.19.0`，仅开发需要）。安装后的插件运行在 DSH 宿主进程内，本身不新增运行时依赖。

从本仓库安装插件既不需要构建，也不需要 DSH 源码 checkout：`lib/` 已提交。需要从源码构建时使用 npm 开发依赖；无法 `npm install` 时可改用 DSH 源码 checkout。

## 安装插件

`dsh plugin add` 接受包目录的绝对路径，因此先克隆本仓库（或使用已有的本地检出）：

```sh
git clone https://github.com/youtaya/dsh-plugins.git
cd dsh-plugins

# 把一个 bundle 安装到 profile（profile 首次使用时自动初始化）。
dsh plugin --profile <profile> add "$PWD/plugins/tool-usage"

# 确认 bundle 层已生效，然后启动该 profile。
dsh --profile <profile> --dump-config   # 应出现 "# == dsh-plugin-tool-usage" 以及 id 为 "tool-usage" 的行
dsh --profile <profile>
```

重启 profile 后插件生效。卸载：

```sh
dsh plugin --profile <profile> remove dsh-plugin-tool-usage
```

这些包尚未发布到 npm；从本地包目录安装是当前受支持的方式。配置覆盖与数据目录位置见对应包的 README。

## 仓库结构

```
.
├── .github/workflows/ci.yml     # 安装 → 构建 → lib 一致性 → 测试 → 打包检查 → 公共信息检查
├── docs/DESIGN.md               # dsh-plugin-tool-usage 的权威设计契约
├── scripts/check-public.mjs     # 扫描待提交文件中的本机路径与凭据形态
└── plugins/
    └── tool-usage/              # dsh-plugin-tool-usage
        ├── src/                 # TypeScript 源码
        ├── lib/                 # 已提交的构建产物（ESM + .d.ts）
        ├── scripts/build.mjs    # 确定性的干净构建（npm typescript 或 DSH checkout）
        ├── cordis.patch.yml     # bundle 层：插入 tool-usage 行
        ├── locale/{en,zh}.json  # 插件展示元数据
        ├── docs/DETAIL*.md      # 随包发布的插件详情页
        ├── tests/               # 针对 lib/ 的 node:test 测试
        └── verification/        # 单元/E2E/在线激活报告与 E2E harness
```

## 开发

```sh
cd plugins/tool-usage
npm install          # 开发依赖：typescript、@types/node、DSH alpha 类型包
npm run build        # 重新生成已提交的 lib/
npm test             # node:test 测试（133 个）
```

在仓库根目录：

```sh
npm run verify       # 构建 + 测试
npm run pack:check   # 对插件包执行 npm pack --dry-run
npm run check:public # 扫描待提交文件中的本机路径与凭据
```

如果无法 `npm install`，可改为基于 DSH 源码 checkout 构建：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness node plugins/tool-usage/scripts/build.mjs
```

`lib/` 是提交到仓库的产物；若与重新构建的结果不一致，CI 会失败。因此修改 `src/` 后必须重新构建并一起提交。仓库约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 验证

每个包的验证证据位于 `plugins/<name>/verification/`：

- [`unit-report.md`](plugins/tool-usage/verification/unit-report.md) —— 构建与测试命令、逐文件结果、运行环境。
- [`e2e-report.md`](plugins/tool-usage/verification/e2e-report.md) —— 在隔离 `DSH_HOME` 中运行真实 headless DSH 进程，逐条断言 PASS/FAIL，并记录完整命令。
- [`live-activation.md`](plugins/tool-usage/verification/live-activation.md) —— 在运行中的 Web profile 中激活插件的证据：实时 JSONL 记录、`stats.json` 与真实的 `tool_usage` 报告。
- [`e2e/setup-and-run.mjs`](plugins/tool-usage/verification/e2e/setup-and-run.mjs) —— 可复用 E2E harness，支持 `--dry-run`、`--no-llm`、`--skip-error`、`--error-only`；它只重建自己的隔离 home，不会触碰线上 `~/.dsh`。

```sh
DSH_CHECKOUT=/path/to/deepseek-harness node plugins/tool-usage/verification/e2e/setup-and-run.mjs
```

E2E harness 需要 DSH CLI；涉及 LLM 的运行还需要 `~/.dsh/.credentials.yaml` 中的凭据，凭据只在进程内读取，不会写入工作区。若宿主不允许子 DSH 嵌套 sandbox，按 E2E 报告所述用 `DSH_PERMISSION_MODE=danger-full-access` 运行一次性任务。

## 设计

[`docs/DESIGN.md`](docs/DESIGN.md) 是 `dsh-plugin-tool-usage` 的权威设计契约：清单、bundle patch、运行时行为、脱敏与解释规则、统计语义、存储、构建、测试与隐私威胁模型。行为变更应先更新契约。

## 参与贡献

欢迎提交 issue 与 pull request，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

## 许可证

[MIT](LICENSE) © 2026 youtaya。每个包也在自己的 `package.json` 中声明许可证。
