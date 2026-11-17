import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  newBondingCurve,
  bondingCurveMarketCap,
  bondingCurvePda,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
import { config } from "./config.js";
import { buildTx, connection, getMintBalances, getSolBalances, lamportsToSol, priorityIxs, solToLamports } from "./solana.js";
import { MAX_BUNDLE_TXS, getInflightBundleStatus, getTipAccount, jitoMode, sendBundle } from "./jito.js";
import { keypairOf, store, type LaunchRecord, type StoredWallet } from "./store.js";

const MAX_TX_BYTES = 1232;
// Measured on devnet: create_v2 ~110k CU, one buy incl. ATA creation ~95k CU.
const CREATE_CU = 200_000;
const BUY_CU_PER_WALLET = 130_000;
// Room kept free in each tx for the Jito tip transfer appended at send time.
const TIP_IX_RESERVE_BYTES = 60;
// Rent + fees for the mint, bonding curve, metadata and creator ATA, rounded up.
const CREATE_OVERHEAD_SOL = 0.03;
// Buyer ATA rent, volume accumulator rent and tx fees, rounded up.
const BUY_OVERHEAD_SOL = 0.006;

export interface TokenMetadataInput {
  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  image?: { buffer: Buffer; mimetype: string; originalname: string };
  metadataUri?: string;
}

/**
 * Resolve the metadata URI stored on-chain: a URI given by the user, an upload to pump.fun's IPFS,
 * or JSON + image hosted by this server (METADATA_UPLOAD=local, or auto-fallback off mainnet).
 */
export async function resolveMetadataUri(input: TokenMetadataInput): Promise<{ uri: string; warning?: string }> {
  if (input.metadataUri) return { uri: input.metadataUri };
  if (!input.image) throw new Error("Provide a token image or a metadata URI");
  if (config.metadataUpload === "local") return { uri: hostMetadataLocally(input) };

  try {
    return { uri: await uploadToPumpIpfs(input) };
  } catch (e) {
    const reason = e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e);
    // On mainnet a localhost URI would leave the token without an image on pump.fun, so fail loudly.
    if (config.metadataUpload === "pumpfun" || config.cluster === "mainnet-beta") {
      throw new Error(`Metadata upload to ${config.pumpIpfsUrl} failed (${reason}). Fix network access or pass a metadata URI.`);
    }
    return {
      uri: hostMetadataLocally(input),
      warning: `pump.fun metadata upload failed (${reason}); metadata is hosted by this server instead`,
    };
  }
}

