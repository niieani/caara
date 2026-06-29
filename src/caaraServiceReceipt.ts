import fs from "node:fs/promises";
import path from "node:path";

import { Clock, Effect, Schema } from "effect";

import { caaraServiceLifecycleError, type CaaraServicePaths } from "./caaraServiceArtifacts.ts";

/** Receipt written by `install-service` and consumed by `uninstall-service`. */
const CaaraInstallReceipt = Schema.Struct({
  binaryPath: Schema.String,
  serviceId: Schema.String,
  serviceFilePath: Schema.String,
  installedAtUnixMs: Schema.Finite,
});

/** Runtime type for an install receipt. */
export type CaaraInstallReceipt = typeof CaaraInstallReceipt.Type;

/** Writes the install receipt consumed by uninstall-service. */
export const writeInstallReceipt = Effect.fnUntraced(function* ({
  paths,
}: {
  readonly paths: CaaraServicePaths;
}) {
  const installedAtUnixMs = yield* Clock.currentTimeMillis;
  const receipt = {
    binaryPath: paths.installedBinaryPath,
    serviceId: paths.serviceId,
    serviceFilePath: paths.serviceFilePath,
    installedAtUnixMs,
  } satisfies CaaraInstallReceipt;
  const encodedReceipt = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(receipt).pipe(
    Effect.mapError((cause) =>
      caaraServiceLifecycleError(`Failed to encode install receipt: ${String(cause)}`),
    ),
  );
  yield* Effect.tryPromise({
    try: () => fs.mkdir(path.dirname(paths.receiptPath), { recursive: true }),
    catch: (cause) =>
      caaraServiceLifecycleError(`Failed to create receipt directory: ${String(cause)}`),
  });
  yield* Effect.tryPromise({
    try: () => fs.writeFile(paths.receiptPath, encodedReceipt, "utf8"),
    catch: (cause) =>
      caaraServiceLifecycleError(`Failed to write install receipt: ${String(cause)}`),
  });
});

/** Decodes one install receipt JSON document. */
const decodeInstallReceipt = Effect.fnUntraced(function* (content: string) {
  const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(content).pipe(
    Effect.mapError((cause) =>
      caaraServiceLifecycleError(`Failed to parse install receipt: ${String(cause)}`),
    ),
  );
  return yield* Schema.decodeUnknownEffect(CaaraInstallReceipt)(parsed).pipe(
    Effect.mapError((cause) =>
      caaraServiceLifecycleError(`Invalid install receipt: ${String(cause)}`),
    ),
  );
});

/** Reads the current install receipt. */
export const readInstallReceipt = Effect.fnUntraced(function* ({
  receiptPath,
}: {
  readonly receiptPath: string;
}) {
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(receiptPath, "utf8"),
    catch: (cause) =>
      caaraServiceLifecycleError(`Caara install receipt not found: ${String(cause)}`),
  });
  return yield* decodeInstallReceipt(content);
});
