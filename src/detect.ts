import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HARNESSES, type Harness } from "./harnesses.js";

export interface Detection {
  harness: Harness;
  installed: boolean;
  reasons: string[];
}

/** Look the binary up in PATH without shelling out. */
export function isOnPath(bins: string[]): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const bin of bins) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, bin + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/**
 * A harness counts as present when its binary is on PATH or its config
 * directory exists. Config roots come from `herdr integration status`, which
 * knows where each harness actually keeps its state.
 */
export function detect(harness: Harness, home = homedir()): Detection {
  const reasons: string[] = [];
  const bin = isOnPath(harness.bins);
  if (bin) reasons.push(`binary ${path.basename(bin)}`);
  const configPath = path.join(home, harness.configRoot);
  if (existsSync(configPath)) reasons.push(`config ${harness.configRoot.startsWith(".") ? "~/" : ""}${harness.configRoot}`);
  return { harness, installed: reasons.length > 0, reasons };
}

export function detectAll(home = homedir()): Detection[] {
  return HARNESSES.map((harness) => detect(harness, home));
}
