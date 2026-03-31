# filmTCG

Prototype film gacha / trading-card game with a large TMDB-backed movie pool.

## What this version does

- Uses solid card backs for the stacked overlap view during pack reveals.
- Pulls from weighted rarity odds instead of flat random selection.
- Can load hundreds of real films with posters and backdrops from TMDB.
- Falls back to the built-in sample set if the backend is not running.

## Setup

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env` or export the variables in your shell.
3. Set `TMDB_BEARER_TOKEN` to your TMDB v4 read access token.
4. Start the server:

```bash
npm start
```

5. Open [http://localhost:3001](http://localhost:3001).

## Using a personal computer as the backend

If you do not want Node on this machine:

1. Run `server.js` on your personal computer.
2. Make sure that machine is reachable from your browser.
3. Edit `config.js` and set `backendBase` to that server's URL.

Example:

```js
window.FILMTCG_CONFIG = {
  backendBase: "https://your-personal-server.example.com"
};
```

You can also temporarily override it in the browser with:

```text
index.html?backend=https://your-personal-server.example.com
```

## API endpoints

- `GET /api/health`
- `GET /api/card-pool?limit=720`
- `GET /api/movie-art?title=Jaws`
- `GET /api/image-proxy?url=...`

## Notes

- `server.js` serves both the frontend and the API.
- The live pool endpoint builds a broader set by aggregating several TMDB discover queries, then assigns rarity by rank so rare pulls stay meaningful even with a huge catalog.
- If TMDB is unavailable, the app still runs with the small sample pool in `index.html`.

redeploy trigger

