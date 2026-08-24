#!/usr/bin/env node
// npm runs `prepare` on install. Two callers need different things from it:
//
//   - A dev running `npm install` in a clone has the TypeScript toolchain and wants
//     a fresh build.
//   - `npm i -g github:gilby125/mcp-server-airbnb` does NOT install devDependencies,
//     so tsc is absent and an unconditional `tsc` here fails the whole install with
//     "tsc: command not found". That is why dist/ is committed on this fork.
//
// So: build when we can, fall back to the committed build when we cannot, and only
// fail when there is neither a toolchain nor a usable dist to fall back on.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

let hasTypeScript = true;
try {
  require.resolve("typescript/package.json");
} catch {
  hasTypeScript = false;
}

run(process.execPath, [join(root, "sync-version.js")]);

if (hasTypeScript) {
  run(process.execPath, [require.resolve("typescript/bin/tsc")]);
  console.log("✅ Built dist/ from source");
} else if (existsSync(join(root, "dist", "index.js"))) {
  console.log("ℹ️  No TypeScript toolchain (expected for a global install) — using the committed dist/");
} else {
  console.error("❌ No TypeScript toolchain and no committed dist/ to fall back on.");
  process.exit(1);
}
