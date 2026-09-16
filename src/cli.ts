#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { adoptInstructions, ensureClause, initConvention, type AdoptResult } from "./convention.js";
import { detectAll } from "./detect.js";
import { diagnose, readSkills } from "./doctor.js";
import { applyFixes, planFixes, type FixResult } from "./fix.js";
import { endpointVerified, HARNESSES, resolveHarnessList, type Harness } from "./harnesses.js";
import { isIgnoreMode, readIgnoreBlock, removeIgnoreBlock, updateGitignore, type IgnoreMode } from "./ignore.js";
import { apply, mergeState, plan, pruneStale, readState, unlink, writeState } from "./link.js";
import { resolveScope, type Scope, type ScopePaths } from "./scope.js";
import { buildHarnessChoices, selectMany } from "./ui.js";

const ESC = String.fromCharCode(27);
// Colour only when something is reading it: a TTY, and not opted out. Piped
// output and CI logs stay free of escape codes.
const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== "0" &&
  (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY === true);
const paint = (code: string): string => (useColor ? `${ESC}[${code}m` : "");
const BOLD = paint("1");
const DIM = paint("2");
const RED = paint("31");
const GREEN = paint("32");
const YELLOW = paint("33");
const CYAN = paint("36");
const RESET = paint("0");;

interface Options {
  command: string;
  scope: Scope;
  harnessIds?: string[];
  all: boolean;
  detected: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  clause: boolean;
  json: boolean;
  verbose: boolean;
  ignore?: IgnoreMode;
}

const COMMANDS = ["init", "sync", "select", "fix", "list", "doctor", "adopt", "unlink", "help", "version"] as const;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: "sync",
    scope: "project",
    all: false,
    detected: false,
    dryRun: false,
    yes: false,
    force: false,
    clause: true,
    json: false,
    verbose: false,
  };
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "-g" || arg === "--global") options.scope = "global";
    else if (arg === "--all") options.all = true;
    else if (arg === "--detected") options.detected = true;
    else if (arg === "--dry-run" || arg === "-n") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--no-clause") options.clause = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose" || arg === "-v") options.verbose = true;
    else if (arg === "--version" || arg === "-V") options.command = "version";
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg.startsWith("--ignore=")) {
      const value = arg.slice("--ignore=".length);
      if (!isIgnoreMode(value)) fail(`--ignore must be one of skills, all, none (got \`${value}\`)`);
      options.ignore = value;
    } else if (arg === "--ignore") options.ignore = "skills";
    else if (arg.startsWith("--harnesses=")) options.harnessIds = split(arg.slice("--harnesses=".length));
    else if (arg === "--harnesses") options.harnessIds = [];
    else if (arg.startsWith("-")) fail(`unknown option \`${arg}\``, true);
    else positional.push(arg);
  }

  const [first] = positional;
  if (first) {
    if ((COMMANDS as readonly string[]).includes(first)) options.command = first;
    else fail(`unknown command \`${first}\` — try \`agentlink help\``);
  }
  if (positional.length > 1) options.harnessIds = split(positional.slice(1).join(","));
  return options;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function split(value: string): string[] {
  return value.split(/[,\s]+/).filter(Boolean);
}

