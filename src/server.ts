import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { router } from "./api/routes.js";
import { CONFIG } from "./config.js";
import { getDb } from "./db/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, "..", "public")));

// API routes
app.use("/api", router);

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Initialize database on startup
getDb();

app.listen(CONFIG.PORT, () => {
  console.log(`Aptos Gas Estimator running at http://localhost:${CONFIG.PORT}`);
});