function hostMetadataLocally(input: TokenMetadataInput): string {
  const image = input.image!;
  const id = crypto.randomUUID();
  const ext = path.extname(image.originalname).toLowerCase() || `.${image.mimetype.split("/")[1] ?? "png"}`;
  const dir = path.join(config.dataDir, "metadata");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}${ext}`), image.buffer);
  const metadata = {
    name: input.name,
    symbol: input.symbol,
    description: input.description ?? "",
    image: `${config.publicUrl}/metadata/${id}${ext}`,
    showName: true,
    twitter: input.twitter || undefined,
    telegram: input.telegram || undefined,
    website: input.website || undefined,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(metadata, null, 2));
  return `${config.publicUrl}/metadata/${id}.json`;
}

async function uploadToPumpIpfs(input: TokenMetadataInput): Promise<string> {
  const image = input.image!;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(image.buffer)], { type: image.mimetype }), image.originalname);
  form.append("name", input.name);
  form.append("symbol", input.symbol);
  form.append("description", input.description ?? "");
  form.append("twitter", input.twitter ?? "");
  form.append("telegram", input.telegram ?? "");
  form.append("website", input.website ?? "");
  form.append("showName", "true");

  const res = await fetch(config.pumpIpfsUrl, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Metadata upload failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { metadataUri?: string };
  if (!body.metadataUri) throw new Error("Metadata upload returned no metadataUri");
  return body.metadataUri;
}

/** Advance the simulated curve so the next buyer in the bundle is quoted against post-buy reserves. */
function applyBuy(curve: BondingCurve, tokens: BN) {
  const solIn = tokens
    .mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.sub(tokens))
    .addn(1);
  curve.virtualTokenReserves = curve.virtualTokenReserves.sub(tokens);
  curve.virtualQuoteReserves = curve.virtualQuoteReserves.add(solIn);
  curve.realTokenReserves = curve.realTokenReserves.sub(tokens);
  curve.realQuoteReserves = curve.realQuoteReserves.add(solIn);
}

function quote(global: Global, feeConfig: FeeConfig | null, curve: BondingCurve | null, lamports: number) {
  return getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: curve ? global.tokenTotalSupply : null,
    bondingCurve: curve,
    amount: new BN(lamports),
    quoteMint: PublicKey.default,
  });
}

interface PlannedTx {
  label: string;
  payer: PublicKey;
  /** Every key that must sign; resolved to keypairs only when sending. */
  signerKeys: PublicKey[];
  ixs: TransactionInstruction[];
}

export interface LaunchPlanInput {
  main: PublicKey;
  buyers: PublicKey[];
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  buyersPerTx: number;
}

/**
 * Build the create (+ dev buy) instructions and the buyer transactions, in send order.
 * Buyers are quoted against a locally simulated curve, since in a bundle the curve
 * doesn't exist on-chain yet when the transactions are built.
 */
export async function planLaunch(input: LaunchPlanInput): Promise<PlannedTx[]> {
  const { main, mint } = input;
  const online = new OnlinePumpSdk(connection);
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig().catch(() => null);

  const curve = newBondingCurve(global);
  curve.creator = main;
  // newBondingCurve copies global.mayhemModeEnabled (true on mainnet), but we create with
  // mayhemMode: false. A mismatch makes buys pay the reserved mayhem fee recipient → NotAuthorized (6000).
  curve.isMayhemMode = false;

  const createIx = await PUMP_SDK.createV2Instruction({
    mint,
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    creator: main,
    user: main,
    mayhemMode: false,
  });
  const planned: PlannedTx[] = [
    { label: "create", payer: main, signerKeys: [main, mint], ixs: [...priorityIxs(CREATE_CU), createIx] },
  ];

  // The dev buy is just the first buy on the fresh curve, made by the main wallet.
  const buys: { user: PublicKey; label: string; lamports: number }[] = [];
  const devLamports = solToLamports(config.devBuySol);
  if (devLamports > 0) buys.push({ user: main, label: "dev", lamports: devLamports });
  const buyLamports = solToLamports(config.buyAmountSol);
  for (const b of input.buyers) buys.push({ user: b, label: short(b), lamports: buyLamports });

  const entries: { user: PublicKey; label: string; ixs: TransactionInstruction[] }[] = [];
  for (const b of buys) {
    // Quoting a null curve uses the program's fresh-curve path; afterwards the simulated curve.
    const isFirst = entries.length === 0;
    const tokens = quote(global, feeConfig, isFirst ? null : curve, b.lamports);
    const ixs = await PUMP_SDK.buyInstructions({
      global,
      // Only `creator` / `isMayhemMode` of the curve are read; the account doesn't exist yet.
      bondingCurveAccountInfo: null as never,
      bondingCurve: curve,
      associatedUserAccountInfo: null,
      mint,
      user: b.user,
      amount: tokens,
      solAmount: new BN(b.lamports),
      slippage: config.slippagePercent,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    applyBuy(curve, tokens);
    entries.push({ user: b.user, label: b.label, ixs });
  }

  // Pack buys into as few transactions as fit, keeping bundle order.
  const toTx = (group: typeof entries): PlannedTx => ({
    label: `buy: ${group.map((e) => e.label).join(", ")}`,
    payer: group[0].user,
    signerKeys: group.map((e) => e.user),
    ixs: [...priorityIxs(BUY_CU_PER_WALLET * group.length), ...group.flatMap((e) => e.ixs)],
  });
  let group: typeof entries = [];
  for (const e of entries) {
    const candidate = [...group, e];
    if (group.length > 0 && (candidate.length > input.buyersPerTx || txSize(toTx(candidate)) > MAX_TX_BYTES - TIP_IX_RESERVE_BYTES)) {
      planned.push(toTx(group));
      group = [e];
    } else {
      group = candidate;
    }
  }
  if (group.length > 0) planned.push(toTx(group));
  return planned;
}

function txSize(p: PlannedTx): number {
  const msg = new TransactionMessage({ payerKey: p.payer, recentBlockhash: PublicKey.default.toBase58(), instructions: p.ixs }).compileToV0Message();
  // serialize() pads placeholder signatures, so this is the real wire size.
  return new VersionedTransaction(msg).serialize().length;
}

type Signable = PlannedTx & { signers: Keypair[] };

function sign(p: Signable, blockhash: string, extraIxs: TransactionInstruction[] = []): VersionedTransaction {
  return buildTx(p.payer, [...p.ixs, ...extraIxs], p.signers, blockhash);
}

async function waitForSignatures(signatures: string[], timeoutMs = 90_000) {
  const result = new Map<string, { ok: boolean; error?: string }>();
  const deadline = Date.now() + timeoutMs;
  while (result.size < signatures.length && Date.now() < deadline) {
    const pending = signatures.filter((s) => !result.has(s));
    const { value } = await connection.getSignatureStatuses(pending);
    value.forEach((st, i) => {
      if (!st) return;
      if (st.err) result.set(pending[i], { ok: false, error: JSON.stringify(st.err) });
      else if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") result.set(pending[i], { ok: true });
    });
    if (result.size < signatures.length) await sleep(1500);
  }
  return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a bundle lands, Jito reports it failed/invalid, or the timeout passes.
 * Landing is also detected through the RPC, since Jito's status lags a little.
 */
async function waitForBundle(bundleId: string, sigs: string[], timeoutMs = 60_000): Promise<{ landed: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([sigs[0]]);
    if (value[0] && (value[0].confirmationStatus === "confirmed" || value[0].confirmationStatus === "finalized" || value[0].err)) {
      return { landed: true };
    }
    const st = await getInflightBundleStatus(bundleId).catch(() => null);
    if (st) last = st.status;
    if (st?.status === "Landed") return { landed: true };
    if (st?.status === "Failed") return { landed: false, reason: `Jito bundle ${bundleId.slice(0, 8)}… failed (a tx in it would fail, or the tip was outbid)` };
    await sleep(2000);
  }
  if (last === "Invalid") {
    return { landed: false, reason: `Jito never saw bundle ${bundleId.slice(0, 8)}… land (status Invalid: dropped or expired). Check JITO_BLOCK_ENGINE_URL matches the RPC's cluster, or raise JITO_TIP_SOL` };
  }
  return { landed: false, reason: `bundle ${bundleId.slice(0, 8)}… did not land within ${timeoutMs / 1000}s${last ? ` (Jito status: ${last})` : ""}` };
}

