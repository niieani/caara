# Diagnostic driver is always available

Caara will include a first-class diagnostic driver that emits predefined runtime events for
smoke-testing Caara core behavior through Codex without involving Claude or another external
agent harness. Because Caara is designed to run on localhost rather than as a public endpoint, this
driver is always available instead of being gated behind production packaging flags.
Diagnostic scenarios are selected through the diagnostic driver's external model specifier, such as
`diagnostic/basic` or `diagnostic/fails-after-partial`; query parameters tune scenario details like
text, delays, chunk counts, or activity-commentary toggles.
The initial scenario set is `basic`, `reasoning`, `activity`, `fails-before-output`,
`fails-after-partial`, `hangs-until-cancel`, `recovery`, and `echo`. The `hangs-until-cancel`
scenario is especially important because it validates both Caara cancellation handling and Codex
client behavior if Codex changes how it cancels subagent response streams.
The same held-open scenario should also support overlapping-turn smokes, proving Caara rejects a
second turn for the same session key while allowing independent turns for other threads.
Diagnostic scenarios participate in session binding behavior when that makes the smoke meaningful:
successful scenarios use a simple diagnostic resume cursor; failure-before-output and
failure-after-partial do not complete the binding; `hangs-until-cancel` uses a query parameter to
choose whether cancellation reports the binding reusable; and `recovery` deliberately exercises the
lost-continuity recovery path.
Diagnostic driver work should be tracked as its own Caara capability, not as temporary Claude SDK
remediation scaffolding.
Diagnostic scenarios are hardcoded typed scenarios for v1, with query parameters limited to bounded
tuning fields such as text, delay, chunk count, activity toggle, and cancellation reusability. The
diagnostic driver should not accept arbitrary JSON event scripts or a freeform runtime-event DSL.
Each scenario should have markdown runbook instructions for the Codex agent executing the smoke;
the existing smoke-testing docs should link to or incorporate those runbooks.
The existing simulator driver is superseded by this diagnostic driver and should be migrated or
removed rather than kept as a parallel undocumented test path.
