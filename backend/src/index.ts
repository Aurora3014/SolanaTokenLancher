import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { keypairOf, store, type StoredWallet } from "./store.js";
import {
  airdrop,
  connection,
  getMintBalances,
  getSolBalances,
  getTokenHoldings,
  lamportsToSol,
  multiTransfer,
  solToLamports,
  sweepWallet,
  transferSol,
} from "./solana.js";
import { buyToken, launchToken, listTokens } from "./pump.js";
import { jitoMode } from "./jito.js";
import { apiLogger } from "./logger.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(apiLogger);
// Locally hosted token metadata + images (see METADATA_UPLOAD).
app.use("/metadata", express.static(path.join(config.dataDir, "metadata")));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

class HttpError extends Error {
  constructor(public status: number, message: string, public data?: unknown) {
    super(message);
  }
}

function walletOr404(id: string): StoredWallet {
  const w = store.getWallet(id);
  if (!w) throw new HttpError(404, "Wallet not found");
  return w;
}

function mainOr400() {
  const main = store.getMain();
  if (!main) throw new HttpError(400, "Select a main wallet first");
  return main;
}

function parsePubkey(value: unknown, field: string): PublicKey {
  try {
    return new PublicKey(String(value));
  } catch {
    throw new HttpError(400, `${field} is not a valid Solana address`);
  }
}

app.get("/api/config", (_req, res) => {
  res.json({
    cluster: config.cluster,
    rpcUrl: config.rpcUrl,
    walletCount: config.walletCount,
    fundAmountSol: config.fundAmountSol,
    airdropSol: airdropEnabled() ? config.airdropSol : 0,
    devBuySol: config.devBuySol,
    buyAmountSol: config.buyAmountSol,
    slippagePercent: config.slippagePercent,
    buyDelayMs: config.buyDelayMs,
    buyersPerTx: config.buyersPerTx,
    // Effective mode: false when JITO_ENABLED can't work on this cluster.
    ...(() => {
      try {
        const j = jitoMode();
        return { jitoEnabled: j.usable, jitoNote: j.note };
      } catch (e) {
        return { jitoEnabled: false, jitoNote: (e as Error).message };
      }
    })(),
    jitoTipSol: config.jitoTipSol,
  });
});

app.get("/api/wallets", async (req, res) => {
  const wallets = store.listWallets();
  const pubkeys = wallets.map((w) => new PublicKey(w.publicKey));
  const sol = await getSolBalances(pubkeys);
  const mint = typeof req.query.mint === "string" && req.query.mint ? parsePubkey(req.query.mint, "mint") : null;
  const tokens = mint ? await getMintBalances(mint, pubkeys) : null;
  res.json(
    wallets.map((w, i) => ({
      id: w.id,
      publicKey: w.publicKey,
      isMain: w.isMain,
      createdAt: w.createdAt,
      sol: lamportsToSol(sol[i]),
      tokenBalance: tokens ? tokens[i] : null,
    })),
  );
});

const airdropEnabled = () => config.airdropSol > 0 && config.cluster !== "mainnet-beta";

/** Generate WALLET_COUNT wallets, then airdrop AIRDROP_AMOUNT_SOL to each (test networks only). */
app.post("/api/wallets/generate", async (_req, res) => {
  const created = store.generate(config.walletCount);
  if (!airdropEnabled()) return res.json({ created: created.length, airdropped: 0, airdropErrors: [] });
  const results = await airdrop(created.map((w) => new PublicKey(w.publicKey)), solToLamports(config.airdropSol));
  const errors = results.filter((r) => r.error);
  res.json({ created: created.length, airdropped: results.length - errors.length, airdropErrors: errors });
});

/** Airdrop AIRDROP_AMOUNT_SOL to the given wallets, or to all wallets. */
app.post("/api/wallets/airdrop", async (req, res) => {
  if (!airdropEnabled()) throw new HttpError(400, "Airdrop is disabled (AIRDROP_AMOUNT_SOL=0 or mainnet)");
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : null;
  const wallets = store.listWallets().filter((w) => !ids || ids.includes(w.id));
  const results = await airdrop(wallets.map((w) => new PublicKey(w.publicKey)), solToLamports(config.airdropSol));
  const errors = results.filter((r) => r.error);
  res.json({ airdropped: results.length - errors.length, airdropErrors: errors });
});

app.post("/api/wallets/import", (req, res) => {
  try {
    const w = store.importWallet(String(req.body?.secretKey ?? ""));
    res.json({ id: w.id, publicKey: w.publicKey });
  } catch {
    throw new HttpError(400, "Invalid base58 private key");
  }
});

app.post("/api/wallets/:id/main", (req, res) => {
  walletOr404(req.params.id);
  store.setMain(req.params.id);
  res.json({ ok: true });
});

app.get("/api/wallets/:id/holdings", async (req, res) => {
  const w = walletOr404(req.params.id);
  const pk = new PublicKey(w.publicKey);
  const [lamports, tokens] = await Promise.all([connection.getBalance(pk), getTokenHoldings(pk)]);
  res.json({ sol: lamportsToSol(lamports), tokens });
});

app.get("/api/wallets/:id/secret", (req, res) => {
  const w = walletOr404(req.params.id);
  res.json({ publicKey: w.publicKey, secretKey: w.secretKey });
});

