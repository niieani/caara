# Installed Codex roles are safe by default

Generated installed Codex roles will not embed smoke-only TMPDIR permissions, broad tool grants, or
dangerous bypass options by default. A role-generation `--yolo` option may generate Caara-owned roles
with dangerous driver bypass settings for users who explicitly choose that posture, but the default
global role surface remains minimal and relies on driver defaults plus Codex advisory effort and
sandbox signals.

`--yolo` is coupled to Caara's process-level dangerous gate. `install-service --yolo` writes service
configuration that enables dangerous skip permissions and installs bypass roles; standalone
role-generation with `--yolo` must fail if the selected Caara service config does not enable the same
gate.

During generated-role updates, yolo mode owns dangerous permission query params. Caara preserves
unrelated user-customized `query_params`, but it sets or removes driver-specific bypass keys to
match the current yolo mode.

Yolo roles set permission-bypass options only: Claude uses
`permission_mode=bypassPermissions`, and Antigravity uses
`dangerously_skip_permissions=true`. Yolo does not force Antigravity `sandbox=false`; sandbox still
follows the normal Codex advisory/default behavior unless the user customizes that query param.
