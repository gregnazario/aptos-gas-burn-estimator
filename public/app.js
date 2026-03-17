// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  APTOS_API_URL: "https://fullnode.mainnet.aptoslabs.com/v1",
  MAX_CONCURRENT: 2,
  MIN_DELAY_MS: 200,
  MAX_RETRIES: 5,
  BASE_BACKOFF_MS: 200,
  MAX_BACKOFF_MS: 60000,
  TX_PAGE_SIZE: 100,
  DB_NAME: "aptos-gas-estimator",
  DB_VERSION: 1,
};

// ─── Rate Limiter ────────────────────────────────────────────────────────────
class RateLimiter {
  constructor() {
    this._active = 0;
    this._lastRequest = 0;
    this._queue = [];
  }

  _tryAcquire() {
    if (this._active < CONFIG.MAX_CONCURRENT) {
      this._active++;
      return true;
    }
    return false;
  }

  _release() {
    this._active--;
    const next = this._queue.shift();
    if (next) next();
  }

  _waitForSlot() {
    if (this._tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => {
      this._queue.push(() => {
        this._active++;
        resolve();
      });
    });
  }

  async execute(fn) {
    await this._waitForSlot();
    try {
      const now = Date.now();
      const elapsed = now - this._lastRequest;
      if (elapsed < CONFIG.MIN_DELAY_MS) {
        await new Promise((r) => setTimeout(r, CONFIG.MIN_DELAY_MS - elapsed));
      }
      this._lastRequest = Date.now();
      return await this._retryWithBackoff(fn);
    } finally {
      this._release();
    }
  }

  async _retryWithBackoff(fn) {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const is429 = err.status === 429;
        const isServer = err.status >= 500;

        // Client errors (besides 429) are not retryable
        if (!is429 && !isServer) throw err;
        // Server errors give up after MAX_RETRIES; 429s retry forever
        if (isServer && attempt >= CONFIG.MAX_RETRIES) throw err;

        const backoff = is429 && err.retryAfter
          ? err.retryAfter * 1000
          : Math.min(
              CONFIG.BASE_BACKOFF_MS * 2 ** Math.min(attempt, 10) + Math.random() * 1000,
              CONFIG.MAX_BACKOFF_MS,
            );
        console.log(`Rate limiter: ${is429 ? "429" : err.status} on attempt ${attempt + 1}, waiting ${Math.round(backoff)}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        attempt++;
      }
    }
  }
}

const rateLimiter = new RateLimiter();

// ─── Aptos API ───────────────────────────────────────────────────────────────
async function aptosFetch(path) {
  return rateLimiter.execute(async () => {
    const res = await fetch(`${CONFIG.APTOS_API_URL}${path}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const err = new Error(`Aptos API error: ${res.status} ${res.statusText}`);
      err.status = res.status;
      const ra = res.headers.get("Retry-After");
      if (ra) err.retryAfter = parseInt(ra, 10);
      throw err;
    }
    return res.json();
  });
}

async function getAccountInfo(address) {
  return aptosFetch(`/accounts/${address}`);
}

