import { useState } from "react";
import { explorerAddr, fmtSol, fmtTokens, pctOfSupply, shortAddr, type AppConfig, type TokenInfo, type WalletRow } from "../api";
import type { Notify } from "../App";
import CopyButton from "./CopyButton";
import BuyModal from "./BuyModal";

interface Props {
  config: AppConfig;
  tokens: TokenInfo[];
  wallets: WalletRow[];
  selectedMint: string | null;
  onSelect: (mint: string) => void;
  notify: Notify;
  onChange: () => void;
}

export default function TokensPanel({ config, tokens, wallets, selectedMint, onSelect, notify, onChange }: Props) {
  const [buying, setBuying] = useState<TokenInfo | null>(null);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Created tokens <span className="muted">({tokens.length})</span>
        </h2>
      </div>

      {tokens.length === 0 ? (
        <div className="empty">No tokens launched yet.</div>
      ) : (
        <div className="token-list">
          {tokens.map((t) => (
            <div key={t.mint} className={`token-card ${t.mint === selectedMint ? "selected" : ""}`}>
              <div className="token-head">
                <div>
                  <b>${t.symbol}</b> <span className="muted">{t.name}</span>
                  {!t.exists && <span className="tag tag-err">not created</span>}
                  {t.complete && <span className="tag tag-ok">graduated</span>}
                </div>
                <span className="muted small">{new Date(t.createdAt).toLocaleString()}</span>
              </div>
              <div className="mono small">
                <a href={explorerAddr(t.mint, config.cluster, config.rpcUrl)} target="_blank" rel="noreferrer">
                  {shortAddr(t.mint)}
                </a>
                <CopyButton text={t.mint} />
              </div>

              {t.exists && (
                <>
                  <div className="token-stats">
                    <div>
                      <span className="label">Market cap</span>
                      <b>{fmtSol(t.marketCapSol)} SOL</b>
                    </div>
                    <div>
                      <span className="label">Held by wallets</span>
                      <b>
                        {fmtTokens(t.heldByWallets)} <span className="muted small">({pctOfSupply(t.heldByWallets).toFixed(2)}%)</span>
                      </b>
                    </div>
                    <div>
                      <span className="label">Holders</span>
                      <b>
                        {t.holderWallets}/{wallets.length}
                      </b>
                    </div>
                  </div>
                  <div className="progress" title={`Bonding curve ${t.curveProgress.toFixed(1)}% sold`}>
                    <div className="progress-fill" style={{ width: `${Math.min(100, t.curveProgress)}%` }} />
                  </div>
                  <div className="muted small">Bonding curve {t.curveProgress.toFixed(1)}%</div>
                </>
              )}

              <div className="row token-actions">
                <button className="btn btn-ghost" disabled={t.mint === selectedMint || !t.exists} onClick={() => onSelect(t.mint)}>
                  {t.mint === selectedMint ? "Shown in wallets" : "Show in wallets"}
                </button>
                <button className="btn btn-primary" disabled={!t.exists || t.complete || wallets.length === 0} onClick={() => setBuying(t)}>
                  Buy
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {buying && (
        <BuyModal
          config={config}
          token={buying}
          wallets={wallets}
          notify={notify}
          onClose={() => setBuying(null)}
          onDone={() => {
            onSelect(buying.mint);
            onChange();
          }}
        />
      )}
    </section>
  );
}
