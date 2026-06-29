import { BunServices } from "@effect/platform-bun";
import { Effect, Match, Option } from "effect";
import { ChildProcess } from "effect/unstable/process";

/** Request sent to the injectable service-manager seam. */
export interface CaaraServiceManagerRequest {
  readonly serviceId: string;
  readonly serviceFilePath: string;
}

/** Service-manager seam used to unload/stop existing user services without tests touching the host. */
export interface CaaraServiceManager {
  readonly unload: (request: CaaraServiceManagerRequest) => typeof Effect.void;
}

/** Runs one command and ignores all command startup/exit failures. */
const runCommandIgnored = (command: readonly string[]) =>
  Effect.gen(function* () {
    const executable = yield* Option.match(Option.fromUndefinedOr(command.at(0)), {
      onNone: () => Effect.die(new Error("Service manager command cannot be empty.")),
      onSome: Effect.succeed,
    });
    const handle = yield* ChildProcess.make(executable, command.slice(1), {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
    yield* handle.exitCode;
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.ignore);

/** Selects the live service-manager unload command for the current host. */
const serviceManagerUnloadCommand = ({
  serviceFilePath,
  serviceId,
}: CaaraServiceManagerRequest): readonly string[] | undefined =>
  Match.value(process.platform).pipe(
    Match.when("darwin", () => ["launchctl", "unload", serviceFilePath] as const),
    Match.when("linux", () => ["systemctl", "--user", "disable", "--now", serviceId] as const),
    Match.orElse(() => undefined),
  );

/** Live service-manager seam for best-effort user service unload/stop. */
export const liveCaaraServiceManager: CaaraServiceManager = {
  unload: (request) =>
    Option.match(Option.fromUndefinedOr(serviceManagerUnloadCommand(request)), {
      onNone: () => Effect.void,
      onSome: runCommandIgnored,
    }),
};
