import { encodeCursor, decodeCursor, InvalidCursorError } from '../../src/utils/cursor';

describe('cursor utils', () => {
  describe('encodeCursor / decodeCursor round trip', () => {
    it('round-trips a composite cursor', () => {
      const createdAt = new Date('2024-01-15T10:30:00.000Z');
      const id = 'task-abc-123';

      const token = encodeCursor(createdAt, id);
      const decoded = decodeCursor(token);

      expect(decoded.createdAt).toBe(createdAt.toISOString());
      expect(decoded.id).toBe(id);
    });

    it('produces an opaque base64url token', () => {
      const token = encodeCursor(new Date('2024-01-15T10:30:00.000Z'), 'task-1');
      expect(token).not.toContain('+');
      expect(token).not.toContain('/');
      expect(token).not.toContain('=');
    });
  });

  describe('legacy bare-date cursor', () => {
    it('decodes a bare ISO date string without an id', () => {
      const decoded = decodeCursor('2024-01-15T10:30:00.000Z');
      expect(decoded.createdAt).toBe('2024-01-15T10:30:00.000Z');
      expect(decoded.id).toBeUndefined();
    });

    it('does not throw for a legacy cursor', () => {
      expect(() => decodeCursor('2023-05-01T00:00:00.000Z')).not.toThrow();
    });
  });

  describe('malformed cursors', () => {
    it('throws InvalidCursorError for garbage input', () => {
      expect(() => decodeCursor('not-a-cursor-at-all')).toThrow(InvalidCursorError);
    });

    it('throws InvalidCursorError for an empty string', () => {
      expect(() => decodeCursor('')).toThrow(InvalidCursorError);
    });

    it('throws InvalidCursorError when the encoded createdAt is invalid', () => {
      const token = Buffer.from(
        JSON.stringify({ createdAt: 'not-a-date', id: 'task-1' }),
      ).toString('base64url');
      expect(() => decodeCursor(token)).toThrow(InvalidCursorError);
    });
  });
});
