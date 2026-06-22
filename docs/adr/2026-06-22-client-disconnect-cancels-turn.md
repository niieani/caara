# Client disconnect cancels the turn

Caara will treat a Codex Responses stream disconnect as cancellation of the in-flight turn and ask
the selected driver to cancel. Drivers own the safe cancellation mechanism; when a driver cannot
cancel safely, it should log a warning and let the external turn finish detached rather than letting
Caara blindly kill a process or discard a session.
