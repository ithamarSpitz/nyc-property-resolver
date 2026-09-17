#!/usr/bin/env node
import path from 'node:path';

import {
  assertNoValidationErrors,
  validateEvidenceDirectory,
} from './lib/contract.mjs';

const evidenceArgument = process.argv[2];

if (!evidenceArgument || evidenceArgument.startsWith('-')) {
  console.error('Usage: npm run acceptance:small:validate -- <evidence-directory>');
  process.exitCode = 2;
} else {
  const evidenceDirectory = path.resolve(evidenceArgument);
  try {
    assertNoValidationErrors(
      validateEvidenceDirectory(evidenceDirectory),
      `small acceptance evidence validation (${evidenceDirectory})`,
    );
    console.log(`Small acceptance evidence is complete: ${evidenceDirectory}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
