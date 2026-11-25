# Remote access

Muster listens only on `127.0.0.1`. To use it from your phone or another computer, put an authenticated proxy in front of it. Don't expose the port directly.

**Cloudflare Tunnel and Cloudflare Access** is one tested setup:

1. Create a named tunnel with `cloudflared` that routes one hostname, such as `muster.example.com`, to `http://127.0.0.1:47831`.
2. In Cloudflare Zero Trust, add an Access application for that hostname that allows only your email.
3. Add the hostname to the `allowed-hosts` file in the data folder (`~/.local/share/muster` unless you set `MUSTER_DATA_DIR`), one per line. Muster re-reads that file when it changes.
4. Set `MUSTER_TRUST_CF_CONNECTING_IP=1` in `.env` (`~/.muster/.env` for an installed Muster) and run `agentmuster restart`, so sign-in throttling counts each visitor separately.
5. Optionally set `MUSTER_ACCESS_TEAM`, `MUSTER_ACCESS_AUD` and `MUSTER_ACCESS_EMAILS`. A request with a valid Access token for one of those emails then signs in without the app password.

**Tailscale** or another private network should work the same way, though only Cloudflare has been tested: add the address you'll use to `allowed-hosts`. A hostname other than `127.0.0.1` or `localhost` has to be reached over https.

Either way, Muster's own sign-in still applies, and anyone who gets past both can act as you on that computer (see `SECURITY.md`).

The installer already starts Muster at login. If you run it from a checkout instead, adapt `ops/muster.plist.example` to your paths and copy it to `~/Library/LaunchAgents`.
