export class SlidePlanParseError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SlidePlanParseError";
    this.path = path;
  }
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SlidePlanParseError(path, "required object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SlidePlanParseError(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

export function exact(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const result = record(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) {
      throw new SlidePlanParseError(`${path}.${key}`, "key is not allowed");
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(result, key) || result[key] === undefined) {
      throw new SlidePlanParseError(`${path}.${key}`, "is required");
    }
  }
  return result;
}

export function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new SlidePlanParseError(path, "must be a string");
  if (value.trim().length === 0) throw new SlidePlanParseError(path, "must not be empty");
  return value;
}

export function stableId(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw new SlidePlanParseError(path, "must be a stable ID");
  }
  return result;
}

export function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum) {
    const description = minimum === 1 ? "a positive integer" : "a non-negative integer";
    throw new SlidePlanParseError(path, `must be ${description}`);
  }
  return value;
}

export function positive(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SlidePlanParseError(path, "must be a positive number");
  }
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new SlidePlanParseError(path, `must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

export function sha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new SlidePlanParseError(path, "must be a 64-character SHA-256 hash");
  }
  return value;
}

export function array(value: unknown, path: string, nonEmpty = false): unknown[] {
  if (!Array.isArray(value)) throw new SlidePlanParseError(path, "must be an array");
  if (nonEmpty && value.length === 0) throw new SlidePlanParseError(path, "must not be empty");
  return value;
}

export function isoDate(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) ||
      Number.isNaN(Date.parse(result))) {
    throw new SlidePlanParseError(path, "must be an ISO-8601 UTC timestamp");
  }
  return result;
}

export function unique(
  values: readonly string[],
  path: string,
  label = "value",
  member = "",
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      throw new SlidePlanParseError(`${path}[${index}]${member}`, `duplicate ${label} '${value}'`);
    }
    seen.add(value);
  });
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
