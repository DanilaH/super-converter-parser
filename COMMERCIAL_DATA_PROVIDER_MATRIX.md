# Commercial Data Provider Matrix

Status: planning/audit document for V3 Commercial Evidence Extension.

This matrix exists to prevent provider-driven architecture and accidental dependence on expensive or automation-hostile sources.

The V3 baseline is **free-first**: a useful commercial-evidence run must not require a paid data subscription.

Provider status can change over time. Re-audit access, quotas, terms, and API availability before implementing a production adapter.

## 1. Integration modes

```text
AUTO
  official/permission-compatible automated collection is suitable

LICENSED_AUTO
  automated use requires a paid/licensed source and is optional

MANUAL_IMPORT
  useful evidence, but automated collection is unclear, restricted, unstable, or not worth maintaining

FIRST_PARTY_IMPORT
  data belongs to us and should initially enter through explicit CSV/JSON import

DO_NOT_USE
  known access/terms/technical constraints make the source unsuitable for the intended pipeline

UNKNOWN
  source requires a dedicated audit before use
```

## 2. Cost classes

```text
FREE_BASELINE
  no recurring paid subscription should be required for the intended use

FREE_WITH_ACCOUNT
  no recurring data subscription expected, but developer/account credentials are required

OPTIONAL_PAID
  potentially useful, but must not be required by the baseline pipeline

VARIABLE
  depends on licensing, account status, quotas, or provider-specific approval

UNKNOWN
  not yet audited
```

## 3. Current provider matrix

