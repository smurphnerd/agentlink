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
}

export interface Harness {
  id: string;
  label: string;
  /** Executables checked on PATH for detection. */
  bins: string[];
  /** Config directory relative to $HOME (from `herdr integration status`). */
  configRoot: string;
  instructions: Record<Scope, Endpoint>;
  skills: Record<Scope, Endpoint>;
  source: string;
  verified: boolean;
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
    verified: true,
  },
  {
    id: "codex",
    label: "OpenAI Codex CLI",
    bins: ["codex"],
    configRoot: ".codex",
    // Codex reads AGENTS.md in the repo and ~/.codex/AGENTS.md globally.
    instructions: scopes(
      { native: true },
      { native: false, alias: ".codex/AGENTS.md" },
    ),
    // Codex's user-level skills directory is $HOME/.agents/skills: native both ways.
    skills: scopes(NATIVE, NATIVE),
    source: CODEX_SKILLS_DOC,
    verified: true,
  },
  {
    id: "pi",
    label: "Pi",
    bins: ["pi"],
    configRoot: ".pi",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".pi/agent/AGENTS.md" },
    ),
    // Pi reads ~/.agents/skills and .agents/skills directly.
    skills: scopes(NATIVE, NATIVE),
    source: PI_SKILLS_DOC,
    verified: true,
  },
  {
    id: "omp",
    label: "Oh My Pi (omp)",
    bins: ["omp"],
    configRoot: ".omp",
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
    verified: true,
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    bins: ["copilot"],
    configRoot: ".copilot",
    // Copilot CLI reads AGENTS.md everywhere, but its *user* instructions live
    // in a differently named file.
    instructions: scopes(
      { native: true },
      { native: false, alias: ".copilot/copilot-instructions.md" },
    ),
    skills: scopes(NATIVE, NATIVE),
    source: `${COPILOT_SKILLS_DOC} · ${COPILOT_INSTRUCTIONS_DOC}`,
    verified: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    bins: ["cursor-agent", "cursor"],
    configRoot: ".cursor",
    instructions: scopes(
      { native: true, note: "Cursor reads AGENTS.md" },
      { native: false, alias: ".cursor/AGENTS.md", note: "not documented by Cursor" },
    ),
    skills: scopes(
      { native: false, alias: ".cursor/skills" },
      { native: false, alias: ".cursor/skills" },
    ),
    source: "https://cursor.com/docs/agent/context",
    verified: false,
  },
  {
    id: "opencode",
    label: "opencode",
    bins: ["opencode"],
    configRoot: ".config/opencode",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".config/opencode/AGENTS.md" },
    ),
    skills: scopes(
      { native: false, alias: ".opencode/skills" },
      { native: false, alias: ".config/opencode/skills" },
    ),
    source: "https://opencode.ai/docs/rules/",
    verified: false,
  },
  {
    id: "qwen",
    label: "Qwen Code",
    bins: ["qwen"],
    configRoot: ".qwen",
    instructions: scopes(
      { native: true, note: "QWEN.md is the legacy name" },
      { native: false, alias: ".qwen/AGENTS.md", note: "not documented by Qwen" },
    ),
    skills: scopes(
      { native: false, alias: ".qwen/skills" },
      { native: false, alias: ".qwen/skills" },
    ),
    source: "https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/",
    verified: true,
  },
  {
    id: "kimi",
    label: "Kimi Code CLI",
    bins: ["kimi"],
    configRoot: ".kimi-code",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".kimi-code/AGENTS.md", note: "not documented by Kimi" },
    ),
    skills: scopes(
      { native: false, alias: ".kimi-code/skills" },
      NATIVE, // Kimi scans ~/.agents/skills as its "generic group"
    ),
    source: "https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html",
    verified: true,
  },
  {
    id: "kilo",
    label: "Kilo Code",
    bins: ["kilo"],
    configRoot: ".config/kilo",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".config/kilo/AGENTS.md", note: "not documented by Kilo" },
    ),
    // Kilo Code reads Claude Code's skills directory for compatibility.
    skills: scopes(
      { native: false, alias: ".claude/skills", note: "shares Claude Code's directory" },
      { native: false, alias: ".config/kilo/skills", note: "unconfirmed" },
    ),
    source: "https://github.com/intellectronica/ruler#skills-support-experimental",
    verified: false,
  },
  {
    id: "droid",
    label: "Factory Droid",
    bins: ["droid"],
    configRoot: ".factory",
    instructions: scopes(
      { native: true, note: "AGENTS.md may also live in the home directory" },
      { native: false, alias: ".factory/AGENTS.md" },
    ),
    skills: scopes(
      { native: false, alias: ".factory/skills" },
      { native: false, alias: ".factory/skills" },
    ),
    source: "https://docs.factory.ai/harness/skills",
    verified: true,
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
    verified: true,
  },
  {
    id: "mastracode",
    label: "Mastra Code",
    bins: ["mastracode"],
    configRoot: ".mastracode",
    instructions: scopes(
      { native: true },
      { native: false, alias: ".mastracode/AGENTS.md", note: "not documented by Mastra" },
    ),
    // Mastra Code lists .agents/skills as a project source and Agent Skills
    // spec compatibility, so both scopes are native.
    skills: scopes(NATIVE, NATIVE),
    source: "https://code.mastra.ai/configuration",
    verified: true,
  },
  {
    id: "grok",
    label: "Grok CLI",
    bins: ["grok"],
    configRoot: ".grok",
    instructions: scopes(
      { native: true, note: "reads AGENTS.md, CLAUDE.md, AGENT.md" },
      { native: false, alias: ".grok/AGENTS.md", note: "not documented by Grok" },
    ),
    skills: scopes(
      { native: false, alias: ".grok/skills" },
      { native: false, alias: ".grok/skills" },
    ),
    source: "https://docs.x.ai/docs/grok-cli/skills",
    verified: true,
  },
  {
    id: "qoder",
    label: "Qoder CLI",
    bins: ["qodercli", "qoder"],
    configRoot: ".qoder",
    instructions: scopes(
      { native: true, note: "configurable via context.fileName" },
      { native: false, alias: ".qoder/AGENTS.md", note: "not documented by Qoder" },
    ),
    skills: scopes(
      { native: false, alias: ".qoder/skills" },
      { native: false, alias: ".qoder/skills" },
    ),
    source: "https://docs.qoder.com/cli/Skills",
    verified: true,
  },
  {
    id: "antigravity",
    label: "Antigravity CLI",
    bins: ["agy", "antigravity"],
    configRoot: ".gemini/config",
    instructions: scopes(
      { native: true, note: "Gemini-lineage discovery: AGENTS.md, CONTEXT.md, GEMINI.md" },
      { native: false, alias: ".gemini/config/AGENTS.md", note: "unconfirmed" },
    ),
    skills: scopes(
      { native: false, alias: ".agent/skills", note: "unconfirmed" },
      { native: false, alias: ".gemini/config/skills", note: "unconfirmed" },
    ),
    source: "https://github.com/intellectronica/ruler#skills-support-experimental",
    verified: false,
  },
  {
    id: "hermes",
    label: "Hermes",
    bins: ["hermes"],
    configRoot: ".hermes",
    instructions: scopes(
      { native: true, note: "unconfirmed" },
      { native: false, alias: ".hermes/AGENTS.md", note: "unconfirmed" },
    ),
    skills: scopes(
      { native: false, alias: ".hermes/skills", note: "unconfirmed" },
      { native: false, alias: ".hermes/skills", note: "unconfirmed" },
    ),
    source: "https://herdr.dev/llms.txt",
    verified: false,
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
