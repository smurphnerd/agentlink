import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HARNESSES } from "../dist/harnesses.js";
import { apply, plan, readState } from "../dist/link.js";
import { resolveScope } from "../dist/scope.js";

const harness = (id) => {
  const found = HARNESSES.find((h) => h.id === id);
  assert.ok(found, `unknown harness ${id}`);
  return found;
};

/** A repository with AGENTS.md, .agents/skills and a git dir. */
function repo(skills = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "agentlink-link-"));
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, "AGENTS.md"), "# Instructions\n");
  mkdirSync(path.join(root, ".agents", "skills"), { recursive: true });
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(path.join(root, ".agents", "skills", name), { recursive: true });
    writeFileSync(path.join(root, ".agents", "skills", name, "SKILL.md"), content);
  }
  return { root, paths: resolveScope("project", root) };
}

test("native endpoints produce no links", () => {
  const { paths } = repo({ demo: "---\nname: demo\ndescription: x\n---\n" });
  const linkPlan = plan(paths, [harness("codex"), harness("pi"), harness("copilot")]);
  assert.deepEqual(linkPlan.ops, []);
  assert.equal(linkPlan.native.length, 6, "instructions and skills are native in both scopes");
});

test("unknown endpoints are reported, never invented", () => {
  const { paths } = repo();
  // Hermes has no documented project skills answer in the table.
  const hermes = { ...harness("hermes"), skills: { ...harness("hermes").skills, project: { native: false } } };
  const linkPlan = plan(paths, [hermes]);
  assert.equal(linkPlan.ops.length, 0);
  assert.equal(linkPlan.unknown.filter((u) => u.kind === "skill").length, 1);
});

test("skills are linked one symlink per skill per harness", () => {
  const { root, paths } = repo({
    alpha: "---\nname: alpha\ndescription: a\n---\n",
    beta: "---\nname: beta\ndescription: b\n---\n",
  });
  const linkPlan = plan(paths, [harness("claude")]);
  const skillOps = linkPlan.ops.filter((op) => op.kind === "skill");
  assert.deepEqual(skillOps.map((op) => op.rel).sort(), [".claude/skills/alpha", ".claude/skills/beta"]);
  apply(paths, linkPlan);
  assert.equal(readlinkSync(path.join(root, ".claude/skills/alpha")), "../../.agents/skills/alpha");
});

test("two harnesses sharing a directory produce one link", () => {
  const { paths } = repo({ demo: "---\nname: demo\ndescription: x\n---\n" });
  // No two real harnesses share a skills directory today, so this is stated
  // explicitly rather than borrowed from whatever the table currently says.
  const sharesClaude = (id) => ({
    ...harness("claude"),
    id,
    label: id,
    skills: { project: { native: false, alias: ".claude/skills" }, global: { native: true } },
  });
  const linkPlan = plan(paths, [sharesClaude("one"), sharesClaude("two")]);
  const shared = linkPlan.ops.filter((op) => op.rel === ".claude/skills/demo");
  assert.equal(shared.length, 1, "one link, not one per harness");
  assert.deepEqual(shared[0].harnessIds.sort(), ["one", "two"]);
});

test("instructions links are skipped when AGENTS.md is missing", () => {
  const { root, paths } = repo();
  rmSync(path.join(root, "AGENTS.md"));
  const linkPlan = plan(paths, [harness("claude")]);
  assert.equal(linkPlan.ops.length, 0);
  assert.match(linkPlan.skips[0].reason, /AGENTS\.md does not exist/);
});

