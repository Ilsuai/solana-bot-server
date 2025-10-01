import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';

const MEMO_PROGRAM_ID = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');
// Using a stable, official Jito tip address from the QuickNode documentation.
const JITO_TIP_ACCOUNT = new PublicKey("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucL4bge9fgo");

async function runSpeedTest() {
  console.log('--- Starting Solana RPC Speed Test ---');

  if (!process.env.PRIVATE_KEY || !process.env.SOLANA_RPC_ENDPOINT) {
    throw new Error('Missing environment variables.');
  }

  const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
  const isQuickNode = rpcUrl.includes('quiknode.pro');

  console.log(`Testing RPC Endpoint: ${rpcUrl.split('/')[2]}`);
  if (isQuickNode) {
    console.log("✅ QuickNode endpoint detected. Jito tip will be used.");
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  console.log(`Using wallet: ${wallet.publicKey.toBase58()}`);

  console.time('Blockhash fetched in');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  console.timeEnd('Blockhash fetched in');

  // Create a standard, simple transaction
  const testTransaction = new Transaction();

  // Add the memo instruction first
  testTransaction.add(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(`RPC Speed Test - ${new Date().toISOString()}`, 'utf-8'),
    })
  );

  // If using QuickNode, add the Jito tip instruction LAST
  if (isQuickNode) {
    testTransaction.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: JITO_TIP_ACCOUNT,
        lamports: 1_000_000, // 0.001 SOL
      })
    );
  }
  
  testTransaction.recentBlockhash = blockhash;
  testTransaction.feePayer = wallet.publicKey;

  console.log('\nSending and confirming transaction...');
  console.time('Transaction confirmed in');
  try {
    const signature = await connection.sendTransaction(testTransaction, [wallet]);
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
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