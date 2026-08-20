// Minimal URL query-param sync (no router dependency). Used to make the active
// tab and selected store deep-linkable and refresh-stable.

export function getSearchParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/** Set or delete a query param via replaceState (no history spam / navigation). */
export function setSearchParam(name: string, value: string | null): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (value == null || value === '') params.delete(name);
    else params.set(name, value);
    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  } catch {
    // history API unavailable — non-fatal
  }
}
