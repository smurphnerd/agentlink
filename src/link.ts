import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Harness } from "./harnesses.js";
import { listSubdirectories, relativeTo, type ScopePaths } from "./scope.js";

export type LinkKind = "instructions" | "skill";

export interface LinkOp {
  /** Absolute path of the symlink to create. */
  target: string;
  /** Absolute path of the canonical source it points at. */
  source: string;
  /** `target` relative to the scope root, for state and display. */
  rel: string;
  kind: LinkKind;
  skill?: string;
  harnessIds: string[];
}

export interface SkipOp {
  target: string;
  rel: string;
  kind: LinkKind;
  harnessIds: string[];
  reason: string;
}

export interface Plan {
  ops: LinkOp[];
  skips: SkipOp[];
  /** Harnesses that already read the canonical path; nothing to create. */
  native: { harnessId: string; kind: LinkKind }[];
  /** Harnesses whose path for this scope has no documented answer. */
  unknown: { harnessId: string; kind: LinkKind }[];
  /**
   * Harness directories that are themselves symlinks to the canonical tree.
   * Already correct, so no links are planned, but still derived paths that
   * belong in .gitignore.
   */
  aliases: { rel: string; harnessId: string }[];
  skillsFound: string[];
}

/** True when `dir` resolves to the same place as the canonical skills tree. */
function resolvesToCanonicalSkills(paths: ScopePaths, dir: string): boolean {
  try {
    return realpathSync(dir) === realpathSync(paths.skills);
  } catch {
    return false;
  }
}

/** Build the full set of links for a scope without touching the filesystem. */
export function plan(paths: ScopePaths, harnesses: Harness[]): Plan {
  const ops = new Map<string, LinkOp>();
  const skips: SkipOp[] = [];
  const native: Plan["native"] = [];
  const unknown: Plan["unknown"] = [];
  const aliases: Plan["aliases"] = [];

  const add = (op: Omit<LinkOp, "harnessIds">, harnessId: string) => {
    const existing = ops.get(op.target);
    if (existing) {
      if (!existing.harnessIds.includes(harnessId)) existing.harnessIds.push(harnessId);
      return;
    }
    ops.set(op.target, { ...op, harnessIds: [harnessId] });
  };

  const skip = (op: Omit<SkipOp, "harnessIds">, harnessId: string) => {
    const existing = skips.find((s) => s.target === op.target && s.reason === op.reason);
    if (existing) {
      if (!existing.harnessIds.includes(harnessId)) existing.harnessIds.push(harnessId);
      return;
    }
    skips.push({ ...op, harnessIds: [harnessId] });
  };

  const instructionsExist = existsSync(paths.instructions);
  const skills = listSubdirectories(paths.skills);

  for (const harness of harnesses) {
    const instr = harness.instructions[paths.scope];
    const alias = instr.native ? undefined : instr.alias;
    if (instr.native) {
      native.push({ harnessId: harness.id, kind: "instructions" });
    } else if (!alias) {
      unknown.push({ harnessId: harness.id, kind: "instructions" });
    } else if (!instructionsExist) {
      skip(
        {
          target: path.join(paths.root, alias),
          rel: alias,
          kind: "instructions",
          reason: "AGENTS.md does not exist yet — run `agentlink init` first",
        },
        harness.id,
      );
    } else {
      add(
        {
          target: path.join(paths.root, alias),
          source: paths.instructions,
          rel: alias,
          kind: "instructions",
        },
        harness.id,
      );
    }

    const sk = harness.skills[paths.scope];
    const skillsAlias = sk.native ? undefined : sk.alias;
    if (sk.native) {
      native.push({ harnessId: harness.id, kind: "skill" });
    } else if (!skillsAlias) {
      unknown.push({ harnessId: harness.id, kind: "skill" });
    } else if (resolvesToCanonicalSkills(paths, path.join(paths.root, skillsAlias))) {
      // The harness directory is a symlink to .agents/skills, which is already
      // the arrangement this tool exists to create.
      aliases.push({ rel: skillsAlias, harnessId: harness.id });
    } else if (skills.length === 0) {
      skip(
        {
          target: path.join(paths.root, skillsAlias),
          rel: skillsAlias,
          kind: "skill",
          reason: "no skills in .agents/skills yet",
        },
        harness.id,
      );
    } else {
      for (const skill of skills) {
        add(
          {
            target: path.join(paths.root, skillsAlias, skill),
            source: path.join(paths.skills, skill),
            rel: path.posix.join(skillsAlias, skill),
            kind: "skill",
            skill,
          },
          harness.id,
        );
      }
    }
  }

  return { ops: [...ops.values()], skips, native, unknown, aliases, skillsFound: skills };
}

