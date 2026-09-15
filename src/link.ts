import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
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
  skillsFound: string[];
}

/** Build the full set of links for a scope without touching the filesystem. */
export function plan(paths: ScopePaths, harnesses: Harness[]): Plan {
  const ops = new Map<string, LinkOp>();
  const skips: SkipOp[] = [];
  const native: Plan["native"] = [];
  const unknown: Plan["unknown"] = [];

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

  return { ops: [...ops.values()], skips, native, unknown, skillsFound: skills };
}

export type LinkState = "linked" | "relinked" | "unchanged" | "skipped";

export interface ApplyResult {
  op: LinkOp;
  state: LinkState;
  detail?: string;
}

export function apply(paths: ScopePaths, plan: Plan, options: { dryRun?: boolean } = {}): ApplyResult[] {
  return plan.ops.map((op) => createLink(paths, op, options));
}

function createLink(paths: ScopePaths, op: LinkOp, options: { dryRun?: boolean }): ApplyResult {
  const existing = inspect(op.target);

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

  return {
    op,
    state: "skipped",
    detail:
      existing.kind === "dir"
        ? "a real directory sits here — move its contents into .agents/skills and re-run"
        : "a real file sits here — merge it into AGENTS.md (or run `agentlink adopt`)",
  };
}

/**
 * A path agentlink owns: either the canonical AGENTS.md it links aliases to,
 * or anything inside <root>/.agents. Only these are safe to replace or delete.
 */
function isOwned(paths: ScopePaths, target: string | undefined): boolean {
  if (!target) return false;
  if (target === paths.instructions) return true;
  const owned = `${paths.agentsDir}${path.sep}`;
  return target === paths.agentsDir || target.startsWith(owned);
}

interface Inspection {
  kind: "missing" | "symlink" | "file" | "dir";
  resolved?: string;
}

function inspect(target: string): Inspection {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return { kind: "missing" };
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
  links: { path: string; source: string }[];
}

export function readState(paths: ScopePaths): State {
  try {
    const parsed = JSON.parse(readFileSync(paths.stateFile, "utf8")) as State;
    if (parsed?.version === 1) return parsed;
  } catch {
    /* first run */
  }
  return { version: 1, scope: paths.scope, harnesses: [], links: [] };
}

export function writeState(paths: ScopePaths, state: State): void {
  mkdirSync(paths.agentsDir, { recursive: true });
  writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Fold this run's results into the previous state. */
export function mergeState(
  paths: ScopePaths,
  previous: State,
  results: ApplyResult[],
  harnessIds: string[],
): State {
  const links = new Map(previous.links.map((link) => [link.path, link]));
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

export { inspect, isOwned };
