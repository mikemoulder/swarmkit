import { createRound } from "./round.ts";
import type { RoundCommand, RoundEvent, RoundTranscript } from "./round.ts";
import { createSettlementPlan } from "./settlement.ts";
import type { ProcurementMechanism } from "./mechanism.ts";

async function restore(input: RoundTranscript, nextTime?: () => number, mechanism?: ProcurementMechanism) {
  const transcript = structuredClone(input);
  if (transcript.version !== 1 || !Number.isFinite(transcript.observedAt)
    || !Array.isArray(transcript.events)) {
    throw new Error("Invalid round transcript");
  }
  let replayTime = -Infinity;
  let replaying = true;
  const round = createRound(transcript.spec, () =>
    replaying || !nextTime ? replayTime : nextTime(), mechanism);

  async function apply(event: RoundEvent) {
    switch (event.type) {
      case "demand":
        return (event.request === null || typeof event.request === "object")
          && round.submitDemand(event.buyerId, event.request);
      case "commitment":
        return typeof event.hash === "string" && round.submitCommitment(event.sellerId, event.hash);
      case "reveal":
        return Boolean(event.bid && typeof event.bid === "object")
          && round.revealBid(event.sellerId, event.bid);
      default:
        return false;
    }
  }

  for (const [index, event] of transcript.events.entries()) {
    if (!event || !Number.isFinite(event.at) || event.at < replayTime || event.at > transcript.observedAt) {
      throw new Error(`Invalid event time at index ${index}`);
    }
    replayTime = event.at;
    if (!await apply(event)) throw new Error(`Rejected round event at index ${index}`);
  }
  replayTime = transcript.observedAt;
  const snapshot = round.snapshot();
  replaying = false;
  return { round, snapshot };
}

export async function resumeRound(transcript: RoundTranscript, clock: () => number = Date.now, mechanism?: ProcurementMechanism) {
  return (await restore(transcript, clock, mechanism)).round;
}

export async function replayRound(transcript: RoundTranscript, mechanism?: ProcurementMechanism) {
  return (await restore(transcript, undefined, mechanism)).snapshot;
}

export async function settlementPlanFromTranscript(transcript: RoundTranscript, mechanism?: ProcurementMechanism) {
  return createSettlementPlan(await replayRound(transcript, mechanism));
}

export type RoundStore = {
  read(roundId: string): Promise<RoundTranscript | undefined>;
  // Atomically save only when the current event count equals expectedRevision.
  // A null revision means the round must not already exist.
  compareAndSet(next: RoundTranscript, expectedRevision: number | null): Promise<boolean>;
};

export async function openStoredRound(
  spec: RoundTranscript["spec"],
  store: RoundStore,
  clock: () => number = Date.now,
  mechanism?: ProcurementMechanism,
) {
  const round = createRound(spec, clock, mechanism);
  const initial = round.transcript();
  if (!await store.compareAndSet(initial, null)) throw new Error("Round already exists");
  return initial;
}

export async function submitStoredRoundEvent(
  roundId: string,
  event: RoundCommand,
  store: RoundStore,
  clock: () => number = Date.now,
  mechanism?: ProcurementMechanism,
) {
  const command = structuredClone(event);
  const prior = await store.read(roundId);
  if (!prior || prior.spec.id !== roundId) throw new Error("Round not found");
  const round = await resumeRound(prior, clock, mechanism);
  let accepted: boolean;
  switch (command.type) {
    case "demand":
      accepted = round.submitDemand(command.buyerId, command.request);
      break;
    case "commitment":
      accepted = round.submitCommitment(command.sellerId, command.hash);
      break;
    case "reveal":
      accepted = await round.revealBid(command.sellerId, command.bid);
      break;
    default:
      throw new Error("Unknown round command");
  }
  if (!accepted) return { status: "rejected" } as const;
  const transcript = round.transcript();
  if (!await store.compareAndSet(transcript, prior.events.length)) {
    return { status: "conflict" } as const;
  }
  return { status: "accepted", transcript } as const;
}
