// server/nexagent-signal.ts
import express from "express";
import admin from "firebase-admin";
import * as TradeExec from "./tradeExecutor";

const router = express.Router();

type ExecResult = { txSignature: string };

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USE_EXECUTOR = true;

async function execSwapAdapter(
  fromMint: string,
  toMint: string,
  amount: number,
  slippageBps?: number
): Promise<ExecResult> {
  const anyExec = TradeExec as any;
  if (typeof anyExec.executeSwap === "function") {
    return anyExec.executeSwap({ fromMint, toMint, amount, slippageBps });
  }
  if (fromMint === SOL_MINT && typeof anyExec.buyToken === "function") {
    return anyExec.buyToken({ mint: toMint, amountSol: amount });
  }
  if (toMint === SOL_MINT && typeof anyExec.sellToken === "function") {
    return anyExec.sellToken({ mint: fromMint, amountTokens: amount });
  }
  throw new Error(
    "No compatible executor found. Export executeSwap({fromMint,toMint,amount,slippageBps}) or buyToken/sellToken."
  );
}

const L = {
  info: (s: string, m: string, meta?: any) => console.log(`🟦 [${s}] ${m}`, meta ?? ""),
  warn: (s: string, m: string, meta?: any) => console.warn(`🟨 [${s}] ${m}`, meta ?? ""),
  error: (s: string, m: string, meta?: any) => console.error(`🟥 [${s}] ${m}`, meta ?? ""),
};
const db = () => admin.firestore();

function clampSlippage(bpsFromSignal?: any): number {
  const def = Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 50); // 0.50%
  const raw = Number(bpsFromSignal ?? def);
  // sane bounds: 0.10% .. 30%
  return Math.max(10, Math.min(raw, 3000));
}

/**
 * POST /nexagent-signal
 */