| Provider/source | Primary commercial evidence | Official API / structured access | Auth / approval | Cost class | Historical | Recommended mode | V3 baseline? | Notes |
|---|---|---|---|---|---|---|---|---|
| Existing Google SERP collection | commercial query SERPs, paid-result observations where visible, commercial competitors | existing runner collection path | existing runner setup | FREE_BASELINE | snapshot only unless stored over time | AUTO | yes | `ads not observed` must never mean `no ads exist`; SERP ad visibility can vary by geo/session/time |
| Existing Surfer evidence | demand/CPC proxy and related language | existing runner path | existing setup | FREE_BASELINE | limited | AUTO | yes | commercial proxy only; CPC is not proof of sales |
| Competitor/provider public websites | pricing, plans, services, CTAs, trial/free, quote/book/buy flows | ordinary public web pages | none for public pages | FREE_BASELINE | current snapshot | AUTO where permission-compatible; otherwise MANUAL_IMPORT | yes | likely highest-value new source; respect robots/terms/policies and existing SSRF/safety contracts |
| JSON-LD / structured page data | Product/Offer/SoftwareApplication price, currency, rating, review count, availability | embedded structured data | none | FREE_BASELINE | current snapshot | AUTO | yes | deterministic extraction preferred; may be stale/incomplete |
| Sitemap/internal-link discovery | pricing/service/product URL discovery | public site structures | none | FREE_BASELINE | current snapshot | AUTO where permission-compatible | yes | discovery source, not commercial proof by itself |
| Checkout/payment-provider fingerprints | payment infrastructure presence | public frontend/network/page evidence | none | FREE_BASELINE | current snapshot | AUTO where permission-compatible | yes | Stripe/Paddle/PayPal/etc. fingerprint != transaction |
| Common Crawl | historical URL/page presence, old pricing/service pages | public corpus and indexes | no AWS account required for direct HTTP access | FREE_BASELINE | strong | AUTO | yes | valuable historical source; archive presence != adoption or revenue |
| Wayback / archive sources | pricing history, positioning history, first-seen paid pages | archive interfaces/APIs vary | varies | FREE_BASELINE / VARIABLE | strong | AUTO only after source-specific audit; otherwise MANUAL_IMPORT | likely | existing runner already uses Wayback-related evidence; commercial-history automation terms/rate limits must be audited separately |
| RDAP | domain registration context | official/public RDAP ecosystem | usually none | FREE_BASELINE | registration history only | AUTO | supporting | domain age != product age; combine with page/history evidence |
| Google Ads Keyword Planning API | search volume, competition/index, bid ranges, average CPC | official Google Ads API | Ads account, OAuth, developer token, access level/permissible use | FREE_WITH_ACCOUNT / VARIABLE | monthly historical metrics | optional AUTO after access audit | no | high-value optional source; do not make V3 depend on Google Ads account/API approval |
| Google Ads Transparency Center | advertiser identity, ad creatives/history/location context | public transparency product; stable general-purpose automation API not assumed | public UI; automation path requires audit | FREE_BASELINE | some ad history | MANUAL_IMPORT / UNKNOWN | no | useful advertiser-level corroboration; not a keyword-market API |
| Etsy Open API v3 | listings/offers/prices, marketplace adoption proxies where exposed | official API | API key; OAuth for scoped endpoints | FREE_WITH_ACCOUNT | provider-dependent | AUTO after terms/field audit | niche-specific | official API has QPD/QPS limits; never assume every desired transaction metric is exposed |
| eBay Buy/Browse APIs | listings/products/prices/sellers | official API | developer credentials; Buy APIs carry additional licensing/approval constraints | VARIABLE | provider-dependent | UNKNOWN / AUTO only after approval audit | no | current docs list Browse API quotas and additional license requirements for Buy APIs |
| Upwork API | jobs, budgets, service-market demand if accessible | official API | restrictive key eligibility; current help requires identity verification and >= $25k lifetime earnings/spend; personal/internal use only | VARIABLE | limited | DO_NOT_USE as baseline | no | unsuitable as a required source; revisit only if account eligibility and intended use fit current terms |
| GitHub API/public repositories | OSS adoption, longevity, releases, commercial-edition links | official API | token useful for quota | FREE_WITH_ACCOUNT | strong activity history | AUTO | niche-specific | adoption/workflow evidence, not willingness-to-pay or revenue proof |
| npm / package registries | package adoption, downloads where official, versions, release cadence | official/public registry APIs vary | usually low friction | FREE_BASELINE / FREE_WITH_ACCOUNT | strong | AUTO per registry | niche-specific | useful for developer-tool ecosystems; downloads != paid adoption |
| App/extension/plugin marketplaces | listings, installs/users/reviews/pricing where exposed | ecosystem-specific | varies | VARIABLE | varies | provider-specific | niche-specific | never assume competitor install/user metrics are available across ecosystems |
| WordPress plugin ecosystem | free installs/reviews + commercial upgrade adjacency | ecosystem-specific APIs/pages | varies | FREE_BASELINE / FREE_WITH_ACCOUNT | useful | provider-specific | niche-specific | strong training ecosystem for free -> paid adjacency; requires dedicated audit before adapter |
| API marketplaces | paid API existence, pricing tiers, usage models | marketplace-specific | varies | VARIABLE | varies | provider-specific | niche-specific | useful for API/data opportunities, but terms and competitor fields vary substantially |
| Public review platforms | review count/rating/customer language | official APIs often limited or licensed | varies | VARIABLE | useful | MANUAL_IMPORT unless licensed/official competitor access exists | no | reviews are adoption proxies, not exact customer or paid-user counts |
| Product Hunt | launch timing, votes/comments/positioning | API/access rules change | account/token may be required | VARIABLE | launch history | MANUAL_IMPORT / UNKNOWN | no | not direct paid evidence; audit current commercial-use/automation terms before adapter |
| Founder/company public disclosures | claimed revenue/customers, pricing history, launch history | unstructured public sources | none / varies | FREE_BASELINE | potentially strong | MANUAL_RESEARCH / MANUAL_IMPORT | no | preserve `FIRST_PARTY_CLAIMED` vs `THIRD_PARTY_REPORTED`; self-reporting and survivorship bias matter |
| Business-for-sale/acquisition marketplaces | revenue/MRR/profit/traffic/business age where disclosed | platform-specific | often account/paywall/terms restrictions | VARIABLE / OPTIONAL_PAID | listing snapshot | MANUAL_IMPORT unless explicitly licensed | no | potentially strong evidence but not worth risky scraping; provenance is critical |
| GSC export for our projects | actual queries, impressions, clicks, pages | first-party Google data | our account | FREE_WITH_ACCOUNT | strong | FIRST_PARTY_IMPORT initially | optional but high value | key feedback loop once a project has traction |
| Product analytics export | actual tool use, paths, events | our chosen analytics | our account | VARIABLE | strong | FIRST_PARTY_IMPORT initially | optional | collect only metrics tied to a research hypothesis |
| Leads / checkout / payments export | real leads, checkout starts, purchases, subscriptions, refunds | our systems | our account | VARIABLE | strongest | FIRST_PARTY_IMPORT initially | optional | strongest commercial evidence for us; no need for direct Stripe/payment-provider integration at V3 start |
| Paid SEO/commercial suites (Ahrefs/Semrush/Similarweb/DataForSEO/etc.) | traffic/keyword/competitor estimates and paid-market enrichment | licensed APIs/products | subscription/API credentials | OPTIONAL_PAID | often strong | LICENSED_AUTO only when justified | no | never foundational; add only to close a demonstrated evidence gap |

## 4. Current free-first baseline

The current expected zero-subscription baseline is:

```text
existing runner SEO data
    + public Google SERP observations
    + competitor/provider websites
    + structured data
    + pricing/service/CTA/checkout evidence
    + Common Crawl / existing historical sources
    + one or more official/public ecosystem adapters where the niche supports them
```

This should already support useful answers such as:

```text
Are paid offers present?
How many independent providers did we observe?
What prices and billing models are publicly advertised?
Are ads observed?
Is marketplace/adoption evidence present?
Have paid offers persisted historically?
```

