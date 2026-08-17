# Data Repair Migration - HTML Escaping Bug Fix

## Problem
The `sanitizeInput` middleware in `src/middleware/sanitize.ts` was HTML-escaping all string inputs on the way into the API. Since the API returns JSON (not HTML), this escaping provided no XSS defense and only corrupted data at rest.

Example: A user named "Café & Sons" was persisted as "Café &amp; Sons". Every subsequent update would double-escape it.

## Solution
1. **Removed the middleware**: Deleted `src/middleware/sanitize.ts` and removed its usage from `src/app.ts`
2. **Created repair script**: `scripts/repair-escaped-data.ts` to unescape existing corrupted data
3. **Added tests**: Tests in `tests/routes/users.test.ts` and `tests/routes/tasks.test.ts` to verify special characters round-trip byte-identical

## Running the Migration

Before running this migration, ensure you have a database backup.

```bash
# Run the repair script
npx tsx scripts/repair-escaped-data.ts
```

## Affected Fields

The repair script unescapes HTML entities in these text fields:
- **User**: `name`, `bio`
- **Task**: `title`, `description`
- **Proof**: `notes`
- **Verification**: `notes`
- **ValidatorVote**: `notes`
- **Notification**: `title`, `body`

## URL Fields (NOT Modified)

URL fields are intentionally NOT modified by this script, as they may legitimately contain `&` characters:
- **User**: `avatarUrl`, `webhookUrl`

## Client Impact

**Mobile clients** may currently display escaped values (e.g., "Café &amp; Sons"). After running this migration:
- New data will be stored correctly
- Existing data will be repaired to the original unescaped form
- Mobile clients should update to handle the corrected data

If mobile clients need time to update, consider a gradual rollout or a decode-on-read shim during transition.

## Security Considerations

The HTML escaping provided no real XSS defense for a JSON API consumed by mobile clients. Proper XSS defense should be:
- At the output boundary for HTML-rendering clients (web dashboards)
- Via Content Security Policy (CSP) headers (already present via helmet)
- Via input validation (already present via zod schemas)

## Verification

After running the migration, verify:
1. Run the test suite: `npm test`
2. Check that special characters in user profiles display correctly
3. Check that task titles and descriptions display correctly
4. Verify URLs with `&` still work correctly
