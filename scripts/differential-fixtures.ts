// Generates seeded random rounds and the SDK's allocation for each, for the contract's
// differential test (contracts/exchange/src/differential.rs). Run: node scripts/differential-fixtures.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { cheapestCapacity } from "../src/swarm/mechanism.ts";

const count = Number(process.argv[2] ?? 2000);
let state = 2026;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));

const rounds = Array.from({ length: count }, () => {
  const buyers = Array.from({ length: int(1, 20) }, (_, i) => {
    const quantity = int(1, 12);
    return { buyerId: `buyer-${i + 1}.testnet`, quantity: String(quantity), budget: String(quantity * int(50, 400) + int(0, 99)) };
  });
  const offers = Array.from({ length: int(0, 6) }, (_, i) => ({
    sellerId: `seller-${int(1, 9)}${i}.testnet`, capacity: String(int(1, 60)), unitPrice: String(int(40, 400)),
  }));
  const lines = cheapestCapacity.allocate(structuredClone(buyers), structuredClone(offers));
  return { buyers, offers, lines };
});
const dir = new URL("../contracts/exchange/src/fixtures/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("rounds.json", dir), JSON.stringify(rounds));
const cleared = rounds.filter((r) => r.lines).length;
console.log(`${count} rounds, ${cleared} cleared, ${count - cleared} failed`);
