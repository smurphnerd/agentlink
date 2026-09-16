import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NODE = process.execPath;

function run(args, cwd) {
  const result = spawnSync(NODE, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function repo(skills = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "agentlink-cli-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(path.join(root, ".agents", "skills", name), { recursive: true });
    writeFileSync(path.join(root, ".agents", "skills", name, "SKILL.md"), content);
  }
  return root;
}

const skill = (name, description = "Does a thing. Use when testing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

test("help lists every command and exits zero", () => {
  const { code, out } = run(["--help"], process.cwd());
  assert.equal(code, 0);
  for (const command of ["init", "sync", "select", "fix", "list", "doctor", "adopt", "unlink"]) {
    assert.ok(out.includes(`agentlink ${command}`), `help mentions ${command}`);
  }
});

test("unknown command and unknown harness fail loudly", () => {
  const root = repo();
  assert.notEqual(run(["nonsense"], root).code, 0);
  const bad = run(["sync", "--harnesses", "not-a-harness"], root);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /unknown harness/);
  rmSync(root, { recursive: true, force: true });
});

test("init creates the convention and links without a prompt when given harnesses", () => {
  const root = repo({ demo: skill("demo") });
  const { code, out } = run(["init", "--harnesses", "claude,codex", "--yes"], root);
  assert.equal(code, 0);
  assert.ok(existsSync(path.join(root, "AGENTS.md")));
  assert.ok(readFileSync(path.join(root, "AGENTS.md"), "utf8").includes("agentlink:begin"));
  assert.equal(readlinkSync(path.join(root, "CLAUDE.md")), "AGENTS.md");
  assert.equal(readlinkSync(path.join(root, ".claude", "skills", "demo")), "../../.agents/skills/demo");
  assert.match(out, /2 harnesses/);
  rmSync(root, { recursive: true, force: true });
});

test("sync is idempotent and safe to repeat", () => {
  const root = repo({ demo: skill("demo") });
  run(["init", "--harnesses", "claude", "--yes"], root);
  const before = readFileSync(path.join(root, ".gitignore"), "utf8");
  const second = run(["sync", "--yes"], root);
  assert.equal(second.code, 0);
  assert.equal(readFileSync(path.join(root, ".gitignore"), "utf8"), before, "gitignore is byte stable");
  assert.match(second.out, /already correct|unchanged/);
  rmSync(root, { recursive: true, force: true });
});

test("git status stays clean: skill links ignored, instructions alias committed", () => {
  const root = repo({ demo: skill("demo") });
  run(["init", "--harnesses", "claude", "--yes"], root);
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
  assert.ok(status.includes("?? CLAUDE.md"), "instructions alias is offered to git");
  assert.ok(!status.includes(".claude/skills"), "skill links are ignored");

  const check = spawnSync("git", ["check-ignore", ".claude/skills/demo"], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 0, "skill link is matched by .gitignore");
  rmSync(root, { recursive: true, force: true });
});

test("--ignore=all also ignores the instructions alias", () => {
  const root = repo({ demo: skill("demo") });
  run(["init", "--harnesses", "claude", "--yes", "--ignore=all"], root);
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
  assert.ok(!status.includes("CLAUDE.md"), "alias is ignored in this mode");
  rmSync(root, { recursive: true, force: true });
});

test("--ignore=none leaves .gitignore alone", () => {
  const root = repo({ demo: skill("demo") });
  run(["init", "--harnesses", "claude", "--yes", "--ignore=none"], root);
  assert.ok(!existsSync(path.join(root, ".gitignore")));
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout;
  assert.ok(status.includes(".claude/"), "links show up as untracked");
  rmSync(root, { recursive: true, force: true });
});

test("dry run reports work without writing", () => {
  const root = repo({ demo: skill("demo") });
  const { code, out } = run(["init", "--harnesses", "claude", "--yes", "--dry-run"], root);
  assert.equal(code, 0);
  assert.match(out, /would link|dry run/);
  assert.ok(!existsSync(path.join(root, "AGENTS.md")), "nothing created");
  assert.ok(!existsSync(path.join(root, "CLAUDE.md")), "nothing linked");
  rmSync(root, { recursive: true, force: true });
});

test("adopt moves an existing CLAUDE.md into AGENTS.md and links back", () => {
  const root = repo();
  writeFileSync(path.join(root, "CLAUDE.md"), "# Real instructions\n\nKeep me.\n");
  const { code } = run(["init", "--harnesses", "claude", "--yes"], root);
  assert.equal(code, 0);
  const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("Keep me."), "content is preserved");
  assert.equal(readlinkSync(path.join(root, "CLAUDE.md")), "AGENTS.md");
  rmSync(root, { recursive: true, force: true });
});

