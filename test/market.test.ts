import { strict as assert } from "node:assert";
import { test } from "node:test";
import { authorizeWithSpendingPolicies, cheapestCapacity, prepareNearIntentsTransfers as prepareSplitIntents } from "../src/swarm/index.ts";
import { auditSettlement, executeWithSpendingPolicies, spendingPolicyMessage } from "../src/swarm/index.ts";
import { executeSettlement, nearIntentsTransport } from "../src/swarm/index.ts";
import {
  openStoredRound, replayRound, resumeRound, settlementPlanFromTranscript, submitStoredRoundEvent,
} from "../src/swarm/index.ts";
import type { RoundStore, RoundTranscript } from "../src/swarm/index.ts";
import {
  nearIntentsExecutionCall, planNearSubaccounts, prepareNearIntentsTransfers, signNearIntentsTransfers,
} from "../src/swarm/index.ts";
import { runScenario } from "../src/scenarios/procurement.ts";
import { commitBid, createRound, simulateProcurement, summarizeSettlement } from "../src/swarm/index.ts";

test("GPU round is deterministic and pays exact shares within buyer caps", async () => {
  const transcript = await runScenario();
  assert.deepEqual(transcript, await runScenario());
  const [demand, committed, revealed, result] = transcript.stages;
  assert.equal(demand.buyers.length, 20);
  assert.equal(committed.bids.length, 5);
  assert.ok(committed.bids.every((bid) => bid.reveal === null));
  assert.ok(revealed.bids.every((bid) => bid.reveal !== null));
  assert.equal(revealed.allocation, null);
  assert.equal(result.bids[0].rejection, "insufficient-capacity");
  assert.equal(result.bids[3].rejection, "buyer-budget");
  assert.equal(result.allocation?.sellerId, "seller-2.swarm.testnet");
  assert.equal(result.allocation?.unitPrice, "4");
  assert.equal(transcript.payments.length, 20);
  for (const buyer of result.buyers) {
    const payment = transcript.payments.find(({ buyerId }) => buyerId === buyer.buyerId);
    assert.ok(payment);
    assert.equal(BigInt(payment.amount), BigInt(buyer.quantity) * 4n);
    assert.ok(BigInt(payment.amount) <= BigInt(buyer.budget));
  }
  assert.equal(transcript.payments.reduce((sum, p) => sum + BigInt(p.amount), 0n).toString(), result.allocation.total);
});

