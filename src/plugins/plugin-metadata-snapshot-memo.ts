let clearPluginMetadataSnapshotMemo: (() => void) | undefined;

export function registerPluginMetadataSnapshotMemoClear(fn: () => void): void {
  clearPluginMetadataSnapshotMemo = fn;
}

export function clearRegisteredPluginMetadataSnapshotMemo(): void {
  clearPluginMetadataSnapshotMemo?.();
}
