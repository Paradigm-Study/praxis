import {
  createCipheriv,
  createHash,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const TEXT_PREFIX = "enc:v";
const BYTE_MAGIC = Buffer.from("PXE1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface MasterKeyringFile {
  format: 1;
  activeVersion: number;
  keys: Record<string, string>;
  createdAt: string;
  rotatedAt?: string;
}

export function keyringPath(baseDir: string): string {
  return join(baseDir, "keys", "master-keys.json");
}

function atomicWrite(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort.
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
}

function validateKeyring(value: unknown): MasterKeyringFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid Praxis master keyring");
  }
  const data = value as Record<string, unknown>;
  if (
    data.format !== 1 ||
    !Number.isInteger(data.activeVersion) ||
    Number(data.activeVersion) < 1 ||
    typeof data.keys !== "object" ||
    data.keys === null ||
    typeof data.createdAt !== "string"
  ) {
    throw new Error("invalid Praxis master keyring");
  }
  const keys: Record<string, string> = {};
  for (const [version, encoded] of Object.entries(data.keys as Record<string, unknown>)) {
    if (typeof encoded !== "string" || Buffer.from(encoded, "base64").byteLength !== 32) {
      throw new Error(`invalid Praxis master key v${version}`);
    }
    keys[version] = encoded;
  }
  if (!keys[String(data.activeVersion)]) {
    throw new Error("active Praxis master key is missing");
  }
  return data as unknown as MasterKeyringFile;
}

export function loadOrCreateKeyring(baseDir: string): MasterKeyringFile {
  const path = keyringPath(baseDir);
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Doctor reports the remaining permission problem.
      }
    }
    return validateKeyring(JSON.parse(readFileSync(path, "utf8")));
  }
  const now = new Date().toISOString();
  const created: MasterKeyringFile = {
    format: 1,
    activeVersion: 1,
    keys: { "1": randomBytes(32).toString("base64") },
    createdAt: now,
  };
  atomicWrite(path, created);
  return created;
}

function readExternalKey(path: string): string {
  const encoded = readFileSync(path, "utf8").trim();
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    bytes = Buffer.from(encoded, "base64");
  }
  if (bytes.byteLength !== 32) {
    throw new Error(`Praxis data key ${path} must decode to exactly 32 bytes`);
  }
  const fileMode = statSync(path).mode & 0o777;
  if (fileMode !== 0o600) throw new Error(`Praxis data key ${path} must be mode 0600`);
  const directoryMode = statSync(dirname(path)).mode & 0o777;
  if (directoryMode !== 0o700) {
    throw new Error(`Praxis data key directory ${dirname(path)} must be mode 0700`);
  }
  return bytes.toString("base64");
}

/** Packaged builds inject safeStorage-unwrapped runtime keys through this seam. */
export function loadStorageKeyring(baseDir: string): MasterKeyringFile {
  const activePath = process.env.PRAXIS_DATA_KEY_FILE;
  if (!activePath) return loadOrCreateKeyring(baseDir);
  const activeVersion = Number(process.env.PRAXIS_DATA_KEY_VERSION ?? 1);
  if (!Number.isInteger(activeVersion) || activeVersion < 1) {
    throw new Error("PRAXIS_DATA_KEY_VERSION must be a positive integer");
  }
  const keys: Record<string, string> = {
    [String(activeVersion)]: readExternalKey(activePath),
  };
  for (const item of (process.env.PRAXIS_PREVIOUS_DATA_KEY_FILES ?? "").split(",")) {
    if (!item.trim()) continue;
    const separator = item.indexOf(":");
    if (separator < 1) throw new Error("invalid PRAXIS_PREVIOUS_DATA_KEY_FILES entry");
    const version = Number(item.slice(0, separator));
    const path = item.slice(separator + 1);
    if (!Number.isInteger(version) || version < 1 || !path) {
      throw new Error("invalid PRAXIS_PREVIOUS_DATA_KEY_FILES entry");
    }
    keys[String(version)] = readExternalKey(path);
  }
  return {
    format: 1,
    activeVersion,
    keys,
    createdAt: new Date().toISOString(),
  };
}

export function usesExternalDataKey(): boolean {
  return !!process.env.PRAXIS_DATA_KEY_FILE;
}

