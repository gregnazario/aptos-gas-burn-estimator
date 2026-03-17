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
    pollTimer: null,
    rateMultiplier: 1,
    multipliers: [1, 5, 10, 20, 50, 100, 500, 1000],

    init() {
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

      // Update URL so the address is shareable
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

      try {
        // Fetch account info
        const res = await fetch(`/api/account/${addr}`);
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        this.account = await res.json();

        // Start sync
        await this.startSync(addr);

        // Load existing data
        await Promise.all([this.loadTransactions(addr), this.loadBurnChart(addr)]);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    async startSync(addr) {
      try {
        const res = await fetch(`/api/account/${addr}/sync`, { method: "POST" });
        const data = await res.json();

        if (data.status === "syncing") {
          this.syncing = true;
          this.syncProgress = { total: data.totalTransactions, synced: data.syncedTransactions };
          this.startPolling(addr);
        }
      } catch (e) {
        console.error("Sync start error:", e);
      }
    },

    startPolling(addr) {
      this.stopPolling();
      this.pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/account/${addr}/sync-status`);
          const data = await res.json();

          if (data.status === "syncing") {
            this.syncProgress = { total: data.totalTransactions, synced: data.syncedTransactions };
          } else {
            this.syncing = false;
            this.syncProgress = null;
            this.stopPolling();

            // Refresh data after sync completes
            await this.refreshAll(addr);
          }
        } catch (e) {
          console.error("Poll error:", e);
        }
      }, 2000);
    },

    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    },

    async refreshAll(addr) {
      await Promise.all([this.refreshAccount(addr), this.loadTransactions(addr), this.loadBurnChart(addr)]);
    },

    async refreshAccount(addr) {
      try {
        const res = await fetch(`/api/account/${addr}`);
        if (res.ok) this.account = await res.json();
      } catch (e) {
        console.error("Refresh error:", e);
      }
    },

    async loadTransactions(addr) {
      try {
        const res = await fetch(`/api/account/${addr}/transactions?page=${this.currentPage}&limit=50&sort=desc`);
        if (res.ok) {
          const data = await res.json();
          this.transactions = data.transactions;
          this.pagination = data.pagination;
        }
      } catch (e) {
        console.error("Transactions error:", e);
      }
    },

    async loadBurnChart(addr) {
      try {
        const res = await fetch(`/api/account/${addr}/burn-rate?bucket=${this.selectedBucket}`);
        if (res.ok) {
          const data = await res.json();
          this.burnChartData = data.data;
          this.$nextTick(() => this.renderChart());
        }
      } catch (e) {
        console.error("Chart error:", e);
      }
    },

    async changeBucket(bucket) {
      this.selectedBucket = bucket;
      if (this.address.trim()) {
        await this.loadBurnChart(this.address.trim());
      }
    },

    async goToPage(page) {
      this.currentPage = page;
      if (this.address.trim()) {
        await this.loadTransactions(this.address.trim());
      }
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
      if (n === null || n === undefined) return "—";
      return Number(n).toLocaleString();
    },

    formatDaysRemaining(days) {
      if (days === null || days === undefined) return "—";
      if (days > 36500) return "100+ yrs";
      if (days > 365) return `${(days / 365).toFixed(1)} yrs`;
      return `${days.toLocaleString()} days`;
    },

    octasToApt(octas) {
      if (!octas || octas === "0") return "0";
      const n = BigInt(octas);
      const whole = n / 100000000n;
      const frac = n % 100000000n;
      const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
      return fracStr ? `${whole}.${fracStr}` : whole.toString();
    },
  }));
});
