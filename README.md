# Ticket Finder

Know when tickets go on sale for the artists you love, near you.

**Site:** https://calvin339.github.io/ticket-finder/

- Each visitor sets their own location and artists (saved only in their browser) and presses **Search**.
- Search runs in a Cloudflare Worker (`worker/`), which reads Bay Area venue websites and, if a key is set,
  the Ticketmaster Discovery API, then returns shows with presale / on-sale times.
- Artist suggestions and photos come from Deezer's public catalog (through the worker); typo fixes from MusicBrainz.

## Venues
Listed in `worker/src/venues.js`. Three site types are supported:
- `livenation`: Live Nation venue sites (full presale and on-sale times, presale codes)
- `ticketweb`: TicketWeb's venue plugin (on-sale dates)
- `anotherplanet`: Another Planet venue sites (presale dates, sometimes times)

To add a venue that uses one of these site types, add a line to `venues.js` and push.

## Deploying
Pushing changes under `worker/` deploys the worker automatically (`.github/workflows/deploy-worker.yml`).
Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and optionally `TM_API_KEY`
(Ticketmaster Discovery API key). After adding `TM_API_KEY`, re-run the "Deploy search worker" workflow.
