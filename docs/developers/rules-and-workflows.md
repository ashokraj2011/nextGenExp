## Attach a workflow to a Treatment Selector rule

Marcus’s address update is an end-to-end example of two independent decisions. The intent model identifies an address update. Treatment Selector (TS) checks Marcus’s MID and that topic to determine which content, action and workflow apply. sfield executes the recommended workflow when Marcus clicks its button.

### Map an intent to a TS topic

In **Intents & Catalog**, give the intent a stable ID, display label, task type, router description and example phrases. Select its **TS Rule Group (Context)** and enable the intent. For example, `update_address` maps to `address-update`. The app's flow list in **Tool setup → Chat routing flows** determines which flows this domain and audience can enter. The intent catalog determines which tasks are available inside account help.

Before the intent call, `contexts.list@1.0.0` loads active TS topics, including published self-service contexts. `propensity.context.score@1.0.0` requests scores for the member and those topics. `availableRoutingIntents` in `packages/contracts/routing-intents.ts` filters the intent list against the active topics. In Logs, check `intentCatalog` in the router request if the new task is missing. Attach a published layout to the same intent ID in UI Builder when it needs its own presentation.

### Configure the rule and run it

1. In **Administration → Tool setup**, choose the Wealth address-update context. Edit **Account is unfunded** for `fund_account`. Its glossary condition is `account.funding_status == "unfunded"`. Choose **Preview funding** under **Workflow on click**, then update the rule. The built-in address rule also requires `address_update_guide` to be eligible for the workflow.
2. In the funding workflow settings choose **Saved tool order** under **How to run funding preview**. Add **Check funding status** first, then **Funding options**, then **Build funding preview**. Save settings. **Agent-guided** is a separate mode in which the model chooses among the enabled tools and can ask for a funding method.
3. Sign in as **Marcus Reed** with an unfunded account and ask **“I moved and need to update my address.”** Open the source turn in **Logs**. It shows both the rule for the standalone address action and the rule for the funding workflow.
4. Click **Preview funding** in chat and open the linked click in Logs. The child turn records the sfield calls in their saved order. Previewing the method leaves the account unfunded.

### Read the TS decision

For the built-in Wealth rules and an unfunded Marcus, the member-level request is `{ "mid": "DEMO-MID-1003", "context": "address-update" }`. The legacy result is `["address_update_guide", "fund_account"]`. The equivalent chat decision has this shape.

```json
{
  "schemaVersion": "2.1",
  "recommendations": [
    { "kind": "content", "id": "address_update_guide" },
    { "kind": "content", "id": "fund_account" },
    { "kind": "action", "id": "account.address.prepare", "version": "1.0.0" },
    {
      "kind": "workflow",
      "id": "account.funding.preview",
      "version": "1.0.0",
      "forContentIds": ["fund_account"]
    }
  ]
}
```

`forContentIds` ties the funding button to displayed eligible content. Tool names and execution order are saved on the sfield side. `fixtures/treatment-scenarios.json` contains the starter rules. `packages/ts-adapter/index.ts` applies the mock CCRE conditions and builds the decision. `packages/contracts/funding-workflow.ts` defines both the response schema and the available funding steps.

To integrate a real TS service, start at the adapter in `packages/ts-adapter/index.ts`. Its `TsAdapter` interface covers listing topics, member scores and ranked content IDs. The current chat path also uses the concrete adapter's richer `selectEligibleContent` result for typed recommendations and rule evidence. Wire that decision into `Runtime.treatmentAdapter`, the sign-in lookup in `apps/server/workspace-actions.ts` and the authoring preview in `apps/server/tool-setup.ts` so the three entry points agree.

### Read the workflow the host resolves

Tool setup stores the three selected steps in this `fundingWorkflow` value.

```json
{
  "id": "account.funding.preview",
  "version": "1.0.0",
  "steps": [
    "funding.status.read@1.0.0",
    "funding.options.read@1.0.0",
    "funding.preview.build@1.0.0"
  ]
}
```

An omitted `mode` selects saved order, and the contract also accepts `"mode": "ordered"`. The server validates the issued action, source experience and workflow reference. `runCustomerWorkflow` in `apps/server/service.ts` resolves that ID and version and starts a scoped sfield run. Each step uses the result of the previous check.

| Tool | Inputs | Output used next |
| --- | --- | --- |
| `funding.status.read` | Child `turnRef` | `accountFundingStatus`. A funded account stops the ordered preview. |
| `funding.options.read` | Same `turnRef` | Eligible `methods`, `amountCents` and `currency`. |
| `funding.preview.build` | Same `turnRef` and the first returned `methodId` in ordered mode | A validated `preview` with that method, amount and currency. |

To add a different customer workflow, register its ID, version and label in `packages/contracts/customer-workflows.ts`. Provide the tool mapping, definition, availability checks and host execution branch, and compile its result into a supported surface. The rule editor can attach registered workflows. Its funding step editor currently accepts only the funding tool references declared in `fundingWorkflowDefinitionSchema`. Alice’s `retirement.beneficiary.review@1.0.0` shows how a second registered workflow runs `retirement.accounts.read@1.0.0` for her selected account.

### Verify the next visit

Use the mock account portal at `/portal/funding` to confirm Marcus’s first deposit. After he signs in again, inspect **Logs → Pending actions** for his MID and `pending-actions`. Ask **“What’s next?”** and inspect the new chat decision for `next-step`. The confirmed funding status makes the same rule exclude the reminder. Comparing these turns distinguishes a completed deposit from a previous preview.

For an empty or unexpected result, inspect the source turn's flow and intent, then its exact TS context, rule outcome and content IDs. If a card appeared without its button, check the displayed content, the registered version and whether its tools were enabled. For failures after clicking, inspect the child turn's first unsuccessful tool call. The ordered workflow and a workflow suppressed by eligibility are covered in `tests/host.test.ts`. Sign-in reminders and portal confirmation are covered in `tests/workspace.test.ts`.
