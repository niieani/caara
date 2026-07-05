# Effect Logger Zero Window CPU Fix

## Brief

Caara user service consumes high idle CPU because its Effect file logger uses `batchWindow:
"0 millis"`. Effect v4 `Logger.batched` treats zero as an immediate sleep and loops forever, even
with an empty buffer.

## Goal

Patch local `effect@4.0.0-beta.85` so nonpositive file logger batch windows do not create tight
background loops, then update Caara to use `Logger.toFile` default batching.

## Scope

In:
- Existing Bun patched dependency for `effect@4.0.0-beta.85`.
- Caara app logging setup.
- Focused regression for zero-window file logger idle behavior.
- Manual idle CPU verification of source Caara process and installed service.

Out:
- Publishing upstream Effect change.
- Reworking Caara logging architecture.
- Changing Bun HTTP idle timeout behavior.

## Criteria

- Regression fails before patch: zero-window file logger idles under a CPU-time ceiling.
  Verifier: focused Vitest file.
- Patched Effect handles `batchWindow: "0 millis"` without busy-looping.
  Verifier: focused Vitest file plus manual source-process CPU probe.
- Caara no longer passes explicit zero file-log batch window.
  Verifier: source review / grep.
- Existing app settings test still passes.
  Verifier: focused Vitest files.

## Execution

Small direct fix. TDD first, then patch dependency, then Caara cleanup and validation.
