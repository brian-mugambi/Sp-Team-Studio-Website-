export const MAX_POSTS = 100;
export const MAX_MESSAGES = 5;
export const MIN_MESSAGE = 10;
export const MAX_MESSAGE = 50;

// Replies are a nested layer under a single message. They share the message
// character limits, but are capped per-message so one thread can't grow
// unbounded. Deleting a message removes its replies (cascadeMessage); deleting
// a reply touches nothing else.
export const MAX_REPLIES_PER_MESSAGE = 20;
export const MIN_REPLY = MIN_MESSAGE;
export const MAX_REPLY = MAX_MESSAGE;

export function normalizeUsername(v: string) { return v.trim().toLowerCase(); }
export function validUsername(v: string) { return /^[a-z0-9_]{3,24}$/.test(v); }
export function validMessage(v: string) {
  const n = [...v.trim()].length;
  return n >= MIN_MESSAGE && n <= MAX_MESSAGE;
}
export function validMediaUrl(v: string) {
  try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:"; }
  catch { return false; }
}
export function mediaTypeFromUrl(v: string): "image"|"video" {
  return /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(v) ? "video" : "image";
}
export function detectContacts(text: string) {
  return {
    urls: text.match(/https?:\/\/[^\s<]+/gi) ?? [],
    emails: text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [],
    phones: text.match(/(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)/g) ?? []
  };
}
