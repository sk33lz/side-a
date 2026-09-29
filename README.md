# Side A

Side A is a small static web app for collecting and sharing music links. Playlists stay in the current browser unless you share or export one.

## Run locally

Install [Node.js](https://nodejs.org/) 22 or newer, then run:

```sh
npm install
npm run dev
```

`npm run dev` applies the D1 migration to Wrangler's local database, builds the app, and starts Cloudflare Pages locally at `http://localhost:8788`. Your private playlists are saved in browser storage; live shared playlists use the local D1 database.

YouTube playlist importing uses the YouTube Data API. Add a Cloudflare Pages secret named `GOOGLE_API_KEY`. For local Wrangler development, create a `.dev.vars` file containing `GOOGLE_API_KEY=your-key`; that file should remain uncommitted.

Optional account sign-in and cloud libraries use Clerk. Add `VITE_CLERK_PUBLISHABLE_KEY` as a Pages environment variable and `CLERK_SECRET_KEY` as an encrypted Pages secret. Enable Google and email verification-code sign-in in Clerk. The browser loads Clerk's official hosted sign-in client only when a publishable key is configured; the secret key is used only by Pages Functions to verify session tokens.

For frontend-only work without Pages Functions, use `npm run dev:vite` (live sharing will not work in this mode).

## Build and preview

```sh
npm run build
npm run preview
```

The production site is written to `dist/`.

## Deploy

Deploy to Cloudflare Pages for live sharing. Sign in with `npx wrangler login`, create a D1 database named `side-a-playlists` with `npx wrangler d1 create side-a-playlists`, and copy its database ID into `wrangler.jsonc`. Apply the migration with `npm run db:migrate:remote`. Then run `npm run deploy`; create the Pages project first if Wrangler asks. The D1 binding must be named `DB`. The Functions in `functions/` provide the live sharing API.

The included `netlify.toml` still supports the static app on Netlify, but Netlify won't run the Cloudflare Pages Functions; live D1 sharing requires deploying on Cloudflare Pages.

## Share a playlist

Choose **Share playlist** to create a live link backed by D1. The owner can edit and reorder the playlist, and the recipient sees the latest version when they open or refresh the link. The recipient can save an editable copy. Playlist JSON files can also be exported and imported. Older snapshot links remain supported.

After sharing, choose **Recovery link** to copy a separate private owner URL. Opening it on a new browser restores the playlist, edit authority, and its connection to recipient feedback. The recovery URL contains the owner token in its fragment, which is not sent to the server during navigation; anyone who receives that URL can edit the playlist, so it must not be sent to recipients.

The edit credential stays in the owner's browser and is stored as a hash in D1. Anyone with the share link can view that playlist, but only the owner browser that created it can update the shared record.

When signed in, playlists are also saved to the owner's D1-backed library. Existing private recovery credentials are automatically claimed by that account, allowing the owner to edit live playlists and see feedback after signing in on another device. Signing out switches back to the browser's separate guest library, preventing another account on the same browser from inheriting the signed-in library.

Track links are organized locally, while public YouTube playlists can be expanded through the server-side YouTube Data API integration. Playlist imports preserve the YouTube order and include available titles, channels, artwork, and durations. Private YouTube playlists require OAuth and are not supported.
