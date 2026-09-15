import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type Scope = "project" | "global";

/**
 * Everything agentlink needs to know about *where* it is working.
 *
 * The convention has exactly two roots: a repository root (project scope) and
 * $HOME (global scope). Both hold the same three things:
 *
 *   <root>/AGENTS.md              instructions, source of truth
 *   <root>/.agents/skills/<name>  skills, source of truth
 *   <root>/.agents/agentlink.json what agentlink has linked
 */
export interface ScopePaths {
  scope: Scope;
  root: string;
  agentsDir: string;
  instructions: string;
  skills: string;
  stateFile: string;
}

export function resolveScope(scope: Scope, cwd: string): ScopePaths {
  const root = scope === "global" ? homedir() : (findRepoRoot(cwd) ?? cwd);
  const agentsDir = path.join(root, ".agents");
  return {
    scope,
    root,
    agentsDir,
    instructions: path.join(root, "AGENTS.md"),
    skills: path.join(agentsDir, "skills"),
    stateFile: path.join(agentsDir, "agentlink.json"),
  };
}

/**
 * Walk up for a `.git` entry (directory, or a file for linked worktrees).
 * Returns null when no repository root exists above cwd.
 */
export function findRepoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  return input;
}

export function exists(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Names of the immediate subdirectories of `dir`, sorted; `[]` when missing. */
export function listSubdirectories(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      names.push(entry.name);
    } else if (entry.isSymbolicLink()) {
      // A symlink is only a skill if it resolves to a directory. A dangling or
      // file-valued link would otherwise become a broken link in every harness.
      try {
        if (statSync(path.join(dir, entry.name)).isDirectory()) names.push(entry.name);
      } catch {
        /* broken symlink: reported by doctor, never linked */
      }
    }
  }
  return names.sort();
}

/** Names of dot-directories, which the convention reserves and skips. */
export function listHiddenSubdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function relativeTo(fromDir: string, target: string): string {
  const rel = path.relative(fromDir, target);
  return rel === "" ? "." : rel;
}
