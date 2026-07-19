export function companionSetupLink(address: string, profile = "default"): string {
  const host = new URL(address);
  if (
    host.protocol !== "https:"
    || host.username !== ""
    || host.password !== ""
    || host.pathname !== "/"
    || host.search !== ""
    || host.hash !== ""
  ) {
    throw new Error("Companion setup requires a root HTTPS host address.");
  }
  const normalizedProfile = profile.trim() || "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalizedProfile)) {
    throw new Error("Companion setup profile is invalid.");
  }
  const query = new URLSearchParams({ address: host.origin });
  if (normalizedProfile !== "default") query.set("profile", normalizedProfile);
  return `t4companion://?${query.toString()}`;
}