function fail(message: string, usage = false): never {
  process.stderr.write(`${RED}error${RESET} ${message}\n`);
  if (usage) process.stderr.write(`${DIM}run \`agentlink help\`${RESET}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") return help();
  if (options.command === "version") return version();

  const paths = resolveScope(options.scope, process.cwd());

  switch (options.command) {
    case "init":
      return runInit(paths, options);
    case "select":
      return runSelect(paths, options);
    case "sync":
      return runSync(paths, options);
    case "fix":
      return runFix(paths, options);
    case "list":
      return runList(paths, options);
    case "doctor":
      return runDoctor(paths, options);
    case "adopt":
      return runAdopt(paths, options);
    case "unlink":
      return runUnlink(paths, options);
    default:
      return help();
  }
}

// --- commands ---------------------------------------------------------------

async function runInit(paths: ScopePaths, options: Options): Promise<void> {
  const chosen = await chooseHarnesses(paths, options, { prompt: true });

  // A repository that already has real instructions should have them adopted
  // rather than shadowed by a fresh stub.
  const adoption = adoptInstructions(paths, { dryRun: options.dryRun });
  if (adoption.performed && !options.json) {
    step("adopt", `${path.basename(adoption.from ?? "")} → AGENTS.md`);
  } else if (adoption.needsInvert && !options.json) {
    process.stdout.write(`  ${YELLOW}!${RESET} ${adoption.reason}\n`);
  }

  const result = initConvention(paths, { dryRun: options.dryRun });
  if (!options.dryRun) mkdirSync(paths.skills, { recursive: true });

  if (!options.json) {
    const where = paths.scope === "global" ? "~" : ".";
    step(result.createdFile ? "create" : "keep", `${where}/AGENTS.md`);
    step(result.createdSkillsDir ? "create" : "keep", `${where}/.agents/skills/`);
  }

  const fixes = migrateDuplicates(paths, chosen, options);
  await syncLinks(paths, chosen, options, { adoption, fixes });
}

async function runFix(paths: ScopePaths, options: Options): Promise<void> {
  const chosen = await chooseHarnesses(paths, options, { prompt: false });
  if (!existsSync(paths.instructions)) {
    if (!options.json) {
      process.stdout.write(`${DIM}no AGENTS.md here yet — run \`agentlink init\` first${RESET}\n`);
    }
    return;
  }
  const fixes = migrateDuplicates(paths, chosen, options);
  await syncLinks(paths, chosen, options, { fixes });
}

async function runSelect(paths: ScopePaths, options: Options): Promise<void> {
  const chosen = await chooseHarnesses(paths, options, { prompt: true });
  if (!options.json) {
    process.stdout.write(`${DIM}selected:${RESET} ${chosen.map((h) => h.id).join(", ") || "(none)"}\n`);
  }
  await syncLinks(paths, chosen, options, {});
}

async function runSync(paths: ScopePaths, options: Options): Promise<void> {
  const chosen = await chooseHarnesses(paths, options, { prompt: false });
  await syncLinks(paths, chosen, options, {});
}

/** Resolve real copies sitting where a symlink belongs, without guessing. */
function migrateDuplicates(paths: ScopePaths, chosen: Harness[], options: Options): FixResult[] {
  const actions = planFixes(paths, chosen);
  if (actions.length === 0) return [];

  const results = applyFixes(paths, actions, { dryRun: options.dryRun, force: options.force });
  if (options.json) return results;

  for (const result of results) {
    const dry = options.dryRun ? ` ${DIM}(dry run)${RESET}` : "";
    if (result.kind === "move" || result.kind === "remove-identical") {
      if (!result.performed && !options.dryRun) {
        // Refused or failed: say so rather than reporting a clean run.
        process.stdout.write(
          `  ${YELLOW}!${RESET} ${result.target} ${DIM}${result.detail ?? "not migrated"}${RESET}\n`,
        );
        continue;
      }
      if (result.kind === "move") {
        step(options.dryRun ? "would" : "move", `${result.target} → ${result.canonical}${dry}`);
      } else {
        step(
          options.dryRun ? "would" : "cleanup",
          `${result.target} ${DIM}identical to the canonical copy${RESET}${dry}`,
        );
      }
    } else if (result.kind === "conflict") {
      const command = result.skill ? "diff -r" : "diff";
      process.stdout.write(
        `  ${YELLOW}!${RESET} conflict ${result.target} ${DIM}${result.detail ?? ""}${RESET}\n` +
          `    ${DIM}fix: ${command} ${result.target} ${result.canonical}, merge by hand, then \`agentlink fix\`${RESET}\n` +
          `         ${DIM}or \`agentlink fix --force\` to favour the canonical copy${RESET}\n`,
      );
    }
  }
  return results;
}

