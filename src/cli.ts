#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { adoptInstructions, ensureClause, initConvention } from "./convention.js";
import { detectAll } from "./detect.js";
import { diagnose, readSkills } from "./doctor.js";
import { HARNESSES, resolveHarnessList, type Harness } from "./harnesses.js";
import { isIgnoreMode, readIgnoreBlock, removeIgnoreBlock, updateGitignore, type IgnoreMode } from "./ignore.js";
import { apply, mergeState, plan, readState, unlink, writeState } from "./link.js";
import { existsSync } from "node:fs";
import { resolveScope, type Scope, type ScopePaths } from "./scope.js";
import { selectMany, type Choice } from "./ui.js";

const ESC = String.fromCharCode(27);
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;
const RESET = `${ESC}[0m`;

interface Options {
  command: string;
  scope: Scope;
  harnessIds?: string[];
  all: boolean;
  detected: boolean;
  dryRun: boolean;
  yes: boolean;
  clause: boolean;
  json: boolean;
  verbose: boolean;
  ignore?: IgnoreMode;
}

const COMMANDS = ["init", "sync", "select", "list", "doctor", "adopt", "unlink", "help"] as const;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: "sync",
    scope: "project",
    all: false,
    detected: false,
    dryRun: false,
    yes: false,
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
    else if (arg === "--no-clause") options.clause = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose" || arg === "-v") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg.startsWith("--ignore=")) {
      const value = arg.slice("--ignore=".length);
      if (!isIgnoreMode(value)) fail(`--ignore must be one of skills, all, none (got \`${value}\`)`);
      options.ignore = value;
    } else if (arg === "--ignore") {
      options.ignore = "skills";
    } else if (arg.startsWith("--harnesses=")) options.harnessIds = split(arg.slice("--harnesses=".length));
    else if (arg === "--harnesses") options.harnessIds = [];
    else if (arg.startsWith("-")) {
      fail(`unknown option \`${arg}\``, true);
    } else positional.push(arg);
  }

  const [first] = positional;
  if (first) {
    if ((COMMANDS as readonly string[]).includes(first)) options.command = first;
    else fail(`unknown command \`${first}\` — try \`agentlink help\``);
  }
  if (positional.length > 1) {
    options.harnessIds = split(positional.slice(1).join(","));
  }
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

  const cwd = process.cwd();
  const paths = resolveScope(options.scope, cwd);

  switch (options.command) {
    case "init":
      return runInit(paths, options);
    case "select":
      return runSelect(paths, options);
    case "sync":
      return runSync(paths, options);
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
  const chosen = await chooseHarnesses(paths, options, { prompt: true, fallback: "detected" });

  // A repository that already has a real harness instructions file should have
  // that content adopted rather than shadowed by a fresh stub.
  const adopted = adoptInstructions(paths, { dryRun: options.dryRun });
  if (adopted.performed && !options.json) {
    step("adopt", `${path.basename(adopted.from ?? "")} → AGENTS.md`);
  }

  const result = initConvention(paths, { dryRun: options.dryRun });
  if (!options.dryRun) mkdirSync(paths.skills, { recursive: true });

  if (!options.json) {
    const where = paths.scope === "global" ? "~" : ".";
    if (result.createdFile) step("create", `${where}/AGENTS.md`);
    else step("keep", `${where}/AGENTS.md`);
    if (result.createdSkillsDir) step("create", `${where}/.agents/skills/`);
    else step("keep", `${where}/.agents/skills/`);
  }
  await syncLinks(paths, chosen, options);
}

async function runSelect(paths: ScopePaths, options: Options): Promise<void> {
  const chosen = await chooseHarnesses(paths, options, { prompt: true, fallback: "detected" });
  if (!options.json) {
    process.stdout.write(`selected: ${chosen.map((h) => h.id).join(", ") || "(none)"}\n`);
  }
  await syncLinks(paths, chosen, options);
}

async function runSync(paths: ScopePaths, options: Options): Promise<void> {
  const chosen = await chooseHarnesses(paths, options, { prompt: false, fallback: "detected" });
  await syncLinks(paths, chosen, options);
}

