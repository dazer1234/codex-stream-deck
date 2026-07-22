# Install Codex Deck Mobile on an iPhone

Codex Deck Mobile is currently distributed as source code, not through the App
Store. You build and sign your own copy with Xcode. The repository has no
CocoaPods or third-party Swift package dependencies, and the iPhone build does
not require Node.js or npm.

> [!IMPORTANT]
> A Mac is currently required to build, sign, and install the iPhone app because
> Xcode runs on macOS. This is also true when the phone will control only a
> Windows Codex computer. Once the app is installed, that Mac does not need to
> remain online unless it is itself a Codex Deck node. There is no App Store,
> TestFlight, or pre-signed IPA distribution in this release.

## What you need

- A Mac with a current Xcode release that includes the iOS 26 SDK.
- An iPhone running iOS 17 or newer, a cable or trusted wireless Xcode pairing,
  and enough free space for one development build.
- An Apple Account added to Xcode under **Xcode > Settings > Accounts**.
- This repository downloaded or cloned on the Mac.
- At least one configured Codex Deck Mac or Windows node.

An Apple Developer Program membership is recommended for the complete app and
widget setup. Xcode's free Personal Team can install development apps for
personal use, but its provisioning expires after seven days and some
capabilities can depend on the account and provisioning profile. If automatic
signing rejects the App Group or widget extension, check the troubleshooting
section below.

## Download the source

For a released build, either download **Source code (zip)** from that GitHub
release and extract it, or clone the matching tag in Terminal:

```zsh
git clone --branch v0.7.0.2 --depth 1 https://github.com/dazer1234/codex-stream-deck.git
cd codex-stream-deck
```

Do not download an unrelated launcher ZIP for the Xcode project. The iPhone
source lives in the repository's `ios` directory.

## 1. Create your local signing configuration

Open Terminal, change into the repository, and choose a unique reverse-DNS
bundle identifier. Use your own name or domain instead of the example:

```zsh
./scripts/configure-ios-signing.sh com.yourname.CodexDeckMobile
```

This creates `ios/Configuration/Local.xcconfig`, which Git ignores. It also
derives a matching widget bundle ID and App Group. Keep the same bundle ID on
future updates so iOS upgrades the installed app instead of creating a second
copy.

If you know the 10-character Apple Team ID, it can be supplied explicitly:

```zsh
./scripts/configure-ios-signing.sh com.yourname.CodexDeckMobile ABC1234567
```

Do not post `Local.xcconfig`, relay tokens, QR codes, or signing details in an
issue or screenshot.

## 2. Open the project and select your team

1. Open `ios/CodexDeckMobile.xcodeproj` in Xcode.
2. Select the blue **CodexDeckMobile** project in the navigator.
3. Select the **CodexDeckMobile** app target, open **Signing & Capabilities**,
   enable **Automatically manage signing**, and select your Team.
4. Repeat that selection for the **CodexDeckWidgets** target.
5. If Xcode asks to register the bundle IDs or App Group, allow it. The app and
   widget target must use the same configured App Group.

Red signing messages at this stage usually mean the bundle identifier is not
unique, the wrong Team is selected, or that Team cannot provision the App Group.

## 3. Install on the iPhone

1. Connect and unlock the iPhone.
2. Tap **Trust** on the phone if it asks whether to trust the Mac.
3. In Xcode's destination menu, select the physical iPhone, not **Any iOS
   Device**.
4. Press the Run button or choose **Product > Run**.
5. Follow any on-device prompt to enable Developer Mode, then run once more.

The app appears on the Home Screen as **Codex Deck**. A `.data` file in Finder
is not the app; installation happens through Xcode's Run action. Open the app
once and allow **Local Network** access so Nearby discovery and widgets can use
the paired node.

## 4. Pair a computer

Nearby Wi-Fi is the simplest first connection and does not require Tailscale.
The iPhone and computer must be on the same private network.

On a Mac with the Codex Deck launcher installed:

```zsh
./start-codex-deck.sh mobile-local-config
```

On Windows, from the installed launcher directory:

```powershell
.\Configure-CodexDeckMobile.ps1 -Local
```

Scan the displayed QR code with the iPhone Camera. On Windows, reload only the
Codex Deck Stream Deck plugin after enabling the listener. If Windows Firewall
asks, allow Node.js on **Private networks** only.

For control away from home, install Tailscale on the phone and computer and
follow [Configure remote access with Tailscale](IOS.md#configure-remote-access-with-tailscale).
Tailscale is optional for same-Wi-Fi use and remains the recommended initial
remote-access path; Codex Deck does not expose Chrome DevTools or a public relay.
To prove the phone is using ordinary Wi-Fi rather than Tailscale, follow the
[local-only connection test](IOS_LOCAL_WIFI.md).

## Widgets and background updates

Open Codex Deck once after installation. Then long-press the Home Screen, tap
`+`, search for **Codex Deck**, and choose a widget. Widgets display a bounded
cached snapshot. iOS schedules refreshes opportunistically, so they are not a
guaranteed real-time connection while the app is terminated. Reliable
terminated-app push is future optional work and is not claimed by this release.

## Updating the source build

Pull or download the newer source, keep the same
`ios/Configuration/Local.xcconfig`, open the project, and press Run again. Xcode
replaces the development build while preserving its bundle-scoped app data.

With a free Personal Team, Xcode may require the app to be rebuilt and
reinstalled after its short-lived provisioning expires. This is an Apple
development-signing limitation, not a Codex Deck connection failure.

## Troubleshooting

- **Bundle identifier is not available:** rerun the configuration script with
  a more unique ID, then reopen Xcode.
- **App Group or widget will not sign:** verify both targets use the same Team.
  If the Team cannot provision App Groups, use an Apple Developer Program team;
  do not remove entitlements from only one target.
- **Unable to install / invalid executable:** clean the build folder in Xcode,
  confirm the physical iPhone is selected, and use **Product > Run**.
- **Developer Mode required:** follow the prompt in Xcode and on the iPhone,
  restart the phone only if iOS itself requests it, then run again.
- **A server with the specified hostname was not found:** use Nearby pairing on
  the same Wi-Fi, or confirm both devices are connected to the same Tailscale
  tailnet and use the private Tailscale HTTPS hostname.
- **Nearby node is not found:** enable Local Network access under iPhone
  Settings, ensure the network is private and not client-isolated, and recreate
  the QR code without rotating it.
- **Old app data or duplicate app:** keep one bundle ID. Removing the app also
  removes its local profiles and Keychain pairing data from that installation.

The full behavior and security model are documented in [Codex Deck Mobile for
iPhone](IOS.md).
