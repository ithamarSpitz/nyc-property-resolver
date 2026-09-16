import {
  Prisma,
  PrismaClient,
  PropertyResolutionInput,
  PropertyResolutionInputType,
} from '@prisma/client';

export type PersistResolutionInputParams = {
  inputType: PropertyResolutionInputType;
  normalizedInput: string;
  propertyId: string;
  resolvedAt?: Date;
  resolverConfidence?: number | null;
  resolverMetadata?: Prisma.InputJsonValue | null;
};

export async function findPropertyIdByResolutionInput(
  prisma: PrismaClient,
  inputType: PropertyResolutionInputType,
  normalizedInput: string,
): Promise<string | null> {
  const existing = await prisma.propertyResolutionInput.findUnique({
    where: {
      inputType_normalizedInput: {
        inputType,
        normalizedInput,
      },
    },
    select: {
      propertyId: true,
    },
  });

  return existing?.propertyId ?? null;
}

export async function persistResolutionInput(
  prisma: PrismaClient,
  params: PersistResolutionInputParams,
): Promise<PropertyResolutionInput> {
  const resolvedAt = params.resolvedAt ?? new Date();

  return prisma.propertyResolutionInput.upsert({
    where: {
      inputType_normalizedInput: {
        inputType: params.inputType,
        normalizedInput: params.normalizedInput,
      },
    },
    create: {
      inputType: params.inputType,
      normalizedInput: params.normalizedInput,
      propertyId: params.propertyId,
      resolvedAt,
      resolverConfidence: params.resolverConfidence ?? null,
      resolverMetadata: params.resolverMetadata ?? Prisma.JsonNull,
    },
    update: {},
  });
}
