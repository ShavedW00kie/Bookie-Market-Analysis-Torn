# Torn Bookie Market Analyst — 0.1.0 verification release

**This is a runnable, self-contained verification build, not the completed automatic Bookie analyst.** It makes no bets. Automatic Torn event extraction, cross-market recommendations, inline badges, and actual-bet accounting are deliberately inactive because authenticated Torn event markup and full settlement mappings have not been verified.

The delivered independent core is implemented and tested. The end-to-end production request remains blocked on the small samples described below. The build contains no invented Torn event selectors or private Torn API requests.

## Start here: supply the evidence needed to finish

1. Install `Torn Bookie Market Analyst.user.js` in Tampermonkey, or paste the complete `.user.js.txt` contents into a new script. Do not install both copies.
2. Open Torn Bookie while signed in. The panel appears above the page content. No API key is needed for evidence collection.
3. Expand **Needed to finish automatic Torn integration**. Click **Select event card / bet row**, then click a participant label in one Bookie event. The selection click is intercepted so it does not activate a native control. Avoid touching wager buttons; select text instead.
4. Use **Parent element** until the preview includes one complete event card/market, not the whole page. The collector refuses a selection containing the panel or more than 500 descendants.
5. Review the preview. Input values, URLs, scripts, media, most attributes, known keys, and email addresses are omitted/redacted. Arbitrary personal text can still remain; review it yourself. Click **Save reviewed sample**.
6. Repeat for an event-detail market and an existing bet row. Rename the resulting files to distinguish list, detail, and existing bet.
7. Attach those three samples and a screenshot showing the same displayed odds and a hypothetical stake/potential-profit display. Do not submit a real bet for testing. Do not send cookies, API keys, passwords, HAR exports, or the full HTML page.

If the panel does not mount in TornPDA, use desktop Tampermonkey for the samples and report the device/browser plus any visible error. Mobile execution and cross-origin transport are not yet validated.

## Implemented now

| Capability | Status |
|---|---|
| Self-contained collapsible panel; gear usable while collapsed | Implemented; visual/browser validation pending |
| The Odds API sports, events, selected h2h odds | Implemented against documented schema; needs your free key for live validation |
| OddsPapi fixtures, dictionary, full-time 1X2 odds | Implemented; limited to one unambiguous matching dictionary market; needs free key |
| Polymarket binary market and both outcome books | Implemented public readers; numeric market ID required; not automatically mapped to Torn |
| Decimal, American, fractional conversions | Implemented/tested |
| Complete-outcome normalization, median consensus, source freshness and deduplication | Implemented/tested; external reference only in current UI |
| Strict event/rule comparison engine | Implemented/tested; not connected to Torn without evidence |
| Hypothetical gross return, profit, break-even, EV and ROI | Implemented; user inputs only; unrounded mathematical amounts |
| Local paper bets with fixed odds/probability snapshot | Implemented; local device timestamps, not tamper-proof |
| Paper settlement, ROI, drawdown, Brier score | Implemented/tested mathematical core; void/push excluded from turnover and Brier score |
| Settings/key management, diagnostics, donation controls | Implemented; UI validation pending |
| Automatic Torn extraction, accepted-odds parsing and inline annotations | Blocked on authenticated samples |
| Automated sport-wide discovery/matching, per-event manual mapping, trend plots | Not implemented in this verification release |
| Actual account exposure, real P/L, same-team correlation | Not implemented; journal warnings only detect identical manual event labels |
| Weighted consensus / Kelly sizing / bet placement | Not implemented; fixed-stake advisory approach only |

All 24 requested sport labels are retained in source for later integration. This is not a claim of complete API coverage. Popular is not a sport. Current OddsPapi parsing is restricted to full-time 1X2; other sports/esports market schemas remain a coverage gap. The Odds API competition list is loaded dynamically. Polymarket is a standalone contract reference, not a team/opponent translator.

## Optional provider setup

Use only an ongoing free plan. Provider access is disabled by default; enabling it does not cause requests until a button is pressed.