test("split fulfillment replays, enforces a cumulative signed cap, and settles distinct seller payments", async () => {
  const options: Parameters<typeof simulateProcurement>[0] = {
    seed: 2,
    spec: {
      id: "split", mechanismId: cheapestCapacity.id, asset: "nep141:wrap.near",
      resource: { label: "GPU", unit: "hour", deliveryWindow: "today" },
      demandCloses: 10, commitCloses: 20, revealCloses: 30,
    },
    buyers: [{ id: "buyer.near", demand: () => ({ quantity: "5", budget: "14" }) }],
    sellers: [
      { id: "alpha.near", offer: () => ({ capacity: "3", unitPrice: "2" }) },
      { id: "beta.near", offer: () => ({ capacity: "2", unitPrice: "4" }) },
    ],
  };
  const { transcript, plan, stages } = await simulateProcurement(options);
  assert.equal(stages[3].splitAllocation?.total, "14");
  assert.equal(plan.version, 2);
  assert.deepEqual(await settlementPlanFromTranscript(JSON.parse(JSON.stringify(transcript))), plan);
  assert.deepEqual(plan.payments.map(({ id, amount }) => [id, amount]), [
    ['["split","buyer.near","alpha.near"]', "6"], ['["split","buyer.near","beta.near"]', "8"],
  ]);
  assert.equal(prepareSplitIntents(plan, { salt: "1234abcd", deadline: new Date(Date.now() + 60000) }).length, 2);
  await assert.rejects(replayRound(transcript, {
    id: cheapestCapacity.id,
    allocate: () => [{ buyerId: "buyer.near", sellerId: "alpha.near", quantity: "5" }],
  }), /exceeds demand, budget or capacity/);
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const policy = { roundId: "split", buyerId: "buyer.near", asset: plan.asset, transportScope: "fixture",
    sellers: ["alpha.near", "beta.near"], maxAmount: "13", expiresAt: 20 };
  async function approval(maxAmount: string) {
    const signedPolicy = { ...policy, maxAmount };
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, spendingPolicyMessage(signedPolicy)));
    return { policy: signedPolicy, signature };
  }
  const resolveBuyerKey = async () => keys.publicKey;
  const authorize = await authorizeWithSpendingPolicies(plan, "fixture", [await approval("13")], resolveBuyerKey, () => 10);
  assert.ok(plan.payments.every((payment) => !authorize(payment)));

  const entries = new Map<string, import("../src/swarm/index.ts").SettlementEntry>();
  const sent = new Set<string>();
  let fingerprint: string | undefined;
  const execution = {
    approvals: [await approval("14")], resolveBuyerKey, clock: () => 10,
    journal: {
      read: async (scope: string) => entries.get(scope),
      reserve: async (scope: string, entry: import("../src/swarm/index.ts").SettlementEntry) => {
        if (!entries.has(scope)) entries.set(scope, entry);
        return entries.get(scope)!;
      },
      bindPlan: async (_scope: string, next: string) => (fingerprint ??= next) === next,
    },
    transport: {
      scope: "fixture", asset: plan.asset,
      prepare: async (payment: Readonly<(typeof plan.payments)[number]>) => ({ hash: payment.id, bytes: payment.id }),
      inspect: async (_payment: Readonly<(typeof plan.payments)[number]>, hash: string) =>
        sent.has(hash) ? "confirmed" as const : "pending" as const,
      broadcast: async ({ hash }: { hash: string }) => { assert.ok(!sent.has(hash)); sent.add(hash); },
    },
  };
  const settled = await executeWithSpendingPolicies(plan, execution);
  assert.equal(settled.summary.confirmed, "14");
  assert.equal(sent.size, 2);
  assert.equal((await executeWithSpendingPolicies(plan, execution)).summary.paid, true);
  await assert.rejects(executeWithSpendingPolicies({ ...plan, payments: plan.payments.slice(1) }, execution),
    /plan differs from the journal/);
  const audited = await auditSettlement(transcript, settled.receipts, { verifier: execution.transport });
  assert.equal(audited.verifiedSummary?.paid, true);
});

test("audit separates offline claims from observed receipts and rejects reused hashes", async () => {
  const { transcript, plan } = await runScenario();
  const receipts = plan.payments.slice(0, 2).map(({ id }, index) => ({
    paymentId: id, status: "confirmed" as const, transactionHash: `tx-${index}`,
  }));
  const offline = await auditSettlement(transcript, receipts);
  assert.equal(offline.verifiedSummary, undefined);
  const online = await auditSettlement(transcript, receipts, {
    verifier: { asset: plan.asset, inspect: async (_payment, hash) => hash === "tx-0" ? "confirmed" : "pending" },
  });
  assert.equal(online.checks[0].matches, true);
  assert.equal(online.checks[1].matches, false);
  assert.equal(online.verifiedSummary?.confirmed, plan.payments[0].amount);
  await assert.rejects(auditSettlement(transcript, [receipts[0], { ...receipts[1], transactionHash: "tx-0" }]),
    /hash reused/);
});