export type LinkState = "linked" | "relinked" | "unchanged" | "skipped";

export interface ApplyResult {
  op: LinkOp;
  state: LinkState;
  detail?: string;
}

/**
 * Apply a plan. Each op is isolated: one failure is reported as skipped rather
 * than aborting the batch, so links created earlier stay recorded in state and
 * remain removable by `unlink`.
 */
export function apply(paths: ScopePaths, plan: Plan, options: { dryRun?: boolean } = {}): ApplyResult[] {
  return plan.ops.map((op) => {
    try {
      return createLink(paths, op, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { op, state: "skipped" as const, detail: `could not link: ${message}` };
    }
  });
}

function createLink(paths: ScopePaths, op: LinkOp, options: { dryRun?: boolean }): ApplyResult {
  const existing = inspect(op.target);

  if (existing.kind === "error") {
    return { op, state: "skipped", detail: `cannot inspect: ${existing.detail}` };
  }

  if (existing.kind === "missing") {
    if (!options.dryRun) {
      mkdirSync(path.dirname(op.target), { recursive: true });
      symlinkSync(relativeTo(path.dirname(op.target), op.source), op.target);
    }
    return { op, state: "linked" };
  }

  if (existing.kind === "symlink") {
    if (existing.resolved === op.source) return { op, state: "unchanged" };
    if (isOwned(paths, existing.resolved)) {
      if (!options.dryRun) {
        unlinkSync(op.target);
        symlinkSync(relativeTo(path.dirname(op.target), op.source), op.target);
      }
      return { op, state: "relinked" };
    }
    return { op, state: "skipped", detail: `already a symlink to ${existing.resolved}` };
  }

  return { op, state: "skipped", detail: blockerMessage(op, existing.kind) };
}

function blockerMessage(op: LinkOp, kind: "file" | "dir"): string {
  if (op.kind === "instructions") {
    return kind === "dir"
      ? `a directory sits at ${op.rel} — remove it, or point it at AGENTS.md yourself`
      : `a real instructions file sits here — merge it into AGENTS.md and re-run`;
  }
  return kind === "dir"
    ? "a real directory sits here — run `agentlink fix` to fold it into .agents/skills"
    : "a real file sits here — remove it and re-run";
}

/**
 * True when agentlink created a path: the canonical AGENTS.md it links aliases
 * to, or anything inside <root>/.agents. Only these are safe to replace/delete.
 */
function isOwned(paths: ScopePaths, target: string | undefined): boolean {
  if (!target) return false;
  if (target === paths.instructions) return true;
  const owned = `${paths.agentsDir}${path.sep}`;
  return target === paths.agentsDir || target.startsWith(owned);
}

/** True when `target` is inside `root` after normalisation. */
export function isInside(root: string, target: string): boolean {
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

interface Inspection {
  kind: "missing" | "symlink" | "file" | "dir" | "error";
  resolved?: string;
  detail?: string;
}

export function inspect(target: string): Inspection {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // Anything other than "does not exist" (ENOTDIR, EACCES, ELOOP, …) is a
    // real problem the caller must report rather than paper over by writing.
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "error", detail: `${code ?? "unknown error"}` };
  }
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", resolved: path.resolve(path.dirname(target), readlinkSync(target)) };
  }
  return { kind: stat.isDirectory() ? "dir" : "file" };
}

// --- state ------------------------------------------------------------------

export interface State {
  version: 1;
  scope: string;
  harnesses: string[];
  /** Which created links are listed in .gitignore. */
  ignore: string;
  links: { path: string; source: string }[];
}

