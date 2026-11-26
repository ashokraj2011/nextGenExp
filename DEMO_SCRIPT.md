# Investment customer walkthrough

Open customer chat at `/` and Administration at `/admin/logs` in another tab. Use the seeded customer profiles and the default Treatment Selector rules. Allow about two minutes for the customer story and three minutes for the calls behind it.

| Time | What to do | What to say |
| --- | --- | --- |
| 0:00–0:45 | Sign in as **Alice Morgan**, open **Retirement accounts** in the sidebar, and point to the two accounts in order. | “Alice holds a workplace 401(k) and a rollover IRA. She can ask about either of the accounts she sees here.” |
| 0:45–1:30 | Ask **“Who’s the beneficiary on the second one?”** Show the rollover IRA ending in **6105**, the empty designation and **Update your beneficiaries**. Open the steps. | “The account service confirms there’s no beneficiary on this IRA. Our existing Treatment Selector rule makes the reminder eligible for this account.” |
| 1:30–2:00 | Sign in as **Jordan Lee** in a separate browser session. Ask the same two questions. | “Jordan’s second account is his Roth IRA ending in 9281. Casey Lee is already named. Jordan gets his answer without an update reminder.” |
| 2:00–3:15 | In **Administration → Logs**, select Alice’s follow-up. Open **Context Router** and **Retirement account records**. | “The Context Router sees Alice’s question and her earlier account list in display order. sfield reads the selected record under Alice’s member ID.” |
| 3:15–4:20 | Expand **Treatment Selector**. Compare its request and returned IDs for Alice and Jordan. | “The selector receives the member ID, the learning context and the selected account ID. Its rule includes `beneficiary_update` for Alice’s IRA and excludes it for Jordan’s. An account’s designation can differ from other accounts held by the same person.” |
| 4:20–5:00 | Open **Experience Composer** on Alice’s turn, then return to her card. | “For Alice, the Experience Composer receives the eligible content. The app renders the account record and approved reminder together. For Jordan, the recorded beneficiary answers the question on its own.” |

The steps describe how to update a designation in account settings. To show continuity, reopen Alice’s account-list chat in a second signed-in session and ask the follow-up there.