test("conflicting instructions are reported, not overwritten", () => {
  const root = repo();
  writeFileSync(path.join(root, "AGENTS.md"), "# Canonical\n");
  writeFileSync(path.join(root, "CLAUDE.md"), "# Different\n");
  const { code, out } = run(["doctor", "--harnesses", "claude"], root);
  assert.match(out, /real file, not a symlink|two copies/);
  assert.equal(readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "# Different\n");
  assert.ok(code >= 0);
  rmSync(root, { recursive: true, force: true });
});

test("fix moves an orphan skill into the canonical tree", () => {
  const root = repo();
  mkdirSync(path.join(root, ".claude", "skills", "orphan"), { recursive: true });
  writeFileSync(path.join(root, ".claude", "skills", "orphan", "SKILL.md"), skill("orphan", "Orphan skill. Use when migrating."));
  writeFileSync(path.join(root, ".claude", "skills", "orphan", "helper.py"), "print('x')\n");

  const { code, out } = run(["init", "--harnesses", "claude", "--yes"], root);
  assert.equal(code, 0);
  assert.match(out, /move/);
  assert.ok(existsSync(path.join(root, ".agents", "skills", "orphan", "helper.py")), "supporting files move too");
  assert.equal(readlinkSync(path.join(root, ".claude", "skills", "orphan")), "../../.agents/skills/orphan");
  rmSync(root, { recursive: true, force: true });
});

test("fix deletes an identical duplicate and preserves a differing one", () => {
  const identical = repo({ dup: skill("dup") });
  mkdirSync(path.join(identical, ".claude", "skills", "dup"), { recursive: true });
  writeFileSync(path.join(identical, ".claude", "skills", "dup", "SKILL.md"), skill("dup"));
  const a = run(["init", "--harnesses", "claude", "--yes"], identical);
  assert.match(a.out, /cleanup/);
  assert.equal(readlinkSync(path.join(identical, ".claude", "skills", "dup")), "../../.agents/skills/dup");
  rmSync(identical, { recursive: true, force: true });

  const differing = repo({ dup: skill("dup", "canonical") });
  mkdirSync(path.join(differing, ".claude", "skills", "dup"), { recursive: true });
  writeFileSync(path.join(differing, ".claude", "skills", "dup", "SKILL.md"), skill("dup", "stale"));
  const b = run(["init", "--harnesses", "claude", "--yes"], differing);
  assert.match(b.out, /conflict/);
  assert.match(readFileSync(path.join(differing, ".claude", "skills", "dup", "SKILL.md"), "utf8"), /stale/);

  const forced = run(["fix", "--harnesses", "claude", "--yes", "--force"], differing);
  assert.equal(forced.code, 0);
  assert.equal(readlinkSync(path.join(differing, ".claude", "skills", "dup")), "../../.agents/skills/dup");
  rmSync(differing, { recursive: true, force: true });
});

test("doctor exits non-zero on a broken skill and zero when healthy", () => {
  const root = repo({ demo: skill("demo") });
  run(["init", "--harnesses", "claude", "--yes"], root);
  assert.equal(run(["doctor"], root).code, 0);

  mkdirSync(path.join(root, ".agents", "skills", "Bad_Name"), { recursive: true });
  writeFileSync(path.join(root, ".agents", "skills", "Bad_Name", "SKILL.md"), "---\nname: Bad_Name\ndescription: x\n---\n");
  const bad = run(["doctor"], root);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /lowercase-hyphenated/);
  rmSync(root, { recursive: true, force: true });
});

