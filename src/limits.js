// Safety limits for untrusted image files. Generous for phone photos
// (a 48 MP iPhone ProRAW-to-HEIC export is ~48 megapixels and ~15 MB).
export const MAX_FILE_BYTES = 64 * 1024 * 1024;  // download or local file
export const MAX_PIXELS = 120_000_000;           // decoded image area
export const MAX_TILES = 1024;                   // grid tiles per image
export const DECODE_TIMEOUT_MS = 20_000;         // per decode job; the worker is replaced after this

/** A file exceeded a safety limit. Never retried another way. */
export class LimitError extends Error {
  constructor(message) { super(message); this.name = 'LimitError'; }
}
