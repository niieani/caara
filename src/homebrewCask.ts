import path from "node:path";

import { Effect, Match, Option, Schema } from "effect";

import {
  createReleaseServiceArtifacts,
  type ServiceArtifact,
  type ServiceArtifactPlatform,
  type ServiceArtifactPlatformArchitecture,
  type ServiceChecksum,
} from "./serviceBuild.ts";

/** Failure while building or validating Homebrew cask text. */
export class HomebrewCaskError extends Schema.TaggedErrorClass<HomebrewCaskError>()(
  "HomebrewCaskError",
  {
    message: Schema.String,
  },
) {}

/** One cask artifact stanza with concrete URL and checksum. */
export interface HomebrewCaskArtifact {
  readonly archiveName: string;
  readonly sha256: string;
  readonly url: string;
}

/** Complete generated cask data for the public release matrix. */
export interface HomebrewCaskDefinition {
  readonly darwinArm64: HomebrewCaskArtifact;
  readonly linuxAmd64: HomebrewCaskArtifact;
  readonly linuxArm64: HomebrewCaskArtifact;
  readonly repository: string;
  readonly version: string;
}

/** Options accepted by Homebrew cask definition generation. */
export interface CreateHomebrewCaskDefinitionOptions {
  readonly checksums: readonly ServiceChecksum[];
  readonly repository: string;
  readonly version: string;
}

/** Options accepted by cask rendering. */
export interface RenderHomebrewCaskOptions {
  readonly definition: HomebrewCaskDefinition;
}

/** Options accepted by static cask text validation. */
export interface ValidateHomebrewCaskTextOptions {
  readonly caskText: string;
}

/** Options accepted by validated cask rendering. */
export interface RenderValidatedHomebrewCaskOptions {
  readonly definition: HomebrewCaskDefinition;
}

/** Builds one typed Homebrew cask failure. */
const homebrewCaskError = (message: string): HomebrewCaskError =>
  new HomebrewCaskError({ message });

/** Finds one release artifact for a cask platform branch. */
const releaseArtifactForPlatform = Effect.fnUntraced(function* ({
  artifacts,
  platform,
  platformArchitecture,
}: {
  readonly artifacts: readonly ServiceArtifact[];
  readonly platform: ServiceArtifactPlatform;
  readonly platformArchitecture: ServiceArtifactPlatformArchitecture;
}) {
  return yield* Option.match(
    Option.fromUndefinedOr(
      artifacts.find(
        (artifact) =>
          artifact.platform === platform && artifact.platformArchitecture === platformArchitecture,
      ),
    ),
    {
      onNone: () =>
        Effect.fail(
          homebrewCaskError(`Missing release artifact for ${platform}_${platformArchitecture}.`),
        ),
      onSome: Effect.succeed,
    },
  );
});

/** Finds one checksum by release archive name. */
const checksumForArtifact = Effect.fnUntraced(function* ({
  artifact,
  checksums,
}: {
  readonly artifact: ServiceArtifact;
  readonly checksums: readonly ServiceChecksum[];
}) {
  return yield* Option.match(
    Option.fromUndefinedOr(
      checksums.find((checksum) => path.basename(checksum.path) === artifact.archiveName),
    ),
    {
      onNone: () => Effect.fail(homebrewCaskError(`Missing checksum for ${artifact.archiveName}.`)),
      onSome: Effect.succeed,
    },
  );
});

/** Builds a GitHub release asset URL for one artifact. */
const releaseArtifactUrl = ({
  archiveName,
  repository,
  version,
}: {
  readonly archiveName: string;
  readonly repository: string;
  readonly version: string;
}): string => `https://github.com/${repository}/releases/download/v${version}/${archiveName}`;

/** Builds one Homebrew cask artifact from a release artifact and checksum. */
const homebrewCaskArtifact = Effect.fnUntraced(function* ({
  artifact,
  checksums,
  repository,
  version,
}: {
  readonly artifact: ServiceArtifact;
  readonly checksums: readonly ServiceChecksum[];
  readonly repository: string;
  readonly version: string;
}) {
  const checksum = yield* checksumForArtifact({ artifact, checksums });
  return {
    archiveName: artifact.archiveName,
    sha256: checksum.sha256,
    url: releaseArtifactUrl({ archiveName: artifact.archiveName, repository, version }),
  } satisfies HomebrewCaskArtifact;
});

/** Builds a Homebrew cask artifact for one public platform. */
const homebrewCaskArtifactForPlatform = Effect.fnUntraced(function* ({
  artifacts,
  checksums,
  platform,
  platformArchitecture,
  repository,
  version,
}: {
  readonly artifacts: readonly ServiceArtifact[];
  readonly checksums: readonly ServiceChecksum[];
  readonly platform: ServiceArtifactPlatform;
  readonly platformArchitecture: ServiceArtifactPlatformArchitecture;
  readonly repository: string;
  readonly version: string;
}) {
  const artifact = yield* releaseArtifactForPlatform({
    artifacts,
    platform,
    platformArchitecture,
  });
  return yield* homebrewCaskArtifact({ artifact, checksums, repository, version });
});

