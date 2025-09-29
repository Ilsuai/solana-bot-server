// server/tradeExecutor.ts
// Executes swaps on Solana via Jupiter v6 (Quote + Swap).
// Exports:
//   - executeSwap({ fromMint, toMint, amount, slippageBps? })
//   - buyToken({ mint, amountSol })
//   - sellToken({ mint, amountTokens })

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  ParsedAccountData,
} from "@solana/web3.js";
import fetch from "node-fetch";
import bs58 from "bs58";

const SOL_MINT = "So11111111111111111111111111111111111111112"; // wSOL
const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const L = {
  info: (s: string, m: string, meta?: any) =>
    console.log(`🟦 [executor:${s}] ${m}`, meta ?? ""),
  warn: (s: string, m: string, meta?: any) =>
    console.warn(`🟨 [executor:${s}] ${m}`, meta ?? ""),
  error: (s: string, m: string, meta?: any) =>
    console.error(`🟥 [executor:${s}] ${m}`, meta ?? ""),
};

// -------- wallet loading --------
function loadKeypair(): Keypair {
  const b58 = process.env.WALLET_PRIVATE_KEY_B58;
  const json = process.env.WALLET_PRIVATE_KEY_JSON;

  if (b58) {
    const secret = bs58.decode(b58);
    return Keypair.fromSecretKey(secret);
  }
  if (json) {
    const arr = JSON.parse(json);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  throw new Error("Missing wallet secret. Set WALLET_PRIVATE_KEY_B58 or WALLET_PRIVATE_KEY_JSON.");
}

const connection = new Connection(RPC_URL, "confirmed");
const wallet = loadKeypair();
L.info("init", "Loaded wallet", { pubkey: wallet.publicKey.toBase58(), rpc: RPC_URL });

// -------- helpers --------
async function getMintDecimals(mintStr: string): Promise<number> {
  if (mintStr === SOL_MINT) return 9;
  const mint = new PublicKey(mintStr);
  const acct = await connection.getParsedAccountInfo(mint, "confirmed");
  const parsed = acct.value?.data as ParsedAccountData | undefined;
  const decimals = parsed?.parsed?.info?.decimals;
  if (typeof decimals === "number") return decimals;
  L.warn("decimals", "Fallback to 9 decimals", { mint: mintStr });
  return 9;
}

function toMinorUnits(amount: number, decimals: number): string {
  const factor = Math.pow(10, decimals);
  const v = Math.round(amount * factor);
  return String(v);
}

// -------- core swap --------
export async function executeSwap(params: {
  fromMint: string;
  toMint: string;
  amount: number; // human units of the FROM mint
  slippageBps?: number; // default 50 (0.5%)
}): Promise<{ txSignature: string }> {
  const { fromMint, toMint, amount } = params;
  const slippageBps = Number(params.slippageBps ?? 50);

  // 1) amount in minor units based on FROM mint decimals
  const decimals = await getMintDecimals(fromMint);
  const amountMinor = toMinorUnits(amount, decimals);

  L.info("quote", "Requesting quote", { fromMint, toMint, amountMinor, slippageBps });

  // 2) QUOTE (Jupiter v6 returns a single best route object)
  const quoteUrl =
    `${JUP_BASE}/v6/quote?` +
    `inputMint=${fromMint}&outputMint=${toMint}&amount=${amountMinor}` +
    `&slippageBps=${slippageBps}&onlyDirectRoutes=false&fastMode=true`;

  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    const t = await quoteRes.text();
    throw new Error(`Quote failed: HTTP ${quoteRes.status} ${t}`);
  }
  const quote: any = await quoteRes.json(); // <-- explicit any to avoid "unknown" TS error

  if (!quote || typeof quote !== "object" || !("outAmount" in quote)) {
    throw new Error("No usable quote returned from Jupiter.");
  }

  L.info("quote", "Got quote", {
    outAmount: (quote as any).outAmount,
    inAmount: (quote as any).inAmount,
    priceImpactPct: (quote as any).priceImpactPct,
  });

  // 3) SWAP: Jupiter returns a base64 transaction to sign
  const swapRes = await fetch(`${JUP_BASE}/v6/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      computeUnitPriceMicroLamports: 0,
      quoteResponse: quote,
    }),
  });

  if (!swapRes.ok) {
    const t = await swapRes.text();
    throw new Error(`Swap build failed: HTTP ${swapRes.status} ${t}`);
  }
  const swapJson: any = await swapRes.json(); // <-- explicit any to avoid "unknown" TS error
  const b64 = swapJson.swapTransaction as string;
  if (!b64) throw new Error("No swapTransaction in response");

  const raw = Buffer.from(b64, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([wallet]);

  // 4) Send + confirm
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });

  L.info("send", "Submitted transaction", { sig });
  await connection.confirmTransaction(sig, "confirmed");
  L.info("confirm", "Transaction confirmed", { sig });

  return { txSignature: sig };
}

// Convenience wrappers (used by webhook adapter)
export async function buyToken(params: {
  mint: string; // token to receive
  amountSol: number; // SOL to spend (human)
}): Promise<{ txSignature: string }> {
  return executeSwap({
    fromMint: SOL_MINT,
    toMint: params.mint,
    amount: params.amountSol,
  });
}

export async function sellToken(params: {
  mint: string; // token to sell
  amountTokens: number; // token amount (human)
}): Promise<{ txSignature: string }> {
  return executeSwap({
    fromMint: params.mint,
    toMint: SOL_MINT,
    amount: params.amountTokens,
  });
}
