# V3 Commercial Evidence Extension

Status: planning source of truth for the next major runner iteration.

This document defines the intended direction of V3. It is deliberately separate from the current V2.1 operational documentation so future commercial research does not leak into current runner contracts prematurely.

## 1. Core purpose

V3 is not a product generator, SaaS planner, startup advisor, or monetization recommendation engine.

The runner remains a personal research/data-acquisition tool. Its job is to collect, normalize, preserve, and expose evidence that helps the operator decide where economic opportunity may exist.

The central question changes from only:

```text
Is there SEO demand and can a weak entrant rank?
```

to:

```text
Around this observed demand / user job, is there public evidence that money is actually being spent?
Where does that money appear to flow?
What paid offers, prices, advertisers, marketplaces, and transaction proxies can we observe?
```

The runner must stop at evidence collection and evidence packaging.

It must not automatically decide:

```text
what product to build
what service to sell
what price we should charge
whether to BUILD / WATCH / REJECT
whether to run a smoke test
whether to create a SaaS, agency, marketplace, affiliate site, or other business model
```

Those remain human analysis decisions outside the runner.

## 2. Strategic model

V3 should combine three evidence families:

```text
SEO EVIDENCE
    demand
    CPC
    SERP accessibility
    entrant proof
    domain strength / age
    site structure

COMMERCIAL EVIDENCE
    commercial-adjacent queries
    paid competitors / service providers
    paid offers
    pricing
    checkout / purchase-flow evidence
    advertising evidence
    marketplace evidence
    adoption / transaction proxies
    historical persistence

FIRST-PARTY TRACTION EVIDENCE (when available)
    real search queries
    impressions
    clicks
    landing pages
    product/tool usage
    leads
    checkout starts
    purchases / subscriptions / refunds
```

These are evidence layers, not scores and not recommendations.

## 3. The important distinction: query demand != money

A keyword can have strong informational demand without a meaningful paid market.

Conversely, a free informational query can sit next to a valuable commercial ecosystem.

Example:

```text
microphone test
```

The query itself may be satisfied by a free browser tool, while adjacent paid activity may exist around:

```text
microphone setup service
OBS audio setup
streaming audio consultation
microphone troubleshooting
microphone repair
remote audio configuration
hardware recommendations / affiliate commerce
```

Therefore V3 must research the commercial ecosystem around an intent, not merely label the original keyword as `commercial=true` or `commercial=false`.

## 4. Commercial query expansion

Commercial query expansion is a first-class V3 capability.

For each meaningful cluster / future `job_cluster`, generate a separate commercial-adjacent query set.

Typical modifiers may include:

```text
buy
price
pricing
cost
service
hire
consultant
agency
specialist
repair
setup
installation
audit
optimization
subscription
software
premium
pro
quote
book
near me
```

Domain-specific modifiers should be supported where useful.

Example:

```text
microphone test
    -> microphone setup service
    -> microphone troubleshooting service
    -> OBS audio setup service
    -> streaming audio consultant
    -> microphone repair cost
```

Another existing research example:

```text
CSV compare
    -> CSV comparison software
    -> CSV compare API
    -> bulk CSV compare
    -> batch CSV compare
    -> automate CSV comparison
    -> CSV reconciliation software
    -> CSV comparison report
    -> <competitor> pricing
    -> <competitor> alternative
```

### Hard rule

Commercial-adjacent keywords are a separate evidence stream.

Do not silently merge their volume into the original SEO cluster and do not treat lexical similarity alone as proof that they represent the same user job.

Relations should be supported by evidence such as:

```text
SERP overlap
competitor overlap
workflow evidence
human interpretation
```

## 5. Revised V3 evidence blocks

The previous planning model proposed blocks H-N. Preserve the block architecture, but revise the scope so the runner remains an evidence engine rather than a product-validation engine.

Current V2.1 evidence remains conceptually separate.

### H. Commercial intent evidence

Possible facts:

```text
commercial-adjacent queries observed
commercial query demand where available
CPC / bid evidence
transactional modifiers
commercial organic-result share
ads observed in sampled SERPs
shopping / marketplace presence where visible
```

Absence of an observed ad is not proof that no advertising market exists.

Use observation semantics such as:

```text
ads_observed = true
ads_observed = false
collection_status = complete | partial | unavailable
```