interface SyncContext {
  adoption?: AdoptResult;
  fixes?: FixResult[];
}

async function syncLinks(
  paths: ScopePaths,
  chosen: Harness[],
  options: Options,
  context: SyncContext,
): Promise<void> {
  const previous = readState(paths);
  const desiredClause = options.clause && existsSync(paths.instructions);

  if (!options.dryRun && !existsSync(paths.skills) && existsSync(paths.instructions)) {
    mkdirSync(paths.skills, { recursive: true });
  }

  const clauseResult = desiredClause ? ensureClause(paths, { dryRun: options.dryRun }) : undefined;

  const linkPlan = plan(paths, chosen);
  const results = apply(paths, linkPlan, { dryRun: options.dryRun });
  const pruned = pruneStale(paths, linkPlan, previous, { dryRun: options.dryRun });

  const mode: IgnoreMode = options.ignore ?? (isIgnoreMode(previous.ignore) ? previous.ignore : "skills");
  const ignoreResult = updateGitignore(
    paths,
    mode,
    {
      skillDirs: unique([
        ...linkPlan.ops.filter((op) => op.kind === "skill").map((op) => path.posix.dirname(op.rel)),
        ...linkPlan.aliases.map((alias) => alias.rel),
      ]),
      instructionFiles: unique(linkPlan.ops.filter((op) => op.kind === "instructions").map((op) => op.rel)),
    },
    { dryRun: options.dryRun },
  );

  if (!options.dryRun) {
    const state = mergeState(paths, previous, results, chosen.map((h) => h.id), {
      ignore: mode,
      plannedRels: linkPlan.ops.map((op) => op.rel),
    });
    writeState(paths, state);
  }

  const conflicts = (context.fixes ?? []).filter((fix) => fix.kind === "conflict" && !fix.performed);
  const blocked = results.filter((result) => result.state === "skipped");
  // Anything skipped here is real content standing where a link belongs, or a
  // path we could not even inspect. Either way it needs a human decision, so the
  // run reports failure. Links that are merely premature (no AGENTS.md yet) are
  // plan shims, not results, and stay quiet.
  const unresolved = blocked.length > 0 || conflicts.length > 0;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scope: paths.scope,
          root: paths.root,
          dryRun: options.dryRun,
          harnesses: chosen.map((h) => h.id),
          adoption: context.adoption ?? null,
          fixes: (context.fixes ?? []).map((fix) => ({
            target: fix.target,
            canonical: fix.canonical,
            kind: fix.kind,
            performed: fix.performed,
          })),
          links: results.map((result) => ({
            path: result.op.rel,
            state: result.state,
            harnesses: result.op.harnessIds,
            detail: result.detail,
          })),
          skipped: linkPlan.skips.map((skip) => ({ path: skip.rel, reason: skip.reason, harnesses: skip.harnessIds })),
          pruned,
          native: linkPlan.native,
          unknown: linkPlan.unknown,
          selection: {
            harnesses: chosen.map((h) => h.id),
            added: chosen.map((h) => h.id).filter((id) => !previous.harnesses.includes(id)),
            removed: previous.harnesses.filter((id) => !chosen.some((h) => h.id === id)),
          },
          aliases: linkPlan.aliases,
          skills: linkPlan.skillsFound,
          conflicts: conflicts.map((fix) => fix.target),
          ignore: {
            mode,
            file: ignoreResult.skipped ? null : ignoreResult.file,
            entries: ignoreResult.entries,
            status: ignoreResult.status,
          },
        },
        null,
        2,
      )}\n`,
    );
    if (unresolved) process.exit(1);
    return;
  }

  const where = paths.scope === "global" ? "~" : path.basename(paths.root);
  process.stdout.write(
    `\n${BOLD}agentlink${RESET} ${DIM}${where} · ${chosen.length} harness${chosen.length === 1 ? "" : "es"}${options.dryRun ? " · dry run" : ""}${RESET}\n`,
  );

  // An explicit --harnesses/--all/--detected changes the saved selection, so
  // say which harnesses that added or dropped rather than letting it pass.
  const selection = selectionChange(previous.harnesses, chosen);
  if (selection) step("select", selection);

  for (const result of results) {
    const symbol =
      result.state === "skipped"
        ? `${YELLOW}!${RESET}`
        : result.state === "unchanged"
          ? `${DIM}=${RESET}`
          : `${GREEN}+${RESET}`;
    const detail = result.detail ? ` ${DIM}${result.detail}${RESET}` : "";
    const verb = options.dryRun && result.state !== "skipped" ? "would link" : result.state;
    process.stdout.write(`  ${symbol} ${result.op.rel} ${DIM}${verb}${RESET}${detail}\n`);
  }

  for (const gone of pruned) {
    process.stdout.write(`  ${DIM}- ${gone} removed (no longer wanted)${RESET}\n`);
  }

  for (const skip of linkPlan.skips) {
    process.stdout.write(`  ${DIM}· ${skip.rel} ${skip.reason}${RESET}\n`);
  }

  if (clauseResult?.action === "malformed") {
    process.stdout.write(
      `  ${YELLOW}!${RESET} ${path.basename(paths.instructions)} has an unterminated agentlink clause — fix it by hand\n`,
    );
  } else if (clauseResult?.changed) {
    step("clause", `${path.basename(paths.instructions)} ${DIM}(${clauseResult.action})${RESET}`);
  }

  if (ignoreResult.status === "malformed") {
    process.stdout.write(
      `  ${YELLOW}!${RESET} .gitignore has an unmatched agentlink marker — remove that line and re-run\n`,
    );
  } else if (!ignoreResult.skipped) {
    const count = ignoreResult.entries.length;
    const suffix = options.dryRun ? ", would update" : "";
    step(
      "ignore",
      ignoreResult.status === "updated"
        ? `.gitignore ${DIM}(${count} entr${count === 1 ? "y" : "ies"}${suffix})${RESET}`
        : `.gitignore ${DIM}(already covers ${count} path${count === 1 ? "" : "s"})${RESET}`,
    );
  }

  const created = results.filter((r) => r.state === "linked" || r.state === "relinked").length;
  const unchanged = results.filter((r) => r.state === "unchanged").length;
  const blockedCount = blocked.length + linkPlan.skips.length;

  process.stdout.write(
    `\n  ${created} ${options.dryRun ? "to link" : "linked"}${unchanged ? `, ${unchanged} already correct` : ""}${pruned.length ? `, ${pruned.length} pruned` : ""}${blockedCount ? `, ${blockedCount} blocked` : ""}, ${linkPlan.native.length} native (nothing to do)\n`,
  );

  for (const alias of linkPlan.aliases) {
    process.stdout.write(`  ${DIM}· ${alias.rel} → .agents/skills (already linked)${RESET}\n`);
  }

  if (blocked.length > 0) {
    process.stdout.write(`  ${DIM}run \`agentlink doctor\` for what to do about the blocked links${RESET}\n`);
  }
  if (!existsSync(paths.instructions)) {
    process.stdout.write(`  ${DIM}no AGENTS.md yet — \`agentlink init\` creates it${RESET}\n`);
  } else if (linkPlan.skillsFound.length === 0) {
    process.stdout.write(`  ${DIM}no skills yet — add one at .agents/skills/<name>/SKILL.md${RESET}\n`);
  }
  if (unresolved) process.exit(1);
}

