# Effect CLI

- Model the executable boundary as one `Command.withSubcommands` tree. Manual pre-dispatch hides
  subcommands from help, completions, validation, and suggestions.
- `--help`, `--version`, and `--completions` are action flags: Effect handles them and intentionally
  skips the selected command handler. Never infer parse failure from handler-owned state remaining
  empty after `Command.runWith`.
- `CliOutput.renderTable` width caps must retain a separator when the left cell reaches/exceeds the
  cap; otherwise long command names concatenate with descriptions. Project Effect patch covers this.
