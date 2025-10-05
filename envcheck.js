function mask(v){ if(!v) return v; const s=String(v); return s.length<=12 ? s : s.slice(0,6)+'…'+s.slice(-6); }
console.log('cwd:', process.cwd());
console.log('SOLANA_RPC_ENDPOINT set?', !!process.env.SOLANA_RPC_ENDPOINT, mask(process.env.SOLANA_RPC_ENDPOINT));
console.log('PRIVATE_KEY set?', !!process.env.PRIVATE_KEY, '(masked)');
console.log('NEXAGENT_SHARED_SECRET set?', !!process.env.NEXAGENT_SHARED_SECRET);
console.log('HELIUS_TIP_LAMPORTS:', process.env.HELIUS_TIP_LAMPORTS);
