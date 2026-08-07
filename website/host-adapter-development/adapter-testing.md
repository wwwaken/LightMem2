# Adapter Testing

From [CONTRIBUTING.md](https://github.com/zjunlp/LightMem2/blob/main/CONTRIBUTING.md) and the [Adapter Playbook](https://github.com/zjunlp/LightMem2/blob/main/docs/adapter-playbook.md):

### Type Check

```bash
pnpm typecheck
```

### Adapter Tests

```bash
# OpenClaw adapter
npm --prefix components/tokenpilot/adapters/openclaw test

# Codex adapter
npm --prefix components/tokenpilot/adapters/codex test

# Claude Code adapter
npm --prefix components/tokenpilot/adapters/claude-code test
```

### Doctor Self-Check

Each adapter provides a `doctor` command for runtime self-verification:

```bash
lightmem2 <host> doctor
```

Or per-adapter:

```bash
npm --prefix components/tokenpilot/adapters/openclaw run doctor:openclaw
npm --prefix components/tokenpilot/adapters/codex run doctor:codex
npm --prefix components/tokenpilot/adapters/claude-code run doctor:claude-code
```

Test directories exist at `adapters/<host>/tests/`.

## Related Pages

- [Adapter Architecture](./adapter-architecture.md)
- [Adding a New Host](./adding-new-host.md)
- [Adapter Playbook](https://github.com/zjunlp/LightMem2/blob/main/docs/adapter-playbook.md)
