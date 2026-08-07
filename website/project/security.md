# Security

## Local-Only Architecture

LightMem2 runs entirely on your machine. All processing is local. The only network traffic is what your agent host already sends to the model API. LightMem2 does not add new external calls.

- No API keys are read, stored, or forwarded.
- No telemetry or analytics is collected.

## Backups Before Changes

Before modifying existing configuration files, LightMem2 creates `.tokenpilot.bak` backups.

## Vulnerability Reporting

Report concerns via [GitHub Issues](https://github.com/zjunlp/LightMem2/issues). A formal security policy has not yet been published.
