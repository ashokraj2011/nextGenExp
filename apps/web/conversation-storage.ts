const activeConversationKey = "pzn-active-conversation";

export function readActiveConversation() {
  try { return localStorage.getItem(activeConversationKey); } catch { return null; }
}

export function rememberActiveConversation(id: string) {
  try { localStorage.setItem(activeConversationKey, id); } catch { /* Storage may be restricted. */ }
}
