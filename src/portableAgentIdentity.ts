import { Schema } from "effect";

/** Public identifier for one portable Agent turn. */
export const PortableTurnId = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^portable-turn-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
  ),
  Schema.brand("PortableTurnId"),
);

/** Public identifier for one portable Agent turn. */
export type PortableTurnId = typeof PortableTurnId.Type;

/** Public portable session identifier with shell- and path-independent syntax. */
export const PortableSessionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)),
  Schema.brand("PortableSessionId"),
);

/** Public portable session identifier. */
export type PortableSessionId = typeof PortableSessionId.Type;

/** Opaque human-viewer capability granting access to one turn observation. */
export const ObservationCapability = Schema.NonEmptyString.pipe(
  Schema.brand("ObservationCapability"),
);

/** Opaque human-viewer capability granting access to one turn observation. */
export type ObservationCapability = typeof ObservationCapability.Type;
