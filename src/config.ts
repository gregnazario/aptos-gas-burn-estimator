function getPort(): number {
  const portFlag = process.argv.indexOf("--port");
  if (portFlag !== -1 && process.argv[portFlag + 1]) {
    return parseInt(process.argv[portFlag + 1], 10);
  }
  return parseInt(process.env.PORT || "3000", 10);
}

export const CONFIG = {
  PORT: getPort(),
  APTOS_API_URL: process.env.APTOS_API_URL || "https://fullnode.mainnet.aptoslabs.com/v1",
  DB_PATH: process.env.DB_PATH || "./data/gas-estimator.db",

  // Rate limiting
  MAX_CONCURRENT_REQUESTS: 2,
  MIN_REQUEST_DELAY_MS: 200,
  MAX_RETRIES: 5,
  BASE_BACKOFF_MS: 200,
  MAX_BACKOFF_MS: 60000,

  // Aptos API pagination
  TX_PAGE_SIZE: 100,
} as const;
