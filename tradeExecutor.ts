// tradeExecutor.ts — FULL FILE (TypeScript)
// Resilient executor: multi-fallback token decimals, mint auto-resolve by symbol,
// safe env binding, Jito + Helius tips, and retry/resign send loop with fast confirmation polling.

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  RpcResponseAndContext,
  SignatureStatus,
} from '@solana/web3.js';

import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import bs58 from 'bs58';
// @ts-ignore
import fetch from 'node-fetch';

import { logTradeToFirestore, getBotStatus, managePosition } from './firebaseAdmin';
import { attachDecimalsResolver } from './tokenDecimals';

// -----------------------------
// Boot checks & safe env binding
// -----------------------------
if (!process.env.SOLANA_RPC_ENDPOINT || !process.env.PRIVATE_KEY) {
  throw new Error('Missing env vars: SOLANA_RPC_ENDPOINT and PRIVATE_KEY must be set.');
}
const RPC_ENDPOINT: string = (process.env.SOLANA_RPC_ENDPOINT as string).trim();
const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://lite-api.jup.ag';

const connection = new Connection(RPC_ENDPOINT, 'processed');

// Wallet
const PRIVATE_KEY_RAW = process.env.PRIVATE_KEY!;
const walletKeypair = (() => {
  try {
    const secretKey = bs58.decode(PRIVATE_KEY_RAW);
    return Keypair.fromSecretKey(secretKey);
  } catch {
    try {
      const arr = JSON.parse(PRIVATE_KEY_RAW);
      const u8 = Uint8Array.from(arr);
      return Keypair.fromSecretKey(u8);
    } catch {
      throw new Error('PRIVATE_KEY must be base58 or a JSON array.');
    }
  }
})();

console.log(`[Boot] Wallet: ${walletKeypair.publicKey.toBase58()}`);
console.log(`[Boot] RPC: ${connection.rpcEndpoint}`);

const jupiterApi = createJupiterApiClient({});

// -----------------------------
// Tunables
// -----------------------------
const MAX_COMPUTE_UNITS = 1_000_000;
const MAX_QUOTE_AGE_MS = 2500;
const MAX_HOPS_BEFORE_REFRESH = 4;
const SLIPPAGE_CAP_BUY_BPS = 300;  // 3.00%
const SLIPPAGE_CAP_SELL_BPS = 300; // 3.00%
const MIN_SOL_BUFFER = 0.01 * LAMPORTS_PER_SOL;

// Retry/resign loop (avoid blockhash expiry)
const RESEND_ROUNDS = 4;                       // rounds to try
const ROUND_CONFIRM_TIMEOUT_MS = 6_000;        // per-round wait before re-signing
const RESEND_DELAY_MS = 1_000;                 // small delay between rounds
const FEE_MULTIPLIER_PER_ROUND = [1, 2, 3, 5]; // bump priority fee each round

// Jito tips (optional via env)
const JITO_TIP_ACCOUNT_LIST: string = (process.env.JITO_TIP_ACCOUNTS || '').trim();
const JITO_TIP_PUBKEYS: PublicKey[] = (() => {
  if (!JITO_TIP_ACCOUNT_LIST) return [];
  const parts = JITO_TIP_ACCOUNT_LIST.split(',').map(s => s.trim()).filter(Boolean);
  const keys: PublicKey[] = [];
  for (const p of parts) {
    try { keys.push(new PublicKey(p)); } catch { console.warn(`[Tip] Ignoring invalid JITO_TIP_ACCOUNTS entry: "${p}"`); }
  }
  if (keys.length === 0) console.warn('[Tip] No valid Jito tip accounts parsed. Jito tips disabled.');
  return keys;
})();

// Helius Fast Sender tips (required by their sender)
const DEFAULT_HELIUS_TIPS = [
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwtJvVfYgFPyJqjJx",
];
const HELIUS_TIP_ACCOUNT_LIST: string = (process.env.HELIUS_TIP_ACCOUNTS || DEFAULT_HELIUS_TIPS.join(',')).trim();
const HELIUS_TIP_PUBKEYS: PublicKey[] = (() => {
  const parts = HELIUS_TIP_ACCOUNT_LIST.split(',').map(s => s.trim()).filter(Boolean);
  const keys: PublicKey[] = [];
  for (const p of parts) {
    try { keys.push(new PublicKey(p)); } catch { /* ignore */ }
  }
  if (keys.length === 0) console.warn('[Helius Tip] No valid Helius tip accounts parsed. Fast Sender may reject tx.');
  return keys;
})();