async function runList(paths: ScopePaths, options: Options): Promise<void> {
  const state = readState(paths);
  const selected = new Set(state.harnesses);
  const rows = detectAll().map(({ harness, installed, reasons }) => ({
    id: harness.id,
    label: harness.label,
    selected: selected.has(harness.id),
    installed,
    reasons,
    instructions: describe(harness.instructions[paths.scope]),
    skills: describe(harness.skills[paths.scope]),
    instructionsVerified: endpointVerified(harness.instructions[paths.scope]),
    skillsVerified: endpointVerified(harness.skills[paths.scope]),
    source: harness.source,
  }));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ scope: paths.scope, root: paths.root, linked: [...selected], harnesses: rows }, null, 2)}\n`,
    );
    return;
  }

  const width = Math.max(...rows.map((row) => row.label.length));
  const installedCount = rows.filter((row) => row.installed).length;
  process.stdout.write(
    `\n${BOLD}harnesses${RESET} ${DIM}· scope: ${paths.scope} · ${selected.size} linked · ${installedCount} installed here${RESET}\n\n`,
  );
  for (const row of rows) {
    // The leading mark is the tool's own state: what is actually linked.
    // Availability is only called out when it is surprising.
    const mark = row.selected ? `${GREEN}✓${RESET}` : `${DIM}·${RESET}`;
    const note =
      row.selected && !row.installed
        ? `  ${YELLOW}selected, not installed${RESET}`
        : !row.selected && row.installed
          ? `  ${DIM}installed, not linked${RESET}`
          : "";
    const flag = !row.instructionsVerified || !row.skillsVerified ? ` ${YELLOW}unverified${RESET}` : "";
    process.stdout.write(
      `  ${mark} ${row.label.padEnd(width)}  ${DIM}instructions${RESET} ${row.instructions}  ${DIM}skills${RESET} ${row.skills}${flag}${note}\n`,
    );
  }
  process.stdout.write(
    `\n  ${GREEN}✓${RESET} linked   ${DIM}·${RESET} not linked   ${DIM}change with \`agentlink select\`${RESET}\n` +
      `  ${DIM}native = harness reads AGENTS.md / .agents/skills itself${RESET}\n` +
      `  ${YELLOW}unverified${RESET} ${DIM}= the vendor's docs do not confirm that path, so the link may sit where nothing reads it.${RESET}\n` +
      `  ${DIM}It is not an error. \`list --json\` prints the source URL for every endpoint.${RESET}\n`,
  );
}

