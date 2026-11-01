import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

/**
 * TLS material for web access (ADR 0342). The owner can bring a certificate;
 * otherwise the host creates a self-signed ECDSA P-256 certificate whose
 * names cover localhost and this computer's LAN addresses. Browsers warn
 * about it once; the settings page shows its fingerprint for comparison.
 */
export type TlsMaterial = {
  cert: string;
  key: string;
  fingerprint256: string;
  /** ISO timestamp. */
  validTo: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const VALIDITY_DAYS = 397;
const RENEW_BEFORE_MS = 30 * DAY_MS;
const CERT_FILE = "self-signed-cert.pem";
const KEY_FILE = "self-signed-key.pem";

export function lanIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

export function inspectTlsMaterial(cert: string, key: string): TlsMaterial {
  const certificate = new X509Certificate(cert);
  if (!certificate.checkPrivateKey(createPrivateKey(key))) {
    throw new Error("The TLS key does not match the certificate.");
  }
  return {
    cert,
    key,
    fingerprint256: certificate.fingerprint256,
    validTo: validToIso(certificate),
  };
}

/** Reuses the stored self-signed certificate until 30 days before it expires. */
export async function loadSelfSignedMaterial(
  directory: string,
  now: Date = new Date(),
): Promise<TlsMaterial> {
  const certPath = join(directory, CERT_FILE);
  const keyPath = join(directory, KEY_FILE);
  const existing = await readExisting(certPath, keyPath);
  if (existing && Date.parse(existing.validTo) - now.getTime() > RENEW_BEFORE_MS) {
    return existing;
  }
  const generated = generateSelfSignedCertificate({ now });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(keyPath, generated.key, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  await writeFile(certPath, generated.cert, { mode: 0o644 });
  return inspectTlsMaterial(generated.cert, generated.key);
}

export async function loadCustomMaterial(certPath: string, keyPath: string): Promise<TlsMaterial> {
  const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
  return inspectTlsMaterial(cert, key);
}

async function readExisting(certPath: string, keyPath: string): Promise<TlsMaterial | null> {
  try {
    const [cert, key] = await Promise.all([
      readFile(certPath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    return inspectTlsMaterial(cert, key);
  } catch {
    // Missing, unreadable, or mismatched material is replaced by a new certificate.
    return null;
  }
}

export function generateSelfSignedCertificate(
  options: { now?: Date; dnsNames?: string[]; ipAddresses?: string[] } = {},
): { cert: string; key: string } {
  const now = options.now ?? new Date();
  const dnsNames = [...new Set(options.dnsNames ?? defaultDnsNames())];
  const ipAddresses = [...new Set(options.ipAddresses ?? ["127.0.0.1", "::1", ...lanIPv4Addresses()])];
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40;
  const signatureAlgorithm = sequence(oid("1.2.840.10045.4.3.2"));
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8("PI Desktop Web Access"))));
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + VALIDITY_DAYS * DAY_MS);
  const extensions = sequence(
    extension("2.5.29.19", true, sequence()),
    extension("2.5.29.15", true, bitString(Buffer.from([0x80]), 7)),
    extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
    extension("2.5.29.17", false, subjectAltName(dnsNames, ipAddresses)),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    signatureAlgorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = sequence(tbs, signatureAlgorithm, bitString(signature));
  return {
    cert: toPem("CERTIFICATE", der),
    key: String(privateKey.export({ type: "pkcs8", format: "pem" })),
  };
}

function defaultDnsNames(): string[] {
  const names = ["localhost"];
  const host = hostname().trim().toLowerCase();
  if (/^[a-z0-9.-]+$/.test(host)) {
    names.push(host);
    if (!host.includes(".")) names.push(`${host}.local`);
  }
  return names;
}

function validToIso(certificate: X509Certificate): string {
  const parsed =
    "validToDate" in certificate && certificate.validToDate instanceof Date
      ? certificate.validToDate
      : new Date(certificate.validTo);
  return Number.isNaN(parsed.getTime()) ? certificate.validTo : parsed.toISOString();
}

// Minimal DER encoding: just enough for one X.509 v3 certificate.

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, ...parts);
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, ...parts);
}

function explicit(index: number, value: Buffer): Buffer {
  return tlv(0xa0 | index, value);
}

function utf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, "utf8"));
}

function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.from([unusedBits]), value);
}

function integer(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const first = trimmed[0] ?? 0;
  return tlv(0x02, (first & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes: number[] = [first * 40 + second];
  for (const component of rest) {
    const groups: number[] = [];
    let remaining = component;
    do {
      groups.unshift(remaining % 128);
      remaining = Math.floor(remaining / 128);
    } while (remaining > 0);
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] ?? 0;
      bytes.push(index < groups.length - 1 ? group | 0x80 : group);
    }
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const iso = date.toISOString();
  const compact = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(compact.slice(2), "ascii"))
    : tlv(0x18, Buffer.from(compact, "ascii"));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(oid(id), tlv(0x01, Buffer.from([0xff])), tlv(0x04, value))
    : sequence(oid(id), tlv(0x04, value));
}

function subjectAltName(dnsNames: string[], ipAddresses: string[]): Buffer {
  const names: Buffer[] = [];
  for (const name of dnsNames) names.push(tlv(0x82, Buffer.from(name, "ascii")));
  for (const address of ipAddresses) {
    const bytes = ipBytes(address);
    if (bytes) names.push(tlv(0x87, bytes));
  }
  return sequence(...names);
}

function ipBytes(address: string): Buffer | null {
  if (address === "::1") {
    const bytes = Buffer.alloc(16);
    bytes[15] = 1;
    return bytes;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return Buffer.from(parts);
}

function toPem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
