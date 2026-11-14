# near-swarmkit

The SDK includes incremental, asynchronous simulation through `startSimulation` and `advanceSimulation`, and decision inspection through `explainAllocation`. Run `node node_modules/near-swarmkit/examples/incremental-market.mjs` for a complete example. Private checkpoints contain unrevealed offers; publish only transcripts or replayed snapshots.

The packaged `examples/sqlite-round-store.mjs` and `examples/agent-service.mjs` are integration recipes for durable round storage and authenticated external participants. The service derives actor identities from credentials rather than request bodies. Node 22.18's built-in SQLite API is experimental. These examples do not provide production identity management or custody.

SwarmKit is an ESM TypeScript SDK for coordinating agent procurement on NEAR. It runs sealed-bid rounds, allocates demand under buyer budgets and seller capacity, and turns a closed round into a replayable payment plan.

Use Node 22.18 or newer. Install the release tarball with `npm install /path/to/near-swarmkit-0.1.0.tgz`.

```js
import { simulateProcurement } from "near-swarmkit";

const { plan } = await simulateProcurement({
  seed: 42,
  spec: {
    id: "inference-credits-01",
    resource: { label: "Inference credits", unit: "credit", deliveryWindow: "Today" },
    asset: "demo-credits",
    demandCloses: 10,
    commitCloses: 20,
    revealCloses: 30,
  },
  buyers: [
    { id: "research", demand: () => ({ quantity: "3", budget: "15" }) },
    { id: "indexer", demand: () => ({ quantity: "2", budget: "10" }) },
  ],
  sellers: [
    { id: "fastlane", offer: () => ({ capacity: "4", unitPrice: "3" }) },
    { id: "northstar", offer: () => ({ capacity: "5", unitPrice: "4" }) },
  ],
});

console.log(plan.payments.map(({ buyerId, amount }) => [buyerId, amount]));
// [["research", "12"], ["indexer", "8"]]
```

`node node_modules/near-swarmkit/examples/dataset-market.mjs` runs a custom mechanism and SQLite round recovery. `node node_modules/near-swarmkit/examples/split-market.mjs` shows one order filled by two sellers.

Amounts and quantities are integer strings. Use `createRound` for application-supplied commands, `settlementPlanFromTranscript` to reproduce charges, and `executeWithSpendingPolicies` for an application-managed signer and durable journal. The simulation uses synthetic receipts.

Choose [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE).

[Documentation](https://swarmkit.pages.dev/docs/) · [Agent guide](https://swarmkit.pages.dev/agents/) · [Source](https://github.com/mikemoulder/swarmkit)