async function getAccountBalance(address) {
  return rateLimiter.execute(async () => {
    const res = await fetch(`${CONFIG.APTOS_API_URL}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        function: "0x1::coin::balance",
        type_arguments: ["0x1::aptos_coin::AptosCoin"],
        arguments: [address],
      }),
    });
    if (!res.ok) {
      const err = new Error(`Aptos API error: ${res.status} ${res.statusText}`);
      err.status = res.status;
      const ra = res.headers.get("Retry-After");
      if (ra) err.retryAfter = parseInt(ra, 10);
      throw err;
    }
    const result = await res.json();
    return result[0] ?? "0";
  });
}

async function getAccountTransactions(address, start, limit) {
  return aptosFetch(`/accounts/${address}/transactions?start=${start}&limit=${limit}`);
}

// ─── IndexedDB ───────────────────────────────────────────────────────────────
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("accounts")) {
        db.createObjectStore("accounts", { keyPath: "address" });
      }
      if (!db.objectStoreNames.contains("transactions")) {
        const store = db.createObjectStore("transactions", {
          keyPath: ["address", "sequence_number"],
        });
        store.createIndex("by_address", "address");
      }
    };
    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbPut(storeName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function dbPutMany(storeName, items) {
  if (items.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const item of items) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function dbGetAllByAddress(address) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("transactions", "readonly");
    const idx = tx.objectStore("transactions").index("by_address");
    const req = idx.getAll(address);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbGetMaxSeq(address) {
  const rows = await dbGetAllByAddress(address);
  if (rows.length === 0) return null;
  return Math.max(...rows.map((r) => r.sequence_number));
}

// ─── Gas Calculation ─────────────────────────────────────────────────────────
function calculateBurnRate(transactions) {
  const txCount = transactions.length;
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

  let totalBurned = 0n;
  let earliestUs = null;
  let latestUs = null;

  for (const tx of transactions) {
    totalBurned += BigInt(tx.gas_cost_octas);
    const ts = tx.timestamp_us;
    if (earliestUs === null || ts < earliestUs) earliestUs = ts;
    if (latestUs === null || ts > latestUs) latestUs = ts;
  }

  if (!earliestUs || !latestUs) {
    return {
      total_gas_burned_octas: totalBurned.toString(),
      transaction_count: txCount,
      avg_daily_burn_octas: "0",
      weighted_daily_burn_octas: "0",
      days_of_history: 0,
      confidence: "none",
    };
  }

  const earliestMs = Number(BigInt(earliestUs) / 1000n);
  const latestMs = Number(BigInt(latestUs) / 1000n);
  const daysOfHistory = Math.max(1, (latestMs - earliestMs) / (1000 * 60 * 60 * 24));

  const avgDailyBurn = totalBurned / BigInt(Math.ceil(daysOfHistory));
  const weightedDailyBurn = calculateWeightedBurn(transactions);
  const confidence = getConfidence(txCount, daysOfHistory);

  return {
    total_gas_burned_octas: totalBurned.toString(),
    transaction_count: txCount,
    avg_daily_burn_octas: avgDailyBurn.toString(),
    weighted_daily_burn_octas: weightedDailyBurn.toString(),
    days_of_history: Math.round(daysOfHistory),
    confidence,
  };
}

function calculateWeightedBurn(transactions) {
  const dayBuckets = bucketTransactions(transactions, "day");
  if (dayBuckets.length === 0) return 0n;

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  let recentTotal = 0n;
  let recentDays = 0;
  let olderTotal = 0n;
  let olderDays = 0;

  for (const b of dayBuckets) {
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

  if (recentDays === 0) {
    return olderDays > 0 ? olderTotal / BigInt(olderDays) : 0n;
  }
  if (olderDays === 0) {
    return recentTotal / BigInt(recentDays);
  }

  // Weighted: recent 30 days gets 2x weight
  const recentAvg = recentTotal / BigInt(recentDays);
  const olderAvg = olderTotal / BigInt(olderDays);
  return (recentAvg * 2n + olderAvg) / 3n;
}

function getConfidence(txCount, daysOfHistory) {
  if (txCount > 100 && daysOfHistory > 30) return "high";
  if (txCount > 20 && daysOfHistory > 7) return "medium";
  if (txCount > 0) return "low";
  return "none";
}

function bucketTransactions(transactions, bucketType) {
  const map = new Map();

  for (const tx of transactions) {
    const tsMs = Number(BigInt(tx.timestamp_us) / 1000n);
    const d = new Date(tsMs);
    let key;

    switch (bucketType) {
      case "hour":
        key =
          d.getUTCFullYear() +
          "-" +
          String(d.getUTCMonth() + 1).padStart(2, "0") +
          "-" +
          String(d.getUTCDate()).padStart(2, "0") +
          "T" +
          String(d.getUTCHours()).padStart(2, "0") +
          ":00:00Z";
        break;
      case "week": {
        const w = new Date(d);
        w.setUTCHours(0, 0, 0, 0);
        const day = w.getUTCDay();
        w.setUTCDate(w.getUTCDate() - day + (day === 0 ? -6 : 1));
        key = w.toISOString().slice(0, 10);
        break;
      }
      case "month":
        key =
          d.getUTCFullYear() +
          "-" +
          String(d.getUTCMonth() + 1).padStart(2, "0") +
          "-01";
        break;
      default:
        key =
          d.getUTCFullYear() +
          "-" +
          String(d.getUTCMonth() + 1).padStart(2, "0") +
          "-" +
          String(d.getUTCDate()).padStart(2, "0");
    }

    if (!map.has(key)) {
      map.set(key, { bucket: key, total_gas_octas: "0", tx_count: 0 });
    }
    const b = map.get(key);
    b.total_gas_octas = (BigInt(b.total_gas_octas) + BigInt(tx.gas_cost_octas)).toString();
    b.tx_count++;
  }

  return Array.from(map.values()).sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

function octasToApt(octas) {
  if (!octas || octas === "0") return "0";
  const n = BigInt(octas);
  const whole = n / 100000000n;
  const frac = n % 100000000n;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

// ─── Alpine.js Component ─────────────────────────────────────────────────────
document.addEventListener("alpine:init", () => {
  Alpine.data("gasEstimator", () => ({
    // State
    address: "",
    loading: false,
    error: null,
    account: null,
    syncing: false,
    syncProgress: null,
    burnChartData: null,
    selectedBucket: "day",
    transactions: [],
    pagination: null,
    currentPage: 1,
    chart: null,
    rateMultiplier: 1,
    multipliers: [1, 5, 10, 20, 50, 100, 500, 1000],
    _allTransactions: [],
    _syncGen: 0,

    init() {
      openDB();

      const params = new URLSearchParams(window.location.search);
      const addr = params.get("address");
      if (addr) {
        this.address = addr;
        this.analyze();
      }
      window.addEventListener("popstate", () => {
        const p = new URLSearchParams(window.location.search);
        const a = p.get("address") || "";
        if (a !== this.address) {
          this.address = a;
          if (a) this.analyze();
        }
      });
    },

    // Computed
    get balanceApt() {
      return this.account?.balance_apt ?? "0";
    },

    get dailyBurnOctas() {
      return this.account?.burn_rate?.weighted_daily_burn_octas ?? "0";
    },

    get adjustedDailyBurnOctas() {
      if (this.dailyBurnOctas === "0") return "0";
      return (BigInt(this.dailyBurnOctas) * BigInt(this.rateMultiplier)).toString();
    },

    get dailyBurnApt() {
      return this.octasToApt(this.adjustedDailyBurnOctas);
    },

    get baseDailyBurnApt() {
      return this.octasToApt(this.dailyBurnOctas);
    },

    get daysRemaining() {
      if (!this.account?.balance_octas || this.adjustedDailyBurnOctas === "0") return null;
      const balance = BigInt(this.account.balance_octas);
      const burn = BigInt(this.adjustedDailyBurnOctas);
      if (burn === 0n) return null;
      return Number(balance / burn);
    },

    get depletionDate() {
      if (this.daysRemaining === null) return null;
      const date = new Date(Date.now() + this.daysRemaining * 24 * 60 * 60 * 1000);
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    },

    get confidence() {
      return this.account?.depletion?.confidence ?? "none";
    },

    get syncPercent() {
      if (!this.syncProgress || this.syncProgress.total === 0) return 0;
      return Math.min(100, Math.round((this.syncProgress.synced / this.syncProgress.total) * 100));
    },

    get daysRemainingColor() {
      if (this.daysRemaining === null) return "";
      if (this.daysRemaining > 365) return "card__value--green";
      if (this.daysRemaining > 90) return "card__value--amber";
      return "card__value--red";
    },

    // Actions
    async analyze() {
      const addr = this.address.trim();
      if (!addr) return;
      if (!/^0x[a-fA-F0-9]{1,64}$/.test(addr)) {
        this.error = "Invalid Aptos address. Must start with 0x followed by hex characters.";
        return;
      }

      const url = new URL(window.location);
      url.searchParams.set("address", addr);
      history.pushState(null, "", url);

      this.error = null;
      this.loading = true;
      this.account = null;
      this.rateMultiplier = 1;
      this.transactions = [];
      this.pagination = null;
      this.burnChartData = null;
      this._allTransactions = [];
      this._syncGen++;
      const gen = this._syncGen;

      try {
        // Fetch account info + balance from Aptos API
        const accountInfo = await getAccountInfo(addr);
        const totalTxCount = parseInt(accountInfo.sequence_number, 10);

        let balance = "0";
        try {
          balance = await getAccountBalance(addr);
        } catch {
          // Account may not have CoinStore resource
        }

        this.account = {
          address: addr,
          balance_octas: balance,
          balance_apt: octasToApt(balance),
          sequence_number: totalTxCount,
          burn_rate: {
            total_gas_burned_octas: "0",
            transaction_count: 0,
            weighted_daily_burn_octas: "0",
            days_of_history: 0,
            confidence: "none",
          },
          depletion: { confidence: "none" },
        };

        // Load cached data from IndexedDB
        await this._loadFromDB(addr);
        this.loading = false;

        // Sync remaining transactions
        if (gen === this._syncGen) {
          await this._syncTransactions(addr, totalTxCount, balance, gen);
        }
      } catch (e) {
        this.error = e.message;
        this.loading = false;
      }
    },

    async _loadFromDB(addr) {
      this._allTransactions = await dbGetAllByAddress(addr);
      if (this._allTransactions.length > 0) {
        this._recalculate();
        this._paginateTransactions();
        this._computeBurnChart();
      }
    },

    _recalculate() {
      const burnRate = calculateBurnRate(this._allTransactions);
      this.account = {
        ...this.account,
        burn_rate: burnRate,
        depletion: { confidence: burnRate.confidence },
      };
    },

    _paginateTransactions() {
      const sorted = [...this._allTransactions].sort(
        (a, b) => b.sequence_number - a.sequence_number,
      );
      const limit = 50;
      const total = sorted.length;
      const totalPages = Math.ceil(total / limit);
      const start = (this.currentPage - 1) * limit;

      this.transactions = sorted.slice(start, start + limit).map((tx) => ({
        hash: tx.hash,
        timestamp_iso: new Date(Number(BigInt(tx.timestamp_us) / 1000n)).toISOString(),
        gas_used: tx.gas_used,
        gas_unit_price: tx.gas_unit_price,
        gas_cost_apt: octasToApt(tx.gas_cost_octas),
        success: tx.success === 1,
      }));

      this.pagination = { total, total_pages: totalPages, page: this.currentPage };
    },

    _computeBurnChart() {
      const buckets = bucketTransactions(this._allTransactions, this.selectedBucket);
      this.burnChartData = buckets.map((b) => ({
        bucket: b.bucket,
        total_gas_apt: octasToApt(b.total_gas_octas),
      }));
      this.$nextTick(() => this.renderChart());
    },

    async _syncTransactions(addr, totalTxCount, balance, gen) {
      if (totalTxCount === 0) {
        await dbPut("accounts", {
          address: addr,
          balance_octas: balance,
          sequence_number: totalTxCount,
          last_synced_at: new Date().toISOString(),
        });
        return;
      }

      const maxStored = await dbGetMaxSeq(addr);
      const startFrom = maxStored !== null ? maxStored + 1 : 0;

      if (startFrom >= totalTxCount) {
        await dbPut("accounts", {
          address: addr,
          balance_octas: balance,
          sequence_number: totalTxCount,
          last_synced_at: new Date().toISOString(),
        });
        return;
      }

      this.syncing = true;
      this.syncProgress = { total: totalTxCount, synced: startFrom };

      let cursor = startFrom;
      try {
        while (cursor < totalTxCount) {
          if (gen !== this._syncGen) return; // cancelled

          const batch = await getAccountTransactions(addr, cursor, CONFIG.TX_PAGE_SIZE);
          if (batch.length === 0) break;

          const rows = batch
            .filter((tx) => tx.type === "user_transaction")
            .map((tx) => ({
              address: addr,
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
            await dbPutMany("transactions", rows);
          }

          cursor += batch.length;
          this.syncProgress = { total: totalTxCount, synced: cursor };

          if (batch.length < CONFIG.TX_PAGE_SIZE) break;
        }

        // Reload everything from IndexedDB after sync
        if (gen === this._syncGen) {
          await this._loadFromDB(addr);
        }
      } finally {
        if (gen === this._syncGen) {
          this.syncing = false;
          this.syncProgress = null;
        }
        await dbPut("accounts", {
          address: addr,
          balance_octas: balance,
          sequence_number: totalTxCount,
          last_synced_at: new Date().toISOString(),
        });
      }
    },

    async changeBucket(bucket) {
      this.selectedBucket = bucket;
      if (this._allTransactions.length > 0) {
        this._computeBurnChart();
      }
    },

    async goToPage(page) {
      this.currentPage = page;
      this._paginateTransactions();
    },

    renderChart() {
      const canvas = document.getElementById("burnChart");
      if (!canvas || !this.burnChartData?.length) return;

      if (this.chart) this.chart.destroy();

      const labels = this.burnChartData.map((d) => d.bucket);
      const values = this.burnChartData.map((d) => parseFloat(d.total_gas_apt));

      this.chart = new Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Gas Burned (APT)",
              data: values,
              borderColor: "#f59e0b",
              backgroundColor: "rgba(245, 158, 11, 0.08)",
              borderWidth: 2,
              fill: true,
              tension: 0.3,
              pointRadius: values.length > 60 ? 0 : 3,
              pointHoverRadius: 5,
              pointBackgroundColor: "#f59e0b",
              pointBorderColor: "#0a0b0f",
              pointBorderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            intersect: false,
            mode: "index",
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "#1a1d2a",
              titleColor: "#7c8194",
              bodyColor: "#e8eaf0",
              borderColor: "#1e2233",
              borderWidth: 1,
              titleFont: { family: "JetBrains Mono", size: 11 },
              bodyFont: { family: "JetBrains Mono", size: 12 },
              padding: 10,
              displayColors: false,
              callbacks: {
                label: (ctx) => `${ctx.parsed.y.toFixed(6)} APT`,
              },
            },
          },
          scales: {
            x: {
              grid: { color: "rgba(30, 34, 51, 0.5)", drawBorder: false },
              ticks: {
                color: "#4a4f64",
                font: { family: "JetBrains Mono", size: 10 },
                maxRotation: 45,
                maxTicksLimit: 12,
              },
            },
            y: {
              grid: { color: "rgba(30, 34, 51, 0.5)", drawBorder: false },
              ticks: {
                color: "#4a4f64",
                font: { family: "JetBrains Mono", size: 10 },
              },
              beginAtZero: true,
            },
          },
        },
      });
    },

    formatHash(hash) {
      if (!hash) return "";
      return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
    },

    explorerUrl(hash) {
      return `https://explorer.aptoslabs.com/txn/${hash}?network=mainnet`;
    },

    formatDate(isoStr) {
      if (!isoStr) return "";
      return new Date(isoStr).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    },

    formatNumber(n) {
      if (n === null || n === undefined) return "\u2014";
      return Number(n).toLocaleString();
    },

    formatDaysRemaining(days) {
      if (days === null || days === undefined) return "\u2014";
      if (days > 36500) return "100+ yrs";
      if (days > 365) return `${(days / 365).toFixed(1)} yrs`;
      return `${days.toLocaleString()} days`;
    },

    octasToApt,
  }));
});
