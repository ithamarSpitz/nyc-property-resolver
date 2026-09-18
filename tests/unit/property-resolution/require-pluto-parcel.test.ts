import { AppError } from '../../../src/errors';
import { requirePlutoParcel } from '../../../src/services/property-resolver/require-pluto-parcel';

const canonicalBbl = '1008350041';

describe('requirePlutoParcel', () => {
  it('surfaces RESOLVER_PLUTO_NOT_FOUND when the source row is genuinely absent', () => {
    expect(() => requirePlutoParcel(canonicalBbl, { status: 'not_found' })).toThrow(
      expect.objectContaining({
        code: 'RESOLVER_PLUTO_NOT_FOUND',
        message: `PLUTO did not contain parcel ${canonicalBbl}`,
      }),
    );
    expect(() => requirePlutoParcel(canonicalBbl, undefined)).toThrow(AppError);
  });

  it('surfaces RESOLVER_PLUTO_INCOMPLETE with reason detail when a row exists but is unusable', () => {
    expect(() =>
      requirePlutoParcel(canonicalBbl, {
        status: 'incomplete',
        reasons: ['missing_address'],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'RESOLVER_PLUTO_INCOMPLETE',
        message: expect.stringContaining('missing_address'),
      }),
    );

    try {
      requirePlutoParcel(canonicalBbl, {
        status: 'incomplete',
        reasons: ['missing_address'],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).message).not.toContain('did not contain parcel');
    }
  });

  it('returns the parcel when PLUTO lookup is complete', () => {
    const parcel = {
      bbl: canonicalBbl,
      borough: 1,
      block: 835,
      lot: 41,
      address: '338 5 AVENUE',
      bldgclass: 'O4',
    };

    expect(requirePlutoParcel(canonicalBbl, { status: 'found', parcel })).toEqual(parcel);
  });
});
