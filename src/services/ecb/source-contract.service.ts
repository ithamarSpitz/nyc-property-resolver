import {
  ECB_SOURCE_ID_FIELD,
  DOB_ECB_SOURCE_CONTRACT_QUERY,
  SOCRATA_ROW_ID_FIELD,
  SOURCE_ROW_UPDATED_AT_FIELD,
  parseSourceContractStats,
  type SourceContractDuplicateGroup,
  type SourceContractStats,
} from '../../schemas/ecb-ingestion.schema';

/** Minimal port: the source client owns query/transport details. */
export interface EcbSourceContractReader {
  getSourceContractStats(): Promise<SourceContractStats>;
}

export type SourceContractReader = EcbSourceContractReader;

export type SourceContractVerification = {
  sourceIdField: typeof ECB_SOURCE_ID_FIELD;
  socrataRowIdField: typeof SOCRATA_ROW_ID_FIELD;
  sourceRowUpdatedAtField: typeof SOURCE_ROW_UPDATED_AT_FIELD;
  totalRowCount: number;
  distinctSourceIdCount: number;
  nullSourceIdCount: number;
  duplicateGroups: readonly SourceContractDuplicateGroup[];
  valid: boolean;
};

function buildVerification(stats: SourceContractStats): SourceContractVerification {
  const parsed = parseSourceContractStats(stats);
  const duplicateGroups = parsed.duplicateGroups.filter((group) => group.count > 1);

  return {
    sourceIdField: ECB_SOURCE_ID_FIELD,
    socrataRowIdField: SOCRATA_ROW_ID_FIELD,
    sourceRowUpdatedAtField: SOURCE_ROW_UPDATED_AT_FIELD,
    totalRowCount: parsed.totalRows,
    distinctSourceIdCount: parsed.distinctSourceIds,
    nullSourceIdCount: parsed.nullSourceIds,
    duplicateGroups,
    valid:
      parsed.nullSourceIds === 0 &&
      duplicateGroups.length === 0 &&
      parsed.totalRows === parsed.distinctSourceIds,
  };
}

export class EcbSourceContractService {
  constructor(private readonly reader: EcbSourceContractReader) {}

  async verify(): Promise<SourceContractVerification> {
    return buildVerification(await this.reader.getSourceContractStats());
  }

  get queryDefinition(): typeof DOB_ECB_SOURCE_CONTRACT_QUERY {
    return DOB_ECB_SOURCE_CONTRACT_QUERY;
  }
}

export async function verifyEcbSourceContract(
  reader: EcbSourceContractReader,
): Promise<SourceContractVerification> {
  return new EcbSourceContractService(reader).verify();
}

export const verifyDobEcbSourceContract = verifyEcbSourceContract;

export function createEcbSourceContractService(
  reader: EcbSourceContractReader,
): EcbSourceContractService {
  return new EcbSourceContractService(reader);
}
