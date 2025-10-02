import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL,
  PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
// Import ASSOCIATED_TOKEN_PROGRAM_ID for accurate ATA checks
import { getAssociatedTokenAddress, getMint, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import bs58 from 'bs58';
// @ts-ignore
import fetch from 'node-fetch';
import { logTradeToFirestore } from './firebaseAdmin';

// --- CONFIGURATION & CONSTANTS ---
if (!process.env.SOLANA_RPC_ENDPOINT || !process.env.PRIVATE_KEY) {
  throw new Error('Missing environment variables: SOLANA_RPC_ENDPOINT and PRIVATE_KEY must be set.');
}
// Using 'processed' commitment for the connection allows faster reads (freshest state), crucial for speed.
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'processed');
const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const jupiterApi = createJupiterApiClient();
const JITO_TIP_ACCOUNTS = (process.env.JITO_TIP_ACCOUNTS || "96gYgAKpdZvy5M2sZpSoe6W6h4scqw4v9v7K6h4xW6h4,HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucL4bge9fgo,D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ").split(',').map(k => new PublicKey(k));

// Solvency Constants (Recommendation 2: Auto-Sizing)
const MIN_SOL_BUFFER = 0.02 * LAMPORTS_PER_SOL;
const EST_FEE_LAMPORTS = 600000; // Conservative estimate for base tx fees (0.0006 SOL)
const ATA_RENT_EXEMPTION = 2039280; // ~0.00204 SOL required for ATA creation (rent exemption)

// Optimization Constants (Recommendation 1: Slippage & Staleness)
const DYNAMIC_SLIPPAGE_MAX_BPS = 2500; // 25% Max Dynamic Slippage Cap for volatile pairs
const MAX_QUOTE_AGE_MS = 1500; // 1.5 seconds
const MAX_HOPS_BEFORE_REFRESH = 2; // Refetch if 3 or more hops

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

/**
 * Checks if an Associated Token Account (ATA) needs creation using efficient batch calls.
 */
async function needsAtaCreation(mint: PublicKey): Promise<boolean> {
  // Generate PDAs for both standard SPL Token and Token-2022
  const atas = await Promise.all([
    getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  ]);

  // Fetch account info in a single batch call (Speed Optimization)
  const accountInfos = await connection.getMultipleAccountsInfo(atas, 'processed');

  // If no account info exists for either PDA, the ATA needs creation.
  return accountInfos.every(info => info === null || info.data.length === 0);
}

async function getWalletTokenBalance(mintStr: string): Promise<bigint> {
  const mint = new PublicKey(mintStr);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, programId);
      // Using 'processed' for faster balance reading
      const acc = await getAccount(connection, ata, 'processed', programId);
      console.log(`[Balance] Found token balance for ${mintStr.slice(0,4)}...: ${acc.amount}`);
      return acc.amount;
    } catch (_) { /* try next program id */ }
  }
  return 0n;
}

async function getTokenDecimals(mintAddress: string): Promise<number> {
  const pk = new PublicKey(mintAddress);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      // Using 'processed' for faster reading
      const decimals = (await getMint(connection, pk, 'processed', programId)).decimals;
      console.log(`[Decimals] Found ${decimals} decimals for ${mintAddress.slice(0,4)}... using SPL Token program.`);
      return decimals;
    } catch (_) {}
  }
  // Fallback to Jupiter API
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

async function getPriorityFeeEstimate(transaction: VersionedTransaction): Promise<number> {
    try {
        // @ts-ignore
        const response = await fetch(connection.rpcEndpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: '1', method: 'getPriorityFeeEstimate',
                params: [{ transaction: bs58.encode(transaction.serialize()), options: { includeAllFees: true } }],
            }),
        });
        const data = await response.json() as any;
        const fee = data.result?.priorityFeeEstimate || 500000;
        console.log(`[Priority Fee] Using dynamic fee: ${fee.toLocaleString()} microLamports`);
        return fee;
    } catch (error) {
        console.warn("[Priority Fee] Failed to get dynamic fee, using fallback.", error);
        return 500000; // Fallback fee
    }
}

/**
 * Comprehensive Solvency Management. Calculates Jito tip and actual spendable SOL for BUYs.
 * Prevents {"Custom": 1} Insufficient Funds errors.
 */
