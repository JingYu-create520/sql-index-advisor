/**
 * The one place this version is written down.
 *
 * It used to be a literal in two modules (`cli.ts` and `mcp/tools.ts`), and after the
 * 0.1.1 bump `sia --version` still printed 0.1.0 — a tool whose own version flag disagrees
 * with its manifest makes every bug report ambiguous and every "does this build have the
 * fix" question unanswerable. Read from the package.json beside the built module instead,
 * so bumping the release is the only edit there is.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  // dist/version.js and src/version.ts both sit one level below the manifest; a nested
  // entry point would be two. The name check keeps us from reading some other package's.
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "sql-index-advisor" && typeof pkg.version === "string") return pkg.version;
    } catch {
      /* candidate not there, try the next one */
    }
  }
  return "0.0.0-unknown";
}

export const VERSION = readVersion();