/** Builds a cask definition from public release artifacts and checksums. */
export const createHomebrewCaskDefinition = Effect.fnUntraced(function* ({
  checksums,
  repository,
  version,
}: CreateHomebrewCaskDefinitionOptions) {
  const artifacts = createReleaseServiceArtifacts({ version });
  const darwinArm64 = yield* homebrewCaskArtifactForPlatform({
    artifacts,
    checksums,
    platform: "darwin",
    platformArchitecture: "arm64",
    repository,
    version,
  });
  const linuxAmd64 = yield* homebrewCaskArtifactForPlatform({
    artifacts,
    checksums,
    platform: "linux",
    platformArchitecture: "amd64",
    repository,
    version,
  });
  const linuxArm64 = yield* homebrewCaskArtifactForPlatform({
    artifacts,
    checksums,
    platform: "linux",
    platformArchitecture: "arm64",
    repository,
    version,
  });

  return {
    darwinArm64,
    linuxAmd64,
    linuxArm64,
    repository,
    version,
  } satisfies HomebrewCaskDefinition;
});

/** Renders one Homebrew cask URL and checksum branch. */
const renderArtifactBranch = ({
  artifact,
}: {
  readonly artifact: HomebrewCaskArtifact;
}): readonly string[] => [`    sha256 "${artifact.sha256}"`, `    url "${artifact.url}"`];

/** Renders the Homebrew cask file text for Caara. */
export const renderHomebrewCask = ({ definition }: RenderHomebrewCaskOptions): string =>
  [
    'cask "caara" do',
    `  version "${definition.version}"`,
    "",
    "  if OS.mac? && Hardware::CPU.arm?",
    ...renderArtifactBranch({ artifact: definition.darwinArm64 }),
    "  elsif OS.linux? && Hardware::CPU.intel?",
    ...renderArtifactBranch({ artifact: definition.linuxAmd64 }),
    "  elsif OS.linux? && Hardware::CPU.arm?",
    ...renderArtifactBranch({ artifact: definition.linuxArm64 }),
    "  else",
    '    odie "Caara release artifacts support Apple Silicon macOS, Linux x64, and Linux arm64."',
    "  end",
    "",
    '  name "Caara"',
    '  desc "OpenAI-compatible Responses API wrapper for local code agents"',
    `  homepage "https://github.com/${definition.repository}"`,
    "",
    '  binary "caara"',
    "",
    "  postflight do",
    '    system_command "#{staged_path}/caara", args: ["install-service"], sudo: false',
    "  end",
    "",
    "  uninstall_preflight do",
    '    system_command "#{staged_path}/caara", args: ["uninstall-service"], sudo: false',
    "  end",
    "",
    "  zap trash: [",
    '    "~/.config/caara",',
    '    "~/.local/state/caara",',
    '    "~/Library/Application Support/caara",',
    '    "~/Library/Logs/caara",',
    "  ]",
    "end",
    "",
  ].join("\n");

/** Returns whether one cask line opens a Ruby block in generated cask syntax. */
const opensRubyBlock = (line: string): boolean =>
  Match.value(line.trim()).pipe(
    Match.when(
      (trimmed) => trimmed.endsWith(" do"),
      () => true,
    ),
    Match.when(
      (trimmed) => trimmed.startsWith("if "),
      () => true,
    ),
    Match.orElse(() => false),
  );

/** Returns whether one cask line closes a Ruby block in generated cask syntax. */
const closesRubyBlock = (line: string): boolean => line.trim() === "end";

/** Computes generated Ruby block balance for static validation. */
const rubyBlockBalance = (caskText: string): number =>
  caskText
    .split("\n")
    .map(
      (line) =>
        [...[1].filter(() => opensRubyBlock(line)), ...[-1].filter(() => closesRubyBlock(line))].at(
          0,
        ) ?? 0,
    )
    .reduce((left, right) => left + right, 0);

/** Validates generated cask text with a strict static Ruby-shape check. */
export const validateHomebrewCaskText = Effect.fnUntraced(function* ({
  caskText,
}: ValidateHomebrewCaskTextOptions) {
  const validationFailure = [
    ['Homebrew cask text must start with cask "caara" do.'].filter(
      () => !caskText.startsWith('cask "caara" do\n'),
    ),
    [`Homebrew cask Ruby block balance is ${rubyBlockBalance(caskText)}.`].filter(
      () => rubyBlockBalance(caskText) !== 0,
    ),
  ]
    .flat()
    .at(0);

  return yield* Option.match(Option.fromUndefinedOr(validationFailure), {
    onNone: () => Effect.void,
    onSome: (message) => Effect.fail(homebrewCaskError(message)),
  });
});

/** Renders cask text and validates the generated Ruby shape before returning it. */
export const renderValidatedHomebrewCask = Effect.fnUntraced(function* ({
  definition,
}: RenderValidatedHomebrewCaskOptions) {
  const caskText = renderHomebrewCask({ definition });
  yield* validateHomebrewCaskText({ caskText });
  return caskText;
});
