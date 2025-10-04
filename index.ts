import 'dotenv/config';
import express, { Request, Response } from 'express';
import { executeTradeFromSignal, TradeSignal } from './tradeExecutor';
import { initializeFirebase } from './firebaseAdmin';
import fetch from 'node-fetch';

// --- Bot Startup Log ---
console.log("==================================================");
console.log("  Solana Trading Bot - Starting Up");
console.log("==================================================");

const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
if (rpcUrl) {
    try {
        const url = new URL(rpcUrl);
        console.log(`✅ CONNECTED TO RPC ENDPOINT: ${url.hostname}`);
    } catch (error) {
        console.error("❌ Invalid SOLANA_RPC_ENDPOINT URL format.");
    }
} else {
    console.log("❌ SOLANA_RPC_ENDPOINT environment variable not set!");
}
console.log("--------------------------------------------------");
// --- End of Startup Log ---

initializeFirebase();

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

// THIS IS THE LINE TO CHANGE
app.post('/YOUR_NEW_WEBHOOK_URL_HERE', async (req: Request, res: Response) => {
    const signalId = req.body.data?.signal_id;
    console.log(`\n================== [SIGNAL ${signalId || 'Unknown'} RECEIVED] ==================`);
    console.log(`Full Payload:`, JSON.stringify(req.body, null, 2));

    try {
        const payloadData = req.body.data;
        const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

        if (!payloadData || payloadData.transaction_type !== 'swap') {
            return res.status(400).send('Invalid or unrecognized signal payload.');
        }

        let action: 'BUY' | 'SELL' | null = null;
        if (payloadData.input_mint === SOL_MINT_ADDRESS) {
            action = 'BUY';
        } else if (payloadData.output_mint === SOL_MINT_ADDRESS) {
            action = 'SELL';
        }

        if (!action) {
            return res.status(400).send('Could not determine BUY/SELL action from signal.');
        }

        const tradeSignal: TradeSignal = {
            action: action,
            signal_id: payloadData.signal_id,
            input_mint: payloadData.input_mint,
            output_mint: payloadData.output_mint,
            input_amount: payloadData.input_amount,
            symbol: action === 'BUY' ? payloadData.output_symbol : payloadData.input_symbol,
        };

        executeTradeFromSignal(tradeSignal).catch(error => {
            console.error(`CRITICAL ASYNC ERROR for Signal ${tradeSignal.signal_id}:`, (error as Error).message);
        });

        res.status(200).send('Webhook received and trade initiated.');

    } catch (error) {
        console.error(`A critical error occurred in the webhook handler for Signal ${signalId || 'Unknown'}:`, error);
        res.status(500).send('Internal server error.');
    }
});

app.get('/', (req, res) => {
  res.send('Solana Trading Bot Server is running!');
});

app.listen(port, () => {
    console.log(`✅ Server is running and listening on port ${port}`);

    // Use the global HTTPS endpoint for the warmup ping
    const senderPingUrl = `https://sender.helius-rpc.com/ping`;
    const warmConnection = async () => {
        try {
            // @ts-ignore
            const response = await fetch(senderPingUrl);
            if (response.ok) {
                console.log(`[Warmup] Ping successful to global sender. Connection is warm.`);
            } else {
                console.warn(`[Warmup] Ping failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('[Warmup] Ping failed with error:', (error as Error).message);
        }
    };

    warmConnection();
    setInterval(warmConnection, 50000);
});