const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exact(value, path, required, optional = []) {
  if (!isRecord(value)) throw new TypeError(`${path}: must be a plain object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.has(key)) throw new TypeError(`${path}.${key}: unexpected key`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      throw new TypeError(`${path}.${key}: is required`);
    }
  }
  return value;
}

export function stableId(value, path) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new TypeError(`${path}: must be a stable ID`);
  }
  return value;
}

export function stringValue(value, path, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.trim() === "")) {
    throw new TypeError(`${path}: must be ${empty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

export function arrayValue(value, path, nonEmpty = false) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new TypeError(`${path}: must be ${nonEmpty ? "a non-empty array" : "an array"}`);
  }
  return value;
}

export function integer(value, path, minimum = 0) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${path}: must be an integer >= ${minimum}`);
  }
  return value;
}

export function oneOf(value, path, choices) {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new TypeError(`${path}: must be one of ${choices.join(", ")}`);
  }
  return value;
}

export function unique(values, path) {
  const seen = new Set();
  values.forEach((value, index) => {
    if (seen.has(value)) throw new TypeError(`${path}[${index}]: duplicate value '${value}'`);
    seen.add(value);
  });
  return values;
}

export function clone(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("cyclic input is not supported");
  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`unexpected key: ${key}`);
    copy[key] = clone(value[key], seen);
  }
  seen.delete(value);
  return copy;
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

export function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot serialize a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`cannot serialize ${typeof value}`);
  if (seen.has(value)) throw new TypeError("cannot serialize a cyclic value");
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((item) => canonicalize(item, seen));
  else {
    if (!isRecord(value)) throw new TypeError("can only serialize plain objects");
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`cannot serialize unsafe key: ${key}`);
      if (value[key] === undefined) throw new TypeError(`cannot serialize undefined at ${key}`);
      result[key] = canonicalize(value[key], seen);
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

// Small synchronous SHA-256 for deterministic browser-side fingerprints.
export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const words = [];
  const bitLength = bytes.length * 8;
  for (const byte of bytes) words.push(byte);
  words.push(0x80);
  while (words.length % 64 !== 56) words.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) words.push((high >>> shift) & 255);
  for (let shift = 24; shift >= 0; shift -= 8) words.push((low >>> shift) & 255);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const k = [];
  const primes = [];
  for (let candidate = 2; primes.length < 64; candidate += 1) {
    if (primes.every((prime) => candidate % prime !== 0)) primes.push(candidate);
  }
  for (const prime of primes) k.push((Math.floor((Math.cbrt(prime) % 1) * 0x100000000)) >>> 0);
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < words.length; offset += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = ((words[at] << 24) | (words[at + 1] << 16) | (words[at + 2] << 8) | words[at + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, z] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const t1 = (z + s1 + ((e & f) ^ (~e & g)) + k[i] + w[i]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [a, b, c, d, e, f, g, z] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
    }
    for (let i = 0; i < 8; i += 1) h[i] = (h[i] + [a, b, c, d, e, f, g, z][i]) >>> 0;
  }
  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}
