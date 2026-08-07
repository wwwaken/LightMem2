# GUA-06 Cross-host Acceptance

## Scope

- Independent validator: 观祥
- Maintainer review and corrections: 徐步强
- Providers: committed mock upstreams only
- Secrets/API keys: none

This acceptance checks context rewrite behavior through real adapter gateway
runtimes. The reusable harness belongs to `@lightmem2/host-adapter`; host tests
remain in their owning adapter packages.

## Claude Request Overlay

Command:

```text
pnpm --dir components/adapters/claude-code test
```

The focused acceptance test verifies:

- Five successful full-history requests pass through two distinct Claude
  gateway runtime lifetimes.
- The first runtime handles three requests, closes, and the second runtime
  handles two requests using the same isolated state directory.
- Every successful captured upstream request, not only the final request in a
  phase, removes `EVICT_ME_<uuid>` and preserves `KEEP_ME_<uuid>`.
- Anthropic `tool_use` and `tool_result` cardinality and closure remain valid in
  every successful request.
- Saved characters are derived from the original payload and actual captured
  request bodies.
- The second runtime observes trace evidence written by the first runtime.
- An injected clone failure bypasses eviction, forwards the original request,
  preserves tool closure, and records `analysis_or_apply_error` without raw
  context in the trace.

Claude status: **PASS** for mock non-streaming request-overlay acceptance.

The restart check proves that request overlay remains safe across process
lifetimes and that the isolated state directory is retained. Claude eviction is
currently recomputed from each full request; this test does not claim persistent
rewrite-plan replay or recovery.

## Codex Response-chain Rebase

The Codex adapter already owns streaming, non-streaming, fallback, cooldown,
epoch recovery, journal ordering, malformed closure, and restart tests under:

```text
components/adapters/codex/tests/
```

Command:

```text
pnpm --dir components/adapters/codex test
```

Codex status: **PASS** for committed mock response-chain rebase tests. PR #15
does not add or modify Codex runtime behavior.

## Architecture

- Generic acceptance recording, restart orchestration, sentinel inspection,
  fallback accounting, and multi-protocol closure checks live in
  `@lightmem2/host-adapter`.
- Claude acceptance imports the shared harness through the package API and does
  not import another adapter's source tree.
- Each phase fails if any successful upstream request retains eviction content,
  loses required content, or breaks tool protocol closure.

## Limitations

- Mock providers only; no real Claude or Codex provider is called.
- Claude streaming acceptance remains separate from this non-streaming test.
- Persistent Claude rewrite-plan replay is not implemented or claimed.
