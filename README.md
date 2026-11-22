# PZN Lab

A local implementation of **PZN Intent to Experience POC v1.1**. The Word specification drives the routed design. The supplied contract pack provides the approved content, fictional balance reads, and composition proposal schema. This project adds routed context, propensity, and eligibility fixtures.

## Run the app

Use Node 22.13 or later and npm 10 or later.

~~~sh
npm ci
npm run build
~~~

This repository includes the sfield core, SQLite store, and test support source in `vendor/sfield`. npm links them as local workspaces and the build compiles them with the installed TypeScript compiler. All registry dependencies come from the configured npm registry.

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

### Portfolio Snapshot demo

Ask **Let me know my portfolio summary** in **Normal eligibility**. The Context Router returns `portsum` with the `show` intent. sfield calls Treatment Selector with `{ context, mid }`. In this mock, its built-in CCRE rule adds **Explore investing options** to the eligible set when **Portfolio → Cash balance (USD) → Greater than → 10000** matches. A saved rule for the same scenario, context and treatment replaces that fixture rule.

The **Portfolio Snapshot** provider supplies cash, equities, fixed income and the valuation date. sfield reads it through the scoped `portfolio.snapshot.read` tool and renders the values as an A2UI snapshot. The Experience Composer receives eligible portfolio suggestions for this requested summary. The host displays the cash amount from the same snapshot used in eligibility.

Demo learner sees **$12,500** in cash and the investing prompt. Demo returning visitor sees **$10,000** in cash and the snapshot alone. Use **Tool setup → Treatment Selector mock → Portfolio summary** to preview the rule for either persona. In **Logs**, compare **Context Router**, **Treatment Selector**, **Portfolio Snapshot**, and **Experience Composer**.

The POC uses synthetic accounts and a fixture implementation of `PortfolioSnapshotProvider`. A deployed integration can supply a portfolio service through that interface and call the existing Treatment Selector with the same context and member ID.

### Inspect requests and responses

Open **Logs** in the chat header and choose a **Chat turn**. The Context Router and Experience Composer show the compiled Chat Completions request body, assembled assistant response, and individual gateway attempts. Treatment Selector shows the sfield tool input, mock input, rule evaluation, and ranked IDs or tool error. Portfolio Snapshot shows its tool request and returned values. In **Inspector**, select a **Turn trace** and click **Open call logs** to open the logs for that turn.

Capture is local to the inspector and saved in SQLite. Gateway headers are excluded, and configured metadata values and known credentials are redacted. For older turns, the inspector verifies a reconstructed gateway body against the saved digest when possible and can show the saved agent input and responses. Set `PZN_INSPECTOR=off` to disable inspector access and new payload capture.

### sfield tool setup

Open **Tool setup** from the chat header to enable the registered sfield tools. For the **Treatment Selector mock**, choose a scenario and context, then use the built-in fixture, set a ranked list from the eligible demo content, return an empty list, or simulate a timeout.

**Run preview** uses the current settings, selected demo persona and turn number. The local Treatment Selector adapter responds directly, so the preview works without LLM gateway credentials. **Save settings** stores the configuration in SQLite for this browser session. New chat requests, including explicit retries, pick up the saved settings. Use **Inspector** after a chat turn to see its Treatment Selector result. Set `PZN_INSPECTOR=off` to hide the tool setup page and disable its API.

#### Create and test a CCRE mock rule

Type **Create rule** in chat. After the Context Router returns `create_rule`, sfield calls the read-only `ccre.glossary.get` tool. The host passes the returned namespaces, attributes, operators and values to the A2UI editor. Open **Logs → CCRE glossary** to see the tool exchange.

Choose a context and treatment, then build a condition using **Namespace**, **Attribute**, **Operator**, and **Value**. For example, choose **Customer**, **Demo persona**, **Equals**, and **Demo learner**. **Preview rule** evaluates the draft for a persona and turn. **Save rule** adds it to Tool setup for future chat turns. The mock evaluates the structured condition and stores any optional CCRE source as text.

You can also create a rule directly in Tool setup.

1. In **Tool setup**, select **Normal eligibility** and **Balances**, then click **Create rule** under **CCRE rules**.
2. Target **Available balance: demo definition**, use **Demo persona is**, select **Demo learner**, and click **Add rule**. The optional CCRE source is stored for future integration. The mock evaluates the condition controls.
3. Click **Run preview** for **Demo learner**, then change the preview persona to **Demo returning visitor** and run it again. The evaluation shows whether the rule matched and the ranked IDs before and after filtering.
4. Click **Save and test in chat** and choose **Compare two terms**. This starts a new conversation with the selected persona and scenario. Open **Logs → Treatment Selector → Mock CCRE evaluation** to see the result on the chat turn.

Rules apply to the selected scenario, context and treatment. They filter its fixture or configured ranked list and keep the order of surviving IDs. **From turn number** includes that turn and later turns. **Test in chat** starts at turn 1. Save rule edits or removals to apply them to subsequent chat requests.

### Direct OpenAI API for local testing