async function getSolvencyAndTip(balLamports: number, needsAta: boolean): Promise<{ tipLamports: number, spendableLamports: bigint }> {
  console.log(`[Check] Current SOL Balance: ${(balLamports / LAMPORTS_PER_SOL).toFixed(4)}. Needs ATA: ${needsAta}`);

  const rentCost = needsAta ? ATA_RENT_EXEMPTION : 0;
  let tipLamports = 0.001 * LAMPORTS_PER_SOL; // Default tip (0.001 SOL)

  // Total overhead required (Buffer + Fees + Potential Rent)
  const requiredForOverhead = MIN_SOL_BUFFER + EST_FEE_LAMPORTS + rentCost;

  if (balLamports < requiredForOverhead + tipLamports) {
    // Calculate remaining SOL after required overhead
    const remainingSol = balLamports - requiredForOverhead;

    if (remainingSol <= 0) {
      throw new Error(`Insufficient SOL for minimum buffer + fees + rent. Balance: ${(balLamports / LAMPORTS_PER_SOL).toFixed(4)}`);
    }

    // Scale down the tip if necessary, ensuring a minimum viable tip (e.g., 0.0003 SOL)
    tipLamports = Math.max(0.0003 * LAMPORTS_PER_SOL, remainingSol);
    console.warn(`[SOL Buffer] Low SOL balance. Scaling tip down to ${(tipLamports / LAMPORTS_PER_SOL).toFixed(5)} SOL.`);
  }

  // Calculate the actual spendable SOL for the trade itself
  const spendableLamports = BigInt(Math.max(0, balLamports - (requiredForOverhead + tipLamports)));

  return { tipLamports: Math.round(tipLamports), spendableLamports };
}


const rehydrateInstruction = (instruction: any): TransactionInstruction | null => {
    if (!instruction) return null;
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        // Crucial: Use accounts, not keys, as confirmed in the project overview
        keys: (instruction.accounts || []).map((key: any) => ({
            pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, 'base64'),
    });
};

/**
 * Fetches a quote and implements the Quote Staleness Guard.
 */
async function getFreshQuote(input_mint: string, output_mint: string, amountInSmallestUnit: bigint): Promise<QuoteResponse> {
    let attempts = 0;
    const maxAttempts = 3; // Limit refetch attempts

    while (attempts < maxAttempts) {
        attempts++;
        const quoteStartTime = Date.now();

        let quote;
        try {
            quote = await jupiterApi.quoteGet({
                inputMint: input_mint,
                outputMint: output_mint,
                amount: Number(amountInSmallestUnit),
                // Utilize Dynamic Slippage (Recommendation 1)
                // Adjusted for SDK version: Use boolean true, and set slippageBps as the cap.
                dynamicSlippage: true,
                slippageBps: DYNAMIC_SLIPPAGE_MAX_BPS,
                asLegacyTransaction: false,
            });
        } catch (error) {
             console.warn(`[Quote] Attempt ${attempts} failed:`, (error as Error).message);
             continue;
        }

        if (!quote) {
            if (attempts === maxAttempts) throw new Error("Failed to get quote from Jupiter after attempts.");
            continue;
        }

        // Staleness Guard (Recommendation 1)
        const quoteAge = Date.now() - quoteStartTime;
        const hopCount = quote.routePlan.length;

        if (quoteAge > MAX_QUOTE_AGE_MS || hopCount > MAX_HOPS_BEFORE_REFRESH) {
            console.warn(`[Quote] Quote is stale (Age: ${quoteAge}ms, Hops: ${hopCount}). Refetching (Attempt ${attempts})...`);
            if (attempts === maxAttempts) {
                console.log("[Quote] Max refetch attempts reached. Proceeding with current quote.");
                return quote;
            }
            continue; // Refetch
        }

        console.log(`[Quote] Fresh quote received (Age: ${quoteAge}ms, Hops: ${hopCount}).`);
        return quote;
    }
    throw new Error("Failed to obtain a fresh quote.");
}


// --- CORE TRADE LOGIC ---

