<p align="center"><img src="build/icon.png" width="128" alt="Hop"></p>

<h1 align="center">Hop</h1>

<p align="center">AirDrop-style file sharing between your Mac and your PC. Drag a file onto the other computer — hop, it's there.</p>

<p align="center"><a href="https://hop-drop.vercel.app/"><b>Download</b></a> · <a href="https://github.com/0xCodez/hop/releases">Releases</a></p>

## How it works

- Open Hop on both computers on the **same Wi-Fi or LAN**. They find each other automatically and appear on the radar.
- **Drag** files or folders onto the other computer (or click it to choose files).
- The other side gets an **Accept / Decline** card. Tick "Always accept from this device" for your own machines.
- Received files land in `Downloads/Hop` (changeable at the bottom of the window). Nothing is overwritten — a second copy becomes `photo (1).jpg`.
- Closing the window keeps Hop running (in the Dock on macOS, in the tray on Windows) so it can still receive.

Files go straight from one computer to the other over your local network. No cloud, no account.

## Install

Download from the [website](https://hop-drop.vercel.app/) or the [latest release](https://github.com/0xCodez/hop/releases/latest):

| Platform | File |
| --- | --- |
| Mac with Apple silicon (M1–M4) | `Hop-mac-arm64.dmg` |
| Mac with Intel | `Hop-mac-x64.dmg` |
| Windows 10/11 | `Hop-windows-x64.exe` |

**macOS.** Hop isn't notarized by Apple yet, so the first launch is blocked. Drag Hop to Applications, then either run

```bash
xattr -cr /Applications/Hop.app
```

or open **System Settings → Privacy & Security** and click **Open Anyway**. Allow Local Network access when asked.

**Windows.** SmartScreen may warn about an unknown publisher: **More info → Run anyway**. When Windows Firewall asks, allow Hop on **Private networks**, and make sure your Wi-Fi network profile is set to **Private**.

## Development

Requires Node.js 22+.

```bash
npm install
npm start          # run the app
npm test           # discovery + transfer smoke test, no Electron needed
npm run dist       # build an installer for the current OS
```

- Two copies on one machine (handy for testing): `HOP_PROFILE=b npm start`.
- UI screenshots with demo data: `npx electron scripts/screenshot.js out.png "demo=offer&platform=darwin" 1500 dark`.
- Regenerate the icon: `npx electron scripts/render-icon.js`.

Pushing a tag like `v0.2.0` builds the installers on GitHub Actions and publishes them as a release. The website in `site/` lives at [hop-drop.vercel.app](https://hop-drop.vercel.app/). Vercel (project root: `site`) and a GitHub Pages mirror both redeploy it on every push to `main`; `npx vercel deploy --prod --yes` from the repo root deploys it by hand.

## Under the hood

| File | Role |
| --- | --- |
| `src/main/discovery.js` | Finds devices: UDP beacons on port 47800 every 1.5 s |
| `src/main/transfer.js` | Transfers: HTTP receiver (offer → streamed files) and sender |
| `src/main/main.js` | Window, tray, notifications, wiring between UI and network |
| `src/renderer/` | UI: radar, drag & drop, the hop animation |
| `site/` | The download website |

There's no encryption yet: Hop is meant for your home network, and every incoming transfer needs your OK unless you've trusted the device.

## License

[MIT](LICENSE). Hop is not affiliated with Apple Inc. or Microsoft Corporation.