export function readState(paths: ScopePaths): State {
  try {
    const parsed = JSON.parse(readFileSync(paths.stateFile, "utf8")) as Partial<State>;
    if (parsed?.version === 1) {
      return {
        version: 1,
        scope: parsed.scope ?? paths.scope,
        harnesses: parsed.harnesses ?? [],
        ignore: parsed.ignore ?? "skills",
        // A hand-edited or hostile state file must not let a later unlink reach
        // outside the scope root.
        links: (parsed.links ?? []).filter(
          (link) => typeof link?.path === "string" && isInside(paths.root, link.path),
        ),
      };
    }
  } catch {
    /* first run */
  }
  return { version: 1, scope: paths.scope, harnesses: [], ignore: "skills", links: [] };
}

export function writeState(paths: ScopePaths, state: State): void {
  mkdirSync(paths.agentsDir, { recursive: true });
  writeFileAtomic(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** Write via a temp file and rename, so an interrupted run cannot truncate. */
export function writeFileAtomic(file: string, contents: string): void {
  const temporary = `${file}.agentlink-tmp`;
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, file);
}

/**
 * Remove links agentlink owns that the current plan no longer wants: a
 * deselected harness, or a skill that was renamed or deleted. Without this the
 * old symlinks stay behind and dangle.
 */
export function pruneStale(
  paths: ScopePaths,
  plan: Plan,
  previous: State,
  options: { dryRun?: boolean } = {},
): string[] {
  const wanted = new Set(plan.ops.map((op) => op.rel));
  const removed: string[] = [];

  for (const link of previous.links) {
    if (wanted.has(link.path) || !isInside(paths.root, link.path)) continue;
    const target = path.join(paths.root, link.path);
    const existing = inspect(target);
    if (existing.kind !== "symlink" || !isOwned(paths, existing.resolved)) continue;
    if (!options.dryRun) {
      unlinkSync(target);
      pruneEmptyParents(path.dirname(target), paths.root);
    }
    removed.push(link.path);
  }
  return removed;
}

export interface MergeOptions {
  ignore?: string;
  /** Kept links shrink to this set; pair with pruneStale to delete them. */
  plannedRels?: string[];
}

/** Fold this run's results into the previous state. */
export function mergeState(
  paths: ScopePaths,
  previous: State,
  results: ApplyResult[],
  harnessIds: string[],
  options: MergeOptions = {},
): State {
  const planned = options.plannedRels ? new Set(options.plannedRels) : undefined;
  const links = new Map(
    previous.links.filter((link) => !planned || planned.has(link.path)).map((link) => [link.path, link]),
  );

  for (const result of results) {
    if (result.state === "skipped") continue;
    links.set(result.op.rel, {
      path: result.op.rel,
      source: relativeTo(paths.root, result.op.source),
    });
  }

  return {
    version: 1,
    scope: paths.scope,
    harnesses: harnessIds,
    ignore: options.ignore ?? previous.ignore ?? "skills",
    links: [...links.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export interface UnlinkResult {
  removed: string[];
  kept: { path: string; reason: string }[];
}

/**
 * Remove the symlinks agentlink created. Anything that is no longer a symlink
 * pointing into .agents is left alone and reported instead.
 */
export function unlink(paths: ScopePaths, options: { dryRun?: boolean } = {}): UnlinkResult {
  const state = readState(paths);
  const removed: string[] = [];
  const kept: { path: string; reason: string }[] = [];

  for (const link of state.links) {
    if (!isInside(paths.root, link.path)) {
      kept.push({ path: link.path, reason: "outside this scope" });
      continue;
    }
    const target = path.join(paths.root, link.path);
    const existing = inspect(target);
    if (existing.kind === "missing") continue;
    if (existing.kind !== "symlink") {
      kept.push({ path: link.path, reason: `no longer a symlink (real ${existing.kind})` });
      continue;
    }
    if (!isOwned(paths, existing.resolved)) {
      kept.push({ path: link.path, reason: "points outside .agents now" });
      continue;
    }
    if (!options.dryRun) {
      unlinkSync(target);
      pruneEmptyParents(path.dirname(target), paths.root);
    }
    removed.push(link.path);
  }

  if (!options.dryRun) writeState(paths, { ...state, links: [] });
  return { removed, kept };
}

export function pruneEmptyParents(dir: string, root: string): void {
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

export { isOwned };
