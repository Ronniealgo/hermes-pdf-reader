# v1.0.1 verification

- Automated regression: **27 passed, 0 failed** after `npm ci --ignore-scripts`, using the project's pinned test dependencies (not the Hermes source checkout's dependencies).
- `npm run check` and `git diff --check`: passed.
- Dependency audit during clean installation: 0 reported vulnerabilities.
- Running Windows Hermes Desktop: **26 UI/file assertions passed**. Tests operated the existing installed app through real DOM controls and the SDK, without restarting the app or gateway.
- Real local PDFs loaded, A→B→A and two separately selected PDFs restored independently. File-sidebar show/hide was tested in both directions without hiding the viewer. Real chat images decoded, next/previous changed and restored their sources. Plugin disabled and enabled through the actual Capabilities → Plugins switches, then reopened successfully.
- Regression coverage includes duplicate stored IDs across owners/connections, unresolved-owner fail-closed behavior, SDK/OS bridge, reordered reads, plugin retirement, current workspace defaults and filesystem roots.

The automated tests explicitly substitute SDK and OS boundaries; they are not a screenshot/PDFium page-position test. The installed-app checks are separate from those contract tests. Native PDF page/zoom retention across remount and persistence across plugin reload are not claimed.

Private document paths, image bytes, session identities, and temporary QA plugins are **not** included in this release.