- **The Odds API:** register through https://the-odds-api.com/ and select Starter FREE. Save the emailed key in Settings; enable the provider; Test saved key. Load sports, load events, and read only an event relevant to the Torn screen. This build requests h2h from one region (`us`), with a maximum nominal cost of one credit per odds request. Some sports will have no US-bookmaker coverage. Sports/events discovery costs zero provider credits.
- **OddsPapi:** https://oddspapi.io/us/sign-up advertises 250 monthly requests. Save/test the key, enable the provider, enter a tournament ID from its documentation, then load fixtures. The first odds read may cost two requests (dictionary + odds); the dictionary is cached for seven days. The account check is unmetered. Returned account credentials are discarded before display/storage.
- **Polymarket:** no key for the implemented reads. Enable it and supply a numeric *market* ID from the provider, not an event slug. Up to three reads retrieve metadata and both books. Only active binary order-book markets are accepted. No wallet or trading code exists.

Free-key signup is performed by you. The script does not enroll, upgrade, pay, or accept provider agreements on your behalf. A data reader may fail because of your plan, network, region, CORS, schema changes, or provider restrictions; it will display a failure rather than bypassing it.

## Interpretation

External reference probability uses proportional margin removal on a complete sportsbook outcome set, then a median across underlying sources. Outcome-wise medians are renormalized when needed. Duplicate source names are collapsed; cross-provider name aliases need verification before enabling combined cross-provider consensus. This release presents each selected provider independently.

Bookmaker settlement equivalence is not established by the odds feed. The reference display is consequently not a Torn recommendation. A two-outcome estimate may be conditional on a decisive result if a tie refunds. The script never equates a prediction contract's “No” with the opposing team's win.

Polymarket estimates use both bid/ask sides with positive size. Empty/crossed/wide books or incoherent two-outcome midpoints are rejected. Displayed depth is shares, and volume is explicitly not a bettor percentage. Unknown fields are not inferred.

The hypothetical calculator uses `gross = stake × decimal odds` and `profit = stake × (decimal odds − 1)`. With a manually supplied binary win probability, EV is `stake × (p × decimal odds − 1)`. Those formulas assume full stake return within decimal odds and no push/partial settlement. They are not applied to actual Torn wagers in this release. Torn payout rounding has not been verified.

Favorite is distinct from positive expected value; even a high-probability outcome can lose money in expectation at sufficiently short odds. The code tests this distinction. No positive-value badge is issued for an unverified Torn match.

## Architecture and performance

The release contains pure analysis functions, independent provider parsers, request/storage services, supplied modules, and a UI. No Torn API key is requested: the supplied codex and usage guide contain no Bookie selection. No affected Torn request is implemented, so no undocumented alternative or codex override is introduced.

A direct-body MutationObserver reattaches only the script's own panel; no event-row selectors are guessed. Hashchange/popstate clear old references; route generation prevents late responses from updating a different view. The panel is anchored at the start of body until the Bookie content anchor is verified. It can sit above Torn's header; precise content placement is pending.

Network requests are serialized and deduplicated. Browser Web Locks coordinate tabs on the same origin; without this capability, API reads are disabled with an explicit reason. This limitation may affect older TornPDA WebViews. Manager storage does not imply cross-browser coordination. Other tools using the same API key are outside the local budget; provider quota headers/account checks remain relevant.

Requests use explicit host/path allowlists. Modern and classic GM request/storage APIs are supported where present. Plain fetch is only attempted as a CORS request with omitted credentials. It is not a CORS bypass. GM transport, Web Locks, and storage behavior require live Tampermonkey/TornPDA testing.

Manual refresh avoids exhausting free quotas. Cache lifetime: odds/books 60 seconds, event lists 5 minutes, sports 1 day, OddsPapi dictionary 7 days. Empty responses are cached as negative results. Cache keys never include secrets. At most 40 cache entries retain payloads; evicted values are cleared. Account responses are never cached. Each retry reserves credits before sending. 429 pauses requests using Retry-After, or ten minutes when absent; 401/403 pause until credentials change or one hour passes. There are at most two server-error retries. Hidden pages do not initiate requests.

