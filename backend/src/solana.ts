import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { config } from "./config.js";

export const connection = new Connection(config.rpcUrl, {
  commitment: "confirmed",
  wsEndpoint: config.wsUrl,
});

export const solToLamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);
export const lamportsToSol = (lamports: number) => lamports / LAMPORTS_PER_SOL;

const BASE_FEE_LAMPORTS = 5000;

export function priorityIxs(computeUnits: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }),
  ];
}

export function priorityFeeLamports(computeUnits: number) {
  return Math.ceil((computeUnits * config.priorityFeeMicroLamports) / 1_000_000);
}

export function buildTx(
  payer: PublicKey,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  blockhash: string,
): VersionedTransaction {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  return tx;
}

export async function sendAndConfirm(payer: Keypair, ixs: TransactionInstruction[], extraSigners: Keypair[] = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = buildTx(payer.publicKey, ixs, [payer, ...extraSigners], blockhash);
  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

export async function getSolBalances(pubkeys: PublicKey[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(pubkeys.slice(i, i + 100));
    out.push(...infos.map((info) => info?.lamports ?? 0));
  }
  return out;
}

export interface TokenHolding {
  mint: string;
  tokenAccount: string;
  programId: string;
  amount: string; // raw units
  decimals: number;
  uiAmount: number;
}

export async function getTokenHoldings(owner: PublicKey): Promise<TokenHolding[]> {
  const holdings: TokenHolding[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const { pubkey, account } of res.value) {
      const info = account.data.parsed.info;
      holdings.push({
        mint: info.mint,
        tokenAccount: pubkey.toBase58(),
        programId: programId.toBase58(),
        amount: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
        uiAmount: info.tokenAmount.uiAmount ?? 0,
      });
    }
  }
  return holdings;
}

/** Balance of one mint for many owners; the mint's token program is looked up once. */
export async function getMintBalances(mint: PublicKey, owners: PublicKey[]): Promise<number[]> {
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) return owners.map(() => 0);
  const atas = owners.map((o) => getAssociatedTokenAddressSync(mint, o, true, mintInfo.owner));
  const out: number[] = [];
  for (let i = 0; i < atas.length; i += 100) {
    const infos = await connection.getMultipleParsedAccounts(atas.slice(i, i + 100));
    for (const info of infos.value) {
      const parsed = info && "parsed" in info.data ? info.data.parsed : null;
      out.push(parsed?.info?.tokenAmount?.uiAmount ?? 0);
    }
  }
  return out;
}

/** Request faucet SOL for each address (test networks / local forks only), a few at a time. */
export async function airdrop(pubkeys: PublicKey[], lamports: number) {
  const results: { publicKey: string; signature?: string; error?: string }[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < pubkeys.length; i += CONCURRENCY) {
    const batch = pubkeys.slice(i, i + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map(async (pk) => {
          try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
            const signature = await connection.requestAirdrop(pk, lamports);
            const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
            if (res.value.err) throw new Error(JSON.stringify(res.value.err));
            return { publicKey: pk.toBase58(), signature };
          } catch (e) {
            return { publicKey: pk.toBase58(), error: e instanceof Error ? e.message : String(e) };
          }
        }),
      )),
    );
  }
  return results;
}

/** Send SOL from one wallet to many recipients, packing transfers into as few transactions as possible. */
export async function multiTransfer(from: Keypair, transfers: { to: PublicKey; lamports: number }[]) {
  const signatures: string[] = [];
  const PER_TX = 18;
  for (let i = 0; i < transfers.length; i += PER_TX) {
    const ixs = [
      ...priorityIxs(5_000 + 1_000 * PER_TX),
      ...transfers.slice(i, i + PER_TX).map((t) =>
        SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: t.to, lamports: t.lamports }),
      ),
    ];
    signatures.push(await sendAndConfirm(from, ixs));
  }
  return signatures;
}

/** Transfer SOL, or everything the wallet can spend when `lamports` is "max". */
export async function transferSol(from: Keypair, to: PublicKey, lamports: number | "max") {
  const cu = 1_000;
  let amount: number;
  if (lamports === "max") {
    const balance = await connection.getBalance(from.publicKey);
    amount = balance - BASE_FEE_LAMPORTS - priorityFeeLamports(cu + 300);
    if (amount <= 0) throw new Error("Balance too low to cover the transaction fee");
  } else {
    amount = lamports;
  }
  return sendAndConfirm(from, [
    ...priorityIxs(cu + 300),
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: amount }),
  ]);
}

/**
 * Move every token and all SOL out of `wallet` to `destination`.
 * Token accounts are closed so their rent comes back as SOL. When `feePayer` is given it pays
 * fees and destination ATA rent, which lets a wallet with tokens but no SOL still be emptied.
 */
export async function sweepWallet(wallet: Keypair, destination: PublicKey, feePayer?: Keypair) {
  const payer = feePayer && !feePayer.publicKey.equals(wallet.publicKey) ? feePayer : wallet;
  const holdings = await getTokenHoldings(wallet.publicKey);
  const signatures: string[] = [];

  // A few token accounts per tx keeps us well under the size limit.
  const TOKENS_PER_TX = 4;
  for (let i = 0; i < holdings.length; i += TOKENS_PER_TX) {
    const ixs: TransactionInstruction[] = [...priorityIxs(60_000 * TOKENS_PER_TX)];
    for (const h of holdings.slice(i, i + TOKENS_PER_TX)) {
      const mint = new PublicKey(h.mint);
      const programId = new PublicKey(h.programId);
      const source = new PublicKey(h.tokenAccount);
      if (BigInt(h.amount) > 0n) {
        const destAta = getAssociatedTokenAddressSync(mint, destination, true, programId);
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destAta, destination, mint, programId),
          createTransferCheckedInstruction(source, mint, destAta, wallet.publicKey, BigInt(h.amount), h.decimals, [], programId),
        );
      }
      // Rent goes to the destination when the wallet itself pays, so nothing is left behind.
      ixs.push(createCloseAccountInstruction(source, payer === wallet ? destination : wallet.publicKey, wallet.publicKey, [], programId));
    }
    const signers = payer === wallet ? [] : [wallet];
    signatures.push(await sendAndConfirm(payer, ixs, signers));
  }

  const balance = await connection.getBalance(wallet.publicKey);
  if (payer === wallet) {
    const cu = 1_300;
    const amount = balance - BASE_FEE_LAMPORTS - priorityFeeLamports(cu);
    if (amount > 0) {
      signatures.push(
        await sendAndConfirm(wallet, [
          ...priorityIxs(cu),
          SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: destination, lamports: amount }),
        ]),
      );
    }
  } else if (balance > 0) {
    // Fee payer covers fees, so the full balance can move and the account is fully emptied.
    signatures.push(
      await sendAndConfirm(
        payer,
        [...priorityIxs(1_300), SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: destination, lamports: balance })],
        [wallet],
      ),
    );
  }
  return signatures;
}
