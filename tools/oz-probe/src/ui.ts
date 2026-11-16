import { createInterface, type Interface } from 'node:readline/promises';

export type Status = 'pass' | 'warn' | 'fail' | 'skip' | 'info';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const ICON: Record<Status, string> = {
  pass: paint('32', '✔'),
  warn: paint('33', '⚠'),
  fail: paint('31', '✖'),
  skip: paint('90', '–'),
  info: paint('36', 'ℹ'),
};

export const bold = (s: string) => paint('1', s);
export const dim = (s: string) => paint('90', s);

/**
 * Console prompts. In non-interactive mode (--yes, or stdin is not a TTY)
 * every question takes its default and anything needing a human is skipped.
 * Lines typed ahead of a prompt are kept for the next question, and if input
 * closes (Ctrl+D, dropped SSH session) remaining questions take their defaults.
 */
export class Prompter {
  readonly interactive: boolean;
  private rl: Interface | undefined;
  private readonly buffered: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private closed = false;

  constructor(interactive: boolean) {
    this.interactive = interactive;
    if (!interactive) return;
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    this.rl.on('line', (l) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w(l);
      } else this.buffered.push(l);
    });
    this.rl.on('close', () => {
      this.closed = true;
      this.waiting?.(undefined);
      this.waiting = undefined;
    });
  }

  private nextLine(): Promise<string | undefined> {
    if (this.buffered.length) return Promise.resolve(this.buffered.shift());
    if (this.closed || !this.rl) return Promise.resolve(undefined);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  async ask(question: string, fallback: string): Promise<string> {
    if (!this.rl) return fallback;
    process.stdout.write(`${question} ${dim(`[${fallback}]`)} `);
    const answer = (await this.nextLine())?.trim();
    if (answer === undefined) process.stdout.write(`${fallback}\n`);
    return answer ? answer : fallback;
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const answer = await this.ask(question, fallback ? 'Y/n' : 'y/N');
    if (answer === 'Y/n') return true;
    if (answer === 'y/N') return false;
    return /^y(es)?$/i.test(answer);
  }

  async pause(message: string): Promise<void> {
    if (!this.rl) return;
    process.stdout.write(`${message} ${dim('[Enter]')} `);
    await this.nextLine();
  }

  close(): void {
    this.rl?.close();
  }
}

export function heading(title: string): void {
  console.log(`\n${bold(title)}`);
}

export function line(status: Status, message: string): void {
  console.log(`  ${ICON[status]} ${message}`);
}

export function detail(message: string): void {
  for (const l of message.split('\n')) console.log(`      ${dim(l)}`);
}
