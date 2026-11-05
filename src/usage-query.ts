// This function is serialized into the Codex renderer, where query objects live.
// Account identifiers stay in that renderer and are never logged or exported.
export function selectUsageQuery(queries: any[]): any | undefined {
  const valid = queries.filter((q) => {
    const key = q?.queryKey;
    const data = q?.state?.data?.rate_limit;
    return Array.isArray(key) && key[0] === "rate-limit-status" &&
      (key.length === 1 || (key.length === 3 && typeof key[1] === "string" && key[1].startsWith("user-") && typeof key[2] === "string" && key[2].length > 0)) &&
      data && typeof data === "object" && (data.primary_window || data.secondary_window) && q.state.status === "success";
  });
  const scoped = valid.filter((q) => q.queryKey.length === 3);
  const active = scoped.filter((q) => typeof q.getObserversCount === "function" && q.getObserversCount() > 0);
  if (active.length) {
    const identities = new Set(active.map((q) => JSON.stringify(q.queryKey.slice(1))));
    if (identities.size !== 1) return undefined;
    return active.sort((a, b) => (Number(b.state.dataUpdatedAt) || 0) - (Number(a.state.dataUpdatedAt) || 0))[0];
  }
  // Once Codex exposes account-scoped entries, an inactive entry cannot prove
  // which account is current; avoid silently displaying another account.
  if (queries.some((q) => Array.isArray(q?.queryKey) && q.queryKey.length === 3 && q.queryKey[0] === "rate-limit-status" && typeof q.queryKey[1] === "string" && q.queryKey[1].startsWith("user-") && typeof q.queryKey[2] === "string" && q.queryKey[2].length > 0)) return undefined;
  return valid.find((q) => q.queryKey.length === 1);
}
