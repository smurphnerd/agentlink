/**
 * The harness table.
 *
 * Every row states, for one coding-agent harness, two things per scope
 * (project / global):
 *
 *   1. the *instructions* file it loads (AGENTS.md, CLAUDE.md, …), and
 *   2. the *skills* directory it scans.
 *
 * An endpoint is either `native` — the harness reads the canonical path
 * (`AGENTS.md`, `.agents/skills/`) on its own, so agentlink creates nothing —
 * or it has an `alias`, a path we symlink to the canonical source.
 *
 * An endpoint with neither `native: true` nor `alias` is *unknown*: we do not
 * invent a path for it. `agentlink list` prints it as unavailable rather than
 * writing a symlink somewhere the harness never looks.
 *
 * `source` is the documentation each row was read from, so a wrong row is a
 * one-line fix rather than archaeology. `verified: false` marks rows whose
 * documentation could not be confirmed.
 */
import type { Scope } from "./scope.js";

export interface Endpoint {
  /** The harness reads AGENTS.md / .agents/skills directly. */
  native: boolean;
  /** Path relative to the scope root; symlinked to the canonical source. */
  alias?: string;
  note?: string;
  /** False when no vendor documentation confirms this path. Defaults to true. */
  verified?: boolean;
}

export interface Harness {
  id: string;
  label: string;
  /** Executables checked on PATH for detection. */
  bins: string[];
  /** Config directory relative to $HOME (from `herdr integration status`). */
  configRoot: string;
  /**
   * The vendor's own npm package, where one exists. Used to check this table
   * against the code that actually ships; third-party packages with similar
   * names are deliberately absent, since inspecting the wrong artifact is how a
   * wrong path gets into a table.
   */
  npmPackage?: string;
  instructions: Record<Scope, Endpoint>;
  skills: Record<Scope, Endpoint>;
  /** Primary documentation these paths were read from. */
  source: string;
}

export function endpointVerified(endpoint: Endpoint): boolean {
  return endpoint.verified !== false;
}

/** Endpoints in a scope that no vendor documentation confirms. */
export function unverifiedEndpoints(
  harness: Harness,
  scope: Scope,
): { kind: "instructions" | "skills"; endpoint: Endpoint }[] {
  const found: { kind: "instructions" | "skills"; endpoint: Endpoint }[] = [];
  for (const kind of ["instructions", "skills"] as const) {
    const endpoint = harness[kind][scope];
    if (!endpointVerified(endpoint)) found.push({ kind, endpoint });
  }
  return found;
}

const PI_SKILLS_DOC =
  "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md";
const CODEX_SKILLS_DOC = "https://developers.openai.com/codex/skills";
const CLAUDE_SKILLS_DOC = "https://code.claude.com/docs/en/skills";
const COPILOT_SKILLS_DOC =
  "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills";
const COPILOT_INSTRUCTIONS_DOC =
  "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions";

/** Build a endpoints pair: project + global in one call. */
function scopes(project: Endpoint, global: Endpoint): Record<Scope, Endpoint> {
  return { project, global };
}

const NATIVE: Endpoint = { native: true };

