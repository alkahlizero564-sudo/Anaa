import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      platform    TEXT,
      token_hash  TEXT NOT NULL UNIQUE,
      lost_mode   INTEGER NOT NULL DEFAULT 0,
      lost_message TEXT,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER
    );

    CREATE TABLE IF NOT EXISTS reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      lat        REAL,
      lng        REAL,
      accuracy   REAL,
      battery    REAL,
      charging   INTEGER,
      network    TEXT,
      online     INTEGER,
      screen     TEXT
    );
    CREATE INDEX IF NOT EXISTS reports_device_time ON reports(device_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      payload    TEXT,
      created_at INTEGER NOT NULL,
      acked_at   INTEGER
    );
  `);
  return db;
}
