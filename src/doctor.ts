import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { hasClause, CLAUSE } from "./convention.js";
import type { Harness } from "./harnesses.js";
import { ignoreEntries, isIgnoreMode, readIgnoreBlock } from "./ignore.js";
import { inspect, plan, readState } from "./link.js";
import { listSubdirectories, type ScopePaths } from "./scope.js";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  message: string;
  fix?: string;
}

export interface SkillRecord {
  name: string;
  dir: string;
  frontmatter: { name?: string; description?: string };
}

export function readSkills(paths: ScopePaths): SkillRecord[] {
  return listSubdirectories(paths.skills).map((name) => {
    const dir = path.join(paths.skills, name);
    const skillFile = findSkillFile(dir);
    return {
      name,
      dir,
      frontmatter: skillFile ? parseFrontmatter(readFileSync(skillFile, "utf8")) : {},
    };
  });
}

/** SKILL.md at the skill root, or one level down for grouping folders. */
export function findSkillFile(dir: string, depth = 0): string | undefined {
  const direct = path.join(dir, "SKILL.md");
  if (existsSync(direct)) return direct;
  if (depth >= 2) return undefined;
  for (const child of listSubdirectories(dir)) {
    const found = findSkillFile(path.join(dir, child), depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const read = (key: string): string | undefined => {
    const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!match?.[1]) return undefined;
    return match[1].trim().replace(/^["']|["']$/g, "");
  };
  return { name: read("name"), description: read("description") };
}

export interface DoctorInput {
  paths: ScopePaths;
  harnesses: Harness[];
  home: string;
}

export function diagnose({ paths, harnesses }: DoctorInput): Finding[] {
  const findings: Finding[] = [];

  // --- the convention itself ------------------------------------------------
  if (!existsSync(paths.instructions)) {
    findings.push({
      severity: "error",
      message: `${label(paths, paths.instructions)} is missing`,
      fix: "agentlink init",
    });
  } else {
    const text = readFileSync(paths.instructions, "utf8");
    if (!hasClause(text)) {
      findings.push({
        severity: "warn",
        message: `${path.basename(paths.instructions)} does not explain the convention to agents`,
        fix: "agentlink sync  (appends the agentlink clause)",
      });
    } else if (!text.includes(CLAUSE)) {
      findings.push({
        severity: "info",
        message: `${path.basename(paths.instructions)} has an outdated agentlink clause`,
        fix: "agentlink sync",
      });
    }
  }

  if (!existsSync(paths.skills)) {
    findings.push({
      severity: "warn",
      message: `${short(paths, paths.skills)} does not exist`,
      fix: "agentlink init",
    });
  }

  // --- skills ---------------------------------------------------------------
  const skills = readSkills(paths);
  const rootMarkdown = safeReadDir(paths.skills).filter((name) => name.endsWith(".md"));
  for (const file of rootMarkdown) {
    findings.push({
      severity: "warn",
      message: `${short(paths, path.join(paths.skills, file))} sits at the root of .agents/skills`,
      fix: "move it into .agents/skills/<skill-name>/SKILL.md — root Markdown is ignored by the spec",
    });
  }

  for (const skill of skills) {
    const name = skill.frontmatter.name;
    if (!existsSync(path.join(skill.dir, "SKILL.md"))) {
      if (!skill.frontmatter.name) {
        findings.push({
          severity: "error",
          message: `.agents/skills/${skill.name} has no SKILL.md`,
          fix: "add SKILL.md with `name` and `description` frontmatter",
        });
      }
      continue;
    }
    if (!name) {
      findings.push({
        severity: "error",
        message: `.agents/skills/${skill.name}/SKILL.md has no \`name\` frontmatter`,
        fix: "add `name:` matching the directory name",
      });
      continue;
    }
    if (name !== skill.name) {
      findings.push({
        severity: "warn",
        message: `.agents/skills/${skill.name} declares name \`${name}\``,
        fix: "keep the directory name and frontmatter name identical so other harnesses resolve it",
      });
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      findings.push({
        severity: "error",
        message: `skill name \`${name}\` is not lowercase-hyphenated, 1-64 chars`,
      });
    }
    if (!skill.frontmatter.description) {
      findings.push({
        severity: "error",
        message: `.agents/skills/${skill.name}/SKILL.md has no \`description\``,
        fix: "describe what the skill does and when to use it",
      });
    }
  }

  // --- links ----------------------------------------------------------------
  const desired = plan(paths, harnesses);
  for (const op of desired.ops) {
    const existing = inspect(op.target);
    if (existing.kind === "missing") {
      findings.push({
        severity: "warn",
        message: `${short(paths, op.target)} is not linked (${op.harnessIds.join(", ")})`,
        fix: "agentlink sync",
      });
    } else if (existing.kind === "symlink" && existing.resolved !== op.source) {
      findings.push({
        severity: "warn",
        message: `${short(paths, op.target)} points at ${short(paths, existing.resolved ?? "")}`,
        fix: "agentlink sync",
      });
    } else if (existing.kind === "file" || existing.kind === "dir") {
      // A real copy where a link belongs: duplicates drift apart.
      if (op.kind === "instructions") {
        findings.push({
          severity: "error",
          message: `${short(paths, op.target)} is a real file, not a symlink — two copies of your instructions`,
          fix: "agentlink adopt  (renames it to AGENTS.md and links back)",
        });
      } else if (directoryHasContent(op.target)) {
        findings.push({
          severity: "warn",
          message: `${short(paths, op.target)} is a real copy of skill \`${op.skill}\``,
          fix: `agentlink fix  (moves or removes it; the canonical copy is .agents/skills/${op.skill})`,
        });
      }
    }
  }

  for (const harness of harnesses) {
    if (!harness.verified) {
      const scopesForHarness = [harness.instructions[paths.scope], harness.skills[paths.scope]];
      if (scopesForHarness.some((endpoint) => endpoint.alias)) {
        findings.push({
          severity: "info",
          message: `${harness.label}: link paths are unverified — see ${harness.source}`,
        });
      }
    }
  }

  // Unignored links turn up as untracked files in every `git status`.
  const state = readState(paths);
  const mode = isIgnoreMode(state.ignore) ? state.ignore : "skills";
  if (paths.scope === "project" && existsSync(path.join(paths.root, ".git")) && mode !== "none") {
    const expected = ignoreEntries(mode, {
      skillDirs: [...new Set(desired.ops.filter((op) => op.kind === "skill").map((op) => path.posix.dirname(op.rel)))],
      instructionFiles: [...new Set(desired.ops.filter((op) => op.kind === "instructions").map((op) => op.rel))],
    });
    const actual = readIgnoreBlock(paths);
    const missing = expected.filter((entry) => !actual.includes(entry));
    if (missing.length > 0) {
      findings.push({
        severity: "warn",
        message: `${missing.length} linked path${missing.length === 1 ? "" : "s"} would show up as untracked: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}`,
        fix: "agentlink sync",
      });
    }
  }

  const stale = desired.skips.filter((skip) => skip.reason.startsWith("AGENTS.md does not exist"));
  for (const skip of stale) {
    if (existsSync(path.join(paths.root, skip.rel))) {
      findings.push({
        severity: "info",
        message: `${short(paths, path.join(paths.root, skip.rel))} exists but AGENTS.md does not`,
      });
    }
  }

  return findings;
}

function directoryHasContent(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function short(paths: ScopePaths, absolute: string): string {
  return path.relative(paths.root, absolute) || ".";
}

function label(paths: ScopePaths, absolute: string): string {
  return path.join(paths.scope === "global" ? "~" : ".", short(paths, absolute));
}