/** Refuses with 409 + holdings if the wallet still has SOL or tokens, unless ?force=true. */
app.delete("/api/wallets/:id", async (req, res) => {
  const w = walletOr404(req.params.id);
  if (req.query.force !== "true") {
    const pk = new PublicKey(w.publicKey);
    const [lamports, tokens] = await Promise.all([connection.getBalance(pk), getTokenHoldings(pk)]);
    const nonEmpty = tokens.filter((t) => BigInt(t.amount) > 0n);
    if (lamports > 0 || nonEmpty.length > 0) {
      throw new HttpError(409, "Wallet still holds funds", { sol: lamportsToSol(lamports), tokens: nonEmpty });
    }
  }
  store.remove(w.id);
  res.json({ ok: true });
});

/** Move all SOL and tokens out of a wallet; defaults to the main wallet as destination. */
app.post("/api/wallets/:id/sweep", async (req, res) => {
  const w = walletOr404(req.params.id);
  const main = store.getMain();
  const destination = req.body?.destination
    ? parsePubkey(req.body.destination, "destination")
    : main
      ? new PublicKey(main.publicKey)
      : null;
  if (!destination) throw new HttpError(400, "No destination given and no main wallet selected");
  if (destination.toBase58() === w.publicKey) throw new HttpError(400, "Destination is the wallet itself");
  const signatures = await sweepWallet(keypairOf(w), destination, main ? keypairOf(main) : undefined);
  res.json({ signatures });
});

app.post("/api/main/withdraw", async (req, res) => {
  const main = mainOr400();
  const to = parsePubkey(req.body?.to, "to");
  const amount = req.body?.amountSol === "max" ? "max" : Number(req.body?.amountSol);
  if (amount !== "max" && !(amount > 0)) throw new HttpError(400, "amountSol must be a positive number or \"max\"");
  const signature = await transferSol(keypairOf(main), to, amount === "max" ? "max" : solToLamports(amount));
  res.json({ signature });
});

/** Top every non-main wallet up to FUND_AMOUNT_SOL (or the given amount) from the main wallet. */
app.post("/api/wallets/fund", async (req, res) => {
  const main = mainOr400();
  const target = solToLamports(Number(req.body?.amountSol) > 0 ? Number(req.body.amountSol) : config.fundAmountSol);
  const others = store.listWallets().filter((w) => !w.isMain);
  const balances = await getSolBalances(others.map((w) => new PublicKey(w.publicKey)));
  const transfers = others
    .map((w, i) => ({ to: new PublicKey(w.publicKey), lamports: target - balances[i] }))
    .filter((t) => t.lamports > 0);
  if (transfers.length === 0) return res.json({ signatures: [], funded: 0 });
  const signatures = await multiTransfer(keypairOf(main), transfers);
  res.json({ signatures, funded: transfers.length });
});

/** Sweep SOL and tokens from every non-main wallet back to the main wallet. */
app.post("/api/wallets/collect", async (_req, res) => {
  const main = mainOr400();
  const mainKp = keypairOf(main);
  const results: { publicKey: string; signatures?: string[]; error?: string }[] = [];
  for (const w of store.listWallets().filter((x) => !x.isMain)) {
    try {
      results.push({ publicKey: w.publicKey, signatures: await sweepWallet(keypairOf(w), mainKp.publicKey, mainKp) });
    } catch (e) {
      results.push({ publicKey: w.publicKey, error: e instanceof Error ? e.message : String(e) });
    }
  }
  res.json({ results });
});

app.post("/api/launch", upload.single("image"), async (req, res) => {
  const b = req.body as Record<string, string | undefined>;
  const name = b.name?.trim();
  const symbol = b.symbol?.trim();
  if (!name || !symbol) throw new HttpError(400, "Token name and symbol are required");
  if (name.length > 32 || symbol.length > 10) throw new HttpError(400, "Name max 32 chars, symbol max 10 chars");
  const buyerIds = b.buyerIds ? (JSON.parse(b.buyerIds) as string[]) : undefined;
  const result = await launchToken(
    {
      name,
      symbol,
      description: b.description,
      twitter: b.twitter,
      telegram: b.telegram,
      website: b.website,
      metadataUri: b.metadataUri?.trim() || undefined,
      image: req.file ? { buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname } : undefined,
    },
    buyerIds,
  );
  res.json(result);
});

/** Launched tokens with live bonding-curve stats and holdings across stored wallets. */
app.get("/api/tokens", async (_req, res) => {
  res.json(await listTokens());
});

/** Buy an existing token with the given wallets, amountSol each. */
app.post("/api/tokens/:mint/buy", async (req, res) => {
  const mint = parsePubkey(req.params.mint, "mint").toBase58();
  const amountSol = Number(req.body?.amountSol);
  const walletIds = Array.isArray(req.body?.walletIds) ? (req.body.walletIds as string[]) : [];
  if (!(amountSol > 0)) throw new HttpError(400, "amountSol must be a positive number");
  if (walletIds.length === 0) throw new HttpError(400, "Select at least one wallet");
  res.json(await buyToken(mint, walletIds, amountSol));
});

app.get("/api/launches", (_req, res) => {
  res.json(store.listLaunches());
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, data: err.data });
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
});

app.listen(config.port, config.host, () => {
  console.log(`Token launcher API on http://${config.host}:${config.port} (${config.cluster}, RPC ${config.rpcUrl})`);
  try {
    const j = jitoMode();
    console.log(`Buy mode: ${j.usable ? `Jito bundle via ${config.jitoBlockEngineUrl}` : "sequential"}`);
    if (j.note) console.warn(`⚠ ${j.note}`);
  } catch (e) {
    console.error(`⚠ ${(e as Error).message}`);
  }
});
