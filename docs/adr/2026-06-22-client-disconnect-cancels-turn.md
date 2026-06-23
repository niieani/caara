# Client disconnect cancels the turn

Caara will treat a Codex Responses stream disconnect as cancellation of the in-flight turn and ask
the selected driver to cancel. Drivers own the cancellation mechanism and must report whether the
external session remains reusable. Turn abandonment means Caara stops relaying while the external
harness may continue running; it is not safe cancellation by itself, and a driver must mark the
session not reusable when abandoned work can create hidden durable context.
For SDK-backed drivers, the session is reusable only when the SDK reports a clean interrupted or
cancelled terminal outcome; ambiguous timeout or stream failure forces query close and non-reusable
binding cleanup.

For the Antigravity CLI driver, cancellation terminates the spawned `agy` process and stops the
transcript tailer. Once a prompt has been sent to an Antigravity conversation, an interrupted turn
may have already mutated the durable conversation transcript, so the driver must not report the
session reusable unless it can prove the turn ended before any external conversation mutation. On
ambiguous cancellation, Caara should clean up the binding and use the lost-continuity recovery path
on the next turn.
