import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { CONFIG } from "../config.js";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(CONFIG.DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(CONFIG.DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      address           TEXT PRIMARY KEY,
      balance_octas     TEXT,
      sequence_number   INTEGER,
      last_synced_at    TEXT,
      last_balance_fetch TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      address           TEXT NOT NULL,
      sequence_number   INTEGER NOT NULL,
      version           TEXT NOT NULL,
      hash              TEXT NOT NULL,
      timestamp_us      TEXT NOT NULL,
      gas_used          TEXT NOT NULL,
      gas_unit_price    TEXT NOT NULL,
      gas_cost_octas    TEXT NOT NULL,
      success           INTEGER NOT NULL,
      PRIMARY KEY (address, sequence_number)
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp
      ON transactions (address, timestamp_us);
  `);
}
