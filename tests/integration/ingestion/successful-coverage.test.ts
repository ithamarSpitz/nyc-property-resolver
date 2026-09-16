import {
  CoverageStatus,
  CoverageStatusReason,
  Dataset,
  IngestionBatchStatus,
  IngestionRunStatus,
  IngestionTriggerType,
  PrismaClient,
} from "@prisma/client";

import {
  publishSuccessfulCoverage,
  SuccessfulCoveragePublicationError,
} from "../../../src/services/ecb/successful-coverage.service";
import { createPropertyIdentityService } from "../../../src/services/property-resolver/property-identity.service";

const describeIntegration = process.env.DATABASE_URL ? describe : describe.skip;

const STARTED_AT = new Date("2026-09-16T10:00:00.000Z");
const LATER_STARTED_AT = new Date("2026-09-16T10:30:00.000Z");
const ACCEPTED_AT = new Date("2026-09-16T10:05:00.000Z");
const WATERMARK = new Date("2026-09-16T09:55:00.000Z");
// Run ids are random in production, so the ordering tests pin ids that would
// invert the outcome if run-id ordering were ever used as a chronology signal.
const LOWER_RUN_ID = "00000000-0000-4000-8000-000000000001";
const HIGHER_RUN_ID = "00000000-0000-4000-8000-000000000002";

