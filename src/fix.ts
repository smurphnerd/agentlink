import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";
import type { Harness } from "./harnesses.js";
import { inspect } from "./link.js";
import { listSubdirectories, relativeTo, type ScopePaths } from "./scope.js";

export type FixKind = "move" | "remove-identical" | "conflict" | "already-linked";

export interface FixAction {
  /** Path relative to the scope root, inside a harness directory. */
  target: string;
  /** Path relative to the scope root, in the canonical tree. */
  canonical: string;
  kind: FixKind;
  skill?: string;
  detail?: string;
}

/**
 * Find real copies sitting where a symlink belongs.
 *
 * A copy is cheap to resolve when the canonical tree has nothing at that name
 * (move it in) or has an identical directory (delete the copy). When the two
 * differ, nothing is guessed: the caller reports both paths and stops, unless
 * the user explicitly asks for the canonical copy to win.
 */
export function planFixes(paths: ScopePaths, harnesses: Harness[]): FixAction[] {
  const actions: FixAction[] = [];
  const seen = new Set<string>();

  for (const harness of harnesses) {
    // Skills: scan the harness directory itself, since an orphan copy exists
    // precisely when the canonical tree has nothing at that name.
    const skills = harness.skills[paths.scope];
    if (!skills.native && skills.alias) {
      const dir = path.join(paths.root, skills.alias);
      for (const name of listSubdirectories(dir)) {
        const target = path.join(dir, name);
        const rel = relativeTo(paths.root, target);
        if (seen.has(rel)) continue;
        seen.add(rel);

        // Symlinks are already correct; inspect() reports them separately.
        if (inspect(target).kind !== "dir" && inspect(target).kind !== "file") continue;

        const source = path.join(paths.skills, name);
        const canonical = relativeTo(paths.root, source);
        if (!existsSync(source)) {
          actions.push({ target: rel, canonical, kind: "move", skill: name });
        } else if (hashTree(target) === hashTree(source)) {
          actions.push({ target: rel, canonical, kind: "remove-identical", skill: name });
        } else {
          actions.push({ target: rel, canonical, kind: "conflict", skill: name, detail: "both copies differ" });
        }
      }
    }

    // Instructions: a real file where a symlink belongs needs a human merge.
    const instructions = harness.instructions[paths.scope];
    if (!instructions.native && instructions.alias && existsSync(paths.instructions)) {
      const target = path.join(paths.root, instructions.alias);
      const rel = relativeTo(paths.root, target);
      if (!seen.has(rel) && inspect(target).kind === "file") {
        seen.add(rel);
        actions.push({
          target: rel,
          canonical: relativeTo(paths.root, paths.instructions),
          kind: "conflict",
          detail: "two copies of your instructions",
        });
      }
    }
  }

  return actions;
}

export interface FixResult extends FixAction {
  performed: boolean;
}

export function applyFixes(
  paths: ScopePaths,
  actions: FixAction[],
  options: { dryRun?: boolean; force?: boolean } = {},
): FixResult[] {
  return actions.map((action) => {
    if (action.kind === "conflict" && !options.force) return { ...action, performed: false };
    if (options.dryRun) return { ...action, performed: false };

    const target = path.join(paths.root, action.target);
    const canonical = path.join(paths.root, action.canonical);

    if (action.kind === "move") {
      mkdirSync(path.dirname(canonical), { recursive: true });
      renameSync(target, canonical);
      pruneEmptyParents(path.dirname(target), paths.root);
      return { ...action, performed: true };
    }

    if (action.kind === "remove-identical" || action.kind === "conflict") {
      rmSync(target, { recursive: true, force: true });
      pruneEmptyParents(path.dirname(target), paths.root);
      return { ...action, performed: true };
    }

    return { ...action, performed: false };
  });
}

/** Stable hash of a directory tree, tolerant of line-ending differences. */
export function hashTree(dir: string): string {
  const hash = createHash("sha256");
  walk(dir, "", hash);
  return hash.digest("hex");
}

function walk(current: string, prefix: string, hash: ReturnType<typeof createHash>): void {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      hash.update(`link ${rel} ${safeReadlink(full)}\n`);
    } else if (entry.isDirectory()) {
      hash.update(`dir ${rel}\n`);
      walk(full, rel, hash);
    } else {
      hash.update(`file ${rel} ${hashFile(full)}\n`);
    }
  }
}

function hashFile(file: string): string {
  try {
    const buffer = readFileSync(file);
    // Treat CRLF and LF files as equal so a Windows-authored copy is not
    // reported as a conflict.
    const isBinary = buffer.includes(0);
    const content = isBinary ? buffer : Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n"));
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "unreadable";
  }
}

function safeReadlink(file: string): string {
  try {
    return readlinkSync(file);
  } catch {
    return "?";
  }
}

function pruneEmptyParents(dir: string, root: string): void {
  let current = dir;
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export { lstatSync };
