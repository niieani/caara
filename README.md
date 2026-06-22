# julian

Signal automation bot built on Bun + TypeScript + Effect v4.

To install dependencies:

```bash
bun install
```

To run the supervised long-running Signal service:

```bash
bun run start
```

To run the service child directly with hot reload during development:

```bash
bun --hot src/service.ts
```

To include raw Signal JSON-RPC request/response lines in diagnostics:

```bash
JULIAN_LOG_LEVEL=Debug bun start:service
```

The dockerized signal-cli daemon writes verbose scrubbed logs to `data/signal/signal-cli.log`.

To refresh the vendored signal-cli JSON schemas:

```bash
bun run schemas:signal-cli:update
```

To refresh the vendored Codex app-server client schemas:

```bash
bun run schemas:codex-app-server:update
```

To refresh the generated Julian service config editor schema:

```bash
bun run schemas:service-config:update
```
