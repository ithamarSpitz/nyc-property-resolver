import { AppError } from '../../../src/errors';
import { normalizeAddress } from '../../../src/services/property-resolver/address-normalizer';

describe('address normalizer', () => {
  describe('whitespace and casing normalization', () => {
    it('collapses repeated whitespace and normalizes casing deterministically', () => {
      const variants = [
        '350   5th   Avenue',
        '350 5th avenue',
        '  350 5th Avenue  ',
      ];

      const expected = {
        normalizedBaseAddress: '350 5th Avenue',
        normalizedUnitDesignation: null,
        normalizedInput: '350 5th Avenue',
      };

      for (const address of variants) {
        expect(normalizeAddress(address)).toEqual(expected);
      }
    });
  });

  describe('Queens hyphenated house numbers', () => {
    it('preserves Queens hyphenated house numbers exactly', () => {
      const result = normalizeAddress('37-15  82nd   street');

      expect(result.normalizedBaseAddress).toBe('37-15 82nd Street');
      expect(result.normalizedInput).toBe('37-15 82nd Street');
      expect(result.normalizedBaseAddress).toContain('37-15');
      expect(result.normalizedBaseAddress).not.toMatch(/3715|37 15/);
    });

    it('does not rewrite hyphenated house numbers during idempotent re-normalization', () => {
      const firstPass = normalizeAddress('37-15 82nd Street');
      const secondPass = normalizeAddress(firstPass.normalizedInput);

      expect(secondPass).toEqual(firstPass);
      expect(secondPass.normalizedInput).toBe('37-15 82nd Street');
    });
  });

  describe('unit-aware addresses', () => {
    it('extracts base address, unit designation, and full normalized input', () => {
      const result = normalizeAddress('419 E 84 St Apt 12C');

      expect(result).toEqual({
        normalizedBaseAddress: '419 E 84 St',
        normalizedUnitDesignation: '12C',
        normalizedInput: '419 E 84 St Apt 12C',
      });
    });

    it('keeps different units in the same building distinct', () => {
      const unit12C = normalizeAddress('419 E 84 St Apt 12C');
      const unit12D = normalizeAddress('419 E 84 St Apt 12D');

      expect(unit12C.normalizedBaseAddress).toBe(unit12D.normalizedBaseAddress);
      expect(unit12C.normalizedInput).not.toBe(unit12D.normalizedInput);
      expect(unit12C.normalizedUnitDesignation).toBe('12C');
      expect(unit12D.normalizedUnitDesignation).toBe('12D');
    });

    it('normalizes equivalent supported unit syntax consistently', () => {
      const apt = normalizeAddress('419 e 84 st apt 12c');
      const apartment = normalizeAddress('419 E 84 St Apartment 12C');
      const hash = normalizeAddress('419 E 84 St #12C');

      expect(apt).toEqual({
        normalizedBaseAddress: '419 E 84 St',
        normalizedUnitDesignation: '12C',
        normalizedInput: '419 E 84 St Apt 12C',
      });
      expect(apartment).toEqual(apt);
      expect(hash).toEqual({
        normalizedBaseAddress: '419 E 84 St',
        normalizedUnitDesignation: '12C',
        normalizedInput: '419 E 84 St # 12C',
      });
    });
  });

  describe('idempotency', () => {
    it('returns the same result when normalization runs twice', () => {
      const inputs = [
        '350 5th Avenue',
        '37-15 82nd Street',
        '419 E 84 St Apt 12C',
      ];

      for (const input of inputs) {
        const once = normalizeAddress(input);
        const twice = normalizeAddress(once.normalizedInput);

        expect(twice).toEqual(once);
      }
    });
  });

  describe('malformed and empty input', () => {
    it('rejects empty and whitespace-only input', () => {
      for (const value of ['', '   ', '\n\t']) {
        expect(() => normalizeAddress(value)).toThrow(AppError);
        expect(() => normalizeAddress(value)).toThrow('Address input must not be empty');
      }
    });

    it('rejects input without alphanumeric content', () => {
      expect(() => normalizeAddress(' , , ')).toThrow('Address input must contain at least one alphanumeric character');
    });

    it('rejects unit-only input without a base street address', () => {
      expect(() => normalizeAddress('Apt 12C')).toThrow('Address input must include a base street address');
    });
  });
});
