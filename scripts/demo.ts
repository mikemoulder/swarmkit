import { runScenario } from "../src/scenarios/procurement.ts";

const scenario = process.argv[2] ?? "gpu";
if (scenario !== "gpu" && scenario !== "api-credits" && scenario !== "no-sale") {
  throw new Error("Choose gpu, api-credits, or no-sale");
}
const transcript = await runScenario(2026, scenario);
const result = transcript.stages.at(-1)!;
console.log(`SwarmKit · ${result.spec.resource.label} · Simulation`);
console.log(`${result.buyers.length} buyers pooled ${result.quantity} ${result.spec.resource.unit}s. ${result.bids.length} seller bids.`);
console.table(result.bids.map(({ sellerId, reveal, rejection }) => ({
  sellerId, price: reveal?.unitPrice, capacity: reveal?.capacity,
  outcome: rejection ?? (sellerId === result.allocation?.sellerId ? "winner" : "eligible"),
})));
if (result.allocation) {
  console.log(`Clearing price: ${result.allocation.unitPrice} simulated credits per unit. Total: ${result.allocation.total}.`);
  console.table(transcript.payments);
} else {
  console.log("No eligible bid. No payments.");
}
