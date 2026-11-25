# Desktop app

Muster's desktop app lives in the macOS menu bar. It shows how many threads are waiting for you, sends a notification when one starts waiting (a reply is ready, the agent has a question, it needs you in the browser, or a run stopped), and opens Muster in its own window. It doesn't run Muster itself: it connects to the Muster the installer set up, so install that first.

## Install

The app isn't signed with an Apple Developer ID yet, so build it yourself:

```sh
cd ~/.muster/desktop
npm install
npm run build:arm64      # Intel Macs: npx electron-builder --mac --x64
open release/*.dmg
```

Drag Muster to Applications and open it. A copy you built on your own Mac opens normally. A copy downloaded from elsewhere is blocked by Gatekeeper until it's signed; until then, right-click it, choose **Open**, and confirm.

## Use

- **Menu bar:** the icon shows a number while threads are waiting. The menu lists them; pick one to open it.
- **Notifications:** one per thread each time it starts waiting, except for the thread you're looking at. Turn them off from the menu. macOS asks permission the first time.
- **Window:** **Open Muster** (⌘O), or open the app again from Finder or Spotlight. Links to other sites open in your browser.
- **Start or restart Muster:** from the menu, when the installer's login service is set up. If replies are running, it asks first, because a restart stops them.
- **Open at login:** a checkbox in the menu. Started at login, the app stays in the menu bar without opening a window.

## How it signs in

Muster keeps a random key in its data folder (`desktop-key`, readable only by you). The app reads it and gets a 30-day sign-in, and the window uses the same sign-in, so you never type the password here. The key never leaves your computer. See [SECURITY.md](../SECURITY.md).

## Where it looks for Muster

The app reads the port from `~/.muster/.env` and finds the data folder the way the server does. To point it somewhere else, create `~/.config/muster/desktop.json`:

```json
{"url": "http://127.0.0.1:47831", "dataDir": "~/.local/share/muster", "serviceLabel": "io.agentmuster.muster"}
```

`serviceLabel` is the launchd label used by Start and Restart. Every field is optional.

## Limits

- macOS only for now.
- Voice typing in the window may not work: Electron doesn't include the browser speech service Chrome and Safari use.
- Notifications reach this computer only. For your phone, keep Muster open on the Home Screen.
