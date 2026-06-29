#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";

import { caaraCliMain } from "./caaraCli.ts";

BunRuntime.runMain(caaraCliMain({ args: process.argv.slice(2) }));
