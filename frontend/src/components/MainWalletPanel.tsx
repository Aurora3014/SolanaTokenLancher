import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { api, explorerAddr, fmtSol, type AppConfig, type WalletRow } from "../api";
import type { Notify } from "../App";
import CopyButton from "./CopyButton";

interface Props {
  config: AppConfig;
  main: WalletRow | null;
  notify: Notify;
  onChange: () => void;
}

export default function MainWalletPanel({ config, main, notify, onChange }: Props) {
  const { connection } = useConnection();
  const { publicKey: external, sendTransaction } = useWallet();
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);

  if (!main) {
    return (
      <section className="panel">
        <h2>Main wallet</h2>
        <p className="muted">
          No main wallet selected. Generate wallets, then pick one as main in the wallet list. The main wallet creates
          the token, makes the dev buy, and funds the other wallets.
        </p>
      </section>
    );
  }

  async function deposit() {
    if (!external || !main) return;
    const sol = Number(depositAmount);
    if (!(sol > 0)) return notify("err", "Enter a deposit amount");
    setBusy("deposit");
    try {
      const latest = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: external, ...latest }).add(
        SystemProgram.transfer({
          fromPubkey: external,
          toPubkey: new PublicKey(main.publicKey),
          lamports: Math.round(sol * LAMPORTS_PER_SOL),
        }),
      );
      const sig = await sendTransaction(tx, connection);
      notify("ok", `Deposit sent: ${sig.slice(0, 12)}… waiting for confirmation`);
      const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      notify("ok", `Deposited ${sol} SOL into the main wallet`);
      setDepositAmount("");
      onChange();
    } catch (e) {
      notify("err", `Deposit failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function withdraw(max: boolean) {
    const to = withdrawTo.trim() || external?.toBase58();
    if (!to) return notify("err", "Enter a destination address or connect an external wallet");
    const amount = max ? "max" : Number(withdrawAmount);
    if (amount !== "max" && !(amount > 0)) return notify("err", "Enter a withdraw amount");
    setBusy("withdraw");
    try {
      const { signature } = await api.withdraw(to, amount);
      notify("ok", `Withdrawn — tx ${signature.slice(0, 12)}…`);
      setWithdrawAmount("");
      onChange();
    } catch (e) {
      notify("err", `Withdraw failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <h2>Main wallet</h2>
      <div className="main-summary">
        <div>
          <div className="label">Address</div>
          <div className="mono">
            <a href={explorerAddr(main.publicKey, config.cluster, config.rpcUrl)} target="_blank" rel="noreferrer">
              {main.publicKey}
            </a>
            <CopyButton text={main.publicKey} />
          </div>
        </div>
        <div className="balance">
          <div className="label">Balance</div>
          <div className="big">{fmtSol(main.sol)} SOL</div>
        </div>
      </div>

      <div className="split">
        <div className="subpanel">
          <h3>Import SOL</h3>
          <p className="muted small">
            From your connected browser wallet{external ? "" : " (connect one at the top right)"}. You can also send SOL
            to the address above from any wallet.
          </p>
          <div className="row">
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="SOL"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
            />
            <button className="btn" disabled={!external || busy !== null} onClick={deposit}>
              {busy === "deposit" ? "Sending…" : "Deposit"}
            </button>
          </div>
        </div>

        <div className="subpanel">
          <h3>Export SOL</h3>
          <input
            className="full"
            placeholder={external ? `To ${external.toBase58().slice(0, 8)}… (connected) or other address` : "Destination address"}
            value={withdrawTo}
            onChange={(e) => setWithdrawTo(e.target.value)}
          />
          <div className="row">
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="SOL"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
            />
            <button className="btn" disabled={busy !== null} onClick={() => withdraw(false)}>
              {busy === "withdraw" ? "Sending…" : "Withdraw"}
            </button>
            <button className="btn btn-ghost" disabled={busy !== null} onClick={() => withdraw(true)}>
              Max
            </button>
          </div>
        </div>
      </div>
      {config.cluster !== "mainnet-beta" && (
        <p className="muted small">
          Test network: get free SOL at{" "}
          <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
            faucet.solana.com
          </a>{" "}
          (select {config.cluster}) and send it to the main wallet address.
        </p>
      )}
    </section>
  );
}
