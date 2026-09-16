import {
  ECB_SOURCE_ID_FIELD,
  SOCRATA_ROW_ID_FIELD,
  SOURCE_ROW_UPDATED_AT_FIELD,
} from '../../../src/schemas/ecb-ingestion.schema';
import {
  EcbSourceContractService,
  verifyEcbSourceContract,
} from '../../../src/services/ecb/source-contract.service';

describe('DOB ECB source contract', () => {
  function reader(stats: {
    totalRows: number;
    distinctSourceIds: number;
    nullSourceIds: number;
    duplicateGroups: Array<{ sourceId: string | null; count: number }>;
  }) {
    return { getSourceContractStats: jest.fn().mockResolvedValue(stats) };
  }

  it('accepts a source id only when it is non-null and unique', async () => {
    const result = await verifyEcbSourceContract(
      reader({
        totalRows: 2,
        distinctSourceIds: 2,
        nullSourceIds: 0,
        duplicateGroups: [],
      }),
    );

    expect(result).toMatchObject({
      sourceIdField: ECB_SOURCE_ID_FIELD,
      socrataRowIdField: SOCRATA_ROW_ID_FIELD,
      sourceRowUpdatedAtField: SOURCE_ROW_UPDATED_AT_FIELD,
      totalRowCount: 2,
      distinctSourceIdCount: 2,
      nullSourceIdCount: 0,
      valid: true,
    });
  });

  it('reports NULL and duplicate-key violations without changing the proposed identity', async () => {
    const service = new EcbSourceContractService(
      reader({
        totalRows: 3,
        distinctSourceIds: 2,
        nullSourceIds: 1,
        duplicateGroups: [{ sourceId: 'ECB-1', count: 2 }],
      }),
    );

    const result = await service.verify();

    expect(result.valid).toBe(false);
    expect(result.nullSourceIdCount).toBe(1);
    expect(result.duplicateGroups).toEqual([{ sourceId: 'ECB-1', count: 2 }]);
    expect(result.sourceIdField).toBe('ISN_DOB_BIS_EXTRACT');
    expect(result.sourceIdField).not.toBe('ECB_VIOLATION_NUMBER');
  });

  it('uses a small reader port instead of a concrete Socrata client', async () => {
    const getSourceContractStats = jest.fn().mockResolvedValue({
      totalRows: 0,
      distinctSourceIds: 0,
      nullSourceIds: 0,
      duplicateGroups: [],
    });

    await new EcbSourceContractService({ getSourceContractStats }).verify();

    expect(getSourceContractStats).toHaveBeenCalledTimes(1);
  });
});
