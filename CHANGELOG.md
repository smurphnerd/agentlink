# Changelog

## 0.1.1

- `list` shows what is linked rather than only what is installed. A `✓` means
  agentlink is linking that harness; a trailing note appears when a harness is
  installed but not linked, or linked but not installed. `list --json` gains
  `selected` and a top-level `linked` array.
- Fixed: `list` printed one mark for two different facts, so a deselected
  harness looked selected. The selection itself was always saved correctly.
- `list` explains what `unverified` means: the vendor's docs do not confirm that
  path, so the link may sit where nothing reads it. It is not an error.
- An explicit `--harnesses`, `--all` or `--detected` sets the saved selection, so
  sync now reports what it added or dropped instead of changing it quietly.
  `sync --json` gains `selection.added` and `selection.removed`.

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
