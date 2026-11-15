import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let tempSequence = 0;

function checkpointError(code, message, cause) {
  const error = new TypeError(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function reviveBinary(_key, value) {
  return value && typeof value === "object" && typeof value.__uint8array__ === "string"
    ? new Uint8Array(Buffer.from(value.__uint8array__, "base64"))
    : value;
}

function replaceBinary(_key, value) {
  return value instanceof Uint8Array ? { __uint8array__: Buffer.from(value).toString("base64") } : value;
}

/** Versioned single-file checkpoint storage with same-directory atomic rename. */
export class JsonCheckpointFile {
  #filePath;
  #version;
  #versionKey;

  constructor(filePath, { version, versionKey = "checkpointVersion" } = {}) {
    if (typeof filePath !== "string" || !filePath) throw new TypeError("filePath is required");
    if (typeof version !== "string" || !version) throw new TypeError("checkpoint version is required");
    if (typeof versionKey !== "string" || !versionKey) throw new TypeError("versionKey is required");
    this.#filePath = filePath;
    this.#version = version;
    this.#versionKey = versionKey;
  }

  load() {
    if (!existsSync(this.#filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.#filePath, "utf8"), reviveBinary);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed[this.#versionKey] !== this.#version) {
        throw checkpointError("CHECKPOINT_VERSION_MISMATCH", "checkpoint version mismatch");
      }
      return parsed;
    } catch (error) {
      if (error?.code === "CHECKPOINT_VERSION_MISMATCH") throw error;
      throw checkpointError("CHECKPOINT_UNREADABLE", `checkpoint unreadable: ${String(error?.message || error)}`, error);
    }
  }

  save(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("checkpoint payload must be an object");
    const body = { ...payload };
    delete body[this.#versionKey];
    const serialized = JSON.stringify({ [this.#versionKey]: this.#version, ...body }, replaceBinary);
    mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.tmp-${process.pid}-${++tempSequence}`;
    try {
      writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.#filePath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
