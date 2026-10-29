# Contributing Guide

Thank you for your interest in Contributing to Persec.

### What you need

- pnpm
- nodejs

Directions to install these are found in the readme

### Before creating a pull request

Before creating a pull request, please run `pnpm run precommit` in your
terminal. This will format the code. CI rejects pull requests that aren't
formatted, fail `pnpm test`, or fail the type check in `pnpm build`.

### Version history

Every pull request that changes what Persec does adds a line to the newest entry in
`src/utils/changelog.ts` (shown in Settings → About). For a new version, bump `version` in
`package.json` and add an entry with the same version on top; `pnpm test` checks they match.

### Adding games / apps

An asset is a game or an app.

**To add games or apps, follow this format**:

```json
{
  "name": "Google", // Name of asset
  "image": "/a/images/ap/g.png", // Image of asset
  "link": "https://www.google.com" // URL for asset
}
```

**Files/Folders:**

- Apps & Games → `public/a/json/lists.json`
- Games images: `public/a/images/ga`
- Apps images: `public/a/images/ap`
