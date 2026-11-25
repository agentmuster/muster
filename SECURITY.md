# Security

## Reporting a vulnerability

Report it privately through **Security → Report a vulnerability** on the GitHub repository. Please don't open a public issue. Include what you found, how to reproduce it, and the version or commit.

## What Muster protects, and what it doesn't

Muster is a single-owner app. One person runs it on their own computer and signs in to it. There are no other users or tenants.

- **Network:** the server listens only on loopback (`127.0.0.1`). Reaching it from another device needs a proxy or tunnel you set up, such as Cloudflare Tunnel with Cloudflare Access, or Tailscale.
- **Sign-in:** every request except the sign-in page needs a signed-in session or a verified Cloudflare Access token. Host and Origin headers are checked on every request, and sign-in attempts are throttled.
- **Desktop app:** the menu-bar app signs in with `desktop-key`, a random key Muster keeps in its data folder (owner-only, mode 600). Whoever can read that file can sign in, and could equally read the rest of the data folder. Delete the file and restart Muster to replace the key, which signs the desktop app out.
- **The agent:** Muster runs Pi as you, with your files, tools, extensions and accounts. Treat anyone who can sign in to Muster as someone who can act as you on that computer.
- **Terminal:** the in-browser terminal gives a shell as you. It's off until you turn it on, and `MUSTER_TERMINAL_DISABLED=1` keeps it off.
- **Modules** are code you choose to run, like Pi extensions. Each call runs in its own process, with a trimmed environment and a list of hosts it may contact. That limits mistakes; it does not stop a module written to do harm. Install only modules you trust.
- **Data at rest:** threads, the session index, uploads and module secrets are stored in Muster's data folder with owner-only permissions. They are not encrypted by Muster, so use full-disk encryption.
- **What leaves the computer:** model requests go to the provider configured in Pi, and they can include excerpts of earlier sessions and Inbox messages. Browser voice typing may use the browser vendor's speech service.

## Supported versions

Until 1.0, only the latest release gets security fixes.