Never translate `not observed` into `does not exist`.

### I. Paid participant / offer evidence

Identify commercial actors around the job:

```text
software vendors
service providers
consultants
agencies
marketplace sellers
retail / ecommerce actors
affiliate/comparison publishers
API providers
```

Possible facts:

```text
paid offer observed
service page observed
pricing page observed
book / quote / buy CTA observed
free plan observed
trial observed
enterprise offer observed
```

### J. Pricing and monetization mechanics

Capture observable pricing facts without inventing economics.

Possible fields:

```text
offer name
provider
price
currency
billing model
billing period
minimum advertised price
maximum advertised price
one-time vs recurring
free plan
free trial
usage limits
quote-only
enterprise-only
source URL
observed at
```

Useful aggregation may include observed ranges and distributions, but they must remain grounded in the underlying offers.

Example:

```text
observed paid offers: 17
advertised entry-price range: $20-$299
median observed entry price: $69
models:
  one-off: ...
  hourly: ...
  subscription: ...
  quote-only: ...
```

This is observed market evidence, not TAM, revenue, ARPU, or LTV.

### K. Paid adoption / transaction evidence

This block answers a stronger question:

```text
Do we observe evidence that the paid offers are actually used / bought?
```

Possible evidence:

```text
marketplace review counts
visible sold / transaction counters where officially exposed
visible install/user counts where officially exposed
customer case studies
long-lived paid plans
repeat paid advertising
credible public revenue/customer disclosures
business-for-sale metrics where legally/contractually available
first-party purchases when they belong to us
```

The runner must preserve the difference between:

```text
listing exists
pricing exists
checkout exists
ad exists
reviews exist
visible transaction metric exists
verified own purchase exists
```

They are not equivalent.

### L. Commercial adjacency around the user job

The old concept was `Free -> Paid workflow adjacency`.

V3 should use the broader concept:

```text
observed user job / intent
    -> adjacent paid job / paid market
```

This avoids assuming that our future implementation must itself become the paid product.

Example:

```text
microphone test
    -> microphone troubleshooting service
    -> streaming audio setup service
    -> repair
    -> hardware purchase
```

For data tooling:

```text
compare CSV
    -> bulk comparison
    -> scheduled reconciliation
    -> API
    -> reporting
```

The relation can still be represented by a `WorkflowEdge`, but the runner must not turn that relation into an automatic product recommendation.

### M. Commercial ecosystem structure

The old draft used `Delivery / operational complexity`, which pulled the runner toward evaluating what we should build.

Replace that core responsibility with observable market structure:

```text
service-heavy vs software-heavy
one-off vs recurring
local vs remote
self-serve vs quote-led
marketplace-mediated vs direct
consumer vs business-facing evidence
standardized package vs bespoke service
API/data model present
affiliate/ecommerce model present
```

If operational complexity of existing providers is directly observable, it may be stored as evidence. Do not estimate our own implementation or delivery complexity inside this block.

### N. First-party traction / commercial evidence

The previous draft called this `Own offer-test evidence`.

That is too product-oriented for the runner.

V3 should instead accept existing first-party facts when they genuinely exist:

```text
GSC queries
impressions
clicks
landing pages
analytics events
tool usage
CTA exposure/clicks
pricing visits
lead events
checkout starts
purchases
subscriptions
refunds
repeat paid usage
```

Initial integration should prefer:

```text
CSV / JSON import
```

Do not build payment-provider infrastructure into the runner until real usage justifies it.

First-party data is not a requirement for external commercial research. It is an optional, higher-strength evidence stream.

## 6. Own SEO traction as a commercial-research trigger

A major V3 use case is to feed real traction from already-launched SEO projects back into research.

Desired loop:

```text
SEO project starts ranking
    -> collect real query / landing-page footprint
    -> identify which problems actually bring users
    -> run commercial query expansion around those problems
    -> inspect paid offers / prices / advertisers / marketplaces
    -> package evidence for human analysis
```

This is stronger than only researching hypothetical seed keywords because the project has already demonstrated that Google can deliver us relevant traffic.

Example question for human analysis:

```text
Google already sends us users with these exact problems.
For which of those problems does the surrounding market show credible evidence of paid activity?
```

The runner should provide the evidence needed to answer that question, not answer it with an opaque recommendation.

