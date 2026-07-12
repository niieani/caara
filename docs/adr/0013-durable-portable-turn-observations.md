# ADR 0013: Durable portable turns and capability observations

## Status

Accepted.

## Decision

Portable Agent state uses two schema-versioned stores below the Caara state directory:
`portable-turns/<turn-id>.json` contains Agent-safe identity and state; and
`portable-observations/<capability>.json` contains human activity plus the capability secret.
Neither store is part of `sessions/`, and observation data is never an external-session recovery
input.

Turn state progresses from `Accepted` to `Working`, then exactly once to `Completed`, `Failed`, or
`Cancelled`. Terminal records reject later writes. Completed turn and observation records survive
service restart. A recovered nonterminal record remains coarse `Working`; Caara does not infer that
the external agent resumed from observation content.

Records receive a fixed expiry when accepted. Default retention is seven days; operators may set a
positive finite `CAARA_PORTABLE_RETENTION_MILLIS`. Cleanup uses Effect `Clock`, visits only
`portable-turns/` and `portable-observations/`, and cannot delete `sessions/`. Expired and unknown
capabilities both produce the same generic HTTP 404 response.

## Consequences

Capability URLs remain bearer secrets and must not enter relay logs or session bindings. Filesystem
state is intentionally simple for the prototype; a later storage backend must preserve directory
isolation, immutable terminal transitions, fixed expiry, and non-enumerable capability lookup.
