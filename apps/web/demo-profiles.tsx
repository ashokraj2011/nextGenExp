import { useState } from "react";
import { ArrowRight, UsersRound } from "lucide-react";
import type { DemoPersona } from "../../packages/contracts/api";
import { formatPortfolioAmount } from "../../packages/contracts/portfolio";
import { DeveloperDrawer } from "./developer-drawer";

export function ProfileAvatar({ name }: { name: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase();
  return <span className="profile-avatar" aria-hidden="true">{initials}</span>;
}

export function DemoProfiles({ personas, activePersonaId, pending, close, startChat }: {
  personas: DemoPersona[];
  activePersonaId: string;
  pending: boolean;
  close: () => void;
  startChat: (personaId: string) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  async function start(personaId: string) {
    setFailed(false);
    if (await startChat(personaId)) close();
    else setFailed(true);
  }

  return <DeveloperDrawer title="Demo profiles" icon={<UsersRound size={17} />} closeLabel="Close demo profiles" close={close} wide>
    <div className="profile-grid">
      {personas.map(({ personaId, displayName, profile }) => {
        const active = activePersonaId === personaId;
        const titleId = "profile-" + personaId;
        return <article key={personaId} className={"profile-card" + (active ? " profile-current" : "")} aria-labelledby={titleId}>
          <header>
            <ProfileAvatar name={displayName} />
            <div><h3 id={titleId}>{displayName}</h3><p>{profile.focus}</p></div>
            {active && <p className="profile-current-label">Current</p>}
          </header>
          <p className="profile-summary">{profile.summary}</p>
          <dl className="profile-facts">
            <div><dt>Portfolio cash</dt><dd>{profile.cashCents === null ? "Unavailable" : formatPortfolioAmount(profile.cashCents)}</dd></div>
            <div><dt>Beneficiaries</dt><dd className={profile.beneficiaryStatus === "missing" ? "profile-missing" : undefined}>
              {profile.beneficiaryStatus === "missing" ? "Missing" : "On file"}
            </dd></div>
          </dl>
          <button className="secondary-button" type="button" disabled={pending} aria-label={"Start chat as " + displayName}
            onClick={() => void start(personaId)}>Start chat <ArrowRight size={15} aria-hidden="true" /></button>
        </article>;
      })}
    </div>
    {failed && <p className="request-notice profile-notice" role="alert">Couldn’t start a chat. Please try again.</p>}
  </DeveloperDrawer>;
}
