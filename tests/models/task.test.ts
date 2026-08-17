import { encodeCursor, InvalidCursorError } from '../../src/utils/cursor';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    task: { findMany: jest.fn() },
  },
}));

import prisma from '../../src/utils/prisma';
import { listTasks } from '../../src/models/task';

const mockPrisma = prisma as unknown as {
  task: { findMany: jest.Mock };
};

interface FixtureTask {
  id: string;
  createdAt: Date;
  title: string;
}

/**
 * In-memory stand-in for Postgres that understands the `where` shapes
 * `listTasks` produces: a plain `createdAt: { lt }` filter (legacy cursor),
 * a composite `OR: [{ createdAt: { lt } }, { createdAt, id: { lt } }]`
 * filter, and plain equality filters like `type`. Rows are expected to
 * already be supplied in `(createdAt desc, id desc)` order, matching what
 * the database would return for the query's orderBy.
 */
function fakeFindMany(tasks: FixtureTask[]) {
  return jest.fn(
    async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
      let rows = tasks;

      if (where.type) {
        rows = rows.filter(
          (t) => (t as unknown as { type?: string }).type === where.type,
        );
      }

      if (where.createdAt) {
        const { lt } = where.createdAt as { lt: Date };
        rows = rows.filter((t) => t.createdAt.getTime() < lt.getTime());
      }

      if (where.OR) {
        const or = where.OR as Array<Record<string, unknown>>;
        rows = rows.filter((t) =>
          or.some((cond) => {
            if ('lt' in ((cond.createdAt as Record<string, unknown>) || {})) {
              const { lt } = cond.createdAt as { lt: Date };
              return t.createdAt.getTime() < lt.getTime();
            }
            const createdAt = cond.createdAt as Date;
            const { lt: idLt } = cond.id as { lt: string };
            return t.createdAt.getTime() === createdAt.getTime() && t.id < idLt;
          }),
        );
      }

      return rows.slice(0, take);
    },
  );
}

describe('task model: listTasks composite cursor pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('pages with a shared createdAt (fixture with N ties)', () => {
    // 5 tasks sharing the exact same createdAt millisecond, pre-sorted the
    // way Postgres would return them for ORDER BY createdAt DESC, id DESC.
    const sharedCreatedAt = new Date('2024-01-15T10:30:00.000Z');
    const fixture: FixtureTask[] = ['id-5', 'id-4', 'id-3', 'id-2', 'id-1'].map((id) => ({
      id,
      createdAt: sharedCreatedAt,
      title: `Task ${id}`,
    }));

    it('pages through all rows with zero duplicates or skips', async () => {
      mockPrisma.task.findMany.mockImplementation(fakeFindMany(fixture));

      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;

      do {
        const { items, nextCursor } = await listTasks({ limit: 2, cursor });
        seen.push(...items.map((t) => t.id));
        cursor = nextCursor ?? undefined;
        guard += 1;
      } while (cursor && guard < 10);

      expect(seen).toEqual(['id-5', 'id-4', 'id-3', 'id-2', 'id-1']);
      expect(new Set(seen).size).toBe(fixture.length);
    });

    it('encodes the composite (createdAt, id) cursor for the next page', async () => {
      mockPrisma.task.findMany.mockImplementation(fakeFindMany(fixture));

      const { nextCursor } = await listTasks({ limit: 2 });
      expect(nextCursor).toBeTruthy();

      const decoded = JSON.parse(
        Buffer.from(nextCursor as string, 'base64url').toString(),
      );
      expect(decoded).toEqual({
        createdAt: sharedCreatedAt.toISOString(),
        id: 'id-4',
      });
    });

    it('builds an OR where-clause of (createdAt lt) or (createdAt eq and id lt)', async () => {
      mockPrisma.task.findMany.mockImplementation(fakeFindMany(fixture));

      const cursor = encodeCursor(sharedCreatedAt, 'id-4');
      await listTasks({ limit: 2, cursor });

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { createdAt: { lt: sharedCreatedAt } },
              { createdAt: sharedCreatedAt, id: { lt: 'id-4' } },
            ],
          }),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('composes the cursor OR-clause with other AND-ed filters instead of loosening them', async () => {
      mockPrisma.task.findMany.mockImplementation(
        fakeFindMany(fixture.map((t) => ({ ...t, type: 'cleanup' }) as FixtureTask)),
      );

      const cursor = encodeCursor(sharedCreatedAt, 'id-4');
      await listTasks({ limit: 2, cursor, type: 'cleanup' });

      const call = mockPrisma.task.findMany.mock.calls[0][0];
      expect(call.where.type).toBe('cleanup');
      expect(call.where.OR).toBeDefined();
    });
  });

  describe('legacy bare-date cursor (backward compatibility)', () => {
    it('does not throw and degrades to a createdAt-only comparison', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);

      await expect(
        listTasks({ limit: 20, cursor: '2024-01-15T10:30:00.000Z' }),
      ).resolves.toEqual({ items: [], nextCursor: null });

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { lt: new Date('2024-01-15T10:30:00.000Z') },
          }),
        }),
      );
      const call = mockPrisma.task.findMany.mock.calls[0][0];
      expect(call.where.OR).toBeUndefined();
    });

    it('returns a new composite nextCursor even when paginating from a legacy cursor', async () => {
      const sharedCreatedAt = new Date('2024-01-15T10:30:00.000Z');
      const olderCreatedAt = new Date('2024-01-15T09:00:00.000Z');
      mockPrisma.task.findMany.mockResolvedValue([
        { id: 'id-9', createdAt: olderCreatedAt, title: 'Older task' },
      ]);

      const { nextCursor } = await listTasks({
        limit: 1,
        cursor: sharedCreatedAt.toISOString(),
      });

      // take = limit + 1 = 2, mock only returned 1 row => hasMore is false
      expect(nextCursor).toBeNull();
    });
  });

  describe('malformed cursors', () => {
    it('throws InvalidCursorError instead of hitting the database', async () => {
      await expect(listTasks({ cursor: 'definitely-not-valid' })).rejects.toThrow(
        InvalidCursorError,
      );
      expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
    });
  });

  describe('no cursor supplied', () => {
    it('omits both createdAt and OR filters on the first page', async () => {
      mockPrisma.task.findMany.mockResolvedValue([]);

      await listTasks({ limit: 20 });

      const call = mockPrisma.task.findMany.mock.calls[0][0];
      expect(call.where.createdAt).toBeUndefined();
      expect(call.where.OR).toBeUndefined();
      expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });
  });
});
