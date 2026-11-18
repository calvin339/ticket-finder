# Ticket Finder

Know when tickets go on sale for the artists you love, near you.

**Site:** https://calvin339.github.io/ticket-finder/

- Each visitor sets their own location and artists (saved only in their browser) and presses **Search**.
- Search runs in a Cloudflare Worker (`worker/`), which reads Bay Area venue websites and, if a key is set,
  the Ticketmaster Discovery API, then returns shows with presale / on-sale times.
- Artist suggestions and photos come from Deezer's public catalog (through the worker); typo fixes from MusicBrainz.

## Venues
Listed in `worker/src/venues.js`. Supported site types:
- `livenation`: Live Nation venue sites (full presale and on-sale times, presale codes)
- `ticketweb`: TicketWeb's venue plugin (on-sale dates)
- `anotherplanet`: Another Planet venue sites (presale dates, sometimes times)
- `seetickets`: SeeTickets' venue plugin (exact on-sale times, read from the show's own page)
- `billja`: Café du Nord / Swedish American Hall (exact presale and on-sale times from the show's page)
- `bottomofthehill`: Bottom of the Hill's calendar (shows and ticket links)

For `seetickets` and `billja`, the worker opens a show's own page only when it matches a searched artist (up to 12 per search).

Not supported yet: Rickshaw Stop (blocks scripts), The Warfield and The Regency (pages built by JavaScript; Ticketmaster covers the Warfield once a key is set), and Squarespace / tixr venues (Great Northern, Thee Parkside, El Rio, Public Works, 1015 Folsom).

To add a venue that uses one of these site types, add a line to `venues.js` and push.

## Deploying
Pushing changes under `worker/` deploys the worker automatically (`.github/workflows/deploy-worker.yml`).
Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and optionally `TM_API_KEY`
(Ticketmaster Discovery API key). After adding `TM_API_KEY`, re-run the "Deploy search worker" workflow.
