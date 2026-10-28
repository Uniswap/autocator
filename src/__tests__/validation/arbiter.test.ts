import {
  getAllocatorAddress,
  TRIBUNAL_ADDRESS,
  THE_COMPACT_ADDRESS,
  initializeAllowedArbiters,
  isArbiterAllowed,
  validateArbiter,
  getAllowedArbiters,
  isTribunal,
  addAllowedArbiter,
  removeAllowedArbiter,
} from '../../validation/arbiter';

describe('Arbiter Validation', () => {
  // Reset to default state before each test
  beforeEach(() => {
    initializeAllowedArbiters();
  });

  describe('Contract Addresses', () => {
    it('should get allocator address from environment', () => {
      // The allocator address should come from ALLOCATOR_ADDRESS env var
      const allocatorAddress = getAllocatorAddress();
      expect(allocatorAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      // Verify it's the value from the env (set in test setup)
      expect(allocatorAddress.toLowerCase()).toBe(
        process.env.ALLOCATOR_ADDRESS!.toLowerCase()
      );
    });

    it('should export correct Tribunal address', () => {
      expect(TRIBUNAL_ADDRESS).toBe(
        '0x000000000000790009689f43bAedb61D67D45bB8'
      );
    });

    it('should export correct The Compact address', () => {
      expect(THE_COMPACT_ADDRESS).toBe(
        '0x00000000000000171ede64904551eeDF3C6C9788'
      );
    });
  });

  describe('initializeAllowedArbiters', () => {
    it('should include Tribunal by default', () => {
      initializeAllowedArbiters();
      expect(isArbiterAllowed(TRIBUNAL_ADDRESS)).toBe(true);
    });

    it('should add custom arbiters from comma-separated string', () => {
      const customArbiter1 = '0x1234567890123456789012345678901234567890';
      const customArbiter2 = '0xabcdefABCDEF12345678901234567890ABCDEF12';

      initializeAllowedArbiters(`${customArbiter1}, ${customArbiter2}`);

      expect(isArbiterAllowed(TRIBUNAL_ADDRESS)).toBe(true); // Still allowed
      expect(isArbiterAllowed(customArbiter1)).toBe(true);
      expect(isArbiterAllowed(customArbiter2)).toBe(true);
    });

    it('should handle empty string', () => {
      initializeAllowedArbiters('');
      expect(isArbiterAllowed(TRIBUNAL_ADDRESS)).toBe(true);
    });

    it('should handle whitespace-only string', () => {
      initializeAllowedArbiters('   ');
      expect(isArbiterAllowed(TRIBUNAL_ADDRESS)).toBe(true);
    });

    it('should ignore invalid addresses', () => {
      // This should log a warning but not throw
      initializeAllowedArbiters(
        'invalid-address, 0x1234567890123456789012345678901234567890'
      );
      expect(
        isArbiterAllowed('0x1234567890123456789012345678901234567890')
      ).toBe(true);
    });
  });

  describe('isArbiterAllowed', () => {
    it('should return true for Tribunal', () => {
      expect(isArbiterAllowed(TRIBUNAL_ADDRESS)).toBe(true);
    });

    it('should return false for random address', () => {
      const randomAddress = '0x9999999999999999999999999999999999999999';
      expect(isArbiterAllowed(randomAddress)).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isArbiterAllowed(TRIBUNAL_ADDRESS.toLowerCase())).toBe(true);
      expect(isArbiterAllowed(TRIBUNAL_ADDRESS.toUpperCase())).toBe(true);
    });

    it('should return false for invalid address', () => {
      expect(isArbiterAllowed('not-an-address')).toBe(false);
    });
  });

  describe('validateArbiter', () => {
    it('should return valid for Tribunal', () => {
      const result = validateArbiter(TRIBUNAL_ADDRESS);
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return invalid for non-allowed arbiter', () => {
      const result = validateArbiter(
        '0x9999999999999999999999999999999999999999'
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('not in the allowed list');
    });

    it('should return invalid for malformed address', () => {
      const result = validateArbiter('not-an-address');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Invalid arbiter address');
    });
  });

  describe('getAllowedArbiters', () => {
    it('should return array with Tribunal by default', () => {
      const arbiters = getAllowedArbiters();
      expect(arbiters.length).toBe(1);
      expect(arbiters[0].toLowerCase()).toBe(TRIBUNAL_ADDRESS.toLowerCase());
    });

    it('should include custom arbiters after initialization', () => {
      const customArbiter = '0x1234567890123456789012345678901234567890';
      initializeAllowedArbiters(customArbiter);

      const arbiters = getAllowedArbiters();
      expect(arbiters.length).toBe(2);
      expect(arbiters.map((a) => a.toLowerCase())).toContain(
        TRIBUNAL_ADDRESS.toLowerCase()
      );
      expect(arbiters.map((a) => a.toLowerCase())).toContain(
        customArbiter.toLowerCase()
      );
    });
  });

  describe('isTribunal', () => {
    it('should return true for Tribunal address', () => {
      expect(isTribunal(TRIBUNAL_ADDRESS)).toBe(true);
    });

    it('should return true for lowercase Tribunal address', () => {
      expect(isTribunal(TRIBUNAL_ADDRESS.toLowerCase())).toBe(true);
    });

    it('should return false for other addresses', () => {
      expect(isTribunal(getAllocatorAddress())).toBe(false);
      expect(isTribunal('0x1234567890123456789012345678901234567890')).toBe(
        false
      );
    });

    it('should return false for invalid address', () => {
      expect(isTribunal('not-an-address')).toBe(false);
    });
  });

  describe('addAllowedArbiter', () => {
    it('should add a new arbiter', () => {
      const newArbiter = '0x1111111111111111111111111111111111111111';
      expect(isArbiterAllowed(newArbiter)).toBe(false);

      const added = addAllowedArbiter(newArbiter);
      expect(added).toBe(true);
      expect(isArbiterAllowed(newArbiter)).toBe(true);
    });

    it('should return false if arbiter already exists', () => {
      const added = addAllowedArbiter(TRIBUNAL_ADDRESS);
      expect(added).toBe(false);
    });

    it('should return false for invalid address', () => {
      const added = addAllowedArbiter('not-an-address');
      expect(added).toBe(false);
    });
  });

  describe('removeAllowedArbiter', () => {
    it('should not allow removing Tribunal', () => {
      const removed = removeAllowedArbiter(TRIBUNAL_ADDRESS);
      expect(removed).toBe(false);
      expect(isArbiterAllowed(TRIBUNAL_ADDRESS)).toBe(true);
    });

    it('should remove a custom arbiter', () => {
      const customArbiter = '0x2222222222222222222222222222222222222222';
      addAllowedArbiter(customArbiter);
      expect(isArbiterAllowed(customArbiter)).toBe(true);

      const removed = removeAllowedArbiter(customArbiter);
      expect(removed).toBe(true);
      expect(isArbiterAllowed(customArbiter)).toBe(false);
    });

    it('should return false for non-existent arbiter', () => {
      const removed = removeAllowedArbiter(
        '0x3333333333333333333333333333333333333333'
      );
      expect(removed).toBe(false);
    });

    it('should return false for invalid address', () => {
      const removed = removeAllowedArbiter('not-an-address');
      expect(removed).toBe(false);
    });
  });
});
