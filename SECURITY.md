# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

The plugin targets the DSH `>=0.2.0-0 <0.3.0` release line. A DSH release outside
that range may load the plugin but is not supported.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use the
repository's private advisory channel:

<https://github.com/youtaya/dsh-plugins/security/advisories/new>

Include the affected plugin and version, a minimal reproduction, and the impact
you expect. You should get an acknowledgement within a few days. Once a fix is
available, the advisory and a patched release will be published together.

## Scope and threat model

`dsh-plugin-tool-usage` runs inside the agent process and records tool calls. By
design it:

- writes only under its configured `outputDir` (default `$DSH_HOME/tool-usage/`),
  with `0o700` directories and `0o600` files;
- makes no network requests and sends no telemetry;
- redacts parameter values whose **key names** match the configured sensitive-key
  list, and truncates long values before an explanation is built;
- never changes a tool result, `exec.signal`, or call identity, and swallows
  recording failures after one warning.

Known limitations that are documented rather than vulnerabilities:

- **Redaction is key-name based.** A secret embedded in a *value* (for example
  `--token=...` inside a shell command) can still be recorded. Extend
  `redactKeys`, tighten `maxStringChars` / `maxParamChars`, or disable
  persistence (`outputDir: ""` or `persistCalls: false`) for sensitive work.
- **The JSONL log is append-only and retained indefinitely**; there is no
  automatic rotation or retention policy. Treat the data directory as sensitive
  local data and manage its lifecycle yourself.
- **The plugin is installed into a profile and runs with that profile's
  privileges.** Only install bundles you trust; the DSH install flow may run a
  package's build scripts.

Reports that only restate a documented limitation will be closed with a pointer
to this section; anything that bypasses a stated guarantee is in scope.
