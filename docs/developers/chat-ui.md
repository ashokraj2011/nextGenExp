## Create a chat UI

A layout controls how an existing result appears. Attach it to an intent, a capability, or a published Wealth content item. On a customer turn the server supplies verified content, values and actions. You can share the same design across customers with different results.

### Review before publishing

**Publish** submits the exact design for review. **Review in Admin chat** opens the request with its revision and a preview of the prepared change. You can also open **Approvals chat** from Administration to see pending requests. Select **Approve publication** or **Deny request** on the card. Decisions use the signed-in operator's identity and are recorded in Logs.

Chat continues using the current publication while a change is under review. If the underlying revision changes, submit a new review from the latest revision. Widget availability, catalog changes, rules, tool and routing settings, workflows, connectors, and integration tasks use the same review chat. A Treatment Selector publication keeps its topic, content, rules, and dictionary together so later drafts leave the published decision intact.

In **sfield Studio → Overview & Locks**, **Request lock approval** submits the current sfield configuration fingerprint for review. When approved, the lock records the exact configuration fingerprint and the operator who approved it.

### Publish a balance comparison

1. In **Administration → UI Builder**, select **Wealth** and open the balance comparison layout or its starter design. Set **Layout name** to **Balance definitions**.
2. In **Details**, set **When should this layout appear?** to “Explain available and current balances side by side.” Attach **Compare balances** (`compare_balances`). A description can help the router match an existing intent.
3. Add or edit a text heading such as **How to read your balance**. Keep the **Balance comparison** block (`PznComparison`). Choose **Grid layout** to arrange blocks in columns.
4. **Save draft**. In **Layout preview → Try a chat turn**, ask **“Compare available and current balances.”** The expected result says **Draft layout applied** and includes your heading. Layout preview uses sample blocks and reads the selected profile for supported data bindings. The chat check runs the configured model and domain rules.
5. **Publish**, open **Review in Admin chat**, and approve the prepared design. Then ask the same question in customer chat. In **Inspector → Published UI**, check the design name and revision. **Design library → Use as template** gives another owner an editable copy. Approved publications affect subsequent turns. Earlier turns retain their recorded UI.

### Configure how a content item appears

In **Administration → Intents & Catalog → Wealth → Content Catalog**, select **Home down payment**. **Built-in formats** shows which verified formats this item may use. Save changes to the content item to update that list.

Choose **Design in UI Builder** to start with the content item attached and its first allowed block in place. Add a saved widget, a linked sequence of widgets, or text. Preview with a customer who has a home-buying goal, then use **Try a chat turn** with **“Show my home-buying goal and savings progress.”** Submit it for publication and approve it in Admin chat. The Content Catalog then displays the published design and revision.

The app checks content attachments after verifying which items the reply will show. If multiple items have designs, it tries them in the order the reply uses them, then tries the intent and capability attachments. The selected layout keeps the verified goal, balances, or other approved blocks and arranges the widgets around them.

### Link widgets into steps

Add each widget to the same layout. Expand the starting widget, open **Advanced (Badge, Progress Bar & CTA)**, and choose the destination under **On button click → Show another widget**. Give the button a label such as **See service impact**. Repeat on the next widget if you need more steps. **Layout preview** shows exactly one linked card at a time and adds **Back** after the first step.

Publish the layout with its chat attachment, then open the card in chat. The steps use the data that was resolved for that reply. To continue the conversation from the last step, use **Send a chat prompt** on that widget and fill in its button label and prompt.

### Publish an interactive experience

Use **New experience** in UI Builder when you want to connect a chat request directly to a registered sfield task and design the result. Choose the tenant’s workspace, the intended audience, and the version of each published read task. Add chat phrases with input placeholders such as `Track delivery {{orderId}}` and bind the card’s fields to that task’s result.

To try the full path, open **Templates → Wealth · Order tracking experience** and select **Alice Morgan** in **Experience preview**. Send **“Track shipment ORD-1001”** and click **Track delivery**. The button sends the displayed order ID to the same action as **“Track delivery ORD-1001”**. Change **Message shown in chat** to see how the copy can change while the task still receives the same order ID. An operator experience can bind a table to an array and configure **On row click** the same way.

Choose a **Field to watch** and a completion value when you want a record update in the original chat. The order template watches for `status = delivered`. A published thread restores its saved card, action inputs, and run state. The original card preserves the data shown at the time, and **Record updates** reports changes from the source. A new publication governs new typed requests. An existing clickable result keeps its original action and task versions while the result is current in the thread.

In **Logs**, open **Interactive experience** to inspect the publication revision, source message or click, structured inputs, sfield request and response, and saved completion state.

This authoring path supports synchronous read tasks and configured chat phrases. Customer experiences use member-scoped tasks and the public fields declared in their contracts. Operator experiences can also display and drill into tabular task results.

### Preview a design through the API

From the browser console on a signed-in admin page, run this example. It previews a design without saving a revision. The response is a `DisplayExperience`. Its first two block names should be `PznLayoutText` and `PznComparison`.

```js
const design = {
  name: "Balance definitions",
  description: "Explain available and current balances side by side.",
  layout: "dashboard",
  targets: [{ kind: "intent", id: "compare_balances" }],
  slots: [
    { kind: "text", id: "heading", heading: "How to read your balance", body: "", tone: "accent" },
    { kind: "block", id: "balances", component: "PznComparison" }
  ]
};
const response = await fetch("/api/admin/ui-layout-preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(design)
});
if (!response.ok) throw new Error(await response.text());
const display = await response.json();
console.log(display.blocks.map(block => block.component));
```

