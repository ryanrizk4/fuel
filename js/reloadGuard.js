// Every app-initiated reload shares the same unsaved-data boundary.
export function createReloadGuard({ isDirty, save, reload, notify }) {
  return () => {
    if (isDirty() && !save()) {
      notify("Your changes are still unsaved. Keep Fuel open and copy a backup or retry saving before refreshing.");
      return false;
    }
    reload();
    return true;
  };
}
