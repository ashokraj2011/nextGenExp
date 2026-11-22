# PZN Lab

A local implementation of **PZN Intent to Experience POC v1.1**. The Word specification drives the routed design. The supplied contract pack provides the approved content, fictional balance reads, and composition proposal schema. This project adds routed context, propensity, and eligibility fixtures.

## Run the app

Use Git, Node 22.13 or later, pnpm 10.33.2, and access to the pinned sfield repository. Run both commands from the extracted project directory.

~~~sh
pnpm run bootstrap
pnpm build
~~~

`pnpm run bootstrap` checks out and builds the pinned sfield workspace and installs the application from the included lockfile.

### Automated test preview

~~~sh
pnpm test:preview
~~~

Open [PZN Lab test preview](http://127.0.0.1:4174). The **Test mode** badge identifies deterministic gateway responses. The preview runs those responses through real sfield, the host verifiers, SQLite, assistant-ui, and the A2UI renderer. It uses temporary data for each server launch.

Try **Compare two terms** for the A2UI comparison. **Guide me through a task** opens the canonical transfer checklist and a portfolio follow-up. To see the eligible set and route decisions, open **Inspector**. Its persona and scenario settings create a new conversation. Type “Show my synthetic demo balance summary” for the read-only metric example.

### Live gateway

Copy `.env.example` to `.env` or set the same values in the server environment. Supply `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY`. The URL is the gateway prefix before `/chat/completions`. Set `LLM_CONTEXT_WINDOW`, `LLM_MAX_OUTPUT_TOKENS`, and any `LLM_QUIRKS` from the gateway’s tested capabilities.

~~~sh
pnpm start
~~~

Open [PZN Lab](http://127.0.0.1:4173). `pnpm dev` runs the same local service with Vite development middleware. The application uses a loopback-only server, a per-browser local session, and SQLite files under `.pzn-data`. `PZN_PORT`, `PZN_DATA_DIR`, and `PZN_INSPECTOR=off` are optional server settings. For the alternate ranking mode, set `PZN_SELECTION_MODE=preserve_ts_rank`.

The live adapter expects streamed Chat Completions, bearer credentials, function calls, and structured output. Other gateway protocols or authentication schemes require the corresponding sfield provider or credential resolver. Enterprise gateway verification is pending the gateway configuration. A shared deployment also needs the intended authentication and access configuration.

## Verify the implementation

~~~sh
pnpm test
pnpm test:browser
~~~

The browser checks use installed Chrome or Playwright Chromium. Install Chromium with `pnpm exec playwright install chromium` if needed. The tests cover actual A2UI action payloads, desktop and 360 px layouts, source details, follow-up rerouting, refresh, stop, retained drafts, and canonical fallback. Screenshots are written to `test-results/`.

The deterministic host tests run the pinned sfield runtime through its HTTP/SSE gateway adapter. They check routing and candidacy scopes, simulated exclusions, expiry, distinct unavailable states, provider failures, the balance tool round trip, replay, cancellation, and restart recovery. The original contract validator also passed its 54 cases against the supplied fixture pack.

The pinned A2UI renderer requires UAX #31 component IDs. The copied smoke fixture uses `open_label` for its button label component. pnpm reports an upstream peer range warning for A2UI’s Markdown adapter. The app supplies a plain-text renderer, and the tested A2UI paths passed with the specified React and core package pair.

Run the gateway checks after configuring the enterprise settings.

~~~sh
pnpm eval:live --smoke
pnpm eval:live
~~~

The smoke run exercises structured comparison, the balance tool round trip, step rendering data, and cancellation through the host. The full run evaluates 30 fixture-backed prompts under each ranking mode, in batches of ten conversations. It reports route accuracy, approved clarification, fixture relevance, completion rates, and p95 timing for both stages and the overall request. The first-status measurement is at the SSE client. Live relevance and latency results require the configured gateway.

## Project map

- `apps/server` hosts the sfield registry and two agent sessions along with SQLite, SSE, action validation, and the inspector API.
- `apps/web` contains the responsive assistant-ui chat, registered A2UI components, and inspector.
- `packages/contracts` and `packages/experience` contain the schemas, scoping verifiers, and compiler for approved content and disclosures.
- `packages/ts-adapter`, `packages/propensity-adapter`, and `fixtures` provide the simulated placement catalog, scores, and ranked eligibility.

The project pins dependencies in `pnpm-lock.yaml` and records the runtime commit, A2UI baseline, and fixture versions in `build-baseline.json`. [sfield source](https://github.com/ashokraj2011/sfield/tree/1b0c942f9b7d317199201533027bfd451d45a072), [A2UI React package](https://www.npmjs.com/package/@a2ui/react/v/0.15.0), [assistant-ui external store runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