function describe(endpoint: { native: boolean; alias?: string }): string {
  if (endpoint.native) return `${CYAN}native${RESET}`;
  if (!endpoint.alias) return `${DIM}unknown${RESET}`;
  return endpoint.alias;
}

function runDoctor(paths: ScopePaths, options: Options): void {
  const state = readState(paths);
  // An explicit selection wins, so a CI runner with no harnesses installed can
  // still check the set a repository declares. Otherwise fall back to what was
  // recorded, then to what is present on this machine.
  let chosen: Harness[];
  if (options.harnessIds && options.harnessIds.length > 0) {
    const { found, unknown } = resolveHarnessList(options.harnessIds.join(","));
    if (unknown.length) fail(`unknown harness${unknown.length > 1 ? "es" : ""}: ${unknown.join(", ")}`);
    chosen = dedupe(found);
  } else if (state.harnesses.length > 0) {
    chosen = HARNESSES.filter((h) => state.harnesses.includes(h.id));
  } else {
    chosen = detectAll()
      .filter((detection) => detection.installed)
      .map((detection) => detection.harness);
  }
  const findings = diagnose({ paths, harnesses: chosen });
  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scope: paths.scope,
          root: paths.root,
          harnesses: chosen.map((h) => h.id),
          skills: readSkills(paths).map((skill) => skill.name),
          findings,
          errors,
          warnings: warns,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(errors > 0 ? 1 : 0);
  }

  const where = paths.scope === "global" ? "~" : paths.root;
  process.stdout.write(`\n${BOLD}agentlink doctor${RESET} ${DIM}${where}${RESET}\n\n`);
  if (findings.length === 0) {
    process.stdout.write(
      `  ${GREEN}✓${RESET} convention intact${chosen.length ? `, ${chosen.length} harness${chosen.length === 1 ? "" : "es"} selected` : ""}\n\n`,
    );
    return;
  }
  for (const severity of ["error", "warn", "info"] as const) {
    for (const finding of findings.filter((f) => f.severity === severity)) {
      const symbol =
        severity === "error" ? `${RED}✗${RESET}` : severity === "warn" ? `${YELLOW}!${RESET}` : `${DIM}·${RESET}`;
      process.stdout.write(`  ${symbol} ${finding.message}\n`);
      if (finding.fix) process.stdout.write(`    ${DIM}fix: ${finding.fix}${RESET}\n`);
    }
  }
  process.stdout.write(
    `\n  ${errors} error${errors === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}\n\n`,
  );
  process.exit(errors > 0 ? 1 : 0);
}

