import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { upsertClause, CLAUSE, BEGIN_MARKER, END_MARKER } from "../dist/convention.js";
import { hashTree } from "../dist/fix.js";
import { HARNESSES, resolveHarnessList } from "../dist/harnesses.js";
import { applyIgnoreBlock } from "../dist/ignore.js";
import { expandHome, findRepoRoot, listSubdirectories, resolveScope } from "../dist/scope.js";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "agentlink-unit-"));
}

test("harness table rows are well formed", () => {
  const ids = new Set();
  for (const harness of HARNESSES) {
    assert.ok(harness.id, "id is required");
    assert.ok(!ids.has(harness.id), `duplicate id ${harness.id}`);
    ids.add(harness.id);
    assert.ok(harness.label, `${harness.id} needs a label`);
    assert.ok(harness.source?.startsWith("http"), `${harness.id} needs a documentation source`);
    assert.ok(harness.bins.length > 0, `${harness.id} needs a detection binary`);
    assert.ok(harness.configRoot && !harness.configRoot.startsWith("/"), `${harness.id} configRoot is home-relative`);
    if (harness.npmPackage !== undefined) {
      assert.match(harness.npmPackage, /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/, `${harness.id} npmPackage looks like a package name`);
    }

    for (const scope of ["project", "global"]) {
      for (const group of ["instructions", "skills"]) {
        const endpoint = harness[group][scope];
        assert.ok(endpoint, `${harness.id}.${group}.${scope} is missing`);
        assert.equal(typeof endpoint.native, "boolean");
        if (endpoint.alias !== undefined) {
          assert.equal(endpoint.native, false, `${harness.id}.${group}.${scope} cannot be both native and an alias`);
          assert.ok(!endpoint.alias.startsWith("/"), `${harness.id} alias must be relative`);
          assert.ok(!endpoint.alias.endsWith("/"), `${harness.id} alias must not end with a slash`);
          assert.ok(!endpoint.alias.includes(".."), `${harness.id} alias must stay inside the scope root`);
        }
      }
    }
  }
});

test("harnesses that read the canonical paths declare nothing to link", () => {
  const codex = HARNESSES.find((h) => h.id === "codex");
  assert.equal(codex.skills.project.native, true);
  assert.equal(codex.skills.global.native, true);
  assert.equal(codex.skills.project.alias, undefined);
  assert.equal(codex.instructions.project.native, true);
});

test("resolveHarnessList reports unknown names instead of guessing", () => {
  const { found, unknown } = resolveHarnessList("claude, nope ,codex");
  assert.deepEqual(found.map((h) => h.id), ["claude", "codex"]);
  assert.deepEqual(unknown, ["nope"]);
});

test("upsertClause inserts once and is idempotent", () => {
  const first = upsertClause("# Title\n\nBody.\n");
  assert.equal(first.action, "inserted");
  assert.ok(first.text.includes(BEGIN_MARKER) && first.text.includes(END_MARKER));
  assert.equal(first.text.split(BEGIN_MARKER).length - 1, 1);

  const second = upsertClause(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.action, "unchanged");
  assert.equal(second.text, first.text);

  const third = upsertClause("# Title\n\nBody.\n");
  assert.equal(third.text, first.text, "same input produces same output");
});

test("upsertClause replaces a stale clause in place and preserves surrounding text", () => {
  const stale = `# Title\n\n${BEGIN_MARKER}\nold text\n${END_MARKER}\n\n## After\n`;
  const result = upsertClause(stale);
  assert.equal(result.action, "updated");
  assert.ok(result.text.includes("## After"), "text after the block survives");
  assert.ok(result.text.includes("# Title"), "text before the block survives");
  assert.ok(!result.text.includes("old text"));
  assert.ok(result.text.includes(CLAUSE));
});

test("upsertClause does not duplicate the block across many runs", () => {
  let text = "# Title\n";
  for (let i = 0; i < 5; i += 1) text = upsertClause(text).text;
  assert.equal(text.split(BEGIN_MARKER).length - 1, 1);
  assert.equal(text.split(END_MARKER).length - 1, 1);
});

test("gitignore block is insert, replace and remove stable", () => {
  const base = "node_modules/\n*.log\n";
  const added = applyIgnoreBlock(base, [".claude/skills/"]);
  assert.equal(added.status, "updated");
  assert.ok(added.text.includes("# agentlink:begin"));
  assert.ok(added.text.endsWith("# agentlink:end\n"));
  assert.ok(added.text.startsWith("node_modules/\n*.log\n"), "user rules stay first");

  const replaced = applyIgnoreBlock(added.text, [".cursor/skills/"]);
  assert.ok(!replaced.text.includes(".claude/skills/"));
  assert.equal(applyIgnoreBlock(replaced.text, [".cursor/skills/"]).status, "unchanged", "idempotent");

  const removed = applyIgnoreBlock(replaced.text, []);
  assert.equal(removed.status, "updated");
  assert.equal(removed.text, base, "removal restores the file exactly");
});

