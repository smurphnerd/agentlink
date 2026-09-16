# agentlink

Every coding agent reads its own files. Claude Code wants `CLAUDE.md` and `.claude/skills/`. Codex reads `AGENTS.md` and `$HOME/.agents/skills`. The other fifteen picked something else again. Use two agents on one repository and you are keeping two copies of the same instructions, which drift.

agentlink reduces that to one rule. Two paths are real:

- `AGENTS.md` holds the instructions.
- `.agents/skills/<name>/SKILL.md` holds each skill.

Everything any harness reads is a symlink to one of those.

## Quick start

```bash
cd your-project
npx @thesmurph/agentlink init
```

`init` prints a checklist of all 17 known harnesses, with the ones installed on your machine already ticked. Confirm, and it creates `AGENTS.md` and `.agents/skills/`, appends a clause that tells future agents how the convention works, and symlinks each selected harness at the canonical files. The selection is saved in `.agents/agentlink.json`, so later runs need no input.

After you add or move a skill:

```bash
npx @thesmurph/agentlink sync
```

## Commands

```
agentlink                pick harnesses (first run), then link
agentlink init           create AGENTS.md + .agents/skills, migrate, link
agentlink sync           re-link after adding or moving a skill
agentlink fix            fold stray real copies into .agents, then link
agentlink select         change which harnesses are linked
agentlink list           what is linked, where each harness reads from, what is installed
agentlink doctor         drift, duplicates, invalid skills, broken links
agentlink adopt          move an existing CLAUDE.md or GEMINI.md into AGENTS.md
agentlink unlink         remove the links agentlink created
```

`init` does the whole conversion in one pass, including skills that already exist as real directories inside a harness folder. An orphan copy is moved into `.agents/skills/` and linked back. A copy identical to the canonical one is deleted. A copy that differs is reported and left alone until you have looked at it; `agentlink fix --force` drops the copy in favour of the canonical one.

Options: `--global` (`-g`) for `$HOME` instead of a repository, `--harnesses a,b` to skip the picker, `--all`, `--detected`, `--dry-run`, `--yes`, `--force`, `--json`, `--no-clause`.

## What gets linked

Where a harness already reads `AGENTS.md` or `.agents/skills/`, agentlink writes nothing and reports the path as native. Links appear only for harnesses that need a file in a place of their own.

| Harness | Project instructions | Project skills | Confirmed |
| --- | --- | --- | --- |
| Claude Code | CLAUDE.md | .claude/skills | yes |
| OpenAI Codex CLI | native | native | yes |
| Pi | native | native | yes |
| Oh My Pi (omp) | native | .omp/skills | yes |
| GitHub Copilot CLI | native | native | yes |
| Cursor | native | native | yes |
| opencode | native | .opencode/skills | yes |
| Qwen Code | native | .qwen/skills | yes |
| Kimi Code CLI | native | native | yes |
| Kilo Code | native | unknown | yes |
| Factory Droid | native | .factory/skills | yes |
| Devin CLI | native | .devin/skills | yes |
| Mastra Code | native | native | yes |
| Grok CLI | native | native | yes |
| Qoder CLI | native | native | yes |
| Antigravity CLI | native | native | yes |
| Hermes | native | unknown | yes |

"native" means the harness reads `AGENTS.md` or `.agents/skills` itself, so agentlink writes nothing. Nine of the seventeen do, for skills: Codex, Pi, Copilot, Cursor, Kimi, Mastra, Grok, Qoder and Antigravity. `unknown` means no path could be established, which is Kilo Code's skills directory; agentlink links nothing there rather than guessing.

Confirmation is tracked per endpoint per scope, not per harness. Every path is checked either against the vendor's documentation or against the code they ship (`scripts/verify-paths.mjs`). What remains unconfirmed is seven **global instruction files** — Qwen, Kimi, Kilo, Droid, Mastra, Grok and Qoder. Those vendors document a project path and say nothing about a home-directory equivalent, so `doctor` names each one when it is in your selection. They are not errors: a symlink in a path nothing reads is inert, and the cost of being wrong is that one harness does not see your global instructions.

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

## CI

`doctor` exits non-zero when it finds a problem, so a repository that has adopted the convention can check itself:

```yaml
- run: npx @thesmurph/agentlink doctor
```

The selection comes from `.agents/agentlink.json`, which is committed, so this works on a runner with no harnesses installed. `doctor --harnesses a,b` checks a declared set without depending on that file. With no selection and nothing installed there is nothing to check, and `doctor` says so instead of reporting a pass.

## Safety

None of this is done by overwriting.

If a harness file already exists as a real file, sync leaves it alone and reports it as blocked. For an instructions file, `agentlink adopt` handles the migration: it renames `CLAUDE.md` to `AGENTS.md`, then links the old name back, so `git diff` shows one rename and you keep every line. When both files contain real content, adopt refuses and says so, because merging is a judgement call.

`agentlink unlink` removes a symlink only when it still points at `AGENTS.md` or into `.agents/`. Anything that has become a real file gets kept and reported. Empty directories left behind are pruned.

`sync` also removes links it created that are no longer wanted: deselect a harness with `select`, or delete a skill from `.agents/skills/`, and the leftover symlink is pruned on the next run rather than left dangling. Pruning only ever removes a symlink that still points into `.agents/`.

Every command takes `--dry-run`.

`doctor` exits non-zero when it finds an error, so it works as a CI check. A run that leaves an unresolved conflict (`init`, `fix`) also exits non-zero, which stops a scripted conversion instead of silently leaving two copies of a skill.

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

## Publishing

The first release needs your npm credentials:

```bash
npm publish --access public --otp=<code from your authenticator>
```

The name is scoped (`agentlink` is too similar to the existing, empty `agent-link`, which npm's typosquat check rejects), so publishing needs `--access public`. Publishing is also 2FA-gated, and the token `npm login` writes by default does not bypass 2FA. A granular access token with "Bypass 2FA" enabled also works, if you would rather not type a code.

After that, releases go through `.github/workflows/publish.yml` on a version tag, using trusted publishing so there is no token to rotate and provenance is attached automatically:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Configure it once on npmjs.com: package settings, Trusted publishing, GitHub Actions, with the workflow filename `publish.yml`.

## Tests

```bash
npm test     # tsc, then node --test
```

Runs on Node 20, 22, 24 and 26, which CI checks. Bare `node --test` rather than `node --test test/`: the directory form resolves differently from Node 22 onward and fails.

No test framework. The suite covers the path table invariants, symlink planning and repair, the `.gitignore` block, the AGENTS.md clause, duplicate migration, and the CLI run end to end in throwaway git repositories.

## Adding a harness

Add one row to `HARNESSES` in `src/harnesses.ts` and cite the documentation you read it from. State for each scope whether the harness reads the canonical path already, needs an alias, or has no documented answer. Rows with no answer print as unknown instead of writing a symlink somewhere the harness never looks.
