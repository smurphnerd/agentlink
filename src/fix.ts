import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import type { Harness } from "./harnesses.js";
import { inspect, isOwned, isInside, pruneEmptyParents } from "./link.js";
import { listSubdirectories, relativeTo, type ScopePaths } from "./scope.js";

export type FixKind = "move" | "remove-identical" | "conflict";

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
    const skills = harness.skills[paths.scope];
    if (!skills.native && skills.alias) {
      const dir = path.join(paths.root, skills.alias);
      // A harness directory that is itself a symlink into the canonical tree
      // would make every entry look like an identical duplicate of itself.
      // Acting on that would delete the canonical skills.
      if (isInsideCanonical(paths, dir)) continue;

      for (const name of listSubdirectories(dir)) {
        const target = path.join(dir, name);
        const rel = relativeTo(paths.root, target);
        if (seen.has(rel)) continue;
        seen.add(rel);

        // Only real directories are copies. Symlinks are already correct, and
        // a symlinked directory is resolved through, never replaced.
        if (inspect(target).kind !== "dir") continue;
        if (isInsideCanonical(paths, target)) continue;

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

    // Instructions: a real file or directory where a symlink belongs needs a human.
    const instructions = harness.instructions[paths.scope];
    if (!instructions.native && instructions.alias && existsSync(paths.instructions)) {
      const target = path.join(paths.root, instructions.alias);
      const rel = relativeTo(paths.root, target);
      const kind = inspect(target).kind;
      if (!seen.has(rel) && (kind === "file" || kind === "dir")) {
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

/** True when `candidate` is the canonical skills tree, or inside it. */
function isInsideCanonical(paths: ScopePaths, candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return false;
  }
  let skillsReal: string;
  try {
    skillsReal = realpathSync(paths.skills);
  } catch {
    return false;
  }
  if (isInside(skillsReal, real)) return true;
  try {
    // Resolving the parent catches a canonical entry that is itself a symlink
    // into .agents, which realpath already collapsed above.
    return isInside(realpathSync(paths.agentsDir), real);
  } catch {
    return false;
  }
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

    const target = path.join(paths.root, action.target);
    const canonical = path.join(paths.root, action.canonical);

    // Never touch anything that is not inside the scope root, and never touch
    // the canonical tree itself.
    if (!isInside(paths.root, target) || isOwned(paths, target)) {
      return { ...action, performed: false, detail: "refused: outside the scope root" };
    }
    if (options.dryRun) return { ...action, performed: false };

    try {
      if (action.kind === "move") {
        mkdirSync(path.dirname(canonical), { recursive: true });
        renameSync(target, canonical);
      } else {
        rmSync(target, { recursive: true, force: true });
      }
      pruneEmptyParents(path.dirname(target), paths.root);
      return { ...action, performed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...action, performed: false, detail: `failed: ${message}` };
    }
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
  } catch (error) {
    // An unreadable directory must not look like an empty one.
    hash.update(`unreadable ${prefix} ${(error as NodeJS.ErrnoException)?.code ?? "?"}\n`);
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
  } catch (error) {
    // A constant sentinel would make two different unreadable files compare
    // equal, which would pick "identical" and delete one of them.
    const code = (error as NodeJS.ErrnoException)?.code ?? "?";
    return `unreadable:${code}:${Buffer.from(file).toString("base64")}`;
  }
}

function safeReadlink(file: string): string {
  try {
    return readlinkSync(file);
  } catch {
    return "?";
  }
}
