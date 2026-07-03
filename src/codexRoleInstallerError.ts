import { Schema } from "effect";

/** Failure while installing or removing generated Codex roles. */
export class CaaraCodexRoleInstallerError extends Schema.TaggedErrorClass<CaaraCodexRoleInstallerError>()(
  "CaaraCodexRoleInstallerError",
  {
    message: Schema.String,
  },
) {}

/** Builds one typed Codex role installer failure. */
export const caaraCodexRoleInstallerError = (message: string): CaaraCodexRoleInstallerError =>
  new CaaraCodexRoleInstallerError({ message });
