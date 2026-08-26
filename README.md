# Aptos Gas Estimator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Estimates how long an Aptos account's balance will last given its on-chain gas
consumption.

Every user transaction on Aptos costs gas (`gas_used × gas_unit_price`, paid in
APT). This tool fetches an account's full transaction history from the Aptos
mainnet REST API, models its burn rate over that history, and projects a
depletion date — useful for checking whether a hot wallet, faucet, or automation
account is funded for the long haul.

**[Live demo →](https://gregnazario.github.io/aptos-gas-burn-estimator/)**
(deployed automatically from `public/` via GitHub Pages)

## Features

- Balance and transaction count for any mainnet account, fetched live from the
  Aptos fullnode API
- Historical gas burn modeled per day, with the last 30 days weighted 2x so
  recent usage dominates the projection (a simple average is also reported)
- Estimated depletion date with color coding (>1 year green, >90 days amber,
  otherwise red) and a confidence level based on how much history was synced
- "Simulate higher usage" multiplier (5x–1000x) to stress-test the runway
- Gas burn chart over time with hour / day / week / month buckets
- Paginated transaction table linking to the Aptos explorer
- Polite API usage: bounded concurrency, minimum delay between requests, and
  exponential backoff honoring `Retry-After` on 429s

## How it works

The repo ships two deployment modes over one shared design:

1. **Fetch live account state.** Account info comes from
   `GET /accounts/:address` and the balance from the `0x1::coin::balance` view
   function (works for both legacy CoinStore and migrated FungibleStore
   accounts). The sequence number doubles as the total transaction count to sync.
2. **Model burn over history.** A background job pages through
   `/accounts/:address/transactions`, keeps `user_transaction`s, computes each
   transaction's cost in octas (`gas_used × gas_unit_price`), and stores it.
   The server mode persists rows in SQLite (WAL mode, keyed by address +
   sequence number, so syncs resume where they left off); the static Pages
   build caches the same data client-side in IndexedDB. Burn rate is total gas
   divided by days of history, weighted toward the last 30 days; depletion is
   balance ÷ daily burn, assuming no incoming transfers and constant usage.
3. **Serve via Express.** An Express app serves the static frontend from
   `public/` plus a Zod-validated JSON API under `/api`.

## Run locally

Requires [Bun](https://bun.sh) (or any Node-compatible runtime with npm).

```sh
bun install
bun run dev        # tsx src/server.ts → http://localhost:3000
```

Other scripts:

```sh
bun run build      # tsc → dist/
bun run start      # node dist/server.js
bun run lint       # biome check .
bun run lint:fix   # biome check --write .
bun run format     # biome format --write .
```

Configuration (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Server port (also settable via `--port <n>`) |
| `APTOS_API_URL` | `https://fullnode.mainnet.aptoslabs.com/v1` | Aptos REST endpoint |
| `DB_PATH` | `./data/gas-estimator.db` | SQLite database location |

## API

All routes are served by the Express server; `:address` must match
`^0x[a-fA-F0-9]{1,64}$`. Requests are validated with Zod and return `400` on
malformed input.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/account/:address` | Balance, sync status, burn rate stats, and depletion estimate in one call |
| `POST` | `/api/account/:address/sync` | Kick off (or resume) a background history sync; returns current progress |
| `GET` | `/api/account/:address/sync-status` | Current sync state: `idle`, `syncing` (with progress), `complete`, or `error` |
| `GET` | `/api/account/:address/transactions?page=1&limit=50&sort=desc` | Stored transactions, paginated (`limit` ≤ 200) |
| `GET` | `/api/account/:address/burn-rate?bucket=day` | Total gas burned grouped by bucket: `hour`, `day`, `week`, or `month` |

Example:

```sh
curl -s localhost:3000/api/account/0x1 | jq '{balance_apt, burn_rate: .burn_rate.weighted_daily_burn_octas, depletion}'
```

## Deployment

A push to `main` triggers `.github/workflows/pages.yml`, which publishes the
`public/` directory to GitHub Pages. In this static mode there is no backend:
the frontend talks directly to the Aptos REST API and caches history in
IndexedDB instead of SQLite. Run the Express server locally or anywhere for the
full API-backed experience.

## Development

Code is formatted and linted with Biome:

```sh
bun run lint          # check for issues
bun run lint:fix      # auto-fix what's fixable
bun run format        # format everything
```

Source layout:

```
src/
  aptos/      # REST client + background history fetcher
  api/        # Express routes + Zod validation schemas
  db/         # better-sqlite3 schema + query helpers
  services/   # burn-rate math and depletion estimates
  utils/      # formatting, rate limiter
public/       # static frontend (plain JS + Alpine.js and Chart.js from CDN)
```

## License

MIT — see [LICENSE](LICENSE).
