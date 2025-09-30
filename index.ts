import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { executeTrade } from './tradeExecutor.js';
import {
  initializeFirebase,
  getBotSettings,
  getOpenPositionByToken,
  closePosition,
  logTradeToFirestore
} from './firebaseAdmin.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

initializeFirebase();

app.use(cors());
app.use(express.json());

const processedSignals = new Set<string>();

app.post('/nexagent-signal', async (req, res) => {
  console.log('[Signal Received]', req.body);
  
  const { dir, inputMint, outputMint, inputAmount, signalId } = req.body;

  if (!dir || !inputMint || !outputMint || inputAmount === undefined || !signalId) {
    console.error('[Validation Failed] Signal is missing required fields.');
    return res.status(400).json({ error: 'Invalid signal payload' });
  }

  if (processedSignals.has(signalId)) {
    console.log(`[Duplicate Signal] Skipping signalId: ${signalId}`);
    // Log the duplicate event to Firestore for your records
    await logTradeToFirestore({
        signalId: signalId,
        status: 'Ignored',
        reason: 'Duplicate signal received',
        date: new Date(),
    });
    return res.status(200).json({ message: 'Duplicate signal, ignored.' });
  }
  processedSignals.add(signalId);
  
  if (processedSignals.size > 1000) {
      const oldestSignal = processedSignals.values().next().value;
      if (oldestSignal) {
          processedSignals.delete(oldestSignal);
      }
  }

  res.status(200).json({ message: 'Signal received and accepted for processing.' });

  try {
    const settings = await getBotSettings();
    if (!settings || settings.botStatus !== 'RUNNING') {
      console.log(`[Bot Not Running] Status is '${settings?.botStatus || 'OFF'}'. Ignoring signal.`);
      return;
    }

    const tokenAddress = dir.toUpperCase() === 'BUY' ? outputMint : inputMint;
    const openPosition = await getOpenPositionByToken(tokenAddress);

    if (dir.toUpperCase() === 'BUY') {
      if (openPosition) {
        console.log(`[BUY IGNORED] An open position already exists for ${tokenAddress}.`);
        return;
      }
      await executeTrade(tokenAddress, 'BUY', inputAmount, { token_symbol: 'Unknown', price_at_signal: 0 });

    } else if (dir.toUpperCase() === 'SELL') {
      if (!openPosition) {
        console.log(`[SELL IGNORED] No open position found for ${tokenAddress}.`);
        return;
      }
      await executeTrade(tokenAddress, 'SELL', openPosition.tokenAmount, { price_at_signal: 0 });
      await closePosition(openPosition.id, 0, 'Signal Received');
    }

  } catch (error: unknown) {
    let errorMessage = "An unknown error occurred in the signal handler.";
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    console.error(`[FATAL] Error processing signal ${signalId}:`, errorMessage);
  }
});

app.listen(PORT, () => {
  console.log(`Bot server running on http://localhost:${PORT}`);
});