import { Schema } from "effect";

/** Public identifier for one portable Agent turn. */
export const PortableTurnId = Schema.NonEmptyString.pipe(Schema.brand("PortableTurnId"));

/** Public identifier for one portable Agent turn. */
export type PortableTurnId = typeof PortableTurnId.Type;

/** Opaque human-viewer capability granting access to one turn observation. */
export const ObservationCapability = Schema.NonEmptyString.pipe(
  Schema.brand("ObservationCapability"),
);

/** Opaque human-viewer capability granting access to one turn observation. */
export type ObservationCapability = typeof ObservationCapability.Type;
