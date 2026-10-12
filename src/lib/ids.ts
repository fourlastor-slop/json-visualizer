/** Random identifiers. Not `crypto.randomUUID`, which is unavailable on plain-http origins. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
