import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentService } from '../examples/agent-service.mjs';
import { sqliteRoundStore } from '../examples/sqlite-round-store.mjs';
import { openStoredRound } from '../src/swarm/index.ts';

test('external participant identity comes from credentials, survives restart, and cannot impersonate a seller', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'swarmkit-agent-')), 'rounds.sqlite');
  let store = sqliteRoundStore(path);
  await openStoredRound({ id: 'api-round', resource: { label: 'Data', unit: 'seat', deliveryWindow: 'Today' }, asset: 'simulation:credits', buyers: ['buyer'], sellers: ['seller'], demandCloses: 10, commitCloses: 20, revealCloses: 30 }, store, () => 1);
  store.close(); store = sqliteRoundStore(path);
  const server = createAgentService({ store, credentials: [{ token: 'buyer-token', id: 'buyer', role: 'buyer' }], clock: () => 2 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const send = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/command`, { method: 'POST', headers: { Authorization: 'Bearer buyer-token' }, body: JSON.stringify(body) });
  try {
    const denied = await send({ roundId: 'api-round', type: 'commitment', sellerId: 'seller', hash: 'a'.repeat(64) });
    assert.equal(denied.status, 403);
    const accepted = await send({ roundId: 'api-round', type: 'demand', buyerId: 'someone-else', request: { quantity: '2', budget: '10' } });
    assert.equal(accepted.status, 200);
    assert.equal((await store.read('api-round')).events[0].buyerId, 'buyer');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
