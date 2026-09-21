import { main } from "./index.js";

/**
 * Standalone bin (sia-mcp). Kept separate from index.ts so that importing the
 * MCP module. Reached either from the `sia mcp` subcommand or from a bundle where
 * `import.meta.url` equals the entry path, it never starts a second server.
 */
main().catch((err: unknown) => {
  process.stderr.write(`MCP server failed: ${(err as Error).message}\n`);
  process.exit(2);
});
