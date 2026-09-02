import { RecoveryClaimStore } from '../../dist/session-orchestrator/index.js';

const store = new RecoveryClaimStore(process.argv[2]);
const lease = await store.acquire('session:g07-cross-process', `claim:child:${process.pid}`);
if (!lease) throw new Error('Child process could not acquire the recovery claim.');
process.send?.({ type: 'acquired', pid: process.pid });
await new Promise((resolve) => process.on('message', (message) => { if (message?.type === 'release') resolve(); }));
await lease.release();
