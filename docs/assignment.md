# **Take-Home Assignment — NYC Open Data: Property Resolver \+ ECB Violations Pipeline & API**

**Company:** Alefy (alefytech.com) · **Role:** Engineer, platform team  
**Effort:** about 3 working days, spread over up to one week. We care about the thinking and the trade-offs, not the hours. If you run out of time, write down what you would do next and stop.  
**Deliverable:** a repo we can run locally with one command, plus a 45-minute walkthrough.

## **1\. Context**

Alefy is a risk-intelligence platform for US real-estate portfolios. Lenders and funds give us the properties behind their deals; we monitor them after closing and alert when something changes: a new lien, a mortgage assignment, an ownership transfer, a foreclosure filing.  
Most of our property signals come from paid vendors that mirror county records. NYC has a second, very rich signal layer that is public, free and machine-readable through [NYC Open Data](https://data.cityofnewyork.us/) (a Socrata portal). Today one of our executives pulls this data by hand. We want it in the platform, programmatically, on a schedule, behind our own API.  
**One constraint drives the whole design: we will not call the Socrata API at request time in production.** It is throttled, it is slow, and it goes down. We need our own copy of the data, refreshed on a schedule, served by an API we control.  
**Scale sets the bar.** A single customer portfolio is 10,000 to 20,000 properties, and we re-scan every one of them weekly. A property is resolved once; after that we hold its identifiers and scan by them. Anything that costs one network call per property per run needs a number next to it.  
Every NYC data point we add will follow the same two-step shape:

> 1. **Resolve the property** — turn an address (or a BBL) into the canonical parcel and building keys NYC uses.  
> 2. **Serve one data point about it** from our own store, through its own endpoint.

Your assignment is to build that shape end to end for the first data point.

## **2\. What to build**

A small service with three parts.

### **2.1 Property resolver**

Given a free-text NYC address, or a 10-digit BBL, resolve and persist a property record containing at least: normalized address, borough, block, lot, BBL, and the BIN(s) of the building(s) on the lot. Resolution must be reproducible: the same input always yields the same property, and adding the same property twice does not create two records.  
Suggested sources (free, no key): [NYC GeoSearch](https://geosearch.planninglabs.nyc/docs/) for address → BBL/BIN, [PLUTO](https://data.cityofnewyork.us/resource/64uk-42ks.json) (64uk-42ks) for BBL → parcel attributes, [Building Footprints](https://data.cityofnewyork.us/resource/5zhs-2jue.json) (5zhs-2jue, fields base\_bbl, bin) for BBL → BINs. Use what you find works; say why in the README.

### **2.2 Ingestion pipeline — DOB ECB Violations**

The data point is **DOB ECB Violations**, dataset [6bgk-3dad](https://data.cityofnewyork.us/resource/6bgk-3dad.json). These are DOB violations that went to a hearing and carry a fine. balance\_due \> 0 means money is owed to the city; unpaid amounts eventually become liens. About 1.8 million rows citywide.  
Build a pipeline that:

> * Runs **on a schedule**. The interval is a configuration value (env var or config file) with a sensible default. Changing it must not require touching code. Provide a way to trigger a run manually (CLI command or admin endpoint) so we do not have to wait during the walkthrough.  
> * Is **idempotent**. Running it twice in a row does not duplicate rows. Re-running after a failure is safe.  
> * Stores **raw and normalized** data separately enough that you can re-derive the normalized form when you discover a parsing mistake.  
> * Records **provenance**: when we fetched, and what the source said its own last-update time was.  
> * Is **bounded**: every loop, retry and batch has an explicit upper limit. A partial failure is recorded, not hidden.  
> * **Handles 10,000 properties per run**, and is designed for 20,000. Do the arithmetic in DESIGN.md: Socrata calls per run, wall time at a rate the source will tolerate, rows stored. A run that dies halfway resumes where it stopped instead of restarting.

**The central design decision is yours.** Two reasonable strategies:

> * **A. Watchlist pull.** Each run fetches ECB rows only for the properties we track, keyed by BIN.  
> * **B. Dataset mirror.** Maintain a local copy of the whole dataset, refreshed incrementally (the dataset exposes a :updated\_at system field), and join to properties locally.

Pick one, implement it, and in DESIGN.md explain what you rejected and at what point you would switch, using 10,000 and 20,000 tracked properties and one versus ten NYC data points as your reference points.

### **2.3 Query API**

HTTP, JSON. No authentication for this assignment. Required behaviours:

| Endpoint (names are yours) | Behaviour |
| :---- | :---- |
| Create / resolve property | Accepts { address } or { bbl }, resolves, persists, returns the property with its keys. Idempotent. |
| Get property | Returns the stored property record. |
| Get property ECB violations | Returns violations **from your store, never from Socrata**. Pagination. At least these filters: open-only, unpaid-only (balance\_due \> 0). Sorted newest first. |
| Add properties in bulk | A batch endpoint or an import command, so 10,000 properties can be registered without 10,000 individual calls. |
| List results across properties | A paginated endpoint a scanning process can read without one call per property: for example violations updated since a timestamp, or properties with an unpaid balance. |
| Trigger ingestion (or CLI) | Runs the pipeline now. |

The violations response must carry **freshness and coverage metadata** so a caller can tell the difference between:

> * **checked and empty** — we looked, there are no violations;  
> * **not checked yet** — the pipeline has not run for this property;  
> * **fetch failed** — the last run errored for this property, with when and why.

An empty list with no explanation is the wrong answer.

## **3\. What to hand in**

A git repo (link, or a zip) containing:

> 1. **The code.** TypeScript on Node 22 is our stack and is preferred. Python is acceptable. Postgres is preferred for storage; if you choose something else, say how it would move to Postgres.  
> 2. **docker-compose.yml** (or equivalent) so that one command starts the database, the API and the scheduler on a clean machine. We will run it on a laptop with Docker and nothing else installed.  
> 3. **README.md** — one page: how to run, how to change the interval, how to trigger a run, the endpoints with one example request and response each.  
> 4. **DESIGN.md** — one to two pages: your ingestion strategy and why; the storage layout (tables, keys, raw vs normalized); how idempotency and partial failure work; how freshness and coverage are represented; what you would build next (second data point, change alerts) and what you would refactor first.  
> 5. **A seed file** with 5–8 real NYC addresses you chose. Include: 350 5th Avenue, Manhattan (Empire State Building, our shared reference case), one Queens address with a hyphenated house number (the 37-15 82nd Street form), one condo unit, one small 2–3 family house, and at least one property that has an unpaid ECB balance.  
> 6. **A 10,000-property scale run.** Seed 10,000 properties by BBL straight from PLUTO (64uk-42ks; every lot in one or two community districts is an easy pick). You do not need to geocode 10,000 addresses. Run the pipeline against them.  
> 7. **A run log** — the console output of a baseline run and an idempotent second run on your address seed, plus the summary of the 10,000-property run: wall time, Socrata calls made, rows stored, failures.  
> 8. **Tests** for the behaviours that matter: address normalization, resolver idempotency, ingestion upsert, the coverage metadata states. A handful of good behaviour tests beats broad coverage.

## **4\. Things that cost people a day (read first)**

> * **BBL** \= borough (1 digit) \+ block (5 digits) \+ lot (4 digits), zero-padded: 1-00835-0041 → 1008350041\. Boroughs: 1 Manhattan, 2 Bronx, 3 Brooklyn, 4 Queens, 5 Staten Island.  
> * **BIN** is a 7-digit building id (first digit \= borough). Most DOB datasets, including ECB, are keyed by BIN. One lot can carry several BINs. BINs ending in 000000 are placeholders for lots with no building on file.  
> * **Key padding is not consistent, even inside one dataset.** In the ECB dataset the same lot appears both as 0041 and 00041\. Filtering on block/lot with one padding silently drops rows. Verify with a $limit=1 probe and a $group query before trusting any zero result; prefer BIN as the join key.  
> * **Condos.** Unit lots are 1001+; the building's billing lot is 7501+. DOB records attach to the building's BIN, not the unit lot. Resolve a condo unit to the building BIN or you will see nothing.  
> * **Queens hyphenated house numbers** (37-15) are real house numbers, not ranges. Keep the hyphen.  
> * **Numbers are strings, and dates are YYYYMMDD.** balance\_due is not always non-negative. Look at what the data actually contains before you sum it.  
> * **Socrata API basics:** https://data.cityofnewyork.us/resource/\<id\>.json?\<SoQL\>. [SoQL docs](https://dev.socrata.com/docs/queries/). Unauthenticated calls are throttled; a free [app token](https://data.cityofnewyork.us/profile/edit/developer_settings) lifts the limit. Keep the token out of the repo.  
> * **Bulk queries.** SoQL takes $where=bin in ('1015862','1015863',...), $limit up to 50,000 per page with $offset (always paired with $order), and count(1) with $group. Ten thousand single-row calls is the wrong shape. GeoSearch is a geocoder, not a bulk service: resolve once, store the identifiers, scan by them.  
> * **Manual verification:** the [BIS Property Profile](https://a810-bisweb.nyc.gov/bisweb/bsqpm01.jsp) is the canonical human view. Spot-check at least two of your properties against it and note in the README whether your numbers match.

## **5\. Out of scope**

Authentication and API keys, a UI, deployment, other NYC datasets, the full Alefy signal taxonomy, and integrating with our systems. Change detection between runs (alerts) is a stretch goal, not a requirement.  
**Stretch, only if you have time:** emit change events between runs (new violation, balance changed); add a second data point endpoint (for example HPD violations, wvxf-dwi5) to show the pattern generalizes; an OpenAPI description of your API.

## **6\. How we evaluate**

| Area | What we look for |
| :---- | :---- |
| **It runs** | One command, clean machine, the reference address resolves and its violations come back from your store. |
| **Correctness** | Resolver handles the traps in §4. Counts for the reference address match ours. Zero results are explained. |
| **Pipeline design** | The strategy choice is argued with numbers. Idempotent, bounded, provenance recorded, partial failure visible. |
| **API design** | Serves from the store. Pagination and filters work. Freshness and coverage metadata are unambiguous. |
| **Scale** | The 10,000-property run completes in sensible time with batched calls, pacing, and resumable progress. The arithmetic for 20,000 is in DESIGN.md. |
| **Production thinking** | Config, not code, for operational settings. Secrets out of the repo. Clear logs. |
| **Communication** | Another engineer could pick up the repo and add the second data point without asking you. |
| **Code hygiene** | Small, readable, tested where it matters, no dead code. |

We are not looking for production-grade completeness. We are looking for correct judgement about what matters first.

## **7\. Logistics**

Send the repo link to the address in the email. We will schedule a 45-minute walkthrough: 10 minutes for you to run it and show the API, 10 minutes on DESIGN.md, then discussion. Questions during the assignment are welcome. A good question is a positive signal.