import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openStoredRound, replayRound, resumeRound, settlementPlanFromTranscript, simulateProcurement, submitStoredRoundEvent,
} from "swarmkit";

const capacityFirst = {
  id: "dataset-capacity-first-v1",
  selectWinner(offers) {
    return offers.reduce((best, offer) =>
      BigInt(offer.capacity) > BigInt(best.capacity) ? offer : best).sellerId;
  },
};

const { stages, plan, settlement, transcript } = await simulateProcurement({
  seed: 42,
  mechanism: capacityFirst,
  spec: {
    id: "dataset-seats-42",
    mechanismId: capacityFirst.id,
    resource: { label: "Dataset subscription", unit: "seat", deliveryWindow: "Today" },
    asset: "simulation-credits",
    demandCloses: 10,
    commitCloses: 20,
    revealCloses: 30,
  },
  buyers: [
    { id: "analytics", demand: () => ({ quantity: "3", budget: "18" }) },
    { id: "research", demand: () => ({ quantity: "2", budget: "10" }) },
  ],
  sellers: [
    { id: "small-vendor", offer: () => ({ capacity: "4", unitPrice: "3" }) },
    { id: "exact-vendor", offer: ({ pooledQuantity }) => ({ capacity: pooledQuantity, unitPrice: "4" }) },
    { id: "full-vendor", offer: () => ({ capacity: "8", unitPrice: "5" }) },
  ],
  paymentOutcome: ({ buyerId }) => buyerId === "research" ? "pending" : "confirmed",
});

const directory = mkdtempSync(join(tmpdir(), "swarmkit-dataset-"));
const path = join(directory, "round.sqlite");
let db = new DatabaseSync(path);
try {
  db.exec("CREATE TABLE rounds (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, transcript TEXT NOT NULL)");
  const store = {
    async read(id) {
      const row = db.prepare("SELECT transcript FROM rounds WHERE id = ?").get(id);
      return row && JSON.parse(row.transcript);
    },
    async compareAndSet(next, expected) {
      const json = JSON.stringify(next);
      if (expected === null) {
        return db.prepare("INSERT OR IGNORE INTO rounds VALUES (?, 0, ?)").run(next.spec.id, json).changes === 1;
      }
      return db.prepare("UPDATE rounds SET revision = ?, transcript = ? WHERE id = ? AND revision = ?")
        .run(next.events.length, json, next.spec.id, expected).changes === 1;
    },
  };
  const { spec, events } = transcript;
  await openStoredRound(spec, store, () => 0, capacityFirst);
  for (const [index, { at, ...command }] of events.entries()) {
    if (index === 2) {
      db.close();
      db = new DatabaseSync(path);
    }
    const submitted = await submitStoredRoundEvent(spec.id, command, store, () => at, capacityFirst);
    assert.equal(submitted.status, "accepted");
  }
  const restored = await store.read(spec.id);
  const resumed = await resumeRound(restored, () => transcript.observedAt, capacityFirst);
  const closed = resumed.transcript();
  await assert.rejects(replayRound(closed), /matching procurement mechanism/);
  await assert.rejects(replayRound(closed, { ...capacityFirst, selectWinner: () => "small-vendor" }),
    /ineligible seller/);
  const replayed = await replayRound(closed, capacityFirst);
  assert.equal(replayed.allocation.sellerId, "full-vendor");
  assert.deepEqual(replayed, stages[3]);
  assert.deepEqual(await settlementPlanFromTranscript(closed, capacityFirst), plan);
  console.log(JSON.stringify({ mode: "simulation", allocation: replayed.allocation, plan, settlement }, null, 2));
} finally {
  db.close();
  unlinkSync(path);
  rmdirSync(directory);
}
