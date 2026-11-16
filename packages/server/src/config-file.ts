import { open, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConfigStore } from '@open-zone/core';
import { parseConfig, type Config } from '@open-zone/shared';

/**
 * Config persisted as one JSON file. Writes are atomic (temp file, fsync,
 * rename) so a power cut mid-write can never leave a truncated config, and
 * nothing is written unless something actually changed (SD-card friendly).
 */
export class JsonFileConfigStore implements ConfigStore {
  readonly path: string;
  private lastWritten: string | undefined;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<Config> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({});
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`${this.path} is not valid JSON: ${(err as Error).message}`, { cause: err });
    }
    const config = parseConfig(raw);
    this.lastWritten = serialize(config);
    return config;
  }

  async save(config: Config): Promise<void> {
    const text = serialize(parseConfig(config));
    if (text === this.lastWritten) return;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
    this.lastWritten = text;
  }
}

function serialize(config: Config): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
