import { PrismaClient } from "@prisma/client";

declare global {
  // Prevents multiple Prisma Client instances in development (hot reload).
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const prisma: PrismaClient = global.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

export default prisma;
