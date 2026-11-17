import { useState } from "react";
import { api, explorerTx, fmtSol, shortAddr, type AppConfig, type BuyResult, type TokenInfo, type WalletRow } from "../api";
import type { Notify } from "../App";

interface Props {
  config: AppConfig;
  token: TokenInfo;
  wallets: WalletRow[];
  notify: Notify;
  onClose: () => void;
  onDone: () => void;
}

export default function BuyModal({ config, token, wallets, notify, onClose, onDone }: Props) {
  const [amount, setAmount] = useState(String(config.buyAmountSol));
  // Generated wallets are pre-selected; the main wallet is opt-in.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(wallets.filter((w) => !w.isMain).map((w) => w.id)));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BuyResult | null>(null);

  const amountSol = Number(amount);
  const needs = amountSol * (1 + config.slippagePercent / 100);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function buy() {
    if (!(amountSol > 0)) return notify("err", "Enter an amount");
    setBusy(true);
    try {
      const r = await api.buyToken(token.mint, amountSol, [...selected]);
      setResult(r);
      const ok = r.transactions.filter((t) => t.status === "confirmed").length;
      const failed = r.transactions.length - ok;
      notify(failed ? "err" : "ok", `${ok} buy(s) confirmed${failed ? `, ${failed} failed` : ""}${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`);
      onDone();
    } catch (e) {
      notify("err", `Buy failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className="modal-title">
          Buy ${token.symbol} <span className="muted small">{token.name}</span>
        </h2>

        <div className="row">
          <label className="small">SOL per wallet</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
          <span className="muted small">
            Total {fmtSol(amountSol * selected.size || 0)} SOL · slippage {config.slippagePercent}%
            {config.buyDelayMs ? ` · ${config.buyDelayMs} ms between buys` : ""}
          </span>
        </div>

        <div className="row">
          <button className="btn-icon" onClick={() => setSelected(new Set(wallets.map((w) => w.id)))}>
            Select all
          </button>
          <button className="btn-icon" onClick={() => setSelected(new Set())}>
            Select none
          </button>
          <span className="muted small">{selected.size} selected</span>
        </div>

        <div className="wallet-pick">
          {wallets.map((w, i) => {
            const short = w.sol < needs + 0.006;
            return (
              <label key={w.id} className={`pick-row ${short ? "insufficient" : ""}`}>
                <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} disabled={busy} />
                <span className="muted">{i + 1}</span>
                <span className="mono">{shortAddr(w.publicKey)}</span>
                {w.isMain && <span className="tag">main</span>}
                <span className="num">{fmtSol(w.sol)} SOL</span>
              </label>
            );
          })}
        </div>

        {result && (
          <ul className="tx-list">
            {result.transactions.map((t) => (
              <li key={t.signature} className={`tx-${t.status}`}>
                <span className="status">{t.status === "confirmed" ? "✓" : t.status === "failed" ? "✗" : "…"}</span>
                <span>{t.label}</span>
                <a className="mono small" href={explorerTx(t.signature, config.cluster, config.rpcUrl)} target="_blank" rel="noreferrer">
                  {shortAddr(t.signature)}
                </a>
                {t.error && <span className="err small">{t.error.slice(0, 160)}</span>}
              </li>
            ))}
            {result.skipped.map((s) => (
              <li key={s.publicKey} className="skipped small">
                skipped <span className="mono">{shortAddr(s.publicKey)}</span> — {s.reason}
              </li>
            ))}
          </ul>
        )}

        <div className="modal-foot">
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </button>
          <button className="btn btn-primary" disabled={busy || selected.size === 0 || !(amountSol > 0)} onClick={buy}>
            {busy ? "Buying…" : `Buy with ${selected.size} wallet${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