It will generally not support honest answers to:

```text
What is competitor X's real MRR?
What is competitor X's conversion rate?
What is their CAC/LTV/churn?
How many exact paying customers do they have?
```

unless those values are legitimately disclosed or available from a source that explicitly exposes them.

## 5. Provider audit checklist

Before implementing any new adapter, record:

```text
provider
source URL / documentation
data category
official API?
auth required?
account requirements
approval requirements
coverage
competitor-data availability
historical coverage
pricing / recurring cost
QPS / QPD / quota
pagination / result caps
commercial-use terms
automation terms
robots/policy constraints
raw evidence available?
provenance class
expected evidence strength
recommended integration mode
failure / missing semantics
maintenance risk
```

Do not infer permissions from technical accessibility.

`API exists` does not automatically mean `our intended automated use is permitted`.

## 6. Evidence-strength notes by source

### Public pricing/service page

Strength:

```text
weak-to-medium commercial evidence
```

Proves an offer is publicly presented.

Does not prove customers buy it.

### Checkout/payment fingerprint

Strength:

```text
medium supporting evidence
```

Shows commercial infrastructure is present.

Does not prove transaction volume.

### Paid advertising observed

Strength:

```text
medium supporting evidence
```

Shows an advertiser is willing to enter an auction / run ads.

Does not prove positive unit economics.

### Reviews / installs / users

Strength:

```text
medium-to-strong adoption proxy, depending on source semantics
```

Do not convert reviews into exact customer counts.

### Official sold/transaction counters

Strength:

```text
strong where source semantics are explicit
```

Preserve whether the metric is item-, seller-, shop-, or platform-level.

### Historical paid-offer persistence

Strength:

```text
medium-to-strong supporting evidence
```

A paid offer surviving for years is stronger than a pricing page first observed today, but still is not revenue proof.

### Our own purchase/subscription data

Strength:

```text
strongest first-party evidence
```

It directly proves that our traffic/workflow produced money.

## 7. Current external-access findings to retain

These findings were checked against official documentation on 2026-08-30 and should be re-verified before implementation:

### Google Ads API

Official Keyword Planning historical metrics expose search volume, competition, competition index, and bid ranges. Google Ads API access requires credentials and a developer token with an access level/permissible-use model. Google states that the API itself is free to use, but access/review/account constraints make it unsuitable as a mandatory baseline dependency.

Official docs:

```text
https://developers.google.com/google-ads/api/docs/keyword-planning/generate-historical-metrics
https://developers.google.com/google-ads/api/docs/api-policy/access-levels
https://developers.google.com/google-ads/api/docs/api-policy/developer-token
```

### Google Ads Transparency Center

Google exposes advertiser and ad information through its transparency system for verified advertisers. Treat it as useful public corroborating evidence, but do not assume a stable general-purpose keyword research API.

Official policy/help reference:

```text
https://support.google.com/adspolicy/answer/9703665
```

### Etsy Open API v3

Etsy provides an official API. An API key is required for requests, OAuth is additionally required for scoped/private operations, and rate limits are application-based QPS/QPD quotas visible in the Developer Portal.

Official docs:

```text
https://developers.etsy.com/documentation/essentials/authentication/
https://developers.etsy.com/documentation/essentials/rate-limits/
```

### eBay APIs

eBay documents default API call limits; Browse API documentation currently lists 5,000 calls/day and Buy APIs are marked as requiring an additional license. Treat this as optional until production access/licensing is confirmed for the exact intended use.

Official docs:

```text
https://developer.ebay.com/develop/get-started/api-call-limits
```

### Upwork API

Current Upwork help requires, among other conditions, identity verification and at least $25,000 lifetime earnings/spend to request an API key; it also states API access is for personal/internal use and not supported for commercial use. Therefore Upwork must not be a baseline V3 dependency.

Official docs:

```text
https://support.upwork.com/hc/en-us/articles/115015857647-How-to-request-an-API-key-from-Upwork
```

### Common Crawl

Common Crawl data is accessible directly over HTTP; its official getting-started documentation states that an AWS account is not required for this access path. This makes it especially attractive for free-first historical commercial evidence.

Official docs:

```text
https://commoncrawl.org/get-started
```

## 8. Next audit priorities

Before V3 code implementation, deepen the audit in this order:

```text
1. competitor pricing/service-page automation constraints
2. current SERP ad-observation reliability in the existing collector
3. Common Crawl index/WARC retrieval cost and practical query strategy
4. one marketplace aligned with an actual candidate niche
5. Google Ads access only if existing CPC/bid evidence proves insufficient
6. first-party GSC import format once real project traction is available
```

Do not broaden the matrix simply to maximize provider count. Add sources only when they answer a concrete evidence question.