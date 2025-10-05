// global.d.ts
// Render may skip devDependencies (@types/*). This shim avoids TS7016 for 'cors'.
declare module 'cors';
