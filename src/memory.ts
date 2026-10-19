import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Redactor } from './safety.js';

export class Memory {
  private recent: string[] = [];
  constructor(private readonly directory: string, private readonly redactor: Redactor, readonly maxBytes = 24000) {
    if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 24000) throw new Error('Memory budget must be 256..24000 UTF-8 bytes');
  }
  async append(value: unknown): Promise<string> {
    const data = this.redactor.redact(JSON.stringify(value));
    const id = createHash('sha256').update(data).digest('hex');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, id + '.json'), data, { mode: 0o600 });
    this.recent.push(Buffer.byteLength(data) > this.maxBytes / 2 ? JSON.stringify({ cold: id, bytes: Buffer.byteLength(data) }) : data);
    while (Buffer.byteLength(this.context()) > this.maxBytes) this.recent.shift();
    return id;
  }
  context(): string { return this.recent.join('\n'); }
  async read(id: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid cold storage id');
    return readFile(join(this.directory, id + '.json'), 'utf8');
  }
}
