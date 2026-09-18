import type { BuildingFootprintCandidate } from '../../../src/clients/building-footprints.client';
import {
  assertFootprintIdentifierAgreement,
  assertGeoSearchBinCorroboratesFootprints,
  collectValidatedBins,
  validateFootprintCandidate,
  validateFootprintCandidates,
} from '../../../src/services/property-resolver/footprint-validation';
import { AppError } from '../../../src/errors';

function footprintCandidate(
  overrides: Partial<BuildingFootprintCandidate> & Pick<BuildingFootprintCandidate, 'bin' | 'baseBbl'>,
): BuildingFootprintCandidate {
  return {
    mapplutoBbl: undefined,
    ...overrides,
  };
}

describe('footprint validation', () => {
  const canonicalBbl = '1008350041';

  describe('non-condo validation', () => {
    it('accepts a candidate when MAPPLUTO_BBL matches the canonical PLUTO BBL', () => {
      const candidate = footprintCandidate({
        bin: '1088718',
        baseBbl: '1008350041',
        mapplutoBbl: '1008350041',
      });

      expect(validateFootprintCandidate(candidate, canonicalBbl, 'non-condo')).toEqual({
        candidate,
        bin: '1088718',
      });
    });

    it('rejects a candidate when MAPPLUTO_BBL mismatches the canonical PLUTO BBL', () => {
      const candidate = footprintCandidate({
        bin: '1088718',
        baseBbl: '1008350041',
        mapplutoBbl: '1008350042',
      });

      expect(validateFootprintCandidate(candidate, canonicalBbl, 'non-condo')).toBe(
        'MAPPLUTO_BBL_MISMATCH',
      );
    });

    it('requires BASE_BBL equality when MAPPLUTO evidence is absent', () => {
      const matching = footprintCandidate({
        bin: '1088718',
        baseBbl: '1008350041',
      });
      const mismatch = footprintCandidate({
        bin: '1088719',
        baseBbl: '1008350042',
      });

      expect(validateFootprintCandidate(matching, canonicalBbl, 'non-condo')).toEqual({
        candidate: matching,
        bin: '1088718',
      });
      expect(validateFootprintCandidate(mismatch, canonicalBbl, 'non-condo')).toBe(
        'BASE_BBL_MISMATCH',
      );
    });

    it('rejects a candidate when MAPPLUTO evidence is explicitly null and BASE_BBL mismatches', () => {
      const candidate = footprintCandidate({
        bin: '1088718',
        baseBbl: '1008350042',
        mapplutoBbl: null,
      });

      expect(validateFootprintCandidate(candidate, canonicalBbl, 'non-condo')).toBe(
        'BASE_BBL_MISMATCH',
      );
    });
  });

  describe('condo validation', () => {
    it('accepts a candidate when MAPPLUTO_BBL matches the billing BBL', () => {
      const candidate = footprintCandidate({
        bin: '1012345',
        baseBbl: '1010060001',
        mapplutoBbl: '1010067501',
      });

      expect(validateFootprintCandidate(candidate, '1010067501', 'condo')).toEqual({
        candidate,
        bin: '1012345',
      });
    });

    it('rejects a candidate when MAPPLUTO evidence is explicitly null for condo validation', () => {
      const candidate = footprintCandidate({
        bin: '1012345',
        baseBbl: '1010060001',
        mapplutoBbl: null,
      });

      expect(validateFootprintCandidate(candidate, '1010067501', 'condo')).toBe(
        'MAPPLUTO_BBL_MISMATCH',
      );
    });
  });

  describe('batch validation helpers', () => {
    it('collects accepted BINs and filters placeholder BINs', () => {
      const validation = validateFootprintCandidates(
        [
          footprintCandidate({ bin: '1012345', baseBbl: canonicalBbl, mapplutoBbl: canonicalBbl }),
          footprintCandidate({ bin: '3000000', baseBbl: canonicalBbl, mapplutoBbl: canonicalBbl }),
        ],
        canonicalBbl,
        'non-condo',
      );

      expect(collectValidatedBins(validation)).toEqual(['1012345']);
    });

    it('throws an explicit MAPPLUTO mismatch error when no candidates are accepted', () => {
      const validation = validateFootprintCandidates(
        [
          footprintCandidate({
            bin: '1088718',
            baseBbl: canonicalBbl,
            mapplutoBbl: '1008350042',
          }),
        ],
        canonicalBbl,
        'non-condo',
      );

      expect(() => assertFootprintIdentifierAgreement(validation, false)).toThrow(
        expect.objectContaining({
          code: 'RESOLVER_FOOTPRINT_MAPPLUTO_BBL_MISMATCH',
        }),
      );
    });

    it('throws an explicit BASE_BBL mismatch error when MAPPLUTO evidence is absent', () => {
      const validation = validateFootprintCandidates(
        [footprintCandidate({ bin: '1088718', baseBbl: '1008350042' })],
        canonicalBbl,
        'non-condo',
      );

      expect(() => assertFootprintIdentifierAgreement(validation, false)).toThrow(
        expect.objectContaining({
          code: 'RESOLVER_FOOTPRINT_BASE_BBL_MISMATCH',
        }),
      );
    });

    it('does not treat an empty footprint set as an identifier contradiction', () => {
      const validation = validateFootprintCandidates([], canonicalBbl, 'non-condo');

      expect(validation).toEqual({ accepted: [], rejected: [] });
      expect(() => assertFootprintIdentifierAgreement(validation, false)).not.toThrow();
    });
  });

  describe('GeoSearch BIN corroboration', () => {
    it('accepts a GeoSearch BIN that matches one validated footprint BIN', () => {
      expect(() =>
        assertGeoSearchBinCorroboratesFootprints('1012345', ['1012345', '1022334']),
      ).not.toThrow();
    });

    it('allows missing GeoSearch BIN evidence', () => {
      expect(() => assertGeoSearchBinCorroboratesFootprints(undefined, ['1012345'])).not.toThrow();
    });

    it('fails explicitly when GeoSearch BIN contradicts validated footprint BINs', () => {
      expect(() => assertGeoSearchBinCorroboratesFootprints('1099999', ['1012345'])).toThrow(AppError);
      expect(() => assertGeoSearchBinCorroboratesFootprints('1099999', ['1012345'])).toThrow(
        expect.objectContaining({
          code: 'RESOLVER_GEOSEARCH_BIN_CONFLICT',
        }),
      );
    });
  });
});
