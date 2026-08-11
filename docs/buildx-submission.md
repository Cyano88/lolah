# Lolah BuildX submission

## One-line pitch

Lolah turns the earliest verified crypto catalysts into safe, cross-market intelligence for subscribed
agents, then anchors privacy-preserving signal and delivery proofs on X Layer.

## The problem

Crypto agents are usually forced to choose between speed and trust. A fast social post may be false,
late, or irrelevant to the market an agent can actually trade. A generic news feed also does not say
whether a matching perpetual or prediction market exists. Lolah closes that gap without converting a
headline directly into an unsafe order.

## The product loop

1. Detect the catalyst. Upbit listings use a low-latency Seoul feed and require an official Upbit notice;
   curated X sources provide broader exchange, project, founder, developer, regulatory, research, and
   security coverage.
2. Verify and classify it. Immutable X author IDs, source scopes, freshness rules, corroboration, and
   duplicate suppression reject impersonators and stale or ambiguous claims.
3. Add market meaning. Lolah checks for the nearest PolyDesk prediction-market context and a matching
   Hyperliquid perpetual market. Missing markets and unavailable context are reported explicitly.
4. Make the safe decision. The current product emits intelligence-only `watch`, `context_ready`, or
   `no_trade` outcomes. It cannot sign or place a trade.
5. Deliver to eligible agents. Lolah Market Watch pushes only to subscribers returned by the official
   OKX active-subscription paths for Lolah's exact ASP and service identity.
6. Prove the work on X Layer. Deterministic Merkle roots can prove that a signal batch existed and that
   deliveries occurred without publishing alert text, agent identities, positions, or instructions.

## Why X Layer matters

X Layer is not a decorative deployment target. It is Lolah's neutral proof surface for
paid agent intelligence. A subscriber or partner can independently verify a batch commitment while the
sensitive intelligence remains offchain. The same primitive can later support transparent service-level
agreements and accountable agent-to-agent data markets.

This makes Lolah a bridge between four forms of market truth:

- authoritative catalysts from official sources;
- probability context from PolyDesk and Polymarket;
- executable-market availability and conditions from Hyperliquid;
- verifiable signal and delivery commitments on X Layer.

## Verified working evidence

The production evidence and reproduction-safe audit trail are recorded in
[`production-evidence.md`](production-evidence.md).

- Standalone Lolah ASP: `#10775`.
- Lolah Market Watch service: `17abe635-66b5-45c7-bfa2-8c7b546474e1`.
- Commercial plan: 72-hour free trial, then 1 USDT per month.
- Live scanner health: <https://lolah.onrender.com/health>.
- A real Upbit DOS listing was accepted from the official notice and detected after 315 ms.
- Lolah found no matching Hyperliquid perpetual and correctly sent a no-trade intelligence alert.
- The production alert reached an eligible subscribed agent through OKX delivery and was acknowledged.
- The active-recipient audit returned three eligible subscriptions, including two trial subscriptions.
- The DOS signal and its completed delivery are now independently committed on X Layer.
- Current repository verification: 161 tests passed, TypeScript type-check passed, and contract compile passed.

## X Layer component

- Contract: [`../contracts/LolahSignalProofRegistry.sol`](../contracts/LolahSignalProofRegistry.sol)
- Proof builder: [`../src/xlayer-signal-proof.ts`](../src/xlayer-signal-proof.ts)
- Network target: X Layer mainnet, chain ID 196
- Contract behavior: rejects duplicate roots, requires a signal root before its delivery root, and uses a
  two-step operator transfer.
- Privacy: only roots, counts, time windows, release hashes, and timestamps are public.
- Deployed contract: [`0xf045...312f`](https://www.oklink.com/x-layer/evm/address/0xf045acdaab3fcb6950e74301a655f1a5b4e5312f)
- Deployment transaction: [`0xab17...0020`](https://www.oklink.com/x-layer/evm/tx/0xab174ce987aa52f3653538f3a4eed0048b0617307bf3f4226a8b3c483f1c0020)
- DOS signal anchor: [`0x5194...dbd9`](https://www.oklink.com/x-layer/evm/tx/0x5194b92c17760a5549de34b3b3d9857bac802431ecf402a38c83c3165fd5dbd9)
- Delivery anchor: [`0x1378...5e9c`](https://www.oklink.com/x-layer/evm/tx/0x1378d78fca94327de989191046f7fa68dd2862fa7296119618f1cdf0234e5e9c)
- Machine-readable proof: [`xlayer-proof.json`](xlayer-proof.json)

Independent RPC verification confirmed that the deployed runtime bytecode matches the compiled artifact,
the operator matches the dedicated Lolah wallet, and both proof roots have nonzero onchain timestamps.

## Eligibility checklist

The August deadline and requirements below come from the organizer announcement supplied by the project
owner. Re-check the live submission form immediately before entry.

| Requirement | Evidence | State |
|---|---|---|
| AI is integral | Agent workflow verifies catalysts, combines PolyDesk and Hyperliquid context, and produces bounded market intelligence | Working |
| Independent X Layer deployment | Live proof registry plus anchored DOS signal and delivery roots | Complete |
| Public working product | Live Render scanner plus listed Lolah ASP and Market Watch service | Working |
| Dedicated X account | Public Lolah product account | Pending verification |
| Submission post tags `@XLayerOfficial` | Final demo post from the dedicated account | Pending |
| Submit by August 21, 23:59 UTC | Organizer submission form | Pending |

## Prize strategy

Submit first for the fixed Hackathon Grant. Do not claim the AI-RWA liquidity prize or volume-based
Launch Grant without independently verifiable qualifying liquidity or trading volume. Lolah's strongest
present case is a working, monetized agent-to-agent intelligence rail with a real safety decision and a
clear reason for using X Layer.

## Claims boundary

Do not claim guaranteed predictions, autonomous execution, 10M USDT of volume, or full coverage of every X
account. The honest demo is stronger:
Lolah caught a real catalyst quickly, checked whether action was possible, refused an unsupported trade,
and delivered useful intelligence to subscribed agents.
