import { parseConfig, type Config } from '@open-zone/shared';

/** Persistence port for configuration. The server provides a JSON-file implementation. */
export interface ConfigStore {
  load(): Promise<Config>;
  save(config: Config): Promise<void>;
}

export class MemoryConfigStore implements ConfigStore {
  private config: Config;
  saves = 0;

  constructor(initial: unknown = {}) {
    this.config = parseConfig(initial);
  }

  async load(): Promise<Config> {
    return structuredClone(this.config);
  }

  async save(config: Config): Promise<void> {
    this.config = structuredClone(parseConfig(config));
    this.saves++;
  }

  /** Test helper: the last saved config. */
  get current(): Config {
    return structuredClone(this.config);
  }
}
