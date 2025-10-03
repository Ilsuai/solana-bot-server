import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL,
  PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getMint, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import bs58 from 'bs58';
// @ts-ignore
import fetch from 'node-fetch';
import { logTradeToFirestore, getBotStatus, managePosition } from './firebaseAdmin';

// --- CONFIGURATION & CONSTANTS ---
if (!process.env.SOLANA_RPC_ENDPOINT || !process.env.PRIVATE_KEY) {
  throw new Error('Missing environment variables: SOLANA_RPC_ENDPOINT and PRIVATE_KEY must be set.');
}
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'processed');
const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const jupiterApi = createJupiterApiClient();
const JITO_TIP_ACCOUNTS = (process.env.JITO_TIP_ACCOUNTS || "96gYgAKpdZvy5M2sZpSoe6W6h4scqw4v9v7K6h4xW6h4,HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucL4bge9fgo,D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ").split(',').map(k => new PublicKey(k));
const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

// Solvency Constants
const MIN_SOL_BUFFER = 0.02 * LAMPORTS_PER_SOL;
const EST_FEE_LAMPORTS = 600000;

// Optimization Constants
const SLIPPAGE_CAP_BUY_BPS = 1500;
const SLIPPAGE_CAP_SELL_BPS = 4000;
const MAX_QUOTE_AGE_MS = 1500;
const MAX_HOPS_BEFORE_REFRESH = 2;
const MAX_COMPUTE_UNITS = 800000; // Safer CU cap for complex swaps

// --- TYPES ---
export type TradeSignal = {
  action: 'BUY' | 'SELL';
  signal_id: number | string;
  input_mint: string;
  output_mint: string;
  input_amount: number;
  symbol?: string;
};

// --- HELPER FUNCTIONS ---

// Dynamic ATA Rent Function
async function getAtaRentLamports(): Promise<number> {
  try {
    // 165 bytes is the size of a standard SPL Token account
    return await connection.getMinimumBalanceForRentExemption(165);
  } catch(e) {
    console.warn("[Rent] Failed to fetch dynamic ATA rent, using fallback.", e);
    return 2039280; // Fallback to a safe, hardcoded value
  }
}

async function needsAtaCreation(mint: PublicKey): Promise<boolean> {
  const atas = await Promise.all([
    getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  ]);
  const accountInfos = await connection.getMultipleAccountsInfo(atas, 'processed');
  return accountInfos.every(info => info === null || info.data.length === 0);
}

async function getWalletTokenBalance(mintStr: string): Promise<bigint> {
  const mint = new PublicKey(mintStr);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, programId);
      const acc = await getAccount(connection, ata, 'processed', programId);
      console.log(`[Balance] Found token balance for ${mintStr.slice(0,4)}...: ${acc.amount}`);
      return acc.amount;
    } catch (_) { /* try next program id */ }
  }
  return 0n;
}

async function getTokenDecimals(mintAddress: string): Promise<number> {
  // Handle SOL mint explicitly for speed
  if (mintAddress === SOL_MINT_ADDRESS) return 9;

  const pk = new PublicKey(mintAddress);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const decimals = (await getMint(connection, pk, 'processed', programId)).decimals;
      console.log(`[Decimals] Found ${decimals} decimals for ${mintAddress.slice(0,4)}... using SPL Token program.`);
      return decimals;
    } catch (_) {}
  }
  try {
    // @ts-ignore
    const res = await fetch(`https://token.jup.ag/v2/mint?mints=${mintAddress}`);
    if(!res.ok) throw new Error(`Jupiter Token API failed with status ${res.status}`);
    const json = await res.json() as any;
    const d = json?.[0]?.decimals;
    if (typeof d === 'number') {
        console.log(`[Decimals] Found ${d} decimals for ${mintAddress.slice(0,4)}... using Jupiter API fallback.`);
        return d;
    }
  } catch (e) {
      console.warn(`[Decimals] Jupiter Token API fallback failed: ${(e as Error).message}`);
  }
  throw new Error(`Could not fetch decimals for token ${mintAddress} after all fallbacks.`);
}

