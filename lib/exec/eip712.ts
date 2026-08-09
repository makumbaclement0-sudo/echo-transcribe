import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

// Minimal EIP-712 typed-data signing — enough for Hyperliquid's Agent type and
// verifiable against the EIP-712 spec's own test vector (see eip712.test).

export type TypeField = { name: string; type: string };
export type Types = Record<string, TypeField[]>;
export type Value = Record<string, unknown>;

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

const enc = new TextEncoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function toWord(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Types that `primaryType` depends on, sorted per spec. */
function deps(primaryType: string, types: Types, found = new Set<string>()): string[] {
  if (found.has(primaryType) || !types[primaryType]) return [];
  found.add(primaryType);
  let result = [primaryType];
  for (const field of types[primaryType]) {
    const base = field.type.replace(/\[\d*\]$/, "");
    if (types[base]) result = result.concat(deps(base, types, found));
  }
  return result;
}

export function encodeType(primaryType: string, types: Types): string {
  const [head, ...rest] = deps(primaryType, types);
  const ordered = [head, ...rest.sort()];
  return ordered
    .map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(",")})`)
    .join("");
}

export function typeHash(primaryType: string, types: Types): Uint8Array {
  return keccak256(enc.encode(encodeType(primaryType, types)));
}

function encodeField(type: string, value: unknown, types: Types): Uint8Array {
  // A struct-typed field encodes to its struct hash directly (already a hash).
  if (types[type]) return hashStruct(type, value as Value, types);
  if (type === "string") return keccak256(enc.encode(String(value)));
  if (type === "bytes") return keccak256(hexToBytes(String(value)));
  if (type === "address") return toWord(BigInt(String(value)));
  if (type === "bool") return toWord(value ? 1n : 0n);
  if (/^uint\d*$/.test(type) || /^int\d*$/.test(type)) return toWord(BigInt(value as never));
  if (/^bytes(\d+)$/.test(type)) {
    const b = hexToBytes(String(value));
    const out = new Uint8Array(32);
    out.set(b.subarray(0, 32), 0); // right-padded
    return out;
  }
  throw new Error(`unsupported EIP-712 field type: ${type}`);
}

export function hashStruct(primaryType: string, value: Value, types: Types): Uint8Array {
  const chunks: Uint8Array[] = [typeHash(primaryType, types)];
  for (const field of types[primaryType])
    chunks.push(encodeField(field.type, value[field.name], types));
  return keccak256(concat(chunks));
}

export interface Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export function domainSeparator(domain: Domain): Uint8Array {
  const types: Types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
  };
  return hashStruct("EIP712Domain", domain as unknown as Value, types);
}

/** The 32-byte digest that gets signed: keccak256(0x1901 ‖ domainSep ‖ hashStruct). */
export function eip712Digest(
  domain: Domain,
  primaryType: string,
  types: Types,
  message: Value
): Uint8Array {
  return keccak256(
    concat([
      new Uint8Array([0x19, 0x01]),
      domainSeparator(domain),
      hashStruct(primaryType, message, types),
    ])
  );
}

export interface Signature {
  r: string;
  s: string;
  v: number;
}

/** Sign a 32-byte digest with a secp256k1 private key (low-s, v ∈ {27,28}).
 *  @noble/curves v2 returns a 65-byte "recovered" signature: [recovery][r][s]. */
export function signDigest(digest: Uint8Array, privKeyHex: string): Signature {
  const priv = hexToBytes(privKeyHex);
  // prehash:false — `digest` is already the 32-byte EIP-712 hash; do NOT let
  // the library hash it again (its default), or the signature won't recover.
  const sig = secp256k1.sign(digest, priv, {
    lowS: true,
    format: "recovered",
    prehash: false,
  });
  return {
    v: sig[0] + 27,
    r: bytesToHex(sig.slice(1, 33)),
    s: bytesToHex(sig.slice(33, 65)),
  };
}

/** Ethereum address for a private key (for verifying which wallet will sign). */
export function addressFromPrivateKey(privKeyHex: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(privKeyHex), false); // 65B: 0x04|X|Y
  const hash = keccak256(pub.slice(1));
  return "0x" + bytesToHex(hash.slice(12)).slice(2);
}
