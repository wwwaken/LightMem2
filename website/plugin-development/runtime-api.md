# Runtime API

The shared packages under `components/tokenpilot/packages/` provide host-agnostic runtime logic:

| Package | Description |
| :-- | :-- |
| `kernel/` | Shared contracts, events, and runtime-facing types |
| `runtime-core/` | Host-agnostic runtime engine and reduction pipeline |
| `layers/history/` | Canonical state, anchors, lifecycle bookkeeping |
| `layers/decision/` | Reduction and eviction analysis / policy logic |
| `layers/memory/` | Experimental memory layer (distillation and retrieval still in progress) |
| `host-adapter/` | Shared host contracts and path-resolution interfaces |
| `product-surface/` | Shared user-facing command actions and product semantics |

These are the actual packages in the repository.

## Related Pages

- [Plugin Directory Structure](/plugin-development/directory-structure) — where each package lives
- [Host-Independent Design](/plugin-development/host-independent-design) — the architectural rationale
