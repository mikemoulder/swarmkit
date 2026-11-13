import { cheapestCapacity, simulateProcurement, settlementPlanFromTranscript } from "near-swarmkit";

const { transcript, stages } = await simulateProcurement({
  seed: 42,
  spec: {
    id: "split-gpu-42",
    mechanismId: cheapestCapacity.id,
    resource: { label: "NVIDIA H100", unit: "GPU hour", deliveryWindow: "Today" },
    asset: "simulation-credits",
    demandCloses: 10,
    commitCloses: 20,
    revealCloses: 30,
  },
  buyers: [{ id: "research", demand: () => ({ quantity: "5", budget: "14" }) }],
  sellers: [
    { id: "alpha", offer: () => ({ capacity: "3", unitPrice: "2" }) },
    { id: "beta", offer: () => ({ capacity: "2", unitPrice: "4" }) },
  ],
});
console.log(JSON.stringify({
  mode: "simulation",
  allocation: stages[3].splitAllocation,
  plan: await settlementPlanFromTranscript(transcript),
}, null, 2));
