import {
  canonicalizeBbl,
  canonicalizeBin,
  filterValidBins,
  isPlaceholderBin,
  parseBblComponents,
} from '../../../src/schemas/property-identifiers.schema';

describe('property identifier primitives', () => {
  describe('BBL validation and canonicalization', () => {
    it('accepts valid 10-digit BBLs without losing NYC zero padding', () => {
      expect(canonicalizeBbl('1008350041')).toBe('1008350041');
      expect(canonicalizeBbl(' 1008350041 ')).toBe('1008350041');
      expect(parseBblComponents('1008350041')).toEqual({
        bbl: '1008350041',
        borough: 1,
        block: 835,
        lot: 41,
      });
    });

    it('rejects malformed BBLs', () => {
      for (const value of ['123', '100835004', '10083500411', 'abcdefghij', '']) {
        expect(() => canonicalizeBbl(value)).toThrow();
      }
    });
  });

  describe('BIN validation and canonicalization', () => {
    it('accepts valid 7-digit BINs', () => {
      expect(canonicalizeBin('1012345')).toBe('1012345');
      expect(canonicalizeBin(' 1012345 ')).toBe('1012345');
    });

    it('rejects malformed BINs', () => {
      for (const value of ['123', '12345678', 'abcdefg', '']) {
        expect(() => canonicalizeBin(value)).toThrow();
      }
    });

    it('treats BINs ending in 000000 as placeholders', () => {
      expect(isPlaceholderBin('1000000')).toBe(true);
      expect(isPlaceholderBin('3000000')).toBe(true);
      expect(isPlaceholderBin('1012345')).toBe(false);
    });
  });

  describe('effective BIN filtering', () => {
    it('excludes placeholder and invalid BINs while preserving valid identifiers', () => {
      expect(
        filterValidBins(['1012345', '3000000', '1000000', 'bad-bin', ' 1022334 ']),
      ).toEqual(['1012345', '1022334']);
    });
  });
});
