import {
  constructHybridNonce,
  parseHybridNonce,
  validateHybridNonce,
  isOffChainNonce,
  isOnChainNonce,
  isPermit2Nonce,
  hybridNonceToHex,
  hexToHybridNonce,
} from '../../validation/hybrid-nonce';
import { NonceCommand } from '../../validation/types';

describe('Hybrid Nonce Utilities', () => {
  const testSponsor = '0x1234567890123456789012345678901234567890';

  describe('constructHybridNonce', () => {
    it('should construct a valid OFF_CHAIN nonce', () => {
      const fragment = BigInt(12345);
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        testSponsor,
        fragment
      );

      // Verify nonce is a valid bigint
      expect(typeof nonce).toBe('bigint');

      // Parse it back and verify components
      const parsed = parseHybridNonce(nonce);
      expect(parsed.command).toBe(NonceCommand.OFF_CHAIN);
      expect(parsed.sponsor.toLowerCase()).toBe(testSponsor.toLowerCase());
      expect(parsed.fragment).toBe(fragment);
    });

    it('should construct a valid ON_CHAIN nonce', () => {
      const fragment = BigInt(999);
      const nonce = constructHybridNonce(
        NonceCommand.ON_CHAIN,
        testSponsor,
        fragment
      );

      const parsed = parseHybridNonce(nonce);
      expect(parsed.command).toBe(NonceCommand.ON_CHAIN);
      expect(parsed.sponsor.toLowerCase()).toBe(testSponsor.toLowerCase());
      expect(parsed.fragment).toBe(fragment);
    });

    it('should construct a valid PERMIT2 nonce', () => {
      const fragment = BigInt(0);
      const nonce = constructHybridNonce(
        NonceCommand.PERMIT2,
        testSponsor,
        fragment
      );

      const parsed = parseHybridNonce(nonce);
      expect(parsed.command).toBe(NonceCommand.PERMIT2);
      expect(parsed.sponsor.toLowerCase()).toBe(testSponsor.toLowerCase());
      expect(parsed.fragment).toBe(fragment);
    });

    it('should throw for fragment exceeding 11 bytes', () => {
      const maxFragment = (BigInt(1) << BigInt(88)) - BigInt(1);
      const overflowFragment = maxFragment + BigInt(1);

      // Max fragment should work
      expect(() =>
        constructHybridNonce(NonceCommand.OFF_CHAIN, testSponsor, maxFragment)
      ).not.toThrow();

      // Overflow should throw
      expect(() =>
        constructHybridNonce(
          NonceCommand.OFF_CHAIN,
          testSponsor,
          overflowFragment
        )
      ).toThrow();
    });

    it('should throw for negative fragment', () => {
      expect(() =>
        constructHybridNonce(NonceCommand.OFF_CHAIN, testSponsor, BigInt(-1))
      ).toThrow();
    });
  });

  describe('parseHybridNonce', () => {
    it('should correctly parse a constructed nonce', () => {
      const fragment = BigInt('123456789012345678901234');
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        testSponsor,
        fragment
      );

      const parsed = parseHybridNonce(nonce);

      expect(parsed.command).toBe(NonceCommand.OFF_CHAIN);
      expect(parsed.sponsor.toLowerCase()).toBe(testSponsor.toLowerCase());
      expect(parsed.fragment).toBe(fragment);
    });

    it('should throw for invalid command byte', () => {
      // Construct a nonce with invalid command byte (0x00)
      const invalidNonce = BigInt(testSponsor) << BigInt(88);

      expect(() => parseHybridNonce(invalidNonce)).toThrow(
        'Invalid nonce command byte'
      );
    });
  });

  describe('command type checks', () => {
    it('isOffChainNonce should return true for OFF_CHAIN nonces', () => {
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        testSponsor,
        BigInt(1)
      );
      expect(isOffChainNonce(nonce)).toBe(true);
      expect(isOnChainNonce(nonce)).toBe(false);
      expect(isPermit2Nonce(nonce)).toBe(false);
    });

    it('isOnChainNonce should return true for ON_CHAIN nonces', () => {
      const nonce = constructHybridNonce(
        NonceCommand.ON_CHAIN,
        testSponsor,
        BigInt(1)
      );
      expect(isOnChainNonce(nonce)).toBe(true);
      expect(isOffChainNonce(nonce)).toBe(false);
      expect(isPermit2Nonce(nonce)).toBe(false);
    });

    it('isPermit2Nonce should return true for PERMIT2 nonces', () => {
      const nonce = constructHybridNonce(
        NonceCommand.PERMIT2,
        testSponsor,
        BigInt(1)
      );
      expect(isPermit2Nonce(nonce)).toBe(true);
      expect(isOffChainNonce(nonce)).toBe(false);
      expect(isOnChainNonce(nonce)).toBe(false);
    });
  });

  describe('validateHybridNonce', () => {
    it('should validate nonce with matching sponsor', () => {
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        testSponsor,
        BigInt(1)
      );

      const result = validateHybridNonce(nonce, testSponsor);
      expect(result.isValid).toBe(true);
    });

    it('should reject nonce with mismatched sponsor', () => {
      const otherSponsor = '0x0000000000000000000000000000000000000001';
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        testSponsor,
        BigInt(1)
      );

      const result = validateHybridNonce(nonce, otherSponsor);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('sponsor mismatch');
    });

    it('should validate nonce with expected command type', () => {
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        testSponsor,
        BigInt(1)
      );

      const validResult = validateHybridNonce(
        nonce,
        testSponsor,
        NonceCommand.OFF_CHAIN
      );
      expect(validResult.isValid).toBe(true);

      const invalidResult = validateHybridNonce(
        nonce,
        testSponsor,
        NonceCommand.ON_CHAIN
      );
      expect(invalidResult.isValid).toBe(false);
      expect(invalidResult.error).toContain('command mismatch');
    });
  });

  describe('hex conversion', () => {
    it('should convert nonce to hex and back', () => {
      const fragment = BigInt('98765432109876543210');
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        testSponsor,
        fragment
      );

      const hex = hybridNonceToHex(nonce);
      expect(hex.startsWith('0x')).toBe(true);
      expect(hex.length).toBe(66); // 0x + 64 hex chars

      const parsed = hexToHybridNonce(hex);
      expect(parsed).toBe(nonce);
    });

    it('should pad hex to 32 bytes', () => {
      const nonce = constructHybridNonce(
        NonceCommand.OFF_CHAIN,
        testSponsor,
        BigInt(1)
      );

      const hex = hybridNonceToHex(nonce);
      // Should be padded to full 32 bytes (64 hex chars)
      expect(hex.length).toBe(66);
    });
  });
});
