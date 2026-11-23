import { useEffect, useState } from "react";
import { capabilityRef, type CapabilityManifest } from "../../packages/contracts/agentic";
import { api, toolSetupErrorMessage } from "./api";
import { readProfileSession, rememberActiveConversation, saveProfileSession } from "./conversation-storage";

type Setup = Awaited<ReturnType<typeof api.capabilities>>;
function Studio({ initial }: { initial: Setup }) {
  const [manifests, setManifests] = useState(initial.manifests);
  const [selected, setSelected] = useState(capabilityRef(manifests[0]));
  const [draft, setDraft] = useState(JSON.stringify(manifests[0], null, 2));
  const [persona, setPersona] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof api.bootstrap>>["personas"]>([]);
  const [eventId] = useState(() => "event_" + crypto.randomUUID().replaceAll("-", ""));
  const chosen = manifests.find((item) => capabilityRef(item) === selected) ?? manifests[0];
  useEffect(() => {
    void api.bootstrap().then(({ personas, defaultPersonaId }) => {
      setProfiles(personas);
      setPersona(defaultPersonaId);
    }).catch((reason) => setError(toolSetupErrorMessage(reason)));
  }, []);

  function select(manifest: CapabilityManifest) {
    setSelected(capabilityRef(manifest));
    setDraft(JSON.stringify(manifest, null, 2));
    setNotice("");
    setError("");
  }
  async function run(task: () => Promise<void>) {
    setNotice("");
    setError("");
    setBusy(true);
    try { await task(); }
    catch (reason) {
      setError(reason instanceof SyntaxError ? "The manifest is missing valid JSON." : toolSetupErrorMessage(reason));
    } finally { setBusy(false); }
  }
  async function publish(validate: boolean) {
    await run(async () => {
      const normalized = await api.publishCapability(JSON.parse(draft), validate);
      if (validate) {
        setNotice("Manifest is valid.");
        return;
      }
      setManifests((items) => items.some((item) => capabilityRef(item) === capabilityRef(normalized)) ? items : [...items, normalized]);
      select(normalized);
      setNotice("Version published.");
    });
  }
  async function preview() {
    await run(async () => {
      const { conversation } = await api.previewCapability({ id: chosen.id, version: chosen.version }, persona, message);
      if (readProfileSession() !== null) saveProfileSession(conversation.personaId);
      rememberActiveConversation(conversation.id);
      location.assign("/chat");
    });
  }
  async function simulate() {
    await run(async () => {
      const result = await api.simulateFirstDeposit(persona, eventId);
      setNotice(result.accepted
        ? "First deposit recorded. Return to this profile in chat and ask what’s next."
        : "A first deposit is already recorded for this profile.");
      const state = await api.bootstrap();
      setProfiles(state.personas);
    });
  }
  return <section className="admin-card axe-studio" aria-labelledby="capability-studio-title">
    <h2 id="capability-studio-title">Capability Studio</h2>
    <fieldset disabled={busy} className="axe-studio-controls">
      <div className="axe-fields">
        <div className="axe-field">
          <label htmlFor="capability-version">Published capability</label>
          <select id="capability-version" value={selected} onChange={(event) => {
            const item = manifests.find((entry) => capabilityRef(entry) === event.target.value);
            if (item) select(item);
          }}>{manifests.map((item) => <option key={capabilityRef(item)} value={capabilityRef(item)}>{item.title} · {item.version}</option>)}</select>
        </div>
        <div className="axe-field"><label htmlFor="capability-profile">Profile for preview</label>
          <select id="capability-profile" value={persona} onChange={(event) => setPersona(event.target.value)}>
            {profiles.map(({ personaId, displayName }) => <option key={personaId} value={personaId}>{displayName}</option>)}
          </select>
        </div>
      </div>
      <div className="axe-field">
        <label htmlFor="capability-manifest">Capability manifest</label>
        <textarea id="capability-manifest" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} />
      </div>
      <div className="axe-form-actions">
        <button className="secondary-button" type="button" onClick={() => void publish(true)}>Validate manifest</button>
        <button className="secondary-button" type="button" onClick={() => void publish(false)}>Publish version</button>
      </div>
      <details className="trace-details">
        <summary>Registered tools and checks</summary>
        <ul>{initial.tools.map(({ ref, label, invariant }) => (
          <li key={ref}>{label} <code>{ref}</code><br />Check <code>{invariant}</code></li>
        ))}</ul>
      </details>
      <div className="axe-field">
        <label htmlFor="capability-request">Preview request</label>
        <input id="capability-request" type="text" value={message} maxLength={1600} onChange={(event) => setMessage(event.target.value)} />
      </div>
      <div className="axe-form-actions">
        <button className="secondary-button" type="button" disabled={!message.trim() || !persona} onClick={() => void preview()}>Run capability in chat</button>
        {profiles.some(({ personaId, profile }) => personaId === persona && profile.accountFundingStatus === "unfunded") && (
          <button className="secondary-button" type="button" onClick={() => void simulate()}>Simulate first deposit</button>
        )}
      </div>
    </fieldset>
    <Evaluation />
    {notice && <p role="status">{notice}</p>}
    {error && <p className="admin-error" role="alert">{error}</p>}
  </section>;
}

function Evaluation() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.evaluation>>>();
  const [status, setStatus] = useState("");
  async function read() {
    setStatus("Loading recent turns…");
    try { setData(await api.evaluation()); setStatus(""); }
    catch (reason) { setStatus(toolSetupErrorMessage(reason)); }
  }
  return <details className="trace-details axe-evaluation" onToggle={(event) => {
    if (event.currentTarget.open && !data && !status) void read();
  }}>
    <summary>Evaluation</summary>
    <p>Up to 40 recent chat turns in this session.</p>
    {status && <p role="status">{status}</p>}
    {data?.rows.some(({ turns }) => turns) ? <div className="axe-evaluation-table">
      <table aria-label={data.mode === "test" ? "Test mode results" : "Live model results"}>
        <thead><tr><th>Path</th><th>Completed</th><th>Median time</th><th>Model calls</th><th>Tool calls</th><th>Tokens</th></tr></thead>
        <tbody>{data.rows.map(({ path, turns, completed, medianMs, modelCalls, toolCalls, tokens }) => (
          <tr key={path}><th scope="row">{path === "fast" ? "Simple" : "Multi-step"}</th><td>{completed} / {turns}</td>
            <td>{medianMs === null ? "—" : (medianMs / 1000).toFixed(2) + " s"}</td><td>{modelCalls}</td><td>{toolCalls}</td><td>{tokens.toLocaleString()}</td></tr>
        ))}</tbody>
      </table>
    </div> : data && <p>Send a chat message to measure a turn.</p>}
    <button className="secondary-button" type="button" disabled={status === "Loading recent turns…"} onClick={() => void read()}>Refresh results</button>
  </details>;
}

export function CapabilityStudio() {
  const [setup, setSetup] = useState<Setup>();
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    void api.capabilities().then((result) => { if (mounted) setSetup(result); })
      .catch((reason) => { if (mounted) setError(toolSetupErrorMessage(reason)); });
    return () => { mounted = false; };
  }, []);
  return setup ? <Studio initial={setup} /> : error ? <p role="alert">{error}</p> : null;
}
