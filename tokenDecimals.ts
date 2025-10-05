// tokenDecimals.ts
// Robust token-decimals resolver with caching and multiple fallbacks.
// Order: WSOL -> on-chain getMint (SPL / Token-2022) -> Jupiter Token API.

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
// @ts-ignore
import fetch from 'node-fetch';

const WSOL = 'So11111111111111111111111111111111111111112';

type CacheEntry = { d: number; at: number };
const DECIMALS_CACHE: Map<string, CacheEntry> = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function memoSet(mint: string, d: number) {
  DECIMALS_CACHE.set(mint, { d, at: Date.now() });
  return d;
}

function memoGet(mint: string): number | undefined {
  const hit = DECIMALS_CACHE.get(mint);
  if (!hit) return;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    DECIMALS_CACHE.delete(mint);
    return;
  }
  return hit.d;
}

export function attachDecimalsResolver(connection: Connection) {
  return async function getTokenDecimals(mintAddress: string): Promise<number> {
    const cached = memoGet(mintAddress);
    if (typeof cached === 'number') {
      console.log(`[Decimals] Cache hit ${cached} for ${mintAddress.slice(0, 4)}…`);
      return cached;
    }

    if (mintAddress === WSOL) {
      console.log('[Decimals] WSOL detected -> 9');
      return memoSet(mintAddress, 9);
    }

    // Try on-chain via SPL and Token-2022
    const pk = new PublicKey(mintAddress);
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const mint = await getMint(connection, pk, 'confirmed', programId);
        if (typeof mint.decimals === 'number') {
          console.log(`[Decimals] On-chain getMint (confirmed) via ${programId.equals(TOKEN_PROGRAM_ID) ? 'Token' : 'Token-2022'}: ${mint.decimals}`);
          return memoSet(mintAddress, mint.decimals);
        }
      } catch (_) {
        // ignore
      }
    }

    // Jupiter Token API fallback
    try {
      const url = `https://token.jup.ag/v2/mint?mints=${mintAddress}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Jupiter token API ${res.status}`);
      const json = await res.json();
      const d = json?.[0]?.decimals;
      if (typeof d === 'number') {
        console.log(`[Decimals] Jupiter API fallback: ${d}`);
        return memoSet(mintAddress, d);
      }
    } catch (e: any) {
      console.warn(`[Decimals] Jupiter fallback failed: ${e?.message || e}`);
    }

    throw new Error(`Could not fetch decimals for token ${mintAddress} after all fallbacks.`);
  };
}
