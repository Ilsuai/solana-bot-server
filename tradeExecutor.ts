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
import { logTradeToFirestore, managePosition } from './firebaseAdmin';
import bs58 from 'bs58';

// --- Configuration and Initialization ---
const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set in the environment variables.');
}
if (!process.env.SOLANA_RPC_ENDPOINT) {
  throw new Error('SOLANA_RPC_ENDPOINT is not set in the environment variables.');
}

const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'confirmed');
const jupiterApi = createJupiterApiClient();

async function getTokenDecimals(mintAddress: string): Promise<number> {
  if (mintAddress === SOL_MINT_ADDRESS) {
    return 9;
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

async function performSwap(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<{ txid: string; quote: QuoteResponse }> {
  console.log(`[Swap] Getting quote for ${amount} of ${inputMint} -> ${outputMint} with ${slippageBps} BPS slippage.`);

  const quote = await jupiterApi.quoteGet({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    onlyDirectRoutes: false,
    asLegacyTransaction: false,
  });

  if (!quote) {
    throw new Error('Failed to get a quote from Jupiter.');
  }

  const swapResult = await jupiterApi.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: walletKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
  });

  const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
  let transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([walletKeypair]);

  const rawTransaction = transaction.serialize();
  const txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 5,
    preflightCommitment: 'confirmed',
  });

  const confirmation = await connection.confirmTransaction(txid, 'confirmed');

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  
  console.log(`✅ Swap successful! Transaction: https://solscan.io/tx/${txid}`);
  return { txid, quote };
}

export async function executeTrade(
  tokenAddress: string,
  action: 'BUY' | 'SELL',
  solAmount: number
): Promise<void> {
    const isBuy = action === 'BUY';
    
    if (!isBuy) {
        console.log(`[Executor] SELL logic not fully implemented yet. Signal for ${tokenAddress} ignored.`);
        return;
    }
    
    const inputMint = SOL_MINT_ADDRESS;
    const outputMint = tokenAddress;
    const solDecimals = 9;
    const amountInLamports = Math.round(solAmount * 10 ** solDecimals);

    const MAX_RETRIES = 3;
    const slippageSettings = [
        process.env.DEFAULT_SLIPPAGE_BPS ? parseInt(process.env.DEFAULT_SLIPPAGE_BPS, 10) : 200,
        1000,
        2500,
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
                buyPrice: solAmount / tokenAmountReceived,
                openedAt: new Date(),
            });

            console.log(`[Executor] Successfully logged trade and opened position for tx: ${txid}`);
            return;

        } catch (error: any) { // Changed to 'any' to access error.response
            console.error(`❌ [TRADE FAILED] Attempt ${i + 1} failed.`);
            if (error instanceof Error) {
                console.error(`   Error Message: ${error.message}`);
            }
            
            // --- THIS IS THE NEW DEBUGGING CODE ---
            if (error.response && typeof error.response.json === 'function') {
                try {
                    const errorBody = await error.response.json();
                    console.error('   Jupiter API Error Body:', JSON.stringify(errorBody));
                } catch (jsonError) {
                    console.error('   Could not parse Jupiter API error response as JSON.');
                }
            }
            // --- END NEW DEBUGGING CODE ---

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
                throw error;
            }
        }
    }
}