import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AI_TOOLS } from "../types/ai-tools.js";
import { getOpenCodeTemplatePath } from "../templates/extract.js";
import { toPosix } from "../utils/posix.js";
import {
  collectSkillTemplates,
  replacePythonCommandLiterals,
  resolveBundledSkills,
  resolveCommands,
  resolveSkills,
  writeTemplateMap,
} from "./shared.js";

/**
 * Files under packages/cli/src/templates/opencode/ that are NOT user-facing
 * assets (build artifacts, runtime caches, etc.). The plugins themselves are
 * dependency-free plain JS — no package.json ships, so nothing here needs to
 * resolve an npm dependency at OpenCode startup.
 */
const EXCLUDE_PATTERNS = [
  ".d.ts",
  ".d.ts.map",
  ".js.map",
  "__pycache__",
  "node_modules",
  "bun.lock",
  ".gitignore",
];

function shouldExclude(filename: string): boolean {
  for (const pattern of EXCLUDE_PATTERNS) {
    if (filename.endsWith(pattern) || filename === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Walk the opencode template directory and produce a `Map<relPath, content>`
 * rooted at `.opencode/`. Shared by both `configureOpenCode` (init-time write)
 * and `collectOpenCodeTemplates` (update-time hash tracking) so the two paths
 * always agree on the exact file set. `commands/` is handled separately (sourced
 * from common template context, not from this directory tree).
 */
function walkOpenCodeTemplateDir(): Map<string, string> {
  const files = new Map<string, string>();
  const sourcePath = getOpenCodeTemplatePath();

  function walk(relDir: string): void {
    const absDir = path.join(sourcePath, relDir);
    for (const entry of readdirSync(absDir)) {
      if (shouldExclude(entry)) continue;
      const absEntry = path.join(absDir, entry);
      const relEntry = relDir ? path.join(relDir, entry) : entry;
      const stat = statSync(absEntry);
      if (stat.isDirectory()) {
        // Skip commands/ — that's sourced from common/ templates, not the
        // opencode/ dir. Including both paths would double-write.
        if (relEntry === "commands") continue;
        walk(relEntry);
      } else {
        const content = readFileSync(absEntry, "utf-8");
        // Map keys are logical paths used as cross-platform hash keys / lookup
        // keys downstream. Always POSIX, regardless of host OS.
        files.set(
          toPosix(path.join(".opencode", relEntry)),
          replacePythonCommandLiterals(content),
        );
      }
    }
  }

  walk("");
  return files;
}

/**
 * The opencode file set — written at init and diffed by `trellis update`.
 */
export function collectOpenCodeTemplates(): Map<string, string> {
  const files = walkOpenCodeTemplateDir();
  const ctx = AI_TOOLS.opencode.templateContext;
  for (const cmd of resolveCommands(ctx)) {
    files.set(`.opencode/commands/trellis/${cmd.name}.md`, cmd.content);
  }
  for (const [filePath, content] of collectSkillTemplates(
    ".opencode/skills",
    resolveSkills(ctx),
    resolveBundledSkills(ctx),
  )) {
    files.set(filePath, content);
  }
  return files;
}

/**
 * Print the supported OpenCode version floor.
 *
 * Below it the plugins load silently and simply do nothing, which is the
 * hardest failure mode to diagnose — so the note is bilingual (a user who
 * cannot read it would not know to upgrade) and goes to stderr, matching
 * `printZcodeSetupHint`. Silenced under VITEST / TRELLIS_QUIET like that one.
 */
export function printOpenCodeVersionHint(): void {
  if (process.env.VITEST || process.env.TRELLIS_QUIET) return;

  process.stderr.write(
    `ℹ️  OpenCode: requires v1.18.29+ or v2. Earlier v1 builds cannot load the Trellis plugins.\n` +
      `   OpenCode：需要 v1.18.29 及以上，或 v2；更早的 v1 版本无法加载 Trellis 插件。\n`,
  );
}

/**
 * Configure OpenCode at init time: write the collected file set, then the one
 * thing a `Map<path, content>` cannot carry — a console notice (same split as
 * `configureZcode`).
 */
export async function configureOpenCode(cwd: string): Promise<void> {
  await writeTemplateMap(cwd, collectOpenCodeTemplates());
  printOpenCodeVersionHint();
}
