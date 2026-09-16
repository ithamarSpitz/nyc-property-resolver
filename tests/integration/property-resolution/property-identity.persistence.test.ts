import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  PrismaClient,
  PropertyResolutionInputType,
} from '@prisma/client';

import { persistResolutionInput } from '../../../src/services/property-resolver/property-input.service';
import {
  PropertyIdentityService,
  createPropertyIdentityService,
} from '../../../src/services/property-resolver/property-identity.service';

describe('property identity persistence', () => {
  let prisma: PrismaClient;
  let identityService: PropertyIdentityService;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    identityService = createPropertyIdentityService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.propertyDatasetCoverage.deleteMany();
    await prisma.propertyResolutionInput.deleteMany();
    await prisma.propertyBin.deleteMany();
    await prisma.property.deleteMany();
  });

  it('reuses one property row for repeated canonical BBL persistence and reads valid BINs by id', async () => {
    const first = await identityService.findOrCreateProperty({
      bbl: '1008350041',
      candidateBins: ['1012345', '3000000'],
      normalizedAddress: '350 5th Avenue',
    });
    const second = await identityService.findOrCreateProperty({
      bbl: '1008350041',
      candidateBins: ['1099999'],
      normalizedAddress: '350 5th Avenue',
    });

    expect(second.id).toBe(first.id);

    const loaded = await identityService.findPropertyById(first.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.bbl).toBe('1008350041');
    expect(loaded?.bins.map((row) => row.bin)).toEqual(['1012345']);

    const coverage = identityService.getEcbCoverage(loaded!);
    expect(coverage).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
    });
  });

  it('initializes NO_VALID_BIN coverage when a property has zero valid BINs', async () => {
    const property = await identityService.findOrCreateProperty({
      bbl: '1000750001',
      candidateBins: ['3000000', 'invalid'],
    });

    expect(property.bins).toHaveLength(0);
    expect(property.identifierVersion).toBe(1);

    const coverage = identityService.getEcbCoverage(property);
    expect(coverage).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NO_VALID_BIN,
      lastAttemptRunId: null,
      lastAttemptAt: null,
    });
  });

  it('reuses one normalized input mapping for repeated persistence', async () => {
    const property = await identityService.findOrCreateProperty({
      bbl: '1012340001',
      candidateBins: ['1012345'],
    });

    const first = await persistResolutionInput(prisma, {
      inputType: PropertyResolutionInputType.BBL,
      normalizedInput: '1012340001',
      propertyId: property.id,
    });
    const second = await persistResolutionInput(prisma, {
      inputType: PropertyResolutionInputType.BBL,
      normalizedInput: '1012340001',
      propertyId: property.id,
    });

    expect(second.id).toBe(first.id);
    expect(second.propertyId).toBe(property.id);
  });

  it('does not change identifier version or coverage when only another input alias is added', async () => {
    const property = await identityService.findOrCreateProperty({
      bbl: '1000750001',
      candidateBins: ['1012345', '1022334'],
    });

    await persistResolutionInput(prisma, {
      inputType: PropertyResolutionInputType.ADDRESS,
      normalizedInput: '350 5th Avenue',
      propertyId: property.id,
    });

    const reloaded = await identityService.findPropertyById(property.id);
    expect(reloaded?.identifierVersion).toBe(1);
    expect(identityService.getEcbCoverage(reloaded!)).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
    });
  });

  it('is a no-op for identifier version and coverage when the effective BIN set is unchanged', async () => {
    const property = await identityService.findOrCreateProperty({
      bbl: '1000750001',
      candidateBins: ['1012345', '3000000', '1022334'],
    });

    const result = await identityService.applyEffectiveBinSet(property.id, [
      '1022334',
      '1012345',
      '3000000',
    ]);

    expect(result.changed).toBe(false);
    expect(result.property.identifierVersion).toBe(1);
    expect(result.property.bins.map((row) => row.bin)).toEqual(['1012345', '1022334']);
    expect(identityService.getEcbCoverage(result.property)).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
    });
  });

  it('updates bins, increments identifier_version once, and invalidates coverage atomically', async () => {
    const property = await identityService.findOrCreateProperty({
      bbl: '1000750001',
      candidateBins: ['1012345'],
    });

    const result = await identityService.applyEffectiveBinSet(property.id, ['1012345', '1022334']);

    expect(result.changed).toBe(true);
    expect(result.property.identifierVersion).toBe(2);
    expect(result.property.bins.map((row) => row.bin)).toEqual(['1012345', '1022334']);

    const coverage = await prisma.propertyDatasetCoverage.findUnique({
      where: {
        propertyId_dataset: {
          propertyId: property.id,
          dataset: Dataset.DOB_ECB_VIOLATIONS,
        },
      },
    });

    expect(coverage).toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED,
    });
  });

  it('enforces uniqueness for property BBL and property BIN relationships', async () => {
    const first = await identityService.findOrCreateProperty({
      bbl: '1000750001',
      candidateBins: ['1012345'],
    });
    const second = await identityService.findOrCreateProperty({
      bbl: '1000750002',
      candidateBins: ['1012345'],
    });

    await expect(
      prisma.property.create({
        data: {
          bbl: '1000750001',
          borough: 1,
          block: 75,
          lot: 1,
          resolvedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.propertyBin.create({
        data: {
          propertyId: second.id,
          bin: '1012345',
        },
      }),
    ).rejects.toThrow();

    expect(first.id).not.toBe(second.id);
  });
});
