# Changelog

## 0.2.3

- Hermes reads `.agents/skills` in a project, from
  `PROJECT_SKILLS_SUBDIRS = (".hermes/skills", ".agents/skills")` in its source.
  That scope is no longer unknown, and the note records the catch: project
  skills "load only when the root is in `skills.trusted_project_dirs`", because
  auto-sourcing skills from any clone is a prompt-injection vector. Its
  home-directory skills stay an alias on `~/.hermes/skills`.
- Kimi reads `~/.agents/AGENTS.md` as the cross-tool global instruction file, so
  that alias is now native and no longer writes a link.

The README's warning about Claude Code and symlinked skills was too pessimistic
and is replaced with what was measured: a symlinked `~/.claude/skills/web-perf`
is offered to the model, while the sandboxed mount loader and the onboarding
importer both decline symlinked sources for their own reasons.

The verifier had two faults of its own, both producing confident nonsense, and
both fixed: it resolved a platform binary by looking in `dependencies` as well as
`optionalDependencies`, which sent qwen to a transitive native module and qoder
to a ripgrep binary; and it drew conclusions from binaries whose strings are not
recoverable, where GitHub's Copilot CLI yields 5 path-like strings from 143 MB.
It now scans the main package first and only looks for a platform package when
the main one is a stub, and it reports no verdict rather than an absence when too
little evidence comes back.

## 0.2.2

More rows corrected from vendor documentation, after several people pointed at
pages that document the canonical path directly.

- Cursor reads `.agents/skills/` and `~/.agents/skills/`, and `AGENTS.md` at the
  project root and in subdirectories. Its skills need no link, and its user rules
  live in settings rather than a file, so there is nothing to link globally.
- Antigravity reads `.agents/skills/` in the workspace. `.agent/skills` was the
  deprecated fallback, and `.gemini/config/skills` is the confirmed global
  directory. Global constraints are `~/.gemini/GEMINI.md`, not the
  `.gemini/config/AGENTS.md` that was guessed.
- Kimi reads `.agents/skills/` at both project and user level, so neither scope
  needs a link.
- opencode auto-loads `~/.agents/skills/`, so only its project directory needs
  linking.
- Hermes reads `AGENTS.md` by walking to the git root, and keeps all skills in
  `~/.hermes/skills/`. It has no documented project-level skills directory, so
  that scope now reports as unknown instead of linking somewhere unread.
- Kilo Code's global instructions file is flagged unverified; a table test now
  fails when a row's note admits doubt while its flag claims confirmation.

Nine of seventeen harnesses now need no skills link at all.

## 0.2.1

- Fixed: `select` remembered your selection but the picker did not use it, so
  every run re-ticked every installed harness and a harness you removed came
  back by default. The picker now starts from the saved selection, and falls
  back to what is installed only on a first run.
- The picker's help line says the current selection is pre-ticked, and a
  harness kept in the selection but no longer installed is labelled
  "still linked" rather than looking like a stray checkbox.

## 0.2.0

Corrects the path table against the code each harness actually ships, checked
with `scripts/verify-paths.mjs`. Paths now come from evidence rather than from
documentation that may describe an older layout.

- Qoder and Grok read `.agents/skills` themselves, so they need no link. Both
  were aliases; Qoder's own directory holds settings and repowiki, not skills,
  and Grok's binary states that it scans `.agents/skills/` at every tier.
- opencode's `.opencode/skills` is confirmed in its shipped binary.
- Kilo Code's skills path is now reported as unknown. `.claude/skills` came from
  a third-party table and appears nowhere in its 195 MB binary, so agentlink
  stopped writing links there rather than guessing.
- Factory Droid's home-directory instructions file has no evidence behind it and
  is flagged unverified, though both of its skills paths are confirmed.
- Claude Code, Codex, Pi, Copilot, Qwen and Mastra Code rows were confirmed as
  they stood.

## 0.1.2

- `list` explains what `unverified` means: the vendor's docs do not confirm that
  path, so the link may sit where nothing reads it. It is not an error.
- An explicit `--harnesses`, `--all` or `--detected` sets the saved selection, so
  sync now reports what it added or dropped instead of changing it quietly.
  `sync --json` gains `selection.added` and `selection.removed`.
- Colour is written only to a TTY, and `NO_COLOR` is honoured, so piped output
  and CI logs contain no escape codes.

## 0.1.1

- `list` shows what is linked rather than only what is installed. A `✓` means
  agentlink is linking that harness; a trailing note appears when a harness is
  installed but not linked, or linked but not installed. `list --json` gains
  `selected` and a top-level `linked` array.
- Fixed: `list` printed one mark for two different facts, so a deselected
  harness looked selected. The selection itself was always saved correctly.

## 0.1.0

First release.

- `agentlink init` creates `AGENTS.md` and `.agents/skills/`, adopts an existing
  `CLAUDE.md` or `GEMINI.md`, folds stray real skill directories into the
  canonical tree, and links every selected harness.
- Symlinks are relative, so clones and git worktrees resolve at any path.
- 17 harnesses, with a documentation source per row. Harnesses that already read
  `AGENTS.md` or `.agents/skills/` are reported as native and left alone. Rows
  with no documented path report as unknown instead of linking somewhere nothing
  reads.
- `sync`, `fix`, `select`, `list`, `doctor`, `adopt` and `unlink`, plus `--global`
  for a home-directory setup.
- An idempotent clause appended to `AGENTS.md` so future agents follow the
  convention without a human explaining it.
- A marked `.gitignore` block: instructions aliases are committed, skill links
  are ignored. `--ignore=skills|all|none`.
- Zero runtime dependencies, 59 tests, verified on Node 20, 22, 24 and 26.
