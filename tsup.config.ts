import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    dts: false,
    sourcemap: true,
    splitting: false,
    // CLI must be executable as a bin.
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { mcp: "src/mcp/bin.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    dts: false,
    sourcemap: true,
    splitting: false,
    // The MCP server is also a bin (sia-mcp).
    banner: { js: "#!/usr/bin/env node" },
  },
]);
