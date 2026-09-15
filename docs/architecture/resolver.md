<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

## 5. Property Resolution

### 5.1 Purpose

The property resolver converts either:

- a free-text NYC address, or
- a BBL

into a canonical stored property containing:

- normalized address
- borough
- block
- lot
- BBL
- one or more BINs

A property is resolved once and the resulting identifiers are persisted.

Resolution is idempotent at two levels:

```text
same normalized input
    -> same stored property mapping

same canonical BBL
    -> same canonical property row
```

Single-property resolution and bulk BBL registration share normalization and persistence logic, but the bulk path uses bounded source queries rather than invoking the single-property network flow once per item.


### Address Normalization Rules

Address normalization is conservative. It may normalize casing, repeated whitespace, and supported unit syntax, but it must preserve punctuation that is part of NYC address identity.

In particular, Queens hyphenated house numbers are preserved exactly:

```text
"37-15 82nd Street"
-> house number remains "37-15"
```

The normalizer must not transform this into:

```text
3715
37 15
37–15 interpreted as a numeric range
```

The preserved hyphenated house number is used both for resolver input and for the normalized-input idempotency key.

### 5.2 Resolution Flow

Before any external resolution call, the resolver normalizes the input and checks whether that exact normalized input has already been resolved.

```text
Input
  |
  v
Normalize input
  |
  v
property_resolution_inputs lookup
   |                 |
 found            not found
   |                 |
   v                 v
return stored     resolve externally
property             |
                     v
              persist property
              + input mapping
```

This makes "resolve once" a database-enforced behavior rather than an application convention.

For a normal address:

```text
Original address
      |
      v
Parse and preserve:
- normalized base address
- unit designator, if present
      |
      v
GeoSearch(base address)
      |
      v
Deterministic candidate selection
      |
      v
Canonical parcel/building context
      |
      v
PLUTO
      |
      v
Building Footprints
      |
      v
Valid BIN(s)
      |
      v
Persist property
      |
      v
Persist normalized input -> property mapping
```

GeoSearch candidate selection is deterministic. The resolver accepts only candidates that provide the identifiers required for downstream resolution and does not silently guess when the result is genuinely ambiguous. The selected result metadata and confidence are stored with the resolution-input record.

For a direct BBL input:

```text
Input BBL
   |
   v
Normalize / validate
   |
   v
property_resolution_inputs lookup
   |
   v
Parcel classification
   |
   v
PLUTO / condo mapping / Building Footprints
   |
   v
Canonical property + BINs
   |
   v
Persist input mapping
```

For a condominium unit BBL, the unit parcel and the DOB building parcel are resolved explicitly through NYC Digital Tax Map datasets:

```text
UNIT_BBL
   |
   v
Digital Tax Map: Condominium Units
dataset: eguu-7ie3
lookup: unit_bbl = input BBL
   |
   v
CONDO_BASE_BBL
   |
   +------------------------------+
   |                              |
   v                              v
Digital Tax Map:             Building Footprints
Condominiums                 lookup by BASE_BBL
dataset: p8u6-a6it                |
lookup: condo_base_bbl            v
   |                           BIN(s)
   v
CONDO_BILLING_BBL
   |
   v
Building Footprints
MAPPLUTO_BBL validation /
PLUTO-compatible parcel lookup
```

For an address that contains a unit designator, the resolver does not assume that GeoSearch identifies the condo unit itself.

```text
"419 E 84 St Apt 12C"
        |
        v
extract:
base address = "419 E 84 St"
unit_designation = "12C"
        |
        v
GeoSearch(base address)
        |
        v
resolve building / condo base context
        |
        v
Digital Tax Map: Condominium Units
filter by condo/base context
AND unit_designation = "12C"
        |
        v
exactly one match?
   |             |
  yes            no
   |             |
UNIT_BBL       explicit unresolved /
   |           ambiguous resolution
   v
existing condo-unit BBL flow
```

A condo-unit address must resolve to exactly one unit match. If the unit designator is missing, unmatched, or ambiguous, the resolver fails explicitly rather than selecting an arbitrary unit.

The resolver preserves both the original normalized input and the extracted unit designator so two unit addresses in the same building remain distinct resolution inputs.

### 5.3 Property Identity

