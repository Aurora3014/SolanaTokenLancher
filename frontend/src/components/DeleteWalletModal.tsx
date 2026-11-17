import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { api, explorerAddr, fmtSol, shortAddr, type Holdings, type WalletRow } from "../api";
import type { Notify } from "../App";
import CopyButton from "./CopyButton";

interface Props {
  wallet: WalletRow;
  /** Main wallet to sweep into; null when deleting the main wallet itself or none is set. */
  main: WalletRow | null;
  cluster: string;
  /** For explorer links on custom clusters (forks). */
  rpcUrl: string;
  notify: Notify;
  onClose: () => void;
  onDone: () => void;
}

export default function DeleteWalletModal({ wallet, main, cluster, rpcUrl, notify, onClose, onDone }: Props) {
  const { publicKey: external } = useWallet();
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [destination, setDestination] = useState(external?.toBase58() ?? "");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.holdings(wallet.id).then(setHoldings, (e) => notify("err", e.message));
  }, [wallet.id, notify]);

  const tokens = holdings?.tokens.filter((t) => BigInt(t.amount) > 0n) ?? [];

  async function exportAndDelete(to?: string) {
    setBusy(true);
    try {
      const { signatures } = await api.sweep(wallet.id, to);
      notify("ok", `Exported funds in ${signatures.length} tx`);
      // Non-forced delete: succeeds only if the wallet really is empty now.
      await api.remove(wallet.id);
      notify("ok", `Removed ${shortAddr(wallet.publicKey)}`);
      onDone();
    } catch (e) {
      notify("err", (e as Error).message);
      setHoldings(await api.holdings(wallet.id).catch(() => holdings));
    } finally {
      setBusy(false);
    }
  }

  async function forceDelete() {
    const lost = `${fmtSol(holdings?.sol ?? wallet.sol)} SOL${tokens.length ? ` and ${tokens.length} token(s)` : ""}`;
    if (!secret && !confirm(`You have not exported the private key.\n${lost} will be unreachable from this app. Delete anyway?`)) return;
    setBusy(true);
    try {
      await api.remove(wallet.id, true);
      notify("ok", `Removed ${shortAddr(wallet.publicKey)}`);
      onDone();
    } catch (e) {
      notify("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>⚠ This wallet still holds funds</h2>
        <p className="mono small">
          <a href={explorerAddr(wallet.publicKey, cluster, rpcUrl)} target="_blank" rel="noreferrer">
            {wallet.publicKey}
          </a>
          {wallet.isMain && <span className="tag">main</span>}
        </p>

        {!holdings ? (
          <p className="muted">Loading balances…</p>
        ) : (
          <ul className="holdings">
            <li>
              <span>SOL</span>
              <b>{fmtSol(holdings.sol)}</b>
            </li>
            {tokens.map((t) => (
              <li key={t.tokenAccount}>
                <span className="mono">
                  <a href={explorerAddr(t.mint, cluster, rpcUrl)} target="_blank" rel="noreferrer">
                    {shortAddr(t.mint)}
                  </a>
                </span>
                <b>{t.uiAmount.toLocaleString()}</b>
              </li>
            ))}
          </ul>
        )}

        <p className="muted small">Export the funds before removing it. SOL and all tokens are moved; token accounts are closed to reclaim rent.</p>

        <div className="modal-actions">
          {main && (
            <button className="btn btn-primary" disabled={busy} onClick={() => exportAndDelete()}>
              {busy ? "Working…" : `Export all to main (${shortAddr(main.publicKey)}) & remove`}
            </button>
          )}

          <div className="row">
            <input className="full mono" placeholder="Destination address" value={destination} onChange={(e) => setDestination(e.target.value)} />
            <button className="btn" disabled={busy || !destination.trim()} onClick={() => exportAndDelete(destination.trim())}>
              Export & remove
            </button>
          </div>

          <div className="row">
            {secret ? (
              <>
                <code className="secret">{secret}</code>
                <CopyButton text={secret} />
              </>
            ) : (
              <button className="btn btn-ghost" disabled={busy} onClick={async () => setSecret((await api.secret(wallet.id)).secretKey)}>
                Show private key
              </button>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={forceDelete}>
            Remove anyway
          </button>
        </div>
      </div>
    </div>
  );
}
