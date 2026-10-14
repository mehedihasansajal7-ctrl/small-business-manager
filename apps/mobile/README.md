# Small Business Manager — Android app (Expo / React Native)

The Android client for **Small Business Manager**: an offline-first workspace shared by 2–5
business partners, with sales, purchases, inventory, double-entry finance, the farming module and
a zero-cost AI assistant.

It is one of three clients over the same contract:

| Piece | What it is |
|---|---|
| `packages/domain` (`@sbm/domain`) | Framework-free business rules: exact `Decimal` money, units, the inventory ledger, double-entry accounting, farming costing, permissions, tenancy and the offline outbox/sync primitives. |
| `apps/api` (`@sbm/api`) | Zero-dependency Node server over SQLite: the HTTP API, the idempotent sync service and the AI gateway. |
| **`apps/mobile` (this package)** | The Expo app. Consumes `@sbm/domain` directly and talks to `apps/api` over HTTPS/HTTP. |

---

> **Get the APK:** a ready-to-install Android build is published to the public
> [`small-business-manager-downloads`](https://github.com/mehedihasansajal7-ctrl/small-business-manager-downloads/releases/latest)
> repository (built by `.github/workflows/android-apk.yml`, so no local Android SDK is needed).
> After installing, open **Sign in → Advanced: which server?** and enter the address of your API
> (for example `http://192.168.0.20:8787`), tap **Test and save this server**, then sign in. The
> address is stored on the device (`src/config/server-url.ts`), so one APK works against any
> server — that is why the build-time URL is only a default.

---

## 1. The three rules this app is built around

1. **Money and quantities are never floating point.** Every amount is parsed and calculated with
   `@sbm/domain`'s `Decimal` (bigint-backed) and `money()` (currency minor units). SQLite money and
   quantity columns are `TEXT`. `Number()` is never used on a monetary value — including inside the
   number inputs and the POS totals.
2. **Nothing is "shared" until the server confirms it.** A sale, purchase, expense, input issue,
   farming event or harvest is written to a local `outbox` table with a deterministic idempotency
   key, shown as a *local proposal*, and marked `SYNCED` only when `POST /api/sync/push` says so.
   The server applies each event exactly once.
3. **The app works offline for the core actions.** Recording a sale, purchase, expense, stock
   adjustment, input issue, farming event, mortality, harvest and cycle operations all work with no
   connection, and all previously synced data can be read. What genuinely needs the internet is
   stated in the UI: signing in, accepting an invite, changing roles, creating a farm/unit, and the
   AI assistant.

Location is intentionally **not** requested. The manifest allows only `INTERNET`, `CAMERA` and
`ACCESS_NETWORK_STATE`, and explicitly blocks the location, audio and contacts permissions.

---

## 2. Prerequisites

Pick one of the two routes.

### Route A — full Android toolchain (build an APK on this machine)

| Requirement | Version | Why |
|---|---|---|
| Node.js | 20 LTS or 22+ | Expo CLI and Metro |
| npm | 10+ | installs the app's toolchain |
| JDK | **17** (Temurin/OpenJDK) | required by the Android Gradle Plugin that Expo SDK 52 generates |
| Android SDK Platform | API **35** | `compileSdkVersion` for SDK 52 |
| Android SDK Build-Tools | 35.0.0 | `aapt2`, `d8` |
| Android SDK Platform-Tools | latest | `adb`, for installing/sideloading |
| Android Studio *(optional)* | Hedgehog or newer | the easiest way to get the SDK + an emulator |
| Environment | `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) set, `platform-tools` on `PATH` | Gradle finds the SDK this way |

### Route B — no Android SDK at all (prebuilt development client)

If you cannot install the SDK, install the **Expo Go** app from <https://expo.dev/go> and run the
QR-code workflow instead (`npm run start`, then scan). Expo Go bundles the native modules this app
uses (`expo-sqlite`, `expo-secure-store`, `expo-image-picker`, `expo-file-system`, `expo-clipboard`,
`expo-sharing`, `expo-crypto`), so the app runs as-is.

Trade-offs of Route B, stated honestly:

* Expo Go cannot produce an `.apk`.
* It is a development shell, not something to hand to a shopkeeper.
* For a sideloadable build you still need Route A (or a cloud build — see §5.3).

---

## 3. Install and run

```bash
# 1. The shared domain package must be COMPILED first: the app consumes its dist/ output.
#    (Run from the monorepo root: small-business-manager/)
npm install                 # installs the workspaces (@sbm/domain, @sbm/api)
npm run build -w @sbm/domain

# 2. Install the mobile app's own dependency tree.
#    apps/mobile is deliberately NOT part of the root npm workspaces: the Expo tree is
#    large, so installing it is an explicit choice.
cd apps/mobile
npm install

# 3. Start the API somewhere reachable by the device (from the monorepo root):
#    PORT=8787 npm run api        # http://127.0.0.1:8787

# 4. Run the app.
npx expo install --check      # confirms every dependency matches Expo SDK 52
npm run start                  # Metro + a QR code (Expo Go, Route B)
npm run android                # Metro + launch on an emulator/device (Route A)
npm run web                    # a quick browser sanity check
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint . --ext .ts,.tsx
```

### Pointing the app at your API

The base URL is resolved in this order:

1. `EXPO_PUBLIC_API_URL`
2. `expo.extra.apiUrl` (from `app.config.ts`)
3. the default `http://10.0.2.2:8787`

`10.0.2.2` is the **Android emulator's** alias for the host machine's `localhost`. A physical device
cannot reach it — use the LAN IP of the machine running the API:

```bash
EXPO_PUBLIC_API_URL=http://192.168.0.20:8787 npm run android
```

For a production build the value must be `https://…`: Android blocks cleartext HTTP outside debug
builds, and a release APK should never ship a plain-HTTP server address. The current value is
visible in the app under **Settings → Server**.

---

## 4. Offline model (how the two clients agree)

* `src/offline/db.ts` — `expo-sqlite` (async API) with versioned migrations and real transactions.
  The mirror tables hold **server-confirmed rows only**; money/quantity columns are `TEXT`.
* `src/offline/outbox.ts` — wraps `@sbm/domain`'s `createOutboxEvent`. The record change and the
  outbox row are written in **one** SQLite transaction. Status transitions use the shared
  `statusAfterFailure` / `retryDelayMs` (exponential backoff with jitter), so the phone, the browser
  and the server cannot disagree about when an event is retried, parked for a human, or dropped as
  permanently rejected.
* `src/offline/sync.ts` — push in batches of 50, then pull with `?since=<cursor>` and apply the
  whole delta in one transaction. `ONLINE_ONLY` actions (`member.role_change`, `member.invite`, …)
  come back as `NEEDS_ATTENTION` and are surfaced in **Sync status** for a human decision.
* Conflicts are never auto-resolved: revisions are compared with `classifyRevision`, and the user
  chooses **keep mine** (`LOCAL_WINS`, re-queued against the server's current revision) or **keep
  the server's** (`SERVER_WINS`, the queued change is dropped).
* `src/offline/attachments.ts` — photos are a **separate** queue. A receipt photo that fails to
  upload must never roll back or duplicate the sale it belongs to; the UI says the image is *stored
  on your server, partners see it after syncing*.

---

## 5. Building an APK **without Google Play**

### 5.1 Debug APK (the quickest sideloadable build)

```bash
cd apps/mobile
npx expo prebuild --platform android     # generates ./android from app.json (only if it does not exist)
npx expo run:android --variant debug     # compiles and installs on a connected device/emulator
```

The APK lands at:

```
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

To build the file without installing it:

```bash
cd apps/mobile/android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

Install it directly (no Play Store, no Play Services):

```bash
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

On the shopkeeper's phone: copy the `.apk`, open it, and allow *Install unknown apps* for the file
manager or browser used. That is the entire distribution story — the spec forbids a Google Play
dependency, and nothing in the app uses Play Services.

### 5.2 Release APK signed with a locally generated keystore

```bash
# 1. Generate the keystore ONCE and keep it offline (losing it means you cannot ship updates).
keytool -genkeypair -v \
  -keystore sbm-release.keystore \
  -alias sbm \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storetype PKCS12 \
  -dname "CN=Small Business Manager, OU=Mobile, O=SFUWT, L=Dhaka, C=BD"

# 2. Tell Gradle about it. Either export the four values as environment variables,
#    or put them in apps/mobile/android/gradle.properties:
#      SBM_UPLOAD_STORE_FILE=sbm-release.keystore
#      SBM_UPLOAD_KEY_ALIAS=sbm
#      SBM_UPLOAD_STORE_PASSWORD=********
#      SBM_UPLOAD_KEY_PASSWORD=********
#    (gradle.properties is git-ignored — never commit the keystore or its passwords.)

# 3. Add the signing config to apps/mobile/android/app/build.gradle (release block):
#      signingConfigs {
#        release {
#          storeFile file(System.getenv("SBM_UPLOAD_STORE_FILE") ?: project.findProperty("SBM_UPLOAD_STORE_FILE"))
#          storePassword System.getenv("SBM_UPLOAD_STORE_PASSWORD") ?: project.findProperty("SBM_UPLOAD_STORE_PASSWORD")
#          keyAlias System.getenv("SBM_UPLOAD_KEY_ALIAS") ?: project.findProperty("SBM_UPLOAD_KEY_ALIAS")
#          keyPassword System.getenv("SBM_UPLOAD_KEY_PASSWORD") ?: project.findProperty("SBM_UPLOAD_KEY_PASSWORD")
#        }
#      }
#      buildTypes { release { signingConfig signingConfigs.release } }

# 4. Build.
cd apps/mobile/android
./gradlew assembleRelease          # Windows: gradlew.bat assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Verify before shipping:

```bash
adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
# or, to confirm the signature:
apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

### 5.3 The same thing with `eas build --local` (no Expo account charged)

`eas.json` ships four profiles. The ones that do **not** require a paid plan:

```bash
cd apps/mobile
npx eas-cli build -p android --profile local --local      # entire build on this machine, APK output
npx eas-cli build -p android --profile preview            # cloud build, free-plan friendly, APK
npx eas-cli build -p android --profile development        # dev client (needs expo-dev-client installed)
```

`--profile local` prints the path to the produced `.apk` when it finishes. `preview` uploads the
build and gives you a download link; it needs an Expo account, but the free tier is enough for
sideloadable internal builds.

---

## 6. What was verified here — and what was not

This source tree was written on a Windows machine with **Node 24 and no JDK, no Android SDK and no
Android Studio**. The Android build path is therefore the one thing that could not be exercised.

### Verified in this environment (real commands, real output)

| Check | Command | Result |
|---|---|---|
| Dependencies install | `npm install` in `apps/mobile` | ✅ **914 packages**, plus the ESLint set and the `@expo/metro-runtime` / `expo-asset` follow-ups |
| SDK version alignment | `npx expo install --check` | ✅ `Dependencies are up to date` (after pinning `expo-asset`, `expo-sqlite` and `react-native` to their SDK 52 versions) |
| Expo config resolves | `npx expo config --type public` | ✅ `app.json` + `app.config.ts` load together; `android.package = com.sbm.businessmanager`, `versionCode = 1`, `extra.apiUrl = http://10.0.2.2:8787` |
| Permissions | `npx expo config` | ✅ `INTERNET`, `CAMERA`, `ACCESS_NETWORK_STATE` only; location/contacts/audio are in `blockedPermissions` (note: `expo-image-picker` *adds* `RECORD_AUDIO`, which the block list then strips) |
| Type check | `npx tsc -p tsconfig.json --noEmit` | ✅ **0 errors**, against the real React, React Native, Expo module and `@sbm/domain` types |
| Lint | `npx eslint . --ext .ts,.tsx` | ✅ **0 errors, 0 warnings** |
| Full app bundle | `npx expo export --platform web` | ✅ **946 modules** bundled by Metro (1.96 MB) — every screen, the offline layer and `@sbm/domain` compile, so all imports and transforms resolve |

Those runs caught and fixed real defects while the app was being written: a wrong import path in the
sync engine, a mutable-vs-readonly interface mismatch, an invalid query type, a **missing `Text`
import that would have crashed a screen at runtime**, a missing `cycleId` argument, a `stock.adjust`
outbox event the server would have rejected, and two missing translation keys.

### NOT verified here

* **No APK, and no `expo prebuild`** — there is no `android/` directory in this repository, by design
  (it is generated and git-ignored). Nothing above proves the *native* Android build works.
* **Nothing ran on a device or emulator**, so runtime behaviour (SQLite on a real device, the camera,
  the keystore, gesture handling, dark mode) is unproven.
* The bundle check used the **web** platform. It proves the shared JS graph compiles; it does not
  prove that Android-specific native modules link.

So the first thing to do on a machine with the toolchain is:

```bash
cd apps/mobile
npm install
npx expo install --check     # expect "up to date"; use `npx expo install --fix` otherwise
npm run typecheck            # expected: clean
npx expo prebuild --platform android
npx expo run:android --variant debug
```

Known environment notes, so they do not surprise you:

* `@sbm/domain` is consumed as a compiled `file:` dependency. If it is resolved before the domain
  package is built, run `npm run build -w @sbm/domain` from the monorepo root and re-run
  `npm install` here — otherwise Metro reports that `packages/domain/dist/index.js` is missing.
* `@react-navigation/drawer` needs `react-native-reanimated` + `react-native-gesture-handler` (both
  declared) and their Babel/Gradle setup, which `expo prebuild` generates.
* `app.config.ts` is a TypeScript dynamic config, which is why `ts-node` is a devDependency — that is
  Expo's documented requirement, not an accident.

---

## 7. Project layout

```
apps/mobile/
├── App.tsx                     provider composition (theme → i18n → network → auth → sync)
├── index.ts                    entry: polyfills FIRST, then react-native-gesture-handler, then Expo
├── app.json                    static manifest: name, scheme, package, permissions
├── app.config.ts               dynamic overlay: EXPO_PUBLIC_API_URL → extra.apiUrl
├── babel.config.js             babel-preset-expo only
├── metro.config.js             monorepo watchFolders + @sbm/domain resolution
├── eas.json                    development / preview / local / production profiles
├── tsconfig.json               strict, paths → packages/domain/dist
├── .eslintrc.js                eslint-config-expo baseline (+ the two documented tweaks)
├── assets/                     generated placeholder icons (scripts/generate-assets.mjs)
├── scripts/generate-assets.mjs dependency-free PNG writer for the placeholder icons
└── src/
    ├── api/                    client.ts (fetch + Set-Cookie session, 401 handling),
    │                           endpoints.ts (typed wrappers for every route), types.ts, session-store.ts
    ├── auth/                   AuthProvider (session, active business, permissions), useActor
    ├── components/             Button, Card, Field/Select/Toggle, NumberInput, StatusBadge,
    │                           OfflineBanner, Notice, Segmented, PermissionGate, Screen,
    │                           PhotoPicker, MoneyText, AIModeBadge
    ├── config/env.ts           API base URL, timeouts, batch size, app info
    ├── i18n/                   bn-BD + en strings, persisted choice, domain formatters
    ├── lib/                    network (NetInfo), useAsyncData, useSync (the sync controller)
    ├── navigation/             RootNavigator, AppNavigator (drawer ≥768dp, tabs below), types
    ├── offline/                db.ts (mirror + migrations), outbox.ts, sync.ts,
    │                           repository.ts (offline reads/writes), attachments.ts
    ├── polyfills/              TextEncoder / crypto.getRandomValues / randomUUID for Hermes
    ├── prefs/storage.ts        AsyncStorage helpers (non-secret preferences)
    ├── screens/                auth, onboarding, dashboard, sales, purchases, inventory, catalog,
    │                           finance, reports, farming, team, ai, sync, settings, more
    └── theme/                  light/dark tokens, persisted mode, status colours
```

---

## 8. Feature notes worth knowing before you change code

* **Field visibility.** The server omits fields a role may not see (`purchasePrice`, `cogs`,
  `costToDate`…). The UI renders a *restricted* state instead of a zero: a hidden balance and a zero
  balance must never look the same.
* **Permissions are a UI convenience.** `<PermissionGate>` hides or explains; the server enforces
  every rule with `assertPermission`, and the sync service re-checks on apply.
* **Reports work offline.** P&L, balance sheet and cash flow are computed on the device from the
  mirrored journal with the same `@sbm/domain` functions the server uses.
* **Farms and farm units are online-only** (there is no `farm.create` / `farm_unit.create` outbox
  event type), while cycles, operations and harvests are offline-capable. The buttons say so.
* **Stock adjustment is online-only too**, for the same reason: `SyncService.applyEvent` has no
  `stock.adjust` case, so `StockAdjustScreen` calls `POST /api/inventory/adjust` directly and disables
  the button offline. See the comment where the queueing helper used to be in
  `src/offline/repository.ts`.
* **AI output is never a transaction.** The AI screen has no "apply" action; a record can only be
  created through the outbox flow with an explicit save. The `generative` / `local` / `fallback` mode
  is rendered on every answer by `AIModeBadge`, and citations show their `kind` with an "open source"
  link.
* **App config.** `app.config.ts` takes precedence over `app.json` and reads `app.json` through the
  `config` argument, so nothing is duplicated.

---

## 9. বাংলা সারসংক্ষেপ (Bangla summary)

**কী তৈরি হয়েছে:** `apps/mobile` — Expo + React Native (TypeScript) দিয়ে লেখা **Small Business
Manager** অ্যান্ড্রয়েড অ্যাপ। এতে আছে বিক্রয় (POS), ক্রয়, মজুদ, হিসাব (ডাবল-এন্ট্রি),
খামার মডিউল, রিপোর্ট, টিম ব্যবস্থাপনা, সিঙ্ক স্ট্যাটাস, সেটিংস এবং এআই সহকারী।

**তিনটি মূল নীতি:**

1. **টাকা ও পরিমাণ কখনোই ফ্লোটিং পয়েন্ট নয়** — সব হিসাব `@sbm/domain`-এর `Decimal`/`money()`
   দিয়ে, ডাটাবেসে `TEXT` হিসেবে। কোথাও `Number()` দিয়ে টাকার হিসাব করা হয় না।
2. **সার্ভার নিশ্চিত না করলে কিছুই "শেয়ার হয়েছে" বলে দেখানো হয় না** — প্রতিটি এন্ট্রি প্রথমে
   এই ডিভাইসের `outbox`-এ সংরক্ষিত হয় এবং নির্দিষ্ট idempotency key সহ সার্ভারে যায়; সার্ভার
   নিশ্চিত করলেই `SYNCED` হয়। একই এন্ট্রি দুইবার পোস্ট হয় না।
3. **অফলাইনে মূল কাজগুলো করা যায়** — বিক্রয়, ক্রয়, খরচ, ইনপুট ইস্যু, খামারের ঘটনা, ফসল সবই
   ইন্টারনেট ছাড়া এন্ট্রি করা যায়, এবং আগের ডেটা দেখা যায়। ইন্টারনেট দরকার শুধু সাইন ইন,
   আমন্ত্রণ গ্রহণ, ভূমিকা পরিবর্তন, খামার তৈরি ও এআই প্রশ্নে — অ্যাপে তা স্পষ্ট লেখা আছে।

**লোকেশন অনুমতি নেই** — ম্যানিফেস্টে শুধু `INTERNET`, `CAMERA`, `ACCESS_NETWORK_STATE`;
লোকেশন, অডিও ও কন্টাক্ট অনুমতি ব্লক করা।

**ছবি/রশিদ:** ক্যামেরা বা গ্যালারি থেকে ছবি যোগ করা যায়। ছবি **আলাদা কিউতে** আপলোড হয় — ছবি
আপলোড ব্যর্থ হলেও বিক্রয় বা লেনদেন বাতিল/দুইবার হয় না। অ্যাপে লেখা থাকে: *"ছবিগুলো আপনার
সার্ভারে সংরক্ষিত হয়, সিঙ্ক হওয়ার পর অংশীদাররা দেখতে পাবেন।"*

**বিল্ড সম্পর্কে সৎ কথা:** এই কোড যে মেশিনে লেখা হয়েছে সেখানে **JDK, Android SDK বা Android Studio
নেই** — তাই এখানে **APK তৈরি করা হয়নি** এবং `expo prebuild` চালানো হয়নি (তাই `android/` ফোল্ডার
রিপোতে নেই, এটি জেনারেট হয়ে থাকে)।

তবে যেগুলো সত্যিই চালানো ও যাচাই করা হয়েছে:

- `npm install` — সফল (৯১৪+ প্যাকেজ)
- `npx expo install --check` — “Dependencies are up to date” (SDK 52-এর সঠিক ভার্সনে পিন করা)
- `npx expo config` — `app.json` + `app.config.ts` ঠিকভাবে লোড হয়; permissions যাচাই করা
  (INTERNET, CAMERA, ACCESS_NETWORK_STATE; লোকেশন ব্লক করা)
- `npx tsc --noEmit` — **০ এরর**
- `npx eslint .` — **০ এরর, ০ ওয়ার্নিং**
- `npx expo export --platform web` — Metro পুরো অ্যাপ (৯৪৬ মডিউল) সফলভাবে বান্ডল করেছে, অর্থাৎ
  সব ইমপোর্ট ও `@sbm/domain` ঠিকভাবে যুক্ত হয়েছে

এই যাচাইয়ের সময় কয়েকটি বাস্তব বাগ ধরা পড়ে ঠিক করা হয়েছে (যেমন একটি স্ক্রিনে `Text` ইমপোর্ট
করা ছিল না — রানটাইমে ক্র্যাশ করত; সিঙ্ক ইঞ্জিনে ভুল ইমপোর্ট পাথ; একটি অসমর্থিত `stock.adjust`
অফলাইন ইভেন্ট; একটি অনুপস্থিত `cycleId`; দুটি অনুপস্থিত অনুবাদ কী)।

**এখনো যাচাই হয়নি:** কোনো ডিভাইসে বা এমুলেটরে চালানো হয়নি, এবং অ্যান্ড্রয়েড নেটিভ বিল্ড (Gradle)
পরীক্ষা করা হয়নি।

**অ্যান্ড্রয়েড টুলচেইন আছে এমন মেশিনে যা চালাতে হবে:**

```bash
cd small-business-manager
npm install
npm run build -w @sbm/domain
cd apps/mobile
npm install
npx expo install --check
npm run typecheck
npx expo prebuild --platform android
npx expo run:android --variant debug
# তৈরি হবে: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

**Google Play ছাড়া বিতরণ:** উপরের `.apk` ফাইল সরাসরি ফোনে কপি করে ইনস্টল করুন (*Install unknown
apps* অনুমতি দিন), অথবা `adb install -r <apk>` চালান। অ্যাপে Google Play Services-এর কোনো
নির্ভরতা নেই।

**সার্ভার ঠিকানা:** এমুলেটরে ডিফল্ট `http://10.0.2.2:8787`। আসল ফোনে চালাতে হলে
`EXPO_PUBLIC_API_URL=http://<আপনার-PC-এর-LAN-IP>:8787 npm run android` ব্যবহার করুন। প্রোডাকশনে
অবশ্যই `https://…` দিতে হবে (অ্যাপে **Settings → Server**-এ ঠিকানাটি দেখা যায়)।
