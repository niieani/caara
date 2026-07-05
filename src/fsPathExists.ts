import fs from "node:fs/promises";

import { Effect } from "effect";

/**
 * Returns whether one filesystem path exists.
 * Probe failures resolve to false in the success channel; this helper never fails.
 */
export const pathExists = Effect.fnUntraced(function* ({
  targetPath,
}: {
  readonly targetPath: string;
}) {
  return yield* Effect.promise(() =>
    fs
      .access(targetPath)
      .then(() => true)
      .catch(() => false),
  );
});
