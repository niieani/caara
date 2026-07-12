# ADR 0015: Portable CLI contract is versioned

## Status

Accepted

## Decision

- Every public `caara agent` result carries `schemaVersion: 1`.
- Human output and process exit status derive from the same decoded typed result as JSON output.
- Human output is the default; `--json` emits one compact JSON value.
- Start requires one prompt source, an explicit target, and an absolute existing working directory.
- Driver options use repeated `--option name=value`; duplicate or malformed names fail before HTTP.
- Prompt text is preserved verbatim and bounded to 1 MiB of UTF-8 at both CLI and service boundaries.
- Errors use closed kinds rather than message parsing. Nonterminal accepted/working results have distinct
  nonzero statuses so shell callers cannot mistake them for completion.

## Exit statuses

| Status | Meaning |
| ---: | --- |
| 0 | completed |
| 10 | accepted |
| 11 | working |
| 20 | failed |
| 21 | cancelled |
| 64 | invalid request |
| 66 | unknown turn or session |
| 69 | service unavailable |
| 70 | target failure |
| 75 | concurrency or cancellation conflict |

