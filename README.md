# On-Sale Radar

Know when tickets go on sale for the artists you love, near you.

- **Live site:** GitHub Pages (Settings → Pages)
- Each visitor sets their own location and artists; it's all stored in their browser.
- Shows come from JamBase (and Ticketmaster / SeatGeek if keys are added in `index.html`).
- **On-sale times** for the artists in `watchlist.json` are found by a daily web search
  (see `CHECK.md`) and saved to `onsales.json`, which the site reads.

## Change the watch list
Edit `watchlist.json` (artists, location, radius) here on GitHub, or ask Claude to do it.