async function syncLinks(paths: ScopePaths, chosen: Harness[], options: Options): Promise<void> {
  const previous = readState(paths);

  if (!options.dryRun && !existsSync(paths.skills) && existsSync(paths.instructions)) {
    mkdirSync(paths.skills, { recursive: true });
  }

  const clauseResult =
    options.clause && existsSync(paths.instructions)
      ? ensureClause(paths, { dryRun: options.dryRun })
      : undefined;

  const linkPlan = plan(paths, chosen);
  const results = apply(paths, linkPlan, { dryRun: options.dryRun });

  const mode: IgnoreMode = options.ignore ?? (isIgnoreMode(previous.ignore) ? previous.ignore : "skills");
  const ignoreResult = updateGitignore(
    paths,
    mode,
    {
      skillDirs: unique(linkPlan.ops.filter((op) => op.kind === "skill").map((op) => path.posix.dirname(op.rel))),
      instructionFiles: unique(
        linkPlan.ops.filter((op) => op.kind === "instructions").map((op) => op.rel),
      ),
    },
    { dryRun: options.dryRun },
  );

  if (!options.dryRun) {
    const state = mergeState(paths, previous, results, chosen.map((h) => h.id), { ignore: mode });
    writeState(paths, state);
  }

  if (clauseResult?.changed && !options.json) {
    step("clause", `${path.basename(paths.instructions)} ${DIM}(${clauseResult.action})${RESET}`);
  }
  if (!options.json && !ignoreResult.skipped) {
    const count = ignoreResult.entries.length;
    if (ignoreResult.changed) {
      step(
        "ignore",
        `.gitignore ${DIM}(${count} entr${count === 1 ? "y" : "ies"}${options.dryRun ? ", would update" : ""})${RESET}`,
      );
    } else {
      step("ignore", `.gitignore ${DIM}(already covers ${count} path${count === 1 ? "" : "s"})${RESET}`);
    }
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scope: paths.scope,
          root: paths.root,
          harnesses: chosen.map((h) => h.id),
          links: results.map((r) => ({ path: r.op.rel, state: r.state, harnesses: r.op.harnessIds, detail: r.detail })),
          skipped: linkPlan.skips.map((s) => ({ path: s.rel, reason: s.reason, harnesses: s.harnessIds })),
          native: linkPlan.native,
          unknown: linkPlan.unknown,
          skills: linkPlan.skillsFound,
          ignore: {
            mode,
            file: ignoreResult.skipped ? null : ignoreResult.file,
            entries: ignoreResult.entries,
            changed: ignoreResult.changed,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const where = paths.scope === "global" ? "~" : path.basename(paths.root);
  process.stdout.write(
    `\n${BOLD}agentlink${RESET} ${DIM}${where} · ${chosen.length} harness${chosen.length === 1 ? "" : "es"}${options.dryRun ? " · dry run" : ""}${RESET}\n`,
  );

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

  const skipped = linkPlan.skips;
  for (const skippedOp of skipped) {
    process.stdout.write(`  ${DIM}·${RESET} ${skippedOp.rel} ${DIM}${skippedOp.reason}${RESET}\n`);
  }

  const created = results.filter((r) => r.state === "linked" || r.state === "relinked").length;
  const unchanged = results.filter((r) => r.state === "unchanged").length;
  const blocked = results.filter((r) => r.state === "skipped").length + skipped.length;
  const nativeCount = linkPlan.native.length;

  process.stdout.write(
    `\n  ${created} ${options.dryRun ? "to link" : "linked"}${unchanged ? `, ${unchanged} already correct` : ""}${blocked ? `, ${blocked} blocked` : ""}, ${nativeCount} native (nothing to do)\n`,
  );

  if (results.some((r) => r.state === "skipped")) {
    process.stdout.write(`  ${DIM}run \`agentlink doctor\` for what to do about the blocked links${RESET}\n`);
  }
  if (!existsSync(paths.instructions)) {
    process.stdout.write(`  ${DIM}no AGENTS.md yet — \`agentlink init\` creates it${RESET}\n`);
  } else if (linkPlan.skillsFound.length === 0) {
    process.stdout.write(
      `  ${DIM}no skills yet — add one at .agents/skills/<name>/SKILL.md${RESET}\n`,
    );
  }
}

async function runList(paths: ScopePaths, options: Options): Promise<void> {
  const detections = detectAll();
  const rows = detections.map(({ harness, installed, reasons }) => ({
    id: harness.id,
    label: harness.label,
    installed,
    reasons,
    instructions: describe(harness.instructions[paths.scope], paths),
    skills: describe(harness.skills[paths.scope], paths),
    verified: harness.verified,
    source: harness.source,
  }));

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ scope: paths.scope, harnesses: rows }, null, 2)}\n`);
    return;
  }

  const width = Math.max(...rows.map((row) => row.label.length));
  process.stdout.write(
    `\n${BOLD}harnesses${RESET} ${DIM}· scope: ${paths.scope} · ${path.join(paths.scope === "global" ? "~" : ".", "")}${RESET}\n\n`,
  );
  for (const row of rows) {
    const mark = row.installed ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
    const flag = row.verified ? "" : ` ${YELLOW}unverified${RESET}`;
    process.stdout.write(`  ${mark} ${row.label.padEnd(width)}  ${DIM}instructions${RESET} ${row.instructions}  ${DIM}skills${RESET} ${row.skills}${flag}\n`);
  }
  process.stdout.write(
    `\n  ${GREEN}●${RESET} present on this machine   ${DIM}native = harness reads AGENTS.md / .agents/skills itself${RESET}\n` +
      `  ${DIM}agentlink list --json prints source URLs for every path${RESET}\n`,
  );
}

function describe(endpoint: { native: boolean; alias?: string }, _paths: ScopePaths): string {
  if (endpoint.native) return `${CYAN}native${RESET}`;
  if (!endpoint.alias) return `${DIM}unknown${RESET}`;
  return endpoint.alias;
}

function runDoctor(paths: ScopePaths, options: Options): void {
  const state = readState(paths);
  // Before the first sync there is no recorded selection; diagnostics are still
  // useful for every harness actually present on the machine.
  const chosen = state.harnesses.length
    ? HARNESSES.filter((h) => state.harnesses.includes(h.id))
    : detectAll()
        .filter((d) => d.installed)
        .map((d) => d.harness);
  const findings = diagnose({ paths, harnesses: chosen, home: paths.root });
  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ scope: paths.scope, root: paths.root, skills: readSkills(paths).map((s) => s.name), findings }, null, 2)}\n`,
    );
    process.exit(errors > 0 ? 1 : 0);
  }

  const where = paths.scope === "global" ? "~" : paths.root;
  process.stdout.write(`\n${BOLD}agentlink doctor${RESET} ${DIM}${where}${RESET}\n\n`);
  if (findings.length === 0) {
    process.stdout.write(`  ${GREEN}✓${RESET} convention intact${chosen.length ? `, ${chosen.length} harnesses linked` : ""}\n\n`);
    return;
  }
  for (const severity of ["error", "warn", "info"] as const) {
    for (const finding of findings.filter((f) => f.severity === severity)) {
      const symbol = severity === "error" ? `${RED}✗${RESET}` : severity === "warn" ? `${YELLOW}!${RESET}` : `${DIM}·${RESET}`;
      process.stdout.write(`  ${symbol} ${finding.message}\n`);
      if (finding.fix) process.stdout.write(`    ${DIM}fix: ${finding.fix}${RESET}\n`);
    }
  }
  process.stdout.write(`\n  ${errors} error${errors === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}\n\n`);
  process.exit(errors > 0 ? 1 : 0);
}

