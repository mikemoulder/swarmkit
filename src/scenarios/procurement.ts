import { simulateProcurement } from "../swarm/index.ts";

export type Scenario = "gpu" | "api-credits" | "no-sale";

export function runScenario(seed = 2026, scenario: Scenario = "gpu") {
  const credits = scenario === "api-credits";
  return simulateProcurement({
    seed,
    spec: {
      id: `${scenario}-${seed}`,
      resource: {
        label: credits ? "Inference API credits" : "NVIDIA H100",
        unit: credits ? "credit pack" : "GPU hour",
        deliveryWindow: "Next available 24-hour block",
      },
      asset: "simulated-credits",
      demandCloses: 10,
      commitCloses: 20,
      revealCloses: 30,
    },
    buyers: Array.from({ length: credits ? 3 : 20 }, (_, index) => ({
      id: `buyer-${index + 1}.swarm.testnet`,
      demand: ({ random }) => {
        const quantity = 1 + Math.floor(random() * 2 ** 32) % 8;
        return { quantity: String(quantity), budget: String(quantity * 7) };
      },
    })),
    sellers: Array.from({ length: credits ? 2 : 5 }, (_, index) => ({
      id: `seller-${index + 1}.swarm.testnet`,
      offer: ({ pooledQuantity }) => {
        const capacity = BigInt(pooledQuantity) - (index === 0 || scenario === "no-sale" ? 1n : 0n);
        return capacity > 0n ? { capacity: String(capacity), unitPrice: String(2 * index + 2) } : null;
      },
    })),
  });
}
