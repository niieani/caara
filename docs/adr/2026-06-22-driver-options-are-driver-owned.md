# Driver options are driver-owned

Caara will not define global driver option names, shared option enums, or prefixed option
namespaces. Provider query parameters are scoped by the selected external agent kind from the model
specifier, and each driver ships its own option schema; this allows option names such as `effort` to
carry harness-specific values like Claude Code's `max` or `ultracode` without forcing them into a
Codex-shaped scale.
