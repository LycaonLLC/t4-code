# Signed macOS releases

Public macOS releases are built with an Apple Developer ID certificate, sent to Apple's notarization service, and checked with Gatekeeper before GitHub can publish them. The workflow stops if any part is missing or invalid.

## One-time Apple setup

1. Enroll the Lycaon Solutions Apple developer team.
2. Create a **Developer ID Application** certificate in Apple's developer portal.
3. Export that certificate and its private key from Keychain Access as a password-protected `.p12` file.
4. In App Store Connect, create an API key allowed to submit software for notarization. Download its `.p8` file once.
5. Add these GitHub Actions repository secrets:

| Secret | Value |
| --- | --- |
| `T4_MACOS_CERTIFICATE_P12_BASE64` | Base64 text of the exported `.p12` file |
| `T4_MACOS_CERTIFICATE_PASSWORD` | Password chosen when the `.p12` file was exported |
| `T4_MACOS_NOTARIZATION_KEY_BASE64` | Base64 text of the App Store Connect `.p8` key |
| `T4_MACOS_NOTARIZATION_KEY_ID` | App Store Connect API key ID |
| `T4_MACOS_NOTARIZATION_ISSUER_ID` | App Store Connect issuer ID |

Keep the certificate and API key out of the repository. Rotate a secret immediately if it is exposed.

## Local proof

Maintainers with the same credentials can build the public shape locally:

```bash
pnpm package:mac
node scripts/verify-macos-signature.mjs \
  release/T4-Code-0.1.23-mac-arm64.zip \
  release/T4-Code-0.1.23-mac-arm64.dmg
```

`package:mac` refuses to fall back to an unsigned build. `package:mac:unsigned` remains available only for local development and cannot satisfy the public release workflow.

The verification script checks four separate facts: the code signature is structurally valid, Gatekeeper accepts the app, the app contains a notarization ticket, and the DMG contains a notarization ticket.
