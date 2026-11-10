import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  INTENTS_VERIFIER, prepareNearIntentsTransfers, readNearIntentsSalt, signNearIntentsTransfers,
} from "../dist/sdk/index.js";

const rpc = "https://rpc.mainnet.near.org";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = BigInt("0x" + bytes.toString("hex"));
  let result = "";
  while (value > 0n) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function borshString(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}

const keys = generateKeyPairSync("ed25519");
const publicBytes = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const buyerId = publicBytes.toString("hex");
const roundId = "swarmkit-verifier-probe";
const requests = prepareNearIntentsTransfers({
  version: 1,
  roundId,
  asset: "nep141:wrap.near",
  payments: [{ id: JSON.stringify([roundId, buyerId]), buyerId, sellerId: "wrap.near", amount: "1" }],
}, { salt: await readNearIntentsSalt(rpc), deadline: new Date(Date.now() + 120_000) });

const args = await signNearIntentsTransfers(requests, async ({ message, nonce, recipient }) => {
  const serialized = Buffer.concat([
    u32(2 ** 31 + 413), borshString(message), Buffer.from(nonce, "base64"),
    borshString(recipient), Buffer.from([0]),
  ]);
  const digest = createHash("sha256").update(serialized).digest();
  return {
    publicKey: "ed25519:" + base58(publicBytes),
    signature: "ed25519:" + base58(sign(null, digest, keys.privateKey)),
  };
});

const response = await fetch(rpc, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  signal: AbortSignal.timeout(15_000),
  body: JSON.stringify({
    jsonrpc: "2.0", id: "swarmkit-signed-probe", method: "query",
    params: {
      request_type: "call_function", finality: "final", account_id: INTENTS_VERIFIER,
      method_name: "simulate_intents", args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  }),
});
assert.ok(response.ok, `RPC HTTP ${response.status}`);
const body = await response.json();
const outcome = body.result?.result
  ? JSON.parse(Buffer.from(body.result.result).toString())
  : body.error ?? body.result ?? body;
assert.match(JSON.stringify(outcome), /balance.*(?:overflow|underflow|insufficient)|insufficient.*balance/i,
  `Expected the unfunded signer to reach balance validation. Got ${JSON.stringify(outcome)}`);
console.log("Signed NEP-413 transfer reached the live Verifier balance check. No transaction was broadcast.");