## 7. Evidence strength hierarchy

Commercial evidence must preserve strength and provenance.

A useful conceptual ladder is:

```text
WEAK
commercial-adjacent query exists
CPC / bid evidence exists
service / pricing page exists

MEDIUM
multiple paid offers exist
explicit prices exist
checkout / booking / quote flow exists
paid ads are observed

STRONGER
paid offers persist historically
many independent sellers/providers exist
reviews / installs / users are visible
repeat advertising is observed
credible customer/revenue claims exist

STRONG
official marketplace transaction/sold metrics where exposed
verified acquisition/business metrics where legitimately available

STRONGEST FOR US
our own observed lead -> checkout -> purchase/subscription/refund data
```

This is not a numeric score contract.

Different evidence types should remain independently inspectable.

## 8. Hard semantic rules

The following must remain true:

```text
pricing page != successful business
checkout provider fingerprint != transaction
marketplace listing != sale
review != exact paid user
CPC != profit
ad observed != profitable advertising
ad not observed != no advertising market
high search volume != willingness to pay
domain age != product age
traffic estimate != revenue
missing != zero
unknown != negative evidence
```

Never estimate competitor MRR as:

```text
traffic * assumed conversion * price
```

and present it as fact.

Unknown is a valid and important output.

## 9. Fact != interpretation != decision

This existing planned separation becomes even more important in V3.

### Fact

```text
competitor = ExampleCo
offer = Audio Setup
price = 99
currency = USD
billing_model = one_time
checkout_observed = true
source = example.com/pricing
observed_at = ...
```

### Interpretation

```text
multiple providers appear to monetize this problem
```

### Decision

```text
we should investigate offering a service
```

The runner owns facts and may produce transparent evidence summaries.

Interpretations must remain visibly derived.

Business/product decisions remain human.

## 10. `EvidenceFact`

New commercial providers should emit typed evidence rather than mutate current CSV schemas unpredictably.

Concept:

```text
EvidenceFact
------------
subject
metric
value
unit
scope
source
sourceUrl
provider
observedAt
collectionStatus
reliability
```

Example:

```text
subject = competitor:foo.com
metric = lowest_paid_price
value = 29
unit = USD/month
source = first-party pricing page
sourceUrl = https://foo.com/pricing
provider = PricingPageProvider
reliability = FIRST_PARTY_OBSERVED
```

Potential reliability classes:

```text
FIRST_PARTY_OBSERVED
OFFICIAL_API
FIRST_PARTY_CLAIMED
THIRD_PARTY_REPORTED
THIRD_PARTY_ESTIMATE
PUBLIC_MARKETPLACE
MANUAL_RESEARCH
OWN_BEHAVIOR
INFERRED
UNKNOWN
```

Do not erase provenance distinctions during aggregation.

## 11. `WorkflowEdge`

Keep the abstraction, but redefine it as a research relationship rather than a product recommendation.

Concept:

```text
WorkflowEdge
------------
fromJob
toJob
edgeType
evidence[]
strength
humanStatus
```

Possible edge types:

```text
scale
batch
automation
monitoring
API
reporting
collaboration
persistence
data
service
repair
consultation
commerce
workflow-expansion
```

Human review remains necessary for questions such as:

```text
is this actually the same workflow?
is the buyer/persona related?
is the adjacency natural or merely lexical?
is the paid job really solving the same underlying problem?
```

## 12. Collection architecture

Expected commercial collection flow:

```text
existing SEO cluster / job_cluster
        |
        +--> commercial query expansion
        |       -> commercial SERPs
        |       -> commercial actors
        |
        +--> competitor / provider discovery
        |       -> pricing / plans / services
        |       -> structured data
        |       -> CTA / checkout / booking fingerprints
        |
        +--> marketplace adapters
        |       -> offers / prices
        |       -> reviews / adoption / transactions where exposed
        |
        +--> advertising evidence
        |       -> observed search ads
        |       -> advertiser-level transparency evidence where accessible
        |
        +--> historical evidence
        |       -> old pricing / service pages
        |       -> offer persistence
        |
        +--> optional first-party imports
                -> GSC / analytics / leads / payments

all providers
        -> EvidenceFact[]
        -> durable storage
        -> evidence projections / summaries
        -> Research Library
        -> human analysis
```

## 13. Competitor first-party collection