BBL is the canonical parcel-level identifier.

BIN represents a building and is the preferred join key for DOB ECB Violations.

A single property may map to multiple BINs, so BINs are stored in a separate relational table rather than in a single property column.

Placeholder BINs are not valid building identifiers for ingestion. Any BIN whose last six digits are `000000` is treated as an unassigned/placeholder BIN and is not inserted into the tracked watchlist.

```text
Resolved BIN
    |
    v
ends with 000000?
   /          \
 yes          no
  |            |
discard      persist
```

A property with no valid BIN is not reported as `CHECKED + empty`. It remains unscannable/not checked with an explicit reason such as `NO_VALID_BIN`.

---


### 5.4 Property Identifier Versioning

`properties.identifier_version` represents the property's effective valid BIN set.

It changes **if and only if** that effective valid BIN set changes.

All writes that can alter `property_bins` go through one application service/repository
operation. Callers do not modify `property_bins` directly.

That operation performs comparison, mutation, version increment, and coverage invalidation
in one database transaction:

```text
BEGIN

lock property row

read current effective valid BIN set
compute next effective valid BIN set

if next_set == current_set:
    leave property_bins unchanged
    leave identifier_version unchanged
    leave coverage unchanged

if next_set != current_set:
    mutate property_bins so it exactly matches next_set

    UPDATE properties
    SET identifier_version = identifier_version + 1

    UPDATE property_dataset_coverage
    SET status = NOT_CHECKED,
        status_reason = IDENTIFIERS_CHANGED
    WHERE property_id = P
      AND dataset = DOB_ECB_VIOLATIONS

COMMIT
```

This transaction is the only supported mutation path for the effective BIN set.

Examples:

```text
add another address/input alias only
-> BIN set unchanged
-> identifier_version unchanged
-> coverage unchanged

re-resolution returns the same effective valid BIN set
-> identifier_version unchanged

effective valid BIN set changes
-> property_bins changes
-> identifier_version increments exactly once
-> current ECB coverage is invalidated atomically
```

When a new ingestion run snapshots Property<->BIN associations, it also stores the current
`identifier_version` as `property_identifier_version`.

Successful coverage publication requires:

```text
current properties.identifier_version
==
snapshot property_identifier_version
```

If the run itself completes successfully but the property identifier set changed after the
snapshot:

```text
run.status = COMPLETED

property coverage:
  remains / becomes NOT_CHECKED
  status_reason = IDENTIFIERS_CHANGED_AFTER_SNAPSHOT
```

The next run snapshots and scans the new BIN set.

Failure publication uses the **same version guard**:

```text
if current identifier_version == snapshot property_identifier_version:
    FAILED / SOURCE_CHANGED may update this property's attempt coverage

if current identifier_version != snapshot property_identifier_version:
    the old run must not overwrite the property's newer coverage state
```

This prevents an older run from publishing either successful or failed coverage for a newer
property-identifier state.

---


### 5.5 Building Footprint Identifier Cross-Check

Building Footprints remains a source for BIN discovery, but non-condo resolution does not
silently trust a footprint-to-lot association when NYC source identifiers disagree.

For a non-condo property, the canonical parcel BBL is established from the resolver/PLUTO
path. Each candidate Building Footprint is validated as follows:

```text
candidate footprint
      |
      v
MAPPLUTO_BBL present?
   |             |
  yes            no
   |             |
   v             v
MAPPLUTO_BBL     BASE_BBL
must equal       must equal
canonical BBL    canonical BBL
      |
      v
mismatch?
   |        |
  yes       no
   |        |
   v        v
explicit   candidate BIN
identifier accepted
conflict
```

If `MAPPLUTO_BBL` is present, it is preferred for the MapPLUTO/parcel cross-check.

For address resolution, when GeoSearch also returns a BIN, that value is treated as
additional corroborating evidence. A direct contradiction between GeoSearch and the
validated footprint mapping is not silently resolved by guessing; the resolver returns an
explicit source/identifier conflict for manual investigation or retry.

This rule does not add another external dependency. It only cross-checks identifiers already
returned by the selected NYC sources.

Condo resolution keeps its separate condo-unit/base/billing flow and its existing
`MAPPLUTO_BBL` validation.
