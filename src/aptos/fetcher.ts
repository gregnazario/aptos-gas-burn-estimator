import { CONFIG } from "../config.js";
import type { TransactionRow } from "../db/queries.js";
import { getMaxSequenceNumber, insertTransactions, updateSyncTime, upsertAccount } from "../db/queries.js";
import { getAccountBalance, getAccountInfo, getAccountTransactions } from "./client.js";

export interface SyncState {
  address: string;
  status: "syncing" | "complete" | "error";
  totalTransactions: number;
  syncedTransactions: number;
  error?: string;
  startedAt: number;
}

// In-memory sync state tracker
const syncStates = new Map<string, SyncState>();

export function getSyncState(address: string): SyncState | undefined {
  return syncStates.get(address);
}

export async function syncAccountTransactions(address: string): Promise<SyncState> {
  const existing = syncStates.get(address);
  if (existing && existing.status === "syncing") {
    return existing;
  }

  const state: SyncState = {
    address,
    status: "syncing",
    totalTransactions: 0,
    syncedTransactions: 0,
    startedAt: Date.now(),
  };
  syncStates.set(address, state);

  // Run sync in background - don't await
  doSync(address, state).catch((err) => {
    state.status = "error";
    state.error = err instanceof Error ? err.message : String(err);
    console.error(`Sync error for ${address}:`, err);
  });

  return state;
}

async function doSync(address: string, state: SyncState): Promise<void> {
  // Get account info to know total transaction count
  const accountInfo = await getAccountInfo(address);
  const totalTxCount = parseInt(accountInfo.sequence_number, 10);
  state.totalTransactions = totalTxCount;

  // Persist account info (balance may not exist if no CoinStore)
  let balance = "0";
  try {
    balance = await getAccountBalance(address);
  } catch {
    // No CoinStore resource
  }
  upsertAccount(address, balance, totalTxCount);

  if (totalTxCount === 0) {
    state.status = "complete";
    updateSyncTime(address);
    return;
  }

  // Find where we left off
  const maxStored = getMaxSequenceNumber(address);
  const startFrom = maxStored !== null ? maxStored + 1 : 0;
  state.syncedTransactions = startFrom;

  if (startFrom >= totalTxCount) {
    state.status = "complete";
    updateSyncTime(address);
    return;
  }

  // Paginate through remaining transactions
  let cursor = startFrom;
  while (cursor < totalTxCount) {
    const batch = await getAccountTransactions(address, cursor, CONFIG.TX_PAGE_SIZE);

    if (batch.length === 0) break;

    const rows: TransactionRow[] = batch
      .filter((tx) => tx.type === "user_transaction")
      .map((tx) => ({
        address,
        sequence_number: parseInt(tx.sequence_number, 10),
        version: tx.version,
        hash: tx.hash,
        timestamp_us: tx.timestamp,
        gas_used: tx.gas_used,
        gas_unit_price: tx.gas_unit_price,
        gas_cost_octas: (BigInt(tx.gas_used) * BigInt(tx.gas_unit_price)).toString(),
        success: tx.success ? 1 : 0,
      }));

    if (rows.length > 0) {
      insertTransactions(rows);
    }

    cursor += batch.length;
    state.syncedTransactions = cursor;

    if (batch.length < CONFIG.TX_PAGE_SIZE) break;
  }

  state.status = "complete";
  updateSyncTime(address);
}
