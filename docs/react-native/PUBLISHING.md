# Publishing Guide — `react-native-amazon-connect-webrtc`

How to ship the React Native library to other teams: channels, pre-publish checklist, versioning,
and the security gates that keep the package clean. (Flutter sibling: [../PUBLISHING.md](../PUBLISHING.md).)

## 1. What gets published

The npm tarball contains exactly what `package.json → files` lists:

```
src/          TypeScript sources (metro consumes these via the "react-native" field)
lib/          compiled JS + .d.ts (node/tooling entry: "main"/"types")
android/      Kotlin module + gradle + manifest (autolinked)
ios/          Swift module + ObjC shim (autolinked via the podspec)
react-native-amazon-connect-webrtc.podspec
README.md, LICENSE
```

Nothing else ships — no tests, no configs, no secrets. Verify before every release:

```bash
npm pack --dry-run          # lists every file that would be published — READ it
```

## 2. Pre-publish checklist (run all of it)

```bash
cd packages/react-native-amazon-connect-webrtc
npm ci                       # exact lockfile install
npm run typecheck            # tsc strict — no errors
npm test                     # 23 unit tests (backend client + controller)
npm audit                    # must print: found 0 vulnerabilities
npm audit --omit=dev         # runtime deps: trivially 0 (there are none)
npm pack --dry-run           # eyeball the file list
```

And the manual gates:

- [ ] **No secrets / real endpoints** in any published file:
      `grep -rE "execute-api|AKIA|eyJ" src ios android *.podspec | grep -v YOUR_API_ID` → empty.
- [ ] Version bumped (semver, §4) and `CHANGELOG` note written.
- [ ] `peerDependencies` still accurate (`react-native >= 0.71`).
- [ ] Chime SDK pins reviewed (`AmazonChimeSDK ~> 0.27` in the podspec,
      `software.aws.chimesdk:amazon-chime-sdk:0.25.4` in `android/build.gradle`) — when bumping,
      re-verify the observer interfaces (`AudioVideoObserver` methods change between minor
      versions; the Android SDK group is `software.aws.chimesdk`, NOT `com.amazonaws`).
- [ ] Smoke-test in a real RN app on a **physical device** (call connects, CallKit/Telecom UI
      shows, mute syncs, speaker routes, DTMF drives an IVR).

## 3. Publishing channels

### a) Public npm

```bash
npm login
npm publish --access public
```

`prepare` runs the TypeScript build automatically, so `lib/` is always fresh in the tarball.

### b) Private registry (GitHub Packages / Artifactory / Verdaccio / CodeArtifact)

```bash
# .npmrc in the consuming org
@your-scope:registry=https://npm.pkg.github.com        # or your registry URL
```

Scope the name (`@your-scope/react-native-amazon-connect-webrtc`) in `package.json`, then
`npm publish`. For AWS CodeArtifact: `aws codeartifact login --tool npm --repository … --domain …`
then `npm publish`.

### c) Git dependency (no registry)

```json
"react-native-amazon-connect-webrtc": "github:your-org/chimeflutter#v1.0.0"
```

Works because `prepare` builds `lib/` on install. Consumers need the native toolchains anyway.

### d) Monorepo path (development)

```json
"react-native-amazon-connect-webrtc": "file:../chimeflutter/packages/react-native-amazon-connect-webrtc"
```

## 4. Versioning

Semver against the **shared contract** ([specs/003](../../specs/003-api-contracts.md)):

- **Major** — breaking change to the JS API, the native event payloads, or the backend contract
  (a contract change must ship in lockstep with the backend + the Flutter plugin — the spec file is
  the single source of truth for all of them).
- **Minor** — new methods/events, new optional config.
- **Patch** — fixes, doc updates, dependency bumps without API impact.

Tag releases `vX.Y.Z` (the podspec's `s.source` points at the tag).

## 5. Keeping it vulnerability-free (the ongoing part)

- **Runtime dependencies: keep at zero.** Every feature so far needs only `fetch`,
  `NativeModules`, and the platform SDKs. Treat any new runtime dep as a design smell first and a
  security review second.
- **CI gate**: run the §2 command block on every PR; fail the build on `npm audit` findings
  (`npm audit --audit-level=low`). Dev-tooling advisories are fixed by bumping the dev
  `react-native`/`jest` pins (they never ship to consumers, but a clean report keeps the signal
  honest).
- **Native SDK advisories**: watch the Amazon Chime SDK release notes (iOS + Android) and Jetpack
  `core-telecom` releases; media stacks get CVE fixes — bump the pins deliberately, then rerun the
  §2 device smoke test.
- **Enable GitHub Dependabot / `npm audit signatures`** on the repo so registry-level compromises
  and advisory updates surface automatically.

## 6. What integrators must still do (their app, not the library)

- Deploy the backend and front it with **their** auth (the API ships open;
  `tokenProvider` carries their JWT).
- iOS: Info.plist usage strings + `UIBackgroundModes audio,voip` + Background Modes capability.
- Android: `minSdk 26`; the library manifest contributes permissions + the foreground service.
- Point them at [GETTING_STARTED.md](./GETTING_STARTED.md) — it covers all of this step by step.