describeIntegration("successful ECB coverage publication", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ecb_violations", "ecb_violation_staging", "ecb_violation_raw", "ingestion_batches", "ingestion_run_property_bins", "ingestion_runs", "property_dataset_coverage", "property_bins", "property_resolution_inputs", "properties" CASCADE',
    );
  });

  async function seedProperty(
    bbl: string,
    bins: readonly string[],
    statusReason: CoverageStatusReason = CoverageStatusReason.NEVER_INGESTED,
  ) {
    return prisma.property.create({
      data: {
        bbl,
        borough: 1,
        block: Number.parseInt(bbl.slice(1, 6), 10),
        lot: Number.parseInt(bbl.slice(6), 10),
        resolvedAt: new Date("2026-01-01T00:00:00.000Z"),
        bins: { create: bins.map((bin) => ({ bin })) },
        datasetCoverage: {
          create: {
            dataset: Dataset.DOB_ECB_VIOLATIONS,
            status: CoverageStatus.NOT_CHECKED,
            statusReason,
          },
        },
      },
    });
  }

  async function seedAcceptedRun(
    snapshots: Array<{
      propertyId: string;
      propertyIdentifierVersion: number;
      bins: string[];
    }>,
    runId?: string,
  ) {
    const distinctBins = [
      ...new Set(snapshots.flatMap((snapshot) => snapshot.bins)),
    ].sort();
    const queuedRun = await prisma.ingestionRun.create({
      data: {
        id: runId,
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.QUEUED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });

    if (snapshots.length > 0) {
      await prisma.ingestionRunPropertyBin.createMany({
        data: snapshots.flatMap((snapshot) =>
          snapshot.bins.map((bin) => ({
            runId: queuedRun.id,
            propertyId: snapshot.propertyId,
            propertyIdentifierVersion: snapshot.propertyIdentifierVersion,
            bin,
          })),
        ),
      });
    }
    if (distinctBins.length > 0) {
      await prisma.ingestionBatch.create({
        data: {
          runId: queuedRun.id,
          batchNumber: 1,
          status: IngestionBatchStatus.COMPLETED,
          batchDefinition: { bins: distinctBins, pageSize: 50_000 },
          completedAt: ACCEPTED_AT,
        },
      });
    }

    return prisma.ingestionRun.update({
      where: { id: queuedRun.id },
      data: {
        status: IngestionRunStatus.RUNNING,
        initializationComplete: true,
        expectedPropertyBinCount: snapshots.reduce(
          (total, snapshot) => total + snapshot.bins.length,
          0,
        ),
        expectedBinCount: distinctBins.length,
        expectedBatchCount: distinctBins.length === 0 ? 0 : 1,
        startedAt: STARTED_AT,
        sourceWatermarkAtStart: WATERMARK,
        sourceWatermarkAtEnd: WATERMARK,
      },
    });
  }

  it("publishes one checked property scope with attempt, success, and dataset watermark metadata", async () => {
    const property = await seedProperty("1000010001", ["1000001", "1000002"]);
    const run = await seedAcceptedRun([
      {
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bins: ["1000001", "1000002"],
      },
    ]);

    const result = await prisma.$transaction((tx) =>
      publishSuccessfulCoverage(tx, run, ACCEPTED_AT),
    );

    expect(result).toEqual({ checkedCount: 1, identifiersChangedCount: 0 });
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.CHECKED,
      statusReason: null,
      lastAttemptRunId: run.id,
      lastSuccessRunId: run.id,
      lastAttemptAt: ACCEPTED_AT,
      lastSuccessAt: ACCEPTED_AT,
      sourceWatermarkAt: WATERMARK,
      lastError: null,
    });
  });

  it("uses the immutable snapshot and does not add a live BIN to the old run requirements", async () => {
    const property = await seedProperty("1000010002", ["1000010"]);
    const run = await seedAcceptedRun([
      {
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bins: ["1000010"],
      },
    ]);

    const identityService = createPropertyIdentityService(prisma);
    await identityService.applyEffectiveBinSet(property.id, [
      "1000010",
      "1000011",
    ]);

    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, run, ACCEPTED_AT),
      ),
    ).resolves.toEqual({ checkedCount: 0, identifiersChangedCount: 1 });
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED_AFTER_SNAPSHOT,
      lastSuccessRunId: null,
    });
  });

  it("marks a changed identifier state not checked without replacing prior success knowledge", async () => {
    const property = await seedProperty("1000010003", ["1000020"]);
    const previousRun = await prisma.ingestionRun.create({
      data: {
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
      },
    });
    const previousSuccessAt = new Date("2026-09-15T10:00:00.000Z");
    await prisma.propertyDatasetCoverage.update({
      where: {
        propertyId_dataset: {
          propertyId: property.id,
          dataset: Dataset.DOB_ECB_VIOLATIONS,
        },
      },
      data: {
        status: CoverageStatus.CHECKED,
        statusReason: null,
        lastAttemptRunId: previousRun.id,
        lastSuccessRunId: previousRun.id,
        lastAttemptAt: previousSuccessAt,
        lastSuccessAt: previousSuccessAt,
        sourceWatermarkAt: previousSuccessAt,
      },
    });
    const run = await seedAcceptedRun([
      {
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bins: ["1000020"],
      },
    ]);
    const identityService = createPropertyIdentityService(prisma);
    await identityService.applyEffectiveBinSet(property.id, [
      "1000020",
      "1000021",
    ]);

    const result = await prisma.$transaction((tx) =>
      publishSuccessfulCoverage(tx, run, ACCEPTED_AT),
    );

    expect(result).toEqual({ checkedCount: 0, identifiersChangedCount: 1 });
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED_AFTER_SNAPSHOT,
      lastAttemptRunId: null,
      lastSuccessRunId: previousRun.id,
      lastAttemptAt: null,
      lastSuccessAt: previousSuccessAt,
      sourceWatermarkAt: previousSuccessAt,
    });
  });

  it("does not overwrite coverage published by a run that started later", async () => {
    const property = await seedProperty("1000010004", ["1000030"]);
    const staleRun = await seedAcceptedRun(
      [
        {
          propertyId: property.id,
          propertyIdentifierVersion: property.identifierVersion,
          bins: ["1000030"],
        },
      ],
      HIGHER_RUN_ID,
    );
    const newerRun = await prisma.ingestionRun.create({
      data: {
        id: LOWER_RUN_ID,
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
        startedAt: LATER_STARTED_AT,
      },
    });
    await prisma.propertyDatasetCoverage.update({
      where: {
        propertyId_dataset: {
          propertyId: property.id,
          dataset: Dataset.DOB_ECB_VIOLATIONS,
        },
      },
      data: {
        status: CoverageStatus.FAILED,
        statusReason: null,
        lastAttemptRunId: newerRun.id,
        lastAttemptAt: ACCEPTED_AT,
        lastError: "NEWER_ATTEMPT",
      },
    });

    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, staleRun, ACCEPTED_AT),
      ),
    ).resolves.toEqual({ checkedCount: 0, identifiersChangedCount: 0 });
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.FAILED,
      lastAttemptRunId: newerRun.id,
      lastError: "NEWER_ATTEMPT",
    });
  });

  it("publishes success when no prior coverage run started later, whatever the run ids are", async () => {
    const property = await seedProperty("1000010010", ["1000031"]);
    const priorRun = await prisma.ingestionRun.create({
      data: {
        id: HIGHER_RUN_ID,
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
        startedAt: STARTED_AT,
      },
    });
    await prisma.propertyDatasetCoverage.update({
      where: {
        propertyId_dataset: {
          propertyId: property.id,
          dataset: Dataset.DOB_ECB_VIOLATIONS,
        },
      },
      data: {
        status: CoverageStatus.FAILED,
        statusReason: null,
        lastAttemptRunId: priorRun.id,
        lastAttemptAt: ACCEPTED_AT,
        lastError: "PRIOR_ATTEMPT",
      },
    });
    const acceptedRun = await seedAcceptedRun(
      [
        {
          propertyId: property.id,
          propertyIdentifierVersion: property.identifierVersion,
          bins: ["1000031"],
        },
      ],
      LOWER_RUN_ID,
    );

    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, acceptedRun, ACCEPTED_AT),
      ),
    ).resolves.toEqual({ checkedCount: 1, identifiersChangedCount: 0 });
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.CHECKED,
      lastAttemptRunId: acceptedRun.id,
      lastSuccessRunId: acceptedRun.id,
      lastError: null,
    });
  });

  it("publishes the identifier-change reason when no prior coverage run started later, whatever the run ids are", async () => {
    const property = await seedProperty("1000010011", ["1000032"]);
    const priorRun = await prisma.ingestionRun.create({
      data: {
        id: HIGHER_RUN_ID,
        dataset: Dataset.DOB_ECB_VIOLATIONS,
        status: IngestionRunStatus.FAILED,
        triggerType: IngestionTriggerType.MANUAL,
        startedAt: STARTED_AT,
      },
    });
    const acceptedRun = await seedAcceptedRun(
      [
        {
          propertyId: property.id,
          propertyIdentifierVersion: property.identifierVersion,
          bins: ["1000032"],
        },
      ],
      LOWER_RUN_ID,
    );
    const identityService = createPropertyIdentityService(prisma);
    await identityService.applyEffectiveBinSet(property.id, [
      "1000032",
      "1000033",
    ]);
    await prisma.propertyDatasetCoverage.update({
      where: {
        propertyId_dataset: {
          propertyId: property.id,
          dataset: Dataset.DOB_ECB_VIOLATIONS,
        },
      },
      data: {
        status: CoverageStatus.FAILED,
        statusReason: null,
        lastAttemptRunId: priorRun.id,
        lastAttemptAt: ACCEPTED_AT,
        lastError: "PRIOR_ATTEMPT",
      },
    });

    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, acceptedRun, ACCEPTED_AT),
      ),
    ).resolves.toEqual({ checkedCount: 0, identifiersChangedCount: 1 });
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED_AFTER_SNAPSHOT,
      lastAttemptRunId: priorRun.id,
      lastSuccessRunId: null,
    });
  });

  it("refuses to replay a completed run over coverage invalidated after its snapshot", async () => {
    const property = await seedProperty("1000010012", ["1000080"]);
    const run = await seedAcceptedRun([
      {
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bins: ["1000080"],
      },
    ]);

    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, run, ACCEPTED_AT),
      ),
    ).resolves.toEqual({ checkedCount: 1, identifiersChangedCount: 0 });
    const completedRun = await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: IngestionRunStatus.COMPLETED,
        finishedAt: ACCEPTED_AT,
      },
    });

    const identityService = createPropertyIdentityService(prisma);
    await identityService.applyEffectiveBinSet(property.id, [
      "1000080",
      "1000081",
    ]);

    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, completedRun, ACCEPTED_AT),
      ),
    ).rejects.toBeInstanceOf(SuccessfulCoveragePublicationError);
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED,
      lastAttemptRunId: null,
      lastSuccessRunId: run.id,
    });
  });

  it("does not rewrite its own published success into a stale identifier-change reason", async () => {
    const property = await seedProperty("1000010013", ["1000090"]);
    const run = await seedAcceptedRun([
      {
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bins: ["1000090"],
      },
    ]);

    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, run, ACCEPTED_AT),
      ),
    ).resolves.toEqual({ checkedCount: 1, identifiersChangedCount: 0 });

    const identityService = createPropertyIdentityService(prisma);
    await identityService.applyEffectiveBinSet(property.id, [
      "1000090",
      "1000091",
    ]);

    // The run is still RUNNING here, so only the row-level stale guard can
    // protect the invalidation written by the BIN-set mutation boundary.
    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, run, ACCEPTED_AT),
      ),
    ).resolves.toEqual({ checkedCount: 0, identifiersChangedCount: 0 });
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.IDENTIFIERS_CHANGED,
      lastAttemptRunId: null,
      lastSuccessRunId: run.id,
      lastSuccessAt: ACCEPTED_AT,
      sourceWatermarkAt: WATERMARK,
    });
  });

  it("leaves a zero-valid-BIN property untouched", async () => {
    const zeroBinProperty = await seedProperty(
      "1000010005",
      [],
      CoverageStatusReason.NO_VALID_BIN,
    );
    const trackedProperty = await seedProperty("1000010006", ["1000040"]);
    const run = await seedAcceptedRun([
      {
        propertyId: trackedProperty.id,
        propertyIdentifierVersion: trackedProperty.identifierVersion,
        bins: ["1000040"],
      },
    ]);

    await prisma.$transaction((tx) =>
      publishSuccessfulCoverage(tx, run, ACCEPTED_AT),
    );

    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: zeroBinProperty.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NO_VALID_BIN,
      lastAttemptRunId: null,
      lastSuccessRunId: null,
    });
  });

  it("rejects incomplete batch scope and rolls back all coverage changes", async () => {
    const property = await seedProperty("1000010007", ["1000050"]);
    const run = await seedAcceptedRun([
      {
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bins: ["1000050"],
      },
    ]);
    await prisma.ingestionBatch.update({
      where: { runId_batchNumber: { runId: run.id, batchNumber: 1 } },
      data: { status: IngestionBatchStatus.PENDING },
    });

    await expect(
      prisma.$transaction((tx) =>
        publishSuccessfulCoverage(tx, run, ACCEPTED_AT),
      ),
    ).rejects.toBeInstanceOf(SuccessfulCoveragePublicationError);
    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: CoverageStatus.NOT_CHECKED,
      statusReason: CoverageStatusReason.NEVER_INGESTED,
    });
  });

  it("uses only the caller transaction", async () => {
    const property = await seedProperty("1000010008", ["1000060"]);
    const run = await seedAcceptedRun([
      {
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bins: ["1000060"],
      },
    ]);
    const rollback = new Error("ROLLBACK_SUCCESS_COVERAGE");

    await expect(
      prisma.$transaction(async (tx) => {
        await publishSuccessfulCoverage(tx, run, ACCEPTED_AT);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({ status: CoverageStatus.NOT_CHECKED });
  });

  it("rejects a root Prisma client instead of releasing locks between writes", async () => {
    const property = await seedProperty("1000010009", ["1000070"]);
    const run = await seedAcceptedRun([
      {
        propertyId: property.id,
        propertyIdentifierVersion: property.identifierVersion,
        bins: ["1000070"],
      },
    ]);

    await expect(
      publishSuccessfulCoverage(
        // Deliberately bypass the compile-time transaction-only contract to
        // verify that production misuse also fails closed at runtime.
        prisma as never,
        run,
        ACCEPTED_AT,
      ),
    ).rejects.toThrow("an existing transaction client is required");

    await expect(
      prisma.propertyDatasetCoverage.findUniqueOrThrow({
        where: {
          propertyId_dataset: {
            propertyId: property.id,
            dataset: Dataset.DOB_ECB_VIOLATIONS,
          },
        },
      }),
    ).resolves.toMatchObject({ status: CoverageStatus.NOT_CHECKED });
  });
});
