# Lolah BuildX submission readiness

Target: the fixed BuildX Hackathon Grant for an AI-powered onchain application. Lolah does not claim
eligibility for the AI-RWA liquidity prize or volume-based Launch Grant without real qualifying
liquidity or trading volume.

The August campaign dates and prize amounts below come from the current announcement supplied by the
project owner. Re-check the official submission form before submitting because the indexed OKX Build X
page still exposes earlier 2026 rounds.

## Eligibility checklist

| Requirement | Evidence | State |
|---|---|---|
| AI is integral to the product | Verified crypto-event classification plus PolyDesk prediction context and Hyperliquid market context | Implemented |
| Independent X Layer deployment | LolahSignalProofRegistry.sol anchors privacy-preserving signal and delivery batch roots | Source implemented; deployment pending |
| Public working product | https://lolah.onrender.com/health and the Lolah OKX service | Scanner live; ASP registration pending |
| Dedicated X account | Public Lolah product account | Pending |
| Submission post tags @XLayerOfficial | Dedicated account submission post | Pending |
| Submit by August 21 at 23:59 UTC | Official submission form | Pending |

## Judge-facing product loop

1. Lolah detects an official Upbit listing or high-impact crypto announcement.
2. It verifies the source and classifies the event.
3. It adds current Hyperliquid market conditions and the nearest PolyDesk prediction-market consensus,
   or states that no relevant Polymarket market exists.
4. It pushes an intelligence-only alert to agents with a currently active Lolah Market Watch
   subscription.
5. It batches signal and delivery commitments into Merkle roots and anchors only those roots on X
   Layer. Raw messages, subscribers, positions, and trading instructions remain offchain.

## Onchain component

- Contract: contracts/LolahSignalProofRegistry.sol
- Network: X Layer mainnet, chain ID 196
- Public RPC: https://rpc.xlayer.tech
- Explorer: https://www.okx.com/web3/explorer/xlayer
- Contract address: pending deployment
- Deployment transaction: pending deployment

The contract has a two-step operator rotation, rejects duplicate batches, requires delivery batches to
reference an existing signal batch, and stores no private subscriber information.

## Demo evidence to capture

- The earliest official Upbit event receipt and measured detection latency.
- The generated alert with source, Hyperliquid context, PolyDesk match or no-market result, and risk
  explanation.
- A controlled subscribed-agent delivery through the official OKX recipient-eligibility path.
- The signal batch root, X Layer transaction, contract event, and explorer link.
- The public Lolah service status showing the 72-hour trial and 1 USDT monthly plan.

## Submission positioning

Lolah is an explainable cross-market intelligence rail for agents. Its differentiation is not another
generic news feed: it connects authoritative catalysts, perpetual-market conditions, prediction-market
consensus, paid agent distribution, and privacy-preserving X Layer proof.

Do not claim that Lolah predicts guaranteed outcomes, automatically places trades, has reached 10M USDT
volume, or qualifies for the AI-RWA liquidity grant unless those facts become independently verifiable.
