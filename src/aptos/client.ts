import { CONFIG } from "../config.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import type { AptosAccountInfo, AptosTransaction } from "./types.js";

class ApiResponseError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiResponseError";
  }
}

async function aptosFetch<T>(path: string): Promise<T> {
  return rateLimiter.execute(async () => {
    const url = `${CONFIG.APTOS_API_URL}${path}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const retryAfter = res.headers.get("Retry-After");
      throw new ApiResponseError(
        `Aptos API error: ${res.status} ${res.statusText}`,
        res.status,
        retryAfter ? parseInt(retryAfter, 10) : undefined,
      );
    }

    return res.json() as Promise<T>;
  });
}

export async function getAccountInfo(address: string): Promise<AptosAccountInfo> {
  return aptosFetch<AptosAccountInfo>(`/accounts/${address}`);
}

export async function getAccountBalance(address: string): Promise<string> {
  // Use the view function — works for both legacy CoinStore and migrated FungibleStore accounts
  const result = await rateLimiter.execute(async () => {
    const url = `${CONFIG.APTOS_API_URL}/view`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        function: "0x1::coin::balance",
        type_arguments: ["0x1::aptos_coin::AptosCoin"],
        arguments: [address],
      }),
    });

    if (!res.ok) {
      const retryAfter = res.headers.get("Retry-After");
      throw new ApiResponseError(
        `Aptos API error: ${res.status} ${res.statusText}`,
        res.status,
        retryAfter ? parseInt(retryAfter, 10) : undefined,
      );
    }

    return res.json() as Promise<string[]>;
  });

  return result[0] ?? "0";
}

export async function getAccountTransactions(
  address: string,
  start: number,
  limit: number,
): Promise<AptosTransaction[]> {
  return aptosFetch<AptosTransaction[]>(`/accounts/${address}/transactions?start=${start}&limit=${limit}`);
}
