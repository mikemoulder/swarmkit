import { commitBid, createRound } from "../swarm/index.ts";
import type { RoundSpec } from "../swarm/index.ts";

export type Scenario = "gpu" | "api-credits" | "no-sale";

export async function runScenario(seed = 2026, scenario: Scenario = "gpu") {
  if (!Number.isSafeInteger(seed)) throw new Error("Seed must be a safe integer");
  const credits = scenario === "api-credits";
  const spec: RoundSpec = {
    id: `${scenario}-${seed}`,
    resource: {
      label: credits ? "Inference API credits" : "NVIDIA H100",
      unit: credits ? "credit pack" : "GPU hour",
      deliveryWindow: "Next available 24-hour block",
    },
    asset: "simulated-credits",
    buyers: Array.from({ length: credits ? 3 : 20 }, (_, i) => `buyer-${i + 1}.swarm.testnet`),
    sellers: Array.from({ length: credits ? 2 : 5 }, (_, i) => `seller-${i + 1}.swarm.testnet`),
    demandCloses: 10,
    commitCloses: 20,
    revealCloses: 30,
  };
  let now = 0;
  const round = createRound(spec, () => now);
  let state = seed >>> 0;
  for (const buyerId of spec.buyers) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const quantity = 1 + (state % 8);
    round.submitDemand(buyerId, { quantity: String(quantity), budget: String(quantity * 7) });
  }
  const demand = round.snapshot();
  const capacity = BigInt(demand.quantity);
  now = spec.demandCloses;
  const offers = spec.sellers.map((sellerId, index) => ({
    sellerId,
    bid: {
      capacity: String(index === 0 || scenario === "no-sale" ? capacity - 1n : capacity),
      unitPrice: String(2 * index + 2),
      salt: (BigInt(state) * 10n + BigInt(index)).toString(16).padStart(64, "0"),
    },
  }));
  for (const { sellerId, bid } of offers) {
    round.submitCommitment(sellerId, await commitBid(spec.id, sellerId, bid));
  }
  const committed = round.snapshot();
  now = spec.commitCloses;
  for (const { sellerId, bid } of offers) await round.revealBid(sellerId, bid);
  const revealed = round.snapshot();
  now = spec.revealCloses;
  const result = round.snapshot();
  return {
    mode: "simulation" as const,
    stages: [demand, committed, revealed, result],
    payments: result.allocation?.shares.map(({ buyerId, amount }) => ({
      buyerId, amount, status: "simulated" as const,
    })) ?? [],
  };
}
