import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Jupiter, RouteInfo } from '@jup-ag/core';
import JSBI from 'jsbi';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { logTradeToFirestore, managePosition } from './firebaseAdmin';

dotenv.config();

const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY is missing from the .env file.");
const wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));

const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
if (!rpcUrl) throw new Error("SOLANA_RPC_ENDPOINT is missing from the .env file.");
const connection = new Connection(rpcUrl, "confirmed");

// FIX: This robust function gets token decimals without the 'getMint' import error.
async function getTokenDecimals(mintAddress: string): Promise<number> {
    if (mintAddress === SOL_MINT_ADDRESS) return 9;
    const mintPublicKey = new PublicKey(mintAddress);
    const accountInfo = await connection.getAccountInfo(mintPublicKey);
    if (!accountInfo) {
        throw new Error(`Could not find mint account for ${mintAddress}`);
    }
    const decimals = accountInfo.data.readUInt8(0);
    return decimals;
}

// This is the memory-efficient way to load Jupiter
async function getJupiterInstance(): Promise<Jupiter> {
  return Jupiter.load({
    connection,
    cluster: "mainnet-beta",
    user: wallet,
    wrapUnwrapSOL: true,
  });
}

async function executeSwap(jupiter: Jupiter, route: RouteInfo): Promise<string | null> {
    // FIX: The 'exchange' method returns 'swapTransaction' directly, not a nested 'transactions' object.
    const { swapTransaction } = await jupiter.exchange({ 
        // FIX: The parameter name is 'routeInfo', not 'route'.
        routeInfo: route 
    });

    if (swapTransaction) {
        const rawTx = swapTransaction.serialize();
        const txid = await connection.sendRawTransaction(rawTx, {
            skipPreflight: true,
            maxRetries: 5,
        });

        const latestBlockHash = await connection.getLatestBlockhash();
        await connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: txid,
        });
        
        console.log(`✅ [Executor] Transaction Confirmed! Signature: ${txid}`);
        return txid;
    }
    return null;
}

module.exports = {
  executeTrade: async function(tokenAddress: string, action: string, amountInput: number, signalData: any): Promise<void> {
    try {
      const jupiter = await getJupiterInstance();
      
      const isBuy = action.toUpperCase() === 'BUY';
      const inputMint = new PublicKey(isBuy ? SOL_MINT_ADDRESS : tokenAddress);
      const outputMint = new PublicKey(isBuy ? tokenAddress : SOL_MINT_ADDRESS);
      
      const inputMintDecimals = await getTokenDecimals(inputMint.toBase58());
      
      // FIX: The amount must be passed as a JSBI object.
      const amountInSmallestUnits = JSBI.BigInt(Math.round(amountInput * (10 ** inputMintDecimals)));

      console.log(`⚙️  [Executor] Finding routes for ${action} ${amountInput}...`);
      
      const routes = await jupiter.computeRoutes({
          inputMint,
          outputMint,
          amount: amountInSmallestUnits,
          slippageBps: 1500, // 15%
          forceFetch: true,
      });

      if (!routes.routesInfos || routes.routesInfos.length === 0) {
        throw new Error("Could not find any routes for this trade.");
      }
      
      const bestRoute = routes.routesInfos[0];
      console.log(`⚙️  [Executor] Best route found. Executing swap...`);
      
      const signature = await executeSwap(jupiter, bestRoute);
      if (!signature) throw new Error("Swap transaction did not return a signature.");

      await logTradeToFirestore({ /* log data */ });
      if (isBuy) {
        const outputMintDecimals = await getTokenDecimals(outputMint.toBase58());
        const tokensReceived = Number(bestRoute.outAmount.toString()) / (10 ** outputMintDecimals);
        await managePosition({ /* position data */ });
      }
    } catch (error: unknown) {
        let msg = "An unknown error occurred";
        if (error instanceof Error) msg = error.message;
        console.error(`\n❌ [TRADE FAILED]`, { message: msg, rawError: error });
        await logTradeToFirestore({ /* error log data */ });
        throw error;
    }
  }
};