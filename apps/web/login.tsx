import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { DemoPersona } from "../../packages/contracts/api";
import { api } from "./api";
import coastalPhoto from "./assets/coastal-planning.jpg";
import { readProfileSession, saveProfileSession } from "./conversation-storage";
import { ProfileAvatar } from "./demo-profiles";
import { LabMark } from "./lab-mark";
import { ThemeToggle } from "./theme";
import "./login.css";

export function Login() {
  const [profiles, setProfiles] = useState<DemoPersona[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const chatPath = "/chat" + location.search;

  useEffect(() => {
    let mounted = true;
    void api.bootstrap().then(
      ({ personas }) => { if (mounted) setProfiles(personas); },
      () => { if (mounted) setLoadFailed(true); },
    );
    return () => { mounted = false; };
  }, [attempt]);

  function signIn(personaId: string) {
    if (!saveProfileSession(personaId)) {
      setNotice("Couldn’t save your profile in this tab. Please try again.");
      return;
    }
    const destination = new URL(chatPath, location.origin);
    if (!destination.searchParams.has("topic") && !destination.searchParams.has("view")) destination.searchParams.set("view", "overview");
    location.replace(destination.pathname + destination.search);
  }

  return <div className="login-page">
    <header className="login-header">
      <div className="login-brand">
        <LabMark small />
        <span className="rail-brand-text">
          <strong>CEP</strong>
          <small>Customer Engagement Platform</small>
        </span>
      </div>
      <ThemeToggle />
      {readProfileSession() !== "" && <a className="login-back" href={chatPath}><ArrowLeft size={16} aria-hidden="true" />Back to chat</a>}
    </header>
    <main className="login-layout">
      <section className="login-content" aria-labelledby="login-title">
        <h1 id="login-title">Sign in</h1>
        <p className="login-description">Choose a profile to open your chat.</p>
        {profiles && <ul className="login-profiles" aria-label="Available profiles">
          {profiles.map(({ personaId, displayName, profile }) => <li key={personaId}>
            <button type="button" className="login-profile" aria-label={"Sign in as " + displayName}
              aria-describedby={"login-account-" + personaId} onClick={() => signIn(personaId)}>
              <ProfileAvatar name={displayName} />
              <span>
                <strong>{displayName}</strong>
                <small id={"login-account-" + personaId}>{profile.accountFundingStatus === "funded" ? "Funded account" : "Awaiting first deposit"}</small>
              </span>
              <ArrowRight size={19} aria-hidden="true" />
            </button>
          </li>)}
        </ul>}
        {!profiles && (loadFailed ? <div className="login-status">
          <p role="alert">Couldn’t load profiles.</p>
          <button type="button" className="secondary-button" onClick={() => {
            setLoadFailed(false);
            setAttempt((value) => value + 1);
          }}>Try again</button>
        </div> : <p className="login-status" role="status">Loading profiles…</p>)}
        {notice && <p className="request-notice login-status" role="alert">{notice}</p>}
      </section>
      <div className="login-photo" aria-hidden="true">
        <img src={coastalPhoto} alt="" width={1536} height={1024} />
      </div>
    </main>
  </div>;
}
