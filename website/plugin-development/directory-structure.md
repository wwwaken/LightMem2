# Plugin Directory Structure

The TokenPilot reference component is organized as follows.

## Top-Level Layout

```text
components/tokenpilot/
├── adapters/
│   ├── openclaw/         # OpenClaw adapter, hooks, commands, embedded proxy
│   ├── codex/            # Codex CLI adapter, hooks, provider install, local proxy
│   └── claude-code/      # Claude Code adapter, gateway routing, MCP recovery
├── products/
│   ├── cli/              # Shared lightmem2 CLI surface
│   └── mcp/              # Shared memory_fault_recover MCP server
├── README.md
└── packages/
    ├── host-adapter/     # Shared host contracts and host-specific path/state interfaces
    ├── product-surface/  # Shared user-facing command actions and product semantics
    ├── runtime-core/     # Host-agnostic runtime engine and reduction pipeline
    ├── kernel/           # Shared contracts, events, and runtime-facing types
    └── layers/
        ├── history/      # Canonical state, anchors, lifecycle bookkeeping
        ├── decision/     # Reduction and eviction analysis / policy logic
        └── memory/       # Experimental memory layer still under active development
```

## Directory Purpose

### `packages/` — Shared Runtime Logic

| Directory | Purpose |
| :-- | :-- |
| `kernel/` | Shared contracts, events, and runtime-facing types |
| `runtime-core/` | Host-agnostic runtime engine and reduction pipeline |
| `layers/history/` | Canonical state, anchors, lifecycle bookkeeping |
| `layers/decision/` | Reduction and eviction analysis / policy logic |
| `layers/memory/` | Experimental memory layer still under active development |
| `host-adapter/` | Shared host contracts and path-resolution interfaces |
| `product-surface/` | Shared user-facing command actions and product semantics |

### `adapters/` — Host-Specific Integration

| Directory | Purpose |
| :-- | :-- |
| `adapters/<host>/` | Host install/uninstall flow, config mutation, request/response hooks, session/transcript bridging, host-specific commands, runtime bootstrap, doctor checks |

### `products/` — Shared Entrypoints

| Directory | Purpose |
| :-- | :-- |
| `products/cli/` | Standalone CLI surface for hosts without native slash commands |
| `products/mcp/` | Shared MCP server surface (e.g., `memory_fault_recover`) |

The adapter internal structure is described in [adapters/README.md](https://github.com/zjunlp/LightMem2/blob/main/components/tokenpilot/adapters/README.md).

## Related Pages

- [Runtime API](/plugin-development/runtime-api) — the shared packages and their public surfaces
