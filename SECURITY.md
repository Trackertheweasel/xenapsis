# Security

Persec carries arbitrary web traffic, so a compromised or broken dependency matters more here than in most apps. This page covers how dependencies are kept current and checked.

## Dependency updates

Dependabot opens update PRs for npm packages (daily), GitHub Actions and the Docker base image (weekly). CI installs with `pnpm install --frozen-lockfile`, which fails if any package doesn't match the sha512 hash in `pnpm-lock.yaml`.

Before merging a dependency PR:

- Read the changelog or release notes, and check that the lockfile diff only touches the packages the PR names.
- Be suspicious of new install scripts. pnpm runs none by default, and `pnpm.ignoredBuiltDependencies` in `package.json` lists the ones we've reviewed and chose to skip. If pnpm warns about a new one, find out what it does before allowing it.
- For a Docker digest bump, the PR only needs a green build.
- For an action bump, check that the SHA matches the tag in the comment beside it.

## Proxy engines

The proxy engines and transports (`@mercuryworkshop/*`, `@titaniumnetwork-dev/*`) come in one grouped PR. A bump can pass the build and still break proxying at runtime: wisp-js 0.5.1 broke DNS (#12) and is held below 0.5.0 in `.github/dependabot.yml`. Before merging that PR, deploy it and browse a few sites through both Scramjet and Ultraviolet, on desktop and on a phone. Review the group at least once a month, even if nothing seems wrong, so it doesn't fall far behind.

Scramjet comes from the npm registry (`@mercuryworkshop/scramjet`). Its 1.x line is `latest` there, and 2.x is still alpha. Before moving to a version, compare the registry tarball with the matching GitHub release:

```bash
npm view @mercuryworkshop/scramjet@1.1.0 dist.integrity
curl -sL https://github.com/MercuryWorkshop/scramjet/releases/download/v1.1.0/mercuryworkshop-scramjet-1.1.0.tgz | openssl dgst -sha512 -binary | openssl base64 -A
```

Both commands should print the same hash (the first one adds a `sha512-` prefix), and it should match the `@mercuryworkshop/scramjet` entry in `pnpm-lock.yaml`.

## Vulnerability scanning

The Dependency Audit workflow runs `pnpm audit` on every push and pull request, and every Monday. It lists all advisories but fails only on high or critical ones. When it fails, upgrade the package, or the direct dependency that pulls it in. If the vulnerable code can't be reached in Persec, add the advisory's GHSA ID to `pnpm.auditConfig.ignoreGhsas` in `package.json`, with the reason in the PR.
