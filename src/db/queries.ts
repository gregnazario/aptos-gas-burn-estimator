import { getDb } from "./schema.js";

export interface AccountRow {
  address: string;
  balance_octas: string | null;
  sequence_number: number | null;
  last_synced_at: string | null;
  last_balance_fetch: string | null;
}

export interface TransactionRow {
  address: string;
  sequence_number: number;
  version: string;
  hash: string;
  timestamp_us: string;
  gas_used: string;
  gas_unit_price: string;
  gas_cost_octas: string;
  success: number;
}

export interface BurnBucket {
  bucket: string;
  total_gas_octas: string;
  tx_count: number;
}

export function getAccount(address: string): AccountRow | undefined {
  return getDb().prepare("SELECT * FROM accounts WHERE address = ?").get(address) as AccountRow | undefined;
}

export function upsertAccount(address: string, balance_octas: string | null, sequence_number: number | null): void {
  getDb()
    .prepare(`
    INSERT INTO accounts (address, balance_octas, sequence_number, last_balance_fetch)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(address) DO UPDATE SET
      balance_octas = excluded.balance_octas,
      sequence_number = excluded.sequence_number,
      last_balance_fetch = datetime('now')
  `)
    .run(address, balance_octas, sequence_number);
}

export function updateSyncTime(address: string): void {
  getDb()
    .prepare(`
    UPDATE accounts SET last_synced_at = datetime('now') WHERE address = ?
  `)
    .run(address);
}

export function getMaxSequenceNumber(address: string): number | null {
  const row = getDb()
    .prepare("SELECT MAX(sequence_number) as max_seq FROM transactions WHERE address = ?")
    .get(address) as { max_seq: number | null } | undefined;
  return row?.max_seq ?? null;
}

export function insertTransactions(txns: TransactionRow[]): void {
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO transactions
      (address, sequence_number, version, hash, timestamp_us, gas_used, gas_unit_price, gas_cost_octas, success)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = getDb().transaction((rows: TransactionRow[]) => {
    for (const tx of rows) {
      insert.run(
        tx.address,
        tx.sequence_number,
        tx.version,
        tx.hash,
        tx.timestamp_us,
        tx.gas_used,
        tx.gas_unit_price,
        tx.gas_cost_octas,
        tx.success,
      );
    }
  });

  batch(txns);
}

export function getTransactionsPaginated(
  address: string,
  page: number,
  limit: number,
  sort: "asc" | "desc",
): { rows: TransactionRow[]; total: number } {
  const countRow = getDb().prepare("SELECT COUNT(*) as count FROM transactions WHERE address = ?").get(address) as {
    count: number;
  };

  const offset = (page - 1) * limit;
  const orderDir = sort === "asc" ? "ASC" : "DESC";
  const rows = getDb()
    .prepare(`SELECT * FROM transactions WHERE address = ? ORDER BY sequence_number ${orderDir} LIMIT ? OFFSET ?`)
    .all(address, limit, offset) as TransactionRow[];

  return { rows, total: countRow.count };
}

export function getBurnRateBuckets(address: string, bucket: string): BurnBucket[] {
  let truncExpr: string;
  switch (bucket) {
    case "hour":
      truncExpr = `strftime('%Y-%m-%dT%H:00:00Z', datetime(CAST(timestamp_us AS REAL) / 1000000, 'unixepoch'))`;
      break;
    case "week":
      // Group by ISO week start (Monday)
      truncExpr = `strftime('%Y-%m-%d', datetime(CAST(timestamp_us AS REAL) / 1000000, 'unixepoch'), 'weekday 0', '-6 days')`;
      break;
    case "month":
      truncExpr = `strftime('%Y-%m-01', datetime(CAST(timestamp_us AS REAL) / 1000000, 'unixepoch'))`;
      break;
    default: // day
      truncExpr = `strftime('%Y-%m-%d', datetime(CAST(timestamp_us AS REAL) / 1000000, 'unixepoch'))`;
  }

  return getDb()
    .prepare(`
    SELECT
      ${truncExpr} as bucket,
      CAST(SUM(CAST(gas_cost_octas AS INTEGER)) AS TEXT) as total_gas_octas,
      COUNT(*) as tx_count
    FROM transactions
    WHERE address = ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `)
    .all(address) as BurnBucket[];
}

export function getTransactionCount(address: string): number {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM transactions WHERE address = ?").get(address) as {
    count: number;
  };
  return row.count;
}

export function getDateRangeOfTransactions(address: string): { earliest_us: string | null; latest_us: string | null } {
  const row = getDb()
    .prepare(`
    SELECT MIN(timestamp_us) as earliest_us, MAX(timestamp_us) as latest_us
    FROM transactions WHERE address = ?
  `)
    .get(address) as { earliest_us: string | null; latest_us: string | null };
  return row;
}

export function getTotalGasBurned(address: string): string {
  const row = getDb()
    .prepare(`
    SELECT COALESCE(CAST(SUM(CAST(gas_cost_octas AS INTEGER)) AS TEXT), '0') as total
    FROM transactions WHERE address = ?
  `)
    .get(address) as { total: string };
  return row.total;
}
