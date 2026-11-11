import { readFile } from "node:fs/promises";
import { auditSettlement, nearTestnetTransport } from "../src/swarm/index.ts";

const [path, option] = process.argv.slice(2);
if (!path || (option && option !== "--verify-testnet")) {
  throw new Error("Usage: npm run audit -- <evidence.json> [--verify-testnet]");
}
const { transcript, receipts } = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const verifier = option ? nearTestnetTransport(async () => {
  throw new Error("Audit uses read-only transaction lookup");
}, "https://test.rpc.fastnear.com") : undefined;
const report = await auditSettlement(transcript, receipts, { verifier });
console.log(JSON.stringify(report, null, 2));
if (report.checks.some(({ matches }) => matches === false)) process.exitCode = 1;
