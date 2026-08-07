# Sessions

A **session** is one continuous conversation with your agent host. TokenPilot tracks per-session metrics and applies context management within each session.

## Viewing Session Info

```bash
# Current session summary
lightmem2 report

# Specific session
lightmem2 codex session <session-id> report
lightmem2 claude-code session <session-id> report
```

## Pinning a Session

Pin a session to make it the default for subsequent commands:

```bash
lightmem2 use codex session <session-id>
lightmem2 use claude-code session <session-id>
```

Now `lightmem2 report` and `lightmem2 visual` will use the pinned session.

## Session Reports

The report shows metrics accumulated over the session:

- Total input tokens
- Cache read vs. cache miss
- Output tokens
- Estimated cost

## Next

- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — understanding reports
- [CLI Reference](/user-guide/cli-reference) — session commands
- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — browser dashboard
