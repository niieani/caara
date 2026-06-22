# Overlapping turns are rejected

Caara will allow only one in-flight turn for a session key and will reject any overlapping turn for
the same external agent kind and Codex `threadId`. Concurrent turns for one Codex subagent should
not occur in normal Codex behavior, and rejecting plus logging the anomaly is safer than queuing or
driving a single external agent session concurrently.
