import { Effect, Match, Option, Result, Schedule } from "effect";

import {
  runCaaraDoctor,
  type CaaraDoctorResult,
  type RunCaaraDoctorOptions,
} from "./caaraDoctor.ts";
import { runPortableDoctorCheck, type CaaraPortableDoctorProbe } from "./caaraPortableDoctor.ts";
import type {
  CaaraServiceLifecycleEnvironment,
  CaaraServicePaths,
  CaaraServicePlatform,
  CaaraServiceRuntime,
} from "./caaraServiceArtifacts.ts";
import {
  installServiceCodexRoles,
  serviceResultWithCodexRoleResult,
  serviceSettingsWithPathEntries,
  type CaaraServiceCodexRoles,
} from "./caaraServiceCodexRoles.ts";
import {
  installServiceNoStartArtifacts,
  type CaaraServiceLifecycleResult,
  type InstallServiceOptions,
  type NoStartInstallOutcome,
} from "./caaraServiceInstallNoStart.ts";
import type { CaaraServiceManager } from "./caaraServiceManager.ts";
import type { CaaraConfigLoader, CaaraSettingsValue } from "./caaraSettings.ts";
import { caaraHealthProbeUrl, liveCaaraHealthProbe, type CaaraHealthProbe } from "./caaraStatus.ts";

/** Doctor seam used by default service install before service start. */
export interface CaaraServiceDoctor {
  readonly fix: typeof runCaaraDoctor;
}

/** Options accepted by default started service installation. */
export interface RunCaaraInstallServiceStartedOptions {
  readonly codexRoles: CaaraServiceCodexRoles;
  readonly configLoader: CaaraConfigLoader | undefined;
  readonly doctor: CaaraServiceDoctor;
  readonly env: CaaraServiceLifecycleEnvironment;
  readonly healthProbe: CaaraHealthProbe;
  readonly options: InstallServiceOptions;
  readonly platform: CaaraServicePlatform | undefined;
  readonly portableProbe?: CaaraPortableDoctorProbe;
  readonly runtime: CaaraServiceRuntime;
  readonly serviceManager: CaaraServiceManager;
}

/** Result of probing the installed service after service-manager start. */
type ServiceHealthVerification =
  | { readonly _tag: "Healthy"; readonly url: string }
  | { readonly _tag: "Unhealthy"; readonly message: string; readonly url: string };

/** Live doctor seam used by service installation. */
export const liveCaaraServiceDoctor: CaaraServiceDoctor = {
  fix: runCaaraDoctor,
};

/** Live health probe seam used by service installation. */
export const liveCaaraServiceHealthProbe: CaaraHealthProbe = liveCaaraHealthProbe;

/** Health poll interval for service start verification. */
const serviceHealthPollInterval = (): "250 millis" => "250 millis";

/** Number of health retries after the initial immediate probe. */
const serviceHealthRetries = (): number => 20;

/** Builds doctor options for install-service repair. */
const serviceDoctorOptions = ({
  configLoader,
  env,
  options,
}: {
  readonly configLoader: CaaraConfigLoader | undefined;
  readonly env: CaaraServiceLifecycleEnvironment;
  readonly options: InstallServiceOptions;
}): RunCaaraDoctorOptions => ({
  args: ["--fix", ...options.settingsArgs],
  configLoader,
  env,
});

/** Runs health verification for a started Caara service. */
const verifyStartedServiceHealth = Effect.fnUntraced(function* ({
  healthProbe,
  settings,
}: {
  readonly healthProbe: CaaraHealthProbe;
  readonly settings: CaaraSettingsValue;
}) {
  const url = caaraHealthProbeUrl({ settings });
  const healthResult = yield* Effect.result(
    healthProbe
      .probe(url)
      .pipe(
        Effect.retry(
          Schedule.both(
            Schedule.spaced(serviceHealthPollInterval()),
            Schedule.recurs(serviceHealthRetries()),
          ),
        ),
      ),
  );

  return Result.match(healthResult, {
    onFailure: (error) =>
      ({ _tag: "Unhealthy", message: error.message, url }) satisfies ServiceHealthVerification,
    onSuccess: () => ({ _tag: "Healthy", url }) satisfies ServiceHealthVerification,
  });
});

/** Builds the service-manager request from resolved install paths. */
const serviceManagerRequestFromPaths = ({ paths }: { readonly paths: CaaraServicePaths }) => ({
  serviceFilePath: paths.serviceFilePath,
  serviceId: paths.serviceId,
});

/** Builds the result when doctor repair still leaves missing executables. */
const doctorFailureInstallResult = ({
  doctorResult,
  installResult,
}: {
  readonly doctorResult: CaaraDoctorResult;
  readonly installResult: CaaraServiceLifecycleResult;
}): CaaraServiceLifecycleResult => ({
  exitCode: 1,
  message: [
    installResult.message,
    "caara install-service failed before service start because doctor repair did not satisfy all executable requirements.",
    doctorResult.message,
  ].join("\n"),
});