function runAdopt(paths: ScopePaths, options: Options): void {
  const result = adoptInstructions(paths, { dryRun: options.dryRun });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (!result.performed) {
    if (result.from) {
      process.stdout.write(
        `${YELLOW}!${RESET} would rename ${path.basename(result.from)} → AGENTS.md ${DIM}(dry run; then run \`agentlink sync\`)${RESET}\n`,
      );
      return;
    }
    process.stdout.write(`${DIM}nothing to adopt: ${result.reason}${RESET}\n`);
    if (result.reason?.includes("merge")) process.exit(1);
    return;
  }
  step("adopt", `${path.basename(result.from ?? "")} → AGENTS.md`);
  process.stdout.write(`  ${DIM}now run \`agentlink sync\` to link it back into every harness${RESET}\n`);
}

function runUnlink(paths: ScopePaths, options: Options): void {
  const result = unlink(paths, { dryRun: options.dryRun });
  const ignoreChanged = removeIgnoreBlock(paths, { dryRun: options.dryRun });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, ignoreBlockRemoved: ignoreChanged }, null, 2)}\n`);
    return;
  }
  for (const removed of result.removed) step("unlink", removed);
  for (const keep of result.kept) process.stdout.write(`  ${YELLOW}!${RESET} kept ${keep.path} ${DIM}(${keep.reason})${RESET}\n`);
  if (ignoreChanged) step("ignore", `.gitignore ${DIM}(block removed)${RESET}`);
  if (result.removed.length === 0 && result.kept.length === 0) {
    process.stdout.write(`${DIM}nothing to unlink${RESET}\n`);
  }
}

async function chooseHarnesses(
  paths: ScopePaths,
  options: Options,
  behaviour: { prompt: boolean; fallback: "detected" | "all" },
): Promise<Harness[]> {
  const state = readState(paths);

  if (options.harnessIds && options.harnessIds.length > 0) {
    const { found, unknown } = resolveHarnessList(options.harnessIds.join(","));
    if (unknown.length) fail(`unknown harness${unknown.length > 1 ? "es" : ""}: ${unknown.join(", ")}`);
    return dedupe(found);
  }
  if (options.all) return HARNESSES;
  if (options.detected) return detectedHarnesses();

  if (state.harnesses.length > 0) {
    const fromState = HARNESSES.filter((h) => state.harnesses.includes(h.id));
    if (fromState.length > 0) return fromState;
  }

  const interactive = behaviour.prompt || (options.command === "sync" && !options.yes && process.stdin.isTTY);
  if (interactive) {
    return promptForHarnesses();
  }
  return behaviour.fallback === "all" ? HARNESSES : detectedHarnesses();
}

async function promptForHarnesses(): Promise<Harness[]> {
  const detections = detectAll();
  const choices: Choice[] = detections.map(({ harness, installed, reasons }) => ({
    id: harness.id,
    label: harness.label,
    hint: installed ? reasons.join(" · ") : "not detected",
    checked: installed,
    group: installed ? "detected" : "other",
  }));

  const picked = await selectMany(choices, {
    title: "Which harnesses should read this project's AGENTS.md and skills?",
    help: "space toggle · a all · i installed only · enter confirm · esc cancel",
  });
  if (picked === null) {
    process.stdout.write(`${DIM}cancelled${RESET}\n`);
    process.exit(0);
  }
  const chosen = detections.filter((d) => picked.includes(d.harness.id)).map((d) => d.harness);
  return dedupe(chosen);
}

function detectedHarnesses(): Harness[] {
  return dedupe(detectAll().filter((d) => d.installed).map((d) => d.harness));
}

function dedupe(harnesses: Harness[]): Harness[] {
  return HARNESSES.filter((h) => harnesses.some((candidate) => candidate.id === h.id));
}

function step(verb: string, message: string): void {
  const padded = verb.padEnd(7);
  process.stdout.write(`  ${GREEN}✓${RESET} ${DIM}${padded}${RESET}${message}\n`);
}

function help(): void {
  process.stdout.write(`
${BOLD}agentlink${RESET} ${DIM}— one source of truth for agent instructions and skills${RESET}

${BOLD}usage${RESET}
  agentlink                      pick harnesses (first run), then link
  agentlink init                 create AGENTS.md + .agents/skills and link
  agentlink sync                 re-link after adding or moving a skill
  agentlink select               change which harnesses are linked
  agentlink list                 show every harness and where it reads from
  agentlink doctor               report drift, duplicates and broken links
  agentlink adopt                move an existing CLAUDE.md/GEMINI.md into AGENTS.md
  agentlink unlink               remove the links agentlink created

${BOLD}options${RESET}
  -g, --global             act on ~ instead of the current repository
      --harnesses a,b      skip the picker
      --all                every harness in the table
      --detected           only harnesses found on this machine
  -n, --dry-run            show what would change
  -y, --yes                never prompt
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
`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${RED}error${RESET} ${message}\n`);
  process.exit(1);
});
