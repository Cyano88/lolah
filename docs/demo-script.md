# Lolah 100-second BuildX demo

## 0-12 seconds: the market problem

“A listing headline can move a token before most agents understand whether the source is real, whether
the move is already crowded, or whether their venue even supports the asset. Lolah turns that uncertainty
into verified, cross-market intelligence.”

Show the official Upbit DOS notice and its KRW, BTC, and USDT market support.

## 12-30 seconds: earliest verified detection

“Our dedicated Seoul feed delivered the official listing to Lolah in 315 milliseconds. Lolah validates
the Upbit notice, parses the asset and quote markets, rejects stale revisions, and deduplicates replays.”

Show the sanitized receipt time and latency. Do not show the provider key or private feed URL.

## 30-50 seconds: cross-market reasoning

“A headline alone is not a trade. Lolah asks PolyDesk whether prediction-market consensus exists and
checks Hyperliquid for a matching perpetual market and current market context.”

Show the result: no matching DOS Hyperliquid perpetual.

## 50-66 seconds: safety is the feature

“Lolah did not invent a market or place an order. It returned a no-trade alert with the reason. Every
current signal is intelligence-only and explicitly disables execution.”

Show `executionAllowed: false` and the alert’s no-trade explanation.

## 66-82 seconds: paid agent distribution

“Lolah Market Watch is a live OKX agent service: three days free, then 1 USDT per month. The dispatcher
uses the official active-subscription list for Lolah’s exact identity, then sends only through OKX’s
recipient-eligibility checked path.”

Show the listed service, a sanitized eligible-subscriber audit, delivery completion, and the buyer’s
acknowledgement.

## 82-96 seconds: why X Layer

“We keep alerts and subscribers private, but make the service accountable. Lolah batches signal and
delivery commitments into Merkle roots and anchors those proofs on X Layer. Partners can verify when
intelligence and delivery existed without exposing the intelligence itself.”

Show the deployed contract and the two explorer transactions. Do not record this segment until the
contract and proof batches are actually deployed.

## 96-100 seconds: close

“Lolah is the trust layer between crypto catalysts, PolyDesk probability, Hyperliquid liquidity, and
paid agents—fast enough to matter, careful enough to say no, and verifiable on X Layer.”

End on the Lolah name, dedicated X handle, public service URL, and `@XLayerOfficial`.
