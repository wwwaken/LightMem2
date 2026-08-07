# Packaging Plugins

TokenPilot uses a **pnpm workspace** within the LightMem2 monorepo.

Build commands from [CONTRIBUTING.md](https://github.com/zjunlp/LightMem2/blob/main/CONTRIBUTING.md):

| Command | Purpose |
| :-- | :-- |
| `pnpm install` | Install all workspace dependencies |
| `pnpm build` | Build all shared packages in the workspace |
| `pnpm lightmem2:build` | Build the standalone CLI surface |
| `pnpm lightmem2:install` | Install the CLI entrypoint globally |

Adapter install scripts:

| Host | Install Command |
| :-- | :-- |
| OpenClaw | `pnpm component:install:tokenpilot:openclaw` |
| Codex CLI | `npm --prefix components/tokenpilot/adapters/codex run install:codex` |
| Claude Code | `npm --prefix components/tokenpilot/adapters/claude-code run install:claude-code` |

## Related Pages

- [Testing Plugins](/plugin-development/testing) — verifying builds
- [Build Your First Plugin](/plugin-development/build-your-first-plugin) — getting started
