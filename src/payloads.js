import fs from 'node:fs/promises';
import path from 'node:path';

export class PayloadStore {
  constructor(cwd) { this.directory = path.join(cwd, '.stackeye'); this.file = path.join(this.directory, 'payloads.json'); this.legacyFile = path.join(cwd, '.samo11y', 'payloads.json'); }
  async all() {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; try { return JSON.parse(await fs.readFile(this.legacyFile, 'utf8')); } catch (legacyError) { if (legacyError.code === 'ENOENT') return {}; throw legacyError; } }
  }
  async save({ functionName, name, payload }) {
    if (!functionName || !name?.trim()) throw new Error('Function and payload name are required');
    JSON.parse(payload);
    const data = await this.all();
    data[functionName] ||= {}; data[functionName][name.trim()] = payload;
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.file);
    return data;
  }
  async remove({ functionName, name }) {
    const data = await this.all();
    if (data[functionName]) delete data[functionName][name];
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    return data;
  }
}
