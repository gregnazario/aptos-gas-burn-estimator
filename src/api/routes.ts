import { type Request, type Response, Router } from "express";
import { getSyncState, syncAccountTransactions } from "../aptos/fetcher.js";
import { getBurnRateBuckets, getTransactionsPaginated } from "../db/queries.js";
import { getAccountSummary } from "../services/account.js";
import { calculateBurnRate, estimateDepletion } from "../services/gas.js";
import { octasToApt, timestampUsToISO } from "../utils/format.js";
import { addressParam, burnRateQuery, paginationQuery } from "./validation.js";

export const router = Router();

// GET /api/account/:address
router.get("/account/:address", async (req: Request, res: Response) => {
  try {
    const params = addressParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.issues[0].message });
      return;
    }

    const summary = await getAccountSummary(params.data.address);
    const burnRate = calculateBurnRate(params.data.address);
    const depletion = estimateDepletion(summary.balance_octas, burnRate);

    res.json({
      ...summary,
      balance_apt: octasToApt(BigInt(summary.balance_octas)),
      burn_rate: burnRate,
      depletion,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = (err as { status?: number }).status;
    if (status === 404 || message.includes("not found")) {
      res.status(404).json({ error: "Account not found" });
    } else {
      console.error("Error fetching account:", err);
      res.status(500).json({ error: message });
    }
  }
});

// POST /api/account/:address/sync
router.post("/account/:address/sync", async (req: Request, res: Response) => {
  try {
    const params = addressParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.issues[0].message });
      return;
    }

    const state = await syncAccountTransactions(params.data.address);
    res.json(state);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Error starting sync:", err);
    res.status(500).json({ error: message });
  }
});

// GET /api/account/:address/sync-status
router.get("/account/:address/sync-status", (req: Request, res: Response) => {
  const params = addressParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.issues[0].message });
    return;
  }

  const state = getSyncState(params.data.address);
  if (!state) {
    res.json({ status: "idle" });
    return;
  }
  res.json(state);
});

// GET /api/account/:address/transactions
router.get("/account/:address/transactions", (req: Request, res: Response) => {
  const params = addressParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.issues[0].message });
    return;
  }

  const query = paginationQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.issues[0].message });
    return;
  }

  const { page, limit, sort } = query.data;
  const result = getTransactionsPaginated(params.data.address, page, limit, sort);

  res.json({
    transactions: result.rows.map((tx) => ({
      ...tx,
      timestamp_iso: timestampUsToISO(tx.timestamp_us),
      gas_cost_apt: octasToApt(BigInt(tx.gas_cost_octas)),
    })),
    pagination: {
      page,
      limit,
      total: result.total,
      total_pages: Math.ceil(result.total / limit),
    },
  });
});

// GET /api/account/:address/burn-rate
router.get("/account/:address/burn-rate", (req: Request, res: Response) => {
  const params = addressParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.issues[0].message });
    return;
  }

  const query = burnRateQuery.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.issues[0].message });
    return;
  }

  const buckets = getBurnRateBuckets(params.data.address, query.data.bucket);
  res.json({
    bucket_type: query.data.bucket,
    data: buckets.map((b) => ({
      ...b,
      total_gas_apt: octasToApt(BigInt(b.total_gas_octas)),
    })),
  });
});
