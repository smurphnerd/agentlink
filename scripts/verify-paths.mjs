#!/usr/bin/env node
/**
 * Check the harness table against the code that actually ships.
 *
 * For every harness that publishes an official npm package, download the
 * published tarball, extract printable strings from everything inside (JS
 * sources and compiled binaries alike), and report:
 *
 *   - which paths in our table appear verbatim in the shipped artifact, and
 *   - which skill- or instruction-looking paths appear that our table does not
 *     know about.
 *
 * The second list is the point. A path we invented shows up as "no evidence",
 * and a path we got wrong shows up as a discovered alternative.
 *
 * Only vendors' own packages are used. Third-party packages whose names merely
 * resemble a harness (cursor-agent, kimi-code, hermes-agent) are deliberately
 * excluded: inspecting the wrong artifact is how a wrong path gets into a table.
 *
 *   node scripts/verify-paths.mjs                 # every harness with an npm package
 *   node scripts/verify-paths.mjs --only claude   # one harness
 *   node scripts/verify-paths.mjs --json
 *   node scripts/verify-paths.mjs --keep          # leave extracted trees in place
 *
 * Notes for whoever edits this next: a compiled harness bundle is tens of
 * megabytes of mostly-printable data. Neither `String.match` with the global
 * flag nor `Array.push(...matches)` survives that (both overflow the stack), so
 * every pass here is chunked and every accumulation is a plain loop.
 */
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HARNESSES } from "../dist/harnesses.js";

const CHUNK = 512 * 1024;
/** Overlap so a path literal split across a chunk boundary is still seen. */
const OVERLAP = 128;
const MAX_UNIQUE_TOKENS = 3000;
const MIN_TOKEN = 4;
const MAX_TOKEN = 90;

/** A flat character class, deliberately: a keyword with quantifiers on both
 *  sides backtracks catastrophically on a bundle. */
const CANDIDATE = /[A-Za-z0-9_.@~$/-]{4,90}/g;
const PRINTABLE = /[\x20-\x7E]{6,}/g;
const INSTRUCTIONS = /(?:AGENTS|CLAUDE|GEMINI|QWEN|CONTEXT|CRUSH|WARP)\.md/;
const CONFIG_TOKEN = /[A-Za-z0-9_.@~$/-]{4,90}/g;

const args = process.argv.slice(2);
const only = pickFlag("--only")?.split(",").map((s) => s.trim());
const asJson = args.includes("--json");
const keep = args.includes("--keep");

function pickFlag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Iterative: a package tree is not deep, but recursion is not worth risking. */
function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

/**
 * Hand each chunk of printable ASCII to `visit`.
 *
 * Reads through a file descriptor in fixed-size windows rather than loading the
 * file, because a compiled CLI is routinely 100-200 MB. An earlier version
 * capped file size and silently skipped anything larger, which turned a 190 MB
 * binary into "no evidence found".
 *
 * ASCII runs come from plain string literals. A chunk holding NUL bytes is also
 * rescanned with them removed, because some bundles embed UTF-16, where every
 * character is separated by a NUL and no run would survive.
 */
function scanFile(file, visit) {
  const stats = statSync(file);
  if (!stats.isFile() || stats.size === 0) return 0;
  const fd = openSync(file, "r");
  const window = CHUNK + OVERLAP;
  const buffer = Buffer.allocUnsafe(window);
  try {
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, window, position);
      if (read <= 0) break;
      const chunk = buffer.subarray(0, read).toString("latin1");
      const runs = chunk.match(PRINTABLE);
      if (runs) for (const run of runs) visit(run);
      if (chunk.includes("\u0000")) {
        const stripped = chunk.replace(/\u0000/g, "");
        const wideRuns = stripped.match(PRINTABLE);
        if (wideRuns) for (const run of wideRuns) visit(run);
      }
      if (read < window) break;
      position += CHUNK;
    }
  } finally {
    closeSync(fd);
  }
  return 1;
}

function tablePaths(harness) {
  const found = [];
  for (const scope of ["project", "global"]) {
    for (const kind of ["instructions", "skills"]) {
      const endpoint = harness[kind][scope];
      if (endpoint.alias) found.push({ scope, kind, value: endpoint.alias });
    }
  }
  return found;
}

