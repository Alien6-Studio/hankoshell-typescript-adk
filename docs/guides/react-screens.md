# React account screens

Headless account, organization, access and security screens rendered with your own design system.

Use **headless IAM with host-owned UI components** for application screens.
The ADK owns account and organization loading, mutations and permission checks;
the application owns its Next.js routes, navigation and design system.

`HankoIdentityScreen` from `/identity/react` accepts a required `ui` adapter for
the application's buttons, fields, selects, cards and member lists. It injects
no CSS, theme variables, navigation frame or iframe and needs only React.
Bind your existing shadcn/ui components using [the reference adapter](https://github.com/Alien6-Studio/hankoshell-typescript-adk/blob/main/examples/shadcn-ui.tsx),
or bind another design system through the same typed contract. No second copy
of shadcn or Radix is installed by the ADK.

Headless screens support `en`, `fr`, `es`, `de`, `it`, `pt-BR`, `ar` and `he`.
Regional tags such as `fr-CA` and `he-IL` resolve to the supported language;
unknown tags fall back to English. `/identity/react` exports
`resolveHankoIdentityLocale`, `hankoIdentityLocales` and `hankoIdentityDirection`.
Use the direction helper on the host's page container for Arabic and Hebrew.
The older themed `/react` wrapper retains its English/French locale contract.

```tsx
"use client";
import { HankoIdentityScreen } from "@alien6-studio/hankoshell-typescript-adk/identity/react";
import { createHankoIdentityClient } from "@alien6-studio/hankoshell-typescript-adk/identity";
import { hankoIdentityUI } from "./hanko-identity-ui";

const controller = createHankoIdentityClient({ endpoint: "/api/account" });
export function OrganizationPage({ subject }: { subject: string }) {
  return (
    <HankoIdentityScreen
      subject={subject}
      controller={controller}
      page="organizations"
      ui={hankoIdentityUI}
      locale="fr"
    />
  );
}
```

Pages cover profile, organizations, access and security. Organization screens
include details, members, invitations, role changes and removal when the backend
authorizes them. `editableFields` narrows organization fields to those the product
supports; the server handler enforces this allowlist too. Unsupported actions stay
hidden, and read-only access is explicit. Selecting an organization to administer
does not switch the application's active tenant.

For custom layouts, use `useHankoAccount`, `useHankoOrganization` and
`useHankoIdentityMutation`. These retain validation, cancellation and mutation state.
`HankoIdentityView` accepts an already-loaded, subject-bound account.

The `/react` entry also provides `HankoIdentityPage` for the same native integration
with live Theme Builder titles and descriptions: pass `ui`, `theme` and `page`.
`HankoIdentityPortal` remains available for standalone themed portals. Applications
should use native pages. Only these themed adapters require Theme Builder.

`createHankoIdentityHandler` from `/identity/server` exposes this same-origin
endpoint. Its `authorize(request)` callback must verify the current session and
return `{ subject, controller }`. Implement that controller against your existing
server-authorized APIs; `createHankoIdentityBackend` supplies bounded authenticated
transport. Set `origin` to the configured public application origin behind a proxy.
Every request rechecks identity, organization membership and allowed operations;
backend authorization remains mandatory. No browser administrator token is needed.
Unsupported operations stay hidden. Business organization data stays in the application.

For `profile`, `password`, `email` and `otp`, pass `hankoAccountAction(action)` to
your OIDC client's normal sign-in flow (Auth.js third argument). The host retains
state, nonce, PKCE and callback handling; Keycloak enforces editable fields and
federation restrictions. Wire `logout` to your application's normal sign-out.
The Theme Builder's `theme.runtime` supports live appearance updates through
`createHankoAppearanceProxy`, using a fixed public upstream and no session credentials.
Customize page titles and descriptions with `theme.modules["account.profile"]`
(and `account.organizations`, `account.access`, `account.security`); each accepts
`title` and `description` strings or `{ en, fr }` translations.
