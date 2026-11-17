import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

export interface StoredWallet {
  id: string;
  publicKey: string;
  secretKey: string; // base58
  isMain: boolean;
  createdAt: string;
}

export interface LaunchRecord {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  createdAt: string;
  mode: "jito" | "sequential";
  transactions: { label: string; signature: string; status: "confirmed" | "failed" | "sent"; error?: string }[];
}

interface Db {
  wallets: StoredWallet[];
  launches: LaunchRecord[];
}

const dbFile = path.join(config.dataDir, "db.json");

function load(): Db {
  if (!fs.existsSync(dbFile)) return { wallets: [], launches: [] };
  const db = JSON.parse(fs.readFileSync(dbFile, "utf8")) as Partial<Db>;
  return { wallets: db.wallets ?? [], launches: db.launches ?? [] };
}

let db = load();

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  // Write-then-rename so a crash mid-write never corrupts the key file.
  const tmp = `${dbFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dbFile);
}

export const store = {
  listWallets(): StoredWallet[] {
    return db.wallets;
  },

  getWallet(id: string): StoredWallet | undefined {
    return db.wallets.find((w) => w.id === id);
  },

  getMain(): StoredWallet | undefined {
    return db.wallets.find((w) => w.isMain);
  },

  generate(count: number): StoredWallet[] {
    const created = Array.from({ length: count }, () => {
      const kp = Keypair.generate();
      return {
        id: crypto.randomUUID(),
        publicKey: kp.publicKey.toBase58(),
        secretKey: bs58.encode(kp.secretKey),
        isMain: false,
        createdAt: new Date().toISOString(),
      };
    });
    db.wallets.push(...created);
    save();
    return created;
  },

  importWallet(secret: string): StoredWallet {
    const kp = Keypair.fromSecretKey(bs58.decode(secret.trim()));
    const publicKey = kp.publicKey.toBase58();
    const existing = db.wallets.find((w) => w.publicKey === publicKey);
    if (existing) return existing;
    const wallet: StoredWallet = {
      id: crypto.randomUUID(),
      publicKey,
      secretKey: bs58.encode(kp.secretKey),
      isMain: false,
      createdAt: new Date().toISOString(),
    };
    db.wallets.push(wallet);
    save();
    return wallet;
  },

  setMain(id: string) {
    if (!this.getWallet(id)) throw new Error("Wallet not found");
    for (const w of db.wallets) w.isMain = w.id === id;
    save();
  },

  remove(id: string) {
    db.wallets = db.wallets.filter((w) => w.id !== id);
    save();
  },

  addLaunch(launch: LaunchRecord) {
    db.launches.unshift(launch);
    save();
  },

  listLaunches(): LaunchRecord[] {
    return db.launches;
  },
};

export function keypairOf(w: StoredWallet): Keypair {
  return Keypair.fromSecretKey(bs58.decode(w.secretKey));
}
