# Managing Plugins

Plugins are the core unit of functionality in LightMem2. This page covers how to list and manage installed plugins.

## List Installed Plugins

```bash
lightmem2 status
```

Shows all installed plugins and their state.

## Switching the Default Host

```bash
lightmem2 use openclaw
lightmem2 use codex
lightmem2 use claude-code
```

This sets the default host for hostless commands like `lightmem2 report`.

## Pinning a Session

```bash
lightmem2 use codex session <session-id>
```

Subsequent `lightmem2 report` and `lightmem2 visual` commands will target this session.

## Checking Current Context

```bash
lightmem2 context
```

Shows:
- Current default host
- Pinned session ID
- Config target

## Next

- [Managing Plugins](/user-guide/managing-plugins)
- [Plugin Configuration](/user-guide/plugin-configuration)
- [CLI Reference](/user-guide/cli-reference)
