import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';
import {
  createJupiterApiClient,
  QuoteResponse,
} from '@jup-ag/api';
import { getMint } from '@solana/spl-token';
import { logTradeToFirestore, managePosition } from './firebaseAdmin';
import bs58 from 'bs58';

// --- Configuration and Initialization ---
const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

// Ensure required environment variables are set
if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in the environment variables.');
}
if (!process.env.SOLANA_RPC_ENDPOINT) {
  throw new Error('SOLANA_RPC_ENDPOINT is not set in the environment variables.');
}

const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'confirmed');
// Initialize the modern Jupiter API client
const jupiterApi = createJupiterApiClient();

/**
 * Fetches the number of decimals for a given token mint.
 * @param mintAddress The token's mint address.
 * @returns The number of decimals.
 */
async function getTokenDecimals(mintAddress: string): Promise<number> {
  if (mintAddress === SOL_MINT_ADDRESS) {
    return 9; // SOL always has 9 decimals
  }
  try {
    const mintPublicKey = new PublicKey(mintAddress);
    const mintInfo = await getMint(connection, mintPublicKey);
    return mintInfo.decimals;
  } catch (error) {
    console.error(`Failed to fetch decimals for mint: ${mintAddress}`, error);
    throw new Error(`Could not determine decimals for token ${mintAddress}.`);
  }
}

/**
 * Performs the swap on Jupiter, including getting the quote, building the transaction,
 * signing it, and sending it to the network.
 * @returns The transaction signature and the quote used.
 */
async function performSwap(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<{ txid: string; quote: QuoteResponse }> {
  console.log(`[Swap] Getting quote for ${amount} of ${inputMint} -> ${outputMint} with ${slippageBps} BPS slippage.`);

  // Get quote with priority fee using the modern 'priorityFeeLevel' property
  const quote = await jupiterApi.quoteGet({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    onlyDirectRoutes: false,
    asLegacyTransaction: false, // Important: Use modern VersionedTransactions
  });

  if (!quote) {
    throw new Error('Failed to get a quote from Jupiter.');
  }

  // Get the serialized transaction from Jupiter's swap endpoint
  const swapResult = await jupiterApi.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: walletKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true, // Automatically handle SOL wrapping/unwrapping
    },
  });

  // Deserialize the transaction
  const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
  let transaction = VersionedTransaction.deserialize(swapTransactionBuf);

  // Sign the transaction with your wallet's keypair
  transaction.sign([walletKeypair]);

  // Execute the transaction
  const rawTransaction = transaction.serialize();
  
  // Use the modern confirmation strategy for better reliability
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 5,
  });

  const confirmation = await connection.confirmTransaction({
        signature: txid,
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight
    }, 'confirmed');

  if (confirmation.value.err) {
    throw new Error(`Transaction confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  
  console.log(`✅ Swap successful! Transaction: https://solscan.io/tx/${txid}`);
  return { txid, quote };
}

/**
 * The main trade execution function called by the webhook.
 * Handles BUY/SELL logic and retries with increasing slippage.
 */
export async function executeTrade(
  tokenAddress: string,
  action: 'BUY' | 'SELL',
  solAmount: number
): Promise<void> {
    const isBuy = action === 'BUY';
    
    // For now, we are only focusing on the BUY logic.
    if (!isBuy) {
        console.log(`[Executor] SELL logic not yet implemented. Signal for ${tokenAddress} ignored.`);
        return;
    }
    
    const inputMint = SOL_MINT_ADDRESS;
    const outputMint = tokenAddress;
    const solDecimals = 9;
    // Convert SOL amount to lamports (the smallest unit) for the API
    const amountInLamports = Math.round(solAmount * 10 ** solDecimals);

    const MAX_RETRIES = 3;
    // Slippage settings for each retry attempt
    const slippageSettings = [500, 1500, 2500]; // 5%, 15%, 25%

    for (let i = 0; i < MAX_RETRIES; i++) {
        const currentSlippage = slippageSettings[i];
        try {
            console.log(`\n--- [ATTEMPT ${i + 1}/${MAX_RETRIES}] ---`);
            console.log(`[Executor] Executing ${action} for ${solAmount} SOL on token ${tokenAddress}`);
            console.log(`[Executor] Slippage: ${currentSlippage / 100}%`);

            const { txid, quote } = await performSwap(
                inputMint,
                outputMint,
                amountInLamports,
                currentSlippage
            );
            
            // On success, calculate token amount received and log everything
            const outputTokenDecimals = await getTokenDecimals(outputMint);
            const tokenAmountReceived = Number(quote.outAmount) / 10 ** outputTokenDecimals;
            
            await logTradeToFirestore({
                txid, status: 'Success', kind: action, solAmount,
                tokenAmount: tokenAmountReceived, tokenAddress,
                slippageBps: currentSlippage, date: new Date(),
            });
            
            await managePosition({
                txid, status: 'open', entryTx: txid, tokenAddress,
                solSpent: solAmount, tokenReceived: tokenAmountReceived,
                buyPrice: solAmount / tokenAmountReceived, openedAt: new Date(),
            });

            console.log(`[Executor] Successfully logged trade and opened position for tx: ${txid}`);
            return; // Exit the loop on success

        } catch (error: any) {
            console.error(`❌ [TRADE FAILED] Attempt ${i + 1} failed.`);
            if (error instanceof Error) {
                console.error(`   Error Message: ${error.message}`);
            }

            if (i === MAX_RETRIES - 1) {
                console.error(`🛑 [FATAL] All ${MAX_RETRIES} attempts failed. Aborting trade.`);
                await logTradeToFirestore({
                    txid: null, status: 'Failed', kind: action, solAmount, tokenAddress,
                    reason: error instanceof Error ? error.message : 'Unknown error', date: new Date(),
                });
                throw error; // Re-throw the final error to be caught by the webhook handler
            }
        }
    }
}