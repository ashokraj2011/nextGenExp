const activeConversationKey = "pzn-active-conversation";
const profileSessionKey = "pzn-profile-session";

export function readActiveConversation() {
  try { return localStorage.getItem(activeConversationKey); } catch { return null; }
}

export function rememberActiveConversation(id: string) {
  try { localStorage.setItem(activeConversationKey, id); } catch { /* Storage may be restricted. */ }
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