export interface LaunchResult extends LaunchRecord {
  skipped: { publicKey: string; reason: string }[];
  warnings: string[];
}

export async function launchToken(meta: TokenMetadataInput, buyerIds?: string[]): Promise<LaunchResult> {
  const jito = jitoMode();
  const mainStored = store.getMain();
  if (!mainStored) throw new Error("Select a main wallet first");
  const main = keypairOf(mainStored);

  let buyerWallets: StoredWallet[] = store.listWallets().filter((w) => !w.isMain);
  if (buyerIds) buyerWallets = buyerWallets.filter((w) => buyerIds.includes(w.id));

  // Pre-flight: the main wallet must afford the create; buyers that can't afford their buy are skipped.
  const balances = await getSolBalances([main.publicKey, ...buyerWallets.map((w) => new PublicKey(w.publicKey))]);
  const mainNeeds = config.devBuySol * 1.01 + CREATE_OVERHEAD_SOL + (jito.usable ? config.jitoTipSol : 0);
  if (lamportsToSol(balances[0]) < mainNeeds) {
    throw new Error(`Main wallet needs at least ${mainNeeds.toFixed(4)} SOL, has ${lamportsToSol(balances[0]).toFixed(4)} SOL`);
  }
  const buyerNeeds = config.buyAmountSol * (1 + config.slippagePercent / 100) + BUY_OVERHEAD_SOL;
  const skipped: LaunchResult["skipped"] = [];
  const buyers: Keypair[] = [];
  buyerWallets.forEach((w, i) => {
    const sol = lamportsToSol(balances[i + 1]);
    if (sol < buyerNeeds) skipped.push({ publicKey: w.publicKey, reason: `has ${sol.toFixed(4)} SOL, needs ${buyerNeeds.toFixed(4)}` });
    else buyers.push(keypairOf(w));
  });

  const { uri, warning } = await resolveMetadataUri(meta);
  const mint = Keypair.generate();
  const keypairs = new Map([main, mint, ...buyers].map((k) => [k.publicKey.toBase58(), k]));
  // Sequential mode sends one wallet per tx so BUY_DELAY_MS applies per wallet.
  const plan = await planLaunch({
    main: main.publicKey,
    buyers: buyers.map((b) => b.publicKey),
    mint: mint.publicKey,
    name: meta.name,
    symbol: meta.symbol,
    uri,
    buyersPerTx: jito.usable ? config.buyersPerTx : 1,
  });
  const planned: Signable[] = plan.map((p) => ({ ...p, signers: p.signerKeys.map((k) => keypairs.get(k.toBase58())!) }));

  const record: LaunchRecord = {
    mint: mint.publicKey.toBase58(),
    name: meta.name,
    symbol: meta.symbol,
    uri,
    createdAt: new Date().toISOString(),
    mode: jito.usable ? "jito" : "sequential",
    transactions: [],
  };

  if (jito.usable) await sendAsBundles(planned, record);
  else await sendSequential(planned, record);

  store.addLaunch(record);
  const warnings = [warning, jito.note].filter((w): w is string => !!w);
  return { ...record, skipped, warnings };
}

