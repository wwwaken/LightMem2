# Runtime Modes

TokenPilot provides three runtime modes: **conservative**, **normal**, and **aggressive**. Each is a preset that configures the stabilizer, reduction, and eviction subsystems. Switch modes at any time without restarting.

## Mode Comparison

| Behavior | Conservative | Normal | Aggressive |
| :-- | :-- | :-- | :-- |
| **Stable Prefix** | On | On | On |
| **Stabilizer target** | Developer | Developer | User |
| **Reduction** | Light | Balanced | Strong |
| **Reduction trigger** | 4000 chars | 2200 chars | 1400 chars |
| **Max tool chars** | 1800 | 1200 | 900 |
| **Eviction** | Off | Off | On |
| **Risk of signal loss** | Very low | Low | Moderate |
| **Token savings** | Moderate | High | Maximum |

## Conservative Mode

For **safety-critical sessions** where you cannot afford to lose any context.

```bash
lightmem2 mode conservative
```

- Stabilizer rewrites context into cache-stable form but keeps it developer-visible
- Reduction applies light trimming only — removes truly redundant output
- Eviction is disabled — full history is always available

## Normal Mode

The **default and recommended mode** for most sessions.

```bash
lightmem2 mode normal
```

- Stabilizer rewrites context and attaches dynamic content at the developer level
- Reduction applies balanced trimming — removes noise while keeping signal
- Eviction is **disabled** by default — for most sessions, reduction alone is sufficient

## Aggressive Mode

For **maximum savings** when you're willing to trade some context completeness.

```bash
lightmem2 mode aggressive
```

- Stabilizer rewrites context and attaches dynamic content at the user level (further from the model)
- Reduction applies strong trimming — may discard borderline-useful output
- Eviction is enabled with lower thresholds — older context is dropped sooner

## Switching Modes Mid-Session

You can change modes at any time — no restart needed:

```bash
# Per-host (OpenClaw supports all three modes)
lightmem2 openclaw mode aggressive

# Codex and Claude Code only support conservative and normal
lightmem2 codex mode conservative
lightmem2 codex mode normal
lightmem2 claude-code mode conservative
lightmem2 claude-code mode normal

# Or inside OpenClaw session
/lightmem2 mode aggressive
```

The new mode takes effect on the next turn.

## Next

- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — how stabilization works
- [Context Reduction](/plugin-catalog/tokenpilot/context-reduction) — the trimming pipeline
- [Context Eviction](/plugin-catalog/tokenpilot/context-eviction) — lifecycle-aware pruning
