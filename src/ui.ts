import { emitKeypressEvents } from "node:readline";

/**
 * A dependency-free checkbox list.
 *
 * Uses raw mode plus ANSI line control rather than a TUI library: the whole
 * point of agentlink is that it works with nothing installed.
 * Falls back to the caller's defaults when stdin is not a TTY.
 */

export interface Choice {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  group?: string;
}

export interface SelectOptions {
  title: string;
  help?: string;
}

const ESC = String.fromCharCode(27);
const CURSOR_UP = (n: number) => (n > 0 ? `${ESC}[${n}A` : "");
const CLEAR_LINE = `${ESC}[2K`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const CYAN = `${ESC}[36m`;

export async function selectMany(choices: Choice[], options: SelectOptions): Promise<string[] | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return choices.filter((c) => c.checked).map((c) => c.id);
  }

  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    let cursor = 0;
    let drawnLines = 0;

    const lines = () => {
      const out: string[] = [];
      out.push(`${BOLD}${options.title}${RESET}`);
      if (options.help) out.push(`${DIM}${options.help}${RESET}`);
      choices.forEach((choice, index) => {
        const active = index === cursor;
        const box = choice.checked ? "[x]" : "[ ]";
        const pointer = active ? `${CYAN}>${RESET}` : " ";
        const hint = choice.hint ? ` ${DIM}${choice.hint}${RESET}` : "";
        const label = active ? `${BOLD}${choice.label}${RESET}` : choice.label;
        out.push(`${pointer} ${box} ${label}${hint}`);
      });
      return out;
    };

    const draw = () => {
      const rendered = lines();
      let output = CURSOR_UP(drawnLines);
      for (const line of rendered) output += `${CLEAR_LINE}${line}\n`;
      if (rendered.length < drawnLines) {
        for (let i = rendered.length; i < drawnLines; i += 1) output += `${CLEAR_LINE}\n`;
        output += CURSOR_UP(drawnLines - rendered.length);
      }
      drawnLines = rendered.length;
      process.stdout.write(output);
    };

    const cleanup = (result: string[] | null) => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      resolve(result);
    };

    const onKey = (_str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean } | undefined) => {
      if (!key) return;
      const name = key.name ?? "";
      if (key.ctrl && name === "c") {
        process.stdout.write("\n");
        cleanup(null);
        return;
      }
      if (name === "escape") {
        cleanup(null);
        return;
      }
      if (name === "return" || name === "enter") {
        process.stdout.write("\n");
        cleanup(choices.filter((c) => c.checked).map((c) => c.id));
        return;
      }
      if (name === "up" || name === "k") {
        cursor = (cursor + choices.length - 1) % choices.length;
        draw();
        return;
      }
      if (name === "down" || name === "j") {
        cursor = (cursor + 1) % choices.length;
        draw();
        return;
      }
      if (name === "space") {
        const choice = choices[cursor];
        if (choice) choice.checked = !choice.checked;
        draw();
        return;
      }
      if (name === "a") {
        const allOn = choices.every((c) => c.checked);
        choices.forEach((c) => {
          c.checked = !allOn;
        });
        draw();
        return;
      }
      if (name === "i") {
        choices.forEach((c) => {
          c.checked = c.group === "detected" ? true : false;
        });
        draw();
        return;
      }
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
    draw();
  });
}