export async function executeTradeFromSignal(signal: TradeSignal) {
  const { action, signal_id, input_mint, output_mint, input_amount, symbol } = signal;
  const startTime = Date.now(); // Start timer for performance tracking

  try {
    const tokenAddress = action === 'BUY' ? output_mint : input_mint;
    console.log(`✅ Signal Validated: ${action} ${symbol || tokenAddress.slice(0,4)}`);

    // Step 1: Parallelized Data Fetching (Speed Optimization)
    // Fetch all necessary data simultaneously for maximum speed.
    const [tokenDecimals, solBalanceLamports, { blockhash, lastValidBlockHeight }, needsAta] = await Promise.all([
      getTokenDecimals(tokenAddress),
      connection.getBalance(walletKeypair.publicKey, 'processed'),
      connection.getLatestBlockhash('processed'),
      // Only check ATA existence for BUY orders for solvency calculation
      action === 'BUY' ? needsAtaCreation(new PublicKey(output_mint)) : Promise.resolve(false),
    ]);

    // Step 2: Solvency Check and Auto-Sizing (Reliability Optimization - Recommendation 2)
    const { tipLamports, spendableLamports } = await getSolvencyAndTip(solBalanceLamports, needsAta);


    let amountInSmallestUnit: bigint;
    if (action === 'BUY') {
      const requestedAmountLamports = BigInt(Math.round(input_amount * LAMPORTS_PER_SOL));

      // Auto-Sizing Implementation
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

    } else { // SELL (Trust the Wallet logic remains)
      const balance = await getWalletTokenBalance(input_mint);
      if (balance === 0n) throw new Error(`No wallet balance for ${symbol} (${input_mint}). Skipping SELL.`);

      amountInSmallestUnit = (balance * 9999n) / 10000n; // Sell 99.99% to leave dust
      const amountToSellFloat = Number(amountInSmallestUnit) / (10 ** tokenDecimals);
      console.log(`🔴 Executing SELL of ~${amountToSellFloat.toFixed(4)} ${symbol || 'Token'} (raw: ${amountInSmallestUnit})`);
    }

    // Step 3: Fresh Quoting (Staleness Guard & Dynamic Slippage)
    const quote = await getFreshQuote(input_mint, output_mint, amountInSmallestUnit);

    console.log(`[Jupiter] Quote received. Min out: ${Number(quote.outAmount) / (10 ** (action === 'BUY' ? tokenDecimals : 9))}. Hops: ${quote.routePlan.length}`);

    // Step 4: Transaction Construction
    const {
      swapInstruction: si, setupInstructions: sui, cleanupInstruction: cui, addressLookupTableAddresses,
    } = await jupiterApi.swapInstructionsPost({
        swapRequest: { quoteResponse: quote, userPublicKey: walletKeypair.publicKey.toBase58(), wrapAndUnwrapSol: true },
    });

    const instructions = [
      ...(sui || []).map(rehydrateInstruction),
      rehydrateInstruction(si),
      ...(cui ? [rehydrateInstruction(cui)] : []),
    ].filter((ix): ix is TransactionInstruction => ix !== null);

    // Jito Tip Instruction
    const tipInstruction = SystemProgram.transfer({
        fromPubkey: walletKeypair.publicKey,
        toPubkey: JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)],
        lamports: tipLamports,
    });

    // Load Address Lookup Tables (ALTs)
    const lookupTableAccounts = await Promise.all((addressLookupTableAddresses || []).map(async (address) => {
        const accountInfo = await connection.getAccountInfo(new PublicKey(address), 'processed');
        if (!accountInfo) throw new Error(`Could not fetch ALT account info for ${address}`);
        return new AddressLookupTableAccount({ key: new PublicKey(address), state: AddressLookupTableAccount.deserialize(accountInfo.data) });
    }));
    if (lookupTableAccounts.length > 0) {
        console.log(`[Build] Loaded ${lookupTableAccounts.length} Address Lookup Tables.`);
    }

    // Step 5: Simulation and Compute Budget
    // Build a temporary transaction to estimate priority fees and simulate
    let tempMessage = new TransactionMessage({
        payerKey: walletKeypair.publicKey, recentBlockhash: blockhash, instructions: [...instructions, tipInstruction],
    }).compileToV0Message(lookupTableAccounts);
    let tempTransaction = new VersionedTransaction(tempMessage);

    // Parallelize priority fee estimation and simulation (Speed Optimization)
    const [priorityFee, simResult] = await Promise.all([
        getPriorityFeeEstimate(tempTransaction),
        // Simulation provides the exact compute units needed.
        connection.simulateTransaction(tempTransaction, { sigVerify: false, replaceRecentBlockhash: true })
    ]);


    if (simResult.value.err) throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}`);
    const unitsConsumed = simResult.value.unitsConsumed!;
    const computeUnits = Math.ceil(unitsConsumed * 1.2); // Apply 20% margin
    console.log(`[Simulate] Units consumed: ${unitsConsumed}. Setting limit with 20% margin: ${computeUnits}`);

    // Final transaction assembly
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

    // Step 6: Simultaneous Send (Turbo Send Strategy - Speed Optimization)
    console.log('[Send] Blasting transaction simultaneously via Helius Sender and Standard RPC...');

    // Extract API key safely
    const apiKeyMatch = process.env.SOLANA_RPC_ENDPOINT!.match(/api-key=([a-zA-Z0-9-]+)/);
    const sendPromises: Promise<string>[] = [];

    if (apiKeyMatch && apiKeyMatch[1]) {
        const senderUrl = `https://sender.helius-rpc.com/fast?api-key=${apiKeyMatch[1]}`;

        // 1. Helius Sender Promise
        // @ts-ignore
        const heliusPromise = fetch(senderUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 'helius-fast', method: 'sendTransaction',
                params: [
                    bs58.encode(rawTransaction),
                    // Use base58 encoding, skip preflight checks, and set maxRetries to 0 for speed
                    { encoding: "base58", skipPreflight: true, maxRetries: 0 }
                ],
            }),
        }).then(async (response: any) => {
            const json = await response.json() as any;
            if (json.error || !json.result) {
                console.warn(`[Helius] Send attempt failed: ${json.error?.message || 'No signature returned'}`);
                throw new Error('Helius Failed');
            }
            console.log(`[Helius] Transaction potentially landed. Signature: ${json.result}`);
            return json.result;
        }).catch((e: Error) => {
            console.warn(`[Helius] Network/API error: ${e.message}`);
            throw e;
        });
        sendPromises.push(heliusPromise);
    } else {
        console.warn("[Send] Helius API key not found in RPC URL. Skipping Helius Sender.");
    }


    // 2. Standard RPC Promise
    // Also set maxRetries to 0 here for the simultaneous blast strategy (we rely on the network accepting the first one)
    const rpcPromise = connection.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 })
        .then(txid => {
            console.log(`[RPC] Transaction potentially landed. Signature: ${txid}`);
            return txid;
        }).catch(e => {
            console.warn(`[RPC] Send attempt failed: ${(e as Error).message}`);
            throw e;
        });
    sendPromises.push(rpcPromise);

    // Wait for the first successful send (the fastest path)
    let txid: string;
    try {
        // Manual implementation of Promise.any() compatible with ES2020
        txid = await new Promise((resolve, reject) => {
            let errors: any[] = [];
            let resolved = false;

            if (sendPromises.length === 0) {
                reject(new Error("No send methods configured (missing Helius API key and RPC failed initialization)."));
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
                        // If all methods fail, reject the promise
                        reject(new Error("All transaction send attempts failed."));
                    }
                });
            });
        });

    } catch (e) {
        throw e; // Re-throw the error caught from the Promise wrapper
    }

    // Step 7: Confirmation
    console.log(`[Confirm] Waiting for confirmation for TxID: ${txid}...`);
    // Use the blockhash fetched at the start.
    // Use 'confirmed' here as we need assurance the trade executed on-chain.
    const confResult = await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confResult.value.err) throw new Error(`Confirmation failed: ${JSON.stringify(confResult.value.err)}`);

    const endTime = Date.now();
    console.log(`✅ Swap successful! Total time: ${endTime - startTime}ms. Tx: https://solscan.io/tx/${txid}`);

    // Log successful trade with performance metrics
    await logTradeToFirestore({ txid, signal_id, action, symbol, timestamp: new Date(), durationMs: endTime - startTime, status: 'success' });
    console.log(`================== [SIGNAL ${signal_id} END] ======================`);

  } catch (error: any) {
    const endTime = Date.now();
    console.error(`🛑 [FATAL] Trade for Signal ID ${signal_id} failed in ${endTime - startTime}ms:`, error.message);
    // Log failed trade with error details and performance metrics
    await logTradeToFirestore({ txid: null, signal_id, action, symbol, error: error.message, timestamp: new Date(), durationMs: endTime - startTime, status: 'failed' });
    console.log(`================== [SIGNAL ${signal_id} END] ======================`);
  }
}