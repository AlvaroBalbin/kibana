# @kbn/core-chrome-feature-flags

Feature flag utilities for Kibana's Chrome system.

## Chrome Next

`NEXT_CHROME_FEATURE_FLAG_KEY` (`core.chrome.next`) controls the Chrome Next rollout.
The flag defaults to `false`, so the foundation code is inert unless the flag is enabled.

Use `isNextChrome(featureFlags)` when core Chrome code needs to branch on the rollout state:

```ts
import { isNextChrome } from '@kbn/core-chrome-feature-flags';

const nextChromeEnabled = isNextChrome(featureFlags);
```

`NEXT_CHROME_SESSION_STORAGE_KEY` (`dev.core.chrome.next`) is used by the development toolbar
toggle. The session override is only read after `core.chrome.next` is enabled, so it can disable
Chrome Next locally during development but cannot enable Chrome Next when the rollout flag is off.

## Design Exploration (POC)

`DESIGN_EXPLORATION_FEATURE_FLAG_KEY` (`core.chrome.designExploration`) enables a throwaway
global style override layer for local design iteration. Not intended for merge.

Enable in `kibana.dev.yml` alongside Chrome Next:

```yaml
feature_flags.overrides:
  core.chrome.next: true
  core.chrome.designExploration: true
```

Use `isDesignExploration(featureFlags)` to branch on the flag. Styles are scoped via
`body[data-design-exploration='true']` (see `DesignExplorationChromeGlobalStyles` in
`@kbn/ui-chrome-layout`).

For app-specific overrides, add a plugin-level `<Global>` component scoped to the same body
attribute:

```tsx
import { Global, css } from '@emotion/react';
import { DESIGN_EXPLORATION_BODY_ATTR } from '@kbn/ui-chrome-layout';

const scope = `body[${DESIGN_EXPLORATION_BODY_ATTR}='true']`;

export const AppHeaderDesignExplorationStyles = () => (
  <Global
    styles={css`
      ${scope} [data-test-subj='kbnAppHeader'] {
        /* padding overrides */
      }
    `}
  />
);
```