/** Add a new active key while retaining old versions for rollback/decryption. */
export function rotateMasterKey(baseDir: string): MasterKeyringFile {
  if (usesExternalDataKey()) {
    throw new Error("external Praxis data keys must be rotated by the desktop supervisor");
  }
  const current = loadOrCreateKeyring(baseDir);
  const nextVersion = Math.max(...Object.keys(current.keys).map(Number)) + 1;
  const next: MasterKeyringFile = {
    ...current,
    activeVersion: nextVersion,
    keys: { ...current.keys, [String(nextVersion)]: randomBytes(32).toString("base64") },
    rotatedAt: new Date().toISOString(),
  };
  atomicWrite(keyringPath(baseDir), next);
  return next;
}

function aad(version: number, context: string): Buffer {
  return Buffer.from(`praxis:v${version}:${context}`, "utf8");
}

/** AES-256-GCM envelope codec. Legacy plaintext remains readable during migration. */
export class StorageCipher {
  readonly activeVersion: number;
  readonly keyVersions: number[];
  readonly keyFingerprints: Record<string, string>;
  #keys: Map<number, Buffer>;

  constructor(keyring: MasterKeyringFile) {
    this.activeVersion = keyring.activeVersion;
    this.#keys = new Map(
      Object.entries(keyring.keys).map(([version, encoded]) => [Number(version), Buffer.from(encoded, "base64")]),
    );
    this.keyVersions = [...this.#keys.keys()].sort((a, b) => a - b);
    this.keyFingerprints = Object.fromEntries(
      [...this.#keys.entries()].map(([version, key]) => [
        String(version),
        createHash("sha256").update(key).digest("hex"),
      ]),
    );
  }

  static ephemeral(): StorageCipher {
    return new StorageCipher({
      format: 1,
      activeVersion: 1,
      keys: { "1": randomBytes(32).toString("base64") },
      createdAt: new Date().toISOString(),
    });
  }

  textVersion(value: unknown): number | undefined {
    if (typeof value !== "string") return undefined;
    const match = value.match(/^enc:v(\d+):/);
    return match ? Number(match[1]) : undefined;
  }

  encryptText(value: string, context: string): string {
    const key = this.#key(this.activeVersion);
    // A keyed deterministic nonce preserves existing equality lookups while
    // preventing nonce reuse across distinct plaintext/context pairs.
    const iv = createHmac("sha256", key)
      .update(context)
      .update("\0")
      .update(value)
      .digest()
      .subarray(0, IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(this.activeVersion, context));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    return `${TEXT_PREFIX}${this.activeVersion}:${packed}`;
  }

  decryptText(value: unknown, context: string): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string") return String(value);
    const version = this.textVersion(value);
    if (version === undefined) return value;
    const encoded = value.slice(value.indexOf(":", TEXT_PREFIX.length) + 1);
    const packed = Buffer.from(encoded, "base64");
    if (packed.byteLength < IV_BYTES + TAG_BYTES) throw new Error("corrupt encrypted text");
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.#key(version), iv);
    decipher.setAAD(aad(version, context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  bytesVersion(value: Uint8Array): number | undefined {
    const bytes = Buffer.from(value);
    if (bytes.byteLength < 8 || !bytes.subarray(0, 4).equals(BYTE_MAGIC)) return undefined;
    return bytes.readUInt32BE(4);
  }

  encryptBytes(value: Uint8Array, context: string): Buffer {
    const key = this.#key(this.activeVersion);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(this.activeVersion, context));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    const header = Buffer.alloc(8);
    BYTE_MAGIC.copy(header, 0);
    header.writeUInt32BE(this.activeVersion, 4);
    return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
  }

  decryptBytes(value: Uint8Array, context: string): Buffer {
    const bytes = Buffer.from(value);
    const version = this.bytesVersion(bytes);
    if (version === undefined) return bytes;
    if (bytes.byteLength < 8 + IV_BYTES + TAG_BYTES) throw new Error("corrupt encrypted blob");
    const iv = bytes.subarray(8, 8 + IV_BYTES);
    const tag = bytes.subarray(8 + IV_BYTES, 8 + IV_BYTES + TAG_BYTES);
    const ciphertext = bytes.subarray(8 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.#key(version), iv);
    decipher.setAAD(aad(version, context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  #key(version: number): Buffer {
    const key = this.#keys.get(version);
    if (!key) throw new Error(`missing Praxis master key v${version}`);
    return key;
  }
}
