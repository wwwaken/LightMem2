# Logs and Diagnostics

How to find logs and use diagnostic tools.

## Quick Diagnostic Commands

Always start with these three:

```bash
lightmem2 doctor    # Integration health check
lightmem2 status    # Current state
lightmem2 report    # Session metrics
```

These answer 90% of "is it working?" questions.

## Log Locations

| Host | Log Location | Notes |
| :-- | :-- | :-- |
| OpenClaw | `~/.openclaw/logs/gateway.log` | Gateway log confirmed in source |

## Next

- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common problems and solutions
- [Uninstall and Rollback](/user-guide/uninstall-and-rollback) — clean removal
