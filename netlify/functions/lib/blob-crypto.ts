/**
 * @file AES-256-GCM encryption helpers for Netlify Blobs storage.
 *
 * All widget token records and user index entries stored in Netlify Blobs are
 * encrypted at rest using AES-256-GCM. The encryption key is read from the
 * `BLOB_ENCRYPTION_KEY` environment variable and must be a 64-character
 * lowercase hexadecimal string (32 bytes).
 *
 * Ciphertext format: `<iv_hex>:<ciphertext_hex>:<auth_tag_hex>`
 * - IV  : 12 bytes random, per-message (96-bit nonce for GCM)
 * - Tag : 16 bytes GCM authentication tag
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const BLOB_ENCRYPTION_KEY_ENV = 'BLOB_ENCRYPTION_KEY';
const HEX_256_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parses and validates the 32-byte hex key. Throws if it is malformed.
 *
 * @param keyHex - 64-character lowercase hex string.
 * @returns A 32-byte `Buffer` ready for use with `createCipheriv`.
 * @throws If `keyHex` does not match the expected 64-hex-char pattern.
 */
function readEncryptionKey(keyHex: string): Buffer {
  if (!HEX_256_KEY_PATTERN.test(keyHex)) {
    throw new Error(`${BLOB_ENCRYPTION_KEY_ENV} must be a 64-character lowercase hex string`);
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Reads and validates the `BLOB_ENCRYPTION_KEY` environment variable.
 *
 * @returns The validated 64-character hex key string.
 * @throws If the variable is missing or not a 64-character lowercase hex string.
 */
export function readBlobEncryptionKey(): string {
  const key = process.env[BLOB_ENCRYPTION_KEY_ENV];
  if (!key) {
    throw new Error(`${BLOB_ENCRYPTION_KEY_ENV} is not configured`);
  }
  if (!HEX_256_KEY_PATTERN.test(key)) {
    throw new Error(`${BLOB_ENCRYPTION_KEY_ENV} must be a 64-character lowercase hex string`);
  }
  return key;
}

/**
 * Encrypts `plaintext` using AES-256-GCM with a random 96-bit nonce.
 *
 * @param plaintext - UTF-8 string to encrypt (typically a JSON record).
 * @param keyHex    - 64-character lowercase hex key (32 bytes).
 * @returns Ciphertext in the format `<iv_hex>:<ciphertext_hex>:<tag_hex>`.
 * @throws If `keyHex` is invalid.
 */
export function encryptBlob(plaintext: string, keyHex: string): string {
  const key = readEncryptionKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ciphertext.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Decrypts a blob record previously produced by {@link encryptBlob}.
 *
 * Returns `null` (instead of throwing) for any input that fails format
 * validation or GCM authentication so that callers can safely fall through
 * to legacy-plaintext migration paths.
 *
 * @param encrypted - Ciphertext in the format `<iv_hex>:<ciphertext_hex>:<tag_hex>`.
 * @param keyHex    - 64-character lowercase hex key (32 bytes).
 * @returns The decrypted UTF-8 plaintext string, or `null` on any failure.
 */
export function decryptBlob(encrypted: string, keyHex: string): string | null {
  const parts = encrypted.split(':');
  if (parts.length !== 3) return null;

  const [ivHex, ciphertextHex, tagHex] = parts;
  if (!ivHex || !ciphertextHex || !tagHex) return null;
  if (!/^[0-9a-f]+$/.test(ivHex) || !/^[0-9a-f]+$/.test(ciphertextHex) || !/^[0-9a-f]+$/.test(tagHex)) return null;
  if (ivHex.length !== 24 || tagHex.length !== 32 || ciphertextHex.length === 0 || ciphertextHex.length % 2 !== 0) {
    return null;
  }

  try {
    const key = readEncryptionKey(keyHex);
    const iv = Buffer.from(ivHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      return null;
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}
