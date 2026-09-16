-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PropertyResolutionInputType" AS ENUM ('ADDRESS', 'BBL');

-- CreateEnum
CREATE TYPE "Dataset" AS ENUM ('DOB_ECB_VIOLATIONS');

-- CreateEnum
CREATE TYPE "CoverageStatus" AS ENUM ('CHECKED', 'NOT_CHECKED', 'FAILED');

-- CreateEnum
CREATE TYPE "CoverageStatusReason" AS ENUM ('NEVER_INGESTED', 'NO_VALID_BIN', 'IDENTIFIERS_CHANGED', 'IDENTIFIERS_CHANGED_AFTER_SNAPSHOT');

-- CreateTable
CREATE TABLE "properties" (
    "id" UUID NOT NULL,
    "identifier_version" INTEGER NOT NULL DEFAULT 1,
    "bbl" VARCHAR(10) NOT NULL,
    "condo_base_bbl" VARCHAR(10),
    "condo_billing_bbl" VARCHAR(10),
    "normalized_address" TEXT,
    "borough" INTEGER NOT NULL,
    "block" INTEGER NOT NULL,
    "lot" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_resolution_inputs" (
    "id" UUID NOT NULL,
    "input_type" "PropertyResolutionInputType" NOT NULL,
    "normalized_input" TEXT NOT NULL,
    "property_id" UUID NOT NULL,
    "resolved_at" TIMESTAMPTZ(6) NOT NULL,
    "resolver_confidence" DOUBLE PRECISION,
    "resolver_metadata" JSONB,

    CONSTRAINT "property_resolution_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_bins" (
    "property_id" UUID NOT NULL,
    "bin" VARCHAR(7) NOT NULL,

    CONSTRAINT "property_bins_pkey" PRIMARY KEY ("property_id","bin")
);

-- CreateTable
CREATE TABLE "property_dataset_coverage" (
    "property_id" UUID NOT NULL,
    "dataset" "Dataset" NOT NULL,
    "status" "CoverageStatus" NOT NULL,
    "status_reason" "CoverageStatusReason",
    "last_attempt_run_id" UUID,
    "last_success_run_id" UUID,
    "last_attempt_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "source_watermark_at" TIMESTAMPTZ(6),
    "last_error" TEXT,

    CONSTRAINT "property_dataset_coverage_pkey" PRIMARY KEY ("property_id","dataset")
);

-- CreateIndex
CREATE UNIQUE INDEX "properties_bbl_key" ON "properties"("bbl");

-- CreateIndex
CREATE UNIQUE INDEX "property_resolution_inputs_input_type_normalized_input_key" ON "property_resolution_inputs"("input_type", "normalized_input");

-- CreateIndex
CREATE INDEX "property_bins_bin_idx" ON "property_bins"("bin");

-- AddForeignKey
ALTER TABLE "property_resolution_inputs" ADD CONSTRAINT "property_resolution_inputs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_bins" ADD CONSTRAINT "property_bins_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_dataset_coverage" ADD CONSTRAINT "property_dataset_coverage_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
