# Scoped TMPDIR Smoke Evidence

Final run: `temp.local/2026-07-02/claude-scoped-tmpdir-smoke/193652`

Role query params:

```toml
query_params = { additional_directories = "$TMPDIR", allowed_tools = "Write($TMPDIR/caara-panel/smoke/**),Edit($TMPDIR/caara-panel/smoke/**)", permission_mode = "dontAsk" }
```

Prompt:

```text
Create an empty file at /var/folders/q9/_hrpcv195p3b_xf77qxhfxq40000gp/T/caara-panel/smoke/caara-claude.md using the Write tool only. Do not use Bash. Do not write anywhere else. Reply only with the absolute path you created.
```

Created file:

```text
/var/folders/q9/_hrpcv195p3b_xf77qxhfxq40000gp/T/caara-panel/smoke/caara-claude.md
size=0
```

Relay log evidence:

```text
TargetSelected rawDriverOptions:
permission_mode=dontAsk
allowed_tools=Write($TMPDIR/caara-panel/smoke/**),Edit($TMPDIR/caara-panel/smoke/**)
additional_directories=$TMPDIR

TurnSucceeded
```

Claude transcript evidence:

```text
tool_use name=Write
file_path=/var/folders/q9/_hrpcv195p3b_xf77qxhfxq40000gp/T/caara-panel/smoke/caara-claude.md
content=""
```

No `PermissionDenied` record appeared for the final turn.