test("apply is idempotent and leaves real files alone", () => {
  const { root, paths } = repo({ demo: "---\nname: demo\ndescription: x\n---\n" });
  const first = apply(paths, plan(paths, [harness("claude")]));
  assert.ok(first.some((r) => r.state === "linked"));

  const second = apply(paths, plan(paths, [harness("claude")]));
  assert.ok(second.every((r) => r.state === "unchanged"), "second run changes nothing");

  // A real directory where a link belongs must not be destroyed.
  const realSkill = path.join(root, ".claude", "skills", "demo");
  rmSync(realSkill);
  mkdirSync(realSkill, { recursive: true });
  writeFileSync(path.join(realSkill, "SKILL.md"), "real content");

  const third = apply(paths, plan(paths, [harness("claude")]));
  const blocked = third.find((r) => r.op.rel === ".claude/skills/demo");
  assert.equal(blocked.state, "skipped");
  assert.match(blocked.detail, /real directory/);
  assert.ok(readFileSync(path.join(realSkill, "SKILL.md"), "utf8").includes("real content"));
});

test("a symlink pointing outside the canonical tree is not hijacked", () => {
  const { root, paths } = repo({ demo: "---\nname: demo\ndescription: x\n---\n" });
  mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  const elsewhere = path.join(root, "somewhere-else");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(root, ".claude", "skills", "demo"));

  const results = apply(paths, plan(paths, [harness("claude")]));
  const op = results.find((r) => r.op.rel === ".claude/skills/demo");
  assert.equal(op.state, "skipped");
  assert.match(op.detail, /already a symlink to/);
});

test("a stale symlink inside .agents is repaired", () => {
  const { root, paths } = repo({ demo: "---\nname: demo\ndescription: x\n---\n" });
  mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  symlinkSync(path.join(root, ".agents", "skills"), path.join(root, ".claude", "skills", "demo"));

  const results = apply(paths, plan(paths, [harness("claude")]));
  const op = results.find((r) => r.op.rel === ".claude/skills/demo");
  assert.equal(op.state, "relinked");
  assert.equal(readlinkSync(path.join(root, ".claude", "skills", "demo")), "../../.agents/skills/demo");
});

test("dry run plans without touching the filesystem", () => {
  const { root, paths } = repo({ demo: "---\nname: demo\ndescription: x\n---\n" });
  const results = apply(paths, plan(paths, [harness("claude")]), { dryRun: true });
  assert.ok(results.some((r) => r.state === "linked"));
  assert.throws(() => readlinkSync(path.join(root, ".claude", "skills", "demo")));
});

test("state records what was linked and defaults missing fields", () => {
  const { root, paths } = repo({ demo: "---\nname: demo\ndescription: x\n---\n" });
  assert.deepEqual(readState(paths), { version: 1, scope: "project", harnesses: [], ignore: "skills", links: [] });

  writeFileSync(path.join(root, ".agents", "agentlink.json"), JSON.stringify({ version: 1, harnesses: ["claude"] }));
  const partial = readState(paths);
  assert.equal(partial.ignore, "skills", "older state files get the default ignore mode");
  assert.deepEqual(partial.links, []);
});

test("global scope links into the home tree shape", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agentlink-global-"));
  mkdirSync(path.join(root, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(path.join(root, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: x\n---\n");
  writeFileSync(path.join(root, "AGENTS.md"), "# Global\n");

  // resolveScope resolves home from the OS, so exercise the plan directly with
  // a scope object shaped exactly like one.
  const paths = {
    scope: "global",
    root,
    agentsDir: path.join(root, ".agents"),
    instructions: path.join(root, "AGENTS.md"),
    skills: path.join(root, ".agents", "skills"),
    stateFile: path.join(root, ".agents", "agentlink.json"),
  };
  const linkPlan = plan(paths, [harness("claude"), harness("codex")]);
  assert.ok(linkPlan.ops.some((op) => op.rel === ".claude/CLAUDE.md"));
  assert.ok(linkPlan.ops.some((op) => op.rel === ".claude/skills/demo"));
  assert.ok(linkPlan.ops.some((op) => op.rel === ".codex/AGENTS.md"), "codex gets a global instructions alias");
  rmSync(root, { recursive: true, force: true });
});
