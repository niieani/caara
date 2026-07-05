import fs from "node:fs/promises";
import path from "node:path";

import { Effect, Match } from "effect";

import { allSafeCodexRoleDefinitions, type CaaraCodexRoleDefinition } from "./codexRoleCatalog.ts";
import { caaraCodexRoleInstallerError } from "./codexRoleInstallerError.ts";
import { pathExists } from "./fsPathExists.ts";
import {
  isCaaraGeneratedCodexRole,
  parseCodexRoleQueryParams,
  renderCodexRoleToml,
  type CodexRoleQueryParams,
} from "./codexRoleToml.ts";

/** One managed role file write decision after preflight. */
export interface RoleWritePlan {
  readonly _tag: "Write";
  readonly queryParams: CodexRoleQueryParams;
  readonly role: CaaraCodexRoleDefinition;
}

/** One user-owned role collision that Caara must not overwrite. */
export interface RoleCollisionPlan {
  readonly _tag: "Collision";
  readonly filePath: string;
}

/** Managed role file write or refusal decision. */
export type RolePreflightPlan = RoleWritePlan | RoleCollisionPlan;

/** Driver family inferred from one generated role model slug. */
type RoleDriverFamily = "Antigravity" | "Claude" | "Unknown";

/** Builds the managed Codex role filename for one definition. */
const roleFilename = ({ role }: { readonly role: CaaraCodexRoleDefinition }): string =>
  `${role.name}.toml`;

/** Infers the driver family from one generated role model slug. */
const roleDriverFamily = ({
  role,
}: {
  readonly role: CaaraCodexRoleDefinition;
}): RoleDriverFamily =>
  Match.value(role.model.split("/").at(0)).pipe(
    Match.when("agy", () => "Antigravity" as const),
    Match.when("claude", () => "Claude" as const),
    Match.orElse(() => "Unknown" as const),
  );

/** Lists query param keys owned by yolo permission posture for one role. */
const yoloOwnedQueryParamKeys = ({
  role,
}: {
  readonly role: CaaraCodexRoleDefinition;
}): readonly string[] =>
  Match.value(roleDriverFamily({ role })).pipe(
    Match.when("Antigravity", () => ["dangerously_skip_permissions"] as const),
    Match.when("Claude", () => ["permission_mode"] as const),
    Match.orElse(() => [] as readonly string[]),
  );

/** Builds yolo query params for one generated role. */
const yoloQueryParams = ({
  role,
  yolo,
}: {
  readonly role: CaaraCodexRoleDefinition;
  readonly yolo: boolean;
}): CodexRoleQueryParams =>
  Match.value({ driver: roleDriverFamily({ role }), yolo }).pipe(
    Match.when({ driver: "Antigravity", yolo: true }, () => ({
      dangerously_skip_permissions: "true",
    })),
    Match.when({ driver: "Claude", yolo: true }, () => ({
      permission_mode: "bypassPermissions",
    })),
    Match.orElse(() => ({})),
  );

/** Removes query params owned by the generated role permission posture. */
const withoutYoloOwnedQueryParams = ({
  queryParams,
  role,
}: {
  readonly queryParams: CodexRoleQueryParams;
  readonly role: CaaraCodexRoleDefinition;
}): CodexRoleQueryParams =>
  Object.fromEntries(
    Object.entries(queryParams).filter(([key]) => !yoloOwnedQueryParamKeys({ role }).includes(key)),
  );

/** Applies the selected generated role permission posture to preserved query params. */
const queryParamsForRoleMode = ({
  queryParams,
  role,
  yolo,
}: {
  readonly queryParams: CodexRoleQueryParams;
  readonly role: CaaraCodexRoleDefinition;
  readonly yolo: boolean;
}): CodexRoleQueryParams => ({
  ...withoutYoloOwnedQueryParams({ queryParams, role }),
  ...yoloQueryParams({ role, yolo }),
});

/** Builds the managed Codex role path for one target directory. */
const roleFilePath = ({
  role,
  targetDirectory,
}: {
  readonly role: CaaraCodexRoleDefinition;
  readonly targetDirectory: string;
}): string => path.join(targetDirectory, roleFilename({ role }));

/** Lists all filenames Caara is allowed to manage. */
const allManagedRoleFilenames = (): readonly string[] =>
  allSafeCodexRoleDefinitions.map((role) => roleFilename({ role }));

