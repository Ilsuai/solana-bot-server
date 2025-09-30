import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';
import {
  createJupiterApiClient,
  QuoteResponse,
  SwapRequest,
} from '@jup-ag/api';
import { getMint } from '@solana/spl-token';
import { logTradeToFirestore, managePosition, getOpenPositionByToken } from './firebaseAdmin';
import bs58 from 'bs58';

// --- Configuration and Initialization ---
const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

// Ensure environment variables are loaded
if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in the environment variables.');
}
if (!process.env.SOLANA_RPC_ENDPOINT) {
  throw new Error('SOLANA_RPC_ENDPOINT is not set in the environment variables.');
}

const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'confirmed');
const jupiterApi = createJupiterApiClient(); // Initialize Jupiter API client

/**
 * Utility function to get the number of decimals for a given token mint.
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
 * Executes a trade (swap) on Jupiter.
 * @param inputMint The mint address of the token to sell.
 * @param outputMint The mint address of the token to buy.
 * @param amount The amount of the input token to sell, in its smallest unit (e.g., lamports).
 * @param slippageBps The slippage in basis points (e.g., 50 for 0.5%).
 * @returns The transaction signature.
 */
async function performSwap(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<{ txid: string; quote: QuoteResponse }> {
  console.log(`[Swap] Getting quote for ${amount} of ${inputMint} -> ${outputMint} with ${slippageBps} BPS slippage.`);

  // 1. Get a quote from Jupiter
  const quote = await jupiterApi.quoteGet({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    onlyDirectRoutes: false,
    asLegacyTransaction: false, // Use VersionedTransactions
  });

  if (!quote) {
    throw new Error('Failed to get a quote from Jupiter.');
  }

  // 2. Get the serialized transaction
  const swapResult = await jupiterApi.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: walletKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
  });

  // 3. Deserialize and sign the transaction
  const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
  let transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([walletKeypair]);

  // 4. Send the transaction
  const rawTransaction = transaction.serialize();
  const txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 5,
    preflightCommitment: 'confirmed',
  });

  // 5. Confirm the transaction
  const confirmation = await connection.confirmTransaction(
    txid,
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  
  console.log(`✅ Swap successful! Transaction: https://solscan.io/tx/${txid}`);
  return { txid, quote };
}

/**
 * Main function to handle a buy or sell signal. It includes retry logic with increasing slippage.
 * @param tokenAddress The address of the token to trade.
 * @param action 'BUY' or 'SELL'.
 * @param solAmount The amount of SOL to use for the trade.
 */
export async function executeTrade(
  tokenAddress: string,
  action: 'BUY' | 'SELL',
  solAmount: number
): Promise<void> {
    const isBuy = action === 'BUY';
    
    // For a BUY, SOL is the input. For a SELL, the token is the input.
    // However, since the primary logic is driven by a fixed SOL amount for buys,
    // we will handle that case specifically. Sells will need a different logic
    // to determine the input amount (e.g., sell 100% of the position).
    
    if (!isBuy) {
        console.log(`[Executor] SELL logic not fully implemented yet. Signal for ${tokenAddress} ignored.`);
        // Here you would fetch the open position to get the token balance to sell.
        // For now, we will focus on fixing the BUY side.
        return;
    }
    
    const inputMint = SOL_MINT_ADDRESS;
    const outputMint = tokenAddress;
    const solDecimals = 9;
    const amountInLamports = Math.round(solAmount * 10 ** solDecimals);

    const MAX_RETRIES = 3;
    const slippageSettings = [
        process.env.DEFAULT_SLIPPAGE_BPS ? parseInt(process.env.DEFAULT_SLIPPAGE_BPS) : 200, // 2%
        1000, // 10%
        2500, // 25%
    ];

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
            
            // On successful trade:
            const outputTokenDecimals = await getTokenDecimals(outputMint);
            const tokenAmountReceived = Number(quote.outAmount) / 10 ** outputTokenDecimals;
            
            const tradeData = {
                txid,
                status: 'Success',
                kind: action,
                solAmount: solAmount,
                tokenAmount: tokenAmountReceived,
                tokenAddress: tokenAddress,
                slippageBps: currentSlippage,
                date: new Date(),
            };
            
            await logTradeToFirestore(tradeData);
            
            await managePosition({
                txid,
                status: 'open',
                entryTx: txid,
                tokenAddress,
                solSpent: solAmount,
                tokenReceived: tokenAmountReceived,
                buyPrice: solAmount / tokenAmountReceived, // Price per token in SOL
                openedAt: new Date(),
            });

            console.log(`[Executor] Successfully logged trade and opened position for tx: ${txid}`);
            return; // Exit loop on success

        } catch (error) {
            console.error(`❌ [TRADE FAILED] Attempt ${i + 1} failed.`);
            if (error instanceof Error) {
                console.error(`   Error: ${error.message}`);
            } else {
                console.error(error);
            }

            if (i === MAX_RETRIES - 1) {
                console.error(`🛑 [FATAL] All ${MAX_RETRIES} attempts failed. Aborting trade.`);
                await logTradeToFirestore({
                    txid: null,
                    status: 'Failed',
                    kind: action,
                    solAmount: solAmount,
                    tokenAddress: tokenAddress,
                    reason: error instanceof Error ? error.message : 'Unknown error',
                    date: new Date(),
                });
                throw error; // Re-throw the final error
            }
        }
    }
}