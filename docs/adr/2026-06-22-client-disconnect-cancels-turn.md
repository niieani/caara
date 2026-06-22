# Client disconnect cancels the turn

Caara will treat a Codex Responses stream disconnect as cancellation of the in-flight turn and ask
the selected driver to cancel. Drivers own the cancellation mechanism and must report whether the
external session remains reusable. Turn abandonment means Caara stops relaying while the external
harness may continue running; it is not safe cancellation by itself, and a driver must mark the
session not reusable when abandoned work can create hidden durable context.
