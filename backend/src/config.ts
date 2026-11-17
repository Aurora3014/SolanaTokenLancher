import path from "node:path";
import dotenv from "dotenv";

// The single .env lives at the project root, shared by backend and frontend tooling.
const rootDir = path.resolve(__dirname, "..", "..");
// override: .env wins over variables already set in the shell, so editing .env always takes effect.
const envFile = path.join(rootDir, ".env");
const loaded = dotenv.config({ path: envFile, override: true, quiet: true });
if (loaded.error) console.warn(`⚠ Could not read ${envFile} (${loaded.error.message}); using defaults`);

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env variable ${name}`);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Env variable ${name} must be a number, got "${raw}"`);
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export const config = {
  // Every value comes from .env; the second argument is only used when the variable is missing.
  port: num("PORT", 4000),
  host: str("HOST", "127.0.0.1"),
  dataDir: path.resolve(rootDir, str("DATA_DIR", "./data")),

  // forknet = a local/remote mainnet fork (e.g. Surfpool) whose RPC also accepts Jito sendBundle.
  cluster: str("SOLANA_CLUSTER", "devnet") as "devnet" | "testnet" | "mainnet-beta" | "forknet",
  rpcUrl: str("RPC_URL", "https://api.devnet.solana.com"),
  wsUrl: process.env.WS_URL?.trim() || undefined,

  walletCount: Math.max(1, Math.floor(num("WALLET_COUNT", 5))),
  fundAmountSol: num("FUND_AMOUNT_SOL", 0.12),
  // SOL requested from the RPC faucet for each newly generated wallet. 0 disables; never used on mainnet.
  airdropSol: num("AIRDROP_AMOUNT_SOL", 5),

  devBuySol: num("DEV_BUY_AMOUNT_SOL", 0.1),
  buyAmountSol: num("BUY_AMOUNT_SOL", 0.1),
  slippagePercent: num("SLIPPAGE_PERCENT", 15),
  buyDelayMs: Math.max(0, num("BUY_DELAY_MS", 0)),
  buyersPerTx: Math.min(4, Math.max(1, Math.floor(num("BUYERS_PER_TX", 3)))),

  priorityFeeMicroLamports: Math.floor(num("PRIORITY_FEE_MICROLAMPORTS", 100_000)),

  jitoEnabled: bool("JITO_ENABLED", false),
  // Empty = the default for the cluster: Jito's mainnet/testnet block engine, or the RPC itself on forknet.
  jitoBlockEngineUrl: "",
  jitoTipSol: num("JITO_TIP_SOL", 0.001),

  pumpIpfsUrl: str("PUMP_IPFS_URL", "https://pump.fun/api/ipfs"),
  // auto = pump.fun IPFS, falling back to hosting on this server off mainnet; pumpfun = IPFS only; local = this server only.
  metadataUpload: str("METADATA_UPLOAD", "auto") as "auto" | "pumpfun" | "local",
  // Base URL put into locally hosted metadata URIs (what wallets and explorers fetch).
  publicUrl: "",
};
config.jitoBlockEngineUrl =
  process.env.JITO_BLOCK_ENGINE_URL?.trim() ||
  (config.cluster === "forknet"
    ? config.rpcUrl
    : config.cluster === "testnet"
      ? "https://testnet.block-engine.jito.wtf"
      : "https://mainnet.block-engine.jito.wtf");
config.publicUrl = (process.env.PUBLIC_URL?.trim() || `http://${config.host}:${config.port}`).replace(/\/$/, "");

export type AppConfig = typeof config;
