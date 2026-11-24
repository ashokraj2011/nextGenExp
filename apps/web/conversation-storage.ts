const activeConversationKey = "pzn-active-conversation";
const adminConversationKey = "pzn-active-admin-conversation";
const profileSessionKey = "pzn-profile-session";

export function readActiveConversation(admin = false) {
  try { return localStorage.getItem(admin ? adminConversationKey : activeConversationKey); } catch { return null; }
}

export function rememberActiveConversation(id: string | null, admin = false) {
  const key = admin ? adminConversationKey : activeConversationKey;
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
