const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
import { Request, Response } from 'express'; // Keep this for types

const { executeTrade } = require('./tradeExecutor');
const {
  initializeFirebase,
  getBotSettings,
  getOpenPositionByToken,
  closePosition,
  logTradeToFirestore
} = require('./firebaseAdmin');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
initializeFirebase();
app.use(cors());
app.use(express.json());
const processedSignals = new Set<string>();

app.post('/nexagent-signal', async (req: Request, res: Response) => {
  const signalId = req.body.data?.signalId || req.body.signalId || 'unknown';
  console.log(`\n================== [${new Date().toISOString()}] SIGNAL [${signalId}] ==================`);
  console.log('➡️ [Signal Received]', req.body);

  const signalPayload = req.body.data || req.body;
  const { dir, inputMint, outputMint, inputAmount } = signalPayload;
  if (!dir || !inputMint || !outputMint || inputAmount === undefined || !signalId) {
    console.error('❌ [Validation Failed] Trade signal is missing required fields.');
    return res.status(400).json({ error: 'Invalid trade signal payload' });
  }
  
  // The rest of the logic remains the same...
  if (processedSignals.has(signalId)) {
    console.log(`🗑️ [Duplicate Signal] Skipping signalId: ${signalId}`);
    return res.status(200).json({ message: 'Duplicate signal, ignored.' });
  }
  processedSignals.add(signalId);
  if (processedSignals.size > 1000) {
    const oldestSignal = processedSignals.values().next().value;
    if (oldestSignal) processedSignals.delete(oldestSignal);
  }
  res.status(200).json({ message: 'Trade signal received and accepted for processing.' });

  try {
    const settings = await getBotSettings();
    if (!settings || settings.botStatus !== 'RUNNING') {
      console.log(`⏸️ [Bot Not Running] Status is '${settings?.botStatus || 'OFF'}'. Ignoring signal.`);
      return;
    }
    const tokenAddress = dir.toUpperCase() === 'BUY' ? outputMint : inputMint;
    const openPosition = await getOpenPositionByToken(tokenAddress);
    if (dir.toUpperCase() === 'BUY') {
      if (openPosition) {
        console.log(`⏸️ [BUY IGNORED] An open position already exists for ${tokenAddress}.`);
        return;
      }
      await executeTrade(tokenAddress, 'BUY', inputAmount, signalPayload);
    } else if (dir.toUpperCase() === 'SELL') {
      if (!openPosition) {
        console.log(`⏸️ [SELL IGNORED] No open position found for ${tokenAddress}.`);
        return;
      }
      await executeTrade(tokenAddress, 'SELL', openPosition.tokenAmount, signalPayload);
      await closePosition(openPosition.id, 0, 'Signal Received');
    }
  } catch (error: unknown) {
    let errorMessage = "An unknown error occurred.";
    if (error instanceof Error) errorMessage = error.message;
    console.error(`🛑 [FATAL] Error processing signal ${signalId}:`, errorMessage);
  }
});

app.listen(PORT, () => {
  console.log(`Bot server running on http://localhost:${PORT}`);
});