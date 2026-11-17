export interface AppConfig {
  cluster: string;
  rpcUrl: string;
  walletCount: number;
  fundAmountSol: number;
  /** 0 when airdrops are disabled or on mainnet. */
  airdropSol: number;
  devBuySol: number;
  buyAmountSol: number;
  slippagePercent: number;
  buyDelayMs: number;
  buyersPerTx: number;
  /** Effective: false when JITO_ENABLED is set but can't work on this cluster (see jitoNote). */
  jitoEnabled: boolean;
  jitoNote?: string;
  jitoTipSol: number;
}

export interface WalletRow {
  id: string;
  publicKey: string;
  isMain: boolean;
  createdAt: string;
  sol: number;
  tokenBalance: number | null;
}

export interface TokenHolding {
  mint: string;
  tokenAccount: string;
  programId: string;
  amount: string;
  decimals: number;
  uiAmount: number;
}

export interface Holdings {
  sol: number;
  tokens: TokenHolding[];
}

export interface LaunchTx {
  label: string;
  signature: string;
  status: "confirmed" | "failed" | "sent";
  error?: string;
}

export interface LaunchRecord {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  createdAt: string;
  mode: "jito" | "sequential";
  transactions: LaunchTx[];
  skipped?: { publicKey: string; reason: string }[];
  warnings?: string[];
}

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  createdAt: string;
  exists: boolean;
  complete: boolean;
  marketCapSol: number;
  curveProgress: number;
  heldByWallets: number;
  holderWallets: number;
}

export interface BuyResult {
  transactions: LaunchTx[];
  skipped: { publicKey: string; reason: string }[];
}

export interface AirdropResult {
  airdropped: number;
  airdropErrors: { publicKey: string; error?: string }[];
}

export class ApiError extends Error {
  status: number;
  data?: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText, body.data);
  return body as T;
}

const json = (method: string, data?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: data === undefined ? undefined : JSON.stringify(data),
});

export const api = {
  config: () => request<AppConfig>("/config"),
  wallets: (mint?: string) => request<WalletRow[]>(`/wallets${mint ? `?mint=${mint}` : ""}`),
  generate: () => request<{ created: number } & AirdropResult>("/wallets/generate", json("POST")),
  airdrop: (ids?: string[]) => request<AirdropResult>("/wallets/airdrop", json("POST", ids ? { ids } : {})),
  importWallet: (secretKey: string) => request<{ id: string }>("/wallets/import", json("POST", { secretKey })),
  setMain: (id: string) => request("/wallets/" + id + "/main", json("POST")),
  holdings: (id: string) => request<Holdings>(`/wallets/${id}/holdings`),
  secret: (id: string) => request<{ publicKey: string; secretKey: string }>(`/wallets/${id}/secret`),
  remove: (id: string, force = false) => request(`/wallets/${id}${force ? "?force=true" : ""}`, json("DELETE")),
  sweep: (id: string, destination?: string) =>
    request<{ signatures: string[] }>(`/wallets/${id}/sweep`, json("POST", destination ? { destination } : {})),
  withdraw: (to: string, amountSol: number | "max") => request<{ signature: string }>("/main/withdraw", json("POST", { to, amountSol })),
  fund: () => request<{ signatures: string[]; funded: number }>("/wallets/fund", json("POST", {})),
  collect: () => request<{ results: { publicKey: string; error?: string }[] }>("/wallets/collect", json("POST")),
  launch: (form: FormData) => request<LaunchRecord>("/launch", { method: "POST", body: form }),
  launches: () => request<LaunchRecord[]>("/launches"),
  tokens: () => request<TokenInfo[]>("/tokens"),
  buyToken: (mint: string, amountSol: number, walletIds: string[]) =>
    request<BuyResult>(`/tokens/${mint}/buy`, json("POST", { amountSol, walletIds })),
};

export const explorerTx = (sig: string, cluster: string, rpcUrl: string) =>
  `https://solscan.io/tx/${sig}${cluster === "mainnet-beta" ? "" : `?cluster=custom&customUrl=${rpcUrl.replace(/\/$/, "")}`}`;
export const explorerAddr = (addr: string, cluster: string, rpcUrl: string) =>
  `https://solscan.io/account/${addr}${cluster === "mainnet-beta" ? "" : `?cluster=custom&customUrl=${rpcUrl.replace(/\/$/, "")}`}`;
export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
// pump.fun tokens have a fixed 1B supply.
export const pctOfSupply = (n: number) => (n / 1e9) * 100;
export const fmtSol = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
