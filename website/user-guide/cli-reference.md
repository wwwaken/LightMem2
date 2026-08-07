# CLI Reference

The `lightmem2` CLI is the unified command interface across all hosts. This page documents every command.

## Global Commands

Commands that work without specifying a host (uses the default host set by `lightmem2 use`).

```bash
lightmem2 report              # Latest session report across hosts
lightmem2 visual              # Open visual inspector (shared, switchable)
lightmem2 use <host>          # Set default host
lightmem2 use <host> session <id>  # Pin default session
lightmem2 context             # Show default host, pinned session, config
lightmem2 --help              # Top-level help
```

## OpenClaw Commands

### In-Session (`/lightmem2`)

```text
/lightmem2 status             # Current plugin and runtime status
/lightmem2 report             # Session token, cache, and cost report
/lightmem2 doctor             # Full integration self-check
/lightmem2 visual             # Open visual inspector
/lightmem2 mode <mode>        # Switch: conservative | normal | aggressive
/lightmem2 stabilizer target <developer|user>
/lightmem2 reduction mode <light|balanced>
/lightmem2 eviction <on|off>
/lightmem2 settings details <on|off>
/lightmem2 help               # List all commands
```

### Standalone CLI

```bash
lightmem2 openclaw status
lightmem2 openclaw report
lightmem2 openclaw doctor
lightmem2 openclaw visual
lightmem2 openclaw mode <mode>
lightmem2 openclaw session <id> report
lightmem2 openclaw stabilizer <on|off>
lightmem2 openclaw stabilizer target <developer|user>
lightmem2 openclaw reduction <on|off>
lightmem2 openclaw reduction mode <light|balanced>
lightmem2 openclaw reduction pass toolPayloadTrim <off>
lightmem2 openclaw eviction <on|off>
lightmem2 openclaw help
```

## Codex Commands

```bash
lightmem2 codex status
lightmem2 codex report
lightmem2 codex doctor
lightmem2 codex visual
lightmem2 codex session <id> report
lightmem2 codex mode <conservative|normal>
lightmem2 codex stabilizer <on|off>
lightmem2 codex stabilizer target <developer|user>
lightmem2 codex reduction <on|off>
lightmem2 codex reduction mode <light|balanced>
lightmem2 codex reduction pass toolPayloadTrim <off>
lightmem2 codex reduction status
lightmem2 codex help
```

Manual proxy control:

```bash
tokenpilot-codex status
tokenpilot-codex start
```

## Claude Code Commands

```bash
lightmem2 claude-code status
lightmem2 claude-code report
lightmem2 claude-code doctor
lightmem2 claude-code visual
lightmem2 claude-code session <id> report
lightmem2 claude-code mode <conservative|normal>
lightmem2 claude-code stabilizer <on|off>
lightmem2 claude-code stabilizer target <developer|user>
lightmem2 claude-code reduction <on|off>
lightmem2 claude-code reduction mode <light|balanced>
lightmem2 claude-code reduction pass toolPayloadTrim <off>
lightmem2 claude-code reduction status
lightmem2 claude-code help
```

## Next

- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — using the browser dashboard
- [Logs and Diagnostics](/user-guide/logs-and-diagnostics) — finding and reading logs
