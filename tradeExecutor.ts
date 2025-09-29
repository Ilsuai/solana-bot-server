import { 
    Connection, 
    Keypair, 
    VersionedTransaction,
    PublicKey, 
} from '@solana/web3.js';
import { 
    createJupiterApiClient, 
    QuoteResponse, 
    SwapRequest 
} from '@jup-ag/api';
import { getMint } from '@solana/spl-token'; 
import * as dotenv from 'dotenv';
import { logTradeToFirestore, managePosition } from './firebaseAdmin';
import bs58 from 'bs58';

dotenv.config();

const SOL_MINT = 'So11111111111111111111111111111111111111112'; 

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY is missing from the .env file.");
}
const walletKeypair = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
const walletPublicKey = walletKeypair.publicKey;

const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
if (!rpcUrl) {
    throw new Error("SOLANA_RPC_ENDPOINT is missing in the .env file.");
}

const connection = new Connection(rpcUrl, 'confirmed');

// Explicitly set the Jupiter API to the v6 Mainnet endpoint
const jupiterApi = createJupiterApiClient({
  basePath: "https://quote-api.jup.ag/v6"
});

// Aggressive priority fee strategy
async function getPriorityFee(): Promise<number> {
    const minFee = 25000; // A reliable minimum fee (0.000025 SOL)
    const maxFee = 1000000; // A sane maximum to avoid overpaying (0.001 SOL)

    try {
        const prioritizationFees = await connection.getRecentPrioritizationFees();
        if (prioritizationFees.length === 0) {
            console.log("[Fee] No recent priority fees found, using minimum.");
            return minFee;
        }

        const recentFees = prioritizationFees
            .map(fee => fee.prioritizationFee)
            .filter(fee => fee <= maxFee);

        if (recentFees.length === 0) {
            console.log("[Fee] No recent fees within a reasonable range, using minimum.");
            return minFee;
        }

        recentFees.sort((a, b) => a - b);
        
        const percentileIndex = Math.floor(recentFees.length * 0.95);
        const aggressiveFee = recentFees[percentileIndex];
        
        const boostedFee = aggressiveFee + 1;
        const finalFee = Math.max(boostedFee, minFee);

        console.log(`[Fee] Aggressive fee (95th percentile + 1): ${finalFee} microLamports`);
        return finalFee;

    } catch (error) {
        console.error("[Fee] Failed to get dynamic priority fee, using minimum.", error);
        return minFee;
    }
}

async function getTokenDecimals(mintAddress: string): Promise<number> {
    if (mintAddress === SOL_MINT) return 9;
    try {
        const mintPublicKey = new PublicKey(mintAddress);
        const mintInfo = await getMint(connection, mintPublicKey);
        return mintInfo.decimals;
    } catch (error) {
        throw new Error(`Could not determine decimals for token ${mintAddress}.`);
    }
}

async function handleTradeSignal(signal: { token_address: string, action: string, amount_input: number }): Promise<{ signature: string, quote: QuoteResponse }> {
    const { token_address, action, amount_input } = signal;
    const slippageBps = 350; // 3.5% Slippage
    const isBuy = action.toUpperCase() === 'BUY';
    
    const inputMint = isBuy ? SOL_MINT : token_address;
    const outputMint = isBuy ? token_address : SOL_MINT;
    
    const inputTokenDecimals = await getTokenDecimals(inputMint);
    const amountInSmallestUnits = Math.round(amount_input * Math.pow(10, inputTokenDecimals));
    
    if (amountInSmallestUnits <= 0) throw new Error(`Invalid amount: ${amount_input}`);

    console.log(`[Executor] Starting ${action} trade for ${amount_input} of ${inputMint}`);

    const dynamicPriorityFee = await getPriorityFee();

    const quote: QuoteResponse = await jupiterApi.quoteGet({
        inputMint,
        outputMint,
        amount: amountInSmallestUnits, 
        slippageBps,
        onlyDirectRoutes: false, 
    });

    if (!quote) throw new Error('Failed to get a valid quote from Jupiter.');

    const { swapTransaction, lastValidBlockHeight } = await jupiterApi.swapPost({
        swapRequest: {
            quoteResponse: quote,
            userPublicKey: walletKeypair.publicKey.toBase58(),
            wrapUnwrapSol: true, 
            computeUnitPriceMicroLamports: dynamicPriorityFee,
        } as SwapRequest
    });

    const transactionBuffer = Buffer.from(swapTransaction, 'base64');
    let transaction = VersionedTransaction.deserialize(transactionBuffer);
    
    transaction.sign([walletKeypair]);
    console.log('[Executor] Transaction signed. Sending...');

    const rawTransaction = transaction.serialize();
    const txSignature = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true, 
        maxRetries: 2,
    });

    await connection.confirmTransaction({
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: lastValidBlockHeight,
        signature: txSignature
    }, 'confirmed');

    console.log(`[Executor] ✅ Trade Confirmed! Signature: ${txSignature}`);
    
    return { signature: txSignature, quote };
}

export async function executeTrade(tokenAddress: string, action: string, amountInput: number, signalData: any): Promise<void> {
    try {
        const { signature, quote } = await handleTradeSignal({
            token_address: tokenAddress,
            action: action,
            amount_input: amountInput, 
        });

        await logTradeToFirestore({
            txid: signature, tokenAddress, solAmount: action === 'BUY' ? amountInput : null,
            action: action.toUpperCase(), date: new Date(), status: 'Success'
        });

        if (action.toUpperCase() === 'BUY') {
            const outputTokenDecimals = await getTokenDecimals(tokenAddress);
            const tokensReceived = parseInt(quote.outAmount) / Math.pow(10, outputTokenDecimals);
            
            await managePosition({
                txid: signature,
                tokenAddress: tokenAddress,
                tokenSymbol: signalData.token_symbol,
                solAmount: amountInput,
                tokenAmount: tokensReceived,
                entryPrice: signalData.price_at_signal,
                status: 'open',
                openedAt: new Date(),
                stopLossPrice: signalData.stop_loss_limit || 0, 
            });
        }
    } catch (error: unknown) {
        let errorMessage = "An unknown error occurred";
        if (error instanceof Error) errorMessage = error.message;
        
        if (typeof error === 'object' && error !== null && 'response' in error) {
            const response = (error as any).response;
            if (response && typeof response.json === 'function') {
                try {
                    const errorBody = await response.json();
                    errorMessage = `Jupiter API Error: ${errorBody.error || JSON.stringify(errorBody)}`;
                } catch (jsonError) {
                    errorMessage = `Jupiter API Error: Failed to parse response. Status: ${response.status || 'unknown'}`;
                }
            }
        }

        console.error(`\n[TRADE FAILED]`, errorMessage);
        await logTradeToFirestore({
            tokenAddress, solAmount: action === 'BUY' ? amountInput : null, 
            action: action.toUpperCase(),
            date: new Date(), status: 'Failed', error: errorMessage
        });
        throw error; 
    }
}