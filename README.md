# agentlink

Every coding agent reads its own files. Claude Code wants `CLAUDE.md` and `.claude/skills/`. Codex reads `AGENTS.md` and `$HOME/.agents/skills`. The other fifteen picked something else again. Use two agents on one repository and you are keeping two copies of the same instructions, which drift.

agentlink reduces that to one rule. Two paths are real:

- `AGENTS.md` holds the instructions.
- `.agents/skills/<name>/SKILL.md` holds each skill.

Everything any harness reads is a symlink to one of those.

## Quick start

```bash
cd your-project
npx agentlink init
```

`init` prints a checklist of all 17 known harnesses, with the ones installed on your machine already ticked. Confirm, and it creates `AGENTS.md` and `.agents/skills/`, appends a clause that tells future agents how the convention works, and symlinks each selected harness at the canonical files. The selection is saved in `.agents/agentlink.json`, so later runs need no input.

After you add or move a skill:

```bash
npx agentlink sync
```

## Commands

```
agentlink                pick harnesses (first run), then link
agentlink init           create AGENTS.md + .agents/skills, migrate, link
agentlink sync           re-link after adding or moving a skill
agentlink fix            fold stray real copies into .agents, then link
agentlink select         change which harnesses are linked
agentlink list           every harness, where it reads from, whether it is installed
agentlink doctor         drift, duplicates, invalid skills, broken links
agentlink adopt          move an existing CLAUDE.md or GEMINI.md into AGENTS.md
agentlink unlink         remove the links agentlink created
```

`init` does the whole conversion in one pass, including skills that already exist as real directories inside a harness folder. An orphan copy is moved into `.agents/skills/` and linked back. A copy identical to the canonical one is deleted. A copy that differs is reported and left alone until you have looked at it; `agentlink fix --force` drops the copy in favour of the canonical one.

Options: `--global` (`-g`) for `$HOME` instead of a repository, `--harnesses a,b` to skip the picker, `--all`, `--detected`, `--dry-run`, `--yes`, `--force`, `--json`, `--no-clause`.

## What gets linked

Where a harness already reads `AGENTS.md` or `.agents/skills/`, agentlink writes nothing and reports the path as native. Links appear only for harnesses that need a file in a place of their own.

| Harness | Project instructions | Project skills | Verified |
| --- | --- | --- | --- |
| Claude Code | CLAUDE.md | .claude/skills | yes |
| OpenAI Codex CLI | native | native | yes |
| Pi | native | native | yes |
| Oh My Pi (omp) | native | .omp/skills | yes |
| GitHub Copilot CLI | native | native | yes |
| Cursor | native | .cursor/skills | no |
| opencode | native | .opencode/skills | no |
| Qwen Code | native | .qwen/skills | yes |
| Kimi Code CLI | native | .kimi-code/skills | yes |
| Kilo Code | native | .claude/skills | no |
| Factory Droid | native | .factory/skills | yes |
| Devin CLI | native | .devin/skills | yes |
| Mastra Code | native | native | yes |
| Grok CLI | native | .grok/skills | yes |
| Qoder CLI | native | .qoder/skills | yes |
| Antigravity CLI | native | .agent/skills | no |
| Hermes | native | .hermes/skills | no |

Rows marked unverified come from third-party path tables or could not be confirmed in vendor documentation. `agentlink list --json` prints the source URL for every row, and `doctor` flags unverified rows in the active selection. The global scope has more unverified rows than the project scope, because fewer vendors document where their home-directory instruction file lives.

## Global scope

`agentlink --global` applies the same convention to your home directory, so personal skills and standing preferences follow you into every repository:

```
~/AGENTS.md              global instructions
~/.agents/skills/        personal skills
```

Each harness gets a link from its own home-directory file, for example `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. Harnesses that already read `~/.agents/skills/` get nothing, which is the point of the convention: the standard path is the one with the real files.

## Git

To git, a symlink is an ordinary tracked file. Nothing is ignored by default, so `agentlink` writes the rules for the paths it creates into a marked block in `.gitignore`. The default split is the one repositories already converge on, including langfuse, which commits `CLAUDE.md` as a symlink and ignores `.claude/skills/`.

- Instructions aliases (`CLAUDE.md`, `.codex/AGENTS.md`) are committed. They are one small file, and they are what makes a fresh clone work for a teammate on a different harness.
- Skill links are ignored. They are derived from `.agents/skills/` and multiply with every skill and harness, and their parent directories hold machine-local harness state.

`--ignore=all` ignores both, for a repository where everyone runs `agentlink sync` after cloning. `--ignore=none` leaves `.gitignore` alone. The choice is stored in `.agents/agentlink.json`, so later runs keep it. `agentlink unlink` removes the block and leaves the rest of `.gitignore` untouched.

```gitignore
# agentlink:begin
.claude/skills/
.cursor/skills/
# agentlink:end
```

One caveat about committing the aliases. Git checks symlinks out as plain text files when `core.symlinks` is false, which is how Git for Windows behaves until symlink support is enabled. A teammate there gets a `CLAUDE.md` whose contents are the string `AGENTS.md`. Teams with Windows checkouts should use `--ignore=all` and run `sync` after cloning.

## Safety

None of this is done by overwriting.

If a harness file already exists as a real file, sync leaves it alone and reports it as blocked. For an instructions file, `agentlink adopt` handles the migration: it renames `CLAUDE.md` to `AGENTS.md`, then links the old name back, so `git diff` shows one rename and you keep every line. When both files contain real content, adopt refuses and says so, because merging is a judgement call.

`agentlink unlink` removes a symlink only when it still points at `AGENTS.md` or into `.agents/`. Anything that has become a real file gets kept and reported. Empty directories left behind are pruned.

Every command takes `--dry-run`.

## Limits worth knowing

Claude Code has open reports of symlinked skill directories working but not appearing in `/skills`. The link is real and the content is reachable; the listing may miss it. If that turns out to matter, `agentlink unlink` restores the previous state and you can copy the skill directory instead.

Harnesses that read `.agents/skills/` natively get no link at all, which means there is nothing for agentlink to repair if the harness changes its mind. `doctor` re-checks the table against what is selected, not against the vendor's current docs.

The Agent Skills specification requires a skill's `name` to match its directory. Pi relaxes that rule so one skills directory can serve several tools. `doctor` warns when the two differ, since the other harnesses stay strict.

## Repository layout

```
src/harnesses.ts   the path table, one row per harness, with a source URL
src/link.ts        planning and creating symlinks
src/convention.ts  the AGENTS.md clause, scaffolding, adoption
src/doctor.ts      diagnostics and skill validation
src/cli.ts         command dispatch and output
src/ui.ts          the checkbox picker, no dependencies
```

Zero runtime dependencies. `npm run build` runs `tsc` into `dist/`.

## Tests

```bash
npm test     # tsc, then node --test over test/
```

No test framework. The suite covers the path table invariants, symlink planning and repair, the `.gitignore` block, the AGENTS.md clause, duplicate migration, and the CLI run end to end in throwaway git repositories.

## Adding a harness

Add one row to `HARNESSES` in `src/harnesses.ts` and cite the documentation you read it from. State for each scope whether the harness reads the canonical path already, needs an alias, or has no documented answer. Rows with no answer print as unknown instead of writing a symlink somewhere the harness never looks.