/** Returns whether one filename belongs to the Caara-managed role catalog. */
const isManagedRoleFilename = ({ filename }: { readonly filename: string }): boolean =>
  allManagedRoleFilenames().includes(filename);

/** Reads a managed role file as UTF-8 text. */
const readRoleFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  return yield* Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: (cause) =>
      caaraCodexRoleInstallerError(`Failed to read Codex role ${filePath}: ${String(cause)}`),
  });
});

/** Lists TOML role filenames in a target directory. */
const listTomlRoleFilenames = Effect.fnUntraced(function* ({
  targetDirectory,
}: {
  readonly targetDirectory: string;
}) {
  const entries = yield* Effect.tryPromise({
    try: () => fs.readdir(targetDirectory),
    catch: (cause) =>
      caaraCodexRoleInstallerError(
        `Failed to list Codex roles directory ${targetDirectory}: ${String(cause)}`,
      ),
  });
  return entries.filter((entry) => entry.endsWith(".toml")).toSorted();
});

/** Returns whether one role file is marked as Caara-generated. */
const isMarkedCaaraRoleFile = Effect.fnUntraced(function* ({
  filePath,
}: {
  readonly filePath: string;
}) {
  const source = yield* readRoleFile({ filePath });
  return isCaaraGeneratedCodexRole(source);
});

/** Narrows optional file paths returned by marked-file discovery. */
const isDefinedFilePath = (filePath: string | undefined): filePath is string =>
  filePath !== undefined;

/** Narrows existing role sources to Caara-marked sources. */
const isMarkedRoleSource = (source: string | undefined): source is string =>
  source !== undefined && isCaaraGeneratedCodexRole(source);

/** Builds one new same-name role write plan. */
const newRoleWritePlan = ({
  role,
}: {
  readonly role: CaaraCodexRoleDefinition;
}): RolePreflightPlan => ({
  _tag: "Write",
  queryParams: {},
  role,
});

/** Builds one existing same-name role write or collision plan. */
const existingRoleWritePlan = ({
  filePath,
  queryParams,
  role,
}: {
  readonly filePath: string;
  readonly queryParams: CodexRoleQueryParams | undefined;
  readonly role: CaaraCodexRoleDefinition;
}): RolePreflightPlan =>
  Match.value(queryParams).pipe(
    Match.when(
      undefined,
      () =>
        ({
          _tag: "Collision",
          filePath,
        }) satisfies RolePreflightPlan,
    ),
    Match.orElse(
      (preservedQueryParams) =>
        ({
          _tag: "Write",
          queryParams: preservedQueryParams,
          role,
        }) satisfies RolePreflightPlan,
    ),
  );

/** Builds one role write plan from optional existing source and parsed query params. */
const roleWritePlanFromSource = ({
  filePath,
  queryParams,
  role,
  source,
}: {
  readonly filePath: string;
  readonly queryParams: CodexRoleQueryParams | undefined;
  readonly role: CaaraCodexRoleDefinition;
  readonly source: string | undefined;
}): RolePreflightPlan =>
  Match.value(source).pipe(
    Match.when(undefined, () => newRoleWritePlan({ role })),
    Match.orElse(() => existingRoleWritePlan({ filePath, queryParams, role })),
  );

/** Builds one role write plan while preserving marked role query params. */
const preflightRoleWrite = Effect.fnUntraced(function* ({
  role,
  targetDirectory,
}: {
  readonly role: CaaraCodexRoleDefinition;
  readonly targetDirectory: string;
}) {
  const filePath = roleFilePath({ role, targetDirectory });
  const exists = yield* pathExists({ targetPath: filePath });
  const sources = yield* Effect.forEach(
    [filePath].filter(() => exists),
    (existingPath) => readRoleFile({ filePath: existingPath }),
    { concurrency: 1 },
  );
  const queryParams = yield* Effect.forEach(
    sources.filter(isMarkedRoleSource),
    (source) => parseCodexRoleQueryParams({ source }),
    { concurrency: 1 },
  );
  return roleWritePlanFromSource({
    filePath,
    queryParams: queryParams.at(0),
    role,
    source: sources.at(0),
  });
});

