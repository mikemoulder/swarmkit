import { paymentIdFor, summarizeSettlement } from "./settlement.ts";
import type { Payment, PaymentReceipt, SettlementPlan } from "./settlement.ts";

export type SignedPayment = { hash: string; bytes: string };
export type SettlementEntry = {
  payment: Payment;
  signed: SignedPayment;
};
export type SettlementJournal = {
  // Atomically return the stored entry, inserting the candidate only if absent.
  reserve(scope: string, candidate: SettlementEntry): Promise<SettlementEntry>;
  read(scope: string): Promise<SettlementEntry | undefined>;
  // Atomically bind a round to a plan, returning false if it was already bound to different contents.
  bindPlan?(scope: string, fingerprint: string): Promise<boolean>;
};
export type SettlementTransport = {
  scope: string;
  asset: string;
  prepare(payment: Readonly<Payment>): Promise<SignedPayment>;
  broadcast(signed: Readonly<SignedPayment>): Promise<void>;
  inspect(payment: Readonly<Payment>, hash: string): Promise<PaymentReceipt["status"]>;
};

export async function executeSettlement(
  input: SettlementPlan,
  options: {
    transport: SettlementTransport;
    journal: SettlementJournal;
    authorize: (payment: Readonly<Payment>) => boolean | Promise<boolean>;
  },
) {
  const plan = structuredClone(input);
  const { transport, journal, authorize } = options;
  summarizeSettlement(plan, []);
  if ((plan.version !== 1 && plan.version !== 2) || !plan.roundId || plan.asset !== transport.asset) {
    throw new Error("Settlement plan does not match the transport");
  }
  for (const payment of plan.payments) {
    if (!payment.buyerId || !payment.sellerId || payment.buyerId === payment.sellerId
      || payment.id !== paymentIdFor(plan.version, plan.roundId, payment.buyerId, payment.sellerId)) {
      throw new Error("Invalid payment identity");
    }
  }
  if (plan.payments.length && (plan.version === 2 || journal.bindPlan)) {
    const scope = JSON.stringify([transport.scope, plan.asset, plan.roundId]);
    const fingerprint = JSON.stringify([plan.version, plan.payments.map(({ id, sellerId, amount }) => [id, sellerId, amount])]);
    if (!journal.bindPlan) throw new Error("Split settlement requires an atomic plan binding");
    if (!await journal.bindPlan(scope, fingerprint)) throw new Error("Split settlement plan differs from the journal");
  }

  const receipts: (PaymentReceipt & { transactionHash?: string; broadcastUncertain?: true })[] = [];
  const unfinishedBuyers = new Set<string>();
  for (const item of plan.payments) {
    const payment = Object.freeze(item);
    const scope = JSON.stringify([transport.scope, plan.asset, payment.id]);
    let entry = await journal.read(scope);
    if (!entry) {
      if (unfinishedBuyers.has(payment.buyerId) || !await authorize(payment)) {
        unfinishedBuyers.add(payment.buyerId);
        receipts.push({ paymentId: payment.id, status: "pending" });
        continue;
      }
      const signed = await transport.prepare(payment);
      if (!signed.hash || !signed.bytes) throw new Error("Missing signed transaction");
      entry = await journal.reserve(scope, { payment, signed });
    }
    if (entry.payment.id !== payment.id || entry.payment.buyerId !== payment.buyerId
      || entry.payment.sellerId !== payment.sellerId || entry.payment.amount !== payment.amount) {
      throw new Error(`Payment differs from the journal: ${payment.id}`);
    }
    const signed = Object.freeze({ ...entry.signed });
    let status = await transport.inspect(payment, signed.hash);
    let broadcastUncertain: true | undefined;
    if (status === "pending" && !unfinishedBuyers.has(payment.buyerId) && await authorize(payment)) {
      try {
        await transport.broadcast(signed);
      } catch {
        broadcastUncertain = true;
      }
      status = await transport.inspect(payment, signed.hash);
    }
    if (status !== "confirmed") unfinishedBuyers.add(payment.buyerId);
    receipts.push({ paymentId: payment.id, status, transactionHash: signed.hash,
      ...(status === "pending" && broadcastUncertain ? { broadcastUncertain } : {}),
    });
  }
  return { receipts, summary: summarizeSettlement(plan, receipts) };
}
