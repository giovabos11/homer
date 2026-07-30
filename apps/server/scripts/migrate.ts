// npm run db:migrate — apply pending SQL migrations to data/app.db.
import path from 'node:path';
import { openDb } from '../src/db/client';
import { serverRoot } from '../src/util/paths';

const dbPath = process.env.DB_PATH ?? path.join(serverRoot(), 'data', 'app.db');
const { sqlite } = openDb(dbPath); // openDb runs migrations
console.log(`[db:migrate] database ready at ${dbPath}`);
const applied = (sqlite.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map(
  (r) => r.name,
);
console.log(`[db:migrate] applied migrations: ${applied.join(', ') || '(none)'}`);
sqlite.close();
