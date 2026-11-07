import type { Allocation, Bid, Demand, RoundSpec } from "./types.ts";

export type { Allocation, Bid, Demand, RoundSpec } from "./types.ts";

const positiveDecimal = /^[1-9][0-9]*$/;
const accountId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const digest = /^[0-9a-f]{64}$/;

function validBid(bid: Bid) {
  return typeof bid.capacity === "string" && positiveDecimal.test(bid.capacity)
    && typeof bid.unitPrice === "string" && positiveDecimal.test(bid.unitPrice)
    && typeof bid.salt === "string" && digest.test(bid.salt);
}

export async function commitBid(roundId: string, sellerId: string, bid: Bid) {
  if (!validBid(bid)) throw new Error("Invalid bid");
  const encoded = new TextEncoder().encode(JSON.stringify([
    "swarmkit-bid-v1", roundId, sellerId, bid.capacity, bid.unitPrice, bid.salt,
  ]));
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createRound(input: RoundSpec, clock: () => number = Date.now) {
  const spec = structuredClone(input);
  const participants = [...spec.buyers, ...spec.sellers];
  if (
    !spec.id || participants.some((id) => !accountId.test(id))
    || new Set(participants).size !== participants.length
    || ![spec.demandCloses, spec.commitCloses, spec.revealCloses].every(Number.isSafeInteger)
    || spec.demandCloses >= spec.commitCloses || spec.commitCloses >= spec.revealCloses
  ) throw new Error("Invalid round configuration");

  const demand = new Map<string, Demand>();
  const commitments = new Map<string, string>();
  const reveals = new Map<string, Bid>();
  let observedTime = -Infinity;

  function phase() {
    const time = clock();
    if (!Number.isFinite(time) || time < observedTime) throw new Error("Invalid round clock");
    observedTime = time;
    if (time < spec.demandCloses) return "demand";
    if (demand.size === 0) return "closed";
    if (time < spec.commitCloses) return "commit";
    if (time < spec.revealCloses) return "reveal";
    return "closed";
  }

  function submitDemand(buyerId: string, request: Demand | null) {
    if (phase() !== "demand" || !spec.buyers.includes(buyerId)) return false;
    if (request === null) {
      demand.delete(buyerId);
      return true;
    }
    if (
      typeof request.quantity !== "string" || !positiveDecimal.test(request.quantity)
      || typeof request.budget !== "string" || !/^(0|[1-9][0-9]*)$/.test(request.budget)
    ) return false;
    demand.set(buyerId, { ...request });
    return true;
  }

  function submitCommitment(sellerId: string, hash: string) {
    if (
      phase() !== "commit" || !spec.sellers.includes(sellerId)
      || commitments.has(sellerId) || !digest.test(hash)
    ) return false;
    commitments.set(sellerId, hash);
    return true;
  }

  async function revealBid(sellerId: string, bid: Bid) {
    const commitment = commitments.get(sellerId);
    if (phase() !== "reveal" || !commitment || reveals.has(sellerId) || !validBid(bid)) return false;
    const submitted = { ...bid };
    const hash = await commitBid(spec.id, sellerId, submitted);
    if (phase() !== "reveal" || reveals.has(sellerId) || hash !== commitment) return false;
    reveals.set(sellerId, submitted);
    return true;
  }

  function snapshot() {
    const current = phase();
    const buyers = Array.from(demand, ([buyerId, request]) => ({ buyerId, ...request }));
    const quantity = buyers.reduce((sum, buyer) => sum + BigInt(buyer.quantity), 0n);
    const bids = Array.from(commitments, ([sellerId, commitment]) => {
      const bid = reveals.get(sellerId);
      let rejection = null;
      if (current === "closed") {
        if (!bid) rejection = "missing-reveal";
        else if (BigInt(bid.capacity) < quantity) rejection = "insufficient-capacity";
        else if (buyers.some((buyer) => BigInt(buyer.quantity) * BigInt(bid.unitPrice) > BigInt(buyer.budget))) {
          rejection = "buyer-budget";
        }
      }
      return { sellerId, commitment, reveal: bid ? { ...bid } : null, rejection };
    });
    let allocation: Allocation | null = null;
    if (current === "closed" && quantity > 0n) {
      for (const entry of bids) {
        if (!entry.reveal || entry.rejection) continue;
        const unitPrice = BigInt(entry.reveal.unitPrice);
        if (allocation) {
          const winningPrice = BigInt(allocation.unitPrice);
          if (unitPrice > winningPrice || (unitPrice === winningPrice && entry.sellerId > allocation.sellerId)) {
            continue;
          }
        }
        allocation = {
          sellerId: entry.sellerId,
          unitPrice: unitPrice.toString(),
          total: (unitPrice * quantity).toString(),
          shares: buyers.map(({ buyerId, quantity }) => ({
            buyerId, quantity, amount: (BigInt(quantity) * unitPrice).toString(),
          })),
        };
      }
    }
    return {
      spec: structuredClone(spec),
      phase: current,
      buyers,
      quantity: quantity.toString(),
      bids,
      allocation,
    };
  }

  return { submitDemand, submitCommitment, revealBid, snapshot };
}