Competitor/provider websites are likely the highest-value free source after SERP discovery.

Useful discovery targets include:

```text
/pricing
/plans
/services
/service
/features
/product
/shop
/products
/hire
/consulting
/consultation
/book
/quote
/checkout
/get-started
/api
/enterprise
```

Discovery should also use:

```text
sitemap
navigation
internal links
structured data
public embedded product JSON
```

Possible observations:

```text
pricing page exists
service page exists
paid plan exists
one-time offer exists
subscription exists
quote-only flow exists
free plan exists
trial exists
booking exists
checkout exists
payment-provider fingerprint exists
```

A payment-provider fingerprint is evidence that payment infrastructure is present, not proof that a transaction occurred.

## 14. Structured data

Where present, prefer deterministic extraction before free-form interpretation.

Useful sources include:

```text
JSON-LD
Product
Offer
SoftwareApplication
meta tags
public embedded product JSON
```

Potential facts:

```text
product / service name
price
currency
availability
rating
review count
plan / offer name
```

Structured data may be stale or incomplete, so retain the original source and observation timestamp.

## 15. Advertising evidence

Separate ordinary SEO CPC proxies from observed advertising activity.

Potential evidence streams:

```text
keyword CPC / bid ranges / advertiser competition
ads observed in sampled SERPs
advertiser identities where visible
advertiser-level history / creatives from public transparency tools
```

Google Ads Keyword Planning is a potentially useful optional provider because historical metrics can expose search volume, competition, competition index, and bid ranges. It requires Google Ads API credentials / developer-token access and should not be a mandatory V3 dependency.

Google Ads Transparency Center can provide advertiser-level public evidence. Treat it as an optional/manual-or-future-adapter source unless a stable permission-compatible automation path is confirmed.

## 16. Marketplace evidence

Marketplace data can be stronger than a standalone pricing page because some ecosystems expose additional adoption or transaction proxies.

Possible facts:

```text
offer count
seller/provider count
advertised prices
price distribution
ratings
review counts
installs/users where officially exposed
sold/transaction counts where officially exposed
listing age
seller age / activity where exposed
```

Do not assume every marketplace exposes every field.

Each marketplace must have its own provider adapter and source audit.

## 17. Historical commercial evidence

Historical persistence is an important strengthening signal.

Potential questions:

```text
How long has this paid offer existed?
Has the pricing page persisted for years?
Has the provider increased prices?
Did a free offer become paid?
Has the service category existed continuously?
```

Useful sources may include:

```text
Common Crawl
Wayback / archive sources
release notes
changelogs
founder/company announcements
```

Example:

```text
pricing first observed: 2022
pricing observed again: 2023, 2024, 2025, 2026
price moved: $29 -> $39 -> $49
```

This is stronger evidence of a persistent commercial offer than a pricing page first seen today, while still not proving revenue.

## 18. Free-first policy

V3 should be designed so the first useful commercial-evidence implementation does not require a paid data subscription.

Preferred order:

```text
existing runner data
-> public SERP observations
-> public competitor/provider websites
-> structured data
-> public / official marketplace APIs where accessible
-> historical public corpora
-> public advertising transparency evidence
-> optional first-party imports
```

Paid providers should be added only when a specific evidence gap is demonstrated and the expected value justifies the cost.

Do not begin with an architecture that assumes subscriptions to Ahrefs, Semrush, Similarweb, DataForSEO, or another commercial provider.

## 19. Progressive enrichment

Progressive enrichment remains mandatory, but the old funnel must be corrected.

Old planning ended with:

```text
1-3
-> smoke test / own data
```

That is no longer a runner responsibility.

Correct direction:

```text
large discovery set
    -> cheap SEO discovery
    -> viable clusters / jobs
    -> targeted commercial query expansion
    -> commercial SERP + actor discovery
    -> pricing / offer / marketplace / history enrichment
    -> evidence-rich research datasets
    -> human analysis
```

Exact gate counts are operational tuning parameters, not product requirements.

Progressive enrichment exists to control:

```text
runtime
rate limits
API cost
human review
data volume
```

## 20. Provider strategy

Conceptual adapters:

