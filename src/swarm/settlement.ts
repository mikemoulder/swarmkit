import type { RoundSnapshot } from "./round.ts";

export type Payment = {
  id: string;
  buyerId: string;
  sellerId: string;
  amount: string;
};
export type SettlementPlan = {
  version: 1 | 2;
  roundId: string;
  asset: string;
  payments: readonly Payment[];
};
export function paymentIdFor(version: SettlementPlan["version"], roundId: string, buyerId: string, sellerId: string) {
  return JSON.stringify(version === 2 ? [roundId, buyerId, sellerId] : [roundId, buyerId]);
}
export type PaymentReceipt = {
  paymentId: string;
  status: "pending" | "confirmed" | "failed";
};

export function createSettlementPlan(round: RoundSnapshot): SettlementPlan {
  if (round.phase !== "closed") throw new Error("Settlement requires a closed round");
  const allocation = round.allocation;
  if (round.splitAllocation !== undefined) {
    return {
      version: 2,
      roundId: round.spec.id,
      asset: round.spec.asset,
      payments: round.splitAllocation?.lines.map(({ buyerId, sellerId, amount }) => ({
        id: paymentIdFor(2, round.spec.id, buyerId, sellerId), buyerId, sellerId, amount,
      })) ?? [],
    };
  }
  return {
    version: 1,
    roundId: round.spec.id,
    asset: round.spec.asset,
    payments: allocation?.shares.map(({ buyerId, amount }) => ({
      id: JSON.stringify([round.spec.id, buyerId]),
      buyerId,
      sellerId: allocation.sellerId,
      amount,
    })) ?? [],
  };
}

export function summarizeSettlement(plan: SettlementPlan, receipts: readonly PaymentReceipt[]) {
  const paymentIds = new Set(plan.payments.map(({ id }) => id));
  if (paymentIds.size !== plan.payments.length) throw new Error("Duplicate payment ID");
  const statuses = new Map<string, PaymentReceipt["status"]>();
  for (const { paymentId, status } of receipts) {
    if (!paymentIds.has(paymentId) || statuses.has(paymentId)) throw new Error("Unexpected payment receipt");
    if (status !== "pending" && status !== "confirmed" && status !== "failed") {
      throw new Error("Invalid receipt status");
    }
    statuses.set(paymentId, status);
  }
  const amounts = { pending: 0n, confirmed: 0n, failed: 0n };
  for (const payment of plan.payments) {
    if (!/^[1-9][0-9]*$/.test(payment.amount)) throw new Error("Invalid payment amount");
    amounts[statuses.get(payment.id) ?? "pending"] += BigInt(payment.amount);
  }
  return {
    pending: amounts.pending.toString(),
    confirmed: amounts.confirmed.toString(),
    failed: amounts.failed.toString(),
    paid: plan.payments.length > 0 && amounts.pending === 0n && amounts.failed === 0n,
  };
}
