# Installing Muster

```sh
curl -fsSL https://agentmuster.io/install.sh | bash
```

Muster needs macOS (Linux is untested), git, Node 22.23 or later, Python 3.9 or later and the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) CLI signed in to a model provider. The installer checks for each of them first and installs none of them: if any is missing it lists what to install, with the command, and stops. [BrowserOS](https://www.browseros.com) is optional: without it, browser takeover and the agent's browser tool are unavailable, and everything else works.

The installer clones Muster into `~/.muster`, installs its Node packages, builds the web app, puts NumPy and scikit-learn in a virtual environment at `~/.muster/.venv`, and links the `agentmuster` command into `~/.local/bin`. It then starts Muster as a login service (launchd on macOS, a systemd user service on Linux) and waits until it answers. Running it again, or `agentmuster update`, updates the install and restarts it; a reply that was running stops and can be resumed. Settings for the installer, all optional: `MUSTER_DIR`, `MUSTER_PORT` (first install only), `MUSTER_BIN_DIR`, and `MUSTER_SERVICE=0` to skip the service.

`agentmuster start` runs Muster in the terminal instead of as a service. `stop`, `restart`, `status` and `logs` manage the service, and `uninstall` removes the service and the command but keeps the app folder and your data.

To run from a checkout instead:

```sh
npm install
python3 -m pip install -r requirements.txt
cp .env.example .env
npm run build
npm start
```

Open `http://127.0.0.1:47831`. The server binds only to loopback and indexes your sessions in the background on startup. On first startup it creates a random owner password and saves it in a private local file:

```sh
cat ~/.local/share/muster/initial-password.txt
```

Enter that password in the app's sign-in form. Do not put it in a URL, chat message, tunnel command, or source control. The file is kept so you can sign in from another device; the account itself stores only a scrypt hash. Once you have saved the password somewhere safer, you can delete the file.

To replace the password, run `npm run rotate-password`, then restart the app. The script writes a new hash and a new `initial-password.txt` (mode 600). Sign-ins live in server memory, so the restart signs out every device.

`MUSTER_WORKSPACE_ROOTS` limits which working directories a new thread can select. Its default is the owner's home directory. Narrow it to your project directories before enabling remote access. This controls directory selection, not the agent's filesystem permissions.