test("a buyer signature gates settlement by amount, transport and expiry", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const payment = { id: '["round","buyer"]', buyerId: "buyer", sellerId: "seller", amount: "25" };
  const plan = { version: 1 as const, roundId: "round", asset: "token", payments: [payment] };
  const policy = { roundId: "round", buyerId: "buyer", asset: "token", transportScope: "testnet",
    sellers: ["seller"], maxAmount: "25", expiresAt: 20 };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, spendingPolicyMessage(policy)));
  let time = 10;
  let broadcasts = 0;
  let entry: import("../src/swarm/index.ts").SettlementEntry | undefined;
  const options = {
    approvals: [{ policy, signature }],
    resolveBuyerKey: async () => keys.publicKey,
    clock: () => time,
    transport: {
      scope: "testnet", asset: "token",
      prepare: async () => {
        time = 20;
        return { hash: "hash", bytes: "bytes" };
      },
      inspect: async () => "pending" as const,
      broadcast: async () => { broadcasts++; },
    },
    journal: {
      read: async () => entry,
      reserve: async (_scope: string, candidate: NonNullable<typeof entry>) => entry ??= candidate,
    },
  };
  assert.equal((await executeWithSpendingPolicies(plan, options)).summary.pending, "25");
  assert.ok(entry);
  assert.equal(broadcasts, 0);
  await assert.rejects(executeWithSpendingPolicies(plan, {
    ...options, approvals: [{ policy: { ...policy, maxAmount: "26" }, signature }],
  }), /Invalid buyer signature/);
  await assert.rejects(executeWithSpendingPolicies(plan, {
    ...options, transport: { ...options.transport, scope: "mainnet" },
  }), /does not match the plan/);
});

test("a stored round survives restart, detects conflicting writes, and replays into the same payment plan", async () => {
  const { transcript, plan, stages } = await runScenario();
  const restored = JSON.parse(JSON.stringify(transcript));
  assert.deepEqual(await replayRound(restored), stages[3]);
  assert.deepEqual(await settlementPlanFromTranscript(restored), plan);
  const tampered = structuredClone(transcript);
  const reveal = tampered.events.find((event) => event.type === "reveal");
  assert.ok(reveal?.type === "reveal");
  reveal.bid.unitPrice = "999";
  await assert.rejects(replayRound(tampered), /Rejected round event/);

  let persisted: RoundTranscript | undefined;
  const store: RoundStore = {
    read: async () => persisted && JSON.parse(JSON.stringify(persisted)),
    compareAndSet: async (next, revision) => {
      if ((persisted?.events.length ?? null) !== revision) return false;
      persisted = structuredClone(next);
      return true;
    },
  };
  const spec = transcript.spec;
  await openStoredRound(spec, store, () => 0);
  const demands = spec.buyers.slice(0, 2).map((buyerId) =>
    submitStoredRoundEvent(spec.id, { type: "demand", buyerId, request: { quantity: "1", budget: "5" } }, store, () => 1));
  assert.deepEqual((await Promise.all(demands)).map(({ status }) => status).sort(), ["accepted", "conflict"]);
  assert.ok(persisted);
  const resumed = await resumeRound(persisted, () => spec.revealCloses);
  assert.equal(resumed.snapshot().quantity, "1");
  assert.equal(resumed.snapshot().phase, "closed");
  assert.equal((await settlementPlanFromTranscript(resumed.transcript())).payments.length, 0);
});

test("Intents transport preflights before signing and reconciles an exact finalized call", async (context) => {
  const asset = "nep141:wrap.near";
  const payment = { id: '["round","buyer.near"]', buyerId: "buyer.near", sellerId: "seller.near", amount: "25" };
  const hash = "1".repeat(32);
  let argsBase64 = "";
  let rejectSimulation = false;
  let finalAmount = "25";
  const mock = context.mock.method(globalThis, "fetch", async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    if (method === "query") {
      const result = params.method_name === "current_salt" ? "abcd1234"
        : { intents_executed: rejectSimulation ? [] : [{}] };
      return Response.json({ result: { result: Array.from(Buffer.from(JSON.stringify(result))) } });
    }
    assert.equal(method, "tx");
    assert.equal(params.sender_account_id, "relay.near");
    const args = JSON.parse(Buffer.from(argsBase64, "base64").toString());
    const message = JSON.parse(args.signed[0].payload.message);
    message.intents[0].tokens[asset] = finalAmount;
    args.signed[0].payload.message = JSON.stringify(message);
    return Response.json({ result: {
      final_execution_status: "FINAL", status: { SuccessValue: "" },
      transaction: {
        hash, signer_id: "relay.near", receiver_id: "intents.near",
        actions: [{ FunctionCall: {
          method_name: "execute_intents", deposit: "0", args: Buffer.from(JSON.stringify(args)).toString("base64"),
        } }],
      },
    } });
  });
  const transport = nearIntentsTransport({
    asset, relayerId: "relay.near",
    signIntent: async () => ({ publicKey: "ed25519:" + "1".repeat(32), signature: "ed25519:" + "1".repeat(64) }),
    signTransaction: async (call) => {
      argsBase64 = Buffer.from(JSON.stringify(call.args)).toString("base64");
      return { hash, bytes: "signed" };
    },
  });
  await transport.prepare(payment);
  assert.equal(await transport.inspect(payment, hash), "confirmed");
  finalAmount = "26";
  await assert.rejects(transport.inspect(payment, hash), /differs from the payment/);
  rejectSimulation = true;
  argsBase64 = "";
  await assert.rejects(transport.prepare(payment), /did not simulate/);
  assert.equal(argsBase64, "");
  mock.mock.restore();
});

