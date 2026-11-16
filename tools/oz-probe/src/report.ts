import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeBytes, type RawResult, type Transcript } from './recorder.ts';
import { detail, heading, line, type Status } from './ui.ts';

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  summary: string;
  data?: Record<string, unknown>;
  raw?: RawResult[];
}

/** One of the open hardware questions the probe exists to answer. */
export interface Finding {
  question: string;
  answer: string;
  status: Status;
}

export class Report {
  readonly startedAt = new Date();
  readonly environment: Record<string, unknown> = {};
  readonly checks: CheckResult[] = [];
  readonly findings: Finding[] = [];
  private currentSection = '';

  section(title: string): void {
    this.currentSection = title;
    heading(title);
  }

  add(check: Omit<CheckResult, 'title'> & { title?: string }): CheckResult {
    const full: CheckResult = { title: check.title ?? this.currentSection, ...check };
    this.checks.push(full);
    line(full.status, full.summary);
    for (const r of full.raw ?? []) {
      detail(
        `${escapeBytes(r.command)} → ${r.response ? escapeBytes(r.response) : '(no response)'}` +
          (r.firstByteMs !== null ? `  [first byte ${r.firstByteMs} ms]` : ''),
      );
    }
    return full;
  }

  find(question: string, answer: string, status: Status = 'info'): void {
    this.findings.push({ question, answer, status });
  }

  get worst(): Status {
    const order: Status[] = ['fail', 'warn', 'pass', 'info', 'skip'];
    return order.find((s) => this.checks.some((c) => c.status === s)) ?? 'info';
  }

  async write(dir: string, transcript: Transcript): Promise<{ json: string; md: string }> {
    const stamp = this.startedAt
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
    const base = join(dir, `oz-probe-report-${stamp}`);
    const json = `${base}.json`;
    const md = `${base}.md`;
    await writeFile(
      json,
      JSON.stringify(
        {
          startedAt: this.startedAt.toISOString(),
          environment: this.environment,
          findings: this.findings,
          checks: this.checks,
          transcript: { entries: transcript.entries, dropped: transcript.dropped },
        },
        null,
        2,
      ),
    );
    await writeFile(md, this.markdown(transcript));
    return { json, md };
  }

  private markdown(transcript: Transcript): string {
    const out: string[] = [];
    out.push(`# open-zone hardware probe report`, '');
    out.push(`Run at ${this.startedAt.toISOString()}`, '');
    out.push('## Environment', '');
    for (const [k, v] of Object.entries(this.environment)) {
      out.push(`- **${k}:** ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    out.push('', '## Findings', '', '| | Question | Answer |', '|---|---|---|');
    for (const f of this.findings) {
      out.push(`| ${f.status} | ${f.question} | ${f.answer.replace(/\|/g, '\\|')} |`);
    }
    out.push('', '## Checks', '');
    for (const c of this.checks) {
      out.push(`### [${c.status}] ${c.title} — ${c.id}`, '', c.summary, '');
      if (c.data) out.push('```json', JSON.stringify(c.data, null, 2), '```', '');
      if (c.raw?.length) {
        out.push('```');
        for (const r of c.raw) {
          out.push(`TX ${escapeBytes(r.command)}`);
          out.push(`RX ${r.response ? escapeBytes(r.response) : '(nothing)'}`);
          out.push(
            `   first byte: ${r.firstByteMs ?? '-'} ms, last byte: ${r.lastByteMs ?? '-'} ms`,
          );
        }
        out.push('```', '');
      }
    }
    out.push('## Transcript (first 300 entries)', '', '```');
    for (const e of transcript.entries.slice(0, 300)) {
      out.push(`${String(e.t).padStart(9)} ${e.dir} ${escapeBytes(e.data)}`);
    }
    if (transcript.entries.length > 300) {
      out.push(`… ${transcript.entries.length - 300} more entries in the JSON report`);
    }
    out.push('```', '');
    return out.join('\n');
  }
}

export function stats(samples: number[]): {
  n: number;
  min: number;
  avg: number;
  p95: number;
  max: number;
} | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 10) / 10;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
  return {
    n: sorted.length,
    min: r(sorted[0]!),
    avg: r(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p95: r(p95),
    max: r(sorted[sorted.length - 1]!),
  };
}
