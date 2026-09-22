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
    // The CLI has to run from the checkout alone: the GitHub Action calls
    // `node dist/cli.js` without installing anything, and a bundle that still
    // resolves `zod` from node_modules died with ERR_MODULE_NOT_FOUND on the
    // runner. Vendoring the runtime deps makes the shipped binary self-contained.
    noExternal: [/^(zod|commander|picocolors|@modelcontextprotocol\/sdk)(\/|$)/],
    // CLI must be executable as a bin. The createRequire shim is needed because
    // the vendored deps are CommonJS: bundled into an ESM file their internal
    // `require("events")` has no `require` to call, and Node throws
    // "Dynamic require of ... is not supported" the moment the binary starts.
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __siaCreateRequire } from 'node:module'; const require = __siaCreateRequire(import.meta.url);",
    },
  },
  {
    entry: { mcp: "src/mcp/bin.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    dts: false,
    sourcemap: true,
    splitting: false,
    // The MCP server is also a bin (sia-mcp), spawned straight from the checkout.
    noExternal: [/^(zod|commander|picocolors|@modelcontextprotocol\/sdk)(\/|$)/],
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __siaCreateRequire } from 'node:module'; const require = __siaCreateRequire(import.meta.url);",
    },
  },
]);
