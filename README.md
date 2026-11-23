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

Open the [test preview](http://127.0.0.1:4174) to start in chat. The **Test mode** badge identifies deterministic gateway responses. The preview runs those responses through real sfield, the host verifiers, SQLite, assistant-ui, and the A2UI renderer. It uses temporary data for each server launch.

Try **Compare two terms** for the A2UI comparison. **Guide me through a task** opens the canonical transfer checklist and a portfolio follow-up. To see the eligible set and route decisions, open **Inspector**. Its persona and scenario settings create a new conversation. Type “Show my synthetic demo balance summary” for the read-only metric example.

### Help and planning overview

Chat opens at `/` and `/chat`. The **PZN Lab** link returns to the homepage. **Help** at `/help` shows the chat sequence and each component’s role, with interactive turn walkthroughs, sample payloads, and downloadable runtime contracts. Its **sfield** section shows who calls each registered tool and how the Portfolio Snapshot provider plugs in. **Proposal** shows the version 2 Treatment Selector response used by the funding workflow demo.

The planning overview is at `/planning`. **Portfolio**, **Retirement**, and **Balances** open chat with a question you can edit before sending. **Compare profiles** opens the profile picker in chat.

The original hero photograph in `apps/web/assets/coastal-planning.jpg` was generated with ImageGen using this prompt.

> Wide 3:2 candid editorial photograph for a financial-planning homepage. A silver-haired woman around 60 and her adult daughter stroll together on a bluff path overlooking the sea. Frame them waist-up near the center with generous headroom and space around both faces for a modest crop. Windswept grasses, a quiet ocean horizon, sage and cream clothing, soft late-afternoon light, natural smiles and realistic skin and fabric textures. No text, logos, or watermark.

### Demo profiles

Open `/login` or choose **Sign in** in the chat navigation to open a local profile. Signing in as **Alice Morgan**, **Jordan Lee**, or **Marcus Reed** opens their last conversation or starts on the chat welcome screen. The conversation list shows that profile’s history. The selection is saved for the browser tab. **Sign out** returns to profile selection.

Click the customer name in the chat header to compare **Alice Morgan**, **Jordan Lee**, and **Marcus Reed**. Each profile shows the customer’s focus, portfolio cash, beneficiary status, and funding status from the demo fixtures. **Start chat** opens a new conversation for that customer in **Standard rules**.

For a short demo, run **Learn about retirement** for both customers. Open **Logs → Treatment Selector** to show why Alice sees the beneficiary reminder and Jordan sees the lesson alone. Then ask both for a portfolio summary to show how the same cash threshold applies at $12,500 and $10,000.

### Intent routing and clarification

sfield sends the latest message, up to four recent turns, and the available intent catalog to the Context Router. History includes clarification questions, assistant reply text, and titles of previously displayed cards. For demo content requests, the LLM selects an intent ID. The host verifies the choice and maps it to a task and Treatment Selector context.

For greetings, acknowledgments, or general questions that need no tools, the Context Router returns `replyText` and chat displays it directly. When a request has no clear supported intent or asks for something outside the available experiences, chat lists what it can help with.

When Treatment Selector returns an empty list, the Experience Composer can continue in plain text using the request and recent chat. It can explain a general concept or ask a follow-up. The same reply field is available when eligible content exists and the Composer finds no suitable match. The app saves the reply in chat history. If the model fails on the empty-list path, the app shows a short local reply. See **Logs → Experience Composer** for the model call and its result.

When the goal is unclear, the router selects a focused question from the approved list and chat displays it. In a new chat, try “i will be 62” followed by “last day of job is next week.” Confirm that you want retirement planning information to route to `retirement_learning`. In a chat that already established retirement as the goal, the same messages can continue that topic directly. Use **Logs → Context Router** to see the input and decision.

After a greeting, “Show me the summary” asks “Did you mean your portfolio summary?” Reply “yes” to see the portfolio snapshot. If the conversation already establishes the portfolio as the subject, the same request opens the snapshot directly.

After comparing available and current balance, “Show me the summary” displays both synthetic balance amounts. The Context Router receives the established subject as `summaryFollowUpIntentId`, which you can see in **Logs → Context Router → Decoded chat input**.

### Portfolio Snapshot demo

Ask **Let me know my portfolio summary** in **Standard rules**. The Context Router selects `show_portfolio`, which maps to the `portsum` context. sfield calls Treatment Selector with `{ context, mid }`. In this mock, its built-in CCRE rule adds **Explore investing options** to the eligible set when **Portfolio → Cash balance (USD) → Greater than → 10000** matches. A saved rule for the same scenario, context and treatment replaces that fixture rule.

The **Portfolio Snapshot** provider supplies cash, equities, fixed income and the valuation date. sfield reads it through the scoped `portfolio.snapshot.read` tool and renders the values as an A2UI snapshot. The Experience Composer receives eligible portfolio suggestions for this requested summary. The host displays the cash amount from the same snapshot used in eligibility.

Alice Morgan sees **$12,500** in cash and the investing prompt. Jordan Lee sees **$10,000** in cash and the snapshot alone. Use **Tool setup → Treatment Selector test settings → Portfolio summary** to preview the rule for either profile. In **Logs**, compare **Context Router**, **Treatment Selector**, **Portfolio Snapshot**, and **Experience Composer**.

The POC uses synthetic accounts and a fixture implementation of `PortfolioSnapshotProvider`. A deployed integration can supply a portfolio service through that interface and call the existing Treatment Selector with the same context and member ID.

### Home-buying goal demo

Choose **Home-buying goal** in a new chat, type “goals,” or ask “How close am I to buying a house?” The Context Router selects `show_home_goal` for the `goals` context. Treatment Selector returns the eligible home down payment template. sfield calls the scoped **Goal Progress** provider for the target and six monthly savings values. The composer selects `PznGoalProgress`, and the host fills the A2UI card with the verified data.

Alice has saved **$26,000** toward **$50,000**. Jordan has saved **$33,600** toward **$60,000**. Each card includes the remaining amount, percentage saved, and a graph of the monthly growth. Expand **View monthly values** to see the underlying points. **Logs → Goal Progress** shows the tool request and response. **Help → Home-buying goal** walks through the architecture and includes the downloadable contract.

### Retirement learning demo

Choose **Learn about retirement** in a new chat with **Standard rules**. The Context Router selects the `retirement_learning` intent, which maps to the `learning` context. sfield sends that context and the demo member ID to Treatment Selector. The mock CCRE rule **Customer → Beneficiary status → Equals → Missing** controls whether Treatment Selector returns `beneficiary_update` alongside `retirement_learning`. The Composer selects the lesson, and sfield adds the eligible reminder when it renders the lesson.

- **Alice Morgan** has missing beneficiary details. Chat shows **Retirement planning basics** and **Update your beneficiaries**. Click **See beneficiary update steps** for the A2UI demo guide.
- **Jordan Lee** has details on file. Chat shows **Retirement planning basics**.

Use **Tool setup → Treatment Selector test settings → Learning → Run preview** to evaluate the rule for either persona. In chat, **Logs → Treatment Selector** shows the mock CCRE evaluation and the returned content IDs.

### Address update and account funding demo

Start a chat as **Marcus Reed**, a new account holder awaiting his first deposit. Choose **Update mailing address** or ask “I moved and need to update my address.” The Context Router selects `update_address`. sfield calls Treatment Selector with Marcus’s synthetic member ID and the `address-update` context. The mock returns `address_update_guide` and evaluates **Account → Funding status → Equals → Unfunded** to determine whether it can also return `fund_account`.

When both cards are eligible, Treatment Selector also returns `account.funding.preview@1.0.0`. Chat displays the address guide and **Fund your account**. Click **Preview funding** to start a separate turn. The app resolves the workflow by ID and version, and sfield runs the saved steps. The default order is **Funding options** then **Build funding preview**. Chat shows a sample $250 bank transfer that ends at review.

In **Tool setup → Funding preview workflow**, add **Check funding status** and place it before or after **Funding options**. Keep both required tools, with **Build funding preview** last, and click **Save settings**.

Ask **“what is next”** as Marcus to get the funding suggestion directly. The Context Router selects `suggest_next_step`. Treatment Selector evaluates the unfunded-account rule for the `next-step` topic and can return **Fund your account** and **Preview funding**.

Open **Logs → Treatment Selector** on the address turn to see the CCRE evaluation and workflow recommendation. Select **Preview funding** in **Logs** to inspect the workflow definition and each call in execution order. Ask the same address question as **Jordan Lee** to see the guide for an already funded account. **Tool setup → Address update → Run preview** compares the rules for both profiles.

### Inspect requests and responses

Open **Logs** in the chat header and choose a **Chat message**. The Context Router and Experience Composer show the compiled Chat Completions request body, assembled assistant response, and individual gateway attempts. Treatment Selector shows the sfield tool input, mock input, rule evaluation, and recommendations. Portfolio Snapshot and the funding workflow show their tool requests and results. In **Inspector**, select a **Chat message** and click **Open call logs** to open the logs for that turn.

Capture is local to the inspector and saved in SQLite. Gateway headers are excluded, and configured metadata values and known credentials are redacted. For older turns, the inspector verifies a reconstructed gateway body against the saved digest when possible and can show the saved agent input and responses. Set `PZN_INSPECTOR=off` to disable inspector access and new payload capture.

### sfield tool setup

Open **Tool setup** from the chat header to enable the registered sfield tools. In **Treatment Selector test settings**, choose a test case and topic. Use the default response, choose the content order, return no content, or simulate a timeout.

**Run preview** uses the current settings, selected demo persona and turn number. The local Treatment Selector adapter responds directly, so the preview works without LLM gateway credentials. **Save settings** stores the configuration in SQLite for this browser session. New chat requests, including explicit retries, pick up the saved settings. Use **Inspector** after a chat turn to see its Treatment Selector result. Set `PZN_INSPECTOR=off` to hide the tool setup page and disable its API.

#### Create and test a CCRE mock rule

Type **Create rule** in chat. After the Context Router returns `create_rule`, sfield calls the read-only `ccre.glossary.get` tool. The host passes the returned namespaces, attributes, operators and values to the A2UI editor. Open **Logs → CCRE glossary** to see the tool exchange.

Choose a topic and a piece of content. Build the rule using **Field group**, **Field**, **Comparison**, and **Value**. For example, choose **Customer**, **Demo profile**, **Equals**, and **Alice Morgan**. **Preview rule** evaluates the draft for a persona and turn. **Save rule** adds it to Tool setup for future chat turns. The mock evaluates the structured condition and stores any optional CCRE source as text.

You can also create a rule directly in Tool setup.

1. In **Tool setup**, select **Standard rules** and **Balances**, then click **Create rule** under **CCRE rules**.
2. Target **Available balance: demo definition**, use **Demo profile is**, select **Alice Morgan**, and click **Add rule**. The optional CCRE source is stored for future integration. The mock evaluates the condition controls.
3. Click **Run preview** for **Alice Morgan**, then change the preview profile to **Jordan Lee** and run it again. The evaluation shows whether the rule matched and the ranked IDs before and after filtering.
4. Click **Save and test in chat** and choose **Compare two terms**. This starts a new conversation with the selected persona and scenario. Open **Logs → Treatment Selector → Mock CCRE evaluation** to see the result on the chat turn.

Rules apply to the selected scenario, context and treatment. They filter its fixture or configured ranked list and keep the order of surviving IDs. **From message number** includes that turn and later turns. **Test in chat** starts at turn 1. Save rule edits or removals to apply them to subsequent chat requests.

### Direct OpenAI API for local testing

Set `OPENAI_API_KEY` in the server environment or in the ignored `.env.openai` file. The local preset uses `gpt-4.1-mini` and the OpenAI Chat Completions endpoint. Set `OPENAI_MODEL` to choose a different Chat Completions model that supports tool calling and structured outputs. See the [OpenAI API quickstart](https://developers.openai.com/api/docs/quickstart) and [model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

~~~sh
npm run build
npm run start:openai
~~~

Open the assistant and check for the **Live model** badge. Treatment Selector, CCRE, and portfolio reads use the demo fixtures. The preview defaults to port **4175** and stores its local state in `.pzn-data/openai`. Use `npm run eval:openai` to run the live API smoke cases. [Open the live preview](http://127.0.0.1:4175/)

### GitHub Copilot ACP

Install GitHub Copilot CLI with ACP support and sign in with a Copilot-enabled account. The app starts the CLI in ACP mode and exchanges JSON-RPC messages over standard input and output. [Copilot CLI ACP reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)

~~~sh
copilot login
~~~

Set the provider in `.env`.

~~~dotenv
LLM_PROVIDER=copilot_acp
~~~

Leave `LLM_MODEL` empty for Copilot's automatic model selection, or enter a model available to your Copilot account. Set `COPILOT_ACP_COMMAND` to the executable path if the server cannot find `copilot` on its PATH. On Windows, use the path to the native `copilot.exe` if your installation uses a command shim.

PZN Lab uses a CLI profile under `.pzn-data/copilot/copilot-cli` by default. If the CLI stores its login in a profile file on your machine, set `COPILOT_HOME` to that directory when you run `copilot login`. With a custom `PZN_DATA_DIR`, use its `copilot-cli` subdirectory. For headless sign-in, supply `COPILOT_GITHUB_TOKEN` through the server environment. [Copilot CLI authentication](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#authentication)

~~~sh
npm run build
npm start
~~~

Open [chat](http://127.0.0.1:4173/chat) and look for the **Copilot ACP** badge. Try Marcus Reed's “I moved and need to update my address.” In **Logs**, expand **Context Router** and **Experience Composer** to see the ACP prompts and replies. sfield runs PZN Lab tools, including Treatment Selector and scoped balance reads. Chat and settings for this provider are stored under `.pzn-data/copilot` unless you set `PZN_DATA_DIR`.

### Office gateway

Copy `.env.example` to `.env` or set the same values in the server environment. Use `LLM_PROVIDER=gateway` for the office gateway. Set `LLM_BASE_URL` to the gateway prefix before `/chat/completions` and `LLM_MODEL` to the gateway model alias. Set `LLM_API_KEY` for Bearer authentication. Set `LLM_CONTEXT_WINDOW`, `LLM_MAX_OUTPUT_TOKENS`, and any `LLM_QUIRKS` from the gateway’s tested capabilities.

If your gateway requires additional headers or request metadata, add JSON objects to your server environment.

~~~dotenv
LLM_GATEWAY_HEADERS_JSON='{"X-Client-Id":"pzn-lab","X-Gateway-Context":{"environment":"demo"}}'
LLM_GATEWAY_BODY_JSON='{"metadata":{"application":"pzn-lab"}}'
~~~

The app sends header strings as written and serializes object or array values as JSON. For gateways that authenticate with a custom header, provide that header in `LLM_GATEWAY_HEADERS_JSON` and leave `LLM_API_KEY` empty. Use one source for the Authorization header. Keep credentials in the server environment or the ignored local `.env`. Extra body fields apply to both agents and their tool-call requests. The adapter manages the model, messages, tools, streaming, and response format.

~~~sh
npm start
~~~

Open the [financial planning demo](http://127.0.0.1:4173). `npm run dev` runs the same local service with Vite development middleware. The application uses a loopback-only server, a per-browser local session, and SQLite files under `.pzn-data`. `PZN_PORT`, `PZN_DATA_DIR`, and `PZN_INSPECTOR=off` are optional server settings. For the alternate ranking mode, set `PZN_SELECTION_MODE=preserve_ts_rank`.

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

The smoke run exercises structured comparison, the balance tool round trip, step rendering data, and cancellation through the host. The full run evaluates the fixture-backed prompts under each ranking mode, in batches of ten conversations. It reports route accuracy, approved clarification, fixture relevance, completion rates, and p95 timing for both stages and the overall request. The first-status measurement is at the SSE client. Live relevance and latency results require the configured gateway.

## Project map

- `apps/server` hosts the sfield registry and two agent sessions along with SQLite, SSE, action validation, and the tool setup and inspector APIs.
- `apps/web` contains the responsive assistant-ui chat, registered A2UI components, inspector, and tool setup panel.
- `packages/contracts` and `packages/experience` contain the schemas, scoping verifiers, and compiler for approved content and disclosures.
- `packages/ts-adapter` serves the supported topics, topic scores, and ranked eligible content from the Treatment Selector demo fixtures.
- `vendor/sfield` contains the sfield workspace source and license.

The project pins dependencies in `package-lock.json` and records the runtime commit, A2UI baseline, and fixture versions in `build-baseline.json`. [A2UI React package](https://www.npmjs.com/package/@a2ui/react/v/0.15.0), [assistant-ui external store runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
