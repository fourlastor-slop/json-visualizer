/**
 * Pairing. The page and the bridge share a secret, the pairing code, and each proves to
 * the other that it knows it without ever sending it: a loopback port is open to every
 * program and every user of the machine, and whoever answers on it first is not
 * necessarily the bridge.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Pairing codes shorter than this are refused: they are meant to be generated, not chosen. */
export const MIN_TOKEN_LENGTH = 20;

export function newNonce() {
  return randomBytes(18).toString('base64url');
}

/**
 * What one side sends to show it knows the pairing code. `role` says who is speaking, so a
 * proof cannot be played back at its author, and the two nonces tie it to this connection.
 * The page computes the same value with WebCrypto.
 * @param {string} token
 * @param {'bridge' | 'page' | 'peer'} role
 * @param {string} clientNonce
 * @param {string} serverNonce
 */
export function proofOf(token, role, clientNonce, serverNonce) {
  return createHmac('sha256', token).update([role, clientNonce, serverNonce].join('\n')).digest('base64url');
}

/**
 * @param {unknown} given
 * @param {string} expected
 */
export function sameProof(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