test("doctor warns when the gitignore block is missing", () => {
  const root = repo({ demo: skill("demo") });
  run(["init", "--harnesses", "claude", "--yes"], root);
  const file = path.join(root, ".gitignore");
  writeFileSync(file, readFileSync(file, "utf8").replace(/# agentlink:begin[\s\S]*?# agentlink:end\n/, ""));
  const { out } = run(["doctor"], root);
  assert.match(out, /untracked/);
  rmSync(root, { recursive: true, force: true });
});

test("unlink removes only what agentlink created", () => {
  const root = repo({ demo: skill("demo") });
  writeFileSync(path.join(root, ".gitignore"), "keep-me/\n");
  run(["init", "--harnesses", "claude", "--yes"], root);

  const { code } = run(["unlink"], root);
  assert.equal(code, 0);
  assert.ok(existsSync(path.join(root, "AGENTS.md")), "canonical instructions survive");
  assert.ok(existsSync(path.join(root, ".agents", "skills", "demo", "SKILL.md")), "canonical skills survive");
  assert.ok(!existsSync(path.join(root, "CLAUDE.md")), "created alias is removed");
  assert.ok(!existsSync(path.join(root, ".claude")), "empty harness directory is pruned");
  assert.equal(readFileSync(path.join(root, ".gitignore"), "utf8"), "keep-me/\n", "user rules are untouched");
  rmSync(root, { recursive: true, force: true });
});

test("json output is machine readable for sync and doctor", () => {
  const root = repo({ demo: skill("demo") });
  const sync = run(["init", "--harnesses", "claude,pi", "--yes", "--json"], root);
  const payload = JSON.parse(sync.out);
  assert.equal(payload.scope, "project");
  assert.deepEqual(payload.harnesses, ["claude", "pi"]);
  assert.ok(Array.isArray(payload.links) && payload.links.length > 0);
  assert.equal(payload.ignore.mode, "skills");

  const doctor = JSON.parse(run(["doctor", "--json"], root).out);
  assert.ok(Array.isArray(doctor.findings));
  assert.deepEqual(doctor.skills, ["demo"]);
  rmSync(root, { recursive: true, force: true });
});

test("global scope writes into a supplied home, never the real one", () => {
  const home = mkdtempSync(path.join(tmpdir(), "agentlink-home-"));
  mkdirSync(path.join(home, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(path.join(home, ".agents", "skills", "demo", "SKILL.md"), skill("demo"));
  writeFileSync(path.join(home, "AGENTS.md"), "# Global\n");
  mkdirSync(path.join(home, ".claude"), { recursive: true });

  const result = spawnSync(NODE, [CLI, "sync", "--global", "--harnesses", "claude", "--yes", "--json"], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(path.join(home, ".claude", "CLAUDE.md")), "../AGENTS.md");
  assert.equal(readlinkSync(path.join(home, ".claude", "skills", "demo")), "../../.agents/skills/demo");
  rmSync(home, { recursive: true, force: true });
});

test("sync before init explains itself instead of failing", () => {
  const root = repo({ demo: skill("demo") });
  const { code, out } = run(["sync", "--harnesses", "claude", "--yes"], root);
  assert.equal(code, 0);
  assert.match(out, /AGENTS\.md does not exist|agentlink init/);
  rmSync(root, { recursive: true, force: true });
});

test("list shows what is linked, not merely what is installed", () => {
  const root = repo({ demo: skill("demo") });
  run(["init", "--harnesses", "claude,cursor", "--yes"], root);

  const before = JSON.parse(run(["list", "--json"], root).out);
  assert.deepEqual(before.linked.sort(), ["claude", "cursor"]);
  assert.equal(before.harnesses.find((h) => h.id === "claude").selected, true);

  // Deselecting has to be visible, and has to be reflected in the header count.
  run(["sync", "--harnesses", "claude", "--yes"], root);
  const after = JSON.parse(run(["list", "--json"], root).out);
  assert.deepEqual(after.linked, ["claude"]);
  assert.equal(after.harnesses.find((h) => h.id === "cursor").selected, false);
  assert.equal(typeof after.harnesses.find((h) => h.id === "cursor").installed, "boolean");
  assert.match(run(["list"], root).out, /1 linked/);
  rmSync(root, { recursive: true, force: true });
});

test("a run that changes the saved selection says so", () => {
  const root = repo({ demo: skill("demo") });
  run(["init", "--harnesses", "claude,qwen", "--yes"], root);

  const dropped = run(["sync", "--harnesses", "claude", "--yes"], root);
  assert.match(dropped.out, /select\s+1 harness \(was 2\): -qwen/, "the drop is named");
  assert.match(dropped.out, /removed \(no longer wanted\)/, "and the link is pruned");

  const restored = run(["sync", "--harnesses", "claude,qwen", "--yes"], root);
  assert.match(restored.out, /\+qwen/, "re-adding is named too");

  const json = JSON.parse(run(["sync", "--harnesses", "claude", "--yes", "--json"], root).out);
  assert.deepEqual(json.selection.removed, ["qwen"]);
  assert.deepEqual(json.selection.harnesses, ["claude"]);
  rmSync(root, { recursive: true, force: true });
});

test("list explains the unverified marker", () => {
  const root = repo({ demo: skill("demo") });
  const { out } = run(["list"], root);
  assert.match(out, /unverified.*vendor's docs do not confirm/i);
  assert.match(out, /not an error/i);
  assert.match(out, /linked.*not linked/);
  rmSync(root, { recursive: true, force: true });
});
