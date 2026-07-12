import { randomUUID } from "node:crypto";

import { Clock, Context, Effect, Layer, Match, Option, Schema } from "effect";
import type { Effect as EffectContract } from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ObservationCapability, PortableTurnId } from "./portableAgentIdentity.ts";

/** Default retention for portable turns and capability observations. */
export const portableAgentRetentionMillis = 7 * 24 * 60 * 60 * 1_000;

/** Durable Agent-safe state machine for one portable turn. */
export const DurablePortableTurn = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  turnId: PortableTurnId,
  sessionId: Schema.NonEmptyString,
  state: Schema.Union([
    Schema.TaggedStruct("Accepted", {}),
    Schema.TaggedStruct("Working", {}),
    Schema.TaggedStruct("Cancelling", {}),
    Schema.TaggedStruct("Completed", { finalAnswer: Schema.String }),
    Schema.TaggedStruct("Failed", {}),
    Schema.TaggedStruct("Cancelled", {
      outcome: Schema.Literals(["Interrupted", "Abandoned", "Terminated"]),
      sessionReusable: Schema.Boolean,
    }),
  ]),
  createdAtMillis: Schema.Finite,
  updatedAtMillis: Schema.Finite,
  expiresAtMillis: Schema.Finite,
});

/** Persisted portable turn record. */
export type DurablePortableTurn = typeof DurablePortableTurn.Type;

/** Durable human-only observation addressed exclusively by capability. */
export const DurablePortableObservation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  capability: ObservationCapability,
  turnId: PortableTurnId,
  status: Schema.Literals(["working", "completed", "failed", "cancelled"]),
  activity: Schema.String,
  finalAnswer: Schema.optional(Schema.String),
  cancellation: Schema.optional(
    Schema.Struct({
      outcome: Schema.Literals(["Interrupted", "Abandoned", "Terminated"]),
      sessionReusable: Schema.Boolean,
    }),
  ),
  createdAtMillis: Schema.Finite,
  updatedAtMillis: Schema.Finite,
  expiresAtMillis: Schema.Finite,
});

/** Persisted capability observation record. */
export type DurablePortableObservation = typeof DurablePortableObservation.Type;

/** Minimal expiry projection used by retention cleanup for both record kinds. */
const ExpiryRecord = Schema.Struct({ expiresAtMillis: Schema.Finite });

/** Returns whether one durable state transition follows the portable turn state machine. */
const isAllowedTurnTransition = ({
  previous,
  next,
}: {
  readonly previous: DurablePortableTurn["state"] | undefined;
  readonly next: DurablePortableTurn["state"];
}): boolean =>
  Option.match(Option.fromUndefinedOr(previous), {
    onNone: () => next._tag === "Accepted",
    onSome: (current) =>
      Match.value(current._tag).pipe(
        Match.when("Accepted", () => next._tag === "Working"),
        Match.when("Working", () => next._tag !== "Accepted"),
        Match.when(
          "Cancelling",
          () => next._tag === "Cancelling" || next._tag === "Cancelled" || next._tag === "Failed",
        ),
        Match.orElse(() => false),
      ),
  });

/** Typed failure for portable state filesystem operations. */
export class PortableAgentStoreError extends Schema.TaggedErrorClass<PortableAgentStoreError>()(
  "PortableAgentStoreError",
  { message: Schema.String },
) {}

/** Durable storage boundary kept separate from external-session bindings. */
export class PortableAgentStore extends Context.Service<
  PortableAgentStore,
  {
    readonly saveTurn: (turn: DurablePortableTurn) => EffectContract<void, PortableAgentStoreError>;
    readonly loadTurn: (
      turnId: PortableTurnId,
    ) => EffectContract<Option.Option<DurablePortableTurn>, PortableAgentStoreError>;
    readonly saveObservation: (
      observation: DurablePortableObservation,
    ) => EffectContract<void, PortableAgentStoreError>;
    readonly loadObservation: (
      capability: ObservationCapability,
    ) => EffectContract<Option.Option<DurablePortableObservation>, PortableAgentStoreError>;
    readonly cleanupExpired: EffectContract<void, PortableAgentStoreError>;
    readonly deleteTurn: (turnId: PortableTurnId) => EffectContract<void, PortableAgentStoreError>;
    readonly deleteObservation: (
      capability: ObservationCapability,
    ) => EffectContract<void, PortableAgentStoreError>;
  }
>()("@caara/PortableAgentStore") {}

/** Converts unknown platform failures into the portable store error channel. */
const storeError = (cause: unknown): PortableAgentStoreError =>
  new PortableAgentStoreError({ message: String(cause) });

