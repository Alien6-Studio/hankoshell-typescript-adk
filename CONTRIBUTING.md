# Contributing

Open an issue describing the application use case before adding an adapter.
Keep authentication protocol, product authorization and deployment configuration
separate.

Run `npm ci && npm run check`. Update the synthetic vectors in
`testdata/` when changing token acceptance and coordinate the same contract with
[the other ADK](https://github.com/Alien6-Studio/hankoshell-golang-adk). Include a
packaged consumer check for packaging changes.

Use synthetic identities, endpoints and credentials in examples. Never commit
cluster configuration, customer data or secrets. Sign commits and include a
`Signed-off-by` line. Contributions are provided under Apache-2.0.

Keep the declared source inputs in `attest.yaml` current when adding files.

Plan integration deliveries using the [coordinated ADK version policy](docs/versioning.md).