// Updated Priority Fee Function with Clamping
async function getPriorityFeeEstimate(transaction: VersionedTransaction): Promise<number> {
  try {
    // Use base64 encoding for the fee estimate request
    const serializedTx = Buffer.from(transaction.serialize()).toString('base64');
    // @ts-ignore
    const response = await fetch(connection.rpcEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: '1', method: 'getPriorityFeeEstimate',
            // Requesting 'High' priority level
            params: [{ transaction: serializedTx, options: { priorityLevel: 'High', recommended: true } }],
        }),
    });
    const data = await response.json() as any;
    let fee = data.result?.priorityFeeEstimate || 500000;

    // Safety Guardrail: Clamp the fee to a sane range
    fee = Math.min(Math.max(fee, 5000), 2000000); // Min 5k, Max 2M microLamports/CU

    console.log(`[Priority Fee] Using clamped fee: ${fee.toLocaleString()} microLamports`);
    return fee;
  } catch (error) {
    console.warn("[Priority Fee] Failed to get dynamic fee, using fallback.", error);
    return 500000;
  }
}

async function getSolvencyAndTip(balLamports: number, needsAta: boolean, ataRent: number): Promise<{ tipLamports: number, spendableLamports: bigint }> {
  console.log(`[Check] Current SOL Balance: ${(balLamports / LAMPORTS_PER_SOL).toFixed(4)}. Needs ATA: ${needsAta}`);
  const rentCost = needsAta ? ataRent : 0; // Use dynamic rent
  let tipLamports = 0.001 * LAMPORTS_PER_SOL;
  const requiredForOverhead = MIN_SOL_BUFFER + EST_FEE_LAMPORTS + rentCost;

  if (balLamports < requiredForOverhead + tipLamports) {
    const remainingSol = balLamports - requiredForOverhead;
    if (remainingSol <= 0) {
      throw new Error(`Insufficient SOL for minimum buffer + fees + rent. Balance: ${(balLamports / LAMPORTS_PER_SOL).toFixed(4)}`);
    }
    tipLamports = Math.max(0.0003 * LAMPORTS_PER_SOL, remainingSol);
    console.warn(`[SOL Buffer] Low SOL balance. Scaling tip down to ${(tipLamports / LAMPORTS_PER_SOL).toFixed(5)} SOL.`);
  }

  const spendableLamports = BigInt(Math.max(0, balLamports - (requiredForOverhead + tipLamports)));
  return { tipLamports: Math.round(tipLamports), spendableLamports };
}

const rehydrateInstruction = (instruction: any): TransactionInstruction | null => {
    if (!instruction) return null;
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: (instruction.accounts || []).map((key: any) => ({
            pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, 'base64'),
    });
};

async function getFreshQuote(input_mint: string, output_mint: string, amountInSmallestUnit: bigint, action: 'BUY' | 'SELL'): Promise<QuoteResponse> {
    let attempts = 0;
    const maxAttempts = 3;
    const slippageBps = action === 'BUY' ? SLIPPAGE_CAP_BUY_BPS : SLIPPAGE_CAP_SELL_BPS;
    console.log(`[Quote] Using ${slippageBps / 100}% slippage cap for ${action}.`);

    while (attempts < maxAttempts) {
        attempts++;
        const quoteStartTime = Date.now();
        let quote;
        try {
            quote = await jupiterApi.quoteGet({
                inputMint: input_mint, outputMint: output_mint, amount: Number(amountInSmallestUnit),
                dynamicSlippage: true, slippageBps: slippageBps, asLegacyTransaction: false,
            });
        } catch (error) {
             console.warn(`[Quote] Attempt ${attempts} failed:`, (error as Error).message);
             continue;
        }

        if (!quote) {
            if (attempts === maxAttempts) throw new Error("Failed to get quote from Jupiter after attempts.");
            continue;
        }

        const quoteAge = Date.now() - quoteStartTime;
        const hopCount = quote.routePlan.length;

        if (quoteAge > MAX_QUOTE_AGE_MS || hopCount > MAX_HOPS_BEFORE_REFRESH) {
            console.warn(`[Quote] Quote is stale (Age: ${quoteAge}ms, Hops: ${hopCount}). Refetching (Attempt ${attempts})...`);
            if (attempts === maxAttempts) {
                console.log("[Quote] Max refetch attempts reached. Proceeding with current quote.");
                return quote;
            }
            continue;
        }

        console.log(`[Quote] Fresh quote received (Age: ${quoteAge}ms, Hops: ${hopCount}).`);
        return quote;
    }
    throw new Error("Failed to obtain a fresh quote.");
}

