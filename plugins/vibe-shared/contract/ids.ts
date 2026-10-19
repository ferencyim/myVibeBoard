// Monotonic ULID generator (Crockford base32). Runtime-neutral: no node imports.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < RANDOM_LEN; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b % 32);
}

function encodeTime(ms: number): string {
  let rest = ms;
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

let lastTime = -1;
let lastRandom: number[] = [];

/** New ULID. Strictly increasing within one process even inside the same millisecond. */
export function newId(nowMs: number = Date.now()): string {
  if (nowMs <= lastTime) {
    // Same (or earlier, clock stepped back) millisecond: increment the random part.
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      if ((lastRandom[i] as number) === 31) {
        lastRandom[i] = 0;
      } else {
        lastRandom[i] = (lastRandom[i] as number) + 1;
        break;
      }
    }
  } else {
    lastTime = nowMs;
    lastRandom = randomDigits();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ENCODING[d]).join("");
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}
