import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { hasClause, CLAUSE, BEGIN_MARKER } from "./convention.js";
import { endpointVerified, unverifiedEndpoints, type Harness } from "./harnesses.js";
import { ignoreEntries, isIgnoreMode, readIgnoreBlock } from "./ignore.js";
import { inspect, plan, readState } from "./link.js";
import { listHiddenSubdirectories, listSubdirectories, type ScopePaths } from "./scope.js";

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
  hasDirectSkillFile: boolean;
  hasNestedSkillFile: boolean;
}

export function readSkills(paths: ScopePaths): SkillRecord[] {
  return listSubdirectories(paths.skills).map((name) => {
    const dir = path.join(paths.skills, name);
    const direct = path.join(dir, "SKILL.md");
    const hasDirectSkillFile = existsSync(direct);
    return {
      name,
      dir,
      hasDirectSkillFile,
      hasNestedSkillFile: !hasDirectSkillFile && findNestedSkillFile(dir, 1) !== undefined,
      frontmatter: hasDirectSkillFile ? parseFrontmatter(readFileSync(direct, "utf8")) : {},
    };
  });
}

/** A SKILL.md in a subdirectory, which only some harnesses read. */
export function findNestedSkillFile(dir: string, depth = 0): string | undefined {
  const direct = path.join(dir, "SKILL.md");
  if (existsSync(direct)) return direct;
  if (depth >= 2) return undefined;
  for (const child of listSubdirectories(dir)) {
    const found = findNestedSkillFile(path.join(dir, child), depth + 1);
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
}

/**
 * Report the problems a user can act on.
 *
 * Missing or misdirected links for a selected harness are errors, not warnings:
 * the whole promise of the tool is that the harness reads what you wrote, and a
 * repository that fails that should not pass a CI check.
 */
export function diagnose({ paths, harnesses }: DoctorInput): Finding[] {
  const findings: Finding[] = [];

  // With nothing selected there are no links to check. Say so, rather than
  // reporting a clean bill of health that was never actually earned: a CI
  // runner has no harnesses installed, so this is reachable on every run.
  if (harnesses.length === 0) {
    findings.push({
      severity: "warn",
      message: "no harnesses are selected or installed, so only the convention was checked",
      fix: "agentlink init, or pass --harnesses to check a specific set",
    });
  }

  // --- the convention itself ------------------------------------------------
  const instructionsExist = existsSync(paths.instructions);
  if (!instructionsExist) {
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
        message: `${path.basename(paths.instructions)} has an outdated agentlink clause, or an unterminated one`,
        fix: "agentlink sync, then check the section by hand",
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
  for (const file of safeReadDir(paths.skills).filter((name) => name.endsWith(".md"))) {
    findings.push({
      severity: "warn",
      message: `${short(paths, path.join(paths.skills, file))} sits at the root of .agents/skills`,
      fix: "move it into .agents/skills/<skill-name>/SKILL.md — root Markdown is not a skill",
    });
  }

  for (const hidden of listHiddenSubdirectories(paths.skills)) {
    findings.push({
      severity: "info",
      message: `.agents/skills/${hidden} starts with a dot, so it is skipped`,
      fix: "rename it without the dot to publish it as a skill",
    });
  }

  for (const name of safeReadDir(paths.skills)) {
    const entry = path.join(paths.skills, name);
    if (name.startsWith(".") || name.endsWith(".md")) continue;
    const kind = inspect(entry).kind;
    if (kind === "symlink") {
      const target = (inspect(entry) as { resolved?: string }).resolved;
      if (!target || !existsSync(target)) {
        findings.push({
          severity: "error",
          message: `.agents/skills/${name} is a broken symlink`,
          fix: "remove it or point it at a directory that exists",
        });
      }
      continue;
    }
    if (kind === "error") {
      findings.push({
        severity: "error",
        message: `.agents/skills/${name} cannot be read`,
        fix: "check permissions on the path",
      });
    }
  }

  for (const skill of readSkills(paths)) {
    if (!skill.hasDirectSkillFile) {
      findings.push({
        severity: "error",
        message: skill.hasNestedSkillFile
          ? `.agents/skills/${skill.name} has no SKILL.md directly inside, only nested ones — most harnesses will not find it`
          : `.agents/skills/${skill.name} has no SKILL.md`,
        fix: "put SKILL.md at .agents/skills/<skill-name>/SKILL.md",
      });
      continue;
    }
    const name = skill.frontmatter.name;
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
        fix: "keep the directory name and frontmatter name identical so every harness resolves it",
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
        severity: "error",
        message: `${short(paths, op.target)} is not linked (${op.harnessIds.join(", ")})`,
        fix: "agentlink sync",
      });
    } else if (existing.kind === "symlink" && existing.resolved !== op.source) {
      findings.push({
        severity: "error",
        message: `${short(paths, op.target)} points at ${short(paths, existing.resolved ?? "")}`,
        fix: "agentlink sync",
      });
    } else if (existing.kind === "file" || existing.kind === "dir") {
      if (op.kind === "instructions") {
        findings.push({
          severity: "error",
          message: `${short(paths, op.target)} is a real ${existing.kind}, not a symlink — two copies of your instructions`,
          fix: "agentlink adopt  (moves it to AGENTS.md and links back)",
        });
      } else {
        // Reported even when empty: an empty directory still blocks the link.
        findings.push({
          severity: "error",
          message: `${short(paths, op.target)} is a real ${existing.kind} instead of a link to skill \`${op.skill}\``,
          fix: `agentlink fix  (the canonical copy is .agents/skills/${op.skill})`,
        });
      }
    }
  }

  // --- honesty about the table ---------------------------------------------
  for (const harness of harnesses) {
    for (const { kind, endpoint } of unverifiedEndpoints(harness, paths.scope)) {
      const where = endpoint.native ? "native path" : endpoint.alias;
      findings.push({
        severity: "info",
        message: `${harness.label}: ${kind} ${where} is not confirmed by ${harness.source}`,
      });
    }
  }

  // --- gitignore ------------------------------------------------------------
  const state = readState(paths);
  const mode = isIgnoreMode(state.ignore) ? state.ignore : "skills";  if (paths.scope === "project" && existsSync(path.join(paths.root, ".git")) && mode !== "none") {
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

  return findings;
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

export { statSync, BEGIN_MARKER };