// --- CORE TRADE LOGIC ---
export async function executeTradeFromSignal(signal: TradeSignal) {
  const { action, signal_id, input_mint, output_mint, input_amount, symbol } = signal;
  const startTime = Date.now();

  try {
    // Operational Safety Check
    const botStatus = await getBotStatus();
    if (botStatus !== 'RUNNING') {
      throw new Error(`Bot status is '${botStatus}'. Skipping signal.`);
    }
    
    // Determine the token involved in the trade (non-SOL side)
    const tokenAddress = action === 'BUY' ? output_mint : input_mint;
    console.log(`✅ Signal Validated: ${action} ${symbol || tokenAddress.slice(0,4)}`);

    // Step 1: Parallelized Data Fetching (Speed Optimization)
    const [tokenDecimals, solBalanceLamports, { blockhash, lastValidBlockHeight }, needsAta, ataRentLamports] = await Promise.all([
      getTokenDecimals(tokenAddress),
      connection.getBalance(walletKeypair.publicKey, 'processed'),
      connection.getLatestBlockhash('processed'),
      action === 'BUY' ? needsAtaCreation(new PublicKey(output_mint)) : Promise.resolve(false),
      getAtaRentLamports(), // Fetch rent dynamically
    ]);

    // Step 2: Solvency Check and Auto-Sizing
    const { tipLamports, spendableLamports } = await getSolvencyAndTip(solBalanceLamports, needsAta, ataRentLamports);

    let amountInSmallestUnit: bigint;
    // Determine output decimals for accurate logging later (Optimization: reuse fetched decimals)
    let outDecimals: number;

    if (action === 'BUY') {
      outDecimals = tokenDecimals; // Buying the token
      const requestedAmountLamports = BigInt(Math.round(input_amount * LAMPORTS_PER_SOL));
      if (requestedAmountLamports > spendableLamports) {
        if (spendableLamports <= 0n) {
          throw new Error("Insufficient SOL to execute any BUY trade after overhead costs.");
        }
        console.warn(`[Auto-Size] Insufficient SOL. Downsizing BUY from ${input_amount.toFixed(4)} SOL to ${(Number(spendableLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL.`);
        amountInSmallestUnit = spendableLamports;
      } else {
        amountInSmallestUnit = requestedAmountLamports;
      }
      console.log(`🟢 Executing BUY for ${(Number(amountInSmallestUnit) / LAMPORTS_PER_SOL).toFixed(4)} SOL -> ${symbol || 'Token'}`);
    } else { // SELL
      outDecimals = 9; // Selling for SOL
      const balance = await getWalletTokenBalance(input_mint);
      if (balance === 0n) throw new Error(`No wallet balance for ${symbol} (${input_mint}). Skipping SELL.`);
      amountInSmallestUnit = (balance * 9999n) / 10000n;
      const amountToSellFloat = Number(amountInSmallestUnit) / (10 ** tokenDecimals);
      console.log(`🔴 Executing SELL of ~${amountToSellFloat.toFixed(4)} ${symbol || 'Token'} (raw: ${amountInSmallestUnit})`);
    }

    // Step 3: Fresh Quoting
    const quote = await getFreshQuote(input_mint, output_mint, amountInSmallestUnit, action);

    // Accurate minOut Logging (using pre-fetched outDecimals)
    console.log(`[Jupiter] Quote received. Min out: ${Number(quote.outAmount) / (10 ** outDecimals)}. Hops: ${quote.routePlan.length}`);

    // Step 4: Transaction Construction
    const { swapInstruction: si, setupInstructions: sui, cleanupInstruction: cui, addressLookupTableAddresses } = await jupiterApi.swapInstructionsPost({
        swapRequest: { quoteResponse: quote, userPublicKey: walletKeypair.publicKey.toBase58(), wrapAndUnwrapSol: true },
    });

    const instructions = [
      ...(sui || []).map(rehydrateInstruction),
      rehydrateInstruction(si),
      ...(cui ? [rehydrateInstruction(cui)] : []),
    ].filter((ix): ix is TransactionInstruction => ix !== null);

    const tipInstruction = SystemProgram.transfer({
        fromPubkey: walletKeypair.publicKey,
        toPubkey: JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)],
        lamports: tipLamports,
    });

    const lookupTableAccounts = await Promise.all((addressLookupTableAddresses || []).map(async (address) => {
        const accountInfo = await connection.getAccountInfo(new PublicKey(address), 'processed');
        if (!accountInfo) throw new Error(`Could not fetch ALT account info for ${address}`);
        return new AddressLookupTableAccount({ key: new PublicKey(address), state: AddressLookupTableAccount.deserialize(accountInfo.data) });
    }));
    if (lookupTableAccounts.length > 0) {
        console.log(`[Build] Loaded ${lookupTableAccounts.length} Address Lookup Tables.`);
    }

    // Step 5: Simulation and Compute Budget
    let tempMessage = new TransactionMessage({
        payerKey: walletKeypair.publicKey, recentBlockhash: blockhash, instructions: [...instructions, tipInstruction],
    }).compileToV0Message(lookupTableAccounts);
    let tempTransaction = new VersionedTransaction(tempMessage);

    const [priorityFee, simResult] = await Promise.all([
        getPriorityFeeEstimate(tempTransaction),
        connection.simulateTransaction(tempTransaction, { sigVerify: false, replaceRecentBlockhash: true })
    ]);

    if (simResult.value.err) throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}`);
    const unitsConsumed = simResult.value.unitsConsumed!;
    let computeUnits = Math.ceil(unitsConsumed * 1.2); // 20% margin

    // Clamp Compute Units (using the safer MAX_COMPUTE_UNITS)
    computeUnits = Math.min(computeUnits, MAX_COMPUTE_UNITS);

    console.log(`[Simulate] Units consumed: ${unitsConsumed}. Setting clamped limit: ${computeUnits}`);

    const finalInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...instructions, tipInstruction
    ];
    let finalMessage = new TransactionMessage({
        payerKey: walletKeypair.publicKey, recentBlockhash: blockhash, instructions: finalInstructions,
    }).compileToV0Message(lookupTableAccounts);
    let finalTransaction = new VersionedTransaction(finalMessage);
    finalTransaction.sign([walletKeypair]);

    const rawTransaction = finalTransaction.serialize();

    // Step 6: Simultaneous Send (Turbo Send)
    console.log('[Send] Blasting transaction simultaneously via Helius Sender and Standard RPC...');
    const apiKeyMatch = process.env.SOLANA_RPC_ENDPOINT!.match(/api-key=([a-zA-Z0-9-]+)/);
    const sendPromises: Promise<string>[] = [];

    // Use base64 encoding for Helius Sender
    const rawTxBase64 = Buffer.from(rawTransaction).toString("base64");

    if (apiKeyMatch && apiKeyMatch[1]) {
        const senderUrl = `https://sender.helius-rpc.com/fast?api-key=${apiKeyMatch[1]}`;

        // 1. Helius Sender (using base64)
        // @ts-ignore
        const heliusPromise = fetch(senderUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 'helius-fast', method: 'sendTransaction',
                params: [ rawTxBase64, { encoding: "base64", skipPreflight: true, maxRetries: 0 } ],
            }),
        }).then(async (response: any) => {
            // Improved error diagnostics
            const text = await response.text();
            let json: any;
            try { json = JSON.parse(text); } catch(e) {}

            if (!json?.result) {
                console.warn(`[Helius] Send failed. Body: ${text.slice(0, 500)}`);
                throw new Error('Helius Failed');
            }
            console.log(`[Helius] Transaction potentially landed. Signature: ${json.result}`);
            return json.result as string;
        }).catch((e: Error) => {
            console.warn(`[Helius] Network/API error: ${e.message}`);
            throw e;
        });
        sendPromises.push(heliusPromise);
    } else {
        console.warn("[Send] Helius API key not found in RPC URL. Skipping Helius Sender.");
    }

    // 2. Standard RPC (uses Uint8Array natively)
    const rpcPromise = connection.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 })
        .then(txid => {
            console.log(`[RPC] Transaction potentially landed. Signature: ${txid}`);
            return txid;
        }).catch(e => {
            console.warn(`[RPC] Send attempt failed: ${(e as Error).message}`);
            throw e;
        });
    sendPromises.push(rpcPromise);

    // Wait for the first successful send (Promise.any fallback)
    let txid: string;
    try {
        txid = await new Promise((resolve, reject) => {
            let errors: any[] = [];
            let resolved = false;
            if (sendPromises.length === 0) {
                reject(new Error("No send methods configured."));
                return;
            }
            sendPromises.forEach(p => {
                p.then(result => {
                    if (!resolved) {
                        resolved = true;
                        resolve(result);
                    }
                }).catch(error => {
                    errors.push(error);
                    if (errors.length === sendPromises.length) {
                        reject(new Error("All transaction send attempts failed."));
                    }
                });
            });
        });
    } catch (e) {
        throw e;
    }

    // Step 7: Confirmation
    console.log(`[Confirm] Waiting for confirmation for TxID: ${txid}...`);
    const confResult = await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confResult.value.err) throw new Error(`Confirmation failed: ${JSON.stringify(confResult.value.err)}`);

    const endTime = Date.now();
    console.log(`✅ Swap successful! Total time: ${endTime - startTime}ms. Tx: https://solscan.io/tx/${txid}`);

     if (action === 'BUY') {
      await managePosition({
        signal_id: signal_id,
        status: 'open',
        openedAt: new Date(),
        tokenAddress: output_mint,
        tokenSymbol: symbol,
        // **FIX**: Changed 'solSpent' to 'solAmount' for consistency
        solAmount: Number(amountInSmallestUnit) / LAMPORTS_PER_SOL,
        tokenReceived: Number(quote.outAmount) / (10 ** tokenDecimals),
        txid: txid,
      });
    } else { // SELL
      await managePosition({
        signal_id: signal_id,
        status: 'closed',
        closedAt: new Date(),
        solReceived: Number(quote.outAmount) / LAMPORTS_PER_SOL,
        exitTx: txid,
      });
    }
    
    await logTradeToFirestore({ txid, signal_id, action, symbol, solAmount: Number(amountInSmallestUnit) / LAMPORTS_PER_SOL, timestamp: new Date(), durationMs: endTime - startTime, status: 'Success' });
    console.log(`================== [SIGNAL ${signal_id} END] ======================`);

  } catch (error: any) {
    const endTime = Date.now();
    console.error(`🛑 [FATAL] Trade for Signal ID ${signal_id} failed in ${endTime - startTime}ms:`, error.message);
    await logTradeToFirestore({ txid: null, signal_id, action, symbol, error: error.message, timestamp: new Date(), durationMs: endTime - startTime, status: 'Failed' });
    console.log(`================== [SIGNAL ${signal_id} END] ======================`);
  }
}