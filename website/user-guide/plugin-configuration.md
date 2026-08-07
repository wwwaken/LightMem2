# Plugin Configuration

Each plugin exposes configuration that can be tuned for your needs.

## Changing Configuration

### Via CLI

```bash
# Mode presets
lightmem2 mode conservative
lightmem2 mode normal
lightmem2 mode aggressive

# Individual settings
lightmem2 stabilizer target developer
lightmem2 reduction mode balanced
lightmem2 eviction on
```

### Via Config File

Edit the plugin config file directly:

```bash
# OpenClaw: ~/.openclaw/openclaw.json
# Codex:    ~/.codex/tokenpilot.json
# Claude:   ~/.claude/tokenpilot.json
```

## Next

- [TokenPilot Configuration](/plugin-catalog/tokenpilot/configuration) — TokenPilot-specific settings
- [Configuration Model](/platform-concepts/configuration-model) — platform-level config
