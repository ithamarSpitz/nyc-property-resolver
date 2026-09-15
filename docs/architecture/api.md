<!-- GENERATED CONTEXT MODULE. Source of truth: /ARCHITECTURE.md. -->
<!-- Do not edit independently; regenerate from the final architecture if it changes. -->

## 18. API Surface

### Create or resolve a property

```http
POST /properties
```

Accepts either:

```json
{
  "address": "350 5th Avenue, Manhattan"
}
```

or a unit-aware address such as:

```json
{
  "address": "419 E 84 St Apt 12C"
}
```

or:

```json
{
  "bbl": "1008350041"
}
```

---

### Bulk property registration

```http
POST /properties/bulk
```

Request contract:

```text
maximum BBLs per request: 10,000
default API body limit: 512kb
```

The Express JSON parser is configured explicitly rather than relying on its default request-size limit.

Bulk registration is a dedicated batch path rather than a loop over the single-property resolver.

For BBL-based bulk import:

```text
Input BBL list
      |
      v
Validate + deduplicate
      |
      v
Skip GeoSearch
      |
      v
Split BBLs into bounded chunks
      |
      +-------------------------+
      |                         |
      v                         v
Bulk PLUTO queries      Bulk Building Footprints queries
      |                         |
      +------------+------------+
                   |
                   v
        Resolve condo mappings where needed
                   |
                   v
         Join results in application
                   |
                   v
        Bulk PostgreSQL upserts
```

The bulk path avoids one external request per property. PLUTO, condominium mapping datasets, and Building Footprints are queried in bounded groups using bulk predicates where supported.

This is also the path used for the 10,000-property scale seed/run.

The scale seed is executed from the application container:

```bash
docker compose run --rm worker npm run seed:scale
``` The 10,000 BBLs are obtained directly from PLUTO and do not require geocoding.

---

### Get property

```http
GET /properties/:id
```

Returns the locally stored canonical property and identifiers.

---

### Get property ECB violations

```http
GET /properties/:id/ecb-violations
```

Example query parameters:

```text
openOnly=true
unpaidOnly=true
cursor=...
limit=...
```

Filter semantics are explicit:

```text
openOnly=true
=> ecb_violation_status = 'ACTIVE'

unpaidOnly=true
=> balance_due > 0
```

`openOnly` and `unpaidOnly` are independent filters.

Returns locally stored violations plus coverage and freshness metadata.

Only rows from the last accepted live normalized state with `is_current = true` are returned by default. Run-scoped staging rows are never served.

The endpoint **must** return violations newest first:

```sql
ORDER BY
  issue_date DESC NULLS LAST,
  source_id DESC
```

Cursor pagination for this endpoint uses the same tuple:

```text
(issue_date, source_id)
```

so every next-page query preserves exactly the same ordering semantics.

---

### Query across tracked properties

```http
GET /ecb-violations
```

Supports portfolio-wide scanning patterns without requiring one request per property.

Possible query parameters include:

```text
updatedSince
unpaidOnly
cursor
limit
```

---



### Portfolio Membership Invariant

`ecb_violations.is_current` means the row is current according to the last accepted scan of
that BIN. It does **not** by itself mean that the BIN is still part of the current tracked
property watchlist.

Therefore the portfolio endpoint applies both conditions:

```sql
WHERE e.is_current = true
  AND EXISTS (
      SELECT 1
      FROM property_bins pb
      WHERE pb.bin = e.bin
  )
```

This prevents a violation from a BIN that is no longer associated with any tracked property
from remaining visible forever simply because that BIN will no longer participate in future
negative reconciliation.

The core `/ecb-violations` feed remains violation-level, not property×violation-level. A
violation whose BIN is shared by multiple tracked properties is returned once.

If a future API intentionally expands results per property, that would be a different
contract and its stable ordering/cursor would also include `property_id`.

### Portfolio Query Update Semantics

For:

```http
GET /ecb-violations?updatedSince=<timestamp>
```

`updatedSince` means:

```text
source_row_updated_at > supplied timestamp
```

where:

```text
source_row_updated_at = Socrata :updated_at
```

This is intentionally different from:

```text
issue_date   = when the violation was issued
updated_at   = local database write/promotion time
```

Results using `updatedSince` are ordered by:

```text
source_row_updated_at DESC,
source_id DESC
```

and cursor pagination uses the same ordering key.

This endpoint provides a portfolio-wide feed of source rows that were updated by Socrata after the supplied timestamp. It is not a full deletion/change-event stream; explicit change events remain outside the core assignment scope.


Portfolio-wide ECB queries use the same live-state semantics as property-scoped ECB queries.

By default:

```text
is_current = true
```

Therefore:

```http
GET /ecb-violations
```

returns only violations in the last accepted live state unless a future explicit historical option is added.

With `updatedSince`:

```text
WHERE is_current = true
  AND source_row_updated_at > supplied timestamp
  AND EXISTS current property_bins membership for the violation BIN
```

The core endpoint is not a deletion/history feed.
## 19. Pagination

Large result endpoints are paginated.

Cursor-based pagination is preferred for violation feeds where rows may change between requests.

For the property ECB endpoint, stable ordering is mandatory:

```text
issue_date DESC NULLS LAST
source_id DESC
```

The cursor represents the tuple `(issue_date, source_id)` of the last item in the previous
page. Because `issue_date` may be `NULL`, the next-page predicate follows the explicit
NULL-aware branches below rather than using a plain row-tuple comparator.

Portfolio endpoints may use a different stable ordering when their contract requires it
(for example `source_row_updated_at DESC, source_id DESC` for `updatedSince`).

---


### NULL-Aware Property ECB Keyset Pagination

The property ECB endpoint orders rows by:

```sql
ORDER BY
  issue_date DESC NULLS LAST,
  source_id DESC
```

The implementation must **not** rely on a plain row-tuple comparator such as:

```sql
(issue_date, source_id) < (:cursorDate, :cursorId)
```

because `issue_date` may be `NULL`.

The cursor encodes:

```text
issue_date
source_id
```

and the next-page predicate has two explicit branches.

If the cursor date is non-null:

```sql
WHERE
      issue_date < :cursorDate
   OR (
        issue_date = :cursorDate
        AND source_id < :cursorId
   )
   OR issue_date IS NULL
```

If the cursor date is null:

```sql
WHERE issue_date IS NULL
  AND source_id < :cursorId
```

The same filters (`is_current`, property/BIN membership, `openOnly`, `unpaidOnly`) are
applied before the ordering/cursor predicate as appropriate.

This guarantees traversal from dated rows into the `NULL` tail and continued pagination
within the `NULL` tail.
