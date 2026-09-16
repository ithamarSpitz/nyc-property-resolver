import { PrismaClient } from '@prisma/client';

let prismaClient: PrismaClient | undefined;

function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}

export function getPrismaClient(): PrismaClient {
  prismaClient ??= createPrismaClient();
  return prismaClient;
}

export async function connectPrisma(): Promise<void> {
  await getPrismaClient().$connect();
}

export async function disconnectPrisma(): Promise<void> {
  if (prismaClient === undefined) {
    return;
  }

  await prismaClient.$disconnect();
  prismaClient = undefined;
}
