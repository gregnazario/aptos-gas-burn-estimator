import { getAccountBalance, getAccountInfo } from "../aptos/client.js";
import { getSyncState } from "../aptos/fetcher.js";
import { getAccount, upsertAccount } from "../db/queries.js";

export interface AccountSummary {
  address: string;
  balance_octas: string;
  sequence_number: number;
  last_synced_at: string | null;
  sync_status: "idle" | "syncing" | "complete" | "error";
  sync_progress?: { total: number; synced: number };
}

export async function getAccountSummary(address: string): Promise<AccountSummary> {
  // Fetch account info (this will 404 if account truly doesn't exist)
  const accountInfo = await getAccountInfo(address);

  // Balance fetch can fail if the account has no CoinStore — that's fine, default to 0
  let balance = "0";
  try {
    balance = await getAccountBalance(address);
  } catch {
    // No CoinStore resource — account exists but holds no APT
  }

  const seqNum = parseInt(accountInfo.sequence_number, 10);
  upsertAccount(address, balance, seqNum);

  const stored = getAccount(address);
  const syncState = getSyncState(address);

  return {
    address,
    balance_octas: balance,
    sequence_number: seqNum,
    last_synced_at: stored?.last_synced_at ?? null,
    sync_status: syncState?.status ?? "idle",
    sync_progress: syncState ? { total: syncState.totalTransactions, synced: syncState.syncedTransactions } : undefined,
  };
}
