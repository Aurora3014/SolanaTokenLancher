# Solana Token Launcher (pump.fun)

Generate wallets, fund them from one main wallet, then launch a pump.fun token where the
generated wallets buy immediately after the create.

- **Backend**: TypeScript + Express, official `@pump-fun/pump-sdk` (`backend/`)
- **Frontend**: React + Vite + Solana wallet adapter (`frontend/`)
- **All settings**: the root `.env` (copy from `.env.example`)

## Run

```bash
cp .env.example .env          # then edit
cd backend  && npm install && npm run dev     # API on http://127.0.0.1:4000
cd frontend && npm install && npm run dev     # UI  on http://localhost:5173
```

## Flow

1. **Generate wallets**: creates `WALLET_COUNT` keypairs (stored in `data/db.json`).
2. **Select a main wallet** (radio button). It creates the token, makes the dev buy and funds the others.
3. **Import SOL** into the main wallet from a connected browser wallet (Phantom, Solflare…), or send
   SOL to its address. **Export SOL** sends it to any address, or to the connected wallet by default.
4. **Fund wallets**: tops every generated wallet up to `FUND_AMOUNT_SOL`.
5. **Launch**: uploads image + metadata to IPFS (via pump.fun), then:
   - tx 1: `create_v2` (Token-2022 mint, bonding curve)
   - next txs: dev buy (`DEV_BUY_AMOUNT_SOL`) + each generated wallet buys `BUY_AMOUNT_SOL`.
     Buys are quoted in order against a locally simulated curve, so each wallet's quote matches its
     position in the bundle.
6. **Remove** a wallet any time. If it still holds SOL or tokens, a dialog shows the balances and lets
   you export everything to the main wallet or an address, reveal the private key, or remove anyway.
7. **Collect all to main**: sweeps SOL and tokens from all generated wallets back to the main wallet.

## Send modes

| `JITO_ENABLED` | Behaviour |
|---|---|
| `false` (default, use on devnet) | create is sent and confirmed, then one tx per wallet with `BUY_DELAY_MS` between buys |
| `true` (mainnet) | create + buys go in Jito bundles of up to 5 txs (atomic, same block). Buys are packed up to `BUYERS_PER_TX` per tx (in practice 2 fit in the 1232-byte limit). Extra wallets go into further bundles with `BUY_DELAY_MS` between bundles. The last tx of each bundle pays `JITO_TIP_SOL`. |

## Notes

- **Testnet vs devnet**: pump.fun's program is deployed on **devnet**, not testnet, so use
  `SOLANA_CLUSTER=devnet`. Get devnet SOL at https://faucet.solana.com.
- Jito has no devnet block engine, so devnet launches are always sequential (not atomic).
- Private keys are stored **unencrypted** in `data/db.json`. Back it up and never commit it
  (it is git-ignored). The API has no authentication, so keep `HOST=127.0.0.1`.
- `RPC_URL` is also sent to the browser (the wallet adapter uses it for deposits). Don't put a secret
  RPC key there if you expose the UI to others.
- The public devnet RPC rate-limits heavily; use a dedicated RPC (Helius, QuickNode…) for real use.
