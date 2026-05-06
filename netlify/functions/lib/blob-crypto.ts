import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const BLOB_ENCRYPTION_KEY_ENV = 'BLOB_ENCRYPTION_KEY';

function readEncryptionKey(keyHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error(`${BLOB_ENCRYPTION_KEY_ENV} must be a 64-character lowercase hex string`);
  }
  return Buffer.from(keyHex, 'hex');
}

export function readBlobEncryptionKey(): string {
  const key = process.env[BLOB_ENCRYPTION_KEY_ENV];
  if (!key) {
    throw new Error(`${BLOB_ENCRYPTION_KEY_ENV} is not configured`);
  }
  readEncryptionKey(key);
  return key;
}

export function encryptBlob(plaintext: string, keyHex: string): string {
  const key = readEncryptionKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ciphertext.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptBlob(encrypted: string, keyHex: string): string | null {
  const parts = encrypted.split(':');
  if (parts.length !== 3) return null;

  const [ivHex, ciphertextHex, tagHex] = parts;
  if (!ivHex || !ciphertextHex || !tagHex) return null;

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
