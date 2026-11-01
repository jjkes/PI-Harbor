import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Owner password hashing for web access (ADR 0342).
 *
 * The stored form carries its own cost parameters so they can be raised later
 * without invalidating existing hashes:
 * `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`.
 */
const SCHEME = "scrypt";
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** Bounds a stored hash may ask for, so a damaged file cannot request unbounded memory. */
const MAX_COST = 1 << 17;
const MAX_BLOCK_SIZE = 16;
const MAX_PARALLELISM = 4;

type ParsedHash = {
  cost: number;
  blockSize: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM, KEY_BYTES);
  return [
    SCHEME,
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export function isPasswordHash(value: string): boolean {
  return parseHash(value) !== null;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const actual = await derive(
    password,
    parsed.salt,
    parsed.cost,
    parsed.blockSize,
    parsed.parallelism,
    parsed.hash.length,
  );
  return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

let decoyHash: Promise<string> | null = null;

/**
 * Checks one sign-in attempt. A wrong username still pays for one scrypt run
 * against a decoy hash, so the response time does not reveal which part of
 * the credentials was wrong.
 */
export async function verifyCredentials(
  input: { username: string; password: string },
  stored: { username: string; passwordHash: string },
): Promise<boolean> {
  const usernameMatches =
    stored.username.length > 0 && sameText(input.username.trim(), stored.username);
  const hash = usernameMatches && stored.passwordHash ? stored.passwordHash : await decoy();
  const passwordMatches = await verifyPassword(input.password, hash);
  return usernameMatches && passwordMatches;
}

function decoy(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return decoyHash;
}

function sameText(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== SCHEME) return null;
  const [, costText = "", blockText = "", parallelText = "", saltText = "", hashText = ""] = parts;
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelism = Number(parallelText);
  if (!Number.isInteger(cost) || cost < 2 || cost > MAX_COST || (cost & (cost - 1)) !== 0) {
    return null;
  }
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > MAX_BLOCK_SIZE) return null;
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > MAX_PARALLELISM) {
    return null;
  }
  const salt = Buffer.from(saltText, "base64");
  const hash = Buffer.from(hashText, "base64");
  if (salt.length < 8 || hash.length < 16 || hash.length > 64) return null;
  return { cost, blockSize, parallelism, salt, hash };
}

function derive(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelism: number,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFC"),
      salt,
      length,
      {
        N: cost,
        r: blockSize,
        p: parallelism,
        maxmem: 256 * cost * blockSize + 32 * 1024 * 1024,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}
