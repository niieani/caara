# Session directory lives in user state

Caara will persist session bindings under a user-state directory such as
`$XDG_STATE_HOME/caara/sessions`, not inside the project repository. Session bindings may contain
external agent session ids and mutable runtime state, so they must survive Caara restarts without
becoming source-controlled project artifacts.