`GET /api/admin/ui-layouts` lists the caller's drafts, visible publications and attachment targets. To save, send `{ operation: "draft", domainId: "wealth", design }` to `POST /api/admin/ui-layouts`. To request publication, send `{ operation: "publish", domainId: "wealth", id, revision, design }` using the returned ID and revision. The `202` response includes the approval ID. Open `/admin/chat?review=<approvalId>` to review it. A `409` can mean the revision is stale or another publication owns the target. Read the current record before retrying.

### Bind values and handle clicks

The server keeps layout drafts and published revisions in `domain_ui_layouts` in the tenant's `app.sqlite` database. Widget Library entries live in `widget-library.json` for Wealth and `widget-library.<domain>.json` for other domains. The React implementation of each supported component ships with the app. Each chat turn saves the publication it used and the resulting display.

A **block** slot reuses a verified card. A **text** slot adds a heading or explanation. A **widget** slot can bind a metric to a key such as `portfolio.cash`. A **form** slot describes fields and can write back supported bindings when configured. Find existing keys and write support in `packages/contracts/data-bindings.ts`. The binding resolver is in `packages/customer-profiles/bindings.ts`. A static amount in widget copy stays static.

On each turn, `applyPublishedUi` in `packages/experience/ui-layout.ts` arranges matching blocks and appends verified blocks the layout did not place. It remaps issued actions to their displayed component IDs. A layout with no compatible result leaves the built-in view in place. `buildSurface` in `packages/experience/compile.ts` emits a validated A2UI `createSurface` message. The React catalog in `apps/web/surface.tsx` draws its components. A workflow button carries IDs issued for that surface. Its click goes back to the server for validation.

### Build a view without a saved design

Ask **“Build a savings calculator for $300 a month for 8 years.”**, **“Show my stock holdings as a bubble chart”**, **“I want to see drill down based on industry”**, or **“I want to set up another goal.”** The 4-stage Dynamic UI Harness (`apps/server/dynamic-ui-harness.ts` and `apps/server/dynamic-ui-generator.ts`) plans grounded data providers, fetches live records, composes native visual nodes (`metrics`, `chart`, `piechart`, `bubblechart`, `table`, `checklist`, `calculator`, `goal_creator`), and verifies/repairs the output before rendering in `apps/web/dynamic-canvas.tsx`.

- **Single Recommendation Authority**: Any follow-up recommendation CTA shown on a Dynamic Canvas card comes strictly from the host-governed `cep.recommendations.arbitrate@1.0.0` `sfield` tool (stamped with a provider provenance badge via `recommendationSource`). Hardcoded generator follow-ups are stripped, recent-buy sell contradictions are suppressed, and `excludePromotions: true` is enforced whenever `cep.empathy.assess@1.0.0` detects hardship in chat or Customer 360 `notes`.
- **Contextual Personalization**: `Store.finish` runs `applyPersonalization` (`apps/server/response-personalizer.ts`) using the customer's first name and `turn.emotionalState` so replies open naturally and empathetically instead of generic copy.
- **Unconnected Source Guard**: If a requested chart needs records and has no connected source, chat pauses with clickable clarification choices instead of fabricating numbers. Publish a recurring design from **UI Builder** when domain owners want to manage it.

### Stitch UI directly from `sfield` tools (`sf.surfaces` & `/api/surfaces/*`)

For screens or widgets that bind directly to registered `sfield` tools without custom server glue, `@sfield/core` provides **`SurfaceBinderService`** (`sf.surfaces`), exposed in CEP as three blind pass-through routes (`apps/server/routes/collaboration.ts`):

- `GET /api/surfaces/schemas` — returns auto-discovered bindable output/input paths from every registered `sfield` tool's closed JSON Schema.
- `POST /api/surfaces/stitch` — executes the declared read `sources` via `sfield`, resolves `$ref` (including `principal.identifiers.*`), `$repeat` (`$item` / `$index`), and deterministic formatters (`usd_cents`, `percent`, `date`), and returns a stitched surface with **HMAC-SHA256 sealed actions**.
- `POST /api/surfaces/action` — blindly forwards a clicked sealed action plus user `formInputs` back to `sf.surfaces.dispatchAction(...)`, which verifies the principal-bound seal, merges only declared `$input` slots, and handles `succeeded`, `pending_approval` (HITL), or `input_required` (MCP Elicitation).
- Try it interactively in **Administration → UI Builder → SurfaceBinder Lab** (`/admin/ui?view=surfaces`).

### Add a new component type in code

Use the home-buying goal card as a working example.

1. Define the props and data shape. Follow `goalProgressCard`, `catalogApis` and `DisplayBlock` in `packages/contracts/surface.ts`. The goal data contract in `packages/contracts/goal-progress.ts` specifies whole cents and chronological months.
2. Supply validated data in the relevant compiler. The `PznGoalProgress` case in `packages/experience/compile.ts` requires a verified goal read. Add composer-selectable types to `contentComponentCatalog` in `packages/contracts/domain.ts` and the enum in `packages/contracts/schemas/experience-proposal.schema.json`. The catalog supplies the choices in the Content Catalog and UI Builder. Set `allowedComponents` for each applicable content item and enforce the data requirements in `packages/experience/verify.ts`.
3. Add the React implementation to `pznCatalog` in `apps/web/surface.tsx` and support the canonical fallback there. The goal chart itself lives in `apps/web/goal-progress.tsx`. Supply compatible target and preview data in `apps/server/ui-layouts.ts`. Components used only in layouts can be listed directly in `layoutComponents` in `packages/contracts/ui-layout.ts`.
4. Check a real chat turn, its fallback rendering, and any issued controls after reordering. `tests/ui-layouts.test.ts` covers verification and publication. `tests/ui-builder-browser.ts` exercises preview, publication and the resulting customer screen.