/** Builds a filesystem-backed portable state layer under isolated subdirectories. */
export const portableAgentStoreLive = ({ stateDir }: { readonly stateDir: string }) =>
  Layer.effect(
    PortableAgentStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const turnDirectory = pathService.join(stateDir, "portable-turns");
      const observationDirectory = pathService.join(stateDir, "portable-observations");
      const turnPath = (turnId: PortableTurnId): string =>
        pathService.join(turnDirectory, `${encodeURIComponent(turnId)}.json`);
      const observationPath = (capability: ObservationCapability): string =>
        pathService.join(observationDirectory, `${encodeURIComponent(capability)}.json`);
      const writeRaw = Effect.fnUntraced(function* ({
        path,
        value,
      }: {
        readonly path: string;
        readonly value: Schema.Json;
      }) {
        yield* fileSystem.makeDirectory(pathService.dirname(path), { recursive: true });
        const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(value);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        yield* fileSystem.writeFileString(temporaryPath, encoded);
        const cleanupTemporary = fileSystem
          .remove(temporaryPath, { force: true })
          .pipe(Effect.ignore);
        yield* fileSystem.rename(temporaryPath, path).pipe(Effect.ensuring(cleanupTemporary));
      });
      const write = (input: { readonly path: string; readonly value: Schema.Json }) =>
        writeRaw(input).pipe(Effect.mapError(storeError));
      const readRaw = Effect.fnUntraced(function* <A>({
        path,
        schema,
      }: {
        readonly path: string;
        readonly schema: Schema.Codec<A, unknown>;
      }) {
        const exists = yield* fileSystem.exists(path);
        if (!exists) return Option.none<A>();
        const content = yield* fileSystem.readFileString(path, "utf8");
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(content);
        return Option.some(decoded);
      });
      const read = <A>(input: {
        readonly path: string;
        readonly schema: Schema.Codec<A, unknown>;
      }) => readRaw(input).pipe(Effect.mapError(storeError));
      const cleanupDirectory = Effect.fnUntraced(function* ({
        directory,
      }: {
        readonly directory: string;
      }) {
        const exists = yield* fileSystem.exists(directory).pipe(Effect.mapError(storeError));
        if (!exists) return;
        const now = yield* Clock.currentTimeMillis;
        const entries = yield* fileSystem
          .readDirectory(directory)
          .pipe(Effect.mapError(storeError));
        const removeExpiredPath = (expiredPath: string) =>
          fileSystem.remove(expiredPath, { force: true }).pipe(Effect.mapError(storeError));
        yield* Effect.forEach(
          entries.filter((entry) => entry.endsWith(".json")),
          (entry) =>
            read({ path: pathService.join(directory, entry), schema: ExpiryRecord }).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (record) => {
                    const expiredPaths = [pathService.join(directory, entry)].filter(
                      () => record.expiresAtMillis <= now,
                    );
                    return Effect.forEach(expiredPaths, removeExpiredPath, { discard: true });
                  },
                }),
              ),
            ),
          { discard: true },
        );
      });
      return {
        saveTurn: Effect.fnUntraced(function* (turn) {
          const path = turnPath(turn.turnId);
          const existing = yield* read({ path, schema: DurablePortableTurn });
          const previous = Option.map(existing, (record) => record.state).pipe(
            Option.getOrUndefined,
          );
          yield* Effect.succeed(turn).pipe(
            Effect.filterOrFail(
              () => isAllowedTurnTransition({ previous, next: turn.state }),
              () =>
                new PortableAgentStoreError({
                  message: `Portable turn ${turn.turnId} cannot transition from ${previous?._tag ?? "missing"} to ${turn.state._tag}.`,
                }),
            ),
          );
          yield* write({ path, value: turn });
        }),
        loadTurn: (turnId) => read({ path: turnPath(turnId), schema: DurablePortableTurn }),
        saveObservation: (observation) =>
          write({ path: observationPath(observation.capability), value: observation }),
        loadObservation: (capability) =>
          read({ path: observationPath(capability), schema: DurablePortableObservation }),
        deleteTurn: (turnId) =>
          fileSystem.remove(turnPath(turnId), { force: true }).pipe(Effect.mapError(storeError)),
        deleteObservation: (capability) =>
          fileSystem
            .remove(observationPath(capability), { force: true })
            .pipe(Effect.mapError(storeError)),
        cleanupExpired: Effect.all(
          [
            cleanupDirectory({ directory: turnDirectory }),
            cleanupDirectory({ directory: observationDirectory }),
          ],
          { discard: true },
        ),
      };
    }),
  );
