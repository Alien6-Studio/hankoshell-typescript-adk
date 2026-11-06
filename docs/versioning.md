# Coordinated ADK versions

Go and TypeScript use one version for each qualified application-integration delivery. The current shared target is **0.7.1**. Select the same published version when an integration uses both languages.

## Planning and qualification

Choose the common version at the start and document its product outcome in both repositories' milestones. Each repository keeps its own implementation and PRs. Qualify the portable token/access contract, the language-specific package or module, and the applicable session/reference flow before delivery.

Publish the two official signed releases under the same `vX.Y.Z` tag name. Record their source revisions and qualification evidence, verify public installation, then update consuming applications. A version is ready for a cross-language rollout once both public artifacts are available and verified.

Repository-specific documentation and delivery maintenance can merge without creating a new consumer release. Include runtime and integration changes in the next coordinated delivery. Release notes explain the product behavior and compatibility delivered to applications.

## Published history

Published tags and artifacts remain immutable. The earlier Go 0.2.0 and TypeScript 0.7.0 releases retain their original names; Go joins the common version line at 0.7.1. Future integration deliveries keep the version numbers aligned.
