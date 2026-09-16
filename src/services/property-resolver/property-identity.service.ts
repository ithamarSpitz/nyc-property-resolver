import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  Prisma,
  PrismaClient,
  Property,
  PropertyBin,
  PropertyDatasetCoverage,
} from '@prisma/client';

import { AppError } from '../../errors';
import {
  CanonicalBin,
  assertValidBbl,
  filterValidBins,
  parseBblComponents,
} from '../../schemas/property-identifiers.schema';

export type PropertyWithRelations = Property & {
  bins: PropertyBin[];
  datasetCoverage: PropertyDatasetCoverage[];
};

export type CreatePropertyInput = {
  bbl: string;
  candidateBins: readonly string[];
  normalizedAddress?: string | null;
  condoBaseBbl?: string | null;
  condoBillingBbl?: string | null;
  borough?: number;
  block?: number;
  lot?: number;
  resolvedAt?: Date;
};

export type ApplyEffectiveBinSetResult = {
  property: PropertyWithRelations;
  changed: boolean;
  previousBins: CanonicalBin[];
  nextBins: CanonicalBin[];
};

type PrismaExecutor = PrismaClient | Prisma.TransactionClient;

function sortBins(bins: readonly string[]): CanonicalBin[] {
  return [...bins].sort();
}

function binsAreEqual(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = sortBins(left);
  const rightSorted = sortBins(right);

  if (leftSorted.length !== rightSorted.length) {
    return false;
  }

  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function toPropertyWithRelations(
  property: Property & {
    bins: PropertyBin[];
    datasetCoverage: PropertyDatasetCoverage[];
  },
): PropertyWithRelations {
  return {
    ...property,
    bins: sortBins(property.bins.map((row) => row.bin)).map((bin) => ({
      propertyId: property.id,
      bin,
    })),
  };
}

async function loadPropertyWithRelations(
  prisma: PrismaExecutor,
  propertyId: string,
): Promise<PropertyWithRelations | null> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      bins: true,
      datasetCoverage: true,
    },
  });

  if (property === null) {
    return null;
  }

  return toPropertyWithRelations(property);
}

function buildInitialCoverage(validBins: readonly CanonicalBin[]): {
  status: CoverageStatus;
  statusReason: CoverageStatusReason;
  lastAttemptRunId: string | null;
  lastAttemptAt: Date | null;
} {
  if (validBins.length > 0) {
    return {
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
      lastAttemptRunId: null,
      lastAttemptAt: null,
    };
  }

  return {
    status: CoverageStatus.NOT_CHECKED,
    statusReason: CoverageStatusReason.NO_VALID_BIN,
    lastAttemptRunId: null,
    lastAttemptAt: null,
  };
}

function buildCoverageAfterBinSetChange(nextBins: readonly CanonicalBin[]): {
  status: CoverageStatus;
  statusReason: CoverageStatusReason;
  lastAttemptRunId: string | null;
  lastAttemptAt: Date | null;
} {
  if (nextBins.length === 0) {
    return {
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NO_VALID_BIN,
      lastAttemptRunId: null,
      lastAttemptAt: null,
    };
  }

  return {
    status: CoverageStatus.NOT_CHECKED,
    statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED,
    lastAttemptRunId: null,
    lastAttemptAt: null,
  };
}

