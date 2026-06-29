import { Effect, Layer, Match } from "effect";

import { mainLayerFromArgs } from "./caaraApp.ts";
import { runCaaraStatusCli } from "./caaraStatus.ts";

/** Selected top-level Caara command after shallow root dispatch. */
export type CaaraCommandSelection =
  | {
      readonly _tag: "Server";
      readonly args: readonly string[];
    }
  | {
      readonly _tag: "Status";
      readonly args: readonly string[];
    };

/** Selects the top-level Caara command while preserving default server startup. */
export const selectCaaraCommand = ({
  args,
}: {
  readonly args: readonly string[];
}): CaaraCommandSelection =>
  Match.value(args.at(0)).pipe(
    Match.when(
      "status",
      () =>
        ({
          _tag: "Status",
          args: args.slice(1),
        }) satisfies CaaraCommandSelection,
    ),
    Match.orElse(
      () =>
        ({
          _tag: "Server",
          args,
        }) satisfies CaaraCommandSelection,
    ),
  );

/** Runs the selected Caara root command. */
export const caaraCliMain = Effect.fnUntraced(function* ({
  args,
}: {
  readonly args: readonly string[];
}) {
  const command = selectCaaraCommand({ args });
  return yield* Match.valueTags(command, {
    Server: ({ args: serverArgs }) => Layer.launch(mainLayerFromArgs({ args: serverArgs })),
    Status: ({ args: statusArgs }) => runCaaraStatusCli({ args: statusArgs }),
  });
});
