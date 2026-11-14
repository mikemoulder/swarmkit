import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSimulation, advanceSimulation, replayRound, simulateProcurement, explainAllocation, cheapestCapacity } from '../src/swarm/index.ts';

const options = { seed: 12,
  spec: { id: 'incremental', resource: { label: 'Storage', unit: 'block', deliveryWindow: 'Now' },
    asset: 'credits', mechanismId: cheapestCapacity.id, demandCloses: 10, commitCloses: 20, revealCloses: 30 },
  buyers: [{ id: 'buyer', demand: async () => ({ quantity: '5', budget: '20' }) }],
  sellers: [{ id: 'seller-a', offer: async () => ({ capacity: '3', unitPrice: '2' }) },
    { id: 'seller-b', offer: async () => ({ capacity: '3', unitPrice: '3' }) }],
};
test('incremental async strategies execute only in their stage and resume from serialized checkpoints', async () => {
  let calls = 0;
  const strategies = { ...options, buyers: [{ id: 'buyer', demand: async () => { calls++; return { quantity: '5', budget: '20' }; } }] };
  let session = startSimulation(strategies);
  assert.equal(calls, 0);
  assert.equal(session.transcript.events.length, 0);
  session = await advanceSimulation(session, strategies);
  assert.equal(calls, 1);
  session = await advanceSimulation(JSON.parse(JSON.stringify(session)), strategies);
  const committed = await replayRound(session.transcript);
  assert.ok(committed.bids.every(b => !b.reveal));
  assert.equal(session.sealedOffers.length, 2);
  session = await advanceSimulation(JSON.parse(JSON.stringify(session)), strategies);
  assert.equal(session.sealedOffers.length, 0);
  session = await advanceSimulation(session, strategies);
  assert.equal(calls, 1);
  assert.deepEqual(await replayRound(session.transcript), (await simulateProcurement(options)).stages[3]);
  const explanation = explainAllocation(await replayRound(session.transcript));
  assert.equal(explanation.buyers[0].spent, '12');
  assert.equal(explanation.buyers[0].remainingBudget, '8');
  assert.equal(explanation.sellers.length, 2);
  assert.deepEqual(await advanceSimulation(session, strategies), session);
  await assert.rejects(advanceSimulation(session, { ...strategies, buyers: [] }), /participants/);
});

test('failed async decision leaves original checkpoint unchanged and can be retried', async () => {
  const initial = startSimulation(options);
  const before = JSON.stringify(initial);
  await assert.rejects(advanceSimulation(initial, { ...options, buyers: [{ id: 'buyer', demand: async () => { throw new Error('unavailable'); } }] }), /unavailable/);
  assert.equal(JSON.stringify(initial), before);
  assert.equal((await advanceSimulation(initial, options)).stage, 'demand');
});
