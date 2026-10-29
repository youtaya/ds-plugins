# Live activation on the running Web profile

> **Pre-fix evidence (2026-10-28):** collected before the post-review fixes. It proves
> live activation and the JSONL/stats flow; the final build was re-verified end-to-end on
> 2026-10-29 (`e2e-report.md` §11).

Date: 2026-10-28 17:12 (Asia/Shanghai)
Performed by: the plugin maintainers (final integration)

> Placeholder: `<workspace>` is the `ds-plugins` checkout root. The machine-specific
> absolute path used at run time was replaced for the public release; nothing else in this
> evidence file was changed.

After the isolated verification passed, the bundle was installed into the user's running
`web` profile and activated by live patch reload:

```text
plugin_manager.install_bundle(
  target = "<workspace>/plugins/tool-usage",
  enabled = true,
)
=> { stage: "enable", target: "dsh-plugin-tool-usage", version: "0.1.0", changed: true,
     application: "applied", packageResult.exitCode: 0, warnings: [] }
```

`~/.dsh/profiles/web/package.json` after activation:

```json
{
  "dependencies": {
    "dsh-plugin-tool-usage": "link:<workspace>/plugins/tool-usage"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "dsh-plugin-tool-usage"
      ]
    }
  }
}
```

The running session immediately gained the `tool_usage` tool (its schema appeared in the
next tool-call step). Subsequent tool calls in that session were recorded live.

## Observed live data

`~/.dsh/tool-usage/` mode `0700`, files mode `0600`:

```text
calls-2026-10-28.jsonl
stats.json
```

First two recorded calls (one JSON line each; fields elided for reading):

```json
{"v":1,"seq":1,"tool":"bash","status":"ok","durationMs":34.2,
 "params":{"command":"echo \"live-plugin-check $(date +%s)\" && ls -la ~/.dsh/tool-usage/ 2>&1 | head", "...":"..."},
 "explanation":{"summary":"执行 Shell 命令：echo \"live-plugin-check $(date +%s)\" && ls -la ~/.dsh/tool-usage/ 2>&1 | head"}}

{"v":1,"seq":2,"tool":"bash","status":"ok","durationMs":200.6,
 "params":{"command":"find ~/.dsh <workspace> ... -name \"calls-*.jsonl\" ..."},
 "explanation":{"summary":"执行 Shell 命令：find ~/.dsh <workspace> ..."}}
```

Then the model-facing tool was invoked in the same session and returned the live report:

```text
工具调用统计（范围：当前会话）

总计 3 次调用 / 0 次失败 / 总耗时 1.3s / 平均 445ms / 最慢 1.1s

| 工具 | 次数 | 失败 | 平均 | 最慢 | 最近 |
| --- | --- | --- | --- | --- | --- |
| bash | 3 | 0 | 445ms | 1.1s | 17:12:30 |

最近调用：
1. [17:12:30] bash — 执行 Shell 命令：sleep 1; ls -la ~/.dsh/tool-usage/; ...（1.1s）
2. [17:12:26] bash — 执行 Shell 命令：find ~/.dsh ...（201ms）
3. [17:12:23] bash — 执行 Shell 命令：echo "live-plugin-check ..."（34ms）
```

The run also proved that a call's own record is committed after it settles (the record
for the call that listed `~/.dsh/tool-usage/` appeared immediately after that call), and
that a `tool_usage` query does not count itself because the snapshot is built before its
own result is committed.

## Notes

- The profile dependency is a `link:` to this workspace. Moving/deleting
  `plugins/tool-usage` breaks the profile entry; point the link at the new location or
  remove the bundle.
- Removal: `dsh plugin --profile web remove dsh-plugin-tool-usage` (or disable it from the
  Plugins page).
- This file is evidence for the live path only; the isolated unit/E2E reports remain the
  reproducible verification (`verification/unit-report.md`, `verification/e2e-report.md`).