function runAdopt(paths: ScopePaths, options: Options): void {
  const result = adoptInstructions(paths, { dryRun: options.dryRun });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.needsInvert) process.exit(1);
    return;
  }
  if (result.performed) {
    step("adopt", `${path.basename(result.from ?? "")} → AGENTS.md`);
    process.stdout.write(`  ${DIM}now run \`agentlink sync\` to link it back into every harness${RESET}\n`);
    return;
  }
  if (result.from) {
    process.stdout.write(
      `${YELLOW}!${RESET} would rename ${path.basename(result.from)} → AGENTS.md ${DIM}(dry run; then run \`agentlink sync\`)${RESET}\n`,
    );
    return;
  }
  process.stdout.write(`${DIM}nothing to adopt: ${result.reason}${RESET}\n`);
  if (result.needsInvert || result.reason?.includes("merge") || result.reason?.includes("several")) process.exit(1);
}

function runUnlink(paths: ScopePaths, options: Options): void {
  const result = unlink(paths, { dryRun: options.dryRun });
  const ignoreChanged = removeIgnoreBlock(paths, { dryRun: options.dryRun });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, ignoreBlockRemoved: ignoreChanged }, null, 2)}\n`);
    return;
  }
  for (const removed of result.removed) step("unlink", removed);
  for (const keep of result.kept) {
    process.stdout.write(`  ${YELLOW}!${RESET} kept ${keep.path} ${DIM}(${keep.reason})${RESET}\n`);
  }
  if (ignoreChanged) step("ignore", `.gitignore ${DIM}(block removed)${RESET}`);
  if (result.removed.length === 0 && result.kept.length === 0) {
    process.stdout.write(`${DIM}nothing to unlink${RESET}\n`);
  }
}

// --- selection --------------------------------------------------------------

async function chooseHarnesses(
  paths: ScopePaths,
  options: Options,
  behaviour: { prompt: boolean },
): Promise<Harness[]> {
  const state = readState(paths);

  if (options.harnessIds && options.harnessIds.length > 0) {
    const { found, unknown } = resolveHarnessList(options.harnessIds.join(","));
    if (unknown.length) fail(`unknown harness${unknown.length > 1 ? "es" : ""}: ${unknown.join(", ")}`);
    return dedupe(found);
  }
  if (options.all) return HARNESSES;
  if (options.detected) return detectedHarnesses();

  // Asking for a specific command or an explicit selection is the only reason to
  // reuse a saved selection; init and select are about choosing.
  if (!behaviour.prompt && state.harnesses.length > 0) {
    const fromState = HARNESSES.filter((h) => state.harnesses.includes(h.id));
    if (fromState.length > 0) return fromState;
  }

  // Never prompt when the caller cannot answer: --yes, --json, or no TTY.
  const canPrompt = !options.yes && !options.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (behaviour.prompt && canPrompt) return promptForHarnesses(paths);

  const fallback = detectedHarnesses();
  if (!options.json) {
    const names = fallback.map((h) => h.id).join(", ") || "none";
    process.stdout.write(
      `${DIM}harnesses present on this machine: ${names}${canPrompt ? "" : " (not prompting)"}${RESET}\n`,
    );
    if (!canPrompt) {
      process.stdout.write(`${DIM}pass --harnesses, --all or --detected to choose explicitly${RESET}\n`);
    }
  }
  return fallback;
}

async function promptForHarnesses(paths: ScopePaths): Promise<Harness[]> {
  const detections = detectAll();
  const choices = buildHarnessChoices(
    detections.map(({ harness, installed, reasons }) => ({
      id: harness.id,
      label: harness.label,
      installed,
      reasons,
    })),
    readState(paths).harnesses,
  );

  const picked = await selectMany(choices, {
    title: "Which harnesses should read this project's AGENTS.md and skills?",
    help: "current selection pre-ticked · space toggle · a all · i installed only · enter confirm · esc cancel",
  });
  if (picked === null) {
    process.stdout.write(`${DIM}cancelled${RESET}\n`);
    process.exit(0);
  }
  return dedupe(detections.filter((d) => picked.includes(d.harness.id)).map((d) => d.harness));
}

function detectedHarnesses(): Harness[] {
  return dedupe(detectAll().filter((d) => d.installed).map((d) => d.harness));
}

function dedupe(harnesses: Harness[]): Harness[] {
  return HARNESSES.filter((h) => harnesses.some((candidate) => candidate.id === h.id));
}

function step(verb: string, message: string): void {
  process.stdout.write(`  ${GREEN}✓${RESET} ${DIM}${verb.padEnd(7)}${RESET}${message}\n`);
}

/** Describe a change to the saved selection, or null when nothing changed. */
function selectionChange(before: string[], chosen: Harness[]): string | null {
  const after = chosen.map((harness) => harness.id);
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  if (added.length === 0 && removed.length === 0) return null;
  // The first run has nothing to compare against; the list above already says it.
  const parts = [added.length ? `+${added.join(" ")}` : "", removed.length ? `-${removed.join(" ")}` : ""];
  return `${after.length} harness${after.length === 1 ? "" : "es"}${
    before.length ? ` (was ${before.length})` : ""
  }: ${parts.filter(Boolean).join(" ")}`;
}

function version(): void {
  try {
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
    process.stdout.write(`${parsed.version ?? "unknown"}\n`);
  } catch {
    process.stdout.write("unknown\n");
  }
}

function help(): void {
  process.stdout.write(`
