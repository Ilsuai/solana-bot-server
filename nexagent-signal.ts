// server/nexagent-signal.ts
import express from "express";
import admin from "firebase-admin";
import * as TradeExec from "./tradeExecutor";

const router = express.Router();

type ExecResult = { txSignature: string };

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USE_EXECUTOR = true; // set false to dry-run without placing on-chain tx

// Adapter so we work with either executeSwap() or buyToken/sellToken in your tradeExecutor.ts
async function execSwapAdapter(
  fromMint: string,
  toMint: string,
  amount: number
): Promise<ExecResult> {
  const anyExec = TradeExec as any;

  if (typeof anyExec.executeSwap === "function") {
    return anyExec.executeSwap({ fromMint, toMint, amount });
  }
  if (fromMint === SOL_MINT && typeof anyExec.buyToken === "function") {
    return anyExec.buyToken({ mint: toMint, amountSol: amount });
  }
  if (toMint === SOL_MINT && typeof anyExec.sellToken === "function") {
    return anyExec.sellToken({ mint: fromMint, amountTokens: amount });
  }
  throw new Error(
    "No compatible executor found. Export executeSwap({fromMint,toMint,amount}) or buyToken/sellToken."
  );
}

const L = {
  info: (s: string, m: string, meta?: any) => console.log(`🟦 [${s}] ${m}`, meta ?? ""),
  warn: (s: string, m: string, meta?: any) => console.warn(`🟨 [${s}] ${m}`, meta ?? ""),
  error: (s: string, m: string, meta?: any) => console.error(`🟥 [${s}] ${m}`, meta ?? ""),
};
const db = () => admin.firestore();

/**
 * POST /nexagent-signal
 * Accepts Nexgent "agentTransactions" payloads and mirrors them.
 * Decides direction purely from input/output mints:
 * - BUY open:  input_mint=SOL  && output_mint!=SOL
 * - SELL close: output_mint=SOL && input_mint!=SOL   (or routes.isClosingTransaction===true)
 */
router.post("/nexagent-signal", async (req, res) => {
  const scope = "nexagent-signal";

  try {
    // Some providers send text/plain
    let body: any = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch {
        L.warn(scope, "Ignored non-JSON body", { sample: body.slice?.(0, 200) });
        return res.status(200).json({ ok: true, note: "ignored_non_json" });
      }
    }

    const d = body?.data;
    if (!d) {
      L.warn(scope, "Ignored: missing data object");
      return res.status(200).json({ ok: true, note: "ignored_no_data" });
    }

    // Respect dashboard Stop: only act when RUNNING
    const settings = await db().collection("settings").doc("bot-settings").get();
    const botStatus = settings.exists ? settings.data()?.botStatus : "OFF";
    if (botStatus !== "RUNNING") {
      L.warn(scope, "Ignored (botStatus not RUNNING)", { botStatus });
      return res.status(200).json({ ok: true, note: "ignored_stopped" });
    }

    // Normalize fields exactly from your sample
    const event = body?.event || "agentTransactions";
    const timestamp = body?.timestamp ? new Date(body.timestamp) : new Date();
    const agentId = d.agent_id || body?.agentId || null;
    const signalId = d.signal_id ?? null;
    const idKey = signalId != null ? String(signalId) : `sig-${Date.now()}`;

    const txType = String(d.transaction_type || "").toLowerCase(); // "swap"
    const inputMint = d.input_mint as string;
    const inputSymbol = String(d.input_symbol || "").trim();
    const inputAmount = Number(d.input_amount ?? 0); // human units
    const inputPriceUsd = Number(d.input_price ?? 0);

    const outputMint = d.output_mint as string;
    const outputSymbol = String(d.output_symbol || "").trim();
    const outputAmount = Number(d.output_amount ?? 0);
    const outputPriceUsd = Number(d.output_price ?? 0);

    const isClosingFlag = Boolean(d?.routes?.isClosingTransaction);
    const isBuyOpen =
      txType === "swap" && inputMint === SOL_MINT && outputMint && outputMint !== SOL_MINT;
    const isSellClose =
      isClosingFlag ||
      (txType === "swap" && outputMint === SOL_MINT && inputMint && inputMint !== SOL_MINT);

    // Log a compact summary of what we received
    L.info(scope, "RX",
      {
        event, ts: timestamp.toISOString(), agentId,
        dir: isBuyOpen ? "BUY" : isSellClose ? "SELL" : "UNKNOWN",
        inputMint, inputAmount, outputMint, outputAmount, signalId
      }
    );

    if (!isBuyOpen && !isSellClose) {
      L.warn(scope, "Ignored: unknown direction", { txType, inputMint, outputMint, isClosingFlag });
      return res.status(200).json({ ok: true, note: "ignored_unknown_direction" });
    }

    // Idempotency: don't process the same signal twice
    const dedupRef = db().collection("ingest_dedup").doc(idKey);
    const dedupSnap = await dedupRef.get();
    if (dedupSnap.exists) {
      L.warn(scope, "Duplicate signal; skipping", { signalId: idKey });
      return res.status(200).json({ ok: true, dedup: true });
    }

    // Keep a raw copy for audit
    await db().collection("nexgent_webhook_raw").doc(idKey).set(
      { receivedAt: admin.firestore.FieldValue.serverTimestamp(), event, payload: body },
      { merge: true }
    );

    // ========== BUY (SOL -> TOKEN) ==========
    if (isBuyOpen) {
      const tokenAddress = outputMint;
      const tokenSym = outputSymbol || tokenAddress;

      let execSig: string | null = null;
      if (USE_EXECUTOR) {
        try {
          L.info(scope, "EXECUTE BUY", {
            fromMint: inputMint, toMint: outputMint, amountSOL: inputAmount, signalId: idKey
          });
          const { txSignature } = await execSwapAdapter(inputMint, tokenAddress, inputAmount);
          execSig = txSignature;
          L.info(scope, "BUY executed", { txSignature: execSig });
        } catch (err: any) {
          L.error(scope, "BUY execution failed", err?.message || err);
          // continue to mirror intent below
        }
      }

      // Open/Upsert position keyed by signal id
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
        signalId: idKey, token: tokenSym, solSpent: inputAmount,
        tokenReceived: outputAmount, executed: Boolean(execSig)
      });
    }

    // ========== SELL (TOKEN -> SOL) ==========
    if (isSellClose) {
      const tokenAddress = inputMint;
      const tokenSym = inputSymbol || tokenAddress;

      let execSig: string | null = null;
      if (USE_EXECUTOR) {
        try {
          L.info(scope, "EXECUTE SELL", {
            fromMint: tokenAddress, toMint: outputMint, amountTokens: inputAmount, signalId: idKey
          });
          const { txSignature } = await execSwapAdapter(tokenAddress, outputMint, inputAmount);
          execSig = txSignature;
          L.info(scope, "SELL executed", { txSignature: execSig });
        } catch (err: any) {
          L.error(scope, "SELL execution failed", err?.message || err);
        }
      }

      // Close the matching open position (prefer same signal key)
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
        signalId: idKey, token: tokenSym, tokenSold: inputAmount,
        solReceived: outputAmount, executed: Boolean(execSig)
      });
    }

    // Mark processed (idempotency)
    await db().collection("ingest_dedup").doc(idKey).set(
      { createdAt: admin.firestore.FieldValue.serverTimestamp(), type: "nexgent_agent_tx" },
      { merge: true }
    );

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    L.error("nexagent-signal", "Handler failed", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;
