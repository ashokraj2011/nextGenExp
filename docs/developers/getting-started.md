## Run the app and trace a chat turn

Use a balance comparison to see how a customer message becomes a screen. You can then change the layout, replace its data source or attach a workflow to a recommendation.

### Start a local checkout

Use Node.js 22.13 or later and npm 10 or later. The repository includes the standalone **`sfield` Agent SDK** (all 8 `@sfield/*` packages) as npm workspaces. Run these commands from the repository root after signing in with the Copilot CLI, the default model provider.

```sh
npm ci
npm run build
npm run sfield -- doctor
npm run preview
```

Open `http://127.0.0.1:4174/` for customer chat, `/admin/help?guide=start` for these guides, and `/sfield-sdk.html` for the standalone SDK overview page. For live editing, run `PZN_PORT=4180 npm run dev` and use port 4180. Admin pages use the operator account for your installation. Local setup and gateway options are in the root `README.md` and `.env.example`.

For an internal npm registry, supply your organization's registry URL to the install, for example `npm ci --registry=https://packages.example.org/artifactory/api/npm/npm-virtual/`. The lockfile omits registry download URLs. npm can use credentials already configured in your user npm settings.

For **Google Gemini**, **OpenAI**, or an **office LLM gateway**, configure **Model gateway** in Administration (`/admin/gateway`) or set `LLM_PROVIDER=gemini` (`GEMINI_API_KEY`, `GEMINI_MODEL`), `LLM_PROVIDER=openai` (`OPENAI_API_KEY`), or `LLM_PROVIDER=gateway` (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`) in `.env`. `LLM_GATEWAY_HEADERS_JSON` and `LLM_GATEWAY_BODY_JSON` carry extra headers and body fields. A configuration activated in the admin panel takes precedence for the app. The command-line chat harness reads its environment separately.

### Follow the first turn

1. Sign in as **Jordan Lee** and ask **“Compare available and current balances.”** The expected chat card is **Compare balance definitions**.
2. In **Administration → Logs**, select the conversation and that message. The app chooses a flow from the enabled tenant and domain flows. Inside account help, sfield retrieves the TS topic catalog and member relevance scores, then sends the message and recent history to the intent model.
3. Inspect **Treatment Selector** for the MID, the topic `balance` and the eligible content. Open the composer exchange to see which eligible items the model proposed for display.
4. In **Inspector**, look for `compare_balances` and `PznComparison`. In the same chat ask **“show me the summary.”** On this turn look for `show_balance`, the balance read and `PznMetricSummary`. The read supplies the amounts.

### Find the part to change

| Task | Start here in the checkout | See the result |
| --- | --- | --- |
| Change how a verified result looks | `packages/contracts/ui-layout.ts` and `apps/web/ui-builder.tsx` | UI Builder → Try a chat turn |
| Add a new kind of card or control | `packages/contracts/surface.ts` and `apps/web/surface.tsx` | The chat reply and its Inspector entry |
| Change what the model sees | `packages/experience/prompt-compiler.ts` and `packages/contracts/model-inputs.ts` | The model request in Logs |
| Give sfield a new data read | `apps/server/runtime.ts` and the domain provider in `packages/` | The tool request, result and run ID |
| Customize empathy, tone & Customer 360 notes | `packages/contracts/empathy.ts`, `apps/server/response-personalizer.ts` and `packages/customer-profiles/index.ts` | `turn.emotionalState`, personalized intro, and Customer 360 notes |
| Change who qualifies or what a click runs | `packages/ts-adapter/index.ts` and `packages/contracts/customer-workflows.ts` | The source message and the separate click in Logs |

### Repeat a conversation from the terminal

```sh
npm run chat:harness -- --profile demo-returning --trace ./balance-trace.json
```

The harness starts an isolated app, compares balances, restarts the server, reopens the same thread, and asks for the summary. Use a new output filename for each run. The report contains the stored transcript, the decoded router input and the recorded calls. For a conversation you type yourself, use `npm run chat:harness -- --interactive`. The loop accepts `/reopen`, `/logs` and `/quit`. Both commands use the configured model provider.

For repeatable checks during development, `npm test` runs the unit and integration suites with local fixtures. After `npm run build`, `npm run test:browser` exercises the customer and admin screens with Playwright. Install the browser with `npx playwright install chromium` if Playwright reports a missing executable.
