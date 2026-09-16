/** Mirrors the `6bgk-3dad` Socrata JSON shape with lowercase API field names. */
export function ecbSocrataRow(
  sourceId: string,
  bin = '1012345',
  updatedAt = '2026-01-02T03:04:05.000Z',
) {
  return {
    isn_dob_bis_extract: sourceId,
    ':id': `socrata-${sourceId}`,
    ':updated_at': updatedAt,
    bin,
    ecb_violation_number: `ECB-${sourceId}`,
    issue_date: '20260203',
    ecb_violation_status: 'ACTIVE',
    balance_due: '-125.50',
  };
}
