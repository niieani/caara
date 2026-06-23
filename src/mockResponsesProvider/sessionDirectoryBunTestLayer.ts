import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";

import { sessionDirectoryLive } from "./sessionDirectoryPlatform.ts";

/** Builds a Bun-backed session directory layer for provider integration tests. */
export const sessionDirectoryBunTestLayer = ({ stateDir }: { readonly stateDir: string }) =>
  sessionDirectoryLive({ stateDir }).pipe(Layer.provide(BunServices.layer));
