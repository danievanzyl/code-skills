import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STATUS_REGISTER_EVENT = "status-window:register";
export const STATUS_UNREGISTER_EVENT = "status-window:unregister";
export const STATUS_INVALIDATE_EVENT = "status-window:invalidate";
export const STATUS_REQUEST_EVENT = "status-window:request-registrations";

export type StatusTone = "text" | "accent" | "muted" | "dim" | "success" | "warning" | "error";

export interface StatusRow {
	label?: string;
	text: string;
	tone?: StatusTone;
	icon?: string;
	indent?: number;
}

export interface StatusSectionSnapshot {
	title: string;
	icon?: string;
	rows: StatusRow[];
	footer?: string;
}

export interface StatusSection {
	id: string;
	priority?: number;
	visible?: () => boolean;
	getSnapshot: () => StatusSectionSnapshot;
}

export function publishStatusSection(pi: ExtensionAPI, section: StatusSection): void {
	pi.events.emit(STATUS_REGISTER_EVENT, section);
}

export function invalidateStatusSection(pi: ExtensionAPI, id: string): void {
	pi.events.emit(STATUS_INVALIDATE_EVENT, { id });
}

export function removeStatusSection(pi: ExtensionAPI, id: string): void {
	pi.events.emit(STATUS_UNREGISTER_EVENT, { id });
}
