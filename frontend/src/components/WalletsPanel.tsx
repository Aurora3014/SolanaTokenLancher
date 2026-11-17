import { Fragment, useState } from "react";
import { api, explorerAddr, fmtSol, fmtTokens, pctOfSupply, shortAddr, type AirdropResult, type AppConfig, type TokenInfo, type WalletRow } from "../api";
import WalletHoldings from "./WalletHoldings";
import type { Notify } from "../App";
import CopyButton from "./CopyButton";
import DeleteWalletModal from "./DeleteWalletModal";

interface Props {
  config: AppConfig;
  wallets: WalletRow[];
  tokens: TokenInfo[];
  loading: boolean;
  /** Token shown in the token column. */
  selectedMint: string | null;
  onSelectMint: (mint: string) => void;
  notify: Notify;
  onChange: () => void;
}

type Busy = "generate" | "airdrop" | "fund" | "collect" | "import" | null;

export default function WalletsPanel({ config, wallets, tokens, loading, selectedMint, onSelectMint, notify, onChange }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [deleting, setDeleting] = useState<WalletRow | null>(null);
  const [importKey, setImportKey] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const symbols = Object.fromEntries(tokens.map((t) => [t.mint, t.symbol]));
  const liveTokens = tokens.filter((t) => t.exists);
  const totalTokens = wallets.reduce((s, w) => s + (w.tokenBalance ?? 0), 0);
  const main = wallets.find((w) => w.isMain);
  const others = wallets.filter((w) => !w.isMain);
  const totalSol = wallets.reduce((s, w) => s + w.sol, 0);

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<string>) {
    setBusy(kind);
    try {
      notify("ok", await fn());
      onChange();
    } catch (e) {
      notify("err", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const airdropMsg = (ok: number, errors: AirdropResult["airdropErrors"]) => {
    if (errors.length) throw new Error(`Airdrop: ${ok} succeeded, ${errors.length} failed (${errors[0].error})`);
    return `airdropped ${config.airdropSol} SOL to ${ok} wallet${ok === 1 ? "" : "s"}`;
  };

  const generate = () =>
    run("generate", async () => {
      const r = await api.generate();
      if (!config.airdropSol) return `Generated ${r.created} wallets`;
      try {
        return `Generated ${r.created} wallets, ${airdropMsg(r.airdropped, r.airdropErrors)}`;
      } catch (e) {
        throw new Error(`Generated ${r.created} wallets. ${(e as Error).message}`);
      }
    });

  const airdropAll = () =>
    run("airdrop", async () => {
      const r = await api.airdrop();
      const msg = airdropMsg(r.airdropped, r.airdropErrors);
      return msg.charAt(0).toUpperCase() + msg.slice(1);
    });

  const fund = () => {
    const need = others.reduce((s, w) => s + Math.max(0, config.fundAmountSol - w.sol), 0);
    if (!confirm(`Top up ${others.length} wallets to ${config.fundAmountSol} SOL each from the main wallet?\nAbout ${fmtSol(need)} SOL will be sent.`)) return;
    run("fund", async () => {
      const { funded } = await api.fund();
      return funded ? `Funded ${funded} wallets` : "All wallets already hold the fund amount";
    });
  };

  const collect = () => {
    if (!confirm("Send all SOL and tokens from every generated wallet back to the main wallet?")) return;
    run("collect", async () => {
      const { results } = await api.collect();
      const failed = results.filter((r) => r.error);
      if (failed.length) throw new Error(`Collected from ${results.length - failed.length}, failed for ${failed.length}: ${failed[0].error}`);
      return `Collected from ${results.length} wallets`;
    });
  };

  const doImport = () =>
    run("import", async () => {
      await api.importWallet(importKey);
      setImportKey("");
      setShowImport(false);
      return "Wallet imported";
    });

  async function selectMain(w: WalletRow) {
    try {
      await api.setMain(w.id);
      onChange();
    } catch (e) {
      notify("err", (e as Error).message);
    }
  }

  async function startDelete(w: WalletRow) {
    // The server checks live balances: an empty wallet is removed straight away,
    // one that still holds funds comes back as 409 and opens the export dialog.
    try {
      await api.remove(w.id);
      notify("ok", `Removed ${shortAddr(w.publicKey)}`);
      onChange();
    } catch (e) {
      if ((e as { status?: number }).status === 409) setDeleting(w);
      else notify("err", (e as Error).message);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Wallets <span className="muted">({wallets.length})</span>
        </h2>
        <div className="row">
          <button className="btn btn-ghost" onClick={onChange} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn btn-ghost" onClick={() => setShowImport((v) => !v)}>
            Import key
          </button>
          <button className="btn btn-primary" onClick={generate} disabled={busy !== null}>
            {busy === "generate"
              ? config.airdropSol
                ? "Generating + airdropping…"
                : "Generating…"
              : `Generate ${config.walletCount} wallets`}
          </button>
        </div>
      </div>

      {showImport && (
        <div className="row import-row">
          <input
            className="full mono"
            type="password"
            placeholder="Base58 private key (e.g. exported from Phantom)"
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
          />
          <button className="btn" disabled={!importKey || busy !== null} onClick={doImport}>
            Import
          </button>
        </div>
      )}

      <div className="toolbar">
        <span className="muted small">
          Total {fmtSol(totalSol)} SOL · Buyers {others.length} · Each buys {config.buyAmountSol} SOL
        </span>
        <div className="row">
          {config.airdropSol > 0 && (
            <button className="btn" onClick={airdropAll} disabled={wallets.length === 0 || busy !== null} title="Request faucet SOL from the RPC for every wallet">
              {busy === "airdrop" ? "Airdropping…" : `Airdrop ${config.airdropSol} SOL`}
            </button>
          )}
          <button className="btn" onClick={fund} disabled={!main || others.length === 0 || busy !== null} title={main ? "" : "Select a main wallet first"}>
            {busy === "fund" ? "Funding…" : `Fund wallets (${config.fundAmountSol} SOL)`}
          </button>
          <button className="btn" onClick={collect} disabled={!main || others.length === 0 || busy !== null}>
            {busy === "collect" ? "Collecting…" : "Collect all to main"}
          </button>
        </div>
      </div>

      {wallets.length === 0 ? (
        <div className="empty">
          No wallets yet. Click <b>Generate {config.walletCount} wallets</b> to create them.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th title="Main wallet">Main</th>
                <th>#</th>
                <th>Address</th>
                <th className="num">SOL</th>
                <th className="num">
                  {liveTokens.length === 0 ? (
                    "Token"
                  ) : (
                    <select className="token-select" value={selectedMint ?? ""} onChange={(e) => onSelectMint(e.target.value)} title="Token shown in this column">
                      {liveTokens.map((t) => (
                        <option key={t.mint} value={t.mint}>
                          ${t.symbol}
                        </option>
                      ))}
                    </select>
                  )}
                </th>
                <th className="num">% supply</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {wallets.map((w, i) => (
                <Fragment key={w.id}>
                <tr className={w.isMain ? "is-main" : ""}>
                  <td>
                    <button className="btn-icon expand" onClick={() => toggleExpand(w.id)} title="Show all tokens in this wallet" aria-expanded={expanded.has(w.id)}>
                      {expanded.has(w.id) ? "▾" : "▸"}
                    </button>
                  </td>
                  <td>
                    <input type="radio" name="main" checked={w.isMain} onChange={() => selectMain(w)} aria-label="Select as main wallet" />
                  </td>
                  <td className="muted">{i + 1}</td>
                  <td className="mono">
                    <a href={explorerAddr(w.publicKey, config.cluster, config.rpcUrl)} target="_blank" rel="noreferrer">
                      {shortAddr(w.publicKey)}
                    </a>
                    <CopyButton text={w.publicKey} />
                    {w.isMain && <span className="tag">main</span>}
                  </td>
                  <td className="num">{fmtSol(w.sol)}</td>
                  <td className="num">{selectedMint ? fmtTokens(w.tokenBalance ?? 0) : "–"}</td>
                  <td className="num muted">{selectedMint && w.tokenBalance ? `${pctOfSupply(w.tokenBalance).toFixed(2)}%` : "–"}</td>
                  <td className="num">
                    <button className="btn-icon danger" onClick={() => startDelete(w)} title="Remove wallet">
                      Remove
                    </button>
                  </td>
                </tr>
                {expanded.has(w.id) && (
                  <tr className="holdings-row">
                    <td colSpan={8}>
                      <WalletHoldings walletId={w.id} sol={w.sol} symbols={symbols} cluster={config.cluster} rpcUrl={config.rpcUrl} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
            {selectedMint && (
              <tfoot>
                <tr>
                  <td colSpan={4} className="muted">
                    Total
                  </td>
                  <td className="num">{fmtSol(totalSol)}</td>
                  <td className="num">{fmtTokens(totalTokens)}</td>
                  <td className="num muted">{pctOfSupply(totalTokens).toFixed(2)}%</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {deleting && (
        <DeleteWalletModal
          wallet={deleting}
          main={main && main.id !== deleting.id ? main : null}
          cluster={config.cluster}
          rpcUrl={config.rpcUrl}
          notify={notify}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            onChange();
          }}
        />
      )}
    </section>
  );
}
