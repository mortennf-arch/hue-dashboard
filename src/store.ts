import type { HueEvent, HueResource } from "./hue-client.js";

/** Holder full tilstand i minnet og fletter inn endringer fra eventstream. */
export class ResourceStore {
  private readonly byId = new Map<string, HueResource>();

  replaceAll(resources: HueResource[]): void {
    this.byId.clear();
    for (const r of resources) this.byId.set(r.id, structuredClone(r));
  }

  apply(event: HueEvent): void {
    for (const r of event.data) {
      if (event.type === "delete") {
        this.byId.delete(r.id);
      } else if (event.type === "add" || !this.byId.has(r.id)) {
        this.byId.set(r.id, structuredClone(r));
      } else {
        deepMerge(this.byId.get(r.id)!, structuredClone(r));
      }
    }
  }

  get(id: string): HueResource | undefined {
    return this.byId.get(id);
  }

  all(): HueResource[] {
    return [...this.byId.values()];
  }

  /** Et lesbart navn: ressursens eget navn, ellers navnet på enheten eller rommet som eier den. */
  label(r: HueResource): string {
    const own = r.metadata?.name;
    if (own) return own;
    const stored = this.byId.get(r.id);
    if (stored?.metadata?.name) return stored.metadata.name;
    const owner = (r.owner ?? stored?.owner) as HueResource["owner"];
    const ownerRes = owner ? this.byId.get(owner.rid) : undefined;
    const ownerName = ownerRes?.metadata?.name;
    const controlId = stored?.metadata?.control_id ?? r.metadata?.control_id;
    if (ownerName && controlId !== undefined) return `${ownerName}, knapp ${controlId}`;
    if (ownerName) return ownerName;
    return r.id.slice(0, 8);
  }
}

export function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k];
    if (v && typeof v === "object" && !Array.isArray(v) && t && typeof t === "object" && !Array.isArray(t)) {
      deepMerge(t as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}
