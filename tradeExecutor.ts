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

const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

if (!process.env.PRIVATE_KEY || !process.env.SOLANA_RPC_ENDPOINT) {
  throw new Error('Missing environment variables: PRIVATE_KEY and SOLANA_RPC_ENDPOINT are required.');
}

const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'confirmed');
const jupiterApi = createJupiterApiClient();

async function getTokenDecimals(mintAddress: string): Promise<number> {
  if (mintAddress === SOL_MINT_ADDRESS) return 9;
  try {
    const mintPublicKey = new PublicKey(mintAddress);
    const mintInfo = await getMint(connection, mintPublicKey);
    return mintInfo.decimals;
  } catch (error) {
    throw new Error(`Could not fetch decimals for token ${mintAddress}.`);
  }
}

async function performSwap(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<{ txid: string; quote: QuoteResponse }> {
  console.log(`[Swap] Getting quote from Jupiter with priority fees...`);

  const priorityFee = process.env.PRIORITY_FEE_MICRO_LAMPORTS
    ? parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS, 10)
    : 50000; // Default priority fee

  const quote = await jupiterApi.quoteGet({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    // @ts-ignore - This bypasses the local editor's false error
    computeUnitPriceMicroLamports: priorityFee,
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
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([walletKeypair]);

  const rawTransaction = transaction.serialize();
  const txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 5,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const confirmation = await connection.confirmTransaction(
    { signature: txid, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  
  console.log(`✅ Swap successful! Transaction: https://solscan.io/tx/${txid}`);
  return { txid, quote };
}

export async function executeTrade(
  tokenAddress: string,
  action: 'BUY' | 'SELL',
  solAmount: number
): Promise<void> {
    if (action !== 'BUY') {
        console.log(`[Executor] SELL logic not implemented. Ignoring signal.`);
        return;
    }
    
    const amountInLamports = Math.round(solAmount * 10 ** 9);
    const slippageSettings = [500, 1500, 2500];

    for (let i = 0; i < slippageSettings.length; i++) {
        const currentSlippage = slippageSettings[i];
        try {
            console.log(`\n--- [ATTEMPT ${i + 1}/${slippageSettings.length}] ---`);
            console.log(`Executing ${action} for ${solAmount} SOL on token ${tokenAddress} with ${currentSlippage / 100}% slippage.`);

            const { txid, quote } = await performSwap(
                SOL_MINT_ADDRESS,
                tokenAddress,
                amountInLamports,
                currentSlippage
            );
            
            const outputTokenDecimals = await getTokenDecimals(tokenAddress);
            const tokenAmountReceived = Number(quote.outAmount) / 10 ** outputTokenDecimals;
            
            await logTradeToFirestore({
                txid, status: 'Success', kind: action, solAmount,
                tokenAmount: tokenAmountReceived, tokenAddress,
                slippageBps: currentSlippage, date: new Date(),
            });
            
            await managePosition({
                txid, status: 'open', tokenAddress, solSpent: solAmount, 
                tokenReceived: tokenAmountReceived, openedAt: new Date(),
            });

            console.log(`Successfully logged trade and position for tx: ${txid}`);
            return;

        } catch (error: any) {
            console.error(`❌ [TRADE FAILED] Attempt ${i + 1} failed:`, error.message);
            if (error.response && typeof error.response.json === 'function') {
                try {
                    const errorBody = await error.response.json();
                    console.error('   Jupiter API Error Body:', JSON.stringify(errorBody));
                } catch (jsonError) {
                    console.error('   Could not parse Jupiter API error response as JSON.');
                }
            }

            if (i === slippageSettings.length - 1) {
                console.error(`🛑 [FATAL] All attempts failed. Aborting trade.`);
                await logTradeToFirestore({
                    txid: null, status: 'Failed', kind: action, solAmount, tokenAddress,
                    reason: error.message || 'Unknown error', date: new Date(),
                });
                throw error;
            }
        }
    }
}