router.post("/nexagent-signal", async (req, res) => {
  const scope = "nexagent-signal";
  try {
    let body: any = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {
        L.warn(scope, "Ignored non-JSON body");
        return res.status(200).json({ ok: true, note: "ignored_non_json" });
      }
    }
    const d = body?.data;
    if (!d) {
      L.warn(scope, "Ignored: missing data object");
      return res.status(200).json({ ok: true, note: "ignored_no_data" });
    }

    // Only act if bot is RUNNING
    const setSnap = await db().collection("settings").doc("bot-settings").get();
    const botStatus = setSnap.exists ? setSnap.data()?.botStatus : "OFF";
    if (botStatus !== "RUNNING") {
      L.warn(scope, "Ignored (botStatus not RUNNING)", { botStatus });
      return res.status(200).json({ ok: true, note: "ignored_stopped" });
    }

    // Normalize
    const event = body?.event || "agentTransactions";
    const timestamp = body?.timestamp ? new Date(body.timestamp) : new Date();
    const agentId = d.agent_id || body?.agentId || null;
    const signalId = d.signal_id ?? null;
    const idKey = signalId != null ? String(signalId) : `sig-${Date.now()}`;

    const txType = String(d.transaction_type || "").toLowerCase();
    const inputMint = d.input_mint as string;
    const inputSymbol = String(d.input_symbol || "").trim();
    const inputAmount = Number(d.input_amount ?? 0);
    const inputPriceUsd = Number(d.input_price ?? 0);

    const outputMint = d.output_mint as string;
    const outputSymbol = String(d.output_symbol || "").trim();
    const outputAmount = Number(d.output_amount ?? 0);
    const outputPriceUsd = Number(d.output_price ?? 0);

    const slippageBps = clampSlippage(d?.routes?.slippageBps);
    const isClosingFlag = Boolean(d?.routes?.isClosingTransaction);

    const isBuyOpen =
      txType === "swap" && inputMint === SOL_MINT && outputMint && outputMint !== SOL_MINT;
    const isSellClose =
      isClosingFlag ||
      (txType === "swap" && outputMint === SOL_MINT && inputMint && inputMint !== SOL_MINT);

    L.info(scope, "RX", {
      event,
      ts: timestamp.toISOString(),
      agentId,
      dir: isBuyOpen ? "BUY" : isSellClose ? "SELL" : "UNKNOWN",
      inputMint,
      inputAmount,
      outputMint,
      outputAmount,
      signalId,
    });

    if (!isBuyOpen && !isSellClose) {
      L.warn(scope, "Ignored: unknown direction", { txType, inputMint, outputMint, isClosingFlag });
      return res.status(200).json({ ok: true, note: "ignored_unknown_direction" });
    }

    // 🔒 Atomic idempotency: claim this signalId; duplicates will fail with ALREADY_EXISTS and be ignored.
    const claimRef = db().collection("ingest_dedup").doc(idKey);
    try {
      await claimRef.create({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "processing",
        type: "nexgent_agent_tx",
      });
    } catch (e: any) {
      // code 6 = ALREADY_EXISTS
      if (e?.code === 6 || /ALREADY_EXISTS/i.test(String(e?.message))) {
        L.warn(scope, "Duplicate signal; skipping", { signalId: idKey });
        return res.status(200).json({ ok: true, dedup: true });
      }
      throw e;
    }

    // Keep raw for audit
    await db().collection("nexgent_webhook_raw").doc(idKey).set(
      { receivedAt: admin.firestore.FieldValue.serverTimestamp(), event, payload: body },
      { merge: true }
    );

    let execSig: string | null = null;

    try {
      if (isBuyOpen) {
        const tokenAddress = outputMint;
        const tokenSym = outputSymbol || tokenAddress;

        if (USE_EXECUTOR) {
          L.info(scope, "EXECUTE BUY", {
            fromMint: inputMint,
            toMint: outputMint,
            amountSOL: inputAmount,
            signalId: idKey,
            slippageBps,
          });
          const { txSignature } = await execSwapAdapter(inputMint, tokenAddress, inputAmount, slippageBps);
          execSig = txSignature;
          L.info(scope, "BUY executed", { txSignature: execSig });
        }

        await db().collection("positions").doc(idKey).set(
          {
            status: "open",
            source: "nexgent",
            agentId,
            txid: execSig || idKey,
            tokenAddress,
            tokenSymbol: tokenSym,
            solSpent: inputAmount,
            tokenReceived: outputAmount,
            solPriceUsd: inputPriceUsd,
            tokenPriceUsd: outputPriceUsd,
            openedAt: timestamp,
          },
          { merge: true }
        );

        await db().collection("trades").add({
          kind: "BUY",
          source: "nexgent",
          agentId,
          txid: execSig || idKey,
          tokenAddress,
          tokenSymbol: tokenSym,
          solAmount: inputAmount,
          tokenAmount: outputAmount,
          solPriceUsd: inputPriceUsd,
          tokenPriceUsd: outputPriceUsd,
          date: timestamp,
          status: execSig ? "Success" : USE_EXECUTOR ? "Failed" : "Recorded",
          signalId,
        });

        L.info(scope, "BUY mirrored", {
          signalId: idKey,
          token: tokenSym,
          solSpent: inputAmount,
          tokenReceived: outputAmount,
          executed: Boolean(execSig),
        });
      } else if (isSellClose) {
        const tokenAddress = inputMint;
        const tokenSym = inputSymbol || tokenAddress;

        if (USE_EXECUTOR) {
          L.info(scope, "EXECUTE SELL", {
            fromMint: tokenAddress,
            toMint: outputMint,
            amountTokens: inputAmount,
            signalId: idKey,
            slippageBps,
          });
          const { txSignature } = await execSwapAdapter(tokenAddress, outputMint, inputAmount, slippageBps);
          execSig = txSignature;
          L.info(scope, "SELL executed", { txSignature: execSig });
        }

        // Close the position
        let refToClose: FirebaseFirestore.DocumentReference | null = null;
        const byKey = await db().collection("positions").doc(idKey).get();
        if (byKey.exists) {
          refToClose = byKey.ref;
        } else {
          const latestOpen = await db()
            .collection("positions")
            .where("tokenAddress", "==", tokenAddress)
            .where("status", "==", "open")
            .orderBy("openedAt", "desc")
            .limit(1)
            .get();
          if (!latestOpen.empty) refToClose = latestOpen.docs[0].ref;
        }

        if (refToClose) {
          await refToClose.update({
            status: "closed",
            closedAt: timestamp,
            deactivationReason: "AgentTransaction",
            tokenSold: inputAmount,
            solReceived: outputAmount,
            tokenPriceUsdAtClose: inputPriceUsd,
            solPriceUsdAtClose: outputPriceUsd,
            txid: execSig || idKey,
          });
        } else {
          L.warn(scope, "No open position found to close; recording trade only", { tokenAddress });
        }

        await db().collection("trades").add({
          kind: "SELL",
          source: "nexgent",
          agentId,
          txid: execSig || idKey,
          tokenAddress,
          tokenSymbol: tokenSym,
          tokenAmount: inputAmount,
          solAmount: outputAmount,
          tokenPriceUsd: inputPriceUsd,
          solPriceUsd: outputPriceUsd,
          date: timestamp,
          status: execSig ? "Success" : USE_EXECUTOR ? "Failed" : "Recorded",
          signalId,
        });

        L.info(scope, "SELL mirrored", {
          signalId: idKey,
          token: tokenSym,
          tokenSold: inputAmount,
          solReceived: outputAmount,
          executed: Boolean(execSig),
        });
      }

      await claimRef.set(
        {
          status: execSig ? "succeeded" : "failed_or_recorded",
          finishedAt: admin.firestore.FieldValue.serverTimestamp(),
          txSignature: execSig || null,
        },
        { merge: true }
      );

      return res.status(200).json({ ok: true, tx: execSig || null });
    } catch (execErr: any) {
      await claimRef.set(
        {
          status: "failed",
          finishedAt: admin.firestore.FieldValue.serverTimestamp(),
          error: String(execErr?.message || execErr),
        },
        { merge: true }
      );
      throw execErr;
    }
  } catch (e: any) {
    L.error("nexagent-signal", "Handler failed", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;