/** Builds the result when service start health verification succeeds. */
const serviceStartedResult = ({
  doctorResult,
  health,
  installResult,
  portableMessage,
}: {
  readonly doctorResult: CaaraDoctorResult;
  readonly health: Extract<ServiceHealthVerification, { readonly _tag: "Healthy" }>;
  readonly installResult: CaaraServiceLifecycleResult;
  readonly portableMessage?: string;
}): CaaraServiceLifecycleResult => ({
  exitCode: 0,
  message: [
    installResult.message,
    doctorResult.message,
    "service started",
    `Caara healthy at ${health.url}`,
    ...[portableMessage].filter((message): message is string => message !== undefined),
  ].join("\n"),
});

/** Runs the optional portable capability probe after service health succeeds. */
const portableStartedResult = Effect.fnUntraced(function* ({
  doctorResult,
  health,
  installResult,
  probe,
}: {
  readonly doctorResult: CaaraDoctorResult;
  readonly health: Extract<ServiceHealthVerification, { readonly _tag: "Healthy" }>;
  readonly installResult: CaaraServiceLifecycleResult;
  readonly probe: CaaraPortableDoctorProbe;
}) {
  const portable = yield* runPortableDoctorCheck({
    cwd: process.cwd(),
    origin: health.url.replace(/\/health$/u, ""),
    probe,
  });
  return {
    exitCode: portable.exitCode,
    message: [
      serviceStartedResult({ doctorResult, health, installResult }).message,
      portable.message,
    ].join("\n"),
  } satisfies CaaraServiceLifecycleResult;
});

/** Starts the installed service, verifies health, then verifies portable delegation. */
const startAndVerifyInstalledService = Effect.fnUntraced(function* ({
  doctorResult,
  healthProbe,
  installOutcome,
  installResult,
  portableProbe,
  serviceManager,
}: {
  readonly doctorResult: CaaraDoctorResult;
  readonly healthProbe: CaaraHealthProbe;
  readonly installOutcome: NoStartInstallOutcome;
  readonly installResult: CaaraServiceLifecycleResult;
  readonly portableProbe: CaaraPortableDoctorProbe | undefined;
  readonly serviceManager: CaaraServiceManager;
}) {
  const request = serviceManagerRequestFromPaths({ paths: installOutcome.paths });
  yield* serviceManager.start(request);
  const health = yield* verifyStartedServiceHealth({
    healthProbe,
    settings: installOutcome.resolution.settings,
  });
  return yield* Match.valueTags(health, {
    Healthy: (healthy) =>
      Option.match(Option.fromUndefinedOr(portableProbe), {
        onNone: () =>
          Effect.succeed(serviceStartedResult({ doctorResult, health: healthy, installResult })),
        onSome: (probe) =>
          portableStartedResult({ doctorResult, health: healthy, installResult, probe }),
      }),
    Unhealthy: (unhealthy) =>
      Effect.succeed(
        serviceHealthFailureResult({
          health: unhealthy,
          installResult,
          statusHint: serviceManager.statusHint(request),
        }),
      ),
  });
});

/** Builds the result when service start health verification fails. */
const serviceHealthFailureResult = ({
  health,
  installResult,
  statusHint,
}: {
  readonly health: Extract<ServiceHealthVerification, { readonly _tag: "Unhealthy" }>;
  readonly installResult: CaaraServiceLifecycleResult;
  readonly statusHint: string;
}): CaaraServiceLifecycleResult => ({
  exitCode: 1,
  message: [
    installResult.message,
    `caara install-service started the service but health verification failed at ${health.url}.`,
    `last health error: ${health.message}`,
    `service status: ${statusHint}`,
  ].join("\n"),
});

/** Runs default install-service: install artifacts, doctor repair, service start, then health probe. */
export const runCaaraInstallServiceStarted = Effect.fnUntraced(function* ({
  codexRoles,
  configLoader,
  doctor,
  env,
  healthProbe,
  options,
  platform,
  portableProbe,
  runtime,
  serviceManager,
}: RunCaaraInstallServiceStartedOptions) {
  const installOutcome = yield* installServiceNoStartArtifacts({
    configLoader,
    env,
    options,
    platform,
    runtime,
  });
  const doctorResult = yield* doctor.fix(serviceDoctorOptions({ configLoader, env, options }));
  const roleResult = yield* installServiceCodexRoles({
    codexRoles,
    configPath: installOutcome.resolution.configPath,
    env,
    settings: serviceSettingsWithPathEntries({
      appendedPathEntries: doctorResult.appendedPathEntries,
      settings: installOutcome.resolution.settings,
    }),
    skip: options.noInstallCodexRoles,
    yolo: options.yolo,
  });
  const installResult = serviceResultWithCodexRoleResult({
    result: installOutcome.result,
    roleResult,
  });
  return yield* Match.value({
    doctorExitCode: doctorResult.exitCode,
    installExitCode: installResult.exitCode,
  }).pipe(
    Match.when({ doctorExitCode: 1 }, () =>
      Effect.succeed(
        doctorFailureInstallResult({
          doctorResult,
          installResult,
        }),
      ),
    ),
    Match.when({ installExitCode: 1 }, () => Effect.succeed(installResult)),
    Match.orElse(() =>
      startAndVerifyInstalledService({
        doctorResult,
        healthProbe,
        installOutcome,
        installResult,
        portableProbe,
        serviceManager,
      }),
    ),
  );
});
