export class NotificationListCoordinator<T extends { id: string }> {
  private items: T[] = [];
  private loadRevision = 0;
  private readonly activeItemMutations = new Set<string>();

  beginLoad(): number {
    this.loadRevision += 1;
    return this.loadRevision;
  }

  isCurrentLoad(revision: number): boolean {
    return revision === this.loadRevision;
  }

  invalidateLoads(): void {
    this.loadRevision += 1;
  }

  replace(items: T[]): T[] {
    this.items = [...items];
    return this.items;
  }

  replaceAfterMutation(items: T[]): T[] {
    this.invalidateLoads();
    return this.replace(items);
  }

  merge(item: T): T[] {
    this.invalidateLoads();
    this.items = this.items.map((current) => current.id === item.id ? item : current);
    return this.items;
  }

  remove(id: string): T[] {
    this.invalidateLoads();
    this.items = this.items.filter((item) => item.id !== id);
    return this.items;
  }

  beginItemMutation(id: string): boolean {
    if (this.activeItemMutations.has(id)) return false;
    this.activeItemMutations.add(id);
    this.invalidateLoads();
    return true;
  }

  endItemMutation(id: string): void {
    this.activeItemMutations.delete(id);
  }
}

export function shouldActivateLinkedNotification(
  eventType: "click" | "auxclick",
  button: number
): boolean {
  return eventType === "click" ? button === 0 : button === 1;
}