/** Builds all managed role write plans while preserving marked role query params. */
export const preflightRoleWrites = Effect.fnUntraced(function* ({
  roles,
  targetDirectory,
}: {
  readonly roles: readonly CaaraCodexRoleDefinition[];
  readonly targetDirectory: string;
}) {
  return yield* Effect.forEach(roles, (role) => preflightRoleWrite({ role, targetDirectory }), {
    concurrency: 1,
  });
});

/** Extracts a preflight collision when present. */
export const firstCollision = ({
  plans,
}: {
  readonly plans: readonly RolePreflightPlan[];
}): RoleCollisionPlan | undefined => plans.find((plan) => plan._tag === "Collision");

/** Extracts write plans from preflight output. */
export const writePlansFromPreflight = ({
  plans,
}: {
  readonly plans: readonly RolePreflightPlan[];
}): readonly RoleWritePlan[] =>
  plans.filter((plan): plan is RoleWritePlan => plan._tag === "Write");

/** Removes one managed role file. */
const removeRoleFile = Effect.fnUntraced(function* ({ filePath }: { readonly filePath: string }) {
  yield* Effect.tryPromise({
    try: () => fs.rm(filePath, { force: true }),
    catch: (cause) =>
      caaraCodexRoleInstallerError(`Failed to remove Codex role ${filePath}: ${String(cause)}`),
  });
  return filePath;
});

/** Removes marked managed role files that no longer belong to available drivers. */
export const removeStaleMarkedRoles = Effect.fnUntraced(function* ({
  roles,
  targetDirectory,
}: {
  readonly roles: readonly CaaraCodexRoleDefinition[];
  readonly targetDirectory: string;
}) {
  const desiredFilenames = roles.map((role) => roleFilename({ role }));
  const filenames = yield* listTomlRoleFilenames({ targetDirectory });
  const staleManagedFilenames = filenames.filter(
    (filename) => isManagedRoleFilename({ filename }) && !desiredFilenames.includes(filename),
  );
  const markedStaleFiles = yield* Effect.forEach(
    staleManagedFilenames,
    (filename) =>
      Effect.gen(function* () {
        const filePath = path.join(targetDirectory, filename);
        const marked = yield* isMarkedCaaraRoleFile({ filePath });
        return [filePath].filter(() => marked).at(0);
      }),
    { concurrency: 1 },
  );
  return yield* Effect.forEach(
    markedStaleFiles.filter(isDefinedFilePath),
    (filePath) => removeRoleFile({ filePath }),
    { concurrency: 1 },
  );
});

/** Removes all marked Caara-generated role files in a target directory. */
export const removeMarkedRoles = Effect.fnUntraced(function* ({
  targetDirectory,
}: {
  readonly targetDirectory: string;
}) {
  const filenames = yield* listTomlRoleFilenames({ targetDirectory });
  const markedFiles = yield* Effect.forEach(
    filenames,
    (filename) =>
      Effect.gen(function* () {
        const filePath = path.join(targetDirectory, filename);
        const marked = yield* isMarkedCaaraRoleFile({ filePath });
        return [filePath].filter(() => marked).at(0);
      }),
    { concurrency: 1 },
  );
  return yield* Effect.forEach(
    markedFiles.filter(isDefinedFilePath),
    (filePath) => removeRoleFile({ filePath }),
    { concurrency: 1 },
  );
});

/** Writes one generated role file into the target directory. */
export const writeRoleFile = Effect.fnUntraced(function* ({
  baseUrl,
  queryParams,
  role,
  targetDirectory,
  yolo,
}: {
  readonly baseUrl: string;
  readonly queryParams: CodexRoleQueryParams;
  readonly role: CaaraCodexRoleDefinition;
  readonly targetDirectory: string;
  readonly yolo: boolean;
}) {
  const filePath = roleFilePath({ role, targetDirectory });
  yield* Effect.tryPromise({
    try: () =>
      fs.writeFile(
        filePath,
        renderCodexRoleToml({
          baseUrl,
          queryParams: queryParamsForRoleMode({ queryParams, role, yolo }),
          role,
        }),
        "utf8",
      ),
    catch: (cause) =>
      caaraCodexRoleInstallerError(
        `Failed to write generated Codex role ${filePath}: ${String(cause)}`,
      ),
  });
  return filePath;
});