async function lockPropertyRow(
  tx: Prisma.TransactionClient,
  propertyId: string,
): Promise<void> {
  const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM properties
    WHERE id = ${propertyId}::uuid
    FOR UPDATE
  `;

  if (lockedRows.length === 0) {
    throw new AppError({
      code: 'PROPERTY_NOT_FOUND',
      message: `Property ${propertyId} was not found`,
      statusCode: 404,
    });
  }
}

async function replacePropertyBins(
  tx: Prisma.TransactionClient,
  propertyId: string,
  nextBins: readonly CanonicalBin[],
): Promise<void> {
  await tx.propertyBin.deleteMany({
    where: { propertyId },
  });

  if (nextBins.length > 0) {
    await tx.propertyBin.createMany({
      data: nextBins.map((bin) => ({
        propertyId,
        bin,
      })),
    });
  }
}

export class PropertyIdentityService {
  constructor(private readonly prisma: PrismaClient) {}

  async findPropertyById(propertyId: string): Promise<PropertyWithRelations | null> {
    return loadPropertyWithRelations(this.prisma, propertyId);
  }

  async findPropertyByBbl(bbl: string): Promise<PropertyWithRelations | null> {
    const canonicalBbl = assertValidBbl(bbl);
    const property = await this.prisma.property.findUnique({
      where: { bbl: canonicalBbl },
      include: {
        bins: true,
        datasetCoverage: true,
      },
    });

    if (property === null) {
      return null;
    }

    return toPropertyWithRelations(property);
  }

  async findOrCreateProperty(input: CreatePropertyInput): Promise<PropertyWithRelations> {
    const canonicalBbl = assertValidBbl(input.bbl);
    const existing = await this.findPropertyByBbl(canonicalBbl);

    if (existing !== null) {
      return existing;
    }

    const parsed = parseBblComponents(canonicalBbl);
    const validBins = filterValidBins(input.candidateBins);
    const resolvedAt = input.resolvedAt ?? new Date();
    const initialCoverage = buildInitialCoverage(validBins);

    const created = await this.prisma.$transaction(async (tx) => {
      const property = await tx.property.create({
        data: {
          bbl: canonicalBbl,
          condoBaseBbl: input.condoBaseBbl ? assertValidBbl(input.condoBaseBbl) : null,
          condoBillingBbl: input.condoBillingBbl ? assertValidBbl(input.condoBillingBbl) : null,
          normalizedAddress: input.normalizedAddress ?? null,
          borough: input.borough ?? parsed.borough,
          block: input.block ?? parsed.block,
          lot: input.lot ?? parsed.lot,
          resolvedAt,
          bins: {
            create: validBins.map((bin) => ({ bin })),
          },
          datasetCoverage: {
            create: {
              dataset: Dataset.DOB_ECB_VIOLATIONS,
              status: initialCoverage.status,
              statusReason: initialCoverage.statusReason,
              lastAttemptRunId: initialCoverage.lastAttemptRunId,
              lastAttemptAt: initialCoverage.lastAttemptAt,
            },
          },
        },
        include: {
          bins: true,
          datasetCoverage: true,
        },
      });

      return toPropertyWithRelations(property);
    });

    return created;
  }

  async applyEffectiveBinSet(
    propertyId: string,
    candidateBins: readonly string[],
  ): Promise<ApplyEffectiveBinSetResult> {
    const nextBins = filterValidBins(candidateBins);

    return this.prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, propertyId);

      const property = await tx.property.findUnique({
        where: { id: propertyId },
        include: {
          bins: true,
          datasetCoverage: true,
        },
      });

      if (property === null) {
        throw new AppError({
          code: 'PROPERTY_NOT_FOUND',
          message: `Property ${propertyId} was not found`,
          statusCode: 404,
        });
      }

      const currentBins = sortBins(property.bins.map((row) => row.bin));

      if (binsAreEqual(currentBins, nextBins)) {
        return {
          property: toPropertyWithRelations(property),
          changed: false,
          previousBins: currentBins,
          nextBins,
        };
      }

      await replacePropertyBins(tx, propertyId, nextBins);

      await tx.property.update({
        where: { id: propertyId },
        data: {
          identifierVersion: {
            increment: 1,
          },
        },
      });

      const coverageUpdate = buildCoverageAfterBinSetChange(nextBins);

      await tx.propertyDatasetCoverage.upsert({
        where: {
          propertyId_dataset: {
            propertyId,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
        create: {
          propertyId,
          dataset: Dataset.DOB_ECB_VIOLATIONS,
          status: coverageUpdate.status,
          statusReason: coverageUpdate.statusReason,
          lastAttemptRunId: coverageUpdate.lastAttemptRunId,
          lastAttemptAt: coverageUpdate.lastAttemptAt,
        },
        update: {
          status: coverageUpdate.status,
          statusReason: coverageUpdate.statusReason,
          lastAttemptRunId: coverageUpdate.lastAttemptRunId,
          lastAttemptAt: coverageUpdate.lastAttemptAt,
        },
      });

      const refreshed = await tx.property.findUnique({
        where: { id: propertyId },
        include: {
          bins: true,
          datasetCoverage: true,
        },
      });

      if (refreshed === null) {
        throw new AppError({
          code: 'PROPERTY_NOT_FOUND',
          message: `Property ${propertyId} was not found after BIN update`,
          statusCode: 500,
        });
      }

      return {
        property: toPropertyWithRelations(refreshed),
        changed: true,
        previousBins: currentBins,
        nextBins,
      };
    });
  }

  getEcbCoverage(property: PropertyWithRelations): PropertyDatasetCoverage | undefined {
    return property.datasetCoverage.find(
      (coverage) => coverage.dataset === Dataset.DOB_ECB_VIOLATIONS,
    );
  }
}

export function createPropertyIdentityService(prisma: PrismaClient): PropertyIdentityService {
  return new PropertyIdentityService(prisma);
}
