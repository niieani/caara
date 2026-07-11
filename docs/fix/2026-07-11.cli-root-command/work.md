# Design

`caaraCliMain` becomes `Command.runWith(caaraCommand, { version })`. `caaraCommand` is a root server
command with shared settings flags and six real Effect subcommands. Each handler forwards a
canonical argv representation into existing domain runners; this preserves their injectable APIs
while removing manual dispatch from the executable boundary.

Action flags terminate inside Effect CLI before handlers. No mutable `Ref` participates in root
dispatch, so help/version cannot be mistaken for missing settings. Package JSON supplies embedded
release version. Flag and command descriptions become the source for help and completions.

The internal settings parser remains for reusable command/domain APIs but receives only serialized
settings args from successful handlers. Its raw pre-validation no longer needs to recognize global
action flags.

`copyInstalledBinary` treats source and destination identity as an explicit idempotent install
outcome. It skips only the redundant copy, then still enforces executable permissions and writes
config/service/receipt/roles. Path identity must be resolved before comparison; different paths keep
the strict copy/error behavior.