```text
existing:
  GoogleProvider
  SurferProvider
  RDAPProvider
  WaybackProvider
  CommonCrawlProvider

future commercial:
  CommercialQueryProvider
  CommercialSerpEvidenceProvider
  PricingPageProvider
  StructuredOfferProvider
  MarketplaceProvider
  AdvertisingEvidenceProvider
  HistoricalCommercialProvider
  ReviewImportProvider
  FirstPartyImportProvider
```

Providers emit typed evidence.

Aggregation must not know provider-specific HTML/API quirks.

## 21. Automation policy

Use the existing conservative policy:

```text
official API / permission-compatible first-party public source
    -> automate when justified

licensed paid source
    -> licensed adapter only when worth the cost

public site with unclear automation permission
    -> manual/import or do not automate

source forbids intended automation
    -> do not automate

data unavailable
    -> unknown
```

No stealth/proxy bypass.

The companion `COMMERCIAL_DATA_PROVIDER_MATRIX.md` is the source-audit surface for provider-specific access, pricing, rate limits, and automation constraints.

## 22. Research Library relationship

V3 commercial facts should reuse the existing durable research lineage rather than create a second independent runner/library.

Principles remain:

```text
SQLite durable truth -> derived CSV/JSON/MD/ZIP
immutable research generations
explicit provenance
explicit collection status
missing != zero
unknown != negative evidence
```

Commercial evidence should be attached to stable research/job entities and remain queryable across generations.

Do not dump dozens of unrelated commercial columns into current `keywords.csv`.

## 23. Final projection

A compact human-facing projection may look like:

```yaml
job: microphone-troubleshooting

seo:
  demand: observed
  accessibility: ...
  entrant_proof: ...

commercial:
  adjacent_queries: 34
  paid_offers_observed: 21
  independent_providers_observed: 14
  advertised_price_range: "$20-$400"
  median_observed_entry_price: "$75"
  checkout_evidence: observed
  advertising_evidence: observed
  marketplace_evidence: partial
  historical_paid_offer_evidence: observed

transaction_evidence:
  strength: partial
  facts: [...]

first_party_traction:
  available: true
  facts: [...]

unknowns:
  - actual competitor revenue
  - actual competitor conversion rate
  - actual CAC
  - actual LTV
```

The projection must remain traceable to raw evidence facts.

It must not end with:

```text
Suggested product: ...
Suggested service: ...
Recommended price: ...
BUILD
```

## 24. Explicit non-goals

V3 does not require:

```text
Runner SaaS accounts
Runner billing
team collaboration UI
heavy dashboard
AI business-plan generation
automatic product ideation
automatic service ideation
automatic pricing recommendation
automatic BUILD/WATCH/REJECT
fake-door tooling
preorder/deposit tooling
smoke-test orchestration
mandatory payment-provider integrations
mandatory paid SEO/commercial-data subscriptions
```

These may exist elsewhere in the broader human workflow, but they are not V3 runner responsibilities.

## 25. Implementation sequence

Updated sequence:

```text
1. keep using/stabilizing V2.1 on real research
2. record actual operator friction and missing commercial questions
3. finalize V3 commercial data model
4. finalize EvidenceFact
5. finalize WorkflowEdge semantics
6. finalize revised blocks H-N
7. complete COMMERCIAL_DATA_PROVIDER_MATRIX.md audit
8. define progressive-enrichment gates
9. implement the smallest high-value free-first provider set
10. validate on known commercial ecosystems
11. compare output against real human research
12. expand provider coverage only where evidence gaps remain
```

Do not begin by scraping five new sources at once.

## 26. First implementation bias

The first V3 slice should favor sources with high evidence value, low marginal cost, and clear provenance.

Likely starting order:

```text
1. commercial query expansion
2. competitor pricing/service page discovery
3. structured offer extraction
4. commercial SERP observations
5. historical persistence via existing/archive sources
6. one high-value marketplace adapter where the niche supports it
7. optional first-party GSC/analytics import
```

This ordering is not yet an implementation contract; provider audit may change it.

## 27. Success criterion

V3 succeeds when a research run can answer, with inspectable evidence:

```text
There is SEO demand here.

Around that demand we observed these paid actors,
these offers,
these prices,
these advertising signals,
these marketplace/adoption/transaction proxies,
and this historical persistence.

These facts are strong / weak / missing for explicitly stated reasons.

Now a human can decide whether there is something worth pursuing.
```

That is the desired boundary of the runner.