# Technical Direction

## Architecture

One Agent Turn module owns target resolution handoff, portable/Codex identity binding, concurrency,
driver lifecycle, event consumption, terminal assembly, cancellation, and durable turn state.
Transport adapters validate and encode their own inputs. Runtime events fan out internally to a
terminal projection and a separately persisted human-observation projection. Only the viewer can
read the latter, through a capability token.

Responses is prefactored first. CLI plus viewer then proves a diagnostic tracer bullet. Persistence,
resume/concurrency, cancellation, and public CLI contracts harden that seam before installation and
real-driver proofs. Host guidance, MCP, and the Codex driver build on the proven interface.

Current extraction choke point: `mockResponsesProvider/server.ts::handleResponsesCreate` owns
session preparation, concurrency lease, driver resolution/start, event consumption, session
completion/deletion, disconnect cancellation, and SSE projection. Move lifecycle ownership behind
Agent Turn; retain only Responses decode, accepted-error mapping, and SSE encoding in the adapter.
Replace driver/session/concurrency Codex identity coupling with transport-neutral session/origin
types rather than adding parallel optional legacy fields.

Portable starts require service-owned background fibers: request scope must not cancel accepted
work. Consume each runtime stream once and project internally to terminal result plus observation;
never replay or double-consume. Durable turns/observation remain separate from session bindings.

## Slice order

Follow `fp tree CAARA-mixhlklg` dependencies exactly. Independent branches after shared prerequisites
may be sequenced to preserve atomic commits and reduce shared-file conflicts. Each issue gets red
tests, implementation, focused gates, full suite, review/cleanup, docs, completion report, status,
semantic commit, and commit assignment.

## Verification evidence

Record commands and notable artifacts in each fp completion comment. Store temporary logs and smoke
artifacts only under `temp.local/2026-07-12/`. The final PRD comment summarizes all final gates and
independent review findings.
