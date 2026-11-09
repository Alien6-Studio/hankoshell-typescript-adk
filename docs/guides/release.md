# Develop, release and verify

Local checks, the release workflow, npm trusted publishing and how to verify a signed release proof.

## Develop

```sh
npm ci
npm run check
```

The package uses ESM and typed exports.

`/identity/react` and `/react` are React client entry points: bundle them with
your application's frontend. Node services use the root, `/authjs`, `/passport`,
`/identity` and `/identity/server` entry points.

## Release

Releases use `vX.Y.Z` tags matching
`package.json`; the release workflow publishes the tested npm archive and signed qualification evidence
on GitHub and npm. Configure the package's npm trusted publisher for GitHub owner
`Alien6-Studio`, repository `hankoshell-typescript-adk`, workflow `release.yml`,
environment `release`, with the `npm publish` action allowed. Publication to npm is
required; a missing publisher configuration fails the delivery instead of silently
skipping it. No CI variable is needed to activate npm publication.

To finish npm distribution of an existing GitHub release, dispatch `Release` from
`main` with its signed tag, for example `v0.7.1`. Qualification runs against that
tag. Before publishing, the workflow compares the archive with the existing public
asset and refuses any difference. It verifies npm's package integrity and preserves
the original GitHub release and evidence. Repeated publication of identical npm
content is harmless; different content under an existing version is refused.
No npm token is stored in this repository. Released versions are immutable.

## Attestation

The [Attestation workflow](https://github.com/Alien6-Studio/hankoshell-typescript-adk/actions/workflows/attest.yml)
runs the tests and builds a package without signing credentials. A separate job
recomputes the evidence against the reviewed commit, signs it with Continuum
Attest 0.2.0 and verifies signature, hashes and successful execution. Releases
publish that exact package. The public signer is pinned in [.github/attest/trust](../../.github/attest/trust).

To check a downloaded proof, check out its source revision and extract the
release's `qualification-evidence.tar.gz` at the repository root (or restore the
`signed-attestation` workflow artifact), then run:

```sh
attest verify proof/receipt.yaml --recompute --require signature,recompute,success --trust-store .github/attest/trust --offline
```

The receipt establishes the recorded checks and package identity. It does not
claim a hermetic build or an independently trusted timestamp.