test("gitignore block handles a file with no trailing newline", () => {
  const added = applyIgnoreBlock("node_modules/", [".claude/skills/"]);
  assert.equal(added.text, "node_modules/\n\n# agentlink:begin\n.claude/skills/\n# agentlink:end\n");
  assert.equal(applyIgnoreBlock(added.text, []).text, "node_modules/\n");
});

test("gitignore editing leaves blank lines elsewhere alone", () => {
  const base = "a/\n\n\n\nb/\n\n\nc/\n";
  const added = applyIgnoreBlock(base, ["x/"]);
  assert.ok(added.text.startsWith(base), "the user's spacing is byte-identical");
  assert.equal(applyIgnoreBlock(added.text, []).text, base);
});

test("an unterminated or stray marker is refused, never guessed at", () => {
  const lone = "# agentlink:begin\n.claude/skills/\nmy-own-rule/\n";
  const result = applyIgnoreBlock(lone, [".cursor/skills/"]);
  assert.equal(result.status, "malformed");
  assert.equal(result.text, lone, "the file is returned untouched");

  const strayEnd = "my-own-rule/\n# agentlink:end\n";
  assert.equal(applyIgnoreBlock(strayEnd, ["x/"]).text, strayEnd);

  const similar = "# agentlink:beginning of my notes\nkeep-me/\n";
  const added = applyIgnoreBlock(similar, ["x/"]);
  assert.ok(added.text.startsWith(similar), "a lookalike comment is not the marker");
  assert.equal(applyIgnoreBlock(added.text, ["x/"]) && added.status, "updated");
});

test("hashTree ignores line ending differences but not content", () => {
  const dir = tempDir();
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  const c = path.join(dir, "c");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  mkdirSync(c, { recursive: true });
  writeFileSync(path.join(a, "SKILL.md"), "line one\nline two\n");
  writeFileSync(path.join(b, "SKILL.md"), "line one\r\nline two\r\n");
  writeFileSync(path.join(c, "SKILL.md"), "line one\ndifferent\n");

  assert.equal(hashTree(a), hashTree(b));
  assert.notEqual(hashTree(a), hashTree(c));
  rmSync(dir, { recursive: true, force: true });
});

test("hashTree notices added, renamed and nested files", () => {
  const dir = tempDir();
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  mkdirSync(path.join(a, "nested"), { recursive: true });
  mkdirSync(path.join(b, "nested"), { recursive: true });
  writeFileSync(path.join(a, "nested", "file.txt"), "x");
  writeFileSync(path.join(b, "nested", "file.txt"), "x");
  assert.equal(hashTree(a), hashTree(b));

  writeFileSync(path.join(b, "extra.txt"), "y");
  assert.notEqual(hashTree(a), hashTree(b));

  rmSync(path.join(b, "extra.txt"));
  writeFileSync(path.join(b, "nested", "renamed.txt"), "x");
  rmSync(path.join(b, "nested", "file.txt"));
  assert.notEqual(hashTree(a), hashTree(b));
  rmSync(dir, { recursive: true, force: true });
});

test("findRepoRoot walks up and stops at the repository", () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, ".git"));
  mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  assert.equal(findRepoRoot(path.join(dir, "a", "b")), dir);
  assert.equal(findRepoRoot(dir), dir);
  rmSync(dir, { recursive: true, force: true });
});

test("resolveScope uses the repo root for projects and home for global", () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, ".git"));
  mkdirSync(path.join(dir, "src"));
  const project = resolveScope("project", path.join(dir, "src"));
  assert.equal(project.root, dir);
  assert.equal(project.instructions, path.join(dir, "AGENTS.md"));
  assert.equal(project.skills, path.join(dir, ".agents", "skills"));

  const global = resolveScope("global", dir);
  assert.equal(global.skills, path.join(expandHome("~"), ".agents", "skills"));
  rmSync(dir, { recursive: true, force: true });
});

test("listSubdirectories skips dotfiles and missing directories", () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, "one"));
  mkdirSync(path.join(dir, "two"));
  mkdirSync(path.join(dir, ".hidden"));
  writeFileSync(path.join(dir, "file.md"), "x");
  assert.deepEqual(listSubdirectories(dir), ["one", "two"]);
  assert.deepEqual(listSubdirectories(path.join(dir, "missing")), []);
  rmSync(dir, { recursive: true, force: true });
});
