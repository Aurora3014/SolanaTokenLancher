import { useState } from "react";
import { api, explorerAddr, explorerTx, fmtSol, shortAddr, type AppConfig, type LaunchRecord, type WalletRow } from "../api";
import type { Notify } from "../App";
import CopyButton from "./CopyButton";

interface Props {
  config: AppConfig;
  main: WalletRow | null;
  buyerCount: number;
  notify: Notify;
  onLaunched: () => void;
}

const empty = { name: "", symbol: "", description: "", twitter: "", telegram: "", website: "", metadataUri: "" };

export default function LaunchPanel({ config, main, buyerCount, notify, onLaunched }: Props) {
  const [form, setForm] = useState(empty);
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<LaunchRecord | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const totalSol = config.devBuySol + buyerCount * config.buyAmountSol;
  const canLaunch = !!main && !!form.name.trim() && !!form.symbol.trim() && (!!image || !!form.metadataUri.trim()) && !launching;

  async function launch() {
    if (!main) return;
    const summary =
      `Launch ${form.name} ($${form.symbol.toUpperCase()}) on ${config.cluster}?\n\n` +
      `Dev buy: ${config.devBuySol} SOL from the main wallet\n` +
      `${buyerCount} wallets × ${config.buyAmountSol} SOL\n` +
      `Mode: ${config.jitoEnabled ? "Jito bundle" : "sequential"}${config.buyDelayMs ? `, ${config.buyDelayMs} ms between buys` : ""}`;
    if (!confirm(summary)) return;

    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) if (v.trim()) fd.append(k, k === "symbol" ? v.trim().toUpperCase() : v.trim());
    if (image) fd.append("image", image);

    setLaunching(true);
    setResult(null);
    try {
      const res = await api.launch(fd);
      setResult(res);
      const failed = res.transactions.filter((t) => t.status === "failed").length;
      notify(failed ? "err" : "ok", failed ? `Launched with ${failed} failed transaction(s)` : `${res.symbol} launched!`);
      onLaunched();
    } catch (e) {
      notify("err", `Launch failed: ${(e as Error).message}`);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <section className="panel">
      <h2>Launch token on pump.fun</h2>

      <div className="form-grid">
        <label>
          Name <span className="muted small">(max 32)</span>
          <input maxLength={32} value={form.name} onChange={set("name")} placeholder="My Token" />
        </label>
        <label>
          Symbol <span className="muted small">(max 10)</span>
          <input maxLength={10} value={form.symbol} onChange={set("symbol")} placeholder="MTK" />
        </label>
        <label className="span2">
          Description
          <textarea rows={2} value={form.description} onChange={set("description")} />
        </label>
        <label className="span2 image-input">
          Image
          <div className="row">
            {preview && <img src={preview} alt="" className="thumb" />}
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setImage(f);
                setPreview(f ? URL.createObjectURL(f) : null);
              }}
            />
          </div>
        </label>
        <label>
          X / Twitter
          <input value={form.twitter} onChange={set("twitter")} placeholder="https://x.com/…" />
        </label>
        <label>
          Telegram
          <input value={form.telegram} onChange={set("telegram")} placeholder="https://t.me/…" />
        </label>
        <label className="span2">
          Website
          <input value={form.website} onChange={set("website")} placeholder="https://…" />
        </label>
      </div>

      <button className="link-btn small" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "▾" : "▸"} Use an existing metadata URI instead of uploading
      </button>
      {advanced && (
        <input className="full" value={form.metadataUri} onChange={set("metadataUri")} placeholder="https://ipfs.io/ipfs/… (JSON with name, symbol, image)" />
      )}

      <div className="launch-summary">
        <div>
          <span className="label">Dev buy</span>
          <b>{config.devBuySol} SOL</b>
        </div>
        <div>
          <span className="label">Bundle buys</span>
          <b>
            {buyerCount} × {config.buyAmountSol} SOL
          </b>
        </div>
        <div>
          <span className="label">Total</span>
          <b>{fmtSol(totalSol)} SOL</b>
        </div>
        <div>
          <span className="label">Slippage</span>
          <b>{config.slippagePercent}%</b>
        </div>
        <div>
          <span className="label">Buy delay</span>
          <b>{config.buyDelayMs} ms</b>
        </div>
      </div>

      <button className="btn btn-primary btn-launch" disabled={!canLaunch} onClick={launch}>
        {launching ? "Launching… keep this tab open" : "🚀 Launch"}
      </button>
      {!main && <p className="muted small center">Select a main wallet to launch.</p>}

      {result && <LaunchResultView result={result} cluster={config.cluster} rpcUrl={config.rpcUrl} />}
    </section>
  );
}

function LaunchResultView({ result, cluster, rpcUrl }: { result: LaunchRecord; cluster: string; rpcUrl: string }) {
  return (
    <div className="result">
      <div className="row">
        <span className="label">Mint</span>
        <a className="mono" href={explorerAddr(result.mint, cluster, rpcUrl)} target="_blank" rel="noreferrer">
          {result.mint}
        </a>
        <CopyButton text={result.mint} />
      </div>
      {cluster === "mainnet-beta" && (
        <a href={`https://pump.fun/coin/${result.mint}`} target="_blank" rel="noreferrer">
          View on pump.fun →
        </a>
      )}
      <ul className="tx-list">
        {result.transactions.map((t) => (
          <li key={t.signature} className={`tx-${t.status}`}>
            <span className="status">{t.status === "confirmed" ? "✓" : t.status === "failed" ? "✗" : "…"}</span>
            <span>{t.label}</span>
            <a className="mono small" href={explorerTx(t.signature, cluster, rpcUrl)} target="_blank" rel="noreferrer">
              {shortAddr(t.signature)}
            </a>
            {t.error && <span className="err small">{t.error}</span>}
          </li>
        ))}
      </ul>
      {result.warnings?.map((w) => (
        <div key={w} className="skipped small">
          ⚠ {w}
        </div>
      ))}
      {!!result.skipped?.length && (
        <div className="skipped small">
          <b>Skipped (not enough SOL):</b>
          <ul>
            {result.skipped.map((s) => (
              <li key={s.publicKey}>
                <span className="mono">{shortAddr(s.publicKey)}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