// Tip sizes (lamports). Helius tip default a bit higher to be clearly detected.
const JITO_TIP_LAMPORTS = Number(process.env.JITO_TIP_LAMPORTS || 0) | 0;       // 0 = disabled
const HELIUS_TIP_LAMPORTS = Number(process.env.HELIUS_TIP_LAMPORTS || 10_000);  // you set 1,000,000

// ---------------------------------------------
// ✅ Robust token-decimal resolver (multi-fallback)
// ---------------------------------------------
const getTokenDecimals = attachDecimalsResolver(connection);

// ---------------------------------------------
// Helpers
// ---------------------------------------------
export async function getPriorityFeeEstimate(transaction: VersionedTransaction) {
  try {
    const serializedTx = Buffer.from(transaction.serialize()).toString('base64');
    const response = await fetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'getPriorityFeeEstimate',
        params: [{ transaction: serializedTx, options: { priorityLevel: 'High', recommended: true } }],
      }),
    });
    const data = await response.json();
    let fee = data.result?.priorityFeeEstimate || 500_000; // microLamports/CU
    fee = Math.min(Math.max(fee, 5_000), 2_000_000);
    console.log(`[Priority Fee] Using clamped fee: ${fee.toLocaleString()} microLamports`);
    return fee;
  } catch (error: any) {
    console.warn('[Priority Fee] Failed to get dynamic fee, using fallback.', error?.message || error);
    return 500_000;
  }
}

async function getAtaRentLamports(): Promise<number> {
  return await connection.getMinimumBalanceForRentExemption(165);
}

async function needsAtaCreation(mint: PublicKey): Promise<boolean> {
  const ata = await getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const info = await connection.getAccountInfo(ata, 'processed');
  return !info;
}

async function getWalletTokenBalance(mintAddress: string): Promise<bigint> {
  const mint = new PublicKey(mintAddress);
  const ata = await getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const info = await connection.getAccountInfo(ata, 'processed');
  if (!info) return 0n;
  const acc = await getAccount(connection, ata, 'processed');
  return BigInt(acc.amount.toString());
}

type WireIx = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
};

function rehydrateInstruction(instruction?: WireIx | null): TransactionInstruction | null {
  if (!instruction) return null;
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: (instruction.accounts || []).map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(instruction.data, 'base64'),
  });
}

// Add tips & compute spendable SOL after reserving rent + tips
async function buildTipsAndSpendable(
  balLamports: number,
  needsAta: boolean,
  ataRent: number
): Promise<{ jitoTipIx?: TransactionInstruction; heliusTipIx?: TransactionInstruction; spendableLamports: bigint }> {
  console.log(`[Check] Current SOL Balance: ${(balLamports / LAMPORTS_PER_SOL).toFixed(4)}. Needs ATA: ${needsAta}`);
  const rentCost = needsAta ? ataRent : 0;

  let jitoTipIx: TransactionInstruction | undefined;
  let heliusTipIx: TransactionInstruction | undefined;

  if (JITO_TIP_PUBKEYS.length > 0 && JITO_TIP_LAMPORTS > 0) {
    const to = JITO_TIP_PUBKEYS[Math.floor(Math.random() * JITO_TIP_PUBKEYS.length)];
    jitoTipIx = SystemProgram.transfer({ fromPubkey: walletKeypair.publicKey, toPubkey: to, lamports: JITO_TIP_LAMPORTS });
    console.log(`[Tip] Jito tip prepared: ${JITO_TIP_LAMPORTS} lamports -> ${to.toBase58()}`);
  }

  if (HELIUS_TIP_PUBKEYS.length > 0 && HELIUS_TIP_LAMPORTS > 0) {
    const to = HELIUS_TIP_PUBKEYS[Math.floor(Math.random() * HELIUS_TIP_PUBKEYS.length)];
    heliusTipIx = SystemProgram.transfer({ fromPubkey: walletKeypair.publicKey, toPubkey: to, lamports: HELIUS_TIP_LAMPORTS });
    console.log(`[Tip] Helius tip prepared: ${HELIUS_TIP_LAMPORTS} lamports -> ${to.toBase58()}`);
  } else {
    console.warn('[Tip] No Helius tip prepared; Fast Sender may reject.');
  }

  const tipLamports = (jitoTipIx ? JITO_TIP_LAMPORTS : 0) + (heliusTipIx ? HELIUS_TIP_LAMPORTS : 0);
  const requiredForOverhead = MIN_SOL_BUFFER + rentCost + tipLamports;

  if (balLamports <= requiredForOverhead) {
    throw new Error(`Insufficient SOL. Need at least ${(requiredForOverhead / LAMPORTS_PER_SOL).toFixed(6)} SOL for buffer+rent+tips.`);
  }

  const spendableLamports = BigInt(balLamports - requiredForOverhead);
  return { jitoTipIx, heliusTipIx, spendableLamports };
}

