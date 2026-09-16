import { SocrataClient } from '../clients/socrata.client';
import { DOB_ECB_SOURCE_CONTRACT_QUERY } from '../schemas/ecb-ingestion.schema';
import {
  EcbSourceContractService,
  type SourceContractVerification,
} from '../services/ecb/source-contract.service';

function formatVerification(result: SourceContractVerification): string {
  return JSON.stringify(
    {
      query: DOB_ECB_SOURCE_CONTRACT_QUERY,
      sourceIdField: result.sourceIdField,
      socrataRowIdField: result.socrataRowIdField,
      sourceRowUpdatedAtField: result.sourceRowUpdatedAtField,
      totalRowCount: result.totalRowCount,
      distinctSourceIdCount: result.distinctSourceIdCount,
      nullSourceIdCount: result.nullSourceIdCount,
      duplicateGroups: result.duplicateGroups,
      valid: result.valid,
    },
    null,
    2,
  );
}

async function main(): Promise<void> {
  const client = new SocrataClient({
    socrataAppToken: process.env.SOCRATA_APP_TOKEN,
  });
  const service = new EcbSourceContractService(client);
  const result = await service.verify();

  console.log(formatVerification(result));

  if (!result.valid) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ECB source-contract verification failed: ${message}`);
  process.exitCode = 1;
});
