import {
  getBurnRateBuckets,
  getDateRangeOfTransactions,
  getTotalGasBurned,
  getTransactionCount,
} from "../db/queries.js";

export interface BurnRateStats {
  total_gas_burned_octas: string;
  transaction_count: number;
  avg_daily_burn_octas: string;
  weighted_daily_burn_octas: string;
  days_of_history: number;
  confidence: "high" | "medium" | "low" | "none";
}

export interface DepletionEstimate {
  days_remaining: number | null;
  depletion_date: string | null;
  confidence: "high" | "medium" | "low" | "none";
  note: string;
}

export function calculateBurnRate(address: string): BurnRateStats {
  const txCount = getTransactionCount(address);
  const totalBurned = getTotalGasBurned(address);

  if (txCount === 0) {
    return {
      total_gas_burned_octas: "0",
      transaction_count: 0,
      avg_daily_burn_octas: "0",
      weighted_daily_burn_octas: "0",
      days_of_history: 0,
      confidence: "none",
    };
  }

  const dateRange = getDateRangeOfTransactions(address);
  if (!dateRange.earliest_us || !dateRange.latest_us) {
    return {
      total_gas_burned_octas: totalBurned,
      transaction_count: txCount,
      avg_daily_burn_octas: "0",
      weighted_daily_burn_octas: "0",
      days_of_history: 0,
      confidence: "none",
    };
  }

  const earliestMs = Number(BigInt(dateRange.earliest_us) / 1000n);
  const latestMs = Number(BigInt(dateRange.latest_us) / 1000n);
  const daysOfHistory = Math.max(1, (latestMs - earliestMs) / (1000 * 60 * 60 * 24));

  const totalBurnedBig = BigInt(totalBurned);
  const avgDailyBurn = totalBurnedBig / BigInt(Math.ceil(daysOfHistory));

  // Weighted burn rate: 2x weight for last 30 days
  const weightedDailyBurn = calculateWeightedBurn(address);

  const confidence = getConfidence(txCount, daysOfHistory);

  return {
    total_gas_burned_octas: totalBurned,
    transaction_count: txCount,
    avg_daily_burn_octas: avgDailyBurn.toString(),
    weighted_daily_burn_octas: weightedDailyBurn.toString(),
    days_of_history: Math.round(daysOfHistory),
    confidence,
  };
}

function calculateWeightedBurn(address: string): bigint {
  const buckets = getBurnRateBuckets(address, "day");
  if (buckets.length === 0) return 0n;

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  let recentTotal = 0n;
  let recentDays = 0;
  let olderTotal = 0n;
  let olderDays = 0;

  for (const b of buckets) {
    const bucketDate = new Date(b.bucket).getTime();
    const age = now - bucketDate;
    const cost = BigInt(b.total_gas_octas);

    if (age <= thirtyDaysMs) {
      recentTotal += cost;
      recentDays++;
    } else {
      olderTotal += cost;
      olderDays++;
    }
  }

  // If no recent data, fall back to simple average
  if (recentDays === 0) {
    return olderDays > 0 ? olderTotal / BigInt(olderDays) : 0n;
  }
  // If no older data, use recent only
  if (olderDays === 0) {
    return recentTotal / BigInt(recentDays);
  }

  // Weighted: recent gets 2x weight
  const recentAvg = recentTotal / BigInt(recentDays);
  const olderAvg = olderTotal / BigInt(olderDays);
  return (recentAvg * 2n + olderAvg) / 3n;
}

function getConfidence(txCount: number, daysOfHistory: number): "high" | "medium" | "low" | "none" {
  if (txCount > 100 && daysOfHistory > 30) return "high";
  if (txCount > 20 && daysOfHistory > 7) return "medium";
  if (txCount > 0) return "low";
  return "none";
}

export function estimateDepletion(balanceOctas: string, burnRate: BurnRateStats): DepletionEstimate {
  if (burnRate.confidence === "none" || burnRate.weighted_daily_burn_octas === "0") {
    return {
      days_remaining: null,
      depletion_date: null,
      confidence: burnRate.confidence,
      note: "Insufficient transaction history to estimate depletion.",
    };
  }

  const balance = BigInt(balanceOctas);
  const dailyBurn = BigInt(burnRate.weighted_daily_burn_octas);

  if (dailyBurn === 0n) {
    return {
      days_remaining: null,
      depletion_date: null,
      confidence: burnRate.confidence,
      note: "Zero burn rate detected.",
    };
  }

  const daysRemaining = Number(balance / dailyBurn);
  const depletionDate = new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000);

  return {
    days_remaining: daysRemaining,
    depletion_date: depletionDate.toISOString(),
    confidence: burnRate.confidence,
    note: "Assumes no incoming APT transfers and constant gas usage.",
  };
}
