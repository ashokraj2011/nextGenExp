# PZN Lab

A local implementation of **PZN Intent to Experience POC v1.1**. The Word specification drives the routed design. The supplied contract pack provides the approved content, fictional balance reads, and composition proposal schema. This project adds routed context, propensity, and eligibility fixtures.

## Run the app

Use Node 22.13 or later and npm 10 or later. The build needs Git and access to the pinned sfield commit.

~~~sh
npm ci
npm run build
~~~

The npm lockfile covers the app and the sfield workspace dependencies. The build fetches the pinned sfield source and compiles its runtime packages with the installed TypeScript compiler. Set `PZN_SFIELD_GIT_URL` to an internal Git mirror or a local repository that contains the pinned commit.

### Install through Artifactory

Use your npm virtual repository URL for the install.

~~~sh
npm ci --registry https://artifactory.example.com/artifactory/api/npm/npm-virtual/
npm run build
~~~

For an authenticated repository, put the following settings in an ignored `.npmrc.local` file. Replace the host and repository name in both lines and provide `NPM_TOKEN` in the shell or CI environment.

~~~ini
registry=https://artifactory.example.com/artifactory/api/npm/npm-virtual/
//artifactory.example.com/artifactory/api/npm/npm-virtual/:_authToken=${NPM_TOKEN}
~~~

~~~sh
npm ci --userconfig .npmrc.local
npm run build
~~~

The same npm commands use any existing registry and authentication settings in your npm user configuration. The lockfile stores package versions and integrity hashes. npm resolves tarball URLs through the configured registry. [JFrog npm repositories](https://docs.jfrog.com/artifactory/docs/npm-repositories), [npm configuration](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc/)

### Automated test preview

~~~sh
npm run test:preview
~~~

Open [PZN Lab test preview](http://127.0.0.1:4174). The **Test mode** badge identifies deterministic gateway responses. The preview runs those responses through real sfield, the host verifiers, SQLite, assistant-ui, and the A2UI renderer. It uses temporary data for each server launch.

Try **Compare two terms** for the A2UI comparison. **Guide me through a task** opens the canonical transfer checklist and a portfolio follow-up. To see the eligible set and route decisions, open **Inspector**. Its persona and scenario settings create a new conversation. Type “Show my synthetic demo balance summary” for the read-only metric example.

### Live gateway

Copy `.env.example` to `.env` or set the same values in the server environment. Supply `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY`. The URL is the gateway prefix before `/chat/completions`. Set `LLM_CONTEXT_WINDOW`, `LLM_MAX_OUTPUT_TOKENS`, and any `LLM_QUIRKS` from the gateway’s tested capabilities.

~~~sh
npm start
~~~

Open [PZN Lab](http://127.0.0.1:4173). `npm run dev` runs the same local service with Vite development middleware. The application uses a loopback-only server, a per-browser local session, and SQLite files under `.pzn-data`. `PZN_PORT`, `PZN_DATA_DIR`, and `PZN_INSPECTOR=off` are optional server settings. For the alternate ranking mode, set `PZN_SELECTION_MODE=preserve_ts_rank`.

The live adapter expects streamed Chat Completions, bearer credentials, function calls, and structured output. Other gateway protocols or authentication schemes require the corresponding sfield provider or credential resolver. Enterprise gateway verification is pending the gateway configuration. A shared deployment also needs the intended authentication and access configuration.

## Verify the implementation

~~~sh
npm test
npm run test:browser
~~~

The browser checks use installed Chrome or Playwright Chromium. Install Chromium with `npm exec -- playwright install chromium` if needed. The tests cover actual A2UI action payloads, desktop and 360 px layouts, source details, follow-up rerouting, refresh, stop, retained drafts, and canonical fallback. Screenshots are written to `test-results/`.

The deterministic host tests run the pinned sfield runtime through its HTTP/SSE gateway adapter. They check routing and candidacy scopes, simulated exclusions, expiry, distinct unavailable states, provider failures, the balance tool round trip, replay, cancellation, and restart recovery. The original contract validator also passed its 54 cases against the supplied fixture pack.

The pinned A2UI renderer requires UAX #31 component IDs. The copied smoke fixture uses `open_label` for its button label component. The npm override aligns A2UI’s Markdown adapter peer dependency with the pinned core. The app supplies a plain-text renderer.

Run the gateway checks after configuring the enterprise settings.

~~~sh
npm run eval:live -- --smoke
npm run eval:live
~~~

The smoke run exercises structured comparison, the balance tool round trip, step rendering data, and cancellation through the host. The full run evaluates 30 fixture-backed prompts under each ranking mode, in batches of ten conversations. It reports route accuracy, approved clarification, fixture relevance, completion rates, and p95 timing for both stages and the overall request. The first-status measurement is at the SSE client. Live relevance and latency results require the configured gateway.

## Project map

- `apps/server` hosts the sfield registry and two agent sessions along with SQLite, SSE, action validation, and the inspector API.
- `apps/web` contains the responsive assistant-ui chat, registered A2UI components, and inspector.
- `packages/contracts` and `packages/experience` contain the schemas, scoping verifiers, and compiler for approved content and disclosures.
- `packages/ts-adapter`, `packages/propensity-adapter`, and `fixtures` provide the simulated placement catalog, scores, and ranked eligibility.

The project pins dependencies in `package-lock.json` and records the runtime commit, A2UI baseline, and fixture versions in `build-baseline.json`. [sfield source](https://github.com/ashokraj2011/sfield/tree/1b0c942f9b7d317199201533027bfd451d45a072), [A2UI React package](https://www.npmjs.com/package/@a2ui/react/v/0.15.0), [assistant-ui external store runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
