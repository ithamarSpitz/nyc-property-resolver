import { ZodError } from 'zod';

import { extractEcbSourceIdentity } from '../../../src/schemas/ecb.schema';
import {
  normalizeEcbViolation,
} from '../../../src/services/ecb/normalization.service';

/**
 * Socrata JSON responses key rows by the dataset's lowercase API field names,
 * so fixtures mirror the `6bgk-3dad` transport shape rather than display labels.
 */
function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    isn_dob_bis_extract: 'ECB-1001',
    ':id': 'socrata-1001',
    ':updated_at': '2026-01-02T03:04:05.000Z',
    bin: ' 1012345 ',
    ecb_violation_number: ' ECB-42 ',
    issue_date: '20260203',
    ecb_violation_status: '  ACTIVE ',
    balance_due: '-125.50',
    unrelated_source_field: 'retained only in raw payload',
    ...overrides,
  };
}

describe('ECB normalization', () => {
  it('extracts only the minimal source identity before domain normalization', () => {
    expect(extractEcbSourceIdentity(sourceRow())).toEqual({
      sourceId: 'ECB-1001',
      socrataRowId: 'socrata-1001',
      sourceRowUpdatedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('normalizes dates, BIN, text fields, and preserves a negative balance', () => {
    const normalized = normalizeEcbViolation(sourceRow());

    expect(normalized).toMatchObject({
      sourceId: 'ECB-1001',
      socrataRowId: 'socrata-1001',
      bin: '1012345',
      violationNumber: 'ECB-42',
      ecbViolationStatus: 'ACTIVE',
      balanceDue: -125.5,
    });
    expect(normalized.issueDate).toEqual(new Date('2026-02-03T00:00:00.000Z'));
    expect(normalized.sourceRowUpdatedAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
  });

  it('accepts nullable source fields as null and trims numeric formatting', () => {
    expect(
      normalizeEcbViolation(
        sourceRow({
          ecb_violation_number: null,
          issue_date: '',
          ecb_violation_status: null,
          balance_due: '1,250.00',
        }),
      ),
    ).toMatchObject({
      violationNumber: null,
      issueDate: null,
      ecbViolationStatus: null,
      balanceDue: 1250,
    });
  });

  it('resolves source fields case-insensitively for display-label spellings', () => {
    const displayLabelRow = {
      ISN_DOB_BIS_EXTRACT: 'ECB-1001',
      ':id': 'socrata-1001',
      ':updated_at': '2026-01-02T03:04:05.000Z',
      BIN: '1012345',
      ECB_VIOLATION_NUMBER: 'ECB-42',
      ISSUE_DATE: '20260203',
      ECB_VIOLATION_STATUS: 'ACTIVE',
      BALANCE_DUE: '-125.50',
    };

    expect(normalizeEcbViolation(displayLabelRow)).toEqual(
      normalizeEcbViolation(sourceRow()),
    );
  });

  it('rejects missing required domain fields', () => {
    expect(() => normalizeEcbViolation(sourceRow({ bin: undefined }))).toThrow(ZodError);
    expect(() => normalizeEcbViolation(sourceRow({ ':id': undefined }))).toThrow(ZodError);
    expect(() =>
      normalizeEcbViolation(sourceRow({ isn_dob_bis_extract: undefined })),
    ).toThrow(ZodError);
  });

  it('rejects invalid dates, BINs, and balances explicitly', () => {
    expect(() => normalizeEcbViolation(sourceRow({ issue_date: 'not-a-date' }))).toThrow(ZodError);
    expect(() => normalizeEcbViolation(sourceRow({ issue_date: '2026-02-30' }))).toThrow(ZodError);
    expect(() => normalizeEcbViolation(sourceRow({ issue_date: '02/30/2026' }))).toThrow(ZodError);
    expect(() => normalizeEcbViolation(sourceRow({ issue_date: '2026/02/30' }))).toThrow(ZodError);
    expect(() => normalizeEcbViolation(sourceRow({ issue_date: '20260230' }))).toThrow(ZodError);
    expect(() =>
      normalizeEcbViolation(sourceRow({ ':updated_at': '2026-02-30T03:04:05.000Z' })),
    ).toThrow(ZodError);
    expect(() =>
      normalizeEcbViolation(sourceRow({ ':updated_at': '2026/02/30' })),
    ).toThrow(ZodError);
    expect(() => normalizeEcbViolation(sourceRow({ bin: 'not-a-bin' }))).toThrow(ZodError);
    expect(() => normalizeEcbViolation(sourceRow({ balance_due: 'not-a-number' }))).toThrow(
      ZodError,
    );
  });
});
