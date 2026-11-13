"use client";

import { useSyncExternalStore } from "react";
import {
	resolveDictation, sanitizeUserSettings,
	type DictationLanguage, type DictationSettings, type EffectiveDictation, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

const INITIAL = {
	language: undefined as DictationLanguage | undefined,
	/** The whole section resolved (engine, Whisper config, language). */
	settings: undefined as EffectiveDictation | undefined,
	saving: false,
	error: null as string | null,
};

/** A patch to the dictation section; `whisper` merges field-by-field. */
export type DictationPatch = Omit<DictationSettings, "whisper"> & { whisper?: DictationSettings["whisper"] };

/** One confirmed dictation section and one write in flight, shared by every
 * surface. The section PUT is replace-whole, so every save sends the stored
 * section with the patch merged in — a language change can never erase the
 * engine/Whisper fields, and vice versa. The factory keeps transport tests
 * isolated without a second persistence path.
 */
export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	let snapshot = INITIAL;
	/** The stored delta, as last confirmed by the server. */
	let stored: DictationSettings = {};
	let reading: Promise<DictationLanguage> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof INITIAL>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};
	const confirm = (section: DictationSettings) => {
		stored = section;
		const settings = resolveDictation(section);
		needsRead = false;
		publish({ language: settings.language, settings, error: null });
		return settings;
	};

	function load(refresh = false): Promise<DictationLanguage> {
		if (writing) return getLanguage();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.language !== undefined) return Promise.resolve(snapshot.language);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return getLanguage();
				return confirm(record?.dictation ?? {}).language;
			} catch {
				if (version !== revision) return getLanguage();
				const message = "Could not load dictation settings. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	function update(patch: DictationPatch, failure = "Could not save dictation settings. Try again."): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.language === undefined) return Promise.resolve(false);
		revision++;
		reading = null;
		const next: DictationSettings = { ...stored, ...patch };
		if (patch.whisper) next.whisper = { ...stored.whisper, ...patch.whisper };
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				});
				if (!res.ok) {
					// A validation refusal (bad URL/model) says what's wrong.
					const detail = await res.json().then((b: { error?: unknown }) => b?.error, () => undefined);
					throw new Error(typeof detail === "string" ? `${failure.replace(/\. Try again\.$/, "")}: ${detail}` : failure);
				}
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.dictation;
				if (confirmed === null || typeof confirmed !== "object") throw new Error(failure);
				const record = sanitizeUserSettings({ version: 1, dictation: confirmed });
				confirm(record?.dictation ?? {});
				saved();
				return true;
			} catch (e) {
				publish({ error: e instanceof Error && e.message ? e.message : failure });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	function save(language: DictationLanguage): Promise<boolean> {
		return update({ language }, "Could not save dictation language. Try again.");
	}

	async function getLanguage(): Promise<DictationLanguage> {
		return (await getSettings()).language;
	}

	/** The confirmed section — waits out any write/read in flight. */
	async function getSettings(): Promise<EffectiveDictation> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.settings === undefined) await load();
			else return snapshot.settings;
		}
	}

	return {
		load, save, update, getLanguage, getSettings,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

export function useDictationLanguage() {
	const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getServerSnapshot);
	return {
		...snapshot,
		load: store.load, save: store.save, update: store.update,
		getLanguage: store.getLanguage, getSettings: store.getSettings,
	};
}