test("ambiguous broadcast resumes from the journal without signing a replacement", async () => {
  const payment = { id: '["round","buyer"]', buyerId: "buyer", sellerId: "seller", amount: "25" };
  const plan = { version: 1 as const, roundId: "round", asset: "token", payments: [payment] };
  let entry: import("../src/swarm/index.ts").SettlementEntry | undefined;
  let confirmed = false;
  let prepares = 0;
  let broadcasts = 0;
  const options = {
    authorize: () => true,
    journal: {
      read: async () => entry,
      reserve: async (_scope: string, candidate: NonNullable<typeof entry>) => entry ??= candidate,
    },
    transport: {
      scope: "test", asset: "token",
      prepare: async () => {
        prepares++;
        return { hash: "hash", bytes: "bytes" };
      },
      inspect: async () => confirmed ? "confirmed" as const : "pending" as const,
      broadcast: async () => {
        assert.ok(entry);
        broadcasts++;
        throw new Error("Response lost");
      },
    },
  };
  const first = await executeSettlement(plan, options);
  assert.equal(first.receipts[0].broadcastUncertain, true);
  confirmed = true;
  const resumed = await executeSettlement(plan, options);
  assert.equal(resumed.summary.confirmed, "25");
  assert.equal(prepares, 1);
  assert.equal(broadcasts, 1);
  await assert.rejects(executeSettlement({ ...plan, payments: [{ ...payment, amount: "26" }] }, options),
    /differs from the journal/);
});

test("NEAR Intents preserves exact buyer, recipient and amount in the signed batch", async () => {
  const payment = { id: '["round","buyer.parent.near"]', buyerId: "buyer.parent.near", sellerId: "seller.parent.near", amount: "9007199254740993" };
  const plan = { version: 1 as const, roundId: "round", asset: "nep141:wrap.near", payments: [payment] };
  const deadline = new Date("2099-01-01T00:00:00.000Z");
  const requests = prepareNearIntentsTransfers(plan, { salt: "1234abcd", deadline });
  const request = requests[0];
  assert.equal(Buffer.from(request.nonce, "base64").length, 32);
  assert.equal(Buffer.from(request.nonce, "base64").subarray(0, 4).toString("hex"), "1234abcd");
  assert.deepEqual(JSON.parse(request.message), {
    signer_id: payment.buyerId,
    deadline: deadline.toISOString(),
    intents: [{ intent: "transfer", receiver_id: payment.sellerId, tokens: { [plan.asset]: payment.amount }, memo: payment.id }],
  });
  const args = await signNearIntentsTransfers(requests, async (input) => {
    assert.equal(input.payment.id, payment.id);
    return { publicKey: "ed25519:" + "1".repeat(32), signature: "ed25519:" + "1".repeat(64) };
  });
  const call = nearIntentsExecutionCall(args);
  assert.equal(call.receiverId, "intents.near");
  assert.equal(call.methodName, "execute_intents");
  assert.deepEqual(call.args.signed[0].payload, { recipient: request.recipient, message: request.message, nonce: request.nonce });
  assert.throws(() => prepareNearIntentsTransfers({ ...plan, asset: "simulated-credits" }, { salt: "1234abcd", deadline }));
});