// Validation & auto-resolve (Jupiter token search)
async function validateOrResolveMint(inputMint: string, symbol?: string): Promise<string> {
  try {
    const pk = new PublicKey(inputMint);
    const info = await connection.getAccountInfo(pk, 'processed');
    if (info) {
      const isTokenOwner =
        info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID);
      if (isTokenOwner && info.data.length >= 82) {
        console.log(`[Mint] Valid SPL Mint detected for ${inputMint.slice(0, 6)}…`);
        return inputMint;
      }
      console.warn(`[Mint] Account exists but not a valid SPL Mint (owner: ${info.owner.toBase58()}, size: ${info.data.length}).`);
    } else {
      console.warn(`[Mint] No account found for ${inputMint.slice(0, 6)}…`);
    }
  } catch (e: any) {
    console.warn(`[Mint] Invalid mint address format: ${inputMint}. ${e?.message || e}`);
  }

  if (!symbol) {
    throw new Error(`Provided mint "${inputMint}" is invalid and no symbol was provided for resolution.`);
  }

  try {
    const url = `${JUPITER_API_BASE}/tokens/v2/search?query=${encodeURIComponent(symbol)}`;
    const res = await fetch(url);
    const arr = (await res.json()) as any[];
    if (Array.isArray(arr) && arr.length > 0) {
      const exact = arr.find(t => (t?.symbol || '').toUpperCase() === symbol.toUpperCase());
      const candidate = exact || arr[0];
      if (candidate?.address) {
        console.log(`[Mint] Auto-resolved "${symbol}" -> ${candidate.address}`);
        return candidate.address;
      }
    }
    throw new Error('No candidates returned by Jupiter for symbol.');
  } catch (e: any) {
    throw new Error(`Failed to resolve mint from symbol "${symbol}": ${e?.message || e}`);
  }
}

// Quote helper
async function getFreshQuote(
  input_mint: string,
  output_mint: string,
  amountInSmallestUnit: bigint,
  action: 'BUY' | 'SELL'
): Promise<QuoteResponse> {
  let attempts = 0;
  const maxAttempts = 3;
  const slippageBps = action === 'BUY' ? SLIPPAGE_CAP_BUY_BPS : SLIPPAGE_CAP_SELL_BPS;
  console.log(`[Quote] Using ${(slippageBps / 100).toFixed(2)}% slippage cap for ${action}.`);

  while (attempts < maxAttempts) {
    attempts++;
    const started = Date.now();
    try {
      const quote = await jupiterApi.quoteGet({
        inputMint: input_mint,
        outputMint: output_mint,
        amount: Number(amountInSmallestUnit),
        dynamicSlippage: true,
        slippageBps,
        asLegacyTransaction: false,
      });

      if (!quote) {
        if (attempts === maxAttempts) throw new Error('No quote returned by Jupiter.');
        continue;
      }

      const age = Date.now() - started;
      const hops = quote.routePlan.length;
      if (age > MAX_QUOTE_AGE_MS || hops > MAX_HOPS_BEFORE_REFRESH) {
        console.warn(`[Quote] Stale/complex route (Age: ${age}ms, Hops: ${hops}). Refetching (Attempt ${attempts})…`);
        if (attempts === maxAttempts) {
          console.log('[Quote] Max refetch attempts reached. Proceeding with current quote.');
          return quote;
        }
        continue;
      }

      console.log(`[Quote] Fresh quote (Age: ${age}ms, Hops: ${hops}).`);
      return quote;
    } catch (e: any) {
      console.warn(`[Quote] Attempt ${attempts} failed:`, e?.message || e);
      if (attempts === maxAttempts) throw e;
    }
  }

  throw new Error('Failed to obtain a fresh quote.');
}

