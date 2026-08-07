# Context Reduction

Context reduction **trims oversized tool output** before it pollutes later turns. Large tool responses can dominate the context window without adding proportional value.

## Reduction Pipeline

TokenPilot's reduction runs a pipeline of passes on each tool result:

| Pass | Description | Configurable |
| :-- | :-- | :-- |
| `readStateCompaction` | Compact stale or superseded read results before they bloat later context | Yes |
| `toolPayloadTrim` | Trim oversized tool payloads | Yes |
| `htmlSlimming` | Compact noisy HTML content | Yes |
| `execOutputTruncation` | Truncate long execution outputs | Yes |
| `agentsStartupOptimization` | Apply agent startup optimization pass | Yes |

## Controlling Reduction

```bash
# Toggle reduction
lightmem2 reduction on
lightmem2 reduction off

# Switch mode
lightmem2 reduction mode balanced

# Enable/disable specific passes
lightmem2 reduction pass toolPayloadTrim off
lightmem2 reduction pass toolPayloadTrim on

# Check current status
lightmem2 reduction status
```

## Next

- [Context Eviction](/plugin-catalog/tokenpilot/context-eviction) — pruning old context
- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — cache optimization
- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — see all metrics
