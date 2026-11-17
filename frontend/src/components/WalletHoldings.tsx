import { useEffect, useState } from "react";
import { api, explorerAddr, fmtSol, pctOfSupply, shortAddr, type Holdings } from "../api";

interface Props {
  walletId: string;
  sol: number;
  /** mint → symbol for tokens launched from this app. */
  symbols: Record<string, string>;
  cluster: string;
  /** For explorer links on custom clusters (forks). */
  rpcUrl: string;
}

/** Every token account in one wallet, loaded when the row is expanded. */
export default function WalletHoldings({ walletId, sol, symbols, cluster, rpcUrl }: Props) {
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.holdings(walletId).then(setHoldings, (e) => setError(e.message));
  }, [walletId]);

  if (error) return <div className="err small">{error}</div>;
  if (!holdings) return <div className="muted small">Loading tokens…</div>;

  const tokens = [...holdings.tokens].sort((a, b) => b.uiAmount - a.uiAmount);
  return (
    <div className="holdings-detail">
      <div className="holding-line">
        <span>SOL</span>
        <b>{fmtSol(holdings.sol ?? sol)}</b>
        <span />
      </div>
      {tokens.length === 0 && <div className="muted small">No token accounts.</div>}
      {tokens.map((t) => (
        <div key={t.tokenAccount} className="holding-line">
          <span>
            {symbols[t.mint] ? <b>${symbols[t.mint]}</b> : <span className="muted">Unknown</span>}{" "}
            <a className="mono small" href={explorerAddr(t.mint, cluster, rpcUrl)} target="_blank" rel="noreferrer">
              {shortAddr(t.mint)}
            </a>
            {t.programId.startsWith("Tokenz") && <span className="muted small"> · Token-2022</span>}
          </span>
          <b>{t.uiAmount.toLocaleString(undefined, { maximumFractionDigits: t.decimals })}</b>
          <span className="muted small">{symbols[t.mint] ? `${pctOfSupply(t.uiAmount).toFixed(3)}% of supply` : ""}</span>
        </div>
      ))}
    </div>
  );
}