function spawn(command, argv) {
  return execFileSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Most CLIs publish a wrapper that pulls the real binary from a
 * platform-specific package. Following that indirection is the difference
 * between "no evidence" and the actual answer, so resolve it before scanning.
 */
function resolvePackage(harness) {
  const suffix = `${process.platform === "darwin" ? "darwin" : process.platform}-${process.arch}`;
  const meta = JSON.parse(spawn("npm", ["view", harness.npmPackage, "--json"]));
  const optional = { ...(meta.optionalDependencies ?? {}), ...(meta.dependencies ?? {}) };
  const platform = Object.keys(optional).find((name) => name.includes(suffix));
  if (!platform) return harness.npmPackage;
  try {
    spawn("npm", ["view", platform, "version"]);
    return platform;
  } catch {
    return harness.npmPackage;
  }
}

function verify(harness) {
  const dir = mkdtempSync(path.join(tmpdir(), `verify-${harness.id}-`));
  try {
    const wanted = resolvePackage(harness);
    const tarball = spawn("npm", ["pack", wanted, "--pack-destination", dir, "--silent"])
      .trim()
      .split("\n")
      .pop();
    spawn("tar", ["-xzf", path.join(dir, tarball), "-C", dir]);

    const files = walk(path.join(dir, "package"));
    const expected = tablePaths(harness);
    const seen = new Set();
    const counts = new Map();
    const canonical = { agentsMd: false, agentsSkills: false, claudeSkills: false };
    const configTokens = new Set();
    let bytes = 0;
    let scanned = 0;

    for (const file of files) {
      bytes += statSync(file).size ?? 0;
      scanned += scanFile(file, (run) => {
        for (const entry of expected) {
          if (!seen.has(entry.value) && run.includes(entry.value)) seen.add(entry.value);
        }
        if (!canonical.agentsMd && INSTRUCTIONS.test(run)) canonical.agentsMd = true;
        if (!canonical.agentsSkills && run.includes(".agents/skills")) canonical.agentsSkills = true;
        if (!canonical.claudeSkills && run.includes(".claude/skills")) canonical.claudeSkills = true;

        // Any path mentioning this harness's own config directory, which is where
        // a skills or instructions file would live.
        if (configTokens.size < 200) {
          const mentions = run.match(CONFIG_TOKEN);
          if (mentions) for (const token of mentions) {
            if (token.includes(harness.configRoot)) configTokens.add(token);
          }
        }

        if (counts.size >= MAX_UNIQUE_TOKENS) return;
        const candidates = run.match(CANDIDATE);
        if (!candidates) return;
        for (const token of candidates) {
          if (token.length < MIN_TOKEN || token.length > MAX_TOKEN) continue;
          // Path-shaped only. "getSkillManager" and "skillName" are identifiers;
          // a path has a separator or is a Markdown filename.
          const looksLikeAPath = token.includes("/") || /\.md$/.test(token);
          if (!looksLikeAPath) continue;
          if (!/skill|\.md$/i.test(token)) continue;
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      });
    }

    // A package that installs a binary contains only a downloader. "ABSENT" in a
    // stub means "not in the stub", not "not in the harness".
    const thin = bytes < 1024 * 1024;
    const present = thin ? [] : expected.filter((entry) => seen.has(entry.value));
    const missing = thin ? [] : expected.filter((entry) => !seen.has(entry.value));

    return {
      thin,
      id: harness.id,
      package: wanted,
      configRoot: harness.configRoot,
      files: scanned,
      megabytes: Math.round(bytes / 1024 / 1024),
      present: present.map((e) => `${e.value} (${e.scope} ${e.kind})`),
      missing: missing.map((e) => `${e.value} (${e.scope} ${e.kind})`),
      canonical,
      discovered: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20),
      configPaths: [...configTokens].sort().slice(0, 20),
    };
  } catch (error) {
    return { id: harness.id, package: harness.npmPackage, error: String(error.message ?? error).slice(0, 160) };
  } finally {
    if (keep) console.error(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

const exe = pickFlag("--exe");
if (exe) {
  const target = path.resolve(exe);
  const files = statSync(target).isDirectory() ? walk(target) : [target];
  const found = new Map();
  const canonical = { agentsMd: false, agentsSkills: false, claudeSkills: false };
  const counts = new Map();
  let bytes = 0;
  for (const file of files) {
    bytes += statSync(file).size ?? 0;
    scanFile(file, (run) => {
      if (!canonical.agentsMd && INSTRUCTIONS.test(run)) canonical.agentsMd = true;
      if (!canonical.agentsSkills && run.includes(".agents/skills")) canonical.agentsSkills = true;
      if (!canonical.claudeSkills && run.includes(".claude/skills")) canonical.claudeSkills = true;
      const candidates = run.match(CONFIG_TOKEN);
      if (!candidates) return;
      for (const token of candidates) {
        if (token.length < MIN_TOKEN || token.length > MAX_TOKEN) continue;
        const pathish = token.includes("/") || /\.md$/.test(token);
        if (!pathish) continue;
        if (!/skill|\.md$|agents/i.test(token)) continue;
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    });
  }
  console.log(`${target} — ${files.length} file(s), ${Math.round(bytes / 1024 / 1024)} MB`);
  console.log(
    `  canonical: ${[
      canonical.agentsMd ? "AGENTS.md" : null,
      canonical.agentsSkills ? ".agents/skills" : null,
      canonical.claudeSkills ? ".claude/skills" : null,
    ]
      .filter(Boolean)
      .join(" ") || "none found"}`,
  );
  for (const [token, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`    ${String(count).padStart(6)}  ${token}`);
  }
  process.exit(0);
}

const targets = HARNESSES.filter((h) => h.npmPackage && (!only || only.includes(h.id)));
if (targets.length === 0) {
  console.error("no harness with an npmPackage matched");
  process.exit(1);
}

const results = targets.map(verify);

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) {
    if (result.error) {
      console.log(`\n${result.id} (${result.package}) — FAILED: ${result.error}`);
      continue;
    }
    console.log(`\n${result.id} (${result.package}) — ${result.files} files scanned, ${result.megabytes} MB`);
    if (result.thin) {
      console.log(`  thin even after resolution (${result.package}): no evidence either way`);
      console.log("  point --exe at an installed binary to check the real thing");
    } else {
      console.log(`  present  : ${result.present.join(", ") || "NONE"}`);
      if (result.missing.length) console.log(`  ABSENT   : ${result.missing.join(", ")} (weak: a path built at runtime is never a literal)`);
    }
    console.log(
      `  canonical: ${[
        result.canonical.agentsMd ? "AGENTS.md" : null,
        result.canonical.agentsSkills ? ".agents/skills" : null,
        result.canonical.claudeSkills ? ".claude/skills" : null,
      ]
        .filter(Boolean)
        .join(" ") || "none found"}`,
    );
    for (const [token, count] of result.discovered) console.log(`    ${String(count).padStart(6)}  ${token}`);
    if (result.configPaths?.length) {
      console.log(`  paths naming ~/${result.configRoot.replace(/^\./, ".")}/…`);
      for (const token of result.configPaths) console.log(`           ${token}`);
    }
  }
}
