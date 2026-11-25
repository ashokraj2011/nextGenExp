import { ArrowRight, MessageCircle } from "lucide-react";
import coastalPhoto from "./assets/coastal-planning.jpg";
import { planningTopics } from "./planning-topics";
import { ThemeToggle } from "./theme";
import "./landing.css";

export function Landing() {
  return <div className="planning-home">
    <header className="planning-header">
      <div className="planning-width planning-header-inner">
        <a className="planning-home-link" href="/planning" aria-current="page">Financial planning</a>
        <nav className="planning-nav" aria-label="Planning topics">
          {planningTopics.map(({ id, name }) => <a key={id} href={"/chat?topic=" + id}>{name}</a>)}
        </nav>
        <div className="planning-header-actions">
          <ThemeToggle compact />
          <a className="planning-header-action" href="/chat">
            <MessageCircle size={17} aria-hidden="true" /> Ask the assistant
          </a>
        </div>
      </div>
    </header>
    <main className="planning-width planning-main">
      <section className="planning-hero" aria-labelledby="planning-title">
        <div className="planning-hero-copy">
          <h1 id="planning-title">Plan for <em>what’s next.</em></h1>
          <p>Review your portfolio, explore retirement, and find a next step based on your profile.</p>
          <div className="planning-hero-actions">
            <a className="planning-primary" href="/chat">Start a conversation <ArrowRight size={17} aria-hidden="true" /></a>
            <a className="planning-secondary" href="/chat?view=profiles">Compare profiles</a>
          </div>
        </div>
        <div className="planning-hero-media">
          <img src={coastalPhoto} alt="Two women walking together along a coastal path" width={1536} height={1024} fetchPriority="high" />
        </div>
      </section>
      <section className="planning-topics" aria-labelledby="planning-topics-title">
        <h2 id="planning-topics-title">Explore a topic</h2>
        <div className="planning-topic-grid">
          {planningTopics.map(({ id, title, description, Icon }) => (
            <a key={id} href={"/chat?topic=" + id} className="planning-topic">
              <span className="planning-topic-icon"><Icon size={21} aria-hidden="true" /></span>
              <div><h3>{title}</h3><p>{description}</p></div>
              <ArrowRight className="planning-topic-arrow" size={18} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>
    </main>
  </div>;
}
