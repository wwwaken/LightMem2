# Data and Permissions

LightMem2 runs entirely on your machine. Understanding what data is stored, where, and what leaves your machine is important.

## What Data Is Stored Locally

| Data | Location | Purpose |
| :-- | :-- | :-- |
| Configuration files | `~/.openclaw/`, `~/.codex/`, `~/.claude/` | Plugin and host settings |
| Session metrics | In-memory (current session only) | Token counts, cache stats, cost |
| Backup files | `*.tokenpilot.bak` alongside originals | Recovery on uninstall |
| CLI state | `~/.lightmem2/` (if created) | Default host, pinned session |

## What Is NOT Stored

- **Message content**. LightMem2 processes messages in flight but does not persist them.
- **API keys**. Never read, stored, or forwarded.
- **Personal paths or server addresses**. Only config file paths explicitly set via env vars are used.

## What Leaves Your Machine

**Nothing by default.** LightMem2's core runtime and plugins run locally. No telemetry, no analytics, no cloud service.

The only network traffic is what your agent host already sends to the model API (e.g., Anthropic, OpenAI). LightMem2 may modify the context sent in those requests (that's its job), but it does not add new external calls.

## Next

- [Uninstall and Rollback](/user-guide/uninstall-and-rollback) — complete cleanup guide
- [Security](/project/security) — security policy
