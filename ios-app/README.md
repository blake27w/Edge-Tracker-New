# Edge Tracker — iOS app (Capacitor)

Wraps the live Edge Tracker web app in a native iOS shell you can sign with your
Apple Developer account and ship via TestFlight or the App Store.

**You need a Mac with Xcode** (Capacitor generates a real Xcode project; you can't
build/sign iOS apps without Xcode).

## 1. First-time setup (on your Mac, in this `ios-app/` folder)
```bash
npm install
npx cap add ios          # creates the ios/ Xcode project
npx cap sync ios
```

## 2. Set the live site URL
`capacitor.config.json` → `server.url` must be your deployed frontend URL.
It's currently `https://blake27w.github.io` — confirm that's where your
index.html actually serves (if GitHub Pages serves it under a repo path, use the
full path, e.g. `https://blake27w.github.io/Edge-Tracker-New`). After changing it:
```bash
npx cap sync ios
```

## 3. App icon
Use `AppIcon-1024.png` (1024×1024, no alpha — App Store compliant).
In Xcode: open `ios/App/App.xcworkspace` → `App/Assets.xcassets/AppIcon` →
drag the 1024 icon in (Xcode 14+ generates the rest from the single 1024).

## 4. Build & run
```bash
npx cap open ios         # opens Xcode
```
In Xcode:
- Select the **App** target → **Signing & Capabilities** → pick your Team
  (your Apple Developer account). Set a unique **Bundle Identifier**
  (matches `appId`: `com.blake27w.edgetracker`).
- Plug in your iPhone → select it → **Run** to install on your own device, OR
- **Product → Archive** → **Distribute App** → **App Store Connect** to upload
  for **TestFlight** (invite up to 100 testers, no public review) or App Store.

## Notes
- This loads the live site, so any frontend change you deploy shows up instantly —
  no rebuild needed for UI updates.
- **App Store review caveat:** Apple can reject pure "website wrapper" apps
  (Guideline 4.2). For your own use / TestFlight this is fine. For a public
  listing, bundle the web assets locally (copy index.html, sw.js, manifest,
  icons into `www/` and remove `server.url`) and add native value
  (e.g. push notifications) to pass review.
- Push notifications, if you want them later: add `@capacitor/push-notifications`
  and wire the backend alerts to APNs.
