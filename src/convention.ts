import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScopePaths } from "./scope.js";

export const BEGIN_MARKER = "<!-- agentlink:begin v1 -->";
export const END_MARKER = "<!-- agentlink:end -->";

/**
 * The clause agentlink appends to AGENTS.md.
 *
 * Its job is to tell a *future agent* — one that has never heard of agentlink —
 * where documentation and skills belong and how to name them, so the convention
 * survives without a human enforcing it.
 */
export const CLAUSE = `${BEGIN_MARKER}
## Agent docs and skills: one source of truth

This repository keeps exactly one copy of every agent instruction file and skill.
Paths such as \`CLAUDE.md\`, \`GEMINI.md\`, \`.claude/skills/\` and \`.cursor/skills/\`
are symlinks maintained by \`agentlink\`. Never edit a symlink, and never create a
file next to one — edit or create the source it points to.

- **Instructions** live in \`AGENTS.md\` at the repository root.
- **Skills** live in \`.agents/skills/<skill-name>/SKILL.md\`, one directory per skill.
- **Extra documentation** goes under \`.agents/\` (for example \`.agents/testing.md\`),
  or in an \`AGENTS.md\` in the subdirectory it applies to.
- **Naming**: the skill directory and its frontmatter \`name\` are the same
  lowercase-hyphenated string, 1-64 characters (\`pdf-forms\`, not \`PDF_Forms\`).
  \`SKILL.md\` needs frontmatter with \`name\` and a \`description\` that states what
  the skill does *and* when to use it. Keep scripts and references inside the
  skill directory and link them with relative paths.
- **After adding, renaming, or moving a skill or doc**, run \`npx agentlink sync\`
  so every harness picks up the change.
${END_MARKER}`;

export interface ClauseResult {
  changed: boolean;
  action: "inserted" | "updated" | "unchanged" | "created-file";
  file: string;
}

export function hasClause(text: string): boolean {
  return text.includes(BEGIN_MARKER);
}

/** Insert the clause, or replace the existing one in place. Idempotent. */
export function upsertClause(text: string): { text: string; changed: boolean; action: ClauseResult["action"] } {
  const start = text.indexOf(BEGIN_MARKER);
  if (start !== -1) {
    const end = text.indexOf(END_MARKER, start);
    if (end !== -1) {
      const existing = text.slice(start, end + END_MARKER.length);
      if (existing === CLAUSE) return { text, changed: false, action: "unchanged" };
      return {
        text: text.slice(0, start) + CLAUSE + text.slice(end + END_MARKER.length),
        changed: true,
        action: "updated",
      };
    }
  }
  const trimmed = text.replace(/\s+$/, "");
  const separator = trimmed.length === 0 ? "" : "\n\n";
  return { text: `${trimmed}${separator}${CLAUSE}\n`, changed: true, action: "inserted" };
}

export function ensureClause(
  paths: ScopePaths,
  options: { dryRun?: boolean } = {},
): ClauseResult {
  const file = paths.instructions;
  if (!existsSync(file)) {
    return { changed: false, action: "unchanged", file };
  }
  const before = readFileSync(file, "utf8");
  const { text, changed, action } = upsertClause(before);
  if (changed && !options.dryRun) writeFileSync(file, text, "utf8");
  return { changed, action, file };
}

/** Create AGENTS.md and .agents/skills/ when they do not exist yet. */
export function initConvention(
  paths: ScopePaths,
  options: { dryRun?: boolean } = {},
): { createdFile: boolean; createdSkillsDir: boolean; file: string; skills: string } {
  const createdFile = !existsSync(paths.instructions);
  if (createdFile && !options.dryRun) {
    const title = path.basename(paths.root) || "project";
    const heading = paths.scope === "global" ? "Global agent instructions" : title;
    writeFileSync(
      paths.instructions,
      `# ${heading}\n\n<!-- One or two sentences: what this is, who it is for. -->\n\n## How to work\n\n<!-- Build, test and review commands; conventions that apply everywhere. -->\n\n${CLAUSE}\n`,
      "utf8",
    );
  } else if (!options.dryRun) {
    ensureClause(paths, options);
  }

  const createdSkillsDir = !existsSync(paths.skills);
  if (createdSkillsDir && !options.dryRun) mkdirSync(paths.skills, { recursive: true });

  return {
    createdFile,
    createdSkillsDir,
    file: paths.instructions,
    skills: paths.skills,
  };
}

export interface AdoptResult {
  performed: boolean;
  reason?: string;
  from?: string;
  to?: string;
}

/**
 * Migrate a harness instructions file into the canonical AGENTS.md.
 *
 * Only the unambiguous case is handled: AGENTS.md is absent and exactly one real
 * (non-symlink) harness file exists. A rename keeps `git log --follow` intact and
 * leaves the old path as a symlink afterwards. When both files exist as real
 * content, merging is a judgement call and we refuse.
 */
export function adoptInstructions(
  paths: ScopePaths,
  options: { dryRun?: boolean; force?: boolean } = {},
): AdoptResult {
  const candidates = ["CLAUDE.md", "GEMINI.md", "QWEN.md", "CRUSH.md", "WARP.md", "CONTEXT.md"];
  const present = candidates
    .map((name) => path.join(paths.root, name))
    .filter((file) => existsSync(file) && !isSymlink(file));

  if (existsSync(paths.instructions) && !isSymlink(paths.instructions)) {
    if (present.length > 0) {
      return {
        performed: false,
        reason: `AGENTS.md and ${present.map((p) => path.basename(p)).join(", ")} both contain real content — merge by hand, then re-run`,
      };
    }
    return { performed: false, reason: "AGENTS.md already exists" };
  }

  if (present.length === 0) return { performed: false, reason: "no harness instructions file to adopt" };
  if (present.length > 1) {
    return {
      performed: false,
      reason: `${present.length} candidate files (${present.map((p) => path.basename(p)).join(", ")}) — pick one with --from`,
    };
  }

  const from = present[0] as string;
  if (options.dryRun) {
    return { performed: false, reason: "dry run", from, to: paths.instructions };
  }
  renameSync(from, paths.instructions);
  return { performed: true, from, to: paths.instructions };
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
