export interface Me {
  readonly id: string;
  readonly handle: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: "publisher" | "moderator";
}

export async function fetchAccountConfig(): Promise<{
  oidc: boolean;
  providerName: string;
}> {
  try {
    const res = await fetch("/account/config", { credentials: "same-origin" });
    if (!res.ok) return { oidc: false, providerName: "Takosumi Accounts" };
    return (await res.json()) as { oidc: boolean; providerName: string };
  } catch {
    return { oidc: false, providerName: "Takosumi Accounts" };
  }
}

export async function fetchMe(): Promise<Me | null> {
  try {
    const res = await fetch("/account/me", { credentials: "same-origin" });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    return ((await res.json()) as { publisher: Me }).publisher;
  } catch {
    return null;
  }
}

export async function setHandle(
  handle: string,
): Promise<{ ok: true; me: Me } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch("/account/handle", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
  } catch {
    return { ok: false, message: "Network error" };
  }
  if (res.ok) {
    return {
      ok: true,
      me: ((await res.json()) as { publisher: Me }).publisher,
    };
  }
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return { ok: false, message: body?.error?.message ?? `error ${res.status}` };
}

export async function logout(): Promise<boolean> {
  try {
    const res = await fetch("/account/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function loginUrl(returnTo: string): string {
  return `/account/login?return=${encodeURIComponent(returnTo)}`;
}