Set `OPENAI_API_KEY` in the server environment or in the ignored `.env.openai` file. The local preset uses `gpt-4.1-mini` and the OpenAI Chat Completions endpoint. Set `OPENAI_MODEL` to choose a different Chat Completions model that supports tool calling and structured outputs. See the [OpenAI API quickstart](https://developers.openai.com/api/docs/quickstart) and [model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

~~~sh
npm run build
npm run start:openai
~~~

Open the local preview and check the **OpenAI API** label in chat. Treatment Selector, CCRE, and portfolio reads use the demo fixtures. The preview defaults to port **4175** and stores its local state in `.pzn-data/openai`. Use `npm run eval:openai` to run the live API smoke cases. [Open the OpenAI preview](http://127.0.0.1:4175/)

### Office gateway

Copy `.env.example` to `.env` or set the same values in the server environment. Set `LLM_BASE_URL` to the gateway prefix before `/chat/completions` and `LLM_MODEL` to the gateway model alias. Set `LLM_API_KEY` for Bearer authentication. Set `LLM_CONTEXT_WINDOW`, `LLM_MAX_OUTPUT_TOKENS`, and any `LLM_QUIRKS` from the gateway’s tested capabilities.

If your gateway requires additional headers or request metadata, add JSON objects to your server environment.

~~~dotenv
LLM_GATEWAY_HEADERS_JSON='{"X-Client-Id":"pzn-lab","X-Gateway-Context":{"environment":"demo"}}'
LLM_GATEWAY_BODY_JSON='{"metadata":{"application":"pzn-lab"}}'
~~~

The app sends header strings as written and serializes object or array values as JSON. For gateways that authenticate with a custom header, provide that header in `LLM_GATEWAY_HEADERS_JSON` and leave `LLM_API_KEY` empty. Use one source for the Authorization header. Keep credentials in the server environment or the ignored local `.env`. Extra body fields apply to both agents and their tool-call requests. The adapter manages the model, messages, tools, streaming, and response format.

~~~sh
npm start
~~~

Open [PZN Lab](http://127.0.0.1:4173). `npm run dev` runs the same local service with Vite development middleware. The application uses a loopback-only server, a per-browser local session, and SQLite files under `.pzn-data`. `PZN_PORT`, `PZN_DATA_DIR`, and `PZN_INSPECTOR=off` are optional server settings. For the alternate ranking mode, set `PZN_SELECTION_MODE=preserve_ts_rank`.

The live adapter expects streamed Chat Completions, function calls, and structured output. Gateways with a different protocol or dynamic authentication require a provider or credential resolver that implements that contract. Enterprise gateway verification is pending the gateway configuration. A shared deployment also needs the intended authentication and access configuration.

## Verify the implementation

~~~sh
npm test
npm run test:browser
~~~

The browser checks use installed Chrome or Playwright Chromium. Install Chromium with `npm exec -- playwright install chromium` if needed. The tests cover actual A2UI action payloads, desktop and 360 px layouts, source details, follow-up rerouting, refresh, stop, retained drafts, canonical fallback, and tool setup. Screenshots are written to `test-results/`.

The deterministic host tests run the pinned sfield runtime through its HTTP/SSE gateway adapter. They check routing and candidacy scopes, simulated exclusions, expiry, distinct unavailable states, provider failures, the balance tool round trip, replay, cancellation, and restart recovery. The original contract validator also passed its 54 cases against the supplied fixture pack.

The pinned A2UI renderer requires UAX #31 component IDs. The copied smoke fixture uses `open_label` for its button label component. The npm override aligns A2UI’s Markdown adapter peer dependency with the pinned core. The app supplies a plain-text renderer.

Run the gateway checks after configuring the enterprise settings.

~~~sh
npm run eval:live -- --smoke
npm run eval:live
~~~

The smoke run exercises structured comparison, the balance tool round trip, step rendering data, and cancellation through the host. The full run evaluates 30 fixture-backed prompts under each ranking mode, in batches of ten conversations. It reports route accuracy, approved clarification, fixture relevance, completion rates, and p95 timing for both stages and the overall request. The first-status measurement is at the SSE client. Live relevance and latency results require the configured gateway.

## Project map

- `apps/server` hosts the sfield registry and two agent sessions along with SQLite, SSE, action validation, and the tool setup and inspector APIs.
- `apps/web` contains the responsive assistant-ui chat, registered A2UI components, inspector, and tool setup panel.
- `packages/contracts` and `packages/experience` contain the schemas, scoping verifiers, and compiler for approved content and disclosures.
- `packages/ts-adapter`, `packages/propensity-adapter`, and `fixtures` provide the simulated placement catalog, scores, and ranked eligibility.
- `vendor/sfield` contains the sfield workspace source and license.

The project pins dependencies in `package-lock.json` and records the runtime commit, A2UI baseline, and fixture versions in `build-baseline.json`. [A2UI React package](https://www.npmjs.com/package/@a2ui/react/v/0.15.0), [assistant-ui external store runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
