---
version: alpha
name: Caara Relay Aperture
description: Brand system for Caara, a Responses-compatible bridge that relays Codex subagent turns to external code agents.
colors:
  primary: "#090A0B"
  secondary: "#788391"
  tertiary: "#63F6C9"
  neutral: "#EDE7DA"
  surfaceDark: "#171A1F"
  surfaceLight: "#F8FAFC"
  backgroundLight: "#EEF1F5"
  textDark: "#13171C"
  copper: "#C77854"
  copperLight: "#B96B4F"
  ruleDark: "#2A3036"
  ruleLight: "#D2D9E0"
typography:
  headline-display:
    fontFamily: "Satoshi Variable"
    fontSize: 56px
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: 0
  headline-lg:
    fontFamily: "Satoshi Variable"
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: 0
  body-md:
    fontFamily: "Satoshi Variable"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  label-md:
    fontFamily: "IBM Plex Mono"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0.08em
  code-md:
    fontFamily: "IBM Plex Mono"
    fontSize: 15px
    fontWeight: 450
    lineHeight: 1.45
    letterSpacing: 0
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  xxl: 64px
  gutter: 16px
  panelPadding: 28px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.neutral}"
    borderColor: "{colors.ruleDark}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  chip-status-ok:
    backgroundColor: "transparent"
    textColor: "{colors.tertiary}"
    borderColor: "{colors.ruleDark}"
    typography: "{typography.code-md}"
    rounded: "{rounded.full}"
    padding: "{spacing.sm}"
  panel-dark:
    backgroundColor: "{colors.surfaceDark}"
    textColor: "{colors.neutral}"
    borderColor: "{colors.ruleDark}"
    rounded: "{rounded.none}"
  panel-light:
    backgroundColor: "{colors.surfaceLight}"
    textColor: "{colors.textDark}"
    borderColor: "{colors.ruleLight}"
    rounded: "{rounded.none}"
  command-input:
    backgroundColor: "transparent"
    textColor: "{colors.neutral}"
    borderColor: "{colors.ruleDark}"
    typography: "{typography.code-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
---

# Caara Design

## Overview

Caara should feel like a precise relay layer for serious code-agent work: modern, elegant, quiet, local-native, and implementation-grade. The brand idea is the **relay aperture**: mirrored rails holding a stable negative-space path between Codex and external agents.

The mark is a geometric aperture made from two bracket-like rails, endpoint nodes, and a central path. It should imply bridge, handoff, continuity, and API framing. Avoid robot imagery, magic sparkles, generic AI gradients, and decorative icons that do not express relay or transport.

Brand assets:

- Dark board: `docs/brand/caara-brandkit-dark.png`
- Light board: `docs/brand/caara-brandkit-light.png`

## Colors

Use a two-mode system. Dark mode is the primary product expression; light mode is the editorial and documentation expression.

- **Primary / Ink Black (#090A0B):** Core dark canvas and high-contrast product surfaces.
- **Neutral / Bone (#EDE7DA):** Dark-mode text and identity surfaces; softer than white. Light mode
  uses cool ink (#13171C) instead.
- **Tertiary / Relay Mint (#63F6C9):** The active relay signal. Use sparingly for live states, endpoints, primary action, and route highlights.
- **Copper (#C77854):** Human warmth and physical detail. Use for edge accents, punctuation, and secondary emphasis.
- **Secondary / Slate (#788391):** Metadata, disabled states, rules, and quiet system structure.
- **Light surfaces (#EEF1F5, #F8FAFC):** Cool porcelain mode with the same graphite structure and
  temperature as dark mode; never warm cream or beige.

Do not introduce additional accent colors unless a new semantic state requires one. Error states may use a restrained red, but it should not compete with relay mint.

## Typography

Use a clear grotesk for brand and narrative UI, paired with a precise monospace for commands, routes, model specifiers, and runtime status.

- **Headlines:** `Satoshi Variable`, medium weight, generous scale, no negative tracking.
- **Body:** `Satoshi Variable`, regular weight, compact but readable.
- **Labels:** `IBM Plex Mono`, uppercase or small technical captions with positive letter spacing.
- **Code and command UI:** `IBM Plex Mono`, medium size, plain casing unless mirroring an exact command or API route.

Keep text sparse. Prefer one strong phrase over explanatory paragraphs in visual surfaces.

## Layout

Use a disciplined grid with visible rhythm: calm cover area, technical construction area, functional product surface, brand essence, palette, typography, physical application, image direction, and system detail.

Product UI should use dense but organized layouts, not marketing cards. Leave enough negative space around the relay aperture mark so it reads at small sizes. Align technical labels and rules precisely; misalignment weakens the system.

Spacing follows a 4px base with 8px, 16px, 24px, 40px, and 64px steps. Use 16px gutters for compact boards and 24px or 40px gutters for documentation pages.

## Elevation & Depth

Depth comes from tonal layers, fine rules, and restrained tactile shadows. Dark mode should feel like layered graphite surfaces with faint scanline or grain texture. Light mode should feel like cool porcelain and brushed aluminum over the same graphite skeleton; it is dark mode with the lights on, never a warm paper world of its own.

Avoid heavy glassmorphism, glowing blobs, generic neon halos, and large drop shadows.

## Shapes

Shape language is architectural and framed. Rectangular containers use square corners or an 8px radius when interaction requires softness. Pills are reserved for status chips and endpoint indicators.

The logo mark must remain geometric: paired rails, endpoint nodes, and a negative-space path. Do not round it into a friendly mascot or overcomplicate it with extra routes.

## Components

- **Buttons:** Mint primary for the single main action; transparent secondary with fine rules for supporting actions.
- **Status chips:** Monospace labels, pill shape, mint dot or endpoint node for healthy/live states.
- **Command inputs:** Framed, monospace, quiet background. Commands should look executable, not decorative.
- **Panels:** Flat surfaces with fine borders. Dark panels use graphite; light panels use porcelain or warm bone.
- **Route lists:** Use concise model specifiers such as `claude/*`, `agy/*`, and `diagnostic/*`; align them like infrastructure, not navigation marketing.
- **Browser/product chrome:** Minimal controls, small service endpoint, and one highlighted API route. Avoid full fake dashboards.

## Do's and Don'ts

- Do use the relay aperture mark consistently across app icon, wordmark, construction diagrams, and status components.
- Do reserve relay mint for active transport, endpoint nodes, live service state, and primary action.
- Do use hard failures and clear status language in product surfaces.
- Do keep the brand quiet, sparse, and precise.
- Don't use generic AI sparkles, purple-blue glows, robot illustrations, or random node clouds.
- Don't mix many accent colors or add gradients without a transport-specific reason.
- Don't make UI boards look like SaaS marketing dashboards.
- Don't distort the wordmark; keep lowercase `caara` with open spacing and calm weight.