${BOLD}agentlink${RESET} ${DIM}— one source of truth for agent instructions and skills${RESET}

${BOLD}usage${RESET}
  agentlink                      pick harnesses (first run), then link
  agentlink init                 create AGENTS.md + .agents/skills, migrate, link
  agentlink sync                 re-link after adding or moving a skill
  agentlink fix                  fold stray real copies into .agents, then link
  agentlink select               change which harnesses are linked
  agentlink list                 show every harness and where it reads from
  agentlink doctor               report drift, duplicates and broken links
  agentlink doctor --harnesses a,b   check a declared set (useful in CI)
  agentlink adopt                move an existing CLAUDE.md/GEMINI.md into AGENTS.md
  agentlink unlink               remove the links agentlink created

${BOLD}options${RESET}
  -g, --global             act on ~ instead of the current repository
      --harnesses a,b      skip the picker
      --all                every harness in the table
      --detected           only harnesses found on this machine
  -n, --dry-run            show what would change
  -y, --yes                never prompt
      --force              on a conflict, keep the canonical copy
      --no-clause          leave AGENTS.md untouched
      --ignore=skills|all|none
                           what to list in .gitignore (default: skills)
      --json               machine-readable output
  -v, --verbose            more detail

${BOLD}the convention${RESET}
  AGENTS.md                     instructions. Everything else points here.
  .agents/skills/<name>/SKILL.md  skills, one directory each.
  ${DIM}Files like CLAUDE.md and .claude/skills/ are symlinks into the above.${RESET}
  ${DIM}Instructions aliases are committed; skill links go in .gitignore.${RESET}

${BOLD}more${RESET}
  agentlink help            this text
  agentlink --version       print the version
`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${RED}error${RESET} ${message}\n`);
  process.exit(1);
});

export { readIgnoreBlock };
