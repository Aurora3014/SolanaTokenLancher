import { useCallback, useEffect, useRef, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { api, type AppConfig, type TokenInfo, type WalletRow } from "./api";
import MainWalletPanel from "./components/MainWalletPanel";
import WalletsPanel from "./components/WalletsPanel";
import LaunchPanel from "./components/LaunchPanel";
import TokensPanel from "./components/TokensPanel";

export type Notify = (kind: "ok" | "err", text: string) => void;

interface Toast {
  id: number;
  kind: "ok" | "err";
  text: string;
}

export default function App({ config }: { config: AppConfig }) {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  // Token shown in the wallet list's token column; defaults to the newest launch.
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify: Notify = useCallback((kind, text) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 9000 : 5000);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const ts = await api.tokens();
      setTokens(ts);
      const mint = ts.some((t) => t.mint === selectedRef.current) ? selectedRef.current : (ts[0]?.mint ?? null);
      selectedRef.current = mint;
      setSelectedMint(mint);
      setWallets(await api.wallets(mint ?? undefined));
    } catch (e) {
      notify("err", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectMint = (mint: string) => {
    selectedRef.current = mint;
    setSelectedMint(mint);
    api.wallets(mint).then(setWallets, (e) => notify("err", e.message));
  };

  const main = wallets.find((w) => w.isMain) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◎</span> Token Launcher
          <span className={`badge ${config.cluster === "mainnet-beta" ? "badge-live" : "badge-test"}`}>{config.cluster}</span>
          <span className={`badge ${config.jitoNote ? "badge-test" : ""}`} title={config.jitoNote}>
            {config.jitoEnabled ? "Jito bundle" : "Sequential buys"}
            {config.jitoNote && " ⚠"}
          </span>
        </div>
        <WalletMultiButton />
      </header>

      <main className="grid">
        <div className="col">
          <MainWalletPanel config={config} main={main} notify={notify} onChange={refresh} />
          <LaunchPanel
            config={config}
            main={main}
            buyerCount={wallets.filter((w) => !w.isMain).length}
            notify={notify}
            onLaunched={refresh}
          />
          <TokensPanel
            config={config}
            tokens={tokens}
            wallets={wallets}
            selectedMint={selectedMint}
            onSelect={selectMint}
            notify={notify}
            onChange={refresh}
          />
        </div>
        <div className="col">
          <WalletsPanel
            config={config}
            wallets={wallets}
            tokens={tokens}
            loading={loading}
            selectedMint={selectedMint}
            onSelectMint={selectMint}
            notify={notify}
            onChange={refresh}
          />
        </div>
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