// Fast status poller (short timeout per round)
async function waitForStatusWithTimeout(sig: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st: RpcResponseAndContext<(SignatureStatus | null)[]> =
      await connection.getSignatureStatuses([sig], { searchTransactionHistory: false });
    const s = st.value?.[0];
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      return true;
    }
    await new Promise(r => setTimeout(r, 400)); // ~2–3 polls/sec
  }
  return false;
}

// ---------------------------------------------
// Signal & Trade Execution
// ---------------------------------------------
export type TradeAction = 'BUY' | 'SELL';

export type TradeSignal = {
  action: TradeAction;
  signal_id: string;

  // Mints & amount
  input_mint: string;
  output_mint: string;
  input_amount: number;

  // Accept any of these symbol fields
  symbol?: string;
  input_symbol?: string;
  output_symbol?: string;
};

export async function executeTradeFromSignal(signal: TradeSignal) {
  const { action, signal_id } = signal;

  // mints & amount can be reassigned if we auto-resolve a bad mint below
  let { input_mint, output_mint, input_amount } = signal;

  // Best symbol for logs & mint resolution:
  const symbolForLogs =
    action === 'BUY'
      ? (signal.output_symbol ?? signal.symbol ?? signal.input_symbol)
      : (signal.input_symbol ?? signal.symbol ?? signal.output_symbol);

  const startTime = Date.now();

  try {
    console.log(`================== [SIGNAL ${signal_id} START] ======================`);

    const botStatus = await getBotStatus();
    if (botStatus !== 'RUNNING') {
      throw new Error(`Bot status is '${botStatus}'. Skipping signal.`);
    }

    // Validate/auto-resolve the token-side mint first
    if (action === 'BUY') {
      output_mint = await validateOrResolveMint(output_mint, symbolForLogs);
    } else {
      input_mint = await validateOrResolveMint(input_mint, symbolForLogs);
    }

    const tokenAddress = action === 'BUY' ? output_mint : input_mint;
    console.log(`✅ Signal Validated: ${action} ${symbolForLogs || tokenAddress.slice(0, 4)}…`);

    // 1) Parallel fetch for speed
    const [
      tokenDecimals,
      solBalanceLamports,
      { blockhash, lastValidBlockHeight },
      needsAta,
      ataRentLamports,
    ] = await Promise.all([
      getTokenDecimals(tokenAddress),
      connection.getBalance(walletKeypair.publicKey, 'processed'),
      connection.getLatestBlockhash('processed'),
      action === 'BUY' ? needsAtaCreation(new PublicKey(output_mint)) : Promise.resolve(false),
      getAtaRentLamports(),
    ]);

    // 2) Tips & sizing
    const { jitoTipIx, heliusTipIx, spendableLamports } = await buildTipsAndSpendable(solBalanceLamports, needsAta, ataRentLamports);

    let outDecimals: number;
    let amountInSmallestUnit: bigint = 0n;

    if (action === 'BUY') {
      outDecimals = tokenDecimals;
      const requestedLamports = BigInt(Math.round(input_amount * LAMPORTS_PER_SOL));
      amountInSmallestUnit = requestedLamports > spendableLamports ? spendableLamports : requestedLamports;
      if (requestedLamports > spendableLamports) {
        console.warn(
          `[Auto-Size] Downsizing BUY from ${input_amount.toFixed(4)} SOL to ${(Number(spendableLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL.`
        );
      }
      console.log(`🟢 Executing BUY for ${(Number(amountInSmallestUnit) / LAMPORTS_PER_SOL).toFixed(4)} SOL -> ${symbolForLogs || 'Token'}`);
    } else {
      outDecimals = 9; // selling token for SOL (SOL decimals)
      const balance = await getWalletTokenBalance(input_mint);
      if (balance === 0n) throw new Error(`No wallet balance for ${symbolForLogs || input_mint}. Skipping SELL.`);
      amountInSmallestUnit = (balance * 9999n) / 10000n; // ~99.99% to avoid dust
      const amountToSellFloat = Number(amountInSmallestUnit) / 10 ** tokenDecimals;
      console.log(`🔴 Executing SELL of ~${amountToSellFloat.toFixed(4)} ${symbolForLogs || 'Token'} (raw: ${amountInSmallestUnit})`);
    }

    // 3) Quote
    const quote = await getFreshQuote(input_mint, output_mint, amountInSmallestUnit, action);
    console.log(`[Jupiter] Quote received. Min out: ${Number(quote.outAmount) / 10 ** outDecimals}. Hops: ${quote.routePlan.length}`);

    // 4) Swap instructions
    const {
      swapInstruction: si,
      setupInstructions: sui,
      cleanupInstruction: cui,
      addressLookupTableAddresses,
    } = await jupiterApi.swapInstructionsPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    const baseInstructions = [
      ...(sui || []).map(rehydrateInstruction).filter(Boolean) as TransactionInstruction[],
      rehydrateInstruction(si)!,
      ...(cui ? [rehydrateInstruction(cui)!] : []),
    ];

    // Add tips last (cheap & ensures Helius sees them)
    if (jitoTipIx) baseInstructions.push(jitoTipIx);
    if (heliusTipIx) baseInstructions.push(heliusTipIx);

    // Lookup tables
    const lookupTableAccounts: AddressLookupTableAccount[] = await Promise.all(
      (addressLookupTableAddresses || []).map(async (address) => {
        const info = await connection.getAccountInfo(new PublicKey(address), 'processed');
        if (!info) throw new Error(`Could not fetch ALT account info for ${address}`);
        return new AddressLookupTableAccount({
          key: new PublicKey(address),
          state: AddressLookupTableAccount.deserialize(info.data),
        });
      })
    );

    // --- Sending strategy with fee bump, blockhash refresh & fast polling ---
    const apiKeyMatch = RPC_ENDPOINT.match(/api-key=([a-zA-Z0-9-]+)/);
    const heliusSenderUrl = apiKeyMatch?.[1]
      ? `https://sender.helius-rpc.com/fast?api-key=${apiKeyMatch[1]}`
      : null;

    let finalSig: string | null = null;

    for (let round = 0; round < RESEND_ROUNDS; round++) {
      const { blockhash: bh } = await connection.getLatestBlockhash('processed');

      // Temp tx for base fee estimate
      const tempMsg = new TransactionMessage({
        payerKey: walletKeypair.publicKey,
        recentBlockhash: bh,
        instructions: baseInstructions,
      }).compileToV0Message(lookupTableAccounts);
      const tempTx = new VersionedTransaction(tempMsg);
      const baseFee = await getPriorityFeeEstimate(tempTx);
      const bump = FEE_MULTIPLIER_PER_ROUND[Math.min(round, FEE_MULTIPLIER_PER_ROUND.length - 1)];
      const priorityFee = Math.floor(baseFee * bump);
      console.log(`[Round ${round + 1}] priorityFee=${priorityFee.toLocaleString()} µLamports/CU`);

      // Sim for CU usage
      const simResult = await connection.simulateTransaction(tempTx, { sigVerify: false, replaceRecentBlockhash: true });
      if (simResult.value.err) throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}`);
      const units = simResult.value.unitsConsumed ?? 400_000;
      let computeUnits = Math.ceil(units * 1.2);
      computeUnits = Math.min(computeUnits, MAX_COMPUTE_UNITS);
      console.log(`[Round ${round + 1}] CU=${computeUnits}`);

      // Final message with compute budget + tips
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
        ...baseInstructions,
      ];

      const finalMessage = new TransactionMessage({
        payerKey: walletKeypair.publicKey,
        recentBlockhash: bh,
        instructions,
      }).compileToV0Message(lookupTableAccounts);

      const finalTx = new VersionedTransaction(finalMessage);
      finalTx.sign([walletKeypair]);

      const rawTx = finalTx.serialize();
      const sendPromises: Promise<string>[] = [];

      // RPC send
      const rpcPromise = connection
        .sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 })
        .then((sig) => { console.log(`[RPC][Round ${round + 1}] Sig: ${sig}`); return sig; })
        .catch((e: any) => { console.warn(`[RPC][Round ${round + 1}] Send failed: ${e?.message || e}`); throw e; });
      sendPromises.push(rpcPromise);

      // Helius Fast Sender (only if configured)
      if (heliusSenderUrl) {
        const rawTxBase64 = Buffer.from(rawTx).toString('base64');
        const heliusPromise = fetch(heliusSenderUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'helius-fast',
            method: 'sendTransaction',
            params: [rawTxBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
          }),
        })
          .then(async (res: any) => {
            const text = await res.text();
            try {
              const json = JSON.parse(text);
              if (!json?.result) {
                console.warn(`[Helius][Round ${round + 1}] Send failed. Body: ${text.slice(0, 500)}`);
                throw new Error('Helius Failed');
              }
              console.log(`[Helius][Round ${round + 1}] Sig: ${json.result}`);
              return json.result as string;
            } catch {
              console.warn(`[Helius][Round ${round + 1}] Non-JSON: ${text.slice(0, 200)}`);
              throw new Error('Helius Failed (non-JSON)');
            }
          })
          .catch((e: any) => {
            console.warn(`[Helius][Round ${round + 1}] Network/API error: ${e?.message || e}`);
            throw e;
          });
        sendPromises.push(heliusPromise);
      }

      // First success wins
      const sig = await new Promise<string>((resolve, reject) => {
        let resolved = false; let errors: any[] = [];
        sendPromises.forEach((p) =>
          p.then((s) => { if (!resolved) { resolved = true; resolve(s); } })
           .catch((err) => { errors.push(err); if (errors.length === sendPromises.length) reject(new Error('All transaction send attempts failed.')); })
        );
      });

      // FAST confirmation polling (short timeout per round)
      console.log(`[Confirm][Round ${round + 1}] Waiting (fast) for ${sig}…`);
      const ok = await waitForStatusWithTimeout(sig, ROUND_CONFIRM_TIMEOUT_MS);
      if (ok) {
        finalSig = sig;
        break;
      }

      console.warn(`[Confirm][Round ${round + 1}] Not confirmed in ${ROUND_CONFIRM_TIMEOUT_MS}ms. Re-signing with higher fee…`);
      await new Promise(r => setTimeout(r, RESEND_DELAY_MS));
    }

    if (!finalSig) {
      throw new Error('Failed to confirm transaction before blockhash expiry after all retries.');
    }

    // Success
    const endTime = Date.now();
    console.log(`✅ Swap successful! Total time: ${endTime - startTime}ms. Tx: https://solscan.io/tx/${finalSig}`);

    // Log amounts: BUY logs intended SOL spent from quote.inAmount; SELL logs SOL received from quote.outAmount
    const solAmountForLog =
      action === 'BUY'
        ? Number(quote.inAmount) / LAMPORTS_PER_SOL
        : Number(quote.outAmount) / LAMPORTS_PER_SOL;

    if (action === 'BUY') {
      await managePosition({
        signal_id,
        status: 'open',
        openedAt: new Date(),
        tokenAddress: output_mint,
        tokenSymbol: symbolForLogs,
        solAmount: solAmountForLog,
        tokenReceived: Number(quote.outAmount) / 10 ** (await getTokenDecimals(output_mint)),
        txid: finalSig,
      });
    } else {
      await managePosition({
        signal_id,
        status: 'closed',
        closedAt: new Date(),
        solReceived: solAmountForLog,
        exitTx: finalSig,
      });
    }

    await logTradeToFirestore({
      txid: finalSig,
      signal_id,
      action,
      symbol: symbolForLogs || undefined,
      solAmount: solAmountForLog,
      timestamp: new Date(),
      durationMs: endTime - startTime,
      status: 'Success',
    });

    console.log(`================== [SIGNAL ${signal_id} END] ======================`);
  } catch (error: any) {
    const endTime = Date.now();
    console.error(`🛑 [FATAL] Trade for Signal ID ${signal_id} failed in ${endTime - startTime}ms:`, error?.message || error);

    await logTradeToFirestore({
      txid: null,
      signal_id,
      action: signal.action,
      symbol: signal.symbol ?? signal.output_symbol ?? signal.input_symbol,
      solAmount: null,
      error: error?.message || String(error),
      timestamp: new Date(),
      durationMs: endTime - startTime,
      status: 'Failed',
    });

    console.log(`================== [SIGNAL ${signal_id} END] ======================`);
  }
}
