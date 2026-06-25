# Driver options override Codex advisory signals

Caara will decode Codex request and metadata settings such as `reasoning.effort` and sandbox
metadata into advisory driver input, not global Caara policy. If a driver parses a query option for
the same concern, such as Claude `effort=max`, that driver option always supersedes Codex-provided
effort, sandbox metadata, and driver defaults. Sandbox metadata is normalized before driver dispatch
to the coarse `none` or `enforced` posture because Codex exposes platform-specific sandbox tags
rather than a portable permission model; each driver owns any mapping from that posture to its
external harness.
