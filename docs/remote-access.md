# Remote access

Muster listens only on `127.0.0.1`. To use it from your phone or another computer, put a tunnel or private network in front of it. Don't expose the port directly.

Hostnames other than `127.0.0.1` and `localhost` must be listed in the `allowed-hosts` file in the data folder (`~/.local/share/muster` unless you set `MUSTER_DATA_DIR`), one per line, and reached over https. Muster re-reads the file when it changes, so adding a host needs no restart.

## Without a domain: a Cloudflare quick tunnel

A quick tunnel needs no Cloudflare account and no domain. Install `cloudflared` (`brew install cloudflared` on macOS), then:

1. Run `cloudflared tunnel --url http://127.0.0.1:47831`. After a few seconds it prints an address like `https://some-random-words.trycloudflare.com`.
2. Add `some-random-words.trycloudflare.com` to `allowed-hosts`.
3. Set `MUSTER_TRUST_CF_CONNECTING_IP=1` in `.env` (`~/.muster/.env` for an installed Muster) and run `agentmuster restart`. Without it, every visitor through the tunnel counts as one client, so someone guessing passwords would lock you out of signing in too.
4. Open the address on your phone and sign in with your Muster password.

What to know before relying on it:

- **The address changes** every time `cloudflared` starts. Add the new hostname to `allowed-hosts` and open the new address; you can delete the old line.
- **Only your Muster password protects it.** There's no Cloudflare Access in front, and anyone who has the address reaches the sign-in page. Muster throttles sign-in attempts, but keep the in-browser terminal off.
- **It's meant for trying things out.** Cloudflare gives quick tunnels no uptime guarantee and a limit of 200 requests in flight at once.
- **Some live updates may lag.** Cloudflare doesn't stream one kind of response (server-sent events) through quick tunnels. In our tests, replies streamed normally, the agent's questions appeared, and reopening a running thread showed its progress. The updates that use only that stream, such as the files list and the background-work strip, may lag until you reopen the thread.
- **An existing `~/.cloudflared/config.yml` takes over.** If you already run a named tunnel, `cloudflared` uses that config instead of creating a quick tunnel, and its traffic goes to the address you passed. Run the quick tunnel from a folder with no config, for example `HOME=$(mktemp -d) cloudflared tunnel --url http://127.0.0.1:47831`, or use the named tunnel.

## With a domain: a named tunnel and Cloudflare Access

This is the setup for everyday use: the address stays the same, and Cloudflare checks your email before a request reaches Muster. You need a domain whose DNS is on Cloudflare (a free account is enough).

1. Create a named tunnel with `cloudflared` that routes one hostname, such as `muster.example.com`, to `http://127.0.0.1:47831`. Run it as a service so it starts at login.
2. In Cloudflare Zero Trust, add an Access application for that hostname that allows only your email.
3. Add the hostname to `allowed-hosts`.
4. Set `MUSTER_TRUST_CF_CONNECTING_IP=1` in `.env` and run `agentmuster restart`, so sign-in throttling counts each visitor separately.
5. Optionally set `MUSTER_ACCESS_TEAM`, `MUSTER_ACCESS_AUD` and `MUSTER_ACCESS_EMAILS`. A request with a valid Access token for one of those emails then signs in without the app password.

## Tailscale or another private network

Tailscale or another private network should work the same way, though only Cloudflare has been tested: add the address you'll use to `allowed-hosts`, and reach it over https (for example with `tailscale serve`).

## Either way

Muster's own sign-in still applies, and anyone who gets past it can act as you on that computer (see `SECURITY.md`). On a phone, add Muster to the Home Screen so it opens full screen like an app.

The installer already starts Muster at login. If you run it from a checkout instead, adapt `ops/muster.plist.example` to your paths and copy it to `~/Library/LaunchAgents`.
