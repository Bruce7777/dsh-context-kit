# GitHub distribution and release maintenance

This independent MIT package contains two Cordis plugins. The current distribution channel is the public [GitHub repository](https://github.com/Bruce7777/dsh-context-kit); npm publishing and community-market indexing are deferred.

## Supported GitHub installation

Install the versioned prebuilt archive stored in this repository:

```sh
dsh plugin --profile web add https://raw.githubusercontent.com/Bruce7777/dsh-context-kit/main/release-assets/dsh-context-kit-0.1.1.tgz
```

The archive includes ESM runtime files, TypeScript declarations, bundle metadata, locales and documentation. It has no install-time lifecycle build. The source repository keeps its development build commands; a Git shorthand source dependency can require package-manager build approval, so it is not the documented one-command path.

The initial package targets Node ≥24.9 and DSH 0.2.2-rc.1. See the [Chinese installation guide](installation.zh.md) for profile selection, configuration, verification and removal, and [test results](test-results.zh.md) for measured costs and limitations.

## Build a release archive

Use the declared runtime and pinned lockfile, then run the applicable checks:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:coverage
pnpm pack --pack-destination release-assets
```

`prepack` builds runtime and declaration files. Generate a SHA-256 checksum beside the archive, inspect the package's file list, and verify the archive before publishing:

```sh
cd release-assets
shasum -a 256 dsh-context-kit-0.1.1.tgz > dsh-context-kit-0.1.1.tgz.sha256
cd ..
pnpm run verify:install ./release-assets/dsh-context-kit-0.1.1.tgz
```

Only selected source, synthetic tests, public aggregate reports and release files belong in Git. `.artifacts/`, credentials, user Session content, local profiles and development dependencies are excluded. Review staged paths and archive contents before uploading. Never overwrite an archive version after public release; increment `package.json` and publish a new version for changed release contents.

After pushing, repeat `verify:install` against the public GitHub URL. This checks the actual public download through the supported `dsh` launcher, using an isolated temporary `DSH_HOME`. Record results in the release's test report. A checksum checks file integrity; it does not authenticate a different source.

## Later npm and market work

An npm release will require registry authentication and verification of the exact published version. A future npm release would allow `dsh plugin --profile web add dsh-context-kit@<version>`. Do not advertise an npm version until registry verification succeeds.

[DSH Market](https://github.com/dsh-market/dsh-market) and native format-1 indexes provide community discovery. npm publication does not automatically create a catalog entry; submission and acceptance are separate steps. Neither registry publication nor market submission is performed in this GitHub-only release.
