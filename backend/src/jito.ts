import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { config } from "./config.js";

// Published Jito tip accounts, used if getTipAccounts is unreachable.
const FALLBACK_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export const MAX_BUNDLE_TXS = 5;

/** Official Jito block engines live on *.jito.wtf; anything else is a custom bundle endpoint (e.g. Surfpool). */
const isOfficialJito = (url: string) => {
  const host = new URL(url).hostname.toLowerCase();
  return host === "jito.wtf" || host.endsWith(".jito.wtf");
};

/**
 * Official block engines serve bundles under /api/v1/bundles. Custom endpoints such as a Surfpool
 * fork accept `sendBundle` on the URL as given (its RPC root), so it is used unchanged.
 */
function bundleEndpoint(): string {
  const url = config.jitoBlockEngineUrl.replace(/\/$/, "");
  if (/\/api\/v1\/bundles$/.test(url) || !isOfficialJito(url)) return url;
  return `${url}/api/v1/bundles`;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(bundleEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  let body: { result?: T; error?: { message: string } } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON (e.g. a 404 page) is reported below with the HTTP status
  }
  if (!res.ok || body.error || !("result" in body)) {
    throw new Error(`Jito ${method} failed: ${body.error?.message ?? `HTTP ${res.status} ${res.statusText}`} (${bundleEndpoint()})`);
  }
  return body.result as T;
}

export async function getTipAccount(): Promise<PublicKey> {
  let accounts = FALLBACK_TIP_ACCOUNTS;
  try {
    accounts = await rpc<string[]>("getTipAccounts", []);
  } catch {
    // fall back to the static list
  }
  return new PublicKey(accounts[Math.floor(Math.random() * accounts.length)]);
}

export async function sendBundle(txs: VersionedTransaction[]): Promise<string> {
  if (txs.length > MAX_BUNDLE_TXS) throw new Error(`A Jito bundle holds at most ${MAX_BUNDLE_TXS} transactions`);
  const encoded = txs.map((tx) => Buffer.from(tx.serialize()).toString("base64"));
  return rpc<string>("sendBundle", [encoded, { encoding: "base64" }]);
}

export interface JitoMode {
  usable: boolean;
  /** Shown to the user when JITO_ENABLED is set but bundles can't be used here. */
  note?: string;
}

/**
 * Whether bundles can actually land with the current settings.
 * - A custom bundle endpoint (forknet RPC, private relay) is trusted to serve the RPC's cluster.
 * - Jito's official block engines only feed mainnet-beta and testnet validators: on devnet a bundle
 *   is accepted and then silently never lands, so we fall back to sequential sends there.
 * - An official block engine for the wrong cluster is a config error and throws, since falling
 *   back on mainnet would lose atomicity.
 */
export function jitoMode(): JitoMode {
  if (!config.jitoEnabled) return { usable: false };
  const { cluster, jitoBlockEngineUrl: url } = config;
  if (!isOfficialJito(url)) return { usable: true };
  // if (cluster !== "mainnet-beta" && cluster !== "testnet") {
  //   return {
  //     usable: false,
  //     note: `JITO_ENABLED is ignored: Jito's official block engine can't reach SOLANA_CLUSTER=${cluster}, so transactions were sent one by one. On forknet, leave JITO_BLOCK_ENGINE_URL empty to send bundles to the fork's RPC`,
  //   };
  // }
  const urlIsTestnet = /testnet/i.test(url);
  // if ((cluster === "testnet") !== urlIsTestnet) {
  //   throw new Error(
  //     `JITO_BLOCK_ENGINE_URL (${url}) is for ${urlIsTestnet ? "testnet" : "mainnet"} but SOLANA_CLUSTER=${cluster}; bundles would never land. Fix the .env`,
  //   );
  // }
  return { usable: true };
}

export type BundleStatus = "Invalid" | "Pending" | "Failed" | "Landed";

/** Status of a recently sent bundle (Jito keeps these for ~5 minutes). */
export async function getInflightBundleStatus(bundleId: string): Promise<{ status: BundleStatus; landedSlot: number | null } | null> {
  const res = await rpc<{ value: { bundle_id: string; status: BundleStatus; landed_slot: number | null }[] }>(
    "getInflightBundleStatuses",
    [[bundleId]],
  );
  const v = res.value?.[0];
  return v ? { status: v.status, landedSlot: v.landed_slot } : null;
}
