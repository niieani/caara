# Antigravity effort selects model variant

Antigravity installed roles will target base Caara model-family slugs such as
`agy/gemini-3.5-flash` rather than separate Low, Medium, or High role files. The Antigravity driver
will map the slug plus Codex advisory effort to the closest Antigravity `agy --model` display-name
variant for that family, with an explicit Antigravity `effort` driver option taking precedence in
the same way Claude driver options override Codex advisory signals today.

This keeps global Codex role count manageable and moves effort selection to the driver boundary
where Caara already handles Codex advisory signals. The current driver lacks this `effort` option and
mapping; release implementation should add it before installing Antigravity global roles.

Mapping uses the closest supported Antigravity variant: Gemini 3.5 Flash maps `low`, `medium`, and
`high` exactly and maps `xhigh` to High; Gemini 3.1 Pro maps `low` to Low and maps `medium`, `high`,
and `xhigh` to High; GPT-OSS 120B always maps to Medium; Claude Sonnet 4.6 and Claude Opus 4.6
always map to Thinking.

Initial slug mappings are: `gemini-3.5-flash` to `Gemini 3.5 Flash (...)`,
`gemini-3.1-pro` to `Gemini 3.1 Pro (...)`, `claude-sonnet-4.6` to
`Claude Sonnet 4.6 (Thinking)`, `claude-opus-4.6` to `Claude Opus 4.6 (Thinking)`, and
`gpt-oss-120b` to `GPT-OSS 120B (Medium)`.

Unknown Antigravity model specifiers remain opaque pass-through values for `agy --model` and do not
receive effort mapping. This preserves custom model use without making Caara a full Antigravity model
catalog.