test("sub-account provisioning assigns one distinct public key to each direct child", () => {
  const agent = { label: "buyer-1", publicKey: "ed25519:" + "1".repeat(32), fundingYoctoNear: "100" };
  const [tx] = planNearSubaccounts("parent.testnet", [agent]);
  assert.equal(tx.signerId, "parent.testnet");
  assert.equal(tx.receiverId, "buyer-1.parent.testnet");
  assert.deepEqual(tx.actions.map(({ type }) => type), ["CreateAccount", "Transfer", "AddFullAccessKey"]);
  assert.throws(() => planNearSubaccounts("parent.testnet", [agent, { ...agent, label: "buyer-2" }]), /reused agent key/);
});

test("same engine clears API credits and creates no payments for an unfilled round", async () => {
  const credits = await runScenario(2026, "api-credits");
  const unfilled = await runScenario(2026, "no-sale");
  assert.equal(credits.payments.length, 3);
  assert.equal(credits.stages.at(-1)?.spec.resource.label, "Inference API credits");
  assert.equal(unfilled.stages.at(-1)?.allocation, null);
  assert.deepEqual(unfilled.payments, []);
});

test("commit is immutable, mismatched reveal can be corrected, and ties use account ID", async () => {
  let time = 0;
  const round = createRound({
    id: "test", resource: { label: "GPU", unit: "hour", deliveryWindow: "today" },
    asset: "credits", buyers: ["buyer"], sellers: ["seller-b", "seller-a"],
    demandCloses: 10, commitCloses: 20, revealCloses: 30,
  }, () => time);
  const bid = { capacity: "3", unitPrice: "4", salt: "a".repeat(64) };
  assert.ok(round.submitDemand("buyer", { quantity: "3", budget: "12" }));
  time = 10;
  assert.equal(round.submitDemand("buyer", null), false);
  for (const seller of ["seller-b", "seller-a"]) {
    assert.ok(round.submitCommitment(seller, await commitBid("test", seller, bid)));
    assert.equal(round.submitCommitment(seller, "b".repeat(64)), false);
  }
  time = 20;
  assert.equal(await round.revealBid("seller-a", { ...bid, unitPrice: "5" }), false);
  assert.ok(await round.revealBid("seller-a", bid));
  assert.ok(await round.revealBid("seller-b", bid));
  time = 30;
  assert.equal(await round.revealBid("seller-a", bid), false);
  assert.equal(round.snapshot().allocation?.sellerId, "seller-a");
});

test("consumer strategies can model a missing reveal and partially paid allocation", async () => {
  const { stages, plan, settlement } = await simulateProcurement({
    seed: 8,
    spec: {
      id: "dataset", resource: { label: "Dataset", unit: "seat", deliveryWindow: "today" },
      asset: "credits", demandCloses: 10, commitCloses: 20, revealCloses: 30,
    },
    buyers: [
      { id: "one", demand: () => ({ quantity: "2", budget: "6" }) },
      { id: "two", demand: () => ({ quantity: "1", budget: "3" }) },
    ],
    sellers: [
      { id: "absent", offer: () => ({ capacity: "3", unitPrice: "1" }), reveal: false },
      { id: "vendor", offer: ({ pooledQuantity }) => ({ capacity: pooledQuantity, unitPrice: "3" }) },
    ],
    paymentOutcome: ({ buyerId }) => buyerId === "one" ? "confirmed" : "failed",
  });
  assert.equal(stages[3].bids[0].rejection, "missing-reveal");
  assert.deepEqual(settlement, { confirmed: "6", pending: "0", failed: "3", paid: false });
  assert.deepEqual(summarizeSettlement(plan, []), { confirmed: "0", pending: "9", failed: "0", paid: false });
  const receipt = { paymentId: plan.payments[0].id, status: "confirmed" } as const;
  assert.throws(() => summarizeSettlement(plan, [receipt, receipt]), /Unexpected payment receipt/);
});
