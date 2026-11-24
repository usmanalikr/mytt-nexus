# Connecting Claude to the brain

The MCP service is an Edge Function at:

```
https://<project-ref>.supabase.co/functions/v1/brain-mcp
```

It has four tools — `search`, `get`, `decisions` and `timeline` — and returns
only what your tier allows. It never says that anything exists at a tier you
cannot see, so an item you may not read looks exactly like one that is not
there.

## Before it will work

1. **Apply the migration**, and give yourself a row in `brain.members`:

   ```sql
   insert into brain.members (user_id, tier, is_owner)
   values ('<your auth.users id>', 1, true);
   ```

   Without a row you read nothing. That is the intended behaviour for someone
   who has signed in but has not been added (AC7), and it looks identical to an
   empty brain, so check this first if every answer comes back empty.

2. **Expose the schemas.** Supabase dashboard → API settings → exposed
   schemas: add `brain`. PostgREST serves no schema that is not on that list,
   and without it every query here returns a 404 about the schema not
   existing. Exposing it weakens nothing — row level security still decides
   every row.

3. **Turn on the OAuth server.** Dashboard → Authentication → OAuth Server.
   Enable dynamic client registration, or register a client by hand for each
   place you want to connect from.

4. **Deploy:**

   ```bash
   supabase functions deploy brain-mcp
   ```

## Connecting

### claude.ai

Settings → Connectors → Add custom connector, and give it the URL above. The
sign-in happens in the browser: Claude finds the authorisation server through
`/.well-known/oauth-protected-resource`, which this function serves.

### Claude Code

```bash
claude mcp add --transport http mytt-brain https://<project-ref>.supabase.co/functions/v1/brain-mcp
```

Then `/mcp` in a session to sign in.

### Claude Desktop

Settings → Connectors → Add custom connector, same URL.

## What it does not do

- **No writing.** Nothing here changes the brain. Publishing a flagged item is
  `brain review`, deliberately: the one place a person is required.
- **No private store.** `brain_private` is the owner's alone and is not served
  here at any tier (AC8). The digest is read with `brain digest`.
- **No ranking yet.** Full-text search over `brain.items`, ordered by date
  rather than by relevance — ranking through PostgREST needs an RPC, and a few
  hundred items are found without it. Worth revisiting when the brain is
  bigger.

## What it records

Every call writes one line to `brain.access_log`: who asked, which tool, how
many rows came back, and when. Not the results, and **not the query** — a
search term can carry a person's name, so only a SHA-256 of it is stored. The
hash still tells an audit that the same search ran twice without repeating what
was searched for (AC15).

Only the owner can read that log.
