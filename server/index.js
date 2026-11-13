import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || join(root, 'data', 'anaa.db');

const db = openDb(dbFile);
const { server } = createApp({
  db,
  publicDir: join(root, 'public'),
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
});

server.listen(port, () => {
  console.log(`Anaa running on http://localhost:${port}`);
});
