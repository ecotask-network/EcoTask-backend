import fs from 'fs';
import path from 'path';
import {
  assertJwtSecretIsSafe,
  DEVELOPMENT_JWT_SECRET,
  DOCUMENTATION_JWT_SECRET,
  KNOWN_JWT_SECRET_PLACEHOLDERS,
  LEGACY_DEVELOPMENT_JWT_SECRET,
  resolveJwtSecret,
} from '../../src/config/jwtSecret';
import { parseEnv } from '../../src/config/validate';
import logger from '../../src/utils/logger';

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('JWT secret configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects the exact legacy validation fallback in production', () => {
    expect(() =>
      assertJwtSecretIsSafe('production', LEGACY_DEVELOPMENT_JWT_SECRET),
    ).toThrow(/known development placeholder.*fresh random secret/i);
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://ecotask:ecotask@localhost:5432/ecotask',
        JWT_SECRET: LEGACY_DEVELOPMENT_JWT_SECRET,
      }),
    ).toThrow(/known development placeholder.*fresh random secret/i);
  });

  it('rejects the repository environment placeholder in production', () => {
    const envExample = fs.readFileSync(path.resolve('.env.example'), 'utf8');
    const placeholder = envExample.match(/^JWT_SECRET=(.+)$/m)?.[1];

    expect(placeholder).toBeDefined();
    expect(placeholder?.length).toBeGreaterThanOrEqual(16);
    expect(KNOWN_JWT_SECRET_PLACEHOLDERS.has(placeholder || '')).toBe(true);
    expect(() => assertJwtSecretIsSafe('production', placeholder || '')).toThrow(
      /known development placeholder.*fresh random secret/i,
    );
  });

  it('blocklists every documented JWT placeholder', () => {
    const files = ['.env.example', 'README.md'];

    for (const file of files) {
      const source = fs.readFileSync(path.resolve(file), 'utf8');
      const placeholders = Array.from(
        source.matchAll(/^JWT_SECRET=([^\s]+)$/gm),
        (match) => match[1],
      );

      expect(placeholders.length).toBeGreaterThan(0);
      for (const placeholder of placeholders) {
        expect(KNOWN_JWT_SECRET_PLACEHOLDERS.has(placeholder)).toBe(true);
        expect(() => assertJwtSecretIsSafe('production', placeholder)).toThrow(
          /known development placeholder.*fresh random secret/i,
        );
      }
    }
  });

  it('rejects a missing production secret', () => {
    expect(() => assertJwtSecretIsSafe('production', '')).toThrow(
      /required in production.*fresh random secret/i,
    );
  });

  it('warns without blocking development or test environments', () => {
    expect(() =>
      assertJwtSecretIsSafe('development', DEVELOPMENT_JWT_SECRET),
    ).not.toThrow();
    expect(() => assertJwtSecretIsSafe('test', DOCUMENTATION_JWT_SECRET)).not.toThrow();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/forgeable/i));
  });

  it('accepts a fresh production secret', () => {
    expect(() =>
      assertJwtSecretIsSafe(
        'production',
        'f4cb3587827eb3673416f427658bbe2348dcd41832c9635f5df9eeb13196ce30',
      ),
    ).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not resolve a fallback secret for production config', () => {
    expect(resolveJwtSecret('production')).toBe('');
    expect(resolveJwtSecret('development')).toBe(DEVELOPMENT_JWT_SECRET);
  });

  it('runs startup validation before auth consumers are imported', () => {
    const appSource = fs.readFileSync(path.resolve('src/app.ts'), 'utf8');
    const imports = Array.from(
      appSource.matchAll(/^import(?:\s+[^'"]+\s+from)?\s+['"]([^'"]+)['"];$/gm),
      (match) => match[1],
    );

    expect(imports[0]).toBe('./config/startup.js');

    const authConsumers = ['src/middleware/auth.ts', 'src/controllers/authController.ts'];
    for (const file of authConsumers) {
      const source = fs.readFileSync(path.resolve(file), 'utf8');
      for (const placeholder of KNOWN_JWT_SECRET_PLACEHOLDERS) {
        expect(source).not.toContain(placeholder);
      }
    }
  });
});
