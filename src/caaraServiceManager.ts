import { BunServices } from "@effect/platform-bun";
import { Effect, Match, Option } from "effect";
import { ChildProcess } from "effect/unstable/process";

import type { CaaraServicePlatform } from "./caaraServiceArtifacts.ts";

/** Request sent to the injectable service-manager seam. */
export interface CaaraServiceManagerRequest {
  readonly serviceId: string;
  readonly serviceFilePath: string;
}

/** Service-manager seam used to unload/stop existing user services without tests touching the host. */
export interface CaaraServiceManager {
  readonly start: (request: CaaraServiceManagerRequest) => typeof Effect.void;
  readonly statusHint: (request: CaaraServiceManagerRequest) => string;
  readonly unload: (request: CaaraServiceManagerRequest) => typeof Effect.void;
}

/** Options used to select service start commands without touching the host. */
export interface ServiceManagerStartCommandsOptions {
  readonly platform: CaaraServicePlatform;
  readonly request: CaaraServiceManagerRequest;
  readonly userId: string;
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

/** Returns the current numeric user id for launchd's per-user service domain. */
const currentUserId = (): string =>
  String(
    Option.getOrThrowWith(
      Option.fromUndefinedOr(process.getuid),
      () => new Error("process.getuid is required for Caara service manager commands."),
    )(),
  );

/** Selects platform-specific commands that enable and start a Caara user service. */
export const serviceManagerStartCommands = ({
  platform,
  request,
  userId,
}: ServiceManagerStartCommandsOptions): readonly (readonly string[])[] =>
  Match.value(platform).pipe(
    Match.when("darwin", () => [
      ["launchctl", "bootstrap", `gui/${userId}`, request.serviceFilePath] as const,
      ["launchctl", "enable", `gui/${userId}/${request.serviceId}`] as const,
      ["launchctl", "kickstart", "-k", `gui/${userId}/${request.serviceId}`] as const,
    ]),
    Match.when("linux", () => [
      ["systemctl", "--user", "daemon-reload"] as const,
      ["systemctl", "--user", "enable", "--now", request.serviceId] as const,
    ]),
    Match.exhaustive,
  );

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

/** Selects the platform-specific status command hint for a Caara user service. */
const serviceManagerStatusHint = ({
  request,
  userId,
}: {
  readonly request: CaaraServiceManagerRequest;
  readonly userId: string;
}): string =>
  Match.value(process.platform).pipe(
    Match.when("darwin", () => `launchctl print gui/${userId}/${request.serviceId}`),
    Match.when("linux", () => `systemctl --user status ${request.serviceId}`),
    Match.orElse(() => `status ${request.serviceId}`),
  );

/** Selects the live service-manager platform for command construction. */
const liveServicePlatform = (): CaaraServicePlatform =>
  Match.value(process.platform).pipe(
    Match.when("darwin", () => "darwin" as const),
    Match.when("linux", () => "linux" as const),
    Match.orElse(() => "linux" as const),
  );

/** Live service-manager seam for best-effort user service unload/stop. */
export const liveCaaraServiceManager: CaaraServiceManager = {
  start: (request) =>
    Effect.forEach(
      serviceManagerStartCommands({
        platform: liveServicePlatform(),
        request,
        userId: currentUserId(),
      }),
      runCommandIgnored,
      { concurrency: 1, discard: true },
    ),
  statusHint: (request) => serviceManagerStatusHint({ request, userId: currentUserId() }),
  unload: (request) =>
    Option.match(Option.fromUndefinedOr(serviceManagerUnloadCommand(request)), {
      onNone: () => Effect.void,
      onSome: runCommandIgnored,
    }),
};
