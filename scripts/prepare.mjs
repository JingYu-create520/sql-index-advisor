/**
 * `npm install` from a git reference runs this as the package's `prepare` hook.
 *
 * It used to be `npm run build` unconditionally, and that is what broke the
 * documented install on a GitHub runner: npm prepares a git dependency inside a
 * throwaway clone, and when the dev toolchain does not land there the hook dies
 * with `tsup: not found` and the whole install fails with exit 127. The reviewer
 * on pull request #2 caught it, which is the entire reason that workflow exists.
 *
 * So: build when the toolchain is present (a contributor's checkout, CI, any
 * normal install), and otherwise fall back to the bundle that the repository
 * ships already built. Never fail an install over a missing dev dependency.
 * `ci.yml` asserts that the committed bundle matches the source, so the fallback
 * cannot silently go stale.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const localBin = fileURLToPath(new URL("../node_modules/.bin/tsup", import.meta.url));

if (!existsSync(localBin)) {
  const bundled = existsSync(fileURLToPath(new URL("../dist/cli.js", import.meta.url)));
  console.log(
    bundled
      ? "sia prepare: tsup is not installed here, keeping the bundle that ships in the repository."
      : "sia prepare: no tsup and no dist/, run `npm ci && npm run build`.",
  );
  process.exit(0);
}

try {
  execFileSync(process.platform === "win32" ? "npm" : "npm", ["run", "build"], { stdio: "inherit" });
} catch {
  // A failed build in someone's checkout is a message, not an install failure:
  // the committed bundle is still there to run.
  console.log("sia prepare: build failed; the committed dist/ was left untouched.");
}
