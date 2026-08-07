# Host-Independent Design

LightMem2 separates component packages and host adapters.

From the [components/README.md](https://github.com/zjunlp/LightMem2/blob/main/components/README.md):

- **Component packages**: reusable runtime logic, state and policy layers, host-agnostic contracts
- **Host adapters**: installation and bootstrap, transcript/session bridging, host-specific command and hook surfaces

From the [adapters/README.md](https://github.com/zjunlp/LightMem2/blob/main/components/tokenpilot/adapters/README.md):

**Adapter responsibilities** (keep inside adapter layer):
- Host install and uninstall flow
- Host config mutation
- Request / response hook wiring
- Session and transcript bridging
- Host-specific command registration
- Runtime bootstrap and doctor checks
- Host-owned path resolution

**Shared package responsibilities** (keep in shared packages):
- Runtime contracts in `packages/kernel/`
- Host-neutral execution primitives in `packages/runtime-core/`
- State and policy logic in `packages/layers/*`
- Host abstraction helpers in `packages/host-adapter/`
- Shared command semantics in `packages/product-surface/`
- Standalone product entrypoints in `products/`

From the [HOSTS.md boundary section](https://github.com/zjunlp/LightMem2/blob/main/components/tokenpilot/HOSTS.md):

- `components/tokenpilot/packages/*` — reusable component logic
- `components/tokenpilot/products/*` — shared product surfaces
- `components/tokenpilot/adapters/<host>` — host-specific integration layer

## Related Pages

- [Plugin Directory Structure](/plugin-development/directory-structure) — where to place shared vs. host-specific code
- [Runtime API](/plugin-development/runtime-api) — the shared packages and their public contracts
- [Adapter Architecture](/host-adapter-development/adapter-architecture)
