import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { VERSION } from "../src/version.js";

describe("version", () => {
  it("is the manifest's version, not a copy that can drift", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    // Two literals used to hold this, and `--version` kept printing the previous release
    // after the manifest moved on. One source, and a test that notices if it breaks.
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe("0.0.0-unknown");
  });
});