async function sendAsBundles(planned: Signable[], record: LaunchRecord) {
  const tipAccount = await getTipAccount();
  const tipLamports = solToLamports(config.jitoTipSol);

  // Jito drops a bundle silently if any tx fails, so check the create on our RPC first.
  // (Buys can't be simulated yet: they need the curve the create makes.)
  const { blockhash: simHash } = await connection.getLatestBlockhash("confirmed");
  const sim = await connection.simulateTransaction(sign(planned[0], simHash), { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const logs = sim.value.logs?.filter((l) => /error|failed/i.test(l)).slice(-3).join(" | ");
    record.transactions.push({
      label: planned[0].label,
      signature: "",
      status: "failed",
      error: `create simulation failed, bundle not sent: ${JSON.stringify(sim.value.err)}${logs ? ` — ${logs}` : ""}`,
    });
    return;
  }

  for (let b = 0; b < planned.length; b += MAX_BUNDLE_TXS) {
    if (b > 0 && config.buyDelayMs > 0) await sleep(config.buyDelayMs);
    const chunk = planned.slice(b, b + MAX_BUNDLE_TXS);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const txs = chunk.map((p, i) => {
      const tip =
        i === chunk.length - 1
          ? [SystemProgram.transfer({ fromPubkey: p.payer, toPubkey: tipAccount, lamports: tipLamports })]
          : [];
      const tx = sign(p, blockhash, tip);
      if (tx.serialize().length > MAX_TX_BYTES) throw new Error(`"${p.label}" exceeds the transaction size limit; lower BUYERS_PER_TX`);
      return tx;
    });
    const sigs = txs.map((tx) => sigOf(tx));
    let bundleId: string;
    try {
      bundleId = await sendBundle(txs);
    } catch (e) {
      chunk.forEach((p, i) => record.transactions.push({ label: p.label, signature: sigs[i], status: "failed", error: errMsg(e) }));
      if (b === 0) break; // nothing exists without the create bundle
      continue;
    }
    const { landed, reason } = await waitForBundle(bundleId, sigs);
    const statuses = landed ? await waitForSignatures(sigs, 15_000) : new Map<string, { ok: boolean; error?: string }>();
    chunk.forEach((p, i) => {
      const st = statuses.get(sigs[i]);
      record.transactions.push({
        label: p.label,
        signature: sigs[i],
        status: st ? (st.ok ? "confirmed" : "failed") : "failed",
        error: st ? st.error : reason,
      });
    });
    if (b === 0 && !statuses.get(sigs[0])?.ok) break;
  }
}

async function sendSequential(planned: Signable[], record: LaunchRecord) {
  const [create, ...buys] = planned;
  let { blockhash } = await connection.getLatestBlockhash("confirmed");
  const createTx = sign(create, blockhash);
  const createSig = sigOf(createTx);
  try {
    await connection.sendTransaction(createTx, { maxRetries: 5 });
  } catch (e) {
    record.transactions.push({ label: create.label, signature: createSig, status: "failed", error: errMsg(e) });
    return;
  }
  const createStatus = (await waitForSignatures([createSig])).get(createSig);
  record.transactions.push({
    label: create.label,
    signature: createSig,
    status: createStatus?.ok ? "confirmed" : "failed",
    error: createStatus?.ok ? undefined : (createStatus?.error ?? "not confirmed before timeout"),
  });
  if (!createStatus?.ok) return;

  const sent: { label: string; signature: string }[] = [];
  let blockhashAt = Date.now();
  for (let i = 0; i < buys.length; i++) {
    if (i > 0 && config.buyDelayMs > 0) await sleep(config.buyDelayMs);
    // Blockhashes expire after ~60s, so refresh when buys are spread out.
    if (Date.now() - blockhashAt > 30_000) {
      ({ blockhash } = await connection.getLatestBlockhash("confirmed"));
      blockhashAt = Date.now();
    }
    const tx = sign(buys[i], blockhash);
    const signature = sigOf(tx);
    try {
      await connection.sendTransaction(tx, { maxRetries: 5 });
      sent.push({ label: buys[i].label, signature });
    } catch (e) {
      record.transactions.push({ label: buys[i].label, signature, status: "failed", error: errMsg(e) });
    }
  }
  const statuses = await waitForSignatures(sent.map((s) => s.signature));
  for (const s of sent) {
    const st = statuses.get(s.signature);
    record.transactions.push({
      ...s,
      status: st ? (st.ok ? "confirmed" : "failed") : "sent",
      error: st?.error,
    });
  }
}

const sigOf = (tx: VersionedTransaction) => bs58.encode(tx.signatures[0]);
const short = (pk: PublicKey) => `${pk.toBase58().slice(0, 4)}…${pk.toBase58().slice(-4)}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  createdAt: string;
  /** false when the create transaction never landed. */
  exists: boolean;
  complete: boolean;
  marketCapSol: number;
  /** Share of the curve's sellable tokens already bought, 0-100. */
  curveProgress: number;
  heldByWallets: number;
  holderWallets: number;
}

/** Launched tokens with live bonding-curve stats and how much the stored wallets hold. */
export async function listTokens(): Promise<TokenInfo[]> {
  const launches = store.listLaunches();
  if (launches.length === 0) return [];
  const global = await new OnlinePumpSdk(connection).fetchGlobal();
  const curves = await connection.getMultipleAccountsInfo(launches.map((l) => bondingCurvePda(l.mint)));
  const owners = store.listWallets().map((w) => new PublicKey(w.publicKey));

  return Promise.all(
    launches.map(async (l, i) => {
      const base = { mint: l.mint, name: l.name, symbol: l.symbol, uri: l.uri, createdAt: l.createdAt };
      const info = curves[i];
      if (!info) return { ...base, exists: false, complete: false, marketCapSol: 0, curveProgress: 0, heldByWallets: 0, holderWallets: 0 };
      const curve = PUMP_SDK.decodeBondingCurve(info);
      const marketCap = bondingCurveMarketCap({
        mintSupply: curve.tokenTotalSupply,
        virtualQuoteReserves: curve.virtualQuoteReserves,
        virtualTokenReserves: curve.virtualTokenReserves,
      });
      const initial = global.initialRealTokenReserves;
      const sold = initial.sub(curve.realTokenReserves);
      const balances = owners.length ? await getMintBalances(new PublicKey(l.mint), owners) : [];
      return {
        ...base,
        exists: true,
        complete: curve.complete,
        marketCapSol: lamportsToSol(marketCap.toNumber()),
        curveProgress: curve.complete ? 100 : Math.max(0, (sold.muln(10_000).div(initial).toNumber() / 100)),
        heldByWallets: balances.reduce((s, b) => s + b, 0),
        holderWallets: balances.filter((b) => b > 0).length,
      };
    }),
  );
}

export interface BuyResult {
  transactions: LaunchRecord["transactions"];
  skipped: { publicKey: string; reason: string }[];
}

/**
 * Buy an existing (not yet graduated) pump.fun token with the given wallets, `amountSol` each.
 * Quotes are chained through a simulated curve so later wallets account for the earlier buys.
 */
export async function buyToken(mintStr: string, walletIds: string[], amountSol: number): Promise<BuyResult> {
  const mint = new PublicKey(mintStr);
  const wallets = store.listWallets().filter((w) => walletIds.includes(w.id));
  if (wallets.length === 0) throw new Error("Select at least one wallet");
  const lamports = solToLamports(amountSol);
  if (lamports <= 0) throw new Error("Amount must be positive");

  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error("Mint account not found");
  const tokenProgram = mintInfo.owner;
  const online = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null)]);
  const curveInfo = await connection.getAccountInfo(bondingCurvePda(mint));
  if (!curveInfo) throw new Error("This token has no bonding curve (the create never landed)");
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (curve.complete) throw new Error("This token graduated from the bonding curve; buy it on PumpSwap instead");

  const balances = await getSolBalances(wallets.map((w) => new PublicKey(w.publicKey)));
  const needs = amountSol * (1 + config.slippagePercent / 100) + BUY_OVERHEAD_SOL;
  const skipped: BuyResult["skipped"] = [];
  const planned: Signable[] = [];
  for (const [i, w] of wallets.entries()) {
    const sol = lamportsToSol(balances[i]);
    if (sol < needs) {
      skipped.push({ publicKey: w.publicKey, reason: `has ${sol.toFixed(4)} SOL, needs ${needs.toFixed(4)}` });
      continue;
    }
    const kp = keypairOf(w);
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, true, tokenProgram);
    const tokens = quote(global, feeConfig, curve, lamports);
    const ixs = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: curveInfo,
      bondingCurve: curve,
      associatedUserAccountInfo: await connection.getAccountInfo(ata),
      mint,
      user: kp.publicKey,
      amount: tokens,
      solAmount: new BN(lamports),
      slippage: config.slippagePercent,
      tokenProgram,
    });
    applyBuy(curve, tokens);
    planned.push({
      label: `buy: ${short(kp.publicKey)}`,
      payer: kp.publicKey,
      signerKeys: [kp.publicKey],
      signers: [kp],
      ixs: [...priorityIxs(BUY_CU_PER_WALLET), ...ixs],
    });
  }

  const transactions: BuyResult["transactions"] = [];
  const sent: { label: string; signature: string }[] = [];
  let { blockhash } = await connection.getLatestBlockhash("confirmed");
  let blockhashAt = Date.now();
  for (const [i, p] of planned.entries()) {
    if (i > 0 && config.buyDelayMs > 0) await sleep(config.buyDelayMs);
    if (Date.now() - blockhashAt > 30_000) {
      ({ blockhash } = await connection.getLatestBlockhash("confirmed"));
      blockhashAt = Date.now();
    }
    const tx = sign(p, blockhash);
    const signature = sigOf(tx);
    try {
      await connection.sendTransaction(tx, { maxRetries: 5 });
      sent.push({ label: p.label, signature });
    } catch (e) {
      transactions.push({ label: p.label, signature, status: "failed", error: errMsg(e) });
    }
  }
  const statuses = await waitForSignatures(sent.map((s) => s.signature));
  for (const s of sent) {
    const st = statuses.get(s.signature);
    transactions.push({ ...s, status: st ? (st.ok ? "confirmed" : "failed") : "sent", error: st?.error });
  }
  return { transactions, skipped };
}
