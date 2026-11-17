import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./index.css";
import App from "./App";
import { api, type AppConfig } from "./api";

function Root() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setConfig, (e) => setError(e.message));
  }, []);

  if (error) return <div className="boot">Backend unreachable: {error}. Is the server running?</div>;
  if (!config) return <div className="boot">Loading…</div>;

  // Browser wallets (Phantom, Solflare, Backpack…) register themselves via Wallet Standard,
  // so no adapter list is needed.
  return (
    <ConnectionProvider endpoint={config.rpcUrl}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <App config={config} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