export const HARNESSES: Harness[] = [
  {
    id: "claude",
    label: "Claude Code",
    bins: ["claude"],
    configRoot: ".claude",
    npmPackage: "@anthropic-ai/claude-code",
    // Claude Code reads CLAUDE.md, not AGENTS.md, and never scans .agents/skills.
    instructions: scopes(
      { native: false, alias: "CLAUDE.md", note: "Claude Code has no AGENTS.md fallback" },
      { native: false, alias: ".claude/CLAUDE.md" },
    ),
    skills: scopes(
      { native: false, alias: ".claude/skills" },
      { native: false, alias: ".claude/skills" },
    ),
    source: CLAUDE_SKILLS_DOC,
  },
  {
    id: "codex",
    label: "OpenAI Codex CLI",
    bins: ["codex"],
    configRoot: ".codex",
    npmPackage: "@openai/codex",
    // Codex reads AGENTS.md in the repo and ~/.codex/AGENTS.md globally.
    instructions: scopes(
      { native: true },
      { native: false, alias: ".codex/AGENTS.md" },
    ),
    // Codex's user-level skills directory is $HOME/.agents/skills: native both ways.
    skills: scopes(NATIVE, NATIVE),
    source: CODEX_SKILLS_DOC,
  },
  {
    id: "pi",
    label: "Pi",
    bins: ["pi"],
    configRoot: ".pi",
    npmPackage: "@earendil-works/pi-coding-agent",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".pi/agent/AGENTS.md" },
    ),
    // Pi reads ~/.agents/skills and .agents/skills directly.
    skills: scopes(NATIVE, NATIVE),
    source: PI_SKILLS_DOC,
  },
  {
    id: "omp",
    label: "Oh My Pi (omp)",
    bins: ["omp"],
    configRoot: ".omp",
    npmPackage: "@oh-my-pi/pi-coding-agent",
    instructions: scopes(
      { native: true, note: "standalone AGENTS.md via the agents-md provider" },
      { native: false, alias: ".omp/agent/AGENTS.md" },
    ),
    // omp scans its own .omp/skills trees; it does not read .agents/skills.
    skills: scopes(
      { native: false, alias: ".omp/skills" },
      { native: false, alias: ".omp/agent/skills" },
    ),
    source: "https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md",
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    bins: ["copilot"],
    configRoot: ".copilot",
    npmPackage: "@github/copilot",
    // Copilot CLI reads AGENTS.md everywhere, but its *user* instructions live
    // in a differently named file.
    instructions: scopes(
      { native: true },
      { native: false, alias: ".copilot/copilot-instructions.md" },
    ),
    skills: scopes(NATIVE, NATIVE),
    source: `${COPILOT_SKILLS_DOC} · ${COPILOT_INSTRUCTIONS_DOC}`,
  },
  {
    id: "cursor",
    label: "Cursor",
    bins: ["cursor-agent", "cursor"],
    configRoot: ".cursor",
    // AGENTS.md at the project root and in subdirectories. User rules are
    // configured in Cursor's settings, not read from a file, so there is nothing
    // to link globally.
    instructions: scopes(
      { native: true, note: "AGENTS.md at the project root and in subdirectories" },
      { native: false, note: "user rules live in Cursor settings, not in a file" },
    ),
    // .agents/skills and ~/.agents/skills are documented, so nothing to link.
    skills: scopes(NATIVE, NATIVE),
    source: "https://cursor.com/docs/skills",
  },
  {
    id: "opencode",
    label: "opencode",
    bins: ["opencode"],
    configRoot: ".config/opencode",
    npmPackage: "opencode-ai",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".config/opencode/AGENTS.md" },
    ),
    // The binary's own documentation: "External skills (auto-loaded):
    // ~/.claude/skills/<name>/SKILL.md, ~/.agents/skills/<name>/SKILL.md" and
    // "Project skills: .opencode/skill(s)/<name>/SKILL.md". So the project needs a
    // link and the home directory does not.
    skills: scopes(
      { native: false, alias: ".opencode/skills" },
      NATIVE,
    ),
    source: "https://opencode.ai/docs/rules/",
  },
  {
    id: "qwen",
    label: "Qwen Code",
    bins: ["qwen"],
    configRoot: ".qwen",
    npmPackage: "@qwen-code/qwen-code",
    instructions: scopes(
      { native: true, note: "QWEN.md is the legacy name" },
      { native: false, alias: ".qwen/AGENTS.md", note: "not documented by Qwen", verified: false },
    ),
    skills: scopes(
      { native: false, alias: ".qwen/skills" },
      { native: false, alias: ".qwen/skills" },
    ),
    source: "https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/",
  },
  {
    id: "kimi",
    label: "Kimi Code CLI",
    bins: ["kimi"],
    configRoot: ".kimi-code",
    instructions: scopes(
      { native: true },
      // "Generic cross-tool instructions can still live under ~/.agents/AGENTS.md
      // in the real OS home." So the canonical file is read and needs no link;
      // ~/.kimi-code/AGENTS.md is the Kimi-specific alternative.
      { native: true, note: "~/.agents/AGENTS.md is read as the cross-tool file" },
    ),
    // Documented at both levels under "Skill Locations": project level scans
    // .kimi-code/skills/ and .agents/skills/, user level scans
    // $KIMI_CODE_HOME/skills/ and ~/.agents/skills/.
    skills: scopes(NATIVE, NATIVE),
    source: "https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html",
  },
  {
    id: "kilo",
    label: "Kilo Code",
    bins: ["kilo"],
    configRoot: ".config/kilo",
    npmPackage: "@kilocode/cli",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".config/kilo/AGENTS.md", note: "not documented by Kilo", verified: false },
    ),
    // No skills path survived inspection of the shipped binary: its config
    // directory holds command/, themes/ and config files, and .claude/skills
    // (a third-party claim) appears nowhere in 195 MB. Reported as unknown
    // rather than linked into a directory nothing reads.
    skills: scopes(
      { native: false, note: "unresolved: not found in the shipped binary" },
      { native: false, note: "unresolved: not found in the shipped binary" },
    ),
    source: "https://github.com/intellectronica/ruler#skills-support-experimental",
  },
  {
    id: "droid",
    label: "Factory Droid",
    bins: ["droid"],
    configRoot: ".factory",
    npmPackage: "@factory/cli",
    instructions: scopes(
      { native: true, note: "AGENTS.md may also live in the home directory" },
      { native: false, alias: ".factory/AGENTS.md", note: "not found in the shipped binary", verified: false },
    ),
    skills: scopes(
      { native: false, alias: ".factory/skills" },
      { native: false, alias: ".factory/skills" },
    ),
    source: "https://docs.factory.ai/harness/skills",
  },
  {
    id: "devin",
    label: "Devin CLI",
    bins: ["devin"],
    configRoot: ".config/devin",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".config/devin/AGENTS.md" },
    ),
    skills: scopes(
      { native: false, alias: ".devin/skills" },
      { native: false, alias: ".config/devin/skills" },
    ),
    source: "https://docs.devin.ai/cli/extensibility/rules",
  },
  {
    id: "mastracode",
    label: "Mastra Code",
    bins: ["mastracode"],
    configRoot: ".mastracode",
    npmPackage: "mastracode",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".mastracode/AGENTS.md", note: "not documented by Mastra", verified: false },
    ),
    // Mastra Code lists .agents/skills as a project source and Agent Skills
    // spec compatibility, so both scopes are native.
    skills: scopes(NATIVE, NATIVE),
    source: "https://code.mastra.ai/configuration",
  },
  {
    id: "grok",
    label: "Grok CLI",
    bins: ["grok"],
    configRoot: ".grok",
    instructions: scopes(
      { native: true, note: "reads AGENTS.md, CLAUDE.md, AGENT.md" },
      { native: false, alias: ".grok/AGENTS.md", note: "not documented by Grok", verified: false },
    ),
    // The binary's embedded documentation: "Grok also scans `.agents/skills/`
    // (and `commands/`) at each tier (alongside `.grok/`)".
    skills: scopes(NATIVE, NATIVE),
    source: "https://docs.x.ai/docs/grok-cli/skills",
  },
  {
    id: "qoder",
    label: "Qoder CLI",
    bins: ["qodercli", "qoder"],
    configRoot: ".qoder",
    npmPackage: "@qoder-ai/qodercli",
    instructions: scopes(
      { native: true, note: "configurable via context.fileName" },
      { native: false, alias: ".qoder/AGENTS.md", note: "not documented by Qoder", verified: false },
    ),
    // Confirmed in the shipped bundle: .agents/skills is present, .qoder/skills
    // is not. Its own config directory holds settings and repowiki, not skills.
    skills: scopes(NATIVE, NATIVE),
    source: "https://docs.qoder.com/cli/Skills",
  },
  {
    id: "antigravity",
    label: "Antigravity CLI",
    bins: ["agy", "antigravity"],
    configRoot: ".gemini/config",
    // Workspace rules are AGENTS.md (with GEMINI.md and CONTEXT.md kept for the
    // Gemini lineage); global constraints live in ~/.gemini/GEMINI.md.
    instructions: scopes(
      { native: true, note: "Gemini-lineage discovery: AGENTS.md, CONTEXT.md, GEMINI.md" },
      { native: false, alias: ".gemini/GEMINI.md" },
    ),
    // ".agents/skills is the default; .agent/skills is kept for backward
    // compatibility" — so the canonical path needs no link, and the old path
    // would be writing to the deprecated one.
    skills: scopes(
      NATIVE,
      { native: false, alias: ".gemini/config/skills" },
    ),
    source: "https://www.antigravity.google/docs/skills/",
  },
  {
    id: "hermes",
    label: "Hermes",
    bins: ["hermes"],
    configRoot: ".hermes",
    // Context discovery walks to the git root and reads AGENTS.md, plus
    // HERMES.md, .hermes.md, AGENTS.override.md and CLAUDE.md. No global
    // instructions file is documented.
    instructions: scopes(
      { native: true, note: "walks to the git root: AGENTS.md, HERMES.md, AGENTS.override.md, CLAUDE.md" },
      { native: false, note: "no global instructions file documented" },
    ),
    // agent/skill_utils.py: PROJECT_SKILLS_SUBDIRS = (".hermes/skills",
    // ".agents/skills"), so the canonical path is read in a project. It is gated
    // though: project skills "load only when the root is in
    // skills.trusted_project_dirs", because auto-sourcing skills from any clone
    // is a prompt-injection vector. At home level only ~/.hermes/skills and the
    // configured skills.external_dirs are read, so that scope needs the link,
    // and note that Hermes installs and deletes skills there itself.
    skills: scopes(
      { native: true, note: "read when the project root is in skills.trusted_project_dirs" },
      { native: false, alias: ".hermes/skills", note: "Hermes installs and deletes skills in this directory" },
    ),
    source: "https://hermes-agent.nousresearch.com/docs/user-guide/features/skills",
  },
];

export const HARNESS_IDS = HARNESSES.map((h) => h.id);

export function findHarness(id: string): Harness | undefined {
  const needle = id.trim().toLowerCase();
  return HARNESSES.find((h) => h.id === needle || h.label.toLowerCase() === needle);
}

/** Resolve a comma/space separated harness list; unknown ids are returned to the caller. */
export function resolveHarnessList(input: string): { found: Harness[]; unknown: string[] } {
  const found: Harness[] = [];
  const unknown: string[] = [];
  for (const raw of input.split(/[,\s]+/).filter(Boolean)) {
    const harness = findHarness(raw);
    if (harness) found.push(harness);
    else unknown.push(raw);
  }
  return { found, unknown };
}
