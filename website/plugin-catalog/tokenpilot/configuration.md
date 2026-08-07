# TokenPilot Configuration

TokenPilot settings control how aggressively it manages context. All settings have sensible defaults — you can start without changing anything.

## Core Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `enabled` | `true`, `false` | `true` | Master on/off switch |
| `mode` | `conservative`, `normal`, `aggressive` | `normal` | Preset that controls all sub-policies |
| `logLevel` | `debug`, `info`, `warn`, `error` | `info` | How much detail in logs |

## Mode Presets

Each mode is a preset that configures stabilizer, reduction, and eviction behavior:

| Mode | Stabilizer | Reduction | Eviction |
| :-- | :-- | :-- | :-- |
| `conservative` | On (developer target) | Light | Off |
| `normal` | On (developer target) | Balanced | Off |
| `aggressive` | On (user target) | Strong | On (earlier threshold) |

See [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) for detailed behavior.

## Stabilizer Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `stabilizer.enabled` | `true`, `false` | `true` | Enable stable-prefix rewriting |
| `stabilizer.target` | `developer`, `user` | `developer` | Which message role gets the dynamic content |

## Reduction Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `reduction.enabled` | `true`, `false` | `true` | Enable context reduction |
| `reduction.mode` | `light`, `balanced` | `balanced` | How aggressively to trim |
| `reduction.pass.toolPayloadTrim` | `true`, `false` | `true` | Enable tool output trimming |

## Eviction Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `eviction.enabled` | `true`, `false` | `false` (off by default) | Enable context eviction |
| `eviction.threshold` | Token count | Mode-dependent | When to start evicting |

## Changing Settings

### Via CLI

```bash
# Change mode (applies the preset)
lightmem2 mode aggressive

# Toggle individual features
lightmem2 stabilizer off
lightmem2 reduction mode light
lightmem2 eviction on
```

## Next

- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — understand each mode in detail
- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — how stabilization works
- [CLI Reference](/user-guide/cli-reference) — all commands
