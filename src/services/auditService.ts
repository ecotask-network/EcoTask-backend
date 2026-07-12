import prisma from '../utils/prisma.js';
import logger from '../utils/logger.js';

export interface AuditLogEntry {
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export async function logAudit(entry: AuditLogEntry): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "AuditLog" (id, "userId", action, resource, "resourceId", details, ip, "createdAt")
      VALUES (gen_random_uuid(), ${entry.userId || null}, ${entry.action}, ${entry.resource}, ${entry.resourceId || null}, ${JSON.stringify(entry.details || {})}::jsonb, ${entry.ip || null}, NOW())
    `;
  } catch (err) {
    logger.error('Failed to write audit log', { err, auditEntry: entry });
  }
}

export async function getAuditLogs(params: {
  userId?: string;
  resource?: string;
  resourceId?: string;
  limit?: number;
  offset?: number;
}) {
  const where: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.userId) {
    where.push(`"userId" = $${paramIndex++}`);
    values.push(params.userId);
  }
  if (params.resource) {
    where.push(`resource = $${paramIndex++}`);
    values.push(params.resource);
  }
  if (params.resourceId) {
    where.push(`"resourceId" = $${paramIndex++}`);
    values.push(params.resourceId);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = params.limit || 50;
  const offset = params.offset || 0;

  const query = `SELECT * FROM "AuditLog" ${whereClause} ORDER BY "createdAt" DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  const countQuery = `SELECT COUNT(*) FROM "AuditLog" ${whereClause}`;

  const [logs, countResult] = await Promise.all([
    prisma.$queryRawUnsafe(query, ...values, limit, offset),
    prisma.$queryRawUnsafe(countQuery, ...values),
  ]);

  return {
    data: logs,
    meta: {
      total: Number((countResult as Array<{ count: bigint }>)[0]?.count || 0),
      limit,
      offset,
    },
  };
}
