import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Wallet } from "lucide-react";
import type { PortalFundingView } from "../../packages/contracts/workspace";
import { api, RequestError, toolSetupErrorMessage } from "./api";
import { saveProfileSession } from "./conversation-storage";
import "./funding-portal.css";

export function FundingPortal() {
  const conversationId = new URLSearchParams(location.search).get("conversationId");
  const backToChat = conversationId ? "/chat?" + new URLSearchParams({ conversationId }) : "/chat?view=overview";
  const [account, setAccount] = useState<PortalFundingView>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void api.portalFunding().then((view) => { if (current) setAccount(view); }, (cause) => {
      if (!current) return;
      if (cause instanceof RequestError && cause.code === "profile_required") {
        location.replace("/login?" + new URLSearchParams({ returnTo: "funding", ...(conversationId && { conversationId }) }));
      }
      else setError(toolSetupErrorMessage(cause));
    });
    return () => { current = false; };
  }, [attempt, conversationId]);

  async function confirm() {
    if (!account || busy) return;
    setBusy(true); setError("");
    try { setAccount(await api.confirmPortalFunding(account.personaId)); }
    catch (cause) { setError(toolSetupErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError("");
    try {
      await api.selectProfile(null);
      saveProfileSession(null);
      location.replace("/login");
    } catch (cause) { setError(toolSetupErrorMessage(cause)); setBusy(false); }
  }

  return <main className="funding-portal">
    <header><span><Wallet size={20} aria-hidden="true" /> Mock account portal</span>
      {account && <button type="button" className="secondary-button" disabled={busy} onClick={() => void signOut()}>Sign out</button>}
    </header>
    <section className="content-card" aria-labelledby="funding-title">
      <h1 id="funding-title">Account funding</h1>
      {account ? <>
        <p className="portal-owner">{account.displayName}</p>
        {account.fundingStatus === "funded" ? <div role="status" className="portal-confirmation">
          <CheckCircle2 size={22} aria-hidden="true" /><div><strong>Account funded</strong>
            {account.confirmation && <p>First deposit confirmed on <time dateTime={new Date(account.confirmation.occurredAt).toISOString()}>
              {new Date(account.confirmation.occurredAt).toLocaleString()}</time>.</p>}
          </div>
        </div> : <>
          <h2>Awaiting first deposit</h2>
          <p>Mark the first deposit as received to update this account’s funding status in chat. This records a simulated deposit.</p>
          <button className="portal-confirm" type="button" disabled={busy} onClick={() => void confirm()}>Mark account funded</button>
        </>}
      </> : !error && <p role="status">Loading your account…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" className="secondary-button" disabled={busy} onClick={() => {
        setAccount(undefined); setError(""); setAttempt((value) => value + 1);
      }}>Reload account</button></div>}
    </section>
    <a href={backToChat}><ArrowLeft size={16} aria-hidden="true" />Back to chat</a>
  </main>;
}
