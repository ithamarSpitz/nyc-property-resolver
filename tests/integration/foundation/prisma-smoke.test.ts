import { PrismaClient } from '@prisma/client';

const describeIntegration =
  process.env.FOUNDATION_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('prisma postgres smoke', () => {
  it('connects to PostgreSQL and runs a query', async () => {
    const prisma = new PrismaClient();

    try {
      const result = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 as ok`;
      expect(result[0]?.ok).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});
