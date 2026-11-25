import type { DomainPackId } from "../../packages/contracts/domain-packs";

const activeConversationKey = "pzn-active-conversation";
const adminConversationKey = "pzn-active-admin-conversation";
const profileSessionKey = "pzn-profile-session";

function threadKey(admin: boolean, domainId: DomainPackId) {
  const key = admin ? adminConversationKey : activeConversationKey;
  return domainId === "wealth" ? key : key + ":" + domainId;
}

export function readActiveConversation(admin = false, domainId: DomainPackId = "wealth") {
  try { return localStorage.getItem(threadKey(admin, domainId)); } catch { return null; }
}

export function rememberActiveConversation(id: string | null, admin = false, domainId: DomainPackId = "wealth") {
  const key = threadKey(admin, domainId);
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch { /* Storage may be restricted. */ }
}

// A missing entry opens chat directly. An empty entry records a sign-out.
export function readProfileSession() {
  try { return sessionStorage.getItem(profileSessionKey); } catch { return null; }
}

export function saveProfileSession(personaId: string | null) {
  try {
    sessionStorage.setItem(profileSessionKey, personaId ?? "");
    return true;
  } catch {
    return false;
  }
}
