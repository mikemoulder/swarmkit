"use client";

import { useEffect, useState } from "react";
import { runScenario } from "../scenarios/procurement.ts";
import type { Scenario } from "../scenarios/procurement.ts";

const stages = ["Demand", "Commit", "Reveal", "Clear"];
const descriptions = [
  "Buyers pool demand and set their individual spending caps.",
  "Sellers submit commitments. Bid prices and capacities are sealed.",
  "Sellers reveal their offers. The SDK checks them against the commitments.",
  "The SDK evaluates capacity and budgets, then calculates each buyer’s share.",
];
const reasons: Record<string, string> = {
  "missing-reveal": "Missing reveal",
  "insufficient-capacity": "Insufficient capacity",
  "buyer-budget": "Over buyer budget",
};
type Transcript = Awaited<ReturnType<typeof runScenario>>;

export default function Market() {
  const [scenario, setScenario] = useState<Scenario>("gpu");
  const [step, setStep] = useState(0);
  const [transcript, setTranscript] = useState<Transcript>();
  const [error, setError] = useState(false);

  useEffect(() => {
    let current = true;
    runScenario(2026, scenario).then(
      (result) => { if (current) setTranscript(result); },
      () => { if (current) setError(true); },
    );
    return () => { current = false; };
  }, [scenario]);

  const round = transcript?.stages[step];
  const allocation = round?.allocation;
  return (
    <main>
      <header>
        <a href="#market" className="brand"><span aria-hidden="true">✳</span> SwarmKit</a>
        <span className="mode">Simulation</span>
      </header>
      <section className="intro" id="market">
        <div>
          <p className="eyebrow">Agent coordination on NEAR</p>
          <h1>Market simulator</h1>
          <p className="lede">Pool demand, reveal competing bids, and see what each agent pays.</p>
        </div>
        <label>Scenario
          <select value={scenario} onChange={(event) => {
            setScenario(event.target.value as Scenario);
            setStep(0);
            setTranscript(undefined);
            setError(false);
          }}>
            <option value="gpu">GPU procurement</option>
            <option value="api-credits">API credit procurement</option>
            <option value="no-sale">Insufficient supply</option>
          </select>
        </label>
      </section>
      {error ? <p role="alert">The simulation could not run. Reload the page to retry.</p>
        : !round ? <p role="status">Preparing the market…</p> : (
          <section className="market" aria-label="Procurement round">
            <nav aria-label="Round stages">
              {stages.map((stage, index) => (
                <button key={stage} aria-current={step === index ? "step" : undefined}
                  onClick={() => setStep(index)}>{stage}</button>
              ))}
            </nav>
            <div className="round">
              <div className="round-head">
                <div><h2>{round.spec.resource.label}</h2><p aria-live="polite">{descriptions[step]}</p></div>
                <button className="action" onClick={() => setStep(step === 3 ? 0 : step + 1)}>
                  {["Seal bids", "Reveal bids", "Clear round", "Replay round"][step]}
                </button>
              </div>
              <dl className="metrics">
                <div><dt>Pooled demand</dt><dd>{round.quantity} <small>{round.spec.resource.unit}s</small></dd></div>
                <div><dt>Buyer agents</dt><dd>{round.buyers.length}</dd></div>
                <div><dt>Seller agents</dt><dd>{round.spec.sellers.length}</dd></div>
                <div><dt>Clearing price</dt><dd>{allocation ? <>{allocation.unitPrice} <small>credits / unit</small></> : "—"}</dd></div>
              </dl>
              {round.bids.length > 0 && (
                <div className="table-wrap"><table>
                  <caption>Seller bids</caption>
                  <thead><tr><th scope="col">Seller</th><th scope="col">Credits / unit</th><th scope="col">Capacity</th><th scope="col">Outcome</th></tr></thead>
                  <tbody>{round.bids.map((bid) => {
                    const won = allocation?.sellerId === bid.sellerId;
                    return <tr key={bid.sellerId} className={won ? "winner" : undefined}>
                      <th scope="row">{bid.sellerId}</th><td>{bid.reveal?.unitPrice ?? "Sealed"}</td>
                      <td>{bid.reveal?.capacity ?? "—"}</td>
                      <td>{won ? "Winner" : bid.rejection ? reasons[bid.rejection] : step === 3 ? "Eligible" : bid.reveal ? "Verified" : "Committed"}</td>
                    </tr>;
                  })}</tbody>
                </table></div>
              )}
              {step === 3 && !allocation && <p className="result">No bid can fill the pool. No payments were created.</p>}
              {allocation && <p className="result">Total allocated: <strong>{allocation.total} simulated credits</strong></p>}
              <details open={step === 3}>
                <summary>{allocation ? "Buyer allocations" : "Buyer demand"} ({round.buyers.length})</summary>
                <div className="table-wrap"><table aria-label="Buyer details">
                  <thead><tr><th scope="col">Buyer</th><th scope="col">Quantity</th><th scope="col">Budget cap</th><th scope="col">Share</th></tr></thead>
                  <tbody>{round.buyers.map((buyer) => <tr key={buyer.buyerId}>
                    <th scope="row">{buyer.buyerId}</th><td>{buyer.quantity}</td><td>{buyer.budget}</td>
                    <td>{allocation?.shares.find((share) => share.buyerId === buyer.buyerId)?.amount ?? "—"}</td>
                  </tr>)}</tbody>
                </table></div>
              </details>
            </div>
          </section>
        )}
      <footer>SwarmKit SDK · Seed 2026 · Simulated accounts and credits</footer>
    </main>
  );
}
