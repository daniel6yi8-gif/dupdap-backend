import { createCipheriv, randomBytes } from 'crypto';
import { EncryptionService } from './encryption.service';
import {
  encryptedColumnTransformer,
  setEncryptionServiceInstance,
} from './encrypted-column.transformer';

const RAW_32_BYTE_KEY = '0123456789abcdef0123456789abcdef';
const HEX_32_BYTE_KEY = 'a'.repeat(64);
/** base64 of 32 raw bytes — 44 chars ending in a single '=' pad */
const BASE64_32_BYTE_KEY = Buffer.alloc(32, 0x2a).toString('base64');

describe('EncryptionService', () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = RAW_32_BYTE_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalKey;
    }
  });

  it('encrypts and decrypts using AES-256-GCM', () => {
    const service = new EncryptionService();
    const encrypted = service.encrypt('sensitive-value');
    expect(encrypted.startsWith('encv1:')).toBe(true);
    expect(service.decrypt(encrypted)).toBe('sensitive-value');
  });

  it('column transformer encrypts on write and decrypts on read', () => {
    setEncryptionServiceInstance(new EncryptionService());
    const transformer = encryptedColumnTransformer('test.field');
    const encrypted = transformer.to('1234567890');
    expect(encrypted).toContain('encv1:');
    expect(transformer.from(encrypted as string)).toBe('1234567890');
  });

  describe('resolveKey — accepted ENCRYPTION_KEY formats', () => {
    /** Encrypts with a service built from `rawKey`, then decrypts with the same key. */
    function roundTripWith(rawKey: string): string {
      process.env.ENCRYPTION_KEY = rawKey;
      const service = new EncryptionService();
      return service.decrypt(service.encrypt('key-format-check'));
    }

    it('accepts a 32-byte raw utf8 key', () => {
      expect(Buffer.from(RAW_32_BYTE_KEY, 'utf8')).toHaveLength(32);
      expect(roundTripWith(RAW_32_BYTE_KEY)).toBe('key-format-check');
    });

    it('accepts a 64-char hex key', () => {
      expect(Buffer.from(HEX_32_BYTE_KEY, 'hex')).toHaveLength(32);
      expect(roundTripWith(HEX_32_BYTE_KEY)).toBe('key-format-check');
    });

    it('accepts a base64 key that decodes to 32 bytes', () => {
      expect(Buffer.from(BASE64_32_BYTE_KEY, 'base64')).toHaveLength(32);
      expect(roundTripWith(BASE64_32_BYTE_KEY)).toBe('key-format-check');
    });

    it('resolves the hex and base64 forms of one key to interchangeable key material', () => {
      // The same 32 bytes expressed as hex and as base64 must produce the same AES key.
      const rawBytes = Buffer.alloc(32, 0x2a);
      process.env.ENCRYPTION_KEY = rawBytes.toString('hex');
      const encrypted = new EncryptionService().encrypt('shared-plaintext');

      process.env.ENCRYPTION_KEY = rawBytes.toString('base64');
      expect(new EncryptionService().decrypt(encrypted)).toBe('shared-plaintext');
    });

    it('throws when ENCRYPTION_KEY is not set', () => {
      delete process.env.ENCRYPTION_KEY;
      expect(() => new EncryptionService()).toThrow('ENCRYPTION_KEY is not set');
    });

    it('throws when the key does not resolve to exactly 32 bytes', () => {
      process.env.ENCRYPTION_KEY = 'too-short';
      expect(() => new EncryptionService()).toThrow(
        'ENCRYPTION_KEY must resolve to exactly 32 bytes (raw utf8, base64, or hex)',
      );
    });

    it('throws when a base64-looking key decodes to the wrong length', () => {
      // 45 unpadded base64 chars decode to 33 bytes — passes the charset check, fails the length check.
      process.env.ENCRYPTION_KEY = 'A'.repeat(45);
      expect(() => new EncryptionService()).toThrow(
        'ENCRYPTION_KEY must resolve to exactly 32 bytes (raw utf8, base64, or hex)',
      );
    });
  });

  describe('decrypt — corrupted ciphertext and wrong keys', () => {
    let service: EncryptionService;

    beforeEach(() => {
      service = new EncryptionService();
    });

    it('throws on a tampered auth tag instead of returning garbage', () => {
      const [prefix, iv, tag, payload] = service.encrypt('sensitive-value').split(':');
      const flippedTag = Buffer.from(tag, 'base64');
      flippedTag[0] ^= 0xff;

      expect(() =>
        service.decrypt(`${prefix}:${iv}:${flippedTag.toString('base64')}:${payload}`),
      ).toThrow();
    });

    it('throws on a tampered payload', () => {
      const [prefix, iv, tag, payload] = service.encrypt('sensitive-value').split(':');
      const flippedPayload = Buffer.from(payload, 'base64');
      flippedPayload[0] ^= 0xff;

      expect(() =>
        service.decrypt(`${prefix}:${iv}:${tag}:${flippedPayload.toString('base64')}`),
      ).toThrow();
    });

    it('throws on a truncated payload', () => {
      const [prefix, iv, tag, payload] = service.encrypt('sensitive-value').split(':');
      const truncated = Buffer.from(payload, 'base64').subarray(0, 1);

      expect(() =>
        service.decrypt(`${prefix}:${iv}:${tag}:${truncated.toString('base64')}`),
      ).toThrow();
    });

    it('throws when decrypted with a different (rotated) key', () => {
      const encrypted = service.encrypt('sensitive-value');

      process.env.ENCRYPTION_KEY = 'fedcba9876543210fedcba9876543210';
      const rotated = new EncryptionService();

      expect(() => rotated.decrypt(encrypted)).toThrow();
    });

    it('throws on a payload with the wrong number of segments', () => {
      expect(() => service.decrypt('encv1:iv:tag')).toThrow('Invalid encrypted payload format');
    });

    it('throws when the IV is not 12 bytes', () => {
      const [prefix, , tag, payload] = service.encrypt('sensitive-value').split(':');

      expect(() =>
        service.decrypt(`${prefix}:${randomBytes(8).toString('base64')}:${tag}:${payload}`),
      ).toThrow('Invalid encrypted payload components');
    });

    it('passes non-encv1 values through unchanged (pre-encryption rows)', () => {
      expect(service.decrypt('not-encrypted')).toBe('not-encrypted');
      expect(service.decrypt('')).toBe('');
    });
  });

  describe('decryptLegacy', () => {
    /** Builds a pre-`encv1` record: IV stored separately, `authTag:ciphertext` hex in one column. */
    function buildLegacyRecord(plaintext: string): { ciphertext: string; ivHex: string } {
      const key = Buffer.from(RAW_32_BYTE_KEY, 'utf8');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

      return {
        ciphertext: `${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`,
        ivHex: iv.toString('hex'),
      };
    }

    it('decrypts a legacy authTag:ciphertext record given the separately stored hex IV', () => {
      const service = new EncryptionService();
      const { ciphertext, ivHex } = buildLegacyRecord('legacy-secret');

      expect(service.decryptLegacy(ciphertext, ivHex)).toBe('legacy-secret');
    });

    it('throws when the legacy payload is missing the authTag:ciphertext separator', () => {
      const service = new EncryptionService();
      const { ivHex } = buildLegacyRecord('legacy-secret');

      expect(() => service.decryptLegacy('deadbeef', ivHex)).toThrow(
        'Invalid legacy encrypted payload',
      );
    });

    it('throws on a legacy record with a tampered auth tag', () => {
      const service = new EncryptionService();
      const { ciphertext, ivHex } = buildLegacyRecord('legacy-secret');
      const [tag, payload] = ciphertext.split(':');
      const flippedTag = Buffer.from(tag, 'hex');
      flippedTag[0] ^= 0xff;

      expect(() =>
        service.decryptLegacy(`${flippedTag.toString('hex')}:${payload}`, ivHex),
      ).toThrow();
    });

    it('throws on a legacy record decrypted with the wrong IV', () => {
      const service = new EncryptionService();
      const { ciphertext } = buildLegacyRecord('legacy-secret');

      expect(() =>
        service.decryptLegacy(ciphertext, randomBytes(12).toString('hex')),
      ).toThrow();
    });
  });

  describe('getInstance (DI-managed singleton)', () => {
    it('returns the instance created by the constructor', () => {
      const service = new EncryptionService();

      expect(EncryptionService.getInstance()).toBe(service);
    });

    it('throws when Nest DI has not instantiated the service yet', () => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { EncryptionService: Fresh } = require('./encryption.service');

        expect(() => Fresh.getInstance()).toThrow(
          'EncryptionService has not been initialized by the Nest DI container yet',
        );
      });
    });
  });
});

