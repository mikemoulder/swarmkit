import { settlementPlanFromTranscript } from "./replay.ts";
import { summarizeSettlement } from "./settlement.ts";
import type { PaymentReceipt } from "./settlement.ts";
import type { RoundTranscript } from "./round.ts";
import type { ProcurementMechanism } from "./mechanism.ts";
import type { SettlementTransport } from "./execute.ts";

export type ReceiptClaim = PaymentReceipt & { transactionHash?: string };

export async function auditSettlement(
  transcript: RoundTranscript,
  claims: readonly ReceiptClaim[],
  options: { mechanism?: ProcurementMechanism; verifier?: Pick<SettlementTransport, "asset" | "inspect"> } = {},
) {
  const receipts = structuredClone(claims);
  const { verifier } = options;
  const plan = await settlementPlanFromTranscript(transcript, options.mechanism);
  if (verifier && verifier.asset !== plan.asset) throw new Error("Verifier asset differs from the round");
  const claimedSummary = summarizeSettlement(plan, receipts);
  const hashes = new Set<string>();
  for (const { transactionHash, status } of receipts) {
    if (!transactionHash) {
      if (verifier && status !== "pending") throw new Error("Final receipt claim requires a transaction hash");
      continue;
    }
    if (hashes.has(transactionHash)) throw new Error("Transaction hash reused across payments");
    hashes.add(transactionHash);
  }
  const byPayment = new Map(receipts.map((receipt) => [receipt.paymentId, receipt]));
  const checks = [];
  for (const payment of plan.payments) {
    const claim = byPayment.get(payment.id);
    const hash = claim?.transactionHash;
    const observed = verifier && hash ? await verifier.inspect(Object.freeze({ ...payment }), hash) : undefined;
    checks.push({
      paymentId: payment.id, transactionHash: hash, claimed: claim?.status ?? "pending",
      observed, matches: observed === undefined ? undefined : observed === claim?.status,
    });
  }
  const verifiedSummary = verifier
    ? summarizeSettlement(plan, checks.map(({ paymentId, observed }) => ({ paymentId, status: observed ?? "pending" })))
    : undefined;
  return { plan, claimedSummary, verifiedSummary, checks };
}
