import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const MAX_BYTES = 10 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class SafeLogger {
  constructor(root) {
    this.root = root;
    this.queue = Promise.resolve();
  }

  write(event) {
    const allowed = {
      timestamp: new Date().toISOString(),
      requestId: event.requestId,
      route: event.route,
      mode: event.mode,
      model: event.model,
      harnessStatus: event.harnessStatus,
      durationMs: event.durationMs,
      status: event.status,
      inputHash: event.inputHash,
      outputHash: event.outputHash,
      tokenUsage: event.tokenUsage,
      errorClass: event.errorClass
    };
    for (const key of Object.keys(allowed)) if (allowed[key] === undefined) delete allowed[key];
    this.queue = this.queue.then(() => this.#append(allowed)).catch(() => {});
    return this.queue;
  }

  // Appends are queued asynchronously. Callers that are about to remove the log
  // directory (tests, shutdown) await this so no write lands after the tree walk.
  drain() { return this.queue.catch(() => {}); }

  async #append(event) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const day = event.timestamp.slice(0, 10);
    const path = join(this.root, `${day}.jsonl`);
    try {
      const info = await stat(path);
      if (info.size >= MAX_BYTES) await rename(path, join(this.root, `${day}-${Date.now()}.jsonl`));
    } catch {}
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.#prune();
  }

  async #prune() {
    const now = Date.now();
    for (const name of await readdir(this.root)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(this.root, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > RETENTION_MS) await unlink(path);
      } catch {}
    }
  }
}