Local request budgets use UTC calendar months and default to 100/50/1,000 for The Odds API/OddsPapi/Polymarket. These are script limits, not provider entitlements. The aggregate providers' free caps are also enforced locally at 500/250. The provider's own reset date and account-wide usage can differ.

Timers are used only for network timeouts/backoff, reference expiration, and download URL cleanup. No timer waits for elements. The supplied debugger attaches its observer on demand when opened.

## Privacy and backup

Credentials persist only through available GM manager storage when requested. Otherwise they remain in memory until the page is unloaded. No credentials go into localStorage. Settings, caches, quotas, and the paper journal can use localStorage when GM storage is unavailable; those non-secret values are accessible to Torn-origin code. Manager storage is not claimed to be encrypted.

No Torn cookies or login credentials are sent by the script to external APIs. Provider keys go only to their documented HTTPS host. Debug output omits keys, authorization values and private account responses. There is no analytics or automatic upload.

Backup exports only whitelisted settings and paper entries. It excludes API keys, raw market caches, DOM samples and logs. Imported entries retain labels but are marked unverified and excluded from the manual prediction Brier score. Import deduplicates IDs and never overwrites an existing journal record. Provider toggles are disabled after import.

Journal entries are capped at 1,000; the table shows the newest 50. Paper bets cannot be recorded retrospectively or settled before their entered start time. The entry's manually recorded odds do not change after saving. This is not a reliable record of all actual Torn bets.

## Module changes

- Embedded debugger 1.0.2 → 1.0.3 adaptation: fixed JavaScript's illegal strict directive/default-parameter combination by moving the default assignment into the function. Reduced the embedded log character budget to approximately 240 Ki characters, added central credential redaction, and deferred its observer until opened. Preserved log/info/warn/error/copy/toggle/clear API and original BSD notice.
- Embedded Donation UI 1.4 → 1.4.1 adaptation: converted standalone startup into an internally scoped class factory; mounted within settings; removed automatic floating startup; delegated lifecycle to the host; used an identified style node to prevent duplicates; namespaced animation classes/keyframes. Preserved coffee artwork, animation, gleam, reduced-motion styling, `bittick1c` coffee link, and ThaWookie `[2954173]` tip instructions. Improved contrast of the green tip button inside this panel.
- Uploaded source files have not been overwritten. Adaptations are embedded in the new release only.

## Validation and reproducibility

Run from the extracted source package:

```
node --test tests/*.test.cjs
```

57 automated tests passed on Node.js 24.19.0. They use **synthetic fixtures and mocked transport**, not live provider account responses. Tests cover odds math, negative-EV favorites, draw/void handling, strict matching, duplicates, series/map differences, stale data, malformed schemas, quotas, backoff, hidden-page cancellation, key handling and module integration assertions. The full assembled userscript passes `node --check`.

Not executed: live Torn extraction, real-provider account calls, browser visual QA, React behavior on authenticated Bookie, Tampermonkey installation, or TornPDA compatibility. No profitability test or claim is made. See `PROVIDER_AUDIT.md` for research and `VALIDATION.txt` for actual test output.

## Next release gate

Use the three sanitized samples to implement exact Torn parsing and native row placement. Verify stake/return conventions using the screenshot. Establish external market rule mappings for supported competitions, starting with narrow, auditable coverage. Then connect the tested matching engine, add source comparisons beside outcomes, and test in your actual desktop/mobile environments. Unknown settlement rules continue to block recommendations.

## Changelog

0.1.0 — First verification release. Independent core, three permitted data-reader integrations, settings, paper journal, evidence collector, embedded module fixes, and 57 tests. Automatic Torn integration remains pending evidence.

License: BSD-3-Clause. Copyright (c) 2026 ShavedW00kie. Full notices are in the source and LICENSE.
