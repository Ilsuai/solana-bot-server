import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config'; // Make sure to load environment variables

// CORRECTED: The official, standard Program ID for the Memo Program
const MEMO_PROGRAM_ID = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');

async function runSpeedTest() {
  console.log('--- Starting Solana RPC Speed Test ---');

  if (!process.env.PRIVATE_KEY || !process.env.SOLANA_RPC_ENDPOINT) {
    throw new Error('Missing environment variables. Make sure PRIVATE_KEY and SOLANA_RPC_ENDPOINT are set.');
  }

  // 1. Setup Connection
  const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
  console.log(`Testing RPC Endpoint: ${rpcUrl.split('?')[0]}`);
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  console.log(`Using wallet: ${wallet.publicKey.toBase58()}`);

  // 2. Measure Blockhash Fetch Time
  console.time('Blockhash fetched in');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  console.timeEnd('Blockhash fetched in');

  // 3. Build a Simple "Memo" Transaction
  const memoInstruction = new TransactionInstruction({
    keys: [], // Memo program takes no accounts
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(`RPC Speed Test - ${new Date().toISOString()}`, 'utf-8'),
  });

  const memoTransaction = new Transaction().add(memoInstruction);
  memoTransaction.recentBlockhash = blockhash;
  memoTransaction.feePayer = wallet.publicKey;

  // 4. Measure Submission and Confirmation Time
  console.log('\nSending and confirming transaction...');
  console.time('Transaction confirmed in');
  try {
    // Step 4a: Send the transaction
    const signature = await connection.sendTransaction(memoTransaction, [wallet]);
    
    // Step 4b: Confirm the transaction
    await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
    }, 'confirmed');

    console.timeEnd('Transaction confirmed in');
    console.log(`✅ Success!`);
    console.log(`   Signature: ${signature}`);
  } catch (error: any) {
    console.timeEnd('Transaction confirmed in');
    console.error('❌ Transaction failed:', error.message);
  }

  console.log('--- Test Complete ---');
}

runSpeedTest().catch(err => {
  console.error('An unexpected error occurred:', err);
});