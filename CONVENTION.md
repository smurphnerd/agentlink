# The agentlink convention

A convention for repositories and home directories that several coding agents read. It exists so that a team can use different agents without maintaining a copy of the same instructions per agent.

## The rule

Two paths hold real content. Every harness-specific path that a tool reads is a symlink to one of them.

```
AGENTS.md                              instructions
.agents/
  skills/<skill-name>/SKILL.md         one directory per skill
  <topic>.md                           optional extra docs
  agentlink.json                       selection and link state (written by the CLI)
```

Links point at these, for example `CLAUDE.md -> AGENTS.md` and `.claude/skills/release -> ../../.agents/skills/release`. The links are relative, so a clone or a `git worktree` resolves them at any path.

## Normative rules

1. `AGENTS.md` at the root of the repository, or at `$HOME` for global instructions, is the only instructions file. Other names are links.
2. Every skill is a directory under `.agents/skills/` containing `SKILL.md`. Supporting files stay inside that directory.
3. A skill directory and its frontmatter `name` are the same lowercase-hyphenated string, 1 to 64 characters, matching `[a-z0-9]+(-[a-z0-9]+)*`.
4. `SKILL.md` carries frontmatter with `name` and `description`. The description states what the skill does and when to use it.
5. Never edit a file that is a symlink, and never create a sibling next to one. Edit the file it points at.
6. Documentation that is not a skill goes under `.agents/`, or in an `AGENTS.md` inside the subdirectory it applies to.
7. Run `agentlink sync` after adding, renaming, or moving a skill or doc.
8. Harness instruction aliases are committed to git. Skill links are listed in `.gitignore` inside a block marked `# agentlink:begin`, which `agentlink sync` owns. Do not edit the block by hand.

Rules 1 to 7 are format requirements, not preferences. Harnesses fail silently when they are broken: a skill whose name disagrees with its directory loads in some tools and not others, and an edited symlink leaves the canonical copy stale.

Rule 8 is a trade-off rather than a requirement. Committing an instructions alias costs one small file and makes a fresh clone work for a teammate on a different harness. Committing skill links costs a symlink per skill per harness, and buys nothing that `agentlink sync` does not regenerate on demand.

## The clause

`agentlink sync` appends this block to `AGENTS.md`, between markers, so a future agent that has never seen the CLI can follow the convention. Paste it by hand if you are adopting the convention without the tool.

```markdown
<!-- agentlink:begin v1 -->
## Agent docs and skills: one source of truth

This repository keeps exactly one copy of every agent instruction file and skill.
Paths such as `CLAUDE.md`, `GEMINI.md`, `.claude/skills/` and `.cursor/skills/`
are symlinks maintained by `agentlink`. Never edit a symlink, and never create a
file next to one — edit or create the source it points to.

- **Instructions** live in `AGENTS.md` at the repository root.
- **Skills** live in `.agents/skills/<skill-name>/SKILL.md`, one directory per skill.
- **Extra documentation** goes under `.agents/` (for example `.agents/testing.md`),
  or in an `AGENTS.md` in the subdirectory it applies to.
- **Naming**: the skill directory and its frontmatter `name` are the same
  lowercase-hyphenated string, 1-64 characters (`pdf-forms`, not `PDF_Forms`).
  `SKILL.md` needs frontmatter with `name` and a `description` that states what
  the skill does *and* when to use it. Keep scripts and references inside the
  skill directory and link them with relative paths.
- **After adding, renaming, or moving a skill or doc**, run `npx agentlink sync`
  so every harness picks up the change.
<!-- agentlink:end -->
```

The markers make the block idempotent and replaceable: sync rewrites the block in place when the convention changes, and never touches the text around it.

## Adopting by hand

```bash
# 1. Instructions
git mv CLAUDE.md AGENTS.md      # or merge the content by hand
ln -s AGENTS.md CLAUDE.md

# 2. Skills
mkdir -p .agents/skills
git mv .claude/skills/release .agents/skills/release
ln -s ../../.agents/skills/release .claude/skills/release
cat >> .gitignore <<'EOF'

# agentlink:begin
.claude/skills/
# agentlink:end
EOF

# 3. The clause
# paste the block above into AGENTS.md
```

Then run `npx agentlink sync` to create the remaining links and `npx agentlink doctor` to check the result. `doctor` exits non-zero when it finds an error, which makes it usable as a CI check on a repository that has adopted the convention.

## Related

The naming and layout rules for skills come from the [Agent Skills specification](https://agentskills.io/specification). The instructions file name comes from [agents.md](https://agents.md/). Both are implemented by most of the harnesses listed in the [README](README.md#what-gets-linked).
