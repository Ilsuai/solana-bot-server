import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Message,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';

const MEMO_PROGRAM_ID = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');
// IMPORTANT: Make sure this is a real Jito tip address from your QuickNode dashboard.
const JITO_TIP_ACCOUNT = new PublicKey("Cw8CFyM9FkoMi7K7crf6HNQqf4uEMzpKw6QNghXLvLkY");

async function runSpeedTest() {
  console.log('--- Starting Solana RPC Speed Test ---');

  if (!process.env.PRIVATE_KEY || !process.env.SOLANA_RPC_ENDPOINT) {
    throw new Error('Missing environment variables.');
  }

  const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
  console.log(`Testing RPC Endpoint: ${rpcUrl.split('/')[2]}`);
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  console.log(`Using wallet: ${wallet.publicKey.toBase58()}`);

  console.time('Blockhash fetched in');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  console.timeEnd('Blockhash fetched in');

  const instructions = [
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(`RPC Speed Test - ${new Date().toISOString()}`, 'utf-8'),
    }),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: JITO_TIP_ACCOUNT,
      lamports: 1_000_000,
    })
  ];
  
  // CORRECTED: Use Message.compile({ ... }) to build the message
  const message = Message.compile({
    payerKey: wallet.publicKey,
    instructions,
    recentBlockhash: blockhash,
  });
  const versionedTransaction = new VersionedTransaction(message);

  versionedTransaction.sign([wallet]);
  const rawTransaction = versionedTransaction.serialize();

  console.log('\nSending and confirming versioned transaction with Jito tip...');
  console.time('Transaction confirmed in');
  try {
    const signature = await connection.sendRawTransaction(rawTransaction, { skipPreflight: true });
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