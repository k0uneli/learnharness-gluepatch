"use client";

import { WHISPER_DEFAULTS, type DictationEngine, type WhisperMode } from "@/src/core";
import { CommitInput, SettingsRow, ThinSelect } from "@/components/settings/controls";
import { useDictationActive } from "@/components/dictation-state";
import { useDictationLanguage } from "@/components/dictation-preference";

/* Settings → Providers → Dictation: the engine choice and, for the
 * self-hosted Whisper engine, its server/model/mode. Every control shares
 * the one dictation store (one write in flight, replace-whole section PUT
 * with the rest of the section merged in) and locks while a run is live,
 * like the Language picker. */

const ENGINE_LABELS: Record<DictationEngine, string> = {
	deepgram: "Deepgram (cloud)",
	whisper: "Whisper (self-hosted)",
};

const MODE_LABELS: Record<WhisperMode, string> = {
	upload: "Upload on stop",
	stream: "Live stream",
};

/** The engine the Dictation group should lay out for (Deepgram until the
 *  saved section has loaded). */
export function useDictationEngine(): DictationEngine {
	return useDictationLanguage().settings?.engine ?? "deepgram";
}

export function DictationEngineSetting() {
	const { settings, saving, update } = useDictationLanguage();
	const active = useDictationActive();
	const locked = active || saving || settings === undefined;
	return <SettingsRow label="Engine" testid="row-dictation-engine" dimmed={active}>
		<ThinSelect
			value={settings?.engine ?? "deepgram"}
			onChange={(next) => { void update({ engine: next as DictationEngine }); }}
			ariaLabel="Dictation engine"
			testid="dictation-engine"
			disabled={locked}
		>
			{(Object.keys(ENGINE_LABELS) as DictationEngine[]).map((engine) => (
				<option key={engine} value={engine}>{ENGINE_LABELS[engine]}</option>
			))}
		</ThinSelect>
	</SettingsRow>;
}

/** Server / Model / Mode rows — shown only while the engine is Whisper. */
export function WhisperSettings() {
	const { settings, saving, error, update } = useDictationLanguage();
	const active = useDictationActive();
	const locked = active || saving || settings === undefined;
	const whisper = settings?.whisper;
	return <>
		<SettingsRow label="Server" hint="OpenAI-compatible Whisper URL" testid="row-whisper-url" dimmed={active}>
			<CommitInput
				value={whisper?.url ?? ""}
				placeholder={WHISPER_DEFAULTS.url}
				onCommit={(url) => { void update({ whisper: { url: url || WHISPER_DEFAULTS.url } }); }}
				ariaLabel="Whisper server URL"
				testid="whisper-url"
				disabled={locked}
				className="w-56"
			/>
		</SettingsRow>
		<SettingsRow label="Model" testid="row-whisper-model" dimmed={active}>
			<CommitInput
				value={whisper?.model ?? ""}
				placeholder={WHISPER_DEFAULTS.model}
				onCommit={(model) => { void update({ whisper: { model: model || WHISPER_DEFAULTS.model } }); }}
				ariaLabel="Whisper model"
				testid="whisper-model"
				disabled={locked}
				className="w-56"
			/>
		</SettingsRow>
		<SettingsRow
			label="Mode"
			hint={whisper?.mode === "stream" ? "Transcribes while you talk" : "Transcribes the whole recording when you stop"}
			testid="row-whisper-mode"
			dimmed={active}
		>
			<ThinSelect
				value={whisper?.mode ?? WHISPER_DEFAULTS.mode}
				onChange={(next) => { void update({ whisper: { mode: next as WhisperMode } }); }}
				ariaLabel="Whisper mode"
				testid="whisper-mode"
				disabled={locked}
			>
				{(Object.keys(MODE_LABELS) as WhisperMode[]).map((mode) => (
					<option key={mode} value={mode}>{MODE_LABELS[mode]}</option>
				))}
			</ThinSelect>
		</SettingsRow>
		{error && <p role="alert" data-testid="whisper-settings-error" className="px-1 text-[11px] text-destructive">{error}</p>}
	</>;
}
