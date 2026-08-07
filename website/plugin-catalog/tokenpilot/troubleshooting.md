# TokenPilot Troubleshooting

Common problems, symptoms, and fixes for TokenPilot.

## Quick Diagnostic

Always start with:

```bash
lightmem2 doctor
lightmem2 status
```

These two commands answer most questions about whether TokenPilot is running correctly.

## Install Problems

### "Command not found: lightmem2"

**Cause**: `~/.local/bin` is not on your `PATH`.

**Fix**:

```bash
export PATH="$HOME/.local/bin:$PATH"
# Add to ~/.bashrc or ~/.zshrc to make permanent
```

### "pnpm: command not found" or pnpm errors

**Cause**: pnpm not installed or corepack not enabled.

**Fix**:

```bash
corepack enable
pnpm install
```

## Runtime Problems

### "No TokenPilot session stats yet"

The session hasn't accumulated enough turns for statistics. Run a few more turns, then check again. This is normal for brand-new sessions.

### "proxy healthy: no" (Codex / Claude Code)

**Fix**:

```bash
# Codex
tokenpilot-codex status
tokenpilot-codex start

# Claude Code — open a new session so SessionStart fires
# Or restart Claude Code
```

## Report a Bug

File an issue on [GitHub](https://github.com/zjunlp/LightMem2/issues).
