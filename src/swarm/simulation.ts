import { commitBid, createRound } from "./round.ts";
import type { Bid, Demand, RoundSpec } from "./types.ts";
import { createSettlementPlan, summarizeSettlement } from "./settlement.ts";
import type { Payment, PaymentReceipt } from "./settlement.ts";
import type { ProcurementMechanism } from "./mechanism.ts";

type StrategyContext = {
  resource: Readonly<RoundSpec["resource"]>;
  asset: string;
  random: () => number;
};
export type BuyerStrategy = {
  id: string;
  demand: (context: StrategyContext) => Demand | null | Promise<Demand | null>;
};
export type SellerStrategy = {
  id: string;
  offer: (context: StrategyContext & { pooledQuantity: string }) => Omit<Bid, "salt"> | null | Promise<Omit<Bid, "salt"> | null>;
  reveal?: boolean;
};
export type SimulationOptions = {
  spec: Omit<RoundSpec, "buyers" | "sellers">;
  seed: number;
  mechanism?: ProcurementMechanism;
  buyers: readonly BuyerStrategy[];
  sellers: readonly SellerStrategy[];
  paymentOutcome?: (payment: Readonly<Payment>) => PaymentReceipt["status"];
};

export async function simulateProcurement(options: SimulationOptions) {
  if (!Number.isSafeInteger(options.seed)) throw new Error("Seed must be a safe integer");
  const spec = structuredClone({
    ...options.spec,
    buyers: options.buyers.map(({ id }) => id),
    sellers: options.sellers.map(({ id }) => id),
  });
  let now = spec.demandCloses - 1;
  const round = createRound(spec, () => now, options.mechanism);
  let state = options.seed >>> 0;
  function randomWord() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  }
  function context(): StrategyContext {
    return { resource: { ...spec.resource }, asset: spec.asset, random: () => randomWord() / 2 ** 32 };
  }

  for (const buyer of options.buyers) {
    if (!round.submitDemand(buyer.id, await buyer.demand(context()))) {
      throw new Error(`Invalid demand from ${buyer.id}`);
    }
  }
  const demand = round.snapshot();
  const offers = new Map<string, Bid>();
  now = spec.demandCloses;
  if (demand.quantity !== "0") {
    for (const seller of options.sellers) {
      const offer = await seller.offer({ ...context(), pooledQuantity: demand.quantity });
      if (!offer) continue;
      const salt = Array.from({ length: 8 }, () => randomWord().toString(16).padStart(8, "0")).join("");
      const bid = { ...offer, salt };
      round.submitCommitment(seller.id, await commitBid(spec.id, seller.id, bid));
      if (seller.reveal !== false) offers.set(seller.id, bid);
    }
  }
  const committed = round.snapshot();
  now = spec.commitCloses;
  for (const [sellerId, bid] of offers) await round.revealBid(sellerId, bid);
  const revealed = round.snapshot();
  now = spec.revealCloses;
  const result = round.snapshot();
  const plan = createSettlementPlan(result);
  const receipts = plan.payments.map((payment): PaymentReceipt => ({
    paymentId: payment.id,
    status: options.paymentOutcome?.({ ...payment }) ?? "confirmed",
  }));
  return {
    mode: "simulation" as const,
    transcript: round.transcript(),
    stages: [demand, committed, revealed, result] as const,
    plan,
    settlement: summarizeSettlement(plan, receipts),
    payments: plan.payments.map(({ buyerId, amount }, index) => ({
      buyerId, amount, status: receipts[index].status === "confirmed" ? "simulated" as const : receipts[index].status,
    })),
  };
}
