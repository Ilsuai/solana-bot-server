// src/tokenDecimals.ts
import { Connection, PublicKey, Commitment } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
// @ts-ignore
import fetch from 'node-fetch';

export function attachDecimalsResolver(connection: Connection) {
  const BACKUP_RPC = process.env.SOLANA_RPC_ENDPOINT_BACKUP || '';
  const backupConnection = BACKUP_RPC ? new Connection(BACKUP_RPC, 'confirmed' as Commitment) : null;
  const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://lite-api.jup.ag';

  const decimalCache = new Map<string, number>();

  const PREKNOWN_DECIMALS: Record<string, number> = {
    'So11111111111111111111111111111111111111112': 9,  // wSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,  // USDC canonical
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,  // USDT
  };

  async function tryGetMintDecimals(conn: Connection, mint: PublicKey, commitment: Commitment = 'confirmed'): Promise<number | null> {
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const info = await getMint(conn, mint, commitment, programId);
        const d = (info as any)?.decimals;
        if (typeof d === 'number') {
          console.log(`[Decimals] On-chain getMint (${commitment}) via ${programId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Token'}: ${d}`);
          return d;
        }
      } catch (e: any) {
        console.warn(`[Decimals] getMint failed on ${programId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Token'} (${commitment}): ${e?.message || e}`);
      }
    }
    return null;
  }

  async function tryGetSupplyDecimals(conn: Connection, mint: PublicKey): Promise<number | null> {
    try {
      // @ts-ignore
      const res = await conn.getTokenSupply(mint, { commitment: 'confirmed' as Commitment });
      const d = (res as any)?.value?.decimals;
      if (typeof d === 'number') {
        console.log(`[Decimals] On-chain getTokenSupply: ${d}`);
        return d;
      }
      console.warn('[Decimals] getTokenSupply returned without decimals.');
      return null;
    } catch (e: any) {
      console.warn(`[Decimals] getTokenSupply failed: ${e?.message || e}`);
      return null;
    }
  }

  async function tryHeliusDASDecimals(mintAddress: string): Promise<number | null> {
    try {
      const res = await fetch(process.env.SOLANA_RPC_ENDPOINT as string, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'getAsset', method: 'getAsset', params: { id: mintAddress } }),
      });
      if (!res.ok) {
        console.warn(`[Decimals] Helius DAS HTTP ${res.status}`);
        return null;
      }
      const json = await res.json() as any;
      const d = json?.result?.token_info?.decimals;
      if (typeof d === 'number') {
        console.log(`[Decimals] Helius DAS getAsset: ${d}`);
        return d;
      }
      console.warn('[Decimals] Helius DAS returned no token_info.decimals.');
      return null;
    } catch (e: any) {
      console.warn(`[Decimals] Helius DAS getAsset failed: ${e?.message || e}`);
      return null;
    }
  }

  async function tryJupiterV2Decimals(mintAddress: string): Promise<number | null> {
    try {
      const url = `${JUPITER_API_BASE}/tokens/v2/search?query=${encodeURIComponent(mintAddress)}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[Decimals] Jupiter v2 HTTP ${res.status}`);
        return null;
      }
      const arr = await res.json() as any;
      const top = Array.isArray(arr) ? arr.find((t: any) => t?.address === mintAddress) || arr[0] : null;
      const d = top?.decimals;
      if (typeof d === 'number') {
        console.log(`[Decimals] Jupiter v2: ${d}`);
        return d;
      }
      console.warn('[Decimals] Jupiter v2 returned no decimals.');
      return null;
    } catch (e: any) {
      console.warn(`[Decimals] Jupiter v2 failed: ${e?.message || e}`);
      return null;
    }
  }

  return async function getTokenDecimals(mintAddress: string): Promise<number> {
    if (decimalCache.has(mintAddress)) return decimalCache.get(mintAddress)!;
    if (PREKNOWN_DECIMALS[mintAddress] != null) {
      const d = PREKNOWN_DECIMALS[mintAddress];
      decimalCache.set(mintAddress, d);
      console.log(`[Decimals] Preknown ${d} for ${mintAddress.slice(0,4)}…`);
      return d;
    }
    if (mintAddress === 'So11111111111111111111111111111111111111112') {
      decimalCache.set(mintAddress, 9);
      return 9;
    }

    const pk = new PublicKey(mintAddress);

    // 1) On-chain via primary RPC
    {
      const d = await tryGetMintDecimals(connection, pk, 'confirmed');
      if (d != null) { decimalCache.set(mintAddress, d); return d; }
    }

    // 2) On-chain via backup RPC
    if (backupConnection) {
      const d = (await tryGetMintDecimals(backupConnection, pk, 'finalized')) ??
                (await tryGetSupplyDecimals(backupConnection, pk));
      if (d != null) { decimalCache.set(mintAddress, d); return d; }
    }

    // 3) Helius DAS
    {
      const d = await tryHeliusDASDecimals(mintAddress);
      if (d != null) { decimalCache.set(mintAddress, d); return d; }
    }

    // 4) Jupiter v2
    {
      const d = await tryJupiterV2Decimals(mintAddress);
      if (d != null) { decimalCache.set(mintAddress, d); return d; }
    }

    // 5) On-chain supply via primary
    {
      const d = await tryGetSupplyDecimals(connection, pk);
      if (d != null) { decimalCache.set(mintAddress, d); return d; }
    }

    throw new Error(`Could not fetch decimals for token ${mintAddress} after all fallbacks.`);
  };
}
