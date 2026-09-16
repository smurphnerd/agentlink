/**
 * One test per finding from the pre-release review. Each of these failed before
 * the fix, so they double as documentation of the failure modes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { clauseFor, upsertClause, BEGIN_MARKER } from "../dist/convention.js";
import { planFixes, applyFixes } from "../dist/fix.js";
import { HARNESSES } from "../dist/harnesses.js";
import { endpointVerified, unverifiedEndpoints } from "../dist/harnesses.js";
import { mergeState, plan, pruneStale, readState } from "../dist/link.js";
import { resolveScope } from "../dist/scope.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NODE = process.execPath;

function run(args, cwd, env = {}) {
  const result = spawnSync(NODE, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/** An environment with no harnesses installed and no home config. */
function emptyEnvironment() {
  return { HOME: mkdtempSync(path.join(tmpdir(), "agentlink-nohome-")), PATH: "/nonexistent" };
}

const harness = (id) => {
  const found = HARNESSES.find((h) => h.id === id);
  assert.ok(found, `unknown harness ${id}`);
  return found;
};

const skill = (name) => `---\nname: ${name}\ndescription: Test fixture. Use when testing.\n---\n`;

function repo(skills = []) {
  const root = mkdtempSync(path.join(tmpdir(), "agentlink-reg-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(path.join(root, ".agents", "skills"), { recursive: true });
  for (const name of skills) {
    mkdirSync(path.join(root, ".agents", "skills", name), { recursive: true });
    writeFileSync(path.join(root, ".agents", "skills", name, "SKILL.md"), skill(name));
  }
  writeFileSync(path.join(root, "AGENTS.md"), "# Instructions\n");
  return root;
}

test("finding 1: a symlinked harness skills directory never deletes the canonical tree", () => {
  const root = repo(["demo"]);
  // A natural hand setup: point the harness directory at the canonical one.
  mkdirSync(path.join(root, ".claude"), { recursive: true });
  symlinkSync("../.agents/skills", path.join(root, ".claude", "skills"));

  const result = run(["init", "--harnesses", "claude", "--yes"], root);
  assert.ok(
    existsSync(path.join(root, ".agents", "skills", "demo", "SKILL.md")),
    "the canonical skill survives",
  );
  assert.equal(result.code, 0);

  // The same guard has to hold for the fix path directly.
  const paths = resolveScope("project", root);
  const actions = planFixes(paths, [harness("claude")]);
  assert.deepEqual(actions, [], "nothing is planned against a symlinked alias");
});

test("finding 1b: applyFixes refuses any target inside the canonical tree", () => {
  const root = repo(["demo"]);
  const paths = resolveScope("project", root);
  const results = applyFixes(
    paths,
    [{ target: ".agents/skills/demo", canonical: ".agents/skills/demo", kind: "remove-identical", skill: "demo" }],
    { force: true },
  );
  assert.equal(results[0].performed, false);
  assert.ok(existsSync(path.join(root, ".agents", "skills", "demo", "SKILL.md")));
});

test("finding 3: a lone clause marker in AGENTS.md is refused, not overwritten", () => {
  const prose = "# Title\n\n<!-- agentlink:begin v1 -->\n\nSome prose the user wrote.\n\n## Later\n";
  const result = upsertClause(prose);
  assert.equal(result.action, "malformed");
  assert.equal(result.text, prose, "returned untouched");

  const root = repo(["demo"]);
  writeFileSync(path.join(root, "AGENTS.md"), prose);
  run(["sync", "--harnesses", "claude", "--yes"], root);
  assert.equal(readFileSync(path.join(root, "AGENTS.md"), "utf8"), prose, "sync left it alone");
});

test("finding 5: state, AGENTS.md and .gitignore are replaced atomically", () => {
  const root = repo(["demo"]);
  run(["init", "--harnesses", "claude", "--yes"], root);
  const leftovers = ["AGENTS.md", ".gitignore", ".agents/agentlink.json"].filter((rel) =>
    existsSync(`${path.join(root, rel)}.agentlink-tmp`),
  );
  assert.deepEqual(leftovers, [], "no temp files left behind");
  rmSync(root, { recursive: true, force: true });
});

test("finding 6: unlink ignores a state file that escapes the repository", () => {
  const root = repo(["demo"]);
  const outside = mkdtempSync(path.join(tmpdir(), "agentlink-outside-"));
  const victim = path.join(outside, "victim");
  symlinkSync(path.join(root, ".agents", "skills"), victim);

  mkdirSync(path.join(root, ".agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "agentlink.json"),
    JSON.stringify({
      version: 1,
      scope: "project",
      harnesses: ["claude"],
      ignore: "skills",
      links: [{ path: path.relative(root, victim), source: ".agents/skills" }],
    }),
  );

  const { code } = run(["unlink"], root);
  assert.equal(code, 0);
  assert.ok(lstatSync(victim).isSymbolicLink(), "the link outside the repo is kept");
  rmSync(outside, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("finding 7: a stale link is pruned when a skill or harness goes away", () => {
  const root = repo(["demo", "other"]);
  run(["init", "--harnesses", "claude,qwen", "--yes"], root);
  assert.ok(existsSync(path.join(root, ".claude", "skills", "other")));
  assert.ok(existsSync(path.join(root, ".qwen", "skills", "other")));

  // Delete a skill, and deselect a harness.
  rmSync(path.join(root, ".agents", "skills", "other"), { recursive: true });
  const { code } = run(["sync", "--harnesses", "claude", "--yes"], root);
  assert.equal(code, 0);

  assert.ok(!existsSync(path.join(root, ".claude", "skills", "other")), "dead skill link is gone");
  assert.ok(!existsSync(path.join(root, ".qwen", "skills", "demo")), "deselected harness is unlinked");
  assert.ok(existsSync(path.join(root, ".claude", "skills", "demo")), "wanted links stay");
  rmSync(root, { recursive: true, force: true });
});

test("finding 7b: pruneStale only removes symlinks agentlink owns", () => {
  const root = repo(["demo"]);
  const paths = resolveScope("project", root);
  mkdirSync(path.join(root, ".claude", "skills", "local-only"), { recursive: true });
  const previous = {
    version: 1,
    scope: "project",
    harnesses: ["claude"],
    ignore: "skills",
    links: [
      { path: ".claude/skills/local-only", source: "" },
      { path: ".claude/skills/demo", source: ".agents/skills/demo" },
    ],
  };
  const linkPlan = plan(paths, [harness("claude")]);
  const pruned = pruneStale(paths, linkPlan, previous);
  assert.deepEqual(pruned, [], "a real directory is never pruned");
  assert.ok(existsSync(path.join(root, ".claude", "skills", "local-only")));

  const merged = mergeState(paths, previous, [], ["claude"], { plannedRels: linkPlan.ops.map((op) => op.rel) });
  assert.deepEqual(
    merged.links.map((link) => link.path),
    [".claude/skills/demo"],
    "state shrinks to the current plan",
  );
  rmSync(root, { recursive: true, force: true });
});

test("finding 8: a failing op is reported, not thrown, and state is still written", () => {
  const root = repo(["demo"]);
  // .claude as a regular file makes every .claude/* link impossible.
  writeFileSync(path.join(root, ".claude"), "not a directory\n");
  const { code, out } = run(["init", "--harnesses", "claude", "--yes"], root);
  assert.notEqual(code, 0, "the blocked link is reported as a failure");
  assert.match(out, /cannot inspect|skipped|blocked/);
  assert.ok(!/^\s*at .*cli\.js/m.test(out), "it reported, it did not crash");

  const state = readState(resolveScope("project", root));
  assert.ok(Array.isArray(state.links));
  rmSync(root, { recursive: true, force: true });
});

test("finding 9: --yes and --json never prompt and say what they chose", () => {
  const root = repo(["demo"]);
  const yes = run(["init", "--yes"], root);
  assert.equal(yes.code, 0);
  assert.match(yes.out, /harnesses present on this machine|not prompting/);

  const root2 = repo(["demo"]);
  const json = run(["init", "--yes", "--json"], root2);
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.out);
  assert.ok(Array.isArray(payload.harnesses));
  assert.ok(payload.adoption !== undefined, "adoption is part of the envelope");
  assert.ok(Array.isArray(payload.fixes), "migration results are part of the envelope");
  rmSync(root, { recursive: true, force: true });
  rmSync(root2, { recursive: true, force: true });
});

test("finding 10: doctor treats a missing link as an error", () => {
  const root = repo(["demo"]);
  run(["init", "--harnesses", "claude", "--yes"], root);
  assert.equal(run(["doctor"], root).code, 0);

  rmSync(path.join(root, ".claude", "skills", "demo"));
  const missing = run(["doctor"], root);
  assert.notEqual(missing.code, 0, "a missing link fails the check");
  assert.match(missing.out, /is not linked/);

  // An empty real directory still blocks the link, so it is reported too.
  mkdirSync(path.join(root, ".claude", "skills", "demo"), { recursive: true });
  const empty = run(["doctor"], root);
  assert.notEqual(empty.code, 0);
  assert.match(empty.out, /is a real dir/);
  rmSync(root, { recursive: true, force: true });
});

test("finding 11: unverified endpoints are named per scope, not hidden by the row", () => {
  // Verification is per endpoint per scope, so a harness can be documented in a
  // project and unconfirmed at home. Qwen is exactly that, and a row-wide flag
  // could not express it.
  const qwen = harness("qwen");
  assert.equal(endpointVerified(qwen.instructions.project), true);
  assert.equal(endpointVerified(qwen.skills.project), true);
  assert.equal(endpointVerified(qwen.instructions.global), false);
  assert.deepEqual(
    unverifiedEndpoints(qwen, "global").map((entry) => entry.endpoint.alias),
    [".qwen/AGENTS.md"],
  );

  // And doctor names the path rather than hiding it behind the row.
  const home = mkdtempSync(path.join(tmpdir(), "agentlink-home-"));
  mkdirSync(path.join(home, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(path.join(home, ".agents", "skills", "demo", "SKILL.md"), skill("demo"));
  writeFileSync(path.join(home, "AGENTS.md"), "# Global\n");
  const init = run(["init", "--global", "--harnesses", "qwen,grok", "--yes"], home, { HOME: home });
  assert.equal(init.code, 0, init.err);

  const { code, out } = run(["doctor", "--global", "--harnesses", "qwen,grok"], home, { HOME: home });
  assert.match(out, /Qwen Code: instructions \.qwen\/AGENTS\.md is not confirmed/);
  assert.match(out, /Grok CLI: instructions \.grok\/AGENTS\.md is not confirmed/);
  assert.equal(code, 0, "an unconfirmed path is information, not a failure");

  const rows = JSON.parse(run(["list", "--global", "--json"], home, { HOME: home }).out).harnesses;
  const qwenRow = rows.find((row) => row.id === "qwen");
  assert.equal(qwenRow.skillsVerified, true);
  assert.equal(qwenRow.instructionsVerified, false);
  rmSync(home, { recursive: true, force: true });
});

test("finding 12: a broken symlink in .agents/skills is an error, not a skill", () => {
  const root = repo(["demo"]);
  symlinkSync(path.join(root, "gone"), path.join(root, ".agents", "skills", "dangling"));
  const { code, out } = run(["doctor"], root);
  assert.notEqual(code, 0);
  assert.match(out, /broken symlink/);
  assert.ok(!existsSync(path.join(root, ".claude", "skills", "dangling")), "never linked");
  rmSync(root, { recursive: true, force: true });
});

test("finding 13: a grouping folder without a direct SKILL.md is reported as a warning", () => {
  const root = repo();
  mkdirSync(path.join(root, ".agents", "skills", "group", "inner"), { recursive: true });
  writeFileSync(path.join(root, ".agents", "skills", "group", "inner", "SKILL.md"), skill("inner"));
  // Cursor and Pi both document recursive discovery, so this warns rather than
  // fails: the layout is valid for some harnesses and invisible to others.
  const { code, out } = run(["doctor", "--harnesses", "mastracode"], root);
  assert.equal(code, 0);
  assert.match(out, /no SKILL.md directly inside/);
  rmSync(root, { recursive: true, force: true });
});

test("finding 14: adopting a symlinked AGENTS.md is refused with an explanation", () => {
  const root = repo();
  rmSync(path.join(root, "AGENTS.md"));
  writeFileSync(path.join(root, "REAL.md"), "# Real content\n");
  symlinkSync("REAL.md", path.join(root, "AGENTS.md"));

  const { code, out } = run(["adopt"], root);
  assert.notEqual(code, 0);
  assert.match(out, /AGENTS.md is a symlink/);
  assert.ok(existsSync(path.join(root, "REAL.md")), "nothing was moved");
  rmSync(root, { recursive: true, force: true });
});

test("a conflict exits non-zero so CI can catch it", () => {
  const root = repo(["demo"]);
  writeFileSync(path.join(root, "AGENTS.md"), "# Canonical\n");
  writeFileSync(path.join(root, "CLAUDE.md"), "# Different\n");
  const { code } = run(["init", "--harnesses", "claude", "--yes"], root);
  assert.notEqual(code, 0, "unresolved conflict fails the command");
  assert.equal(readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "# Different\n");
  rmSync(root, { recursive: true, force: true });
});

test("finding 15: doctor with nothing selected says so instead of passing silently", () => {
  // A CI runner has no harnesses installed. Without a selection there are no
  // links to check, and reporting that as clean would be a false pass.
  const root = repo(["demo"]);
  writeFileSync(path.join(root, "AGENTS.md"), "# Instructions\n");

  // Detection reads PATH and HOME, so both have to be empty for this to be
  // the CI environment rather than this developer's laptop.
  const bare = run(["doctor"], root, emptyEnvironment());
  assert.match(bare.out, /no harnesses are selected or installed/);
  assert.equal(bare.code, 0, "a warning, not a failure: the repo may be mid-adoption");

  // An explicit selection works with no harness installed at all.
  const explicit = run(["doctor", "--harnesses", "claude"], root, emptyEnvironment());
  assert.notEqual(explicit.code, 0, "the declared set is really checked");
  assert.match(explicit.out, /is not linked/);
  rmSync(root, { recursive: true, force: true });
});

test("finding 16: the global clause does not claim to describe a repository", () => {
  const globalClause = clauseFor("global");
  const projectClause = clauseFor("project");
  assert.match(projectClause, /This repository keeps exactly one copy/);
  assert.ok(!globalClause.includes("This repository"), "a global file loads in every project");
  assert.match(globalClause, /user-level instructions file/);
  assert.match(globalClause, /~\/\.agents\/skills/);

  // Both use the same markers, so switching scope replaces rather than appends.
  const seeded = upsertClause("# Global\n", "global");
  const swapped = upsertClause(seeded.text, "project");
  assert.equal(swapped.action, "updated");
  assert.equal(swapped.text.split(BEGIN_MARKER).length - 1, 1);
});

test("finding 17: content standing in the way fails the run, a missing source does not", () => {
  // A real file where a link belongs: someone has to decide, so exit non-zero.
  const blocked = repo(["demo"]);
  writeFileSync(path.join(blocked, "AGENTS.md"), "# Instructions\n");
  mkdirSync(path.join(blocked, ".claude", "skills", "demo"), { recursive: true });
  const conflict = run(["sync", "--harnesses", "claude", "--yes"], blocked);
  assert.notEqual(conflict.code, 0, "a real directory in the way is a decision, not a no-op");
  assert.match(conflict.out, /real directory sits here/);

  // Nothing to link yet is not a failure.
  const premature = repo(["demo"]);
  rmSync(path.join(premature, "AGENTS.md"));
  const nothing = run(["sync", "--harnesses", "claude", "--yes"], premature);
  assert.equal(nothing.code, 0, "no AGENTS.md yet is not an error");
  assert.match(nothing.out, /AGENTS\.md does not exist/);

  rmSync(blocked, { recursive: true, force: true });
  rmSync(premature, { recursive: true, force: true });
});

test("an unknown path is reported, not silently skipped", () => {
  // Kilo Code's skills path survived no inspection, so agentlink links nothing.
  // Saying so is the difference between "nothing needed" and "no idea where to
  // put it", which the user cannot tell apart from silence.
  const kilo = harness("kilo");
  assert.equal(kilo.skills.project.alias, undefined);
  assert.equal(kilo.skills.project.native, false);

  const root = repo(["demo"]);
  const { code, out } = run(["doctor", "--harnesses", "kilo"], root);
  assert.equal(code, 0, "an unknown path is information, not a failure");
  assert.match(out, /no known skill path/);
  assert.ok(!existsSync(path.join(root, ".claude", "skills", "demo")), "and nothing was linked");
  rmSync(root, { recursive: true, force: true });
});
