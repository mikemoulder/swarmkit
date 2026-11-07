import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runScenario } from "../src/scenarios/procurement.ts";
import { commitBid, createRound } from "../src/swarm/index.ts";

test("GPU round is deterministic and pays exact shares within buyer caps", async () => {
  const transcript = await runScenario();
  assert.deepEqual(transcript, await runScenario());
  const [demand, committed, revealed, result] = transcript.stages;
  assert.equal(demand.buyers.length, 20);
  assert.equal(committed.bids.length, 5);
  assert.ok(committed.bids.every((bid) => bid.reveal === null));
  assert.ok(revealed.bids.every((bid) => bid.reveal !== null));
  assert.equal(revealed.allocation, null);
  assert.equal(result.bids[0].rejection, "insufficient-capacity");
  assert.equal(result.bids[3].rejection, "buyer-budget");
  assert.equal(result.allocation?.sellerId, "seller-2.swarm.testnet");
  assert.equal(result.allocation?.unitPrice, "4");
  assert.equal(transcript.payments.length, 20);
  for (const buyer of result.buyers) {
    const payment = transcript.payments.find(({ buyerId }) => buyerId === buyer.buyerId);
    assert.ok(payment);
    assert.equal(BigInt(payment.amount), BigInt(buyer.quantity) * 4n);
    assert.ok(BigInt(payment.amount) <= BigInt(buyer.budget));
  }
  assert.equal(transcript.payments.reduce((sum, p) => sum + BigInt(p.amount), 0n).toString(), result.allocation.total);
});

test("same engine clears API credits and creates no payments for an unfilled round", async () => {
  const credits = await runScenario(2026, "api-credits");
  const unfilled = await runScenario(2026, "no-sale");
  assert.equal(credits.payments.length, 3);
  assert.equal(credits.stages.at(-1)?.spec.resource.label, "Inference API credits");
  assert.equal(unfilled.stages.at(-1)?.allocation, null);
  assert.deepEqual(unfilled.payments, []);
});

test("commit is immutable, mismatched reveal can be corrected, and ties use account ID", async () => {
  let time = 0;
  const round = createRound({
    id: "test", resource: { label: "GPU", unit: "hour", deliveryWindow: "today" },
    asset: "credits", buyers: ["buyer"], sellers: ["seller-b", "seller-a"],
    demandCloses: 10, commitCloses: 20, revealCloses: 30,
  }, () => time);
  const bid = { capacity: "3", unitPrice: "4", salt: "a".repeat(64) };
  assert.ok(round.submitDemand("buyer", { quantity: "3", budget: "12" }));
  time = 10;
  assert.equal(round.submitDemand("buyer", null), false);
  for (const seller of ["seller-b", "seller-a"]) {
    assert.ok(round.submitCommitment(seller, await commitBid("test", seller, bid)));
    assert.equal(round.submitCommitment(seller, "b".repeat(64)), false);
  }
  time = 20;
  assert.equal(await round.revealBid("seller-a", { ...bid, unitPrice: "5" }), false);
  assert.ok(await round.revealBid("seller-a", bid));
  assert.ok(await round.revealBid("seller-b", bid));
  time = 30;
  assert.equal(await round.revealBid("seller-a", bid), false);
  assert.equal(round.snapshot().allocation?.sellerId, "seller-a");
});
