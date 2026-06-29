#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Layer } from "effect";

import { mainLayer } from "./caaraApp.ts";

BunRuntime.runMain(Layer.launch(mainLayer));